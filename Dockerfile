FROM node:22-slim

# Build alati za better-sqlite3 (native modul)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Kopiraj package fajlove prvo (bolji cache)
COPY package*.json ./
RUN npm install --omit=dev || npm install

# Kopiraj ostatak koda (sekreti idu preko env var, ne u .env)
COPY . .

# Pokreni bot (čita config iz env var)
CMD ["node", "index.js"]
