const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const YAML = require('yaml'); 
const db = require('../Structures/Database.js');
const CONFIG = require('../config.js');

// --- Konstantno-vremensko poređenje tajni ---
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// --- Sanitizacija imena fajla: blokira .. / \ i sve osim sigurnih znakova ---
function sanitizeFilename(name) {
  if (typeof name !== 'string') return null;
  // Ukloni sve path separatore i traversal pokušaje
  const cleaned = name.replace(/[\\/]/g, '').replace(/\.\./g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  if (!/^[a-zA-Z0-9_.-]+$/.test(cleaned)) return null;
  return cleaned;
}

// --- Rate limiter (jednostavan, per-IP) ---
const rateLimit = {
  hits: new Map(),
  windowMs: 60_000,
  max: 10,
};
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = rateLimit.hits.get(ip);
  if (!entry || now - entry.start > rateLimit.windowMs) {
    rateLimit.hits.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count += 1;
  if (entry.count > rateLimit.max) {
    return res.status(429).json({ success: false, error: 'Rate limit exceeded. Try again later.' });
  }
  next();
}

// --- Loguj addon/update pokušaje ---
function logSecurityEvent(type, req, extra) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const line = `[${new Date().toISOString()}] ${type} | IP: ${ip} | ${extra || ''}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(__dirname, '../Logs/security.log'), line + '\n');
  } catch (e) { /* ignore */ }
}

class APIServer {
    constructor(client) {
        this.client = client;
        this.app = express();

        try {
            const apiCfg = yaml.load(fs.readFileSync('./Configs/api.yml', 'utf8')).API;
            this.config = apiCfg;
        } catch (e) {
            console.error('[API] Failed to load api.yml, defaulting to disabled.');
            this.config = { Enabled: false };
        }

        if (!this.config.Enabled) return;

        // Fix 4: CORS eksplicitno, ne wildcard. Prazno = same-origin only.
        if (CONFIG.adminPanelOrigin) {
            this.app.use(cors({ origin: CONFIG.adminPanelOrigin }));
        } else {
            // Bez dozvoljenog origina → ne šalji Access-Control-Allow-Origin (same-origin)
            this.app.use((req, res, next) => {
                res.removeHeader('Access-Control-Allow-Origin');
                next();
            });
        }
        this.app.use(express.json());

        // Globalna auth: SecretKey iz api.yml (zadržano) — ali addon/update imaju jaču proveru niže
        this.app.use((req, res, next) => {
            const authHeader = req.headers.authorization;
            if (!authHeader || authHeader !== `Bearer ${this.config.SecretKey}`) {
                return res.status(401).json({ error: 'Unauthorized. Invalid Secret Key.' });
            }
            next();
        });

        this.setupRoutes();
    }

    start(port) {
        const listenPort = port || CONFIG.apiPort || 8099;
        const bindAddr = CONFIG.apiBind || '127.0.0.1';
        this.app.listen(listenPort, bindAddr, () => {
            console.log(`[API] Server running on ${bindAddr}:${listenPort}`);
        });
    }

    setupRoutes() {
        this.app.get('/api/stats', async (req, res) => {
            try {
                if (!this.client.user) {
                    return res.json({ success: false, error: 'Bot is still starting up.' });
                }

                let userCount = 0;
                this.client.guilds.cache.forEach(guild => {
                    userCount += guild.memberCount;
                });

                const allTickets = db.getAllTickets() || [];
                const openTickets = allTickets.filter(t => t.open).length;
                const closedTickets = allTickets.filter(t => !t.open).length;

                const totalMem = os.totalmem();
                const freeMem = os.freemem();
                const usedMem = totalMem - freeMem;
                const ramPercent = Math.round((usedMem / totalMem) * 100);
                const cpuLoad = os.loadavg()[0].toFixed(2);

                res.json({
                    success: true,
                    data: {
                        bot: {
                            username: this.client.user.username,
                            id: this.client.user.id,
                            avatar: this.client.user.displayAvatarURL(),
                            version: require('../package.json').version,
                            ping: this.client.ws.ping,
                            uptime: process.uptime(),
                        },
                        servers: this.client.guilds.cache.size,
                        users: userCount,
                        tickets: {
                            total: allTickets.length,
                            open: openTickets,
                            closed: closedTickets
                        },
                        hosting: {
                            ram_used: (usedMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                            ram_total: (totalMem / 1024 / 1024 / 1024).toFixed(2) + ' GB',
                            ram_percent: ramPercent,
                            cpu_load: cpuLoad,
                            uptime: Math.floor(os.uptime() / 86400) + ' Days'
                        }
                    }
                });
            } catch (err) {
                console.error('[API] Error fetching stats:', err);
                res.status(500).json({ success: false, error: 'Internal Server Error' });
            }
        });

        this.app.get('/api/configs/:file', (req, res) => {
            const validFiles = ['supportbot', 'ticket-panel', 'commands', 'messages', 'supportbot-ai'];
            const file = req.params.file;
            if (!validFiles.includes(file)) return res.status(400).json({ success: false, error: 'Invalid file' });
            try {
                const configData = fs.readFileSync(`./Configs/${file}.yml`, 'utf8');
                res.json({ success: true, data: configData });
            } catch (err) {
                res.status(500).json({ success: false, error: 'Failed to read config' });
            }
        });

        this.app.put('/api/configs/raw', (req, res) => {
            const validFiles = ['supportbot', 'ticket-panel', 'commands', 'messages', 'supportbot-ai'];
            const file = req.body.filename;
            const content = req.body.content;
            if (!validFiles.includes(file)) return res.status(400).json({ success: false, error: 'Invalid file' });
            try {
                fs.writeFileSync(`./Configs/${file}.yml`, content);
                res.json({ success: true });
            } catch (err) {
                res.status(500).json({ success: false, error: 'Failed to write config' });
            }
        });

        this.app.get('/api/configs/json/:file', (req, res) => {
            const validFiles = ['supportbot', 'ticket-panel', 'commands', 'messages', 'supportbot-ai'];
            const file = req.params.file;
            if (!validFiles.includes(file)) return res.status(400).json({ success: false, error: 'Invalid file' });
            try {
                const configData = yaml.load(fs.readFileSync(`./Configs/${file}.yml`, 'utf8'));
                res.json({ success: true, data: configData });
            } catch (err) {
                res.status(500).json({ success: false, error: 'Failed to parse config' });
            }
        });

        this.app.post('/api/configs/update-fields/multi', (req, res) => {
            const updates = req.body;
            if (!updates || typeof updates !== 'object') return res.status(400).json({ success: false, error: 'Invalid updates' });
            try {
                for (const [keyPath, value] of Object.entries(updates)) {
                    const [fileName, path] = keyPath.split(':');
                    const fileContent = fs.readFileSync(`./Configs/${fileName}.yml`, 'utf8');
                    const doc = YAML.parseDocument(fileContent);
                    const keys = path.split('.');
                    doc.setIn(keys, value);
                    fs.writeFileSync(`./Configs/${fileName}.yml`, doc.toString());
                }
                res.json({ success: true });
            } catch (err) {
                console.error('[API] Update failed:', err);
                res.status(500).json({ success: false, error: err.message });
            }
        });

        this.app.post('/api/addons/install', rateLimitMiddleware, async (req, res) => {
            // Fix 1: jača auth — x-addons-key header (constant-time) pored globalnog SecretKey
            const addonKey = req.headers['x-addons-key'];
            if (!addonKey || !safeEqual(addonKey, CONFIG.addonsSecretKey)) {
                logSecurityEvent('ADDON_INSTALL_DENIED', req, 'invalid x-addons-key');
                return res.status(403).json({ success: false, error: 'Forbidden. Invalid addons key.' });
            }

            const { url, filename } = req.body;
            if (!url || !filename) {
                logSecurityEvent('ADDON_INSTALL_REJECTED', req, 'missing url/filename');
                return res.status(400).json({ success: false, error: 'Missing url or filename' });
            }

            // Sanitizuj filename — blokira path traversal
            const safeName = sanitizeFilename(filename);
            if (!safeName) {
                logSecurityEvent('ADDON_INSTALL_BLOCKED', req, `path traversal filename: ${filename}`);
                return res.status(400).json({ success: false, error: 'Invalid filename.' });
            }
            if (!safeName.endsWith('.js')) {
                logSecurityEvent('ADDON_INSTALL_BLOCKED', req, `non-js file: ${safeName}`);
                return res.status(400).json({ success: false, error: 'Only .js addon files allowed.' });
            }

            try {
                const axios = require('axios');
                const response = await axios({
                    method: 'get',
                    url: url,
                    responseType: 'stream'
                });

                // Ensure Addons directory exists
                if (!fs.existsSync('./Addons')) {
                    fs.mkdirSync('./Addons');
                }

                const writer = fs.createWriteStream(`./Addons/${safeName}`);
                response.data.pipe(writer);

                writer.on('finish', () => {
                    logSecurityEvent('ADDON_INSTALL_SUCCESS', req, `installed ${safeName}`);
                    res.json({ success: true, message: `Addon ${safeName} installed. Restart the bot to load it.` });
                });

                writer.on('error', (err) => {
                    logSecurityEvent('ADDON_INSTALL_ERROR', req, `write failed ${safeName}`);
                    res.status(500).json({ success: false, error: 'Failed to write addon file' });
                });

            } catch (err) {
                logSecurityEvent('ADDON_INSTALL_ERROR', req, `download failed: ${err.message}`);
                res.status(500).json({ success: false, error: 'Failed to download addon' });
            }
        });

        this.app.post('/api/addons/push', rateLimitMiddleware, (req, res) => {
            // Fix 1: jača auth — x-addons-key header (constant-time)
            const addonKey = req.headers['x-addons-key'];
            if (!addonKey || !safeEqual(addonKey, CONFIG.addonsSecretKey)) {
                logSecurityEvent('ADDON_PUSH_DENIED', req, 'invalid x-addons-key');
                return res.status(403).json({ success: false, error: 'Forbidden. Invalid addons key.' });
            }

            const { filename, content } = req.body;
            if (!filename || !content) {
                logSecurityEvent('ADDON_PUSH_REJECTED', req, 'missing filename/content');
                return res.status(400).json({ success: false, error: 'Missing filename or content' });
            }

            // Sanitizuj filename — blokira traversal
            const safeName = sanitizeFilename(filename);
            if (!safeName) {
                logSecurityEvent('ADDON_PUSH_BLOCKED', req, `path traversal filename: ${filename}`);
                return res.status(400).json({ success: false, error: 'Invalid filename.' });
            }
            if (!safeName.endsWith('.js')) {
                logSecurityEvent('ADDON_PUSH_BLOCKED', req, `non-js file: ${safeName}`);
                return res.status(400).json({ success: false, error: 'Only .js addon files allowed.' });
            }

            try {
                if (!fs.existsSync('./Addons')) {
                    fs.mkdirSync('./Addons');
                }
                fs.writeFileSync(`./Addons/${safeName}`, content);
                logSecurityEvent('ADDON_PUSH_SUCCESS', req, `pushed ${safeName}`);
                res.json({ success: true, message: `Addon ${safeName} deployed. Restart the bot to load it.` });
            } catch (err) {
                logSecurityEvent('ADDON_PUSH_ERROR', req, `write failed: ${err.message}`);
                res.status(500).json({ success: false, error: 'Failed to write addon file' });
            }
        });

        // --- Nexus Updater API ---
        // Fix 2: NE prihvata korisnički URL. Izvor je hardkodovan u CONFIG.updateUrl.
        // Koristi execFile (argumenti kao niz) — bez shell interpolacije → bez injection.
        this.app.post('/api/system/update', rateLimitMiddleware, async (req, res) => {
            // Auth: x-updater-key (constant-time) + globalni SecretKey
            const updaterKey = req.headers['x-updater-key'];
            if (!updaterKey || !safeEqual(updaterKey, CONFIG.updaterSecretKey)) {
                logSecurityEvent('UPDATE_DENIED', req, 'invalid x-updater-key');
                return res.status(403).json({ success: false, error: 'Forbidden. Invalid updater key.' });
            }

            const updateUrl = CONFIG.updateUrl;
            if (!updateUrl) {
                logSecurityEvent('UPDATE_REJECTED', req, 'UPDATE_URL not configured');
                return res.status(400).json({ success: false, error: 'Update URL not configured on server.' });
            }

            try {
                const axios = require('axios');
                const { execFile } = require('child_process');

                logSecurityEvent('UPDATE_START', req, `applying update from configured source`);

                // 1. Download iz HARDKODOVANOG izvora
                const tempZip = `./update_${Date.now()}.zip`;
                const response = await axios({ method: 'get', url: updateUrl, responseType: 'stream' });
                const writer = fs.createWriteStream(tempZip);
                response.data.pipe(writer);

                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });

                // 2. Extract sa execFile — argumenti kao niz, bez shell stringova
                const tempDir = `./temp_update_${Date.now()}`;
                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

                const isWindows = process.platform === 'win32';
                try {
                    if (isWindows) {
                        execFile('powershell', ['-Command', `Expand-Archive -Path '${tempZip}' -DestinationPath '${tempDir}' -Force`]);
                    } else {
                        execFile('unzip', ['-o', tempZip, '-d', tempDir]);
                    }
                } catch (e) {
                    throw new Error(`Extraction failed. Ensure ${isWindows ? 'PowerShell' : 'unzip'} is installed. ${e.message}`);
                }

                // 3. Identifikuj inner dir
                let sourcePath = tempDir;
                const items = fs.readdirSync(tempDir);
                if (items.length === 1 && fs.statSync(path.join(tempDir, items[0])).isDirectory()) {
                    sourcePath = path.join(tempDir, items[0]);
                }

                // 4. Smart Config Merge (zadržano)
                const configFiles = ['supportbot', 'commands', 'messages', 'ticket-panel', 'supportbot-ai'];
                configFiles.forEach(cf => {
                    const currentPath = `./Configs/${cf}.yml`;
                    const newPath = path.join(sourcePath, 'Configs', `${cf}.yml`);

                    if (fs.existsSync(currentPath) && fs.existsSync(newPath)) {
                        const currentCfg = yaml.load(fs.readFileSync(currentPath, 'utf8'));
                        const newCfg = yaml.load(fs.readFileSync(newPath, 'utf8'));

                        const merge = (target, source) => {
                            for (const key of Object.keys(source)) {
                                if (source[key] instanceof Object && !Array.isArray(source[key]) && target[key]) {
                                    merge(target[key], source[key]);
                                } else if (target[key] === undefined) {
                                    target[key] = source[key];
                                }
                            }
                        };
                        merge(currentCfg, newCfg);
                        fs.writeFileSync(currentPath, YAML.stringify(currentCfg));
                    }
                });

                // 5. Overwrite Core Folders — execFile, argumenti kao niz
                const coreFolders = ['API', 'Commands', 'Events', 'Structures'];
                coreFolders.forEach(folder => {
                    const src = path.join(sourcePath, folder);
                    if (fs.existsSync(src)) {
                        if (isWindows) {
                            execFile('xcopy', [src, `.\\${folder}`, '/E', '/I', '/Y']);
                        } else {
                            execFile('cp', ['-R', `${src}/`, `./${folder}/`]);
                        }
                    }
                });

                // 6. Update package.json (version only)
                const newPkgPath = path.join(sourcePath, 'package.json');
                if (fs.existsSync(newPkgPath)) {
                    const currentPkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
                    const newPkg = JSON.parse(fs.readFileSync(newPkgPath, 'utf8'));
                    currentPkg.version = newPkg.version;
                    fs.writeFileSync('./package.json', JSON.stringify(currentPkg, null, 2));
                }

                fs.unlinkSync(tempZip);
                if (isWindows) {
                    execFile('rmdir', ['/s', '/q', tempDir]);
                } else {
                    execFile('rm', ['-rf', tempDir]);
                }

                logSecurityEvent('UPDATE_SUCCESS', req, 'update applied, restarting');
                res.json({ success: true, message: 'Update installed successfully. Bot is restarting...' });

                // Reboot
                setTimeout(() => process.exit(0), 1000);

            } catch (err) {
                logSecurityEvent('UPDATE_ERROR', req, err.message);
                res.status(500).json({ success: false, error: err.message });
            }
        });

        // --- Transcript API ---
        this.app.get('/api/system/transcripts', (req, res) => {
            const transcriptDir = './Data/Transcripts';
            try {
                if (!fs.existsSync(transcriptDir)) {
                    return res.json({ success: true, data: [] });
                }
                const files = fs.readdirSync(transcriptDir);
                const transcripts = files
                    .filter(f => f.endsWith('-transcript.html'))
                    .map(f => {
                        const stats = fs.statSync(`${transcriptDir}/${f}`);
                        return {
                            id: f.replace('-transcript.html', ''),
                            filename: f,
                            createdAt: stats.mtime
                        };
                    })
                    .sort((a, b) => b.createdAt - a.createdAt);
                res.json({ success: true, data: transcripts });
            } catch (err) {
                res.status(500).json({ success: false, error: 'Failed to list transcripts' });
            }
        });

        this.app.get('/api/system/transcripts/:id', (req, res) => {
            const id = req.params.id.replace(/[^0-9]/g, ''); // Sanitize ID
            const filePath = `./Data/Transcripts/${id}-transcript.html`;
            try {
                if (!fs.existsSync(filePath)) {
                    return res.status(404).json({ success: false, error: 'Transcript not found' });
                }
                const content = fs.readFileSync(filePath, 'utf8');
                res.json({ success: true, data: content });
            } catch (err) {
                res.status(500).json({ success: false, error: 'Failed to read transcript' });
            }
        });
    }
}

module.exports = APIServer;
