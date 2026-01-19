const { logger } = require('./utils');
const llm = require('./llm_client');
const memory = require('./memory_store');

class Observer {
    constructor(bot) {
        this.bot = bot;
        this.lastCommentTime = 0;
        this.valuableBlocks = ['diamond_ore', 'gold_ore', 'iron_ore', 'ancient_debris'];
        
        // Random banter loop
        setInterval(() => this.randomBanter(), 45000 + Math.random() * 60000); // Every 45-105 seconds
    }

    start() {
        this.bot.on('weatherUpdate', () => this.handleWeather());
        this.bot.on('entitySpawn', (entity) => this.handleEntity(entity));
        this.bot.on('blockUpdate', (oldBlock, newBlock) => this.handleBlockUpdate(oldBlock, newBlock));
        this.bot.on('messagestr', (msg, pos, json) => this.handleSystemMessage(msg, json));
    }

    canComment() {
        // Limit reactive comments
        if (Date.now() - this.lastCommentTime > 15000) {
            this.lastCommentTime = Date.now();
            return true;
        }
        return false;
    }

    async randomBanter() {
        // Don't interrupt if bot is chatting actively or busy
        if (Date.now() - this.lastCommentTime < 20000) return;

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

            const response = await llm.generateResponse(prompt, {}); // Empty context passed as prompt has it
            if (response && response.chat) {
                this.bot.chat(response.chat);
                this.lastCommentTime = Date.now();
            }
        } catch (e) {
            logger.error('Banter failed', e);
        }
    }

    async handleWeather() {
        if (!this.canComment()) return;
        if (this.bot.isRaining) {
            // Simple triggers can remain static or also use LLM if needed, but static is faster
            memory.addWorldEvent('weather', 'идет дождь');
            const phrases = [
                "опять дождь, пора под крышу",
                "мокро и скользко, аккуратнее",
                "дождь включили, значит ферму отложу"
            ];
            this.bot.chat(phrases[Math.floor(Math.random() * phrases.length)]);
        }
    }

    async handleEntity(entity) {
        if (!this.canComment()) return;
        if (this.bot.entity.position.distanceTo(entity.position) > 10) return;

        if (entity.name === 'creeper') {
            this.bot.chat("крипер! держим дистанцию");
        }
    }

    async handleBlockUpdate(oldBlock, newBlock) {
        if (!this.canComment()) return;
        if (!oldBlock || !newBlock) return;
        if (this.valuableBlocks.includes(oldBlock.name) && newBlock.name === 'air') {
            memory.addWorldEvent('resource', `добыли ${oldBlock.name}`);
            this.bot.chat("о, ресурсы. пригодится на крафт");
        }
    }

    async handleSystemMessage(message, json) {
        if (message.includes('died') || message.includes('slain') || message.includes('умер')) {
            if (!this.canComment()) return;
            memory.addWorldEvent('death', message);
            this.bot.chat("F. надеюсь ты не брал кредит на броню");
        }
    }
}

module.exports = Observer;
