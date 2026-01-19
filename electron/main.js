const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFile, fork, spawn } = require('child_process');

const config = require('../src/config');

const appDataRoot = app.getPath('appData');
const userDataRoot = path.join(appDataRoot, 'minecraft-llm-bot');
const configPath = path.join(userDataRoot, 'config.user.json');
const promptDefaultPath = path.join(app.getAppPath(), 'prompts', 'system_prompt.default.txt');
const promptUserPath = path.join(userDataRoot, 'system_prompt.txt');

const getResourceRoot = () => (app.isPackaged ? process.resourcesPath : app.getAppPath());
const defaultViaProxyRoot = app.isPackaged
    ? path.join(getResourceRoot(), 'viaproxy')
    : path.join(getResourceRoot(), 'tools', 'viaproxy');

let mainWindow = null;
let currentConfig = config;
let botProcess = null;
let botStatus = { running: false };
let viaProxyProcess = null;

const readFileSafe = (filePath) => {
    try {
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        return null;
    }
};

const writeFileSafe = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
};

const writeJsonSafe = (filePath, data) => {
    const serialized = JSON.stringify(data, null, 2);
    writeFileSafe(filePath, serialized);
};

const normalizeUrl = (raw) => {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
    return `http://${trimmed}`;
};

const fetchWithTimeout = async (url, timeoutMs = 2000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timer);
    }
};

const listModelsViaApi = async (host) => {
    const normalized = normalizeUrl(host);
    if (!normalized) throw new Error('OLLAMA_HOST is empty');
    const response = await fetchWithTimeout(`${normalized.replace(/\/$/, '')}/api/tags`, 2500);
    if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models.map(m => m.name).filter(Boolean) : [];
    return models;
};

const listModelsViaCli = async () => {
    return new Promise((resolve) => {
        execFile('ollama', ['list'], { timeout: 5000 }, (err, stdout) => {
            if (err) {
                resolve({ models: [], error: err.message });
                return;
            }
            const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
            if (lines.length <= 1) {
                resolve({ models: [] });
                return;
            }
            const models = lines.slice(1).map(line => line.split(/\s+/)[0]).filter(Boolean);
            resolve({ models });
        });
    });
};

const checkTcp = async (host, port) => {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve({ ok, error });
        };
        socket.setTimeout(1500);
        socket.on('connect', () => finish(true, null));
        socket.on('timeout', () => finish(false, 'timeout'));
        socket.on('error', (err) => finish(false, err.message));
        socket.connect(Number(port), host);
    });
};

const findViaProxyJar = (root) => {
    try {
        if (!root || !fs.existsSync(root)) return null;
        const entries = fs.readdirSync(root);
        const jar = entries.find(name => /^ViaProxy-.*\.jar$/i.test(name)) || entries.find(name => /\.jar$/i.test(name));
        return jar ? path.join(root, jar) : null;
    } catch (e) {
        return null;
    }
};

const getViaProxySettings = () => {
    const viaProxy = currentConfig.viaProxy || {};
    const root = viaProxy.root || viaProxy.path || defaultViaProxyRoot;
    const jar = viaProxy.jar || findViaProxyJar(root);
    const javaPath = viaProxy.javaPath || 'java';
    const argsRaw = viaProxy.args || '';
    const args = Array.isArray(argsRaw)
        ? argsRaw
        : String(argsRaw)
            .split(' ')
            .map(arg => arg.trim())
            .filter(Boolean);
    const autoStart = Boolean(viaProxy.autoStart);
    return { root, jar, javaPath, args, autoStart };
};

const startViaProxy = () => {
    if (viaProxyProcess) return { ok: true, status: 'already_running' };
    const settings = getViaProxySettings();
    if (!settings.jar) {
        return { ok: false, error: 'ViaProxy jar not found' };
    }
    viaProxyProcess = spawn(settings.javaPath, ['-jar', settings.jar, ...settings.args], {
        cwd: settings.root,
        stdio: 'pipe'
    });
    viaProxyProcess.once('error', (err) => {
        viaProxyProcess = null;
        if (mainWindow) {
            mainWindow.webContents.send('proxy-error', { error: err.message });
        }
    });
    viaProxyProcess.on('exit', () => {
        viaProxyProcess = null;
    });
    return { ok: true, status: 'started' };
};

const stopViaProxy = () => {
    if (!viaProxyProcess) return { ok: true, status: 'not_running' };
    viaProxyProcess.kill();
    viaProxyProcess = null;
    return { ok: true, status: 'stopped' };
};

const getBotEntry = () => path.join(app.getAppPath(), 'src', 'index.js');

const startBot = () => {
    if (botProcess) return { ok: true, status: 'already_running' };
    const entry = getBotEntry();
    botProcess = fork(entry, [], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            BOT_CONFIG_PATH: configPath
        },
        execPath: process.execPath,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    botProcess.on('message', (msg) => {
        if (msg && msg.type === 'bot_status') {
            botStatus = msg.data || botStatus;
            if (mainWindow) {
                mainWindow.webContents.send('bot-status', botStatus);
            }
        }
    });
    botProcess.on('exit', () => {
        botProcess = null;
        botStatus = { running: false };
        if (mainWindow) {
            mainWindow.webContents.send('bot-status', botStatus);
        }
    });
    return { ok: true, status: 'started' };
};

const stopBot = () => {
    if (!botProcess) return { ok: true, status: 'not_running' };
    botProcess.send({ type: 'shutdown' });
    setTimeout(() => {
        if (botProcess) {
            botProcess.kill('SIGKILL');
        }
    }, 3000);
    return { ok: true, status: 'stopping' };
};

const waitForBotExit = (timeoutMs = 5000) => {
    return new Promise((resolve) => {
        if (!botProcess) {
            resolve(true);
            return;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolve(true);
        };
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(false);
        }, timeoutMs);
        botProcess.once('exit', () => {
            clearTimeout(timer);
            finish();
        });
    });
};

const restartBot = async () => {
    if (!botProcess) {
        return startBot();
    }
    stopBot();
    await waitForBotExit(6000);
    return startBot();
};

const sendBotCommand = (type, payload = {}) => {
    if (!botProcess) return { ok: false, error: 'bot not running' };
    botProcess.send({ type, payload });
    return { ok: true };
};

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1020,
        height: 900,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
    if (currentConfig.launcher && currentConfig.launcher.autoStartBot) {
        startBot();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', async () => {
    return {
        config: currentConfig,
        configPath,
        defaults: {
            viaProxyRoot: defaultViaProxyRoot,
            viaProxyJar: findViaProxyJar(defaultViaProxyRoot)
        }
    };
});

ipcMain.handle('save-config', async (_, payload) => {
    currentConfig = payload;
    writeJsonSafe(configPath, payload);
    return { ok: true, path: configPath };
});

ipcMain.handle('get-prompt', async () => {
    const userPrompt = readFileSafe(promptUserPath);
    if (userPrompt && userPrompt.trim().length > 0) {
        return { text: userPrompt, source: 'user', path: promptUserPath };
    }
    const defaultPrompt = readFileSafe(promptDefaultPath) || '';
    return { text: defaultPrompt, source: 'default', path: promptDefaultPath };
});

ipcMain.handle('save-prompt', async (_, text) => {
    writeFileSafe(promptUserPath, String(text || ''));
    return { ok: true, path: promptUserPath };
});

ipcMain.handle('get-default-prompt', async () => {
    const defaultPrompt = readFileSafe(promptDefaultPath) || '';
    return { text: defaultPrompt, source: 'default', path: promptDefaultPath };
});

ipcMain.handle('list-models', async (_, host) => {
    try {
        const models = await listModelsViaApi(host);
        return { models, source: 'api' };
    } catch (e) {
        const cliResult = await listModelsViaCli();
        return { models: cliResult.models || [], source: 'cli', error: cliResult.error || e.message };
    }
});

ipcMain.handle('check-proxy', async (_, host, port) => {
    if (!host || !port) return { ok: false, error: 'host or port missing' };
    return checkTcp(host, port);
});

ipcMain.handle('start-bot', async () => {
    if (getViaProxySettings().autoStart) startViaProxy();
    return startBot();
});

ipcMain.handle('stop-bot', async () => stopBot());
ipcMain.handle('restart-bot', async () => restartBot());
ipcMain.handle('bot-status', async () => botStatus);
ipcMain.handle('bot-command', async (_, type, payload) => sendBotCommand(type, payload));

ipcMain.handle('start-viaproxy', async () => startViaProxy());
ipcMain.handle('stop-viaproxy', async () => stopViaProxy());
ipcMain.handle('viaproxy-status', async () => ({
    running: Boolean(viaProxyProcess),
    root: getViaProxySettings().root,
    jar: getViaProxySettings().jar
}));
