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
                events: []
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
                if (!this.data.world) this.data.world = {};
                if (!Array.isArray(this.data.world.facts)) this.data.world.facts = [];
                if (!Array.isArray(this.data.world.chat)) this.data.world.chat = [];
                if (!Array.isArray(this.data.world.events)) this.data.world.events = [];
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

    getPlayer(username) {
        if (!this.data.players[username]) {
            this.data.players[username] = {
                facts: [],
                interactions: [],
                aliases: [],
                trust: 0,
                lastSeen: null,
                lastPosition: null,
                muteUntil: null
            };
        }
        return this.data.players[username];
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
