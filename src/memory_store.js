const fs = require('fs');
const path = require('path');
const config = require('./config');

class MemoryStore {
    constructor() {
        this.filePath = config.paths.memory;
        this.data = {
            players: {},
            world: {
                facts: [],
                chat: [],
                events: [],
                placedBlocks: []
            }
        };
        this.lastSaveAt = 0;
        this.load();
    }

    load() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            if (fs.existsSync(this.filePath)) {
                const raw = fs.readFileSync(this.filePath, 'utf8');
                const parsed = JSON.parse(raw);
                this.data = parsed || this.data;
                if (!this.data.players) this.data.players = {};
                this.data = this.normalizeData(this.data);
            } else {
                this.save();
            }
        } catch (e) {
            console.error('Memory load error:', e);
            this.data = { players: {}, world: {} };
        }
    }

    save() {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
            this.lastSaveAt = Date.now();
        } catch (e) {
            console.error('Memory save error:', e);
        }
    }

    normalizeData(data) {
        const output = data && typeof data === 'object' ? data : {};
        if (!output.players || typeof output.players !== 'object') output.players = {};
        if (!output.world || typeof output.world !== 'object') output.world = {};
        if (!Array.isArray(output.world.facts)) output.world.facts = [];
        if (!Array.isArray(output.world.chat)) output.world.chat = [];
        if (!Array.isArray(output.world.events)) output.world.events = [];
        if (!Array.isArray(output.world.placedBlocks)) output.world.placedBlocks = [];
        for (const player of Object.values(output.players)) {
            if (!player || typeof player !== 'object') continue;
            if (!Array.isArray(player.topics)) player.topics = [];
        }
        return output;
    }

    replaceData(data) {
        this.data = this.normalizeData(data);
        this.save();
    }

    reloadFromDisk() {
        try {
            if (!fs.existsSync(this.filePath)) return false;
            const raw = fs.readFileSync(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            this.data = this.normalizeData(parsed);
            return true;
        } catch (e) {
            console.error('Memory reload error:', e);
            return false;
        }
    }

    getData() {
        return this.data;
    }

    getPlayer(username) {
        if (!this.data.players[username]) {
            this.data.players[username] = {
                facts: [],
                interactions: [],
                aliases: [],
                trust: 0,
                lastSeen: null,
                lastPosition: null,
                muteUntil: null,
                topics: []
            };
        }
        return this.data.players[username];
    }

    adjustTrust(username, delta) {
        const p = this.getPlayer(username);
        const next = Number.isFinite(Number(delta)) ? p.trust + Number(delta) : p.trust;
        p.trust = Math.max(-10, Math.min(10, next));
        this.save();
        return p.trust;
    }

    getTrust(username) {
        const p = this.getPlayer(username);
        return Number.isFinite(Number(p.trust)) ? p.trust : 0;
    }

    addFact(username, fact) {
        const p = this.getPlayer(username);
        const clean = String(fact || '').trim();
        if (!clean) return false;
        const normalized = this.normalizeFact(clean);
        const existingNormalized = p.facts.map(f => this.normalizeFact(f));
        if (existingNormalized.includes(normalized)) return false;

        p.facts.push(clean);
        const maxFacts = config.behavior.maxFactsPerPlayer || 50;
        if (p.facts.length > maxFacts) {
            p.facts.splice(0, p.facts.length - maxFacts);
        }
        this.save();
        return true;
    }

    addTopic(username, topic) {
        const p = this.getPlayer(username);
        const clean = String(topic || '').trim();
        if (!clean) return false;
        const normalized = this.normalizeFact(clean);
        if (normalized.length < 5) return false;

        const now = Date.now();
        const ttlMs = Number.isFinite(Number(config.behavior.topicTtlMs))
            ? Number(config.behavior.topicTtlMs)
            : 1800000;
        p.topics = (p.topics || []).filter(item => item && now - item.timestamp <= ttlMs);
        if (p.topics.some(item => item.normalized === normalized)) return false;

        p.topics.push({ text: clean, normalized, timestamp: now });
        const limit = Number.isFinite(Number(config.behavior.maxTopicsPerPlayer))
            ? Number(config.behavior.maxTopicsPerPlayer)
            : 10;
        if (p.topics.length > limit) {
            p.topics.splice(0, p.topics.length - limit);
        }
        this.save();
        return true;
    }

    getTopics(username, limit = 5) {
        const p = this.getPlayer(username);
        const now = Date.now();
        const ttlMs = Number.isFinite(Number(config.behavior.topicTtlMs))
            ? Number(config.behavior.topicTtlMs)
            : 1800000;
        p.topics = (p.topics || []).filter(item => item && now - item.timestamp <= ttlMs);
        const items = p.topics || [];
        return items.slice(-limit).map(item => item.text);
    }

    removeFact(username, fact) {
        const p = this.getPlayer(username);
        const idx = p.facts.indexOf(fact);
        if (idx > -1) {
            p.facts.splice(idx, 1);
            this.save();
            return true;
        }
        return false;
    }

    logInteraction(username, type, content) {
        const p = this.getPlayer(username);
        p.interactions.push({
            timestamp: Date.now(),
            type,
            content
        });
        if (p.interactions.length > 50) p.interactions.shift();
        this.logGlobalChat(username, content);
        this.save();
    }

    setLastSeen(username, position) {
        const p = this.getPlayer(username);
        p.lastSeen = Date.now();
        p.lastPosition = position;
        if (Date.now() - this.lastSaveAt > 30000) {
            this.save();
        }
    }

    setMuted(username, durationMs) {
        const p = this.getPlayer(username);
        p.muteUntil = Date.now() + durationMs;
        this.save();
    }

    isMuted(username) {
        const p = this.getPlayer(username);
        if (!p.muteUntil) return false;
        if (Date.now() >= p.muteUntil) {
            p.muteUntil = null;
            return false;
        }
        return true;
    }

    normalizeFact(fact) {
        return String(fact || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
    }

    logGlobalChat(username, content) {
        if (!content) return;
        this.data.world.chat.push({
            timestamp: Date.now(),
            username,
            message: String(content)
        });
        const limit = 80;
        if (this.data.world.chat.length > limit) {
            this.data.world.chat.splice(0, this.data.world.chat.length - limit);
        }
    }

    addWorldFact(fact, source = 'user') {
        const clean = String(fact || '').trim();
        if (!clean) return false;
        const normalized = this.normalizeFact(clean);
        const existing = this.data.world.facts.map(f => this.normalizeFact(f.text));
        if (existing.includes(normalized)) return false;
        this.data.world.facts.push({
            timestamp: Date.now(),
            source,
            text: clean
        });
        const limit = 80;
        if (this.data.world.facts.length > limit) {
            this.data.world.facts.splice(0, this.data.world.facts.length - limit);
        }
        this.save();
        return true;
    }

    addWorldEvent(type, text) {
        const clean = String(text || '').trim();
        if (!clean) return false;
        this.data.world.events.push({
            timestamp: Date.now(),
            type: String(type || 'event'),
            text: clean
        });
        const limit = 80;
        if (this.data.world.events.length > limit) {
            this.data.world.events.splice(0, this.data.world.events.length - limit);
        }
        this.save();
        return true;
    }

    markBlockPlaced(position, name, by) {
        if (!position) return false;
        const entry = {
            key: `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
            x: Math.floor(position.x),
            y: Math.floor(position.y),
            z: Math.floor(position.z),
            name: String(name || ''),
            by: by ? String(by) : null,
            timestamp: Date.now()
        };
        const list = this.data.world.placedBlocks || [];
        if (!list.find(item => item.key === entry.key)) {
            list.push(entry);
        }
        const limit = 250;
        if (list.length > limit) {
            list.splice(0, list.length - limit);
        }
        this.data.world.placedBlocks = list;
        this.save();
        return true;
    }

    isPlayerPlaced(block) {
        if (!block || !block.position) return false;
        const key = `${Math.floor(block.position.x)},${Math.floor(block.position.y)},${Math.floor(block.position.z)}`;
        const list = this.data.world.placedBlocks || [];
        return list.some(item => item.key === key);
    }

    getPlacedBlocksNear(position, radius = 16, limit = 20) {
        if (!position) return [];
        const r = Number(radius) || 16;
        const list = this.data.world.placedBlocks || [];
        const results = [];
        for (const item of list) {
            const dx = item.x - position.x;
            const dy = item.y - position.y;
            const dz = item.z - position.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist <= r) {
                results.push({ ...item, distance: Number(dist.toFixed(1)) });
            }
            if (results.length >= limit) break;
        }
        return results;
    }

    getWorldFacts(limit = 20) {
        const items = this.data.world.facts || [];
        return items.slice(-limit).map(f => f.text);
    }

    getWorldEvents(limit = 20) {
        const items = this.data.world.events || [];
        return items.slice(-limit);
    }

    getRecentGlobalChat(limit = 20) {
        const items = this.data.world.chat || [];
        return items.slice(-limit);
    }

    getRecentInteractions(limit = 20) {
        const all = [];
        for (const [username, p] of Object.entries(this.data.players)) {
            for (const interaction of p.interactions || []) {
                all.push({
                    username,
                    timestamp: interaction.timestamp,
                    type: interaction.type,
                    content: interaction.content
                });
            }
        }
        all.sort((a, b) => b.timestamp - a.timestamp);
        return all.slice(0, limit);
    }
}

module.exports = new MemoryStore();
