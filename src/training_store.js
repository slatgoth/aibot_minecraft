const fs = require('fs');
const path = require('path');
const config = require('./config');

const defaultTraining = {
    version: 2,
    rules: {
        must: [],
        mustNot: [],
        notes: ''
    },
    promptAppend: '',
    modelRouting: {},
    behaviorOverrides: {
        fleeCreeper: true
    },
    rewards: [],
    ruleWeights: {},
    rewardTotals: {
        total: 0,
        positive: 0,
        negative: 0,
        countPositive: 0,
        countNegative: 0
    }
};

class TrainingStore {
    constructor() {
        this.filePath = (config.paths && config.paths.training)
            ? config.paths.training
            : path.join(__dirname, '..', 'training.json');
        this.logPath = (config.paths && config.paths.trainingLog)
            ? config.paths.trainingLog
            : path.join(path.dirname(this.filePath), 'training.log');
        this.data = this.normalize({});
        this.load();
    }

    summarizeRewards(rewards) {
        const totals = {
            total: 0,
            positive: 0,
            negative: 0,
            countPositive: 0,
            countNegative: 0
        };
        if (!Array.isArray(rewards)) return totals;
        rewards.forEach((entry) => {
            const score = Number(entry && entry.score);
            if (!Number.isFinite(score) || score === 0) return;
            totals.total += score;
            if (score > 0) {
                totals.positive += score;
                totals.countPositive += 1;
            } else {
                totals.negative += score;
                totals.countNegative += 1;
            }
        });
        return totals;
    }

    normalize(data) {
        const output = data && typeof data === 'object' ? data : {};
        output.version = Number.isFinite(Number(output.version)) ? Number(output.version) : defaultTraining.version;
        if (!output.rules || typeof output.rules !== 'object') output.rules = {};
        output.rules.must = Array.isArray(output.rules.must) ? output.rules.must : [];
        output.rules.mustNot = Array.isArray(output.rules.mustNot) ? output.rules.mustNot : [];
        output.rules.notes = typeof output.rules.notes === 'string' ? output.rules.notes : '';
        output.promptAppend = typeof output.promptAppend === 'string' ? output.promptAppend : '';
        output.modelRouting = output.modelRouting && typeof output.modelRouting === 'object' ? output.modelRouting : {};
        if (!output.behaviorOverrides || typeof output.behaviorOverrides !== 'object') output.behaviorOverrides = {};
        if (typeof output.behaviorOverrides.fleeCreeper !== 'boolean') {
            output.behaviorOverrides.fleeCreeper = defaultTraining.behaviorOverrides.fleeCreeper;
        }
        output.rewards = Array.isArray(output.rewards) ? output.rewards : [];
        output.ruleWeights = output.ruleWeights && typeof output.ruleWeights === 'object' ? output.ruleWeights : {};
        output.rewardTotals = output.rewardTotals && typeof output.rewardTotals === 'object'
            ? output.rewardTotals
            : this.summarizeRewards(output.rewards);
        if (!Number.isFinite(Number(output.rewardTotals.total))) {
            output.rewardTotals = this.summarizeRewards(output.rewards);
        }
        return output;
    }

    load() {
        try {
            if (!this.filePath || !fs.existsSync(this.filePath)) {
                this.data = this.normalize({});
                return;
            }
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = this.normalize(parsed);
        } catch (e) {
            this.data = this.normalize({});
        }
    }

    reloadFromDisk() {
        this.load();
        return true;
    }

    save() {
        try {
            if (!this.filePath) return false;
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
            return true;
        } catch (e) {
            return false;
        }
    }

    get() {
        return this.data;
    }

    getBehaviorOverrides() {
        return this.data.behaviorOverrides || {};
    }

    getModelRouting() {
        return this.data.modelRouting || {};
    }

    detectRewardRule(note, score, ruleType = 'auto') {
        let text = String(note || '').trim();
        if (!text) return null;
        let resolvedType = ruleType || 'auto';
        const lower = text.toLowerCase();
        if (lower.startsWith('делай:')) {
            resolvedType = 'must';
            text = text.slice(6).trim();
        } else if (lower.startsWith('нельзя:')) {
            resolvedType = 'mustNot';
            text = text.slice(7).trim();
        } else if (lower.startsWith('не:')) {
            resolvedType = 'mustNot';
            text = text.slice(3).trim();
        } else if (lower.startsWith('do:')) {
            resolvedType = 'must';
            text = text.slice(3).trim();
        } else if (lower.startsWith('dont:') || lower.startsWith("don't:")) {
            resolvedType = 'mustNot';
            text = text.replace(/^don'?t:/i, '').trim();
        }
        const startsNegation = /^не\s+/i.test(text);
        if (resolvedType === 'auto') {
            if (score < 0) {
                resolvedType = 'mustNot';
            } else if (startsNegation) {
                resolvedType = 'mustNot';
            } else {
                resolvedType = 'must';
            }
        }
        if (resolvedType === 'must' && startsNegation) {
            text = text.replace(/^не\s+/i, '').trim();
        } else if (resolvedType === 'mustNot' && !startsNegation) {
            text = `не ${text}`;
        }
        const ignored = new Set(['похвала', 'штраф', 'фидбек', 'поощрение', 'reward', 'feedback']);
        if (ignored.has(text.toLowerCase())) return null;
        if (!text) return null;
        return { ruleText: text, ruleType: resolvedType };
    }

    applyRewardToRules(entry, ruleType = 'auto') {
        if (!entry) return;
        const detected = this.detectRewardRule(entry.note, entry.score, ruleType);
        if (!detected || !detected.ruleText) return;
        const must = new Set(this.data.rules.must || []);
        const mustNot = new Set(this.data.rules.mustNot || []);
        if (detected.ruleType === 'must') {
            must.add(detected.ruleText);
            mustNot.delete(detected.ruleText);
        } else {
            mustNot.add(detected.ruleText);
            must.delete(detected.ruleText);
        }
        this.data.rules.must = Array.from(must);
        this.data.rules.mustNot = Array.from(mustNot);
        if (!this.data.ruleWeights || typeof this.data.ruleWeights !== 'object') {
            this.data.ruleWeights = {};
        }
        const prev = Number(this.data.ruleWeights[detected.ruleText]) || 0;
        const delta = Number(entry.score) || 0;
        this.data.ruleWeights[detected.ruleText] = prev + delta;
    }

    appendLog(entry) {
        if (!entry || !this.logPath) return;
        const ts = entry.timestamp ? new Date(entry.timestamp).toISOString() : new Date().toISOString();
        const score = Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0;
        const note = entry.note ? String(entry.note) : '';
        const source = entry.source ? String(entry.source) : '';
        const player = entry.player ? String(entry.player) : '';
        const tail = source ? ` [${source}${player ? `:${player}` : ''}]` : '';
        const line = `[${ts}] ${score >= 0 ? '+' : ''}${score} | ${note}${tail}\n`;
        try {
            fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
            fs.appendFileSync(this.logPath, line, 'utf8');
        } catch (e) {}
    }

    recordReward({ score = 0, note = '', source = 'runtime', player = null, ruleType = 'auto' } = {}) {
        // Persist feedback and update rule priorities in one place.
        const safeScore = Number.isFinite(Number(score)) ? Number(score) : 0;
        const safeNote = String(note || '').trim();
        if (!safeNote || safeScore === 0) return null;
        const entry = {
            timestamp: Date.now(),
            score: safeScore,
            note: safeNote,
            source,
            player: player ? String(player) : null,
            ruleType
        };
        this.data.rewards = Array.isArray(this.data.rewards) ? this.data.rewards : [];
        this.data.rewards.push(entry);
        this.applyRewardToRules(entry, ruleType);
        this.data.rewardTotals = this.summarizeRewards(this.data.rewards);
        this.save();
        this.appendLog(entry);
        return entry;
    }

    buildPromptAddon() {
        const rules = this.data.rules || {};
        const weights = this.data.ruleWeights || {};
        const renderRule = (rule) => {
            const weight = Number(weights[rule]) || 0;
            if (!weight) return `- ${rule}`;
            return `- (${weight >= 0 ? '+' : ''}${weight}) ${rule}`;
        };
        const lines = [];
        if (Array.isArray(rules.must) && rules.must.length > 0) {
            lines.push('Нужно:');
            rules.must.forEach((rule) => lines.push(renderRule(rule)));
        }
        if (Array.isArray(rules.mustNot) && rules.mustNot.length > 0) {
            lines.push('Нельзя:');
            rules.mustNot.forEach((rule) => lines.push(renderRule(rule)));
        }
        if (rules.notes) {
            lines.push('Заметки:');
            lines.push(rules.notes);
        }
        if (this.data.promptAppend) {
            lines.push('Дополнительный промт:');
            lines.push(this.data.promptAppend);
        }
        const totals = this.data.rewardTotals || this.summarizeRewards(this.data.rewards);
        if (totals.total !== 0 || totals.countPositive || totals.countNegative) {
            lines.push(`Сводка поощрений: ${totals.total >= 0 ? '+' : ''}${totals.total} (+=${totals.positive} / -=${Math.abs(totals.negative)})`);
        }
        if (Array.isArray(this.data.rewards) && this.data.rewards.length > 0) {
            const recent = this.data.rewards
                .slice()
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
                .slice(0, 5);
            lines.push('Поощрения/штрафы:');
            recent.forEach((entry) => {
                const score = Number.isFinite(Number(entry.score)) ? Number(entry.score) : 0;
                const note = entry.note ? String(entry.note) : '';
                lines.push(`- ${score >= 0 ? '+' : ''}${score}: ${note}`);
            });
        }
        return lines.join('\n');
    }
}

module.exports = new TrainingStore();
