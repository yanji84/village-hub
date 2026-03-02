import { describe, it, expect } from 'vitest';
import {
  processActions, resolveCombat, tickSurvival, handleDeath,
  doMove, doGather, doCraft, doEat, doAttack, doScout,
} from '../../games/survival/logic.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mulberry32 } from '../../games/survival/world.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, '../../games/survival/schema.json'), 'utf-8'));

// Override world size to 10x10 for test convenience
const testWidth = 10;
const testHeight = 10;
const gameConfig = {
  raw: { ...schema, world: { ...schema.world, width: testWidth, height: testHeight } },
  isGridGame: true,
};

// Helper to create a small all-plains world state
function makeWorldState(overrides = {}) {
  return {
    terrain: '.'.repeat(testWidth * testHeight),
    tileData: {},
    bots: {},
    clock: { tick: 0, dayTick: 0 },
    ...overrides,
  };
}

function makeBotState(overrides = {}) {
  return {
    x: 5, y: 5, health: 100, hunger: 0,
    inventory: {}, equipment: { weapon: null, armor: null, tool: null },
    alive: true,
    ...overrides,
  };
}

describe('doMove', () => {
  it('moves bot in valid direction', () => {
    const bot = makeBotState();
    const world = makeWorldState();
    const events = doMove('alice', bot, 'N', world, gameConfig);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('move');
    expect(bot.x).toBe(5);
    expect(bot.y).toBe(4);
  });

  it('fails on invalid direction', () => {
    const bot = makeBotState();
    const world = makeWorldState();
    const events = doMove('alice', bot, 'INVALID', world, gameConfig);
    expect(events[0].action).toBe('move_fail');
    expect(bot.x).toBe(5);
    expect(bot.y).toBe(5);
  });

  it('fails at world edge', () => {
    const bot = makeBotState({ x: 0, y: 0 });
    const world = makeWorldState();
    const events = doMove('alice', bot, 'N', world, gameConfig);
    expect(events[0].action).toBe('move_fail');
  });

  it('fails on impassable terrain (water)', () => {
    const bot = makeBotState({ x: 4, y: 5 });
    // Place water at (5,5)
    const terrain = '.'.repeat(5 * testWidth + 5) + '~' + '.'.repeat(testWidth * testHeight - 5 * testWidth - 6);
    const world = makeWorldState({ terrain });
    const events = doMove('alice', bot, 'E', world, gameConfig);
    expect(events[0].action).toBe('move_fail');
    expect(events[0].reason).toContain('Impassable');
  });

  it('handles diagonal movement', () => {
    const bot = makeBotState();
    const world = makeWorldState();
    doMove('alice', bot, 'NE', world, gameConfig);
    expect(bot.x).toBe(6);
    expect(bot.y).toBe(4);
  });
});

describe('doGather', () => {
  it('gathers resources from current tile', () => {
    const bot = makeBotState();
    const world = makeWorldState({
      tileData: { '5,5': { resources: [{ item: 'wood', qty: 3 }], depletedAt: 0 } },
    });
    const events = doGather('alice', bot, world, gameConfig, 10);
    expect(events[0].action).toBe('gather');
    expect(bot.inventory.wood).toBeGreaterThan(0);
  });

  it('fails when no resources on tile', () => {
    const bot = makeBotState();
    const world = makeWorldState();
    const events = doGather('alice', bot, world, gameConfig, 10);
    expect(events[0].action).toBe('gather_fail');
  });

  it('depletes tile when all resources gathered', () => {
    const bot = makeBotState();
    const world = makeWorldState({
      tileData: { '5,5': { resources: [{ item: 'berry', qty: 1 }], depletedAt: 0 } },
    });
    doGather('alice', bot, world, gameConfig, 42);
    expect(world.tileData['5,5'].resources).toHaveLength(0);
    expect(world.tileData['5,5'].depletedAt).toBe(42);
  });

  it('fails when inventory is full', () => {
    const inv = {};
    for (let i = 0; i < 20; i++) inv[`item${i}`] = 1;
    const bot = makeBotState({ inventory: inv });
    const world = makeWorldState({
      tileData: { '5,5': { resources: [{ item: 'wood', qty: 1 }], depletedAt: 0 } },
    });
    const events = doGather('alice', bot, world, gameConfig, 10);
    expect(events[0].action).toBe('gather_fail');
    expect(events[0].reason).toContain('Inventory full');
  });

  it('applies gather bonus from equipped tool', () => {
    const bot = makeBotState({ equipment: { weapon: null, armor: null, tool: 'wooden_pickaxe' } });
    const world = makeWorldState({
      tileData: { '5,5': { resources: [{ item: 'stone', qty: 5 }], depletedAt: 0 } },
    });
    doGather('alice', bot, world, gameConfig, 10);
    // wooden_pickaxe gives gatherBonus 1, so should gather 2 (1 + 1)
    expect(bot.inventory.stone).toBe(2);
  });
});

describe('doCraft', () => {
  it('crafts wooden_pickaxe from 2 wood', () => {
    const bot = makeBotState({ inventory: { wood: 5 } });
    const events = doCraft('alice', bot, 'wooden_pickaxe', gameConfig);
    expect(events[0].action).toBe('craft');
    expect(events[0].item).toBe('wooden_pickaxe');
    expect(bot.inventory.wood).toBe(3);
    // Auto-equips to empty tool slot
    expect(bot.equipment.tool).toBe('wooden_pickaxe');
  });

  it('fails when missing materials', () => {
    const bot = makeBotState({ inventory: { wood: 1 } });
    const events = doCraft('alice', bot, 'wooden_pickaxe', gameConfig);
    expect(events[0].action).toBe('craft_fail');
    expect(events[0].reason).toContain('Missing');
  });

  it('fails with unknown recipe', () => {
    const bot = makeBotState();
    const events = doCraft('alice', bot, 'diamond_sword', gameConfig);
    expect(events[0].action).toBe('craft_fail');
    expect(events[0].reason).toContain('Unknown recipe');
  });

  it('auto-equips weapon to empty slot', () => {
    const bot = makeBotState({ inventory: { wood: 3, stone: 2 } });
    doCraft('alice', bot, 'wooden_sword', gameConfig);
    expect(bot.equipment.weapon).toBe('wooden_sword');
  });

  it('does not auto-equip when slot is occupied', () => {
    const bot = makeBotState({
      inventory: { wood: 3, stone: 2 },
      equipment: { weapon: 'stone_sword', armor: null, tool: null },
    });
    doCraft('alice', bot, 'wooden_sword', gameConfig);
    expect(bot.equipment.weapon).toBe('stone_sword');
    expect(bot.inventory.wooden_sword).toBe(1);
  });
});

describe('doEat', () => {
  it('reduces hunger when eating food', () => {
    const bot = makeBotState({ hunger: 50, inventory: { berry: 3 } });
    const events = doEat('alice', bot, 'berry', gameConfig);
    expect(events[0].action).toBe('eat');
    expect(bot.hunger).toBe(40); // berry restores 10
    expect(bot.inventory.berry).toBe(2);
  });

  it('fails when eating non-food item', () => {
    const bot = makeBotState({ inventory: { wood: 1 } });
    const events = doEat('alice', bot, 'wood', gameConfig);
    expect(events[0].action).toBe('eat_fail');
  });

  it('fails when item not in inventory', () => {
    const bot = makeBotState();
    const events = doEat('alice', bot, 'berry', gameConfig);
    expect(events[0].action).toBe('eat_fail');
    expect(events[0].reason).toContain('No berry');
  });

  it('hunger does not go below 0', () => {
    const bot = makeBotState({ hunger: 5, inventory: { berry: 1 } });
    doEat('alice', bot, 'berry', gameConfig);
    expect(bot.hunger).toBe(0);
  });
});

describe('doAttack', () => {
  it('queues attack against adjacent bot', () => {
    const botState = makeBotState();
    const world = makeWorldState({
      bots: { alice: { x: 5, y: 5, alive: true }, bob: { x: 5, y: 6, alive: true } },
    });
    const result = doAttack('alice', 'bob', botState, world, gameConfig);
    expect(result.pending).toEqual({ attacker: 'alice', target: 'bob' });
  });

  it('fails when target is too far', () => {
    const botState = makeBotState();
    const world = makeWorldState({
      bots: { alice: { x: 5, y: 5, alive: true }, bob: { x: 5, y: 8, alive: true } },
    });
    const result = doAttack('alice', 'bob', botState, world, gameConfig);
    expect(result.pending).toBeNull();
    expect(result.events[0].action).toBe('attack_fail');
  });

  it('fails when target is dead', () => {
    const botState = makeBotState();
    const world = makeWorldState({
      bots: { alice: { x: 5, y: 5, alive: true }, bob: { x: 5, y: 6, alive: false } },
    });
    const result = doAttack('alice', 'bob', botState, world, gameConfig);
    expect(result.pending).toBeNull();
  });

  it('fails when no target specified', () => {
    const botState = makeBotState();
    const world = makeWorldState();
    const result = doAttack('alice', null, botState, world, gameConfig);
    expect(result.pending).toBeNull();
  });
});

describe('doScout', () => {
  it('emits scout event', () => {
    const bot = makeBotState();
    const world = makeWorldState();
    const events = doScout('alice', bot, world, gameConfig);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('scout');
    expect(events[0].bot).toBe('alice');
  });
});

describe('processActions', () => {
  it('processes non-exclusive actions together', () => {
    const bot = makeBotState({ hunger: 50, inventory: { berry: 2 } });
    const world = makeWorldState({
      tileData: { '5,5': { resources: [{ item: 'wood', qty: 2 }], depletedAt: 0 } },
    });
    const actions = [
      { tool: 'survival_gather', params: {} },
      { tool: 'survival_eat', params: { item: 'berry' } },
    ];
    const { events } = processActions('alice', actions, bot, world, gameConfig);
    const actionTypes = events.map(e => e.action);
    expect(actionTypes).toContain('gather');
    expect(actionTypes).toContain('eat');
  });

  it('exclusive action overrides non-exclusive', () => {
    const bot = makeBotState({ hunger: 50, inventory: { berry: 2 } });
    const world = makeWorldState();
    const actions = [
      { tool: 'survival_move', params: { direction: 'N' } },
      { tool: 'survival_eat', params: { item: 'berry' } },
    ];
    const { events } = processActions('alice', actions, bot, world, gameConfig);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('move');
    // Eat should not have been processed
    expect(bot.inventory.berry).toBe(2);
  });

  it('returns empty for dead bot', () => {
    const bot = makeBotState({ alive: false });
    const world = makeWorldState();
    const { events, pendingAttacks } = processActions('alice', [{ tool: 'survival_move', params: { direction: 'N' } }], bot, world, gameConfig);
    expect(events).toHaveLength(0);
    expect(pendingAttacks).toHaveLength(0);
  });
});

describe('resolveCombat', () => {
  it('applies damage simultaneously', () => {
    const bots = {
      alice: makeBotState({ equipment: { weapon: 'stone_sword', armor: null, tool: null } }),
      bob: makeBotState({ equipment: { weapon: null, armor: null, tool: null } }),
    };
    const attacks = [
      { attacker: 'alice', target: 'bob' },
      { attacker: 'bob', target: 'alice' },
    ];
    const events = resolveCombat(attacks, bots, gameConfig);
    // stone_sword does 15 damage
    expect(bots.bob.health).toBe(85);
    // unarmed does 5 damage
    expect(bots.alice.health).toBe(95);
    expect(events.some(e => e.action === 'attack')).toBe(true);
  });

  it('respects armor defense', () => {
    const bots = {
      alice: makeBotState({ equipment: { weapon: null, armor: null, tool: null } }),
      bob: makeBotState({ equipment: { weapon: null, armor: 'wooden_shield', tool: null } }),
    };
    const attacks = [{ attacker: 'alice', target: 'bob' }];
    resolveCombat(attacks, bots, gameConfig);
    // unarmed 5 - shield defense 3 = 2 damage, but min 1
    expect(bots.bob.health).toBe(98);
  });

  it('marks killed when health hits 0', () => {
    const bots = {
      alice: makeBotState({ equipment: { weapon: 'iron_sword', armor: null, tool: null } }),
      bob: makeBotState({ health: 10, equipment: { weapon: null, armor: null, tool: null } }),
    };
    const attacks = [{ attacker: 'alice', target: 'bob' }];
    const events = resolveCombat(attacks, bots, gameConfig);
    expect(bots.bob.health).toBe(0);
    expect(events.some(e => e.action === 'killed' && e.bot === 'bob')).toBe(true);
  });

  it('returns empty for no attacks', () => {
    expect(resolveCombat([], {}, gameConfig)).toHaveLength(0);
  });

  it('minimum damage is 1 even with high armor', () => {
    const bots = {
      alice: makeBotState({ equipment: { weapon: null, armor: null, tool: null } }),
      bob: makeBotState({ equipment: { weapon: null, armor: 'iron_armor', tool: null } }),
    };
    // unarmed 5 - iron_armor 10 = -5, but minimum 1
    const attacks = [{ attacker: 'alice', target: 'bob' }];
    resolveCombat(attacks, bots, gameConfig);
    expect(bots.bob.health).toBe(99);
  });
});

describe('tickSurvival', () => {
  it('increases hunger each tick', () => {
    const bots = { alice: makeBotState({ hunger: 0 }) };
    tickSurvival(bots, schema.survival);
    expect(bots.alice.hunger).toBe(3);
  });

  it('drains health when hunger exceeds threshold', () => {
    const bots = { alice: makeBotState({ hunger: 80 }) };
    const events = tickSurvival(bots, schema.survival);
    // hunger 80 + 3 = 83, >= 80 threshold, drain 5
    expect(bots.alice.health).toBe(95);
    expect(events.some(e => e.action === 'hunger_drain')).toBe(true);
  });

  it('emits hunger warning near threshold', () => {
    const bots = { alice: makeBotState({ hunger: 68 }) };
    const events = tickSurvival(bots, schema.survival);
    // hunger 68 + 3 = 71, 71 >= 70 (threshold - 10) but < 80
    expect(events.some(e => e.action === 'hunger_warning')).toBe(true);
  });

  it('caps hunger at maxHunger', () => {
    const bots = { alice: makeBotState({ hunger: 99 }) };
    tickSurvival(bots, schema.survival);
    expect(bots.alice.hunger).toBe(100);
  });

  it('emits starved when health drops to 0', () => {
    const bots = { alice: makeBotState({ hunger: 99, health: 3 }) };
    const events = tickSurvival(bots, schema.survival);
    expect(bots.alice.health).toBe(0);
    expect(events.some(e => e.action === 'starved')).toBe(true);
  });

  it('skips dead bots', () => {
    const bots = { alice: makeBotState({ alive: false, hunger: 50 }) };
    tickSurvival(bots, schema.survival);
    expect(bots.alice.hunger).toBe(50); // unchanged
  });
});

describe('handleDeath', () => {
  it('drops inventory at death position', () => {
    const bot = makeBotState({ inventory: { wood: 3, berry: 2 }, x: 5, y: 5 });
    const world = makeWorldState();
    const rng = mulberry32(42);
    handleDeath('alice', bot, world, schema.survival, schema.world.terrain, rng, 10, 10);
    const tile = world.tileData['5,5'];
    expect(tile).toBeDefined();
    expect(tile.resources.some(r => r.item === 'wood' && r.qty === 3)).toBe(true);
    expect(tile.resources.some(r => r.item === 'berry' && r.qty === 2)).toBe(true);
  });

  it('drops equipment at death position', () => {
    const bot = makeBotState({
      inventory: {},
      equipment: { weapon: 'stone_sword', armor: null, tool: null },
      x: 5, y: 5,
    });
    const world = makeWorldState();
    const rng = mulberry32(42);
    handleDeath('alice', bot, world, schema.survival, schema.world.terrain, rng, 10, 10);
    const tile = world.tileData['5,5'];
    expect(tile.resources.some(r => r.item === 'stone_sword')).toBe(true);
    expect(bot.equipment.weapon).toBeNull();
  });

  it('resets bot to respawn stats', () => {
    const bot = makeBotState({ health: 0, hunger: 100, inventory: { wood: 5 } });
    const world = makeWorldState();
    const rng = mulberry32(42);
    handleDeath('alice', bot, world, schema.survival, schema.world.terrain, rng, 10, 10);
    expect(bot.health).toBe(50);
    expect(bot.hunger).toBe(30);
    expect(bot.alive).toBe(true);
    expect(Object.keys(bot.inventory)).toHaveLength(0);
  });

  it('respawns on grid edge', () => {
    const bot = makeBotState({ health: 0 });
    const world = makeWorldState();
    const rng = mulberry32(42);
    const events = handleDeath('alice', bot, world, schema.survival, schema.world.terrain, rng, 10, 10);
    const respawnEvent = events.find(e => e.action === 'respawn');
    expect(respawnEvent).toBeDefined();
    const { x, y } = respawnEvent;
    const isEdge = x === 0 || x === 9 || y === 0 || y === 9;
    expect(isEdge).toBe(true);
  });

  it('emits death and respawn events', () => {
    const bot = makeBotState({ health: 0 });
    const world = makeWorldState();
    const rng = mulberry32(42);
    const events = handleDeath('alice', bot, world, schema.survival, schema.world.terrain, rng, 10, 10);
    expect(events.some(e => e.action === 'death')).toBe(true);
    expect(events.some(e => e.action === 'respawn')).toBe(true);
  });
});
