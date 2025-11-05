FROM node:20-alpine

# Asegura zona horaria del contenedor (opcional; Luxon ya usa la zona via código)
ENV TZ=America/Sao_Paulo
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
RUN mkdir -p /app/data

ENV NODE_ENV=production
CMD ["npm", "start"]
