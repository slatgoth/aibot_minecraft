const fs = require('fs');
const { Ollama } = require('ollama');
const config = require('./config');
const { logger } = require('./utils');
const memory = require('./memory_store');
const training = require('./training_store');

class LLMClient {
    constructor() {
        this.ollama = new Ollama({ host: config.llm.host });
        this.model = null;
        this.systemPrompt = this.buildSystemPrompt();
        this.available = true;
        this.unavailableUntil = 0;
        this.initInFlight = null;
    }

    async init() {
        if (this.initInFlight) return this.initInFlight;
        this.initInFlight = (async () => {
            try {
            const list = await this.ollama.list();
            const preferredRaw = config.llm && config.llm.defaultModel ? String(config.llm.defaultModel).trim() : '';
            const preferred = preferredRaw ? preferredRaw.toLowerCase() : '';
            const preferredMatch = preferred
                ? (list.models.find(m => m.name === preferredRaw)
                    || list.models.find(m => m.name.toLowerCase() === preferred)
                    || list.models.find(m => m.name.includes(preferredRaw)))
                : null;
            const deepseek = list.models.find(m => m.name.includes('deepseek'));
            if (preferredMatch) {
                this.model = preferredMatch.name;
                logger.info(`Selected LLM model: ${this.model}`);
            } else if (preferredRaw && list.models.length > 0) {
                this.model = deepseek ? deepseek.name : list.models[0].name;
                logger.warn(`Preferred model not found (${preferredRaw}). Using: ${this.model}`);
            } else if (deepseek) {
                this.model = deepseek.name;
                logger.info(`Selected LLM model: ${this.model}`);
            } else {
                this.model = list.models.length > 0 ? list.models[0].name : 'llama2';
                logger.warn(`No preferred/deepseek model found. Using: ${this.model}`);
            }
            this.available = true;
            this.unavailableUntil = 0;
        } catch (e) {
            logger.error('Failed to list Ollama models', e);
            const fallback = config.llm && config.llm.defaultModel ? String(config.llm.defaultModel) : 'deepseek-llm';
            this.model = fallback; // Default fallback name
            this.markUnavailable();
        } finally {
            this.initInFlight = null;
        }
        })();
        return this.initInFlight;
    }

    markUnavailable() {
        this.available = false;
        this.unavailableUntil = Date.now() + 60000;
    }

    isAvailable() {
        return this.available && Date.now() >= this.unavailableUntil;
    }

    normalizeContent(content) {
        let text = String(content || '').trim();
        if (!text) return text;
        text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        return text;
    }

    tryParseJson(content) {
        const cleaned = this.normalizeContent(content);
        if (!cleaned) return null;
        try {
            return JSON.parse(cleaned);
        } catch (e) {
            const extracted = this.extractJsonBlock(cleaned);
            if (extracted) {
                try {
                    return JSON.parse(extracted);
                } catch (err) {
                    return null;
                }
            }
        }
        return null;
    }

    extractJsonBlock(text) {
        const start = text.indexOf('{');
        if (start === -1) return null;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < text.length; i += 1) {
            const ch = text[i];
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = !inString;
            }
            if (inString) continue;
            if (ch === '{') depth += 1;
            if (ch === '}') {
                depth -= 1;
                if (depth === 0) {
                    return text.slice(start, i + 1);
                }
            }
        }
        return null;
    }

    sanitizeDecision(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const decision = {
            thought: raw.thought !== undefined ? String(raw.thought) : null,
            chat: raw.chat !== undefined ? raw.chat : null,
            actions: Array.isArray(raw.actions) ? raw.actions : []
        };
        decision.actions = decision.actions
            .filter(action => action && typeof action === 'object' && action.name)
            .map(action => ({
                name: String(action.name),
                args: action.args && typeof action.args === 'object' ? action.args : {}
            }));
        if (decision.chat !== null && decision.chat !== undefined) {
            const text = String(decision.chat).trim();
            decision.chat = text.length ? text : null;
        } else {
            decision.chat = null;
        }
        return decision;
    }

    loadPromptFromFile(filePath) {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            const raw = fs.readFileSync(filePath, 'utf8');
            const trimmed = String(raw || '').trim();
            if (!trimmed.length) return null;
            return trimmed;
        } catch (e) {
            return null;
        }
    }

    applyPromptTemplate(prompt) {
        if (!prompt) return prompt;
        return prompt.replace(/\{bot_username\}/g, config.bot.username);
    }

    buildSystemPrompt() {
        const userPrompt = this.loadPromptFromFile(config.paths.systemPromptUser)
            || this.loadPromptFromFile(config.paths.systemPrompt);
        const trainingAddon = training.buildPromptAddon();
        if (userPrompt) {
            const combined = [userPrompt, trainingAddon].filter(Boolean).join('\n\n');
            return this.applyPromptTemplate(combined);
        }
        const fallback = this.loadPromptFromFile(config.paths.systemPromptDefault);
        if (fallback) {
            const combined = [fallback, trainingAddon].filter(Boolean).join('\n\n');
            return this.applyPromptTemplate(combined);
        }
        const combined = [
            `
Ты - Minecraft бот-персонаж с ником ${config.bot.username}.
Личность:
- Стиль: разговорный, нижний регистр, без эмодзи, русский язык.
- Роль: реальный игрок, думаешь о выживании и помощи.
- Не используй оскорбления или личные данные.
- Отзывайся на ник ${config.bot.username}.

Инструкции:
1. Твой ответ должен быть валидным JSON объектом (БЕЗ markdown обертки \`\`\`json).
2. Формат ответа:
{
  "thought": "скрытое размышление",
  "chat": "текст в чат (или null)",
  "actions": [
     { "name": "tool_name", "args": { ... } }
  ]
}
3. ВАЖНО: Всегда проверяй 'inventory' в Context перед тем как сказать, что у тебя чего-то нет.
4. Если просят дать предмет - используй give_item.
5. Если действие не требуется, actions = [].
6. Если чат не требуется, chat = null.
7. Внимательно анализируй всех игроков из Context.players/playersOnline, а не только последнего отправителя.
8. Если игроков несколько - распределяй внимание и общайся со всеми в общем чате, обращаясь по нику.
9. Context.recentChat содержит последние сообщения всех игроков - учитывай общий чат.
10. Context.globalChat и Context.worldFacts содержат общую память мира - используй их для контекста.
11. Context.nearbySigns содержит текст табличек (если видны).
12. Context.nearbyDrops содержит выпавшие предметы рядом.
13. Context.playerPlacedBlocks показывает блоки, которые поставили игроки рядом. Не ломай их.
14. Никогда не ломай блоки игроков и постройки. Добывай только природные ресурсы.
15. Если нужно пройти через дверь — используй open_door, а не ломай блок.
16. Если используешь remember_fact/remember_world_fact, не пиши об этом в чат.
17. Если пользователь пишет предметы по-русски, преобразуй в английские id (oak_log, cobblestone).

Доступные инструменты (Tools):
- say(text), whisper(player, text), reply_to(player, text)
- move_to(x, y, z), wander(range), follow(entity_name), stop()
- look_at(x, y, z), scan_surroundings()
- mine_block(name, count), place_block(name, x, y, z), activate_block(x, y, z), open_door(), read_sign()
- pickup_item(name, radius)
- craft_item(name, count), use_furnace(input_name, fuel_name, count)
- attack_entity(name), defend()
- check_inventory(), equip(item_name, slot)
- give_item(player_name, item_name, count), toss_all()
- sleep(), wake(), eat(name)
- use_chest(action, x, y, z, item_name, count) -> action: "deposit" or "withdraw"
- mount(entity_type), dismount()
- remember_fact(player_name, fact), remember_world_fact(fact)
- start_mining_task(name, count)
- start_gather_wood(count, types)
- start_farm_task(crops)
- get_status()
- jump(count)

Контекст:
Ты находишься в мире Minecraft. Используй инструменты для взаимодействия.
            `,
            trainingAddon
        ].filter(Boolean).join('\n\n');
        return this.applyPromptTemplate(combined);
    }

    isMemoryError(err) {
        const message = String((err && err.message) || err || '').toLowerCase();
        if (!message) return false;
        return message.includes('requires more system memory')
            || (message.includes('system memory') && message.includes('available'));
    }

    parseModelSize(name) {
        const match = String(name || '').toLowerCase().match(/(\d+)\s*b/);
        if (!match) return Number.POSITIVE_INFINITY;
        return Number.parseInt(match[1], 10);
    }

    async selectFallbackModel(currentModel, options = {}) {
        // Prefer explicit fallbacks, then smallest available model by name.
        const routing = training.getModelRouting();
        const candidates = [
            options.fallbackModel,
            routing ? routing.fallback : null,
            config.llm ? config.llm.fallbackModel : null
        ]
            .map(value => (value ? String(value).trim() : ''))
            .filter(Boolean)
            .filter(value => value !== currentModel);
        if (candidates.length > 0) return candidates[0];
        try {
            const list = await this.ollama.list();
            const models = (list.models || []).map(m => m.name).filter(Boolean);
            const filtered = models.filter(name => name !== currentModel);
            if (filtered.length === 0) return null;
            filtered.sort((a, b) => this.parseModelSize(a) - this.parseModelSize(b));
            return filtered[0];
        } catch (e) {
            return null;
        }
    }

    resolveModel(options = {}) {
        if (options.model) return String(options.model);
        const routing = training.getModelRouting();
        if (routing && typeof routing === 'object') {
            const reasonKey = options.reason ? String(options.reason) : null;
            if (reasonKey && routing[reasonKey]) return String(routing[reasonKey]);
            if (routing.default) return String(routing.default);
        }
        return this.model;
    }

    async generateResponse(userMessage, contextData, options = {}) {
        if (!this.isAvailable()) {
            if (Date.now() >= this.unavailableUntil) {
                await this.init();
            }
            if (!this.isAvailable()) return null;
        }
        if (!this.model) await this.init();
        if (!this.isAvailable()) return null;

        const messages = options.messagesOverride || [
            { role: 'system', content: this.systemPrompt },
            { role: 'system', content: `Context: ${JSON.stringify(contextData)}` },
            { role: 'user', content: userMessage }
        ];
        const selectedModel = this.resolveModel(options);

        try {
            const response = await this.ollama.chat({
                model: selectedModel,
                messages: messages,
                format: 'json', // Force JSON output
                stream: false
            });

            const parsed = this.tryParseJson(response.message.content);
            if (parsed) {
                const sanitized = this.sanitizeDecision(parsed);
                if (sanitized) return sanitized;
            }

            logger.error('Failed to parse LLM JSON response', { content: response.message.content });
            if (!options.retry) {
                const retryMessages = messages.concat({
                    role: 'system',
                    content: 'Верни только валидный JSON без текста вокруг. Строго по формату.'
                });
                return this.generateResponse(userMessage, contextData, { retry: true, messagesOverride: retryMessages });
            }
            return null;
        } catch (e) {
            if (this.isMemoryError(e) && !options.fallbackTried) {
                const fallbackModel = await this.selectFallbackModel(selectedModel, options);
                if (fallbackModel) {
                    logger.warn(`LLM OOM for ${selectedModel}. Falling back to ${fallbackModel}.`);
                    this.model = fallbackModel;
                    return this.generateResponse(userMessage, contextData, {
                        ...options,
                        model: fallbackModel,
                        fallbackTried: true
                    });
                }
            }
            logger.error('LLM request failed', e);
            this.markUnavailable();
            return null;
        }
    }
}

module.exports = new LLMClient();
