const config = require('./config');
const { logger } = require('./utils');

class SurvivalDirector {
    constructor(bot, skills, taskManager) {
        this.bot = bot;
        this.skills = skills;
        this.taskManager = taskManager;
        this.lastStepAt = 0;
        this.lastActionAt = 0;
    }

    shouldStep() {
        const cooldownMs = Number.isFinite(Number(config.behavior.survivalStepCooldownMs))
            ? Number(config.behavior.survivalStepCooldownMs)
            : 10000;
        const now = Date.now();
        if (now - this.lastStepAt < cooldownMs) return false;
        this.lastStepAt = now;
        return true;
    }

    canAct() {
        const cooldownMs = Number.isFinite(Number(config.behavior.survivalActionCooldownMs))
            ? Number(config.behavior.survivalActionCooldownMs)
            : 15000;
        return Date.now() - this.lastActionAt >= cooldownMs;
    }

    markAct() {
        this.lastActionAt = Date.now();
    }

    countItem(name) {
        if (!name) return 0;
        const item = this.bot.registry.itemsByName[name];
        if (!item) return 0;
        return this.bot.inventory.count(item.id);
    }

    hasItem(name) {
        return this.countItem(name) > 0;
    }

    countBySuffix(suffixes) {
        const items = this.bot.inventory.items();
        let total = 0;
        for (const item of items) {
            if (!item || !item.name) continue;
            if (suffixes.some(suffix => item.name.endsWith(suffix))) {
                total += item.count || 0;
            }
        }
        return total;
    }

    getFoodItem() {
        const foods = this.bot.inventory.items().filter(i => i && i.food > 0);
        if (foods.length === 0) return null;
        foods.sort((a, b) => (b.food || 0) - (a.food || 0));
        return foods[0];
    }

    async step(context = {}) {
        if (!this.shouldStep()) return false;
        if (!this.canAct()) return false;
        if (this.taskManager && this.taskManager.isBusy()) return false;

        const health = Number.isFinite(Number(this.bot.health)) ? Number(this.bot.health) : 20;
        const food = Number.isFinite(Number(this.bot.food)) ? Number(this.bot.food) : 20;

        if (health <= 10 || food <= 12) {
            const foodItem = this.getFoodItem();
            if (foodItem) {
                await this.skills.eat({ name: foodItem.name });
                this.markAct();
                return true;
            }
        }

        const woodCount = this.countBySuffix(['_log', '_wood', '_stem', '_hyphae']) + this.countItem('bamboo_block');
        const plankCount = this.countBySuffix(['_planks', 'bamboo_planks']);
        const hasCraftingTable = this.hasItem('crafting_table');
        const hasWoodPickaxe = this.hasItem('wooden_pickaxe');
        const hasStonePickaxe = this.hasItem('stone_pickaxe');
        const hasIronPickaxe = this.hasItem('iron_pickaxe');

        if (!hasCraftingTable && (woodCount > 0 || plankCount > 0)) {
            await this.skills.craft_item({ name: 'crafting_table', count: 1 });
            this.markAct();
            return true;
        }

        if ((woodCount + plankCount) < 12) {
            this.taskManager.startTask({ type: 'gather_wood', amount: 24 });
            this.markAct();
            return true;
        }

        if (!hasWoodPickaxe && plankCount >= 3) {
            await this.skills.craft_item({ name: 'wooden_pickaxe', count: 1 });
            this.markAct();
            return true;
        }

        const cobbleCount = this.countItem('cobblestone');
        if (hasWoodPickaxe && !hasStonePickaxe && cobbleCount < 3) {
            this.taskManager.startTask({ type: 'mine', target: 'stone', amount: 12 });
            this.markAct();
            return true;
        }

        if (hasWoodPickaxe && !hasStonePickaxe && cobbleCount >= 3) {
            await this.skills.craft_item({ name: 'stone_pickaxe', count: 1 });
            this.markAct();
            return true;
        }

        const rawIron = this.countItem('raw_iron');
        const ironOre = this.countItem('iron_ore');
        const ironIngot = this.countItem('iron_ingot');

        if (hasStonePickaxe && !hasIronPickaxe && (rawIron + ironOre + ironIngot) < 6) {
            this.taskManager.startTask({ type: 'mine', target: 'iron_ore', amount: 6 });
            this.markAct();
            return true;
        }

        if (rawIron > 0) {
            await this.skills.use_furnace({ input_name: 'raw_iron', count: Math.min(rawIron, 8) });
            this.markAct();
            return true;
        }

        if (!hasIronPickaxe && ironIngot >= 3) {
            await this.skills.craft_item({ name: 'iron_pickaxe', count: 1 });
            this.markAct();
            return true;
        }

        if (food < 14 && this.countBySuffix(['_seeds']) > 0) {
            this.taskManager.startTask({ type: 'farm' });
            this.markAct();
            return true;
        }

        return false;
    }
}

module.exports = SurvivalDirector;
