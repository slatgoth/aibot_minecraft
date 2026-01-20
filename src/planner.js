const { logger } = require('./utils');
const llm = require('./llm_client');
const config = require('./config');
const memory = require('./memory_store');
const TaskManager = require('./task_manager');
const SurvivalDirector = require('./survival_director');

class Planner {
    constructor(bot, skills, perception, speechManager) {
        this.bot = bot;
        this.skills = skills;
        this.perception = perception;
        this.speechManager = speechManager;
        this.taskManager = new TaskManager(bot, skills);
        this.survivalDirector = new SurvivalDirector(bot, skills, this.taskManager);
        this.mode = config.behavior.defaultMode; // 'manual' or 'autonomous'
        this.isRunning = false;
        this.taskQueue = [];
        this.lastLLMAt = 0;
        this.lastSocialChatAt = 0;
        this.socialIndex = 0;
        this.lastSpokeAt = new Map();
        this.lastAutoChatAt = 0;
        this.lastAutonomousDecisionAt = 0;
        this.followState = {
            target: null,
            since: 0,
            stickUntil: 0,
            lastAny: 0
        };
        this.lastScanPlayers = [];
    }

    shouldQueryLLM(options = {}) {
        const force = options.force === true;
        const cooldownMs = config.behavior.chatCooldown || 0;
        if (force) {
            this.lastLLMAt = Date.now();
            return true;
        }
        if (cooldownMs <= 0) return true;
        const now = Date.now();
        if (now - this.lastLLMAt < cooldownMs) return false;
        this.lastLLMAt = now;
        return true;
    }

    getSocialTarget(players) {
        const intervalMs = config.behavior.socialRoundInterval || 0;
        if (intervalMs <= 0) return null;
        const now = Date.now();
        if (now - this.lastSocialChatAt < intervalMs) return null;

        const maxDistance = Number.isFinite(Number(config.behavior.socialMaxDistance))
            ? Number(config.behavior.socialMaxDistance)
            : 32;
        const candidates = (players || [])
            .filter(p => p && p.name && p.name !== this.bot.username)
            .filter(p => p.hasEntity && Number(p.distance || 0) <= maxDistance);
        const eligible = candidates.filter(p => this.canAddressPlayer(p.name));
        if (eligible.length === 0) return null;

        const ordered = eligible
            .slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        const idx = this.socialIndex % ordered.length;
        return ordered[idx];
    }

    markSocialSpoke() {
        this.lastSocialChatAt = Date.now();
        this.socialIndex += 1;
    }

    canAddressPlayer(name) {
        if (!name) return false;
        if (memory.isMuted(name)) return false;
        const cooldownMs = config.behavior.perPlayerChatCooldown || 0;
        if (cooldownMs <= 0) return true;
        const last = this.lastSpokeAt.get(name) || 0;
        return Date.now() - last >= cooldownMs;
    }

    markPlayerSpoke(name) {
        if (!name) return;
        this.lastSpokeAt.set(name, Date.now());
    }

    markAutoChat() {
        this.lastAutoChatAt = Date.now();
    }

    shouldAutonomousDecision() {
        const cooldownMs = config.behavior.autonomousDecisionCooldownMs || 0;
        if (cooldownMs <= 0) return true;
        const now = Date.now();
        if (now - this.lastAutonomousDecisionAt < cooldownMs) return false;
        this.lastAutonomousDecisionAt = now;
        return true;
    }


    getMemoryContext(scanResult, sender) {
        const memContext = {};
        const players = Array.isArray(scanResult.players) ? scanResult.players : [];

        for (const player of players) {
            const mem = memory.getPlayer(player.name);
            if (mem && mem.facts && mem.facts.length > 0) {
                memContext[player.name] = mem.facts;
            }
        }

        // Memory for sender
        if (sender) {
            const mem = memory.getPlayer(sender);
            if (mem && mem.facts && mem.facts.length > 0) {
                memContext[sender] = mem.facts;
            }
        }
        
        return memContext;
    }

    getTrustContext(scanResult, sender) {
        const trustContext = {};
        const players = Array.isArray(scanResult.players) ? scanResult.players : [];
        for (const player of players) {
            if (!player || !player.name) continue;
            trustContext[player.name] = memory.getTrust(player.name);
        }
        if (sender) {
            trustContext[sender] = memory.getTrust(sender);
        }
        return trustContext;
    }

    getTopicContext(scanResult, sender) {
        const topicContext = {};
        const players = Array.isArray(scanResult.players) ? scanResult.players : [];
        for (const player of players) {
            if (!player || !player.name) continue;
            const topics = memory.getTopics(player.name, 5);
            if (topics.length > 0) {
                topicContext[player.name] = topics;
            }
        }
        if (sender) {
            const topics = memory.getTopics(sender, 5);
            if (topics.length > 0) {
                topicContext[sender] = topics;
            }
        }
        return topicContext;
    }

    getMoodContext() {
        const health = Number.isFinite(Number(this.bot.health)) ? Number(this.bot.health) : 20;
        const food = Number.isFinite(Number(this.bot.food)) ? Number(this.bot.food) : 20;
        let mood = 'neutral';
        if (health <= 8 || food <= 8) {
            mood = 'irritated';
        } else if (health >= 16 && food >= 16) {
            mood = 'good';
        }
        return { mood, health, food };
    }

    updateLastScanPlayers(players) {
        this.lastScanPlayers = Array.isArray(players) ? players : [];
    }

    isTargetVisible(name) {
        if (!name) return false;
        return this.lastScanPlayers.some(p => p && p.name === name && p.hasEntity);
    }

    resolveFollowTarget(args = {}) {
        const targetName = args.targetName || args.entity_name || args.entity || args.name || args.player;
        if (targetName && String(targetName).toLowerCase() !== 'player') {
            return targetName;
        }
        const visible = this.lastScanPlayers
            .filter(p => p && p.hasEntity && !memory.isMuted(p.name));
        if (visible.length === 0) return null;
        visible.sort((a, b) => (a.distance || 0) - (b.distance || 0));
        return visible[0].name || null;
    }

    canFollowTarget(name) {
        const now = Date.now();
        const behavior = config.behavior || {};
        const globalCooldown = Number.isFinite(Number(behavior.followGlobalCooldownMs))
            ? Number(behavior.followGlobalCooldownMs)
            : 30000;
        if (globalCooldown > 0 && now - this.followState.lastAny < globalCooldown) {
            return false;
        }
        const stickMs = Number.isFinite(Number(behavior.followStickMs))
            ? Number(behavior.followStickMs)
            : 60000;
        if (this.followState.target && name && this.followState.target !== name) {
            const targetVisible = this.isTargetVisible(this.followState.target);
            if (targetVisible && now < this.followState.stickUntil) {
                return false;
            }
        }
        if (this.bot.pathfinder.isMoving() && this.followState.target && name && name !== this.followState.target) {
            return false;
        }
        return true;
    }

    markFollow(name) {
        const now = Date.now();
        const stickMs = Number.isFinite(Number(config.behavior.followStickMs))
            ? Number(config.behavior.followStickMs)
            : 60000;
        this.followState.lastAny = now;
        if (name) {
            this.followState.target = name;
            this.followState.since = now;
            this.followState.stickUntil = now + stickMs;
        }
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    stop() {
        this.isRunning = false;
        if (this.taskManager) {
            this.taskManager.stopTask();
        }
    }

    setMode(mode) {
        if (['manual', 'autonomous', 'survival'].includes(mode)) {
            this.mode = mode;
            logger.info(`Mode set to: ${mode}`);
        }
    }

    async loop() {
        while (this.isRunning) {
            try {
                // 1. Task Manager Update (High Priority)
                if (await this.taskManager.update()) {
                    await new Promise(r => setTimeout(r, 500)); // Fast tick for tasks
                    continue; 
                }

                // 2. LLM Decision (Low Priority)
                if (this.mode === 'autonomous' || this.mode === 'survival') {
                    await this.autonomousStep();
                } else {
                    // Manual mode: process queue or wait
                    if (this.taskQueue.length > 0) {
                        const task = this.taskQueue.shift();
                        await this.executeTask(task);
                    }
                }
            } catch (e) {
                logger.error('Planner loop error', e);
            }
            await new Promise(r => setTimeout(r, 2000)); // Tick rate for LLM
        }
    }

    async autonomousStep() {
        const isMoving = this.bot.pathfinder.isMoving();
        const scan = this.perception.scan();
        const behavior = config.behavior || {};
        const maxDistance = Number.isFinite(Number(behavior.socialMaxDistance))
            ? Number(behavior.socialMaxDistance)
            : 32;
        const nearbyPlayers = (scan.players || [])
            .filter(p => p && p.hasEntity && Number(p.distance || 0) <= maxDistance);
        const hasNearbyPlayers = nearbyPlayers.length > 0;
        const scanContext = {
            ...scan,
            players: nearbyPlayers
        };
        this.updateLastScanPlayers(scanContext.players);
        if (this.speechManager) {
            this.speechManager.updateContext(scanContext);
        }

        const soloMode = !hasNearbyPlayers;
        const survivalEnabled = behavior.autonomousSurvivalEnabled !== false;
        const shouldRunSurvival = this.mode === 'survival' || (soloMode && survivalEnabled);
        if (shouldRunSurvival) {
            const acted = await this.survivalDirector.step({ scan: scanContext, soloMode, mode: this.mode });
            if (acted && (soloMode || this.mode === 'survival')) {
                return;
            }
        }
        if (!this.shouldQueryLLM()) {
            if (soloMode) {
                const autoPickup = behavior.autoPickupDrops !== false;
                if (autoPickup && scan.nearbyDrops && scan.nearbyDrops.length > 0 && !isMoving && !this.taskManager.isBusy()) {
                    await this.skills.pickup_item({ radius: behavior.scanRadiusDrops || 18 });
                }
                if (!isMoving && !this.taskManager.isBusy()) {
                    const range = Number.isFinite(Number(behavior.wanderRange)) ? Number(behavior.wanderRange) : 24;
                    await this.skills.wander({ range });
                }
            }
            return;
        }
        if (!this.shouldAutonomousDecision()) return;

        const memories = this.getMemoryContext(scanContext, null);
        const trust = this.getTrustContext(scanContext, null);
        const topics = this.getTopicContext(scanContext, null);
        const mood = this.getMoodContext();
        const recentChat = memory.getRecentInteractions(config.behavior.maxChatHistory || 20);
        const globalChat = memory.getRecentGlobalChat(config.behavior.maxChatHistory || 20);
        const worldFacts = memory.getWorldFacts(20);
        const worldEvents = memory.getWorldEvents(20);
        const socialTarget = soloMode ? null : this.getSocialTarget(nearbyPlayers);

        const context = {
             ...scanContext,
             isMoving: isMoving,
             memory: memories,
             recentChat: recentChat,
             globalChat: globalChat,
             worldFacts: worldFacts,
             worldEvents: worldEvents,
             playerTrust: trust,
             botMood: mood,
             conversationTopics: topics,
             socialFocus: this.followState.target ? {
                 name: this.followState.target,
                 since: this.followState.since,
                 stickUntil: this.followState.stickUntil
             } : null,
             socialTarget: socialTarget ? {
                 name: socialTarget.name,
                 position: socialTarget.position,
                 distance: socialTarget.distance,
                 hasEntity: socialTarget.hasEntity,
                 lastSeen: socialTarget.lastSeen,
                 lastPosition: socialTarget.lastPosition
             } : null
        };
        
        let prompt = "";
        
        if (this.mode === 'autonomous') {
            // Social Mode
            prompt = "Ты в АВТОНОМНОМ режиме (Social). Твоя цель: быть общительным, но не спамить. ";
            prompt += "1. Если видишь игрока: подойди (follow) и начни диалог, но пиши редко и по делу. ";
            prompt += "2. Учитывай Context.playerTrust и Context.botMood: подстраивай тон под настроение и отношение к игроку. ";
            prompt += "3. Анализируй список игроков в Context.players и общайся со всеми в общем чате по очереди, без навязчивости. ";
            prompt += "4. Если никого рядом нет - сосредоточься на выживании и прогрессе (добыча, крафт, ферма). ";
            prompt += "5. Если игрок дал предмет или еду, коротко поблагодари и отметь это.";
            if (socialTarget) {
                prompt += ` СЕЙЧАС социальный обход: адресуйся игроку ${socialTarget.name} в общем чате. Упомяни ник, но пиши коротко. `;
            }

            if (isMoving) {
                 prompt += "Ты идешь. Если видишь игрока - напиши ему коротко (chat). Если цель далеко - можешь сменить цель.";
            }

            if (!soloMode && context.nearbyEntities.some(e => e.type === 'player')) {
                prompt += " ВАЖНО: ИГРОК РЯДОМ. НЕ СПАМИ, но можешь сказать одну фразу. ИСПОЛЬЗУЙ 'remember_fact' ЕСЛИ УЗНАЛ ЧТО-ТО НОВОЕ.";
            }
        } else if (this.mode === 'survival') {
            // Survival Mode
             prompt = "Ты в режиме ВЫЖИВАНИЯ (Survival). Твоя цель: выжить, добыть ресурсы, скрафтить броню и стать крутым. ";
             prompt += "Если нужно много ресурсов (например, дерева), используй 'start_mining_task' чтобы я сам собирал, пока не наберется. ";
             prompt += "1. Еда и Здоровье - приоритет. ";
             prompt += "2. Инструменты: Дерево -> Доски -> Верстак -> Кирка. ";
             prompt += "3. Игроков игнорируй, если они не мешают.";
        }

        const decision = await llm.generateResponse(prompt, context, { reason: this.mode });
        if (!decision) return;
        if (soloMode) {
            decision.chat = null;
        }

        let usedSocial = false;
        if (decision && socialTarget) {
            const targetName = socialTarget.name;
            if (!decision.chat) {
                usedSocial = false;
            } else {
                const chatText = String(decision.chat);
                if (!chatText.toLowerCase().includes(targetName.toLowerCase())) {
                    decision.chat = `${targetName}, ${chatText}`;
                }
                usedSocial = true;
            }
        }

        const chatText = await this.executeDecision(decision, {
            reason: 'autonomous',
            player: socialTarget ? socialTarget.name : null
        });
        if (usedSocial && chatText && socialTarget) {
            this.markSocialSpoke();
            this.markPlayerSpoke(socialTarget.name);
        }

        const autoPickup = behavior.autoPickupDrops !== false;
        if (autoPickup && scan.nearbyDrops && scan.nearbyDrops.length > 0 && !isMoving && !this.taskManager.isBusy()) {
            await this.skills.pickup_item({ radius: behavior.scanRadiusDrops || 18 });
        }
    }

    async processUserRequest(username, message, options = {}) {
        const force = options.forceLLM === true || options.reason === 'direct' || options.reason === 'mention';
        if (!this.shouldQueryLLM({ force })) return;
        if (options.passive && memory.isMuted(username)) return;
        const scan = this.perception.scan();
        this.updateLastScanPlayers(scan.players);
        if (this.speechManager) {
            this.speechManager.updateContext(scan);
        }
        const memories = this.getMemoryContext(scan, username);
        const trust = this.getTrustContext(scan, username);
        const topics = this.getTopicContext(scan, username);
        const mood = this.getMoodContext();
        const recentChat = memory.getRecentInteractions(config.behavior.maxChatHistory || 20);
        const globalChat = memory.getRecentGlobalChat(config.behavior.maxChatHistory || 20);
        const worldFacts = memory.getWorldFacts(20);
        const worldEvents = memory.getWorldEvents(20);
        
        const context = {
            ...scan,
            lastSender: username,
            memory: memories,
            recentChat: recentChat,
            globalChat: globalChat,
            worldFacts: worldFacts,
            worldEvents: worldEvents,
            playerTrust: trust,
            botMood: mood,
            conversationTopics: topics
        };
        const promptParts = [
            `Игрок ${username} пишет: "${message}".`,
            "Если просят запомнить - используй remember_fact.",
            "Если просят добыть много - start_mining_task.",
            options.passive ? "Сообщение из общего чата: ответь коротко и по делу. Не молчи, но избегай лишних действий." : ""
        ];
        const reason = options.reason || (options.passive ? 'social' : 'direct');
        const decision = await llm.generateResponse(promptParts.filter(Boolean).join(' '), context, { reason });
        
        if (decision) {
            const chatText = await this.executeDecision(decision, { reason, player: username });
            if (!chatText && (reason === 'direct' || reason === 'mention')) {
                if (this.speechManager) {
                    this.speechManager.enqueue('ок, принял', { reason, player: username });
                } else {
                    this.bot.chat('ок, принял');
                }
            }
            return;
        }
        if (!llm.isAvailable()) {
            if (this.speechManager) {
                this.speechManager.enqueue('llm сейчас недоступен, попробуй позже', { reason: 'direct', player: username });
            } else {
                this.bot.chat('llm сейчас недоступен, попробуй позже');
            }
        } else {
            if (this.speechManager) {
                this.speechManager.enqueue('чёт не понял, повтори', { reason: 'direct', player: username });
            } else {
                this.bot.chat('чёт не понял, повтори');
            }
        }
    }

    async executeDecision(decision, options = {}) {
        if (decision.thought) logger.info(`Think: ${decision.thought}`);
        
        let chatText = null;
        if (decision.chat !== null && decision.chat !== undefined) {
            chatText = String(decision.chat);
            if (this.speechManager) {
                const sent = this.speechManager.enqueue(chatText, {
                    reason: options.reason || 'autonomous',
                    player: options.player || null
                });
                if (!sent) {
                    chatText = null;
                }
            } else {
                this.bot.chat(chatText);
            }
        }

        if (decision.actions && Array.isArray(decision.actions) && decision.actions.length > 0) {
            for (const action of decision.actions) {
                if (!action || !action.name) continue;
                const args = action.args || {};
                logger.info(`Action: ${action.name}`, args);
                
                // Special handling for tasks
                if (action.name === 'start_mining_task') {
                     const target = args.name || args.target || args.target_block;
                     if (!target) {
                         logger.warn('start_mining_task missing target');
                         continue;
                     }
                     this.taskManager.startTask({ type: 'mine', target: target, amount: args.count || 10 });
                     continue;
                }
                if (action.name === 'start_gather_wood' || action.name === 'start_wood_task') {
                    const amount = Number.isFinite(Number(args.count)) ? Number(args.count) : 32;
                    const types = args.types || args.wood_types || args.woods;
                    this.taskManager.startTask({ type: 'gather_wood', amount, types });
                    continue;
                }
                if (action.name === 'start_farm_task' || action.name === 'start_farming_task') {
                    const crops = args.crops || args.crop_types;
                    this.taskManager.startTask({ type: 'farm', crops });
                    continue;
                }

                if (action.name === 'follow') {
                    const behavior = config.behavior || {};
                    const reason = options.reason || 'autonomous';
                    const allowAutoFollow = behavior.autonomousFollowEnabled !== false;
                    if (reason !== 'direct' && reason !== 'mention' && !allowAutoFollow) {
                        logger.info('Follow disabled for autonomous mode');
                        continue;
                    }
                    const targetName = this.resolveFollowTarget(args);
                    if (!targetName) {
                        logger.info('Follow skipped: no target');
                        continue;
                    }
                    if (!this.canFollowTarget(targetName)) {
                        logger.info('Follow suppressed', { targetName });
                        continue;
                    }
                    await this.skills.follow({ ...args, player: targetName });
                    this.markFollow(targetName);
                    continue;
                }
                
                if (this.skills[action.name]) {
                    try {
                         await this.skills[action.name](args);
                    } catch (e) {
                        logger.error(`Skill ${action.name} failed`, e);
                        if (this.speechManager) {
                            this.speechManager.enqueue(`сек, не могу сделать ${action.name}, чет сломалось`, {
                                reason: options.reason || 'event',
                                player: options.player || null
                            });
                        } else {
                            this.bot.chat(`сек, не могу сделать ${action.name}, чет сломалось`);
                        }
                    }
                } else {
                    logger.warn(`Unknown skill: ${action.name}`);
                }
            }
        }
        return chatText;
    }

    async executeTask(task) {
        // Simplified manual task execution
        logger.info('Executing manual task', task);
    }
}

module.exports = Planner;
