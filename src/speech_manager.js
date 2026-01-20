const { logger, sleep } = require('./utils');
const config = require('./config');

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

class SpeechManager {
    constructor(bot) {
        this.bot = bot;
        this.planner = null;
        this.context = null;
        this.queue = [];
        this.processing = false;
        this.socialEnergy = 55;
        this.lastEnergyUpdateAt = Date.now();
        this.lastSpokeAt = 0;
        this.lastPulseAt = 0;
        this.nextAutonomousAt = Date.now() + this.getAutonomousIntervalMs();
        this.messageHistory = [];
        this.messageTimestamps = [];
        this.lastByPlayer = new Map();
    }

    setPlanner(planner) {
        this.planner = planner;
    }

    updateContext(context) {
        this.context = context || null;
        this.recoverEnergy();
    }

    recoverEnergy() {
        const now = Date.now();
        const stepMs = 10000;
        if (now - this.lastEnergyUpdateAt < stepMs) return;
        const steps = Math.floor((now - this.lastEnergyUpdateAt) / stepMs);
        const behavior = config.behavior || {};
        const recoverPerStep = Number.isFinite(Number(behavior.speechEnergyRecoverPer10s))
            ? Number(behavior.speechEnergyRecoverPer10s)
            : 2;
        this.socialEnergy = clamp(this.socialEnergy + steps * recoverPerStep, 0, 100);
        if (this.bot && this.bot.time && !this.bot.time.isDay) {
            const nightPenalty = Number.isFinite(Number(behavior.speechEnergyNightPenalty))
                ? Number(behavior.speechEnergyNightPenalty)
                : 1;
            this.socialEnergy = clamp(this.socialEnergy - steps * nightPenalty, 0, 100);
        }
        this.lastEnergyUpdateAt = now;
    }

    getMode() {
        if (this.socialEnergy <= 30) return 'focused';
        if (this.socialEnergy >= 70) return 'chatty';
        return 'neutral';
    }

    getNearbyPlayerCount() {
        const players = this.context && Array.isArray(this.context.players) ? this.context.players : [];
        return players.filter(p => p && p.hasEntity).length;
    }

    normalizeText(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9а-яё]+/gi, ' ')
            .trim();
    }

    isAutonomousReason(reason) {
        return reason === 'autonomous' || reason === 'pulse' || reason === 'social';
    }

    getAutonomousIntervalMs() {
        const behavior = config.behavior || {};
        const minMs = Number.isFinite(Number(behavior.speechAutonomousMinIntervalMs))
            ? Number(behavior.speechAutonomousMinIntervalMs)
            : 240000;
        const maxMs = Number.isFinite(Number(behavior.speechAutonomousMaxIntervalMs))
            ? Number(behavior.speechAutonomousMaxIntervalMs)
            : 420000;
        const safeMin = Math.max(10000, minMs);
        const safeMax = Math.max(safeMin, maxMs);
        return safeMin + Math.random() * (safeMax - safeMin);
    }

    isDuplicate(text) {
        const normalized = this.normalizeText(text);
        if (!normalized) return true;
        const historyMs = config.behavior.autoChatHistoryMs || 0;
        if (historyMs <= 0) return false;
        const now = Date.now();
        this.messageHistory = this.messageHistory.filter(item => now - item.timestamp <= historyMs);
        return this.messageHistory.some(item => item.normalized === normalized);
    }

    recordMessage(text, player, reason) {
        const normalized = this.normalizeText(text);
        const now = Date.now();
        if (normalized) {
            this.messageHistory.push({ normalized, timestamp: now });
            const maxSize = Number.isFinite(Number(config.behavior.autoChatHistorySize))
                ? Number(config.behavior.autoChatHistorySize)
                : 20;
            if (this.messageHistory.length > maxSize) {
                this.messageHistory.splice(0, this.messageHistory.length - maxSize);
            }
        }
        this.lastSpokeAt = now;
        this.messageTimestamps.push(now);
        const burstWindowMs = config.behavior.speechBurstWindowMs || 20000;
        this.messageTimestamps = this.messageTimestamps.filter(ts => now - ts <= burstWindowMs);
        if (player) {
            this.lastByPlayer.set(player, now);
        }

        if (this.isAutonomousReason(reason)) {
            this.nextAutonomousAt = now + this.getAutonomousIntervalMs();
        }

        const behavior = config.behavior || {};
        let decay = 0;
        if (reason === 'direct') decay = behavior.speechEnergyDecayOnDirect ?? 5;
        else if (reason === 'event' || reason === 'danger' || reason === 'gift') decay = behavior.speechEnergyDecayOnEvent ?? 4;
        else decay = behavior.speechEnergyDecayOnTalk ?? 8;
        if (Number.isFinite(Number(decay))) {
            this.socialEnergy = clamp(this.socialEnergy - Number(decay), 0, 100);
        }
    }

    canBurst(reason) {
        const now = Date.now();
        const burstWindowMs = config.behavior.speechBurstWindowMs || 20000;
        this.messageTimestamps = this.messageTimestamps.filter(ts => now - ts <= burstWindowMs);
        const max = reason === 'direct'
            ? (config.behavior.speechDirectBurstMax || 6)
            : (config.behavior.speechBurstMax || 3);
        return this.messageTimestamps.length < max;
    }

    shouldPulse() {
        const now = Date.now();
        if (now < this.nextAutonomousAt) return false;
        const intervalMs = config.behavior.speechPulseIntervalMs || 60000;
        if (now - this.lastPulseAt < intervalMs) return false;
        this.lastPulseAt = now;
        return true;
    }

    shouldAllow(reason, text, player) {
        if (!text) return false;
        if (reason !== 'direct' && reason !== 'mention') {
            if (this.isDuplicate(text)) return false;
        }
        if (reason !== 'direct' && reason !== 'mention' && !this.canBurst(reason)) return false;

        if (reason === 'direct' || reason === 'mention' || reason === 'event' || reason === 'danger' || reason === 'gift') {
            return true;
        }

        if (this.isAutonomousReason(reason)) {
            const now = Date.now();
            if (now < this.nextAutonomousAt) return false;
            return true;
        }

        const now = Date.now();
        const cooldownMs = config.behavior.autoChatCooldownMs || 0;
        if (cooldownMs > 0 && now - this.lastSpokeAt < cooldownMs) return false;

        if (player) {
            const perPlayerCooldown = config.behavior.perPlayerChatCooldown || 0;
            const last = this.lastByPlayer.get(player) || 0;
            if (perPlayerCooldown > 0 && now - last < perPlayerCooldown) return false;
        }

        const mode = this.getMode();
        const behavior = config.behavior || {};
        const chanceFocused = Number(behavior.speechPulseChanceFocused ?? 0.03);
        const chanceNeutral = Number(behavior.speechPulseChanceNeutral ?? 0.08);
        const chanceChatty = Number(behavior.speechPulseChanceChatty ?? 0.18);
        let chance = mode === 'focused' ? chanceFocused : (mode === 'chatty' ? chanceChatty : chanceNeutral);
        const nearby = this.getNearbyPlayerCount();
        if (nearby === 0) chance *= 0.4;
        if (nearby >= 3) chance *= 0.6;
        if (Math.random() > chance) return false;

        return true;
    }

    getDelayMs(reason) {
        const behavior = config.behavior || {};
        const minDelay = Number.isFinite(Number(behavior.speechMinDelayMs)) ? Number(behavior.speechMinDelayMs) : 600;
        const maxDelay = Number.isFinite(Number(behavior.speechMaxDelayMs)) ? Number(behavior.speechMaxDelayMs) : 2500;
        const busyDelay = Number.isFinite(Number(behavior.speechBusyDelayMs)) ? Number(behavior.speechBusyDelayMs) : 6000;
        const eventMin = Number.isFinite(Number(behavior.speechEventMinDelayMs)) ? Number(behavior.speechEventMinDelayMs) : 80;
        const eventMax = Number.isFinite(Number(behavior.speechEventMaxDelayMs)) ? Number(behavior.speechEventMaxDelayMs) : 600;

        if (reason === 'danger' || reason === 'event' || reason === 'gift') {
            return eventMin + Math.random() * (eventMax - eventMin);
        }

        let baseMin = minDelay;
        let baseMax = maxDelay;
        if (reason === 'direct' || reason === 'mention') {
            baseMin = Number.isFinite(Number(behavior.speechDirectMinDelayMs)) ? Number(behavior.speechDirectMinDelayMs) : minDelay;
            baseMax = Number.isFinite(Number(behavior.speechDirectMaxDelayMs)) ? Number(behavior.speechDirectMaxDelayMs) : maxDelay;
        }

        const isBusy = this.bot && this.bot.pathfinder && this.bot.pathfinder.isMoving();
        const taskBusy = this.planner && this.planner.taskManager && this.planner.taskManager.isBusy();
        if (isBusy || taskBusy) {
            const boosted = Math.max(baseMax, busyDelay);
            return baseMin + Math.random() * (boosted - baseMin);
        }
        return baseMin + Math.random() * (baseMax - baseMin);
    }

    enqueue(text, options = {}) {
        const reason = options.reason || 'autonomous';
        const player = options.player || null;
        if (!this.shouldAllow(reason, text, player)) return false;

        const delayMs = Number.isFinite(Number(options.delayMs))
            ? Number(options.delayMs)
            : this.getDelayMs(reason);

        const entry = { text: String(text), reason, player, delayMs };
        if (reason === 'direct' || reason === 'mention' || reason === 'danger' || reason === 'event' || reason === 'gift') {
            this.queue.unshift(entry);
        } else {
            this.queue.push(entry);
        }
        this.processQueue().catch(err => logger.error('Speech queue error', err));
        return true;
    }

    async processQueue() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length > 0) {
            const item = this.queue.shift();
            if (!item) continue;
            if (item.delayMs > 0) {
                await sleep(item.delayMs);
            }
            if (!this.bot || !this.bot.chat) continue;
            this.bot.chat(item.text);
            this.recordMessage(item.text, item.player, item.reason);
        }
        this.processing = false;
    }
}

module.exports = SpeechManager;
