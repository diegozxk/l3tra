import { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } from 'discord.js';
import { DateTime, Interval } from 'luxon';
import fs from 'node:fs';
import path from 'node:path';

// ========= CONFIG PERSISTENTE =========
const DATA_DIR = path.join(process.cwd(), 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { channelId: null };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let config = loadConfig();

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // no es estrictamente necesario si solo usas `l!`, pero ayuda
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User]
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error('Falta DISCORD_TOKEN en variables de entorno');
  process.exit(1);
}

// ========= ZONA HORARIA =========
const ZONE = 'America/Sao_Paulo';

// ========= TERRITORIOS =========
// hora: HH:mm (24h) en zona America/Sao_Paulo
const TERRITORIES = [
  { time: '00:00', name: 'Complexo do Alemão' },
  { time: '12:00', name: 'Cidade de Deus' },
  { time: '16:00', name: 'Rocinha' },
  { time: '20:00', name: 'Jacarezinho' },
];

// Offsets (minutos) antes de la hora objetivo
const OFFSETS = [90, 30, 10]; // 1h30, 30m, 10m

// Mapa para guardar reacciones 🔥 por “ciclo” (key = YYYY-MM-DD@HH:mm)
const reactionMap = new Map();
// Para no duplicar envíos si el bot se reinicia
const sentKeys = new Set();

// ========= UTILIDADES DE TIEMPO =========
function nextOccurrenceFor(timeHHmm) {
  const [h, m] = timeHHmm.split(':').map(Number);
  const now = DateTime.now().setZone(ZONE);
  let candidate = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (candidate <= now) candidate = candidate.plus({ days: 1 });
  return candidate; // DateTime
}

function keyFor(dt, timeHHmm) {
  return `${dt.toISODate()}@${timeHHmm}`;
}

function msUntil(dt) {
  return Math.max(0, dt.diffNow().as('milliseconds'));
}

async function getChannel() {
  if (!config.channelId) return null;
  try {
    const ch = await client.channels.fetch(config.channelId);
    return ch && ch.isTextBased() ? ch : null;
  } catch { return null; }
}

// ========= MENSAJES =========
function msg90(name, timeLabel) {
  return `O território de **${timeLabel}** chamado **${name}** estará disponível em **uma hora e meia**.\nQuem estiver disponível para capturá-lo/defendê-lo, reaja com o emoji abaixo 🔥\n@everyone`;
}

function msg30(name, timeLabel, mentions) {
  const mentionText = mentions.length ? mentions.join(' ') : '(ninguém reagiu ainda)';
  return `O território de **${timeLabel}** chamado **${name}** estará disponível em **30 minutos**. Lembre-se de participar!\n${mentionText}`;
}

function msg10(name, timeLabel, mentions) {
  const mentionText = mentions.length ? mentions.join(' ') : '(ninguém reagiu ainda)';
  return `O território de **${timeLabel}** chamado **${name}** estará disponível em **10 minutos**. Entre agora mesmo para a guerra!\n${mentionText}`;
}

// ========= SCHEDULER =========
async function scheduleTerritory({ time, name }) {
  // Próxima fecha/hora de ese territorio (inicio)
  const start = nextOccurrenceFor(time);
  const cycleKey = keyFor(start, time);

  // Programamos los tres avisos antes del inicio
  for (const offset of OFFSETS) {
    const when = start.minus({ minutes: offset });
    const sendKey = `${cycleKey}-${offset}`;
    if (sentKeys.has(sendKey)) continue; // evita duplicados tras reinicio

    const ms = msUntil(when);
    setTimeout(async () => {
      const channel = await getChannel();
      if (!channel) return;

      // Asegura almacenamiento del set de reacciones para este ciclo
      if (!reactionMap.has(cycleKey)) reactionMap.set(cycleKey, new Set());

      if (offset === 90) {
        // Primer aviso: pedir reacciones y crear collector
        const m = await channel.send(msg90(name, time));
        try { await m.react('🔥'); } catch {}

        // Collector hasta 10 minutos antes del inicio
        const cutoff = start.minus({ minutes: 10 });
        const collector = m.createReactionCollector({
          filter: (r, u) => r.emoji.name === '🔥' && !u.bot,
          time: Interval.fromDateTimes(DateTime.now(), cutoff).toDuration().as('milliseconds')
        });

        collector.on('collect', (_reaction, user) => {
          const set = reactionMap.get(cycleKey);
          set.add(`<@${user.id}>`);
        });

        collector.on('remove', (_reaction, user) => {
          const set = reactionMap.get(cycleKey);
          set.delete(`<@${user.id}>`);
        });

      } else if (offset === 30) {
        const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
        await channel.send(msg30(name, time, mentions));
      } else if (offset === 10) {
        const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
        await channel.send(msg10(name, time, mentions));
        // Limpiar datos del ciclo poco después
        setTimeout(() => reactionMap.delete(cycleKey), 30 * 60 * 1000);
      }

      sentKeys.add(sendKey);
    }, ms);
  }

  // Reprograma este territorio para el siguiente día
  setTimeout(() => scheduleTerritory({ time, name }), msUntil(start.plus({ days: 1 }).minus({ minutes: Math.min(...OFFSETS) })));
}

async function scheduleAll() {
  for (const t of TERRITORIES) scheduleTerritory(t);
}

// ========= COMANDO l! =========
client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  if (message.content.trim() !== 'l!') return;

  const member = await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) return;

  // Requiere "Manage Guild" para cambiar el canal
  if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
    await message.reply('❌ Precisas permissão **Gerenciar Servidor** para configurar o canal.');
    return;
  }

  config.channelId = message.channel.id;
  saveConfig(config);
  await message.reply('✅ Canal configurado! Enviarei os avisos aqui.');
});

// ========= READY =========
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logado como ${c.user.tag}`);
  const channel = await getChannel();
  if (channel) {
    channel.send('🔔 Bot iniciado. Os lembretes de territórios estão ativos em America/Sao_Paulo.');
  } else {
    console.log('ℹ️ Aún no hay canal configurado. Escribe `l!` en el canal donde quieras los avisos.');
  }
  scheduleAll();
});

client.login(TOKEN);
