const qs = (id) => document.getElementById(id);

const fields = {
    botHost: qs('botHost'),
    botPort: qs('botPort'),
    botUsername: qs('botUsername'),
    botVersion: qs('botVersion'),
    botAuth: qs('botAuth'),
    serverHost: qs('serverHost'),
    serverPort: qs('serverPort'),
    ollamaHost: qs('ollamaHost'),
    ollamaModel: qs('ollamaModel'),
    ollamaContext: qs('ollamaContext'),
    ollamaTemperature: qs('ollamaTemperature'),
    viaProxyRoot: qs('viaProxyRoot'),
    viaProxyJar: qs('viaProxyJar'),
    javaPath: qs('javaPath'),
    viaProxyArgs: qs('viaProxyArgs'),
    autoStartProxy: qs('autoStartProxy'),
    syncViaProxyConfig: qs('syncViaProxyConfig'),
    viaProxyTargetVersion: qs('viaProxyTargetVersion'),
    viaProxyAuthMethod: qs('viaProxyAuthMethod'),
    viaProxyOnlineMode: qs('viaProxyOnlineMode'),
    viaProxyAccountIndex: qs('viaProxyAccountIndex'),
    viaProxyBackendProxyUrl: qs('viaProxyBackendProxyUrl'),
    autoStartBot: qs('autoStartBot'),
    autoReconnect: qs('autoReconnect'),
    reconnectDelayMs: qs('reconnectDelayMs'),
    maxReconnectAttempts: qs('maxReconnectAttempts'),
    waitForProxy: qs('waitForProxy'),
    waitForProxyTimeoutMs: qs('waitForProxyTimeoutMs'),
    defaultMode: qs('defaultMode'),
    commandPrefixes: qs('commandPrefixes'),
    chatCooldown: qs('chatCooldown'),
    globalChatCooldown: qs('globalChatCooldown'),
    maxChatHistory: qs('maxChatHistory'),
    socialRoundInterval: qs('socialRoundInterval'),
    perPlayerChatCooldown: qs('perPlayerChatCooldown'),
    maxFactsPerPlayer: qs('maxFactsPerPlayer'),
    etiquetteMuteMinutes: qs('etiquetteMuteMinutes'),
    systemPrompt: qs('systemPrompt'),
    currentUsername: qs('currentUsername'),
    newUsername: qs('newUsername'),
    currentMode: qs('currentMode'),
    liveMode: qs('liveMode'),
    liveChat: qs('liveChat'),
    liveCommand: qs('liveCommand')
};

const proxyStatus = qs('proxyStatus');
const ollamaStatus = qs('ollamaStatus');
const modelSelect = qs('modelSelect');
const modelHint = qs('modelHint');
const promptSource = qs('promptSource');
const saveStatus = qs('saveStatus');
const viaProxyRunStatus = qs('viaProxyRunStatus');
const botRunStatus = qs('botRunStatus');
const botStatusHint = qs('botStatusHint');
const botLog = qs('botLog');
const proxyLog = qs('proxyLog');
const memoryText = qs('memoryText');
const memoryStatus = qs('memoryStatus');
const memoryAutoRefresh = qs('memoryAutoRefresh');
const memoryAutoSave = qs('memoryAutoSave');
const memoryPlayerName = qs('memoryPlayerName');
const memoryWorldFact = qs('memoryWorldFact');
const memoryWorldEvent = qs('memoryWorldEvent');

const botLogBuffer = [];
const proxyLogBuffer = [];
const maxLogLines = 200;
let memoryDirty = false;
let memoryRefreshTimer = null;
let memorySaveTimer = null;

const readNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const appendLog = (buffer, element, chunk) => {
    if (!element || !chunk) return;
    const lines = String(chunk).split(/\r?\n/).filter(line => line.length > 0);
    if (lines.length === 0) return;
    buffer.push(...lines);
    if (buffer.length > maxLogLines) {
        buffer.splice(0, buffer.length - maxLogLines);
    }
    element.value = buffer.join('\n');
    element.scrollTop = element.scrollHeight;
};

const parsePrefixes = (raw) => {
    if (!raw) return [];
    return String(raw)
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
};

const normalizeMemory = (data) => {
    const output = data && typeof data === 'object' ? data : {};
    if (!output.players || typeof output.players !== 'object') output.players = {};
    if (!output.world || typeof output.world !== 'object') output.world = {};
    if (!Array.isArray(output.world.facts)) output.world.facts = [];
    if (!Array.isArray(output.world.chat)) output.world.chat = [];
    if (!Array.isArray(output.world.events)) output.world.events = [];
    if (!Array.isArray(output.world.placedBlocks)) output.world.placedBlocks = [];
    return output;
};

const memoryStats = (data) => {
    const players = Object.keys(data.players || {}).length;
    const facts = (data.world && data.world.facts ? data.world.facts.length : 0);
    const chat = (data.world && data.world.chat ? data.world.chat.length : 0);
    const events = (data.world && data.world.events ? data.world.events.length : 0);
    const placed = (data.world && data.world.placedBlocks ? data.world.placedBlocks.length : 0);
    return `Игроки: ${players} | Факты: ${facts} | Чат: ${chat} | События: ${events} | Блоки: ${placed}`;
};

const loadMemory = async () => {
    const result = await window.api.getMemory();
    if (!result.ok) {
        memoryStatus.textContent = result.error || 'ошибка загрузки памяти';
        return;
    }
    const normalized = normalizeMemory(result.data);
    if (!memoryDirty) {
        memoryText.value = JSON.stringify(normalized, null, 2);
    }
    memoryStatus.textContent = `${memoryStats(normalized)} | ${result.path}`;
    memoryDirty = false;
};

const saveMemory = async (override) => {
    let data = override;
    if (!data) {
        try {
            data = JSON.parse(memoryText.value || '{}');
        } catch (e) {
            memoryStatus.textContent = `ошибка JSON: ${e.message}`;
            return;
        }
    }
    const normalized = normalizeMemory(data);
    const result = await window.api.saveMemory(normalized);
    if (!result.ok) {
        memoryStatus.textContent = result.error || 'ошибка сохранения памяти';
        return;
    }
    memoryStatus.textContent = `сохранено | ${memoryStats(normalized)}`;
    memoryDirty = false;
};

const scheduleAutoSave = () => {
    if (memorySaveTimer) clearTimeout(memorySaveTimer);
    if (memoryAutoSave.value !== 'true') return;
    memorySaveTimer = setTimeout(() => {
        saveMemory();
    }, 1200);
};

const setMemoryRefresh = (enabled) => {
    if (memoryRefreshTimer) {
        clearInterval(memoryRefreshTimer);
        memoryRefreshTimer = null;
    }
    if (!enabled) return;
    memoryRefreshTimer = setInterval(() => {
        if (!memoryDirty) {
            loadMemory();
        }
    }, 5000);
};

const fillForm = (config, defaults) => {
    fields.botHost.value = config.bot?.host || '';
    fields.botPort.value = config.bot?.port ?? '';
    fields.botUsername.value = config.bot?.username || '';
    fields.botVersion.value = config.bot?.version || '';
    fields.botAuth.value = config.bot?.auth || '';

    fields.serverHost.value = config.proxy?.targetHost || '';
    fields.serverPort.value = config.proxy?.targetPort ?? '';

    fields.ollamaHost.value = config.llm?.host || '';
    fields.ollamaModel.value = config.llm?.defaultModel || '';
    fields.ollamaContext.value = config.llm?.contextWindow ?? '';
    fields.ollamaTemperature.value = config.llm?.temperature ?? '';

    const viaProxy = config.viaProxy || {};
    fields.viaProxyRoot.value = viaProxy.root || viaProxy.path || defaults?.viaProxyRoot || '';
    fields.viaProxyJar.value = viaProxy.jar || defaults?.viaProxyJar || '';
    fields.javaPath.value = viaProxy.javaPath || '';
    fields.viaProxyArgs.value = Array.isArray(viaProxy.args) ? viaProxy.args.join(' ') : (viaProxy.args || '');
    fields.autoStartProxy.value = String(Boolean(viaProxy.autoStart));
    fields.syncViaProxyConfig.value = String(viaProxy.syncConfig !== false);
    fields.viaProxyTargetVersion.value = viaProxy.targetVersion || '';
    fields.viaProxyAuthMethod.value = (viaProxy.authMethod || 'NONE').toUpperCase();
    fields.viaProxyOnlineMode.value = String(Boolean(viaProxy.proxyOnlineMode));
    fields.viaProxyAccountIndex.value = viaProxy.accountIndex ?? 0;
    fields.viaProxyBackendProxyUrl.value = viaProxy.backendProxyUrl || '';
    fields.autoStartBot.value = String(Boolean(config.launcher?.autoStartBot));
    fields.autoReconnect.value = String(config.connection?.autoReconnect !== false);
    fields.reconnectDelayMs.value = config.connection?.reconnectDelayMs ?? 5000;
    fields.maxReconnectAttempts.value = config.connection?.maxReconnectAttempts ?? 0;
    fields.waitForProxy.value = String(config.launcher?.waitForProxy !== false);
    fields.waitForProxyTimeoutMs.value = config.launcher?.waitForProxyTimeoutMs ?? 15000;

    fields.defaultMode.value = config.behavior?.defaultMode || 'manual';
    fields.liveMode.value = config.behavior?.defaultMode || 'manual';
    fields.commandPrefixes.value = (config.behavior?.commandPrefixes || []).join(', ');
    fields.chatCooldown.value = config.behavior?.chatCooldown ?? '';
    fields.globalChatCooldown.value = config.behavior?.globalChatCooldown ?? '';
    fields.maxChatHistory.value = config.behavior?.maxChatHistory ?? '';
    fields.socialRoundInterval.value = config.behavior?.socialRoundInterval ?? '';
    fields.perPlayerChatCooldown.value = config.behavior?.perPlayerChatCooldown ?? '';
    fields.maxFactsPerPlayer.value = config.behavior?.maxFactsPerPlayer ?? '';
    fields.etiquetteMuteMinutes.value = config.behavior?.etiquetteMuteMinutes ?? '';
};

const buildConfigPayload = () => {
    return {
        bot: {
            host: fields.botHost.value.trim(),
            port: readNumber(fields.botPort.value, 25568),
            username: fields.botUsername.value.trim(),
            version: fields.botVersion.value.trim(),
            auth: fields.botAuth.value.trim()
        },
        proxy: {
            targetHost: fields.serverHost.value.trim(),
            targetPort: readNumber(fields.serverPort.value, 25565)
        },
        llm: {
            host: fields.ollamaHost.value.trim(),
            defaultModel: fields.ollamaModel.value.trim(),
            contextWindow: readNumber(fields.ollamaContext.value, 8192),
            temperature: readNumber(fields.ollamaTemperature.value, 0.7)
        },
        viaProxy: {
            root: fields.viaProxyRoot.value.trim(),
            jar: fields.viaProxyJar.value.trim(),
            javaPath: fields.javaPath.value.trim(),
            args: fields.viaProxyArgs.value.trim(),
            autoStart: fields.autoStartProxy.value === 'true',
            syncConfig: fields.syncViaProxyConfig.value === 'true',
            targetVersion: fields.viaProxyTargetVersion.value.trim(),
            authMethod: fields.viaProxyAuthMethod.value.trim(),
            proxyOnlineMode: fields.viaProxyOnlineMode.value === 'true',
            accountIndex: readNumber(fields.viaProxyAccountIndex.value, 0),
            backendProxyUrl: fields.viaProxyBackendProxyUrl.value.trim()
        },
        connection: {
            autoReconnect: fields.autoReconnect.value === 'true',
            reconnectDelayMs: readNumber(fields.reconnectDelayMs.value, 5000),
            maxReconnectAttempts: readNumber(fields.maxReconnectAttempts.value, 0)
        },
        launcher: {
            autoStartBot: fields.autoStartBot.value === 'true',
            waitForProxy: fields.waitForProxy.value === 'true',
            waitForProxyTimeoutMs: readNumber(fields.waitForProxyTimeoutMs.value, 15000)
        },
        behavior: {
            defaultMode: fields.defaultMode.value,
            commandPrefixes: parsePrefixes(fields.commandPrefixes.value),
            chatCooldown: readNumber(fields.chatCooldown.value, 5000),
            globalChatCooldown: readNumber(fields.globalChatCooldown.value, 0),
            maxChatHistory: readNumber(fields.maxChatHistory.value, 20),
            socialRoundInterval: readNumber(fields.socialRoundInterval.value, 500000),
            perPlayerChatCooldown: readNumber(fields.perPlayerChatCooldown.value, 120000),
            maxFactsPerPlayer: readNumber(fields.maxFactsPerPlayer.value, 50),
            etiquetteMuteMinutes: readNumber(fields.etiquetteMuteMinutes.value, 10)
        }
    };
};

const updateModelList = (models) => {
    modelSelect.innerHTML = '';
    if (!models || models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'моделей нет';
        modelSelect.appendChild(option);
        modelHint.textContent = 'Нет моделей. Рекомендуется: ollama pull deepseek-llm';
        return;
    }
    models.forEach(model => {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelSelect.appendChild(option);
    });
    modelHint.textContent = `Найдено моделей: ${models.length}`;
};

const loadPrompt = async () => {
    const prompt = await window.api.loadPrompt();
    fields.systemPrompt.value = prompt.text || '';
    promptSource.textContent = prompt.source === 'user'
        ? `Источник: пользовательский (${prompt.path})`
        : `Источник: по умолчанию (${prompt.path})`;
};

const refreshModels = async () => {
    ollamaStatus.textContent = 'проверяю...';
    const result = await window.api.listModels(fields.ollamaHost.value);
    updateModelList(result.models);
    if (result.models.length > 0) {
        ollamaStatus.textContent = `моделей: ${result.models.length} (${result.source})`;
    } else {
        ollamaStatus.textContent = result.error ? `ошибка: ${result.error}` : 'моделей нет';
    }
};

const checkProxy = async () => {
    proxyStatus.textContent = 'проверяю...';
    const result = await window.api.checkProxy(fields.botHost.value.trim(), fields.botPort.value);
    proxyStatus.textContent = result.ok ? 'подключение ок' : `ошибка: ${result.error}`;
};

const saveConfig = async () => {
    const payload = buildConfigPayload();
    const result = await window.api.saveConfig(payload);
    if (!result.ok) {
        saveStatus.textContent = 'ошибка сохранения';
        return;
    }
    if (result.sync && result.sync.ok === false) {
        saveStatus.textContent = `сохранено: ${result.path} (ViaProxy: ${result.sync.error})`;
        return;
    }
    saveStatus.textContent = `сохранено: ${result.path}`;
};

const savePrompt = async () => {
    const result = await window.api.savePrompt(fields.systemPrompt.value);
    promptSource.textContent = result.ok ? `Источник: пользовательский (${result.path})` : 'ошибка сохранения prompt';
};

const saveAll = async () => {
    await saveConfig();
    await savePrompt();
};

const updateBotStatus = (status) => {
    if (!status || !status.running) {
        botRunStatus.textContent = 'остановлен';
        fields.currentUsername.value = '';
        fields.currentMode.value = '';
        botStatusHint.textContent = '';
        return;
    }
    botRunStatus.textContent = 'работает';
    fields.currentUsername.value = status.username || '';
    fields.currentMode.value = status.mode || '';
    const hp = status.health ?? '-';
    const food = status.food ?? '-';
    const pos = status.position ? `${status.position.x},${status.position.y},${status.position.z}` : '-';
    botStatusHint.textContent = `HP: ${hp} | Food: ${food} | Pos: ${pos}`;
};

const refreshProcessStatuses = async () => {
    const botStatus = await window.api.getBotStatus();
    updateBotStatus(botStatus);
    const proxyStatus = await window.api.getViaProxyStatus();
    viaProxyRunStatus.textContent = proxyStatus.running ? 'работает' : 'остановлен';
};

const startBot = async () => {
    await saveConfig();
    const result = await window.api.startBot();
    if (!result.ok) {
        const message = result.error || 'не удалось';
        botRunStatus.textContent = `ошибка: ${message}`;
        botStatusHint.textContent = `ошибка запуска: ${message}`;
    } else {
        botRunStatus.textContent = result.status || 'запускается';
    }
    return result;
};

const stopBot = async () => {
    const result = await window.api.stopBot();
    botRunStatus.textContent = result.status || 'останавливается';
};

const startViaProxy = async () => {
    await saveConfig();
    const result = await window.api.startViaProxy();
    if (!result.ok) {
        viaProxyRunStatus.textContent = `ошибка: ${result.error || 'не удалось'}`;
    } else {
        viaProxyRunStatus.textContent = result.status || 'запускается';
    }
    return result;
};

const stopViaProxy = async () => {
    const result = await window.api.stopViaProxy();
    viaProxyRunStatus.textContent = result.status || 'останавливается';
};

const applyUsername = async () => {
    const newName = fields.newUsername.value.trim();
    if (!newName) return;
    fields.botUsername.value = newName;
    await saveConfig();
    const result = await window.api.restartBot();
    botStatusHint.textContent = result.ok ? 'бот перезапускается с новым ником' : `ошибка: ${result.error || 'не удалось'}`;
    fields.newUsername.value = '';
};

const init = async () => {
    const configResult = await window.api.loadConfig();
    fillForm(configResult.config, configResult.defaults);
    await loadPrompt();
    await refreshModels();
    await refreshProcessStatuses();
};

qs('saveConfigBtn').addEventListener('click', saveConfig);
qs('savePromptBtn').addEventListener('click', savePrompt);
qs('saveAllBtn').addEventListener('click', saveAll);
qs('refreshModelsBtn').addEventListener('click', refreshModels);
qs('checkProxyBtn').addEventListener('click', checkProxy);
qs('startBotBtn').addEventListener('click', startBot);
qs('stopBotBtn').addEventListener('click', stopBot);
qs('startViaProxyBtn').addEventListener('click', startViaProxy);
qs('stopViaProxyBtn').addEventListener('click', stopViaProxy);
qs('applyUsernameBtn').addEventListener('click', applyUsername);
qs('startAllBtn').addEventListener('click', async () => {
    const proxyResult = await startViaProxy();
    if (proxyResult && proxyResult.ok === false) return;
    await startBot();
});
qs('setModeBtn').addEventListener('click', async () => {
    await window.api.botCommand('set_mode', { mode: fields.liveMode.value });
});
qs('stopTasksBtn').addEventListener('click', async () => {
    await window.api.botCommand('stop_tasks', {});
});
qs('sendChatBtn').addEventListener('click', async () => {
    const text = fields.liveChat.value.trim();
    if (!text) return;
    await window.api.botCommand('chat', { text });
    fields.liveChat.value = '';
});
qs('sendCommandBtn').addEventListener('click', async () => {
    const text = fields.liveCommand.value.trim();
    if (!text) return;
    await window.api.botCommand('user_command', { text });
    fields.liveCommand.value = '';
});
qs('reloadPromptBtn').addEventListener('click', async () => {
    await window.api.botCommand('reload_prompt', {});
});
qs('openLogsBtn').addEventListener('click', async () => {
    await window.api.openLogsFolder();
});
qs('useModelBtn').addEventListener('click', () => {
    if (modelSelect.value) {
        fields.ollamaModel.value = modelSelect.value;
    }
});
qs('copyPullBtn').addEventListener('click', async () => {
    const command = 'ollama pull deepseek-llm';
    try {
        await navigator.clipboard.writeText(command);
        modelHint.textContent = 'Команда скопирована в буфер обмена.';
    } catch (e) {
        modelHint.textContent = `Скопируй вручную: ${command}`;
    }
});
qs('loadDefaultPromptBtn').addEventListener('click', async () => {
    const defaultPrompt = await window.api.loadDefaultPrompt();
    fields.systemPrompt.value = defaultPrompt.text || '';
    promptSource.textContent = `Источник: по умолчанию (${defaultPrompt.path})`;
});

qs('memoryReloadBtn').addEventListener('click', loadMemory);
qs('memorySaveBtn').addEventListener('click', () => saveMemory());
qs('memoryClearChatBtn').addEventListener('click', async () => {
    let data;
    try {
        data = JSON.parse(memoryText.value || '{}');
    } catch (e) {
        memoryStatus.textContent = `ошибка JSON: ${e.message}`;
        return;
    }
    data = normalizeMemory(data);
    data.world.chat = [];
    await saveMemory(data);
});
qs('memoryClearEventsBtn').addEventListener('click', async () => {
    let data;
    try {
        data = JSON.parse(memoryText.value || '{}');
    } catch (e) {
        memoryStatus.textContent = `ошибка JSON: ${e.message}`;
        return;
    }
    data = normalizeMemory(data);
    data.world.events = [];
    await saveMemory(data);
});
qs('memoryClearAllBtn').addEventListener('click', async () => {
    const cleared = normalizeMemory({});
    await saveMemory(cleared);
    memoryText.value = JSON.stringify(cleared, null, 2);
});
qs('memoryClearPlayerBtn').addEventListener('click', async () => {
    const player = (memoryPlayerName.value || '').trim();
    if (!player) return;
    let data;
    try {
        data = JSON.parse(memoryText.value || '{}');
    } catch (e) {
        memoryStatus.textContent = `ошибка JSON: ${e.message}`;
        return;
    }
    data = normalizeMemory(data);
    delete data.players[player];
    await saveMemory(data);
});
qs('memoryAddFactBtn').addEventListener('click', async () => {
    const text = (memoryWorldFact.value || '').trim();
    if (!text) return;
    let data;
    try {
        data = JSON.parse(memoryText.value || '{}');
    } catch (e) {
        memoryStatus.textContent = `ошибка JSON: ${e.message}`;
        return;
    }
    data = normalizeMemory(data);
    data.world.facts.push({ timestamp: Date.now(), source: 'panel', text });
    memoryWorldFact.value = '';
    await saveMemory(data);
});
qs('memoryAddEventBtn').addEventListener('click', async () => {
    const text = (memoryWorldEvent.value || '').trim();
    if (!text) return;
    let data;
    try {
        data = JSON.parse(memoryText.value || '{}');
    } catch (e) {
        memoryStatus.textContent = `ошибка JSON: ${e.message}`;
        return;
    }
    data = normalizeMemory(data);
    data.world.events.push({ timestamp: Date.now(), type: 'panel', text });
    memoryWorldEvent.value = '';
    await saveMemory(data);
});

memoryText.addEventListener('input', () => {
    memoryDirty = true;
    scheduleAutoSave();
});
memoryAutoRefresh.addEventListener('change', () => setMemoryRefresh(memoryAutoRefresh.value === 'true'));
memoryAutoSave.addEventListener('change', scheduleAutoSave);

window.api.onBotStatus(updateBotStatus);
window.api.onBotError((payload) => {
    botStatusHint.textContent = payload && payload.error ? `ошибка бота: ${payload.error}` : 'ошибка запуска бота';
});
window.api.onProxyError((payload) => {
    viaProxyRunStatus.textContent = payload && payload.error ? `ошибка: ${payload.error}` : 'ошибка запуска';
});
window.api.onBotLog((payload) => {
    appendLog(botLogBuffer, botLog, payload && payload.text ? payload.text : '');
});
window.api.onProxyLog((payload) => {
    appendLog(proxyLogBuffer, proxyLog, payload && payload.text ? payload.text : '');
});
setInterval(refreshProcessStatuses, 5000);

init();
loadMemory();
setMemoryRefresh(true);
