// ===============================
// ⚔️ BOT TERRITÓRIOS - 9dg (visual bonito + help + next + PT-BR)
// ===============================
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
  EmbedBuilder,
} from "discord.js";
import { DateTime, Interval } from "luxon";
import fs from "node:fs";
import path from "node:path";
import express from "express";

// ========= CONFIG PERSISTENTE =========
const DATA_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    console.log("[CONFIG] Config carregada");
    return JSON.parse(raw);
  } catch {
    console.warn("[CONFIG] Sem config, criando nova");
    return { channelId: null, timezone: "America/Sao_Paulo" };
  }
}
function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  console.log("[CONFIG] Config salva:", cfg);
}
let config = loadConfig();

// ========= DISCORD CLIENT =========
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
    Partials.User,
  ],
});

const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("❌ FALTA DISCORD_TOKEN nas variáveis de ambiente!");
  process.exit(1);
}

// ========= DADOS & AJUSTES =========
const ZONE = config.timezone || "America/Sao_Paulo";
const TERRITORIES = [
  { time: "00:00", name: "Complexo do Alemão", id: "40/42" },
  { time: "12:00", name: "Cidade de Deus", id: "31/3" },
  { time: "16:00", name: "Rocinha", id: "27/36" },
  { time: "20:00", name: "Jacarezinho", id: "14/33" },
];
const OFFSETS = [90, 30, 10, 0];
const CLEANUP_AFTER_START_MIN = 120;

// Paleta
const COLORS = {
  primary: 0x5865f2, // blurple
  ok: 0x57f287, // verde
  warn: 0xfee75c, // amarelo
  danger: 0xed4245, // vermelho
  neutral: 0x2b2d31, // cinza escuro
};

// Emojis
const EMOJI = {
  bell: "🔔",
  fire: "🔥",
  sword: "⚔️",
  clock: "🕓",
  hourglass: "⏳",
  next: "⏭️",
  check: "✅",
  warn: "🟡",
  alert: "🔴",
  city: "🏙️",
};

// ========= ESTADO =========
const reactionMap = new Map(); // Map<cycleKey, Set<mentions>>
const sentKeys = new Set(); // evita reenvio no mesmo ciclo/offset

// ========= TEMPO =========
function nowZ() {
  return DateTime.now().setZone(ZONE);
}
function nextOccurrenceFor(timeHHmm) {
  const [h, m] = timeHHmm.split(":").map(Number);
  const now = nowZ();
  let candidate = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (candidate <= now) candidate = candidate.plus({ days: 1 });
  return candidate;
}
function previousOccurrenceFor(timeHHmm) {
  const [h, m] = timeHHmm.split(":").map(Number);
  const now = nowZ();
  let candidate = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (candidate > now) candidate = candidate.minus({ days: 1 });
  return candidate;
}
function keyFor(dt, timeHHmm) {
  return `${dt.toISODate()}@${timeHHmm}`;
}
function msUntil(dt) {
  return Math.max(0, dt.diffNow().as("milliseconds"));
}
function formatRemaining(targetDT) {
  const diff = targetDT.diff(nowZ(), ["hours", "minutes", "seconds"]);
  const h = Math.max(0, Math.floor(diff.hours));
  const m = Math.max(0, Math.floor(diff.minutes));
  const s = Math.max(0, Math.floor(diff.seconds));
  const pad = (n) => String(n).padStart(2, "0");
  return `${h}h ${pad(m)}m ${pad(s)}s`;
}
function fmtDateTime(dt) {
  return dt.toFormat("dd/LL HH:mm:ss");
}
function discordRelative(dt) {
  // <t:unix:R> → “em X tempo / há X tempo” (renderizado pelo Discord)
  return `<t:${Math.floor(dt.toSeconds())}:R>`;
}

// ========= CANAL =========
async function getChannel() {
  if (!config.channelId) return null;
  try {
    const ch = await client.channels.fetch(config.channelId);
    if (!ch || !ch.isTextBased()) return null;
    return ch;
  } catch (err) {
    console.error("[CANAL] Erro ao buscar canal:", err);
    return null;
  }
}

// ========= EMBEDS =========
function baseEmbed() {
  return new EmbedBuilder()
    .setColor(COLORS.primary)
    .setFooter({ text: `Zona horária: ${ZONE} • por 9dg` })
    .setTimestamp();
}

function buildReminderEmbed({ stage, name, time, startDT, mentions = [] }) {
  const remainingTxt = startDT ? formatRemaining(startDT) : "—";
  const rel = startDT ? discordRelative(startDT) : "";
  const id = TERRITORIES.find((t) => t.name === name)?.id ?? "—";

  const e = baseEmbed()
    .setTitle(`${EMOJI.city} ${name}`)
    .addFields(
      { name: "Horário", value: `**${time}**`, inline: true },
      { name: "ID", value: `\`${id}\``, inline: true },
    );

  if (stage === "90") {
    e.setColor(COLORS.primary).setDescription(
      `${EMOJI.bell} **Abre em ${remainingTxt}** ${rel}\n` +
        `Se você vai participar, reage com ${EMOJI.fire} pra gente se organizar.`,
    );
  } else if (stage === "30") {
    e.setColor(COLORS.warn).setDescription(
      `${EMOJI.warn} **Faltam ${remainingTxt}** ${rel}\n` +
        `${mentions.length ? mentions.join(" ") : "_(ninguém confirmou ainda)_"}`,
    );
  } else if (stage === "10") {
    e.setColor(COLORS.danger).setDescription(
      `${EMOJI.alert} **Últimos ${remainingTxt}** ${rel} — já vai entrando!\n` +
        `${mentions.length ? mentions.join(" ") : "_(ninguém confirmou ainda)_"}`,
    );
  } else if (stage === "start") {
    e.setColor(COLORS.ok)
      .setTitle(`${EMOJI.sword} ${name} — DISPONÍVEL AGORA`)
      .setDescription(
        `${mentions.length ? mentions.join(" ") : "_(ninguém com 🔥 no aviso)_"}`,
      );
  } else if (stage === "manual") {
    e.setColor(COLORS.primary)
      .setDescription(
        `${EMOJI.bell} **Abre em ${remainingTxt}** ${rel}\n` +
          `Se for, reage com ${EMOJI.fire} pra contar você.`,
      )
      .addFields({ name: "Tipo", value: "Aviso manual", inline: true });
  }

  return e;
}

function buildStatusEmbed() {
  const now = nowZ();
  const e = baseEmbed().setTitle("📊 Status dos territórios");

  const lines = TERRITORIES.map((t) => {
    const next = nextOccurrenceFor(t.time);
    const left = formatRemaining(next);
    return (
      `${EMOJI.clock} **${t.time}** — ${t.name} \`[${t.id}]\`\n` +
      `${EMOJI.hourglass} Próximo: **${left}** ${discordRelative(next)} *( ${fmtDateTime(next)} )*`
    );
  });

  e.setDescription(lines.join("\n\n"));
  return e;
}

function buildHelpEmbed() {
  return baseEmbed()
    .setTitle("🧭 Ajuda de comandos")
    .setDescription("Tudo que você pode usar com o bot:")
    .addFields(
      {
        name: "`l!`",
        value:
          "Define **este canal** para os avisos automáticos. (requer *Gerenciar Servidor*)",
        inline: false,
      },
      { name: "`!help`", value: "Mostra este painel de ajuda.", inline: false },
      {
        name: "`!next`",
        value: "Mostra **o próximo território** e quanto falta.",
        inline: false,
      },
      {
        name: "`!turfs`",
        value: "Lista **todos** com tempo restante e horário exato.",
        inline: false,
      },
      {
        name: "`m! <1-4>`",
        value: `Envia **aviso manual** (com ${EMOJI.fire} pra confirmar presença).`,
        inline: false,
      },
      {
        name: "`s! <1-4>`",
        value: `Envia **ENTREM AGORA** mencionando quem reagiu ${EMOJI.fire}.`,
        inline: false,
      },
    );
}

function buildNextEmbed() {
  let best = null;
  for (const t of TERRITORIES) {
    const start = nextOccurrenceFor(t.time);
    if (!best || start < best.start) best = { t, start };
  }
  if (!best)
    return baseEmbed()
      .setColor(COLORS.neutral)
      .setDescription("Não consegui determinar o próximo território.");

  const { t, start } = best;
  return baseEmbed()
    .setColor(COLORS.ok)
    .setTitle(`${EMOJI.next} Próximo território`)
    .setDescription(
      `${EMOJI.city} **${t.name}**\n` +
        `${EMOJI.clock} **${t.time}** — ${fmtDateTime(start)}\n` +
        `${EMOJI.hourglass} Abre em **${formatRemaining(start)}** ${discordRelative(start)}`,
    );
}

// ========= AGENDADOR =========
async function scheduleTerritory({ time, name }) {
  const start = nextOccurrenceFor(time);
  const cycleKey = keyFor(start, time);
  console.log(`[SCHEDULER] ${name} (${time}) → ${fmtDateTime(start)}`);

  for (const offset of OFFSETS) {
    const when = start.minus({ minutes: offset });
    const sendKey = `${cycleKey}-${offset}`;
    if (sentKeys.has(sendKey)) continue;

    const ms = msUntil(when);
    console.log(`[SCHEDULER] ${name} aviso ${offset}m → ${fmtDateTime(when)}`);

    setTimeout(async () => {
      const channel = await getChannel();
      if (!channel) {
        console.warn("[SCHEDULER] Sem canal configurado (use `l!`).");
        return;
      }
      if (!reactionMap.has(cycleKey)) reactionMap.set(cycleKey, new Set());

      try {
        if (offset === 90) {
          const embed = buildReminderEmbed({
            stage: "90",
            name,
            time,
            startDT: start,
          });
          const m = await channel.send({
            content: "@everyone",
            embeds: [embed],
          });
          try {
            await m.react(EMOJI.fire);
          } catch {}
          const cutoff = start.minus({ minutes: 10 });
          const collector = m.createReactionCollector({
            filter: (r, u) =>
              (r.emoji.name === "🔥" || r.emoji.name === EMOJI.fire) && !u.bot,
            time: Interval.fromDateTimes(nowZ(), cutoff)
              .toDuration()
              .as("milliseconds"),
            dispose: true,
          });
          collector.on("collect", (_r, user) => {
            const set = reactionMap.get(cycleKey);
            set.add(`<@${user.id}>`);
            console.log(`[REAÇÃO] ${user.tag} ${EMOJI.fire} em ${name}`);
          });
          collector.on("remove", (_r, user) => {
            const set = reactionMap.get(cycleKey);
            set.delete(`<@${user.id}>`);
            console.log(
              `[REAÇÃO REMOVIDA] ${user.tag} ${EMOJI.fire} em ${name}`,
            );
          });
        } else if (offset === 30) {
          const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
          const embed = buildReminderEmbed({
            stage: "30",
            name,
            time,
            startDT: start,
            mentions,
          });
          await channel.send({ embeds: [embed] });
        } else if (offset === 10) {
          const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
          const embed = buildReminderEmbed({
            stage: "10",
            name,
            time,
            startDT: start,
            mentions,
          });
          await channel.send({ embeds: [embed] });
        } else if (offset === 0) {
          const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
          const embed = buildReminderEmbed({
            stage: "start",
            name,
            time,
            mentions,
          });
          await channel.send({ embeds: [embed] });
          setTimeout(
            () => {
              reactionMap.delete(cycleKey);
              console.log(`[CLEANUP] Reações limpas para ciclo ${cycleKey}`);
            },
            CLEANUP_AFTER_START_MIN * 60 * 1000,
          );
        }
        sentKeys.add(sendKey);
      } catch (err) {
        console.error(`[ERRO] Falha ao enviar para ${name}:`, err);
      }
    }, ms);
  }

  // agenda o próximo dia
  setTimeout(
    () => scheduleTerritory({ time, name }),
    msUntil(start.plus({ days: 1 }).minus({ minutes: Math.min(...OFFSETS) })),
  );
}

async function scheduleAll() {
  console.log("[SCHEDULER] Iniciando agendamentos…");
  for (const t of TERRITORIES) scheduleTerritory(t);
}

// ========= HELPERS =========
function getCycleKeyForManual(territory) {
  const now = nowZ();
  const next = nextOccurrenceFor(territory.time);
  if (next.diff(now).as("minutes") > 0) return keyFor(next, territory.time);
  const prev = previousOccurrenceFor(territory.time);
  return keyFor(prev, territory.time);
}

// ========= COMANDOS =========
client.on(Events.MessageCreate, async (message) => {
  if (!message.guild || message.author.bot) return;
  const content = message.content.trim();

  // l! → configurar canal
  if (content === "l!") {
    const member = await message.guild.members
      .fetch(message.author.id)
      .catch(() => null);
    if (!member) return;
    if (!member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
      await message.reply(
        "❌ Você precisa da permissão **Gerenciar Servidor** para configurar o canal.",
      );
      return;
    }
    config.channelId = message.channel.id;
    saveConfig(config);
    await message.reply({
      embeds: [
        baseEmbed()
          .setColor(COLORS.ok)
          .setTitle(`${EMOJI.check} Canal configurado`)
          .setDescription(
            "Perfeito! A partir de agora, **todos os avisos** vão sair neste canal.",
          ),
      ],
    });
    return;
  }

  // !help
  if (content === "!help") {
    await message.channel.send({ embeds: [buildHelpEmbed()] });
    return;
  }

  // !next
  if (content === "!next") {
    await message.channel.send({ embeds: [buildNextEmbed()] });
    return;
  }

  // !turfs → status
  if (content === "!turfs") {
    await message.channel.send({ embeds: [buildStatusEmbed()] });
    return;
  }

  // m! → aviso manual com 🔥
  if (content.startsWith("m! ")) {
    const num = parseInt(content.substring(3).trim());
    if (isNaN(num) || num < 1 || num > 4) {
      await message.reply(
        "❌ Use: `m! 1`, `m! 2`, `m! 3` ou `m! 4`\n" +
          "1 = Complexo do Alemão (00:00)\n2 = Cidade de Deus (12:00)\n3 = Rocinha (16:00)\n4 = Jacarezinho (20:00)",
      );
      return;
    }
    const territory = TERRITORIES[num - 1];
    const startDT = nextOccurrenceFor(territory.time);
    const embed = buildReminderEmbed({
      stage: "manual",
      name: territory.name,
      time: territory.time,
      startDT,
    });
    const msg = await message.channel.send({
      content: "@everyone",
      embeds: [embed],
    });
    try {
      await msg.react(EMOJI.fire);
    } catch {}
    return;
  }

  // s! → entrar agora (manual) com menções
  if (content.startsWith("s! ")) {
    const num = parseInt(content.substring(3).trim());
    if (isNaN(num) || num < 1 || num > 4) {
      await message.reply(
        "❌ Use: `s! 1`, `s! 2`, `s! 3` ou `s! 4`\n" +
          "1 = Complexo do Alemão (00:00)\n2 = Cidade de Deus (12:00)\n3 = Rocinha (16:00)\n4 = Jacarezinho (20:00)",
      );
      return;
    }
    const territory = TERRITORIES[num - 1];
    const cycleKey = getCycleKeyForManual(territory);
    const mentions = Array.from(reactionMap.get(cycleKey) ?? []);
    const embed = buildReminderEmbed({
      stage: "start",
      name: territory.name,
      time: territory.time,
      mentions,
    });
    await message.channel.send({ embeds: [embed] });
    return;
  }
});

// ========= READY =========
client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logado como ${c.user.tag}`);
  const channel = await getChannel();
  if (channel) {
    channel.send({
      embeds: [
        baseEmbed()
          .setTitle(`${EMOJI.bell} Bot iniciado`)
          .setDescription(
            `Lembretes ativos em **${ZONE}**.\nUse \`l!\` neste canal para fixar se ainda não estiver configurado.`,
          ),
      ],
    });
  } else {
    console.log("ℹ️ Sem canal configurado. Use `l!` no canal desejado.");
  }
  scheduleAll();
});

// ========= KEEP-ALIVE (REPLIT) =========
const app = express();
app.get("/", (_, res) => res.send("Bot online e funcional!"));
app.listen(3000, () =>
  console.log("🌐 Servidor HTTP ativo (keep-alive Replit)"),
);

// ========= LOGS GLOBAIS =========
process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED REJECTION]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err);
});

client.login(TOKEN);
