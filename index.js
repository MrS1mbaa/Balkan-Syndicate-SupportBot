//      ___                            _    ___        _
//    / __> _ _  ___  ___  ___  _ _ _| |_ | . > ___ _| |_
//     \__ \| | || . \| . \/ . \| '_> | |  | . \/ . \ | |
//     <___/`___||  _/|  _/\___/|_|   |_|  |___/\___/ |_|
//                |_|  |_|
//
//           SupportBot created by Emerald Services
//           Installed with MIT License
//
//           Discord Support: https://emeraldsrv.dev/discord
//           Community Resources: https://community.emeraldsrv.dev

const fs = require("fs");
const path = require("path");

const yaml = require("js-yaml");
const supportbot = yaml.load(
  fs.readFileSync("./Configs/supportbot.yml", "utf8")
);

const CONFIG = require("./config.js");

const Client = require("./Structures/Client.js");
const client = new Client({
  intents: ['Guilds', 'GuildMembers', 'GuildMessages', 'MessageContent']
});

const APIServer = require("./API/server.js");

// --- Guild Lockdown: bot radi samo na ALLOWED_GUILD_ID ---
if (CONFIG.allowedGuildId) {
  const allowed = String(CONFIG.allowedGuildId).trim();
  client.on('guildCreate', async (guild) => {
    if (String(guild.id) !== allowed) {
      console.warn(`[LOCK] Bot dodan na nedozvoljen guild ${guild.name} (${guild.id}). Napuštam.`);
      try {
        await guild.leave();
      } catch (e) {
        console.error(`[LOCK] Ne mogu napustiti ${guild.id}:`, e.message);
      }
    }
  });
  // Ako bot već ima nedozvoljene guildove pri pokretanju
  client.once('clientReady', async () => {
    for (const [id, guild] of client.guilds.cache) {
      if (id !== allowed) {
        console.warn(`[LOCK] Nedozvoljen guild ${guild.name} (${id}). Napuštam.`);
        try { await guild.leave(); } catch (e) { /* ignore */ }
      }
    }
  });
}

client.start(CONFIG.discordToken);

client.once('clientReady', () => {
    const api = new APIServer(client);
    api.start();
});

// SupportBot - New Logging System

const logTypes = ["Output", "Warn", "Error"];

if (!fs.existsSync("./Logs")) {
  fs.mkdirSync("./Logs");
}
logTypes.forEach((type) => {
  const dir = `./Logs/${type}`;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
});

function logToFile(type, data) {
  const date = new Date().toISOString().split("T")[0];
  const file = path.join(`./Logs/${type}`, `${type}-${date}.log`);
  fs.appendFileSync(file, `[${new Date().toISOString()}] ${data}\n`);
}

const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  logToFile("Output", args.join(" "));
};

const origWarn = console.warn;
console.warn = (...args) => {
  origWarn(...args);
  logToFile("Warn", args.join(" "));
};

const origError = console.error;
console.error = (...args) => {
  origError(...args);
  logToFile("Error", args.join(" "));
};

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});
