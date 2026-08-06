// ============================================================
// config.js — Centralni config loader
// Učitava .env (ručno, bez dotenv paketa), izlaže sekrete,
// i ODBIJA pokretanje ako je neki sekret i dalje placeholder.
// ============================================================
const fs = require("fs");
const path = require("path");

// --- Ručni .env loader (izbegava dodatnu zavisnost) ---
// Pravilo: vrednost iz .env fajla IMA PREDNOST nad process.env.
// Ovo sprečava da Dokploy prosledi placeholder/kratku vrednost koja
// prebije ispravan token u .env. (Za dev na mašini, .env je ispravan.)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    // Ako .env ne postoji, oslanjamo se na process.env (Dokploy env vars)
    return;
  }
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // UVIJEK overwrite-uj (i prazne i postojeće) iz .env fajla
    if (key) {
      process.env[key] = value;
    }
  }
}

loadEnv();

// --- Placeholder markeri (literalne vrednosti koje nikad ne smeju proći) ---
const FORBIDDEN_PLACEHOLDERS = [
  "BOT_TOKEN",
  "MODEL_API_KEY",
  "PASTEBIN_API_KEY",
  "PUT_RANDOM",
  "YOUR_",
  "<",
  ">",
];

function looksLikePlaceholder(value) {
  if (!value || typeof value !== "string") return true;
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return FORBIDDEN_PLACEHOLDERS.some((p) => trimmed.includes(p));
}

// --- Sekreti (iz .env) ---
const config = {
  discordToken: process.env.DISCORD_TOKEN || "",
  addonsSecretKey: process.env.ADDONS_SECRET_KEY || "",
  updaterSecretKey: process.env.UPDATER_SECRET_KEY || process.env.ADDONS_SECRET_KEY || "",
  modelApiKey: process.env.MODEL_API_KEY || "",
  pastebinApiKey: process.env.PASTEBIN_API_KEY || "",
  apiPort: parseInt(process.env.API_PORT || "8099", 10),
  apiBind: process.env.API_BIND || "127.0.0.1",
  adminPanelOrigin: process.env.ADMIN_PANEL_ORIGIN || "",
  allowedGuildId: process.env.ALLOWED_GUILD_ID || "",
  // Fix 2: update izvor — hardkodovan, NE prima URL od korisnika
  updateUrl: process.env.UPDATE_URL || "",
};

// --- Startup provera: odbij ako su sekreti placeholder ili prazni ---
const requiredSecrets = [
  { name: "DISCORD_TOKEN", value: config.discordToken },
  { name: "ADDONS_SECRET_KEY", value: config.addonsSecretKey },
];

const missing = [];
for (const sec of requiredSecrets) {
  if (looksLikePlaceholder(sec.value)) {
    missing.push(sec.name);
  }
}

if (missing.length > 0) {
  console.error(
    "[CONFIG] ❌ Pokretanje ODBIJENO. Sledeći sekreti su placeholder ili prazni: " +
      missing.join(", ") +
      "\nPopuni ih u .env fajlu. Ne pokreći bot sa lažnim/placeholder vrednostima."
  );
  process.exit(1);
}

// Ako nije postavljen ALLOWED_GUILD_ID → upozorenje ali ne blokira
if (!config.allowedGuildId) {
  console.warn(
    "[CONFIG] ⚠️ ALLOWED_GUILD_ID nije postavljen. Bot neće biti zaključan na jedan server."
  );
}

module.exports = config;
