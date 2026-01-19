const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { execFile } = require('child_process');

const config = require('../src/config');

const userDataRoot = app.getPath('userData');
const configPath = path.join(userDataRoot, 'config.user.json');
const promptDefaultPath = path.join(app.getAppPath(), 'prompts', 'system_prompt.default.txt');
const promptUserPath = path.join(userDataRoot, 'system_prompt.txt');

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

const createWindow = () => {
    const win = new BrowserWindow({
        width: 980,
        height: 820,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    win.loadFile(path.join(__dirname, 'index.html'));
};

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-config', async () => {
    return {
        config,
        configPath
    };
});

ipcMain.handle('save-config', async (_, payload) => {
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
