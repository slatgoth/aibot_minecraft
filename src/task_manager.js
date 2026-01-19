const { goals } = require('mineflayer-pathfinder');
const { logger } = require('./utils');
const Vec3 = require('vec3');

class TaskManager {
    constructor(bot, skills) {
        this.bot = bot;
        this.skills = skills;
        this.currentTask = null; // { type: 'mine', target: 'oak_log', amount: 10, collected: 0 }
    }

    isBusy() {
        return this.currentTask !== null;
    }

    startTask(task) {
        logger.info(`Starting long task: ${task.type}`, task);
        this.currentTask = task;
    }

    stopTask() {
        if (this.currentTask) {
            logger.info(`Stopping task: ${this.currentTask.type}`);
            this.bot.pathfinder.setGoal(null);
            this.currentTask = null;
        }
    }

    async update() {
        if (!this.currentTask) return false;

        const task = this.currentTask;

        try {
            if (task.type === 'mine') {
                await this.handleMiningTask(task);
            } else if (task.type === 'defend') {
                // Combat logic handled by PVP plugin mostly, but we can monitor safety
                if (!this.bot.nearestEntity(e => e.type === 'mob' && e.position.distanceTo(this.bot.entity.position) < 10)) {
                    this.stopTask(); // No enemies nearby
                }
            }
        } catch (e) {
            logger.error(`Task error: ${task.type}`, e);
            this.stopTask();
            return false; // Task failed
        }
        
        return true; // Still working
    }

    async handleMiningTask(task) {
        // Check if we have enough
        const targetItem = this.bot.registry.itemsByName[task.target];
        if (!targetItem) {
            this.bot.chat(`что за ${task.target}? не понимаю`);
            this.stopTask();
            return;
        }
        const count = this.bot.inventory.count(targetItem.id);
        if (count >= task.amount) {
            this.bot.chat(`собрал ${task.target}, хватит пока`);
            this.stopTask();
            return;
        }

        // Check if we are already mining or moving
        if (this.bot.pathfinder.isMoving()) return;
        if (this.bot.targetDigBlock) return; // Already digging

        // Find closest block
        const positions = this.bot.findBlocks({
            matching: b => b.name === task.target,
            maxDistance: 32,
            count: 20
        });
        const block = positions
            .map(pos => this.bot.blockAt(pos))
            .find(candidate => candidate && this.skills.isSafeToMine(candidate));

        if (!block) {
            this.bot.chat(`больше не вижу ${task.target} рядом`);
            this.stopTask();
            return;
        }

        // Go and mine
        try {
            await this.bot.collectBlock.collect(block);
            // We don't stop task here, we wait for next update loop to check count
        } catch (e) {
            // If pathfinding fails repeatedly, abort
            logger.warn(`Mining step failed: ${e.message}`);
            // Wander a bit?
            this.stopTask();
        }
    }
}

module.exports = TaskManager;
