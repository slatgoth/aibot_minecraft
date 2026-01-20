const { logger } = require('./utils');
const llm = require('./llm_client');
const memory = require('./memory_store');
const config = require('./config');

class Observer {
    constructor(bot, planner, speechManager) {
        this.bot = bot;
        this.planner = planner;
        this.speechManager = speechManager;
        this.lastCommentTime = 0;
        this.valuableBlocks = ['diamond_ore', 'gold_ore', 'iron_ore', 'ancient_debris'];
        this._onWeather = null;
        this._onEntity = null;
        this._onBlockUpdate = null;
        this._onSystemMessage = null;
        this._onPlayerCollect = null;
        this._onEntityHurt = null;
        this._banterTimer = null;
        this.itemOwners = new Map();
        this.recentCollectIds = new Map();
        this.lastGiftAt = new Map();
        this.lastHurtAt = 0;
        this.lastDropPickupAt = 0;
        this.itemParser = require('prismarine-item')(bot.version);
        this.banterMinMs = Number.isFinite(Number(config.behavior.banterIntervalMinMs))
            ? Number(config.behavior.banterIntervalMinMs)
            : 120000;
        this.banterMaxMs = Number.isFinite(Number(config.behavior.banterIntervalMaxMs))
            ? Number(config.behavior.banterIntervalMaxMs)
            : 240000;

        // Random banter loop
        this.scheduleBanter();
    }

    scheduleBanter() {
        if (this._banterTimer) {
            clearTimeout(this._banterTimer);
        }
        const minMs = Math.max(15000, this.banterMinMs);
        const maxMs = Math.max(minMs, this.banterMaxMs);
        const delay = minMs + Math.random() * (maxMs - minMs);
        this._banterTimer = setTimeout(async () => {
            await this.randomBanter();
            this.scheduleBanter();
        }, delay);
    }

    start() {
        if (!this._onWeather) {
            this._onWeather = () => this.handleWeather();
            this.bot.on('weatherUpdate', this._onWeather);
        }
        if (!this._onEntity) {
            this._onEntity = (entity) => this.handleEntity(entity);
            this.bot.on('entitySpawn', this._onEntity);
        }
        if (!this._onBlockUpdate) {
            this._onBlockUpdate = (oldBlock, newBlock) => this.handleBlockUpdate(oldBlock, newBlock);
            this.bot.on('blockUpdate', this._onBlockUpdate);
        }
        if (!this._onSystemMessage) {
            this._onSystemMessage = (msg, pos, json) => this.handleSystemMessage(msg, json);
            this.bot.on('messagestr', this._onSystemMessage);
        }
        if (!this._onPlayerCollect) {
            this._onPlayerCollect = (collector, collected) => this.handlePlayerCollect(collector, collected);
            this.bot.on('playerCollect', this._onPlayerCollect);
        }
        if (!this._onEntityHurt) {
            this._onEntityHurt = (entity) => this.handleEntityHurt(entity);
            this.bot.on('entityHurt', this._onEntityHurt);
        }
    }

    stop() {
        if (this._banterTimer) {
            clearTimeout(this._banterTimer);
            this._banterTimer = null;
        }
        if (this._onWeather) {
            this.bot.removeListener('weatherUpdate', this._onWeather);
            this._onWeather = null;
        }
        if (this._onEntity) {
            this.bot.removeListener('entitySpawn', this._onEntity);
            this._onEntity = null;
        }
        if (this._onBlockUpdate) {
            this.bot.removeListener('blockUpdate', this._onBlockUpdate);
            this._onBlockUpdate = null;
        }
        if (this._onSystemMessage) {
            this.bot.removeListener('messagestr', this._onSystemMessage);
            this._onSystemMessage = null;
        }
        if (this._onPlayerCollect) {
            this.bot.removeListener('playerCollect', this._onPlayerCollect);
            this._onPlayerCollect = null;
        }
        if (this._onEntityHurt) {
            this.bot.removeListener('entityHurt', this._onEntityHurt);
            this._onEntityHurt = null;
        }
    }

    canComment() {
        const cooldownMs = Number.isFinite(Number(config.behavior.eventCommentCooldownMs))
            ? Number(config.behavior.eventCommentCooldownMs)
            : 15000;
        if (Date.now() - this.lastCommentTime <= cooldownMs) return false;
        return true;
    }

    markComment() {
        this.lastCommentTime = Date.now();
        if (this.planner) this.planner.markAutoChat();
    }

    say(text, reason = 'event', player = null) {
        if (!text) return false;
        if (this.speechManager) {
            return this.speechManager.enqueue(text, { reason, player });
        }
        this.bot.chat(text);
        return true;
    }

    async randomBanter() {
        // Don't interrupt if bot is chatting actively or busy
        if (Date.now() - this.lastCommentTime < 20000) return;
        if (this.speechManager && !this.speechManager.shouldPulse()) return;
        if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) return;
        if (this.planner && this.planner.taskManager && this.planner.taskManager.isBusy()) return;

        try {
            // Gather context for the joke
            const nearbyPlayers = Object.values(this.bot.players).filter(p => {
                if (!p.entity) return false;
                if (p.username === this.bot.username) return false;
                if (p.entity.position.distanceTo(this.bot.entity.position) >= 20) return false;
                return !memory.isMuted(p.username);
            });
            const targetPlayer = nearbyPlayers.length > 0 ? nearbyPlayers[Math.floor(Math.random() * nearbyPlayers.length)] : null;
            
            let memoryFact = null;
            if (targetPlayer) {
                const mem = memory.getPlayer(targetPlayer.username);
                if (mem && mem.facts.length > 0) {
                    memoryFact = mem.facts[Math.floor(Math.random() * mem.facts.length)];
                }
            }

            const context = {
                time: this.bot.time.isDay ? "день" : "ночь",
                weather: this.bot.isRaining ? "дождь" : "ясно",
                health: this.bot.health,
                nearbyPlayer: targetPlayer ? targetPlayer.username : "никого",
                memoryFact: memoryFact
            };

            const prompt = `
            Придумай ОДНУ короткую смешную фразу для чата майнкрафта от лица бота-персонажа.
            Свяжи что-то из этого:
            1. Текущая ситуация: ${JSON.stringify(context)}.
            2. Бытовые наблюдения или игровой прогресс.
            3. Факт об игроке: ${memoryFact ? `Про ${targetPlayer.username}: ${memoryFact}` : "нет фактов"}.

            Стиль: легкий юмор, нижний регистр. Не задавай вопросы, просто мысль или подкол без оскорблений.
            Верни JSON: { "chat": "текст" }
            `;

            const response = await llm.generateResponse(prompt, {}, { reason: 'banter' }); // Empty context passed as prompt has it
            if (response && response.chat) {
                const sent = this.say(response.chat, 'pulse');
                if (sent) this.markComment();
            }
        } catch (e) {
            logger.error('Banter failed', e);
        }
    }

    async handleWeather() {
        if (this.bot.isRaining) {
            // Simple triggers can remain static or also use LLM if needed, but static is faster
            memory.addWorldEvent('weather', 'идет дождь');
            if (!this.canComment()) return;
            const phrases = [
                "опять дождь, пора под крышу",
                "мокро и скользко, аккуратнее",
                "дождь включили, значит ферму отложу"
            ];
            const sent = this.say(phrases[Math.floor(Math.random() * phrases.length)], 'event');
            if (sent) this.markComment();
        }
    }

    async handleEntity(entity) {
        if (!entity) return;
        if (entity.type === 'object' && entity.name === 'item') {
            this.trackItemOwner(entity);
            await this.handleDroppedItem(entity);
        }
        if (!this.canComment()) return;
        if (!this.bot.entity || !entity.position) return;
        if (this.bot.entity.position.distanceTo(entity.position) > 10) return;

        if (entity.name === 'creeper') {
            const sent = this.say("крипер! держим дистанцию", 'danger');
            if (sent) this.markComment();
            return;
        }
    }

    async handleEntityHurt(entity) {
        if (!entity || !this.bot.entity) return;
        if (entity.id !== this.bot.entity.id) return;
        const behavior = config.behavior || {};
        const cooldownMs = Number.isFinite(Number(behavior.hurtCommentCooldownMs))
            ? Number(behavior.hurtCommentCooldownMs)
            : 15000;
        const now = Date.now();
        if (now - this.lastHurtAt < cooldownMs) return;
        this.lastHurtAt = now;
        const phrases = [
            'ай, полегче',
            'не бей, я вообще-то полезный',
            'оу, попал'
        ];
        const sent = this.say(phrases[Math.floor(Math.random() * phrases.length)], 'danger');
        if (sent) this.markComment();
    }

    async handleDroppedItem(entity) {
        const behavior = config.behavior || {};
        if (behavior.autoPickupDrops === false) return;
        if (!this.bot.entity || !entity.position) return;
        if (!this.planner || !this.planner.skills) return;
        if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) return;
        if (this.planner.taskManager && this.planner.taskManager.isBusy()) return;
        const radius = Number.isFinite(Number(behavior.autoPickupDropRadius))
            ? Number(behavior.autoPickupDropRadius)
            : 6;
        const distance = this.bot.entity.position.distanceTo(entity.position);
        if (distance > radius) return;
        const cooldownMs = Number.isFinite(Number(behavior.autoPickupDropCooldownMs))
            ? Number(behavior.autoPickupDropCooldownMs)
            : 4000;
        if (Date.now() - this.lastDropPickupAt < cooldownMs) return;
        this.lastDropPickupAt = Date.now();
        try {
            await this.planner.skills.pickup_item({ radius: radius + 2 });
        } catch (e) {
            logger.error('Auto pickup failed', e);
        }
    }

    async handleBlockUpdate(oldBlock, newBlock) {
        if (!oldBlock || !newBlock) return;
        if (oldBlock.name === 'air' && newBlock.name !== 'air') {
            const placer = this.bot.nearestEntity(e => {
                if (!e || e.type !== 'player') return false;
                if (e.username === this.bot.username) return false;
                return e.position.distanceTo(newBlock.position) < 6;
            });
            if (placer) {
                memory.markBlockPlaced(newBlock.position, newBlock.name, placer.username || placer.name);
            }
        }
        if (this.valuableBlocks.includes(oldBlock.name) && newBlock.name === 'air') {
            memory.addWorldEvent('resource', `добыли ${oldBlock.name}`);
            if (!this.canComment()) return;
            const sent = this.say("о, ресурсы. пригодится на крафт", 'event');
            if (sent) this.markComment();
        }
    }

    async handleSystemMessage(message, json) {
        if (message.includes('died') || message.includes('slain') || message.includes('умер')) {
            memory.addWorldEvent('death', message);
            if (!this.canComment()) return;
            const sent = this.say("F. надеюсь ты не брал кредит на броню", 'event');
            if (sent) this.markComment();
        }
    }

    trackItemOwner(entity) {
        if (!entity || !entity.position) return;
        if (entity.id === undefined || entity.id === null) return;
        const nearest = this.bot.nearestEntity(e => {
            if (!e || e.type !== 'player') return false;
            if (!e.username || e.username === this.bot.username) return false;
            return e.position.distanceTo(entity.position) <= 4;
        });
        const owner = nearest ? (nearest.username || nearest.name) : null;
        this.itemOwners.set(entity.id, {
            owner,
            position: entity.position,
            timestamp: Date.now()
        });
        if (this.itemOwners.size > 200) {
            const now = Date.now();
            for (const [id, info] of this.itemOwners.entries()) {
                if (now - info.timestamp > 120000) {
                    this.itemOwners.delete(id);
                }
            }
        }
    }

    getItemFromEntity(entity) {
        if (!entity || !Array.isArray(entity.metadata)) return null;
        let stack = null;
        for (const entry of entity.metadata) {
            if (!entry || typeof entry !== 'object') continue;
            if (Object.prototype.hasOwnProperty.call(entry, 'itemId')) {
                stack = entry;
                break;
            }
            if (entry.present && entry.itemId !== undefined) {
                stack = entry;
                break;
            }
        }
        if (!stack || stack.itemId === undefined) return null;
        const item = this.itemParser.fromNotch({
            type: stack.itemId,
            count: stack.itemCount || 1,
            nbt: stack.nbt || stack.itemNbt || null
        });
        if (!item || !item.name) return null;
        return { name: item.name, count: stack.itemCount || item.count || 1 };
    }

    isFoodItem(name) {
        if (!name || !this.bot.registry) return false;
        if (this.bot.registry.foodsByName && this.bot.registry.foodsByName[name]) return true;
        const item = this.bot.registry.itemsByName ? this.bot.registry.itemsByName[name] : null;
        if (!item) return false;
        return Number.isFinite(Number(item.foodPoints)) || Number.isFinite(Number(item.food));
    }

    prettyItemName(name) {
        return String(name || '').replace(/_/g, ' ');
    }

    getMoodLabel() {
        const health = Number.isFinite(Number(this.bot.health)) ? Number(this.bot.health) : 20;
        const food = Number.isFinite(Number(this.bot.food)) ? Number(this.bot.food) : 20;
        if (health <= 8 || food <= 8) return 'irritated';
        if (health >= 16 && food >= 16) return 'good';
        return 'neutral';
    }

    async handlePlayerCollect(collector, collected) {
        if (!collector || !collected) return;
        if (!this.bot.entity) return;
        if (collector.id !== this.bot.entity.id) return;
        if (collected.name !== 'item') return;
        if (collected.id === undefined || collected.id === null) return;

        const already = this.recentCollectIds.get(collected.id);
        if (already && Date.now() - already < 20000) return;
        this.recentCollectIds.set(collected.id, Date.now());
        setTimeout(() => {
            this.recentCollectIds.delete(collected.id);
        }, 60000);

        const itemInfo = this.getItemFromEntity(collected);
        if (!itemInfo) return;

        const ownerEntry = this.itemOwners.get(collected.id);
        this.itemOwners.delete(collected.id);
        const ownerName = ownerEntry && ownerEntry.owner ? ownerEntry.owner : null;
        const cooldownMs = Number.isFinite(Number(config.behavior.giftCommentCooldownMs))
            ? Number(config.behavior.giftCommentCooldownMs)
            : 60000;
        const lastGiftAt = this.lastGiftAt.get(ownerName || '_') || 0;
        if (Date.now() - lastGiftAt < cooldownMs) return;

        setTimeout(async () => {
            const hasItem = this.bot.inventory.items().some(i => i.name === itemInfo.name);
            if (!hasItem) return;

            this.lastGiftAt.set(ownerName || '_', Date.now());
            if (ownerName) {
                const trustDelta = this.isFoodItem(itemInfo.name) ? 2 : 1;
                memory.adjustTrust(ownerName, trustDelta);
                memory.addWorldEvent('gift', `${ownerName} -> ${itemInfo.name} x${itemInfo.count}`);
            } else {
                memory.addWorldEvent('gift', `unknown -> ${itemInfo.name} x${itemInfo.count}`);
            }

            const isFood = this.isFoodItem(itemInfo.name);
            const mood = this.getMoodLabel();
            const trust = ownerName ? memory.getTrust(ownerName) : 0;
            const itemLabel = this.prettyItemName(itemInfo.name);
            let line = null;

            if (ownerName) {
                if (isFood) {
                    if (mood === 'irritated') {
                        line = `${ownerName}, спасибо. я реально голодный, это спасает`;
                    } else if (mood === 'good') {
                        line = `${ownerName}, о, ${itemLabel}. вкусно, благодарю`;
                    } else {
                        line = `${ownerName}, принял ${itemLabel}, спасибо`;
                    }
                } else if (trust >= 4) {
                    line = `${ownerName}, о, ${itemLabel}. хорошая тема, спасибо`;
                } else if (trust <= -3) {
                    line = `${ownerName}, взял ${itemLabel}. надеюсь это не ловушка`;
                } else {
                    line = `${ownerName}, взял ${itemLabel}. пригодится`;
                }
            } else {
                line = `поднял ${itemLabel}. пригодится`;
            }

            if (line) {
                const sent = this.say(line, 'gift', ownerName);
                if (sent) this.markComment();
            }

            const behavior = config.behavior || {};
            if (behavior.followOnGift !== false && ownerName && this.planner && this.planner.taskManager && !this.planner.taskManager.isBusy()) {
                const playerEntity = this.bot.players[ownerName]?.entity;
                if (playerEntity) {
                    const dist = playerEntity.position.distanceTo(this.bot.entity.position);
                    if (dist <= 8) {
                        this.bot.lookAt(playerEntity.position.offset(0, playerEntity.height, 0));
                    } else if (dist <= 16 && !this.bot.pathfinder.isMoving()) {
                        await this.planner.skills.follow({ player: ownerName });
                    }
                }
            }
        }, 250);
    }
}

module.exports = Observer;
