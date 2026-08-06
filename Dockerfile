FROM node:22-alpine

WORKDIR /app

# Kopiraj package fajlove prvo (bolji cache)
COPY package*.json ./
RUN npm install --omit=dev || npm install

# Kopiraj ostatak koda (bez .env — dodaje se preko env var)
COPY . .

# Aplikacija čita config iz env, pokreće se direktno
CMD ["node", "index.js"]
