const { logger } = require('./utils');
const config = require('./config');
const memory = require('./memory_store');
const training = require('./training_store');
const llm = require('./llm_client');

class ChatHandler {
    constructor(bot, planner, speechManager) {
        this.bot = bot;
        this.planner = planner;
        this.speechManager = speechManager;
        this.lastUserRequestAt = new Map();
        this.lastGlobalRequestAt = 0;
    }

    say(text, player = null) {
        if (!text) return;
        if (this.speechManager) {
            this.speechManager.enqueue(String(text), { reason: 'direct', player });
            return;
        }
        this.bot.chat(String(text));
    }

    extractTopic(message, isAddressed, isMentioned, prefixes) {
        let text = String(message || '').trim();
        if (!text) return null;
        if (isAddressed && Array.isArray(prefixes)) {
            for (const prefix of prefixes) {
                const lowerPrefix = String(prefix || '').toLowerCase();
                if (text.toLowerCase().startsWith(lowerPrefix)) {
                    text = text.slice(prefix.length).trim();
                    break;
                }
            }
        }
        if (isMentioned) {
            text = text.replace(this.bot.username, '').trim();
        }
        const words = text.split(/\s+/).filter(Boolean);
        if (text.length < 6 || words.length < 2) return null;
        const stop = ['прыгай', 'иди', 'следуй', 'follow', 'go', 'stop', 'стоп'];
        if (words.length === 2 && stop.includes(words[0].toLowerCase())) return null;
        return text;
    }

    extractRewardFeedback(message, isAddressed, isMentioned, prefixes) {
        if (!isAddressed && !isMentioned) return null;
        let text = String(message || '').trim();
        if (!text) return null;
        if (isAddressed && Array.isArray(prefixes)) {
            for (const prefix of prefixes) {
                const lowerPrefix = String(prefix || '').toLowerCase();
                if (text.toLowerCase().startsWith(lowerPrefix)) {
                    text = text.slice(prefix.length).trim();
                    break;
                }
            }
        }
        if (isMentioned) {
            text = text.replace(this.bot.username, '').trim();
        }
        if (!text) return null;

        const clampScore = (score) => {
            const value = Number(score);
            if (!Number.isFinite(value) || value === 0) return 0;
            return Math.max(-10, Math.min(10, value));
        };

        const direct = text.match(/^([+-]\d+)\s*(.*)$/);
        if (direct) {
            const score = clampScore(direct[1]);
            const note = direct[2] ? direct[2].trim() : 'фидбек';
            return score ? { score, note } : null;
        }

        const short = text.match(/^(\+{1,3}|-{1,3})\s*(.*)$/);
        if (short) {
            const score = short[1].startsWith('+') ? 1 : -1;
            const note = short[2] ? short[2].trim() : (score > 0 ? 'похвала' : 'штраф');
            return { score, note };
        }

        const keyword = text.match(/^(поощрение|reward|feedback|штраф)\s*([+-]?\d+)?\s*(.*)$/i);
        if (keyword) {
            const isPenalty = keyword[1].toLowerCase() === 'штраф';
            const rawScore = keyword[2];
            const score = clampScore(rawScore || (isPenalty ? -1 : 1));
            const note = keyword[3] ? keyword[3].trim() : (isPenalty ? 'штраф' : 'поощрение');
            return score ? { score, note } : null;
        }

        return null;
    }

    isMuteRequest(messageLower, isAddressed, isMentioned) {
        if (!isAddressed && !isMentioned) return false;
        const triggers = [
            'заткнись',
            'замолчи',
            'молчи',
            'не пиши',
            'не говори',
            'отстань',
            'хватит',
            'не трогай',
            'не подходи',
            'не лезь',
            'shut up'
        ];
        return triggers.some(t => messageLower.includes(t));
    }

    isOnCooldown(username) {
        const cooldownMs = config.behavior.chatCooldown || 0;
        const globalCooldownMs = config.behavior.globalChatCooldown || 0;
        if (cooldownMs <= 0) return false;
        const now = Date.now();
        if (globalCooldownMs > 0 && now - this.lastGlobalRequestAt < globalCooldownMs) return true;
        const lastUserAt = this.lastUserRequestAt.get(username) || 0;
        return now - lastUserAt < cooldownMs;
    }

    markRequest(username) {
        const now = Date.now();
        this.lastGlobalRequestAt = now;
        this.lastUserRequestAt.set(username, now);
    }

    init() {
        if (this._onChat) return;
        this._onChat = async (username, message) => {
            if (username === this.bot.username) return;

            logger.info(`Chat in: <${username}> ${message}`);
            memory.logInteraction(username, 'chat', message);

            // Command handling
            const msgLower = message.toLowerCase();
            const prefixes = (config.behavior.commandPrefixes && config.behavior.commandPrefixes.length > 0)
                ? config.behavior.commandPrefixes
                : [`${this.bot.username},`];
            const isAddressed = prefixes.some(prefix => msgLower.startsWith(String(prefix).toLowerCase()));
            const isMentioned = message.includes(this.bot.username);
            const allowGeneral = this.planner.mode !== 'manual';

            const topic = this.extractTopic(message, isAddressed, isMentioned, prefixes);
            if (topic) {
                memory.addTopic(username, topic);
            }

            const feedback = this.extractRewardFeedback(message, isAddressed, isMentioned, prefixes);
            if (feedback) {
                const entry = training.recordReward({
                    score: feedback.score,
                    note: feedback.note,
                    source: 'chat',
                    player: username
                });
                if (entry) {
                    llm.systemPrompt = llm.buildSystemPrompt();
                    this.say(`${username}, фидбек принят (${entry.score >= 0 ? '+' : ''}${entry.score})`, username);
                }
                return;
            }

            if (this.isMuteRequest(msgLower, isAddressed, isMentioned)) {
                const minutes = config.behavior.etiquetteMuteMinutes || 10;
                memory.setMuted(username, minutes * 60000);
                if (isAddressed || isMentioned) {
                    this.say(`${username}, ок, приторможу на ${minutes} мин`, username);
                }
                return;
            }

            if (isAddressed) {
                this.markRequest(username);
                const jumpMatch = msgLower.match(/прыгай\s*(\d+)?/);
                if (jumpMatch) {
                    const count = jumpMatch[1] ? Number(jumpMatch[1]) : 1;
                    await this.planner.skills.jump({ count });
                    return;
                }
                if (msgLower.includes('открой дверь') || msgLower.includes('открой двери')) {
                    await this.planner.skills.open_door({});
                    return;
                }
                if (msgLower.includes('прочитай табличку') || msgLower.includes('прочитай таблички')) {
                    await this.planner.skills.read_sign({});
                    return;
                }
                const woodMatch = msgLower.match(/(дров|бревен|брёвен|бревна|бревно|дерева)\s*(\d+)?/);
                if (woodMatch) {
                    const amount = woodMatch[2] ? Number(woodMatch[2]) : 32;
                    this.planner.taskManager.startTask({ type: 'gather_wood', amount });
                    this.say(`иду за дровами (${amount})`, username);
                    return;
                }
                if (msgLower.includes('ферм') || msgLower.includes('огород')) {
                    this.planner.taskManager.startTask({ type: 'farm' });
                    this.say('занимаюсь фермой', username);
                    return;
                }
                if (msgLower.includes('режим выживания')) {
                    this.planner.setMode('survival');
                    this.say('ладно, включаю режим выживания. не мешайте, я развиваюсь.', username);
                    return;
                }
                if (msgLower.includes('режим автономный') || msgLower.includes('автономный режим') || msgLower.includes('режим авто')) {
                    this.planner.setMode('autonomous');
                    this.say('ок, автономный режим. щас наведу суеты.', username);
                    return;
                }
                if (msgLower.includes('режим ручной') || msgLower.includes('ручной режим') || msgLower.includes('режим мануальный')) {
                    this.planner.setMode('manual');
                    this.say('ручной режим. слушаю команды.', username);
                    return;
                }
                await this.planner.processUserRequest(username, message, { reason: 'direct', forceLLM: true });
            } else if (isMentioned) {
                // Mentioned
                this.markRequest(username);
                await this.planner.processUserRequest(username, message, { reason: 'mention', forceLLM: true });
            } else if (allowGeneral) {
                if (memory.isMuted(username)) {
                    logger.info(`Muted user ignored: ${username}`);
                    return;
                }
                if (this.isOnCooldown(username)) {
                    logger.info(`Chat cooldown active for ${username}`);
                    return;
                }
                this.markRequest(username);
                await this.planner.processUserRequest(username, message, { passive: true, reason: 'social' });
            }
        };
        this.bot.on('chat', this._onChat);
    }

    stop() {
        if (!this._onChat) return;
        this.bot.removeListener('chat', this._onChat);
        this._onChat = null;
    }
}

module.exports = ChatHandler;
