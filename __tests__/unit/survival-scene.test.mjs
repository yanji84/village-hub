import { describe, it, expect } from 'vitest';
import { buildSurvivalScene, getDayPhase, formatInventory, formatStats } from '../../games/survival/scene.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, '../../games/survival/schema.json'), 'utf-8'));
const gameConfig = { raw: schema, isGridGame: true };

describe('getDayPhase', () => {
  const dayNight = schema.dayNight;

  it('returns dawn at tick 0', () => {
    expect(getDayPhase(0, dayNight).name).toBe('dawn');
  });

  it('returns day at tick 4', () => {
    expect(getDayPhase(4, dayNight).name).toBe('day');
  });

  it('returns day at tick 10', () => {
    expect(getDayPhase(10, dayNight).name).toBe('day');
  });

  it('returns dusk at tick 18', () => {
    expect(getDayPhase(18, dayNight).name).toBe('dusk');
  });

  it('returns night at tick 22', () => {
    expect(getDayPhase(22, dayNight).name).toBe('night');
  });

  it('wraps around cycle (tick 24 = dawn)', () => {
    expect(getDayPhase(24, dayNight).name).toBe('dawn');
  });

  it('wraps around cycle (tick 28 = day)', () => {
    expect(getDayPhase(28, dayNight).name).toBe('day');
  });

  it('returns correct visibility base', () => {
    expect(getDayPhase(10, dayNight).visibilityBase).toBe(7);
    expect(getDayPhase(23, dayNight).visibilityBase).toBe(3);
  });
});

describe('formatInventory', () => {
  it('shows empty inventory', () => {
    const result = formatInventory({}, { weapon: null, armor: null, tool: null }, gameConfig);
    expect(result).toContain('empty');
    expect(result).toContain('0/20');
  });

  it('shows items with counts', () => {
    const inv = { wood: 3, berry: 2 };
    const result = formatInventory(inv, { weapon: null, armor: null, tool: null }, gameConfig);
    expect(result).toContain('Wood x3');
    expect(result).toContain('Berry x2');
    expect(result).toContain('5/20');
  });

  it('shows equipped items', () => {
    const inv = {};
    const equip = { weapon: 'stone_sword', armor: null, tool: 'wooden_pickaxe' };
    const result = formatInventory(inv, equip, gameConfig);
    expect(result).toContain('[Stone Sword equipped]');
    expect(result).toContain('[Wooden Pickaxe equipped]');
  });
});

describe('formatStats', () => {
  it('formats stats line correctly', () => {
    const bot = { health: 85, hunger: 42, x: 32, y: 15 };
    const dayPhase = { name: 'day' };
    const result = formatStats(bot, dayPhase, 10);
    expect(result).toContain('HP: 85/100');
    expect(result).toContain('Hunger: 42/100');
    expect(result).toContain('Pos: (32,15)');
    expect(result).toContain('Time: day');
    expect(result).toContain('tick 10');
  });
});

describe('buildSurvivalScene', () => {
  const smallTerrain = '.'.repeat(100);

  function makeOpts(overrides = {}) {
    return {
      botName: 'alice',
      botState: { x: 5, y: 5, health: 100, hunger: 0, inventory: {}, equipment: { weapon: null, armor: null, tool: null }, alive: true },
      worldState: {
        terrain: smallTerrain,
        tileData: {},
        bots: { alice: { x: 5, y: 5, alive: true } },
        clock: { tick: 10, dayTick: 10 },
      },
      gameConfig: { ...gameConfig, raw: { ...schema, world: { ...schema.world, width: 10, height: 10 } } },
      currentTick: 10,
      recentEvents: [],
      villageSummary: '',
      isScout: false,
      ...overrides,
    };
  }

  it('includes all section headers', () => {
    const scene = buildSurvivalScene(makeOpts());
    expect(scene).toContain('== STATUS ==');
    expect(scene).toContain('== MAP ==');
    expect(scene).toContain('== INVENTORY ==');
    expect(scene).toContain('== NEARBY ==');
    expect(scene).toContain('== RECENT EVENTS ==');
    expect(scene).toContain('== ACTIONS ==');
    expect(scene).toContain('== GUIDANCE ==');
  });

  it('includes ASCII map with bot marker', () => {
    const scene = buildSurvivalScene(makeOpts());
    expect(scene).toContain('*');
  });

  it('includes map legend', () => {
    const scene = buildSurvivalScene(makeOpts());
    expect(scene).toContain('Legend:');
  });

  it('shows empty inventory message', () => {
    const scene = buildSurvivalScene(makeOpts());
    expect(scene).toContain('Your inventory is empty.');
  });

  it('shows inventory when bot has items', () => {
    const opts = makeOpts();
    opts.botState.inventory = { wood: 3 };
    const scene = buildSurvivalScene(opts);
    expect(scene).toContain('Wood x3');
  });

  it('shows no nearby message when alone', () => {
    const scene = buildSurvivalScene(makeOpts());
    expect(scene).toContain('No other survivors visible.');
  });

  it('shows nearby bots when present', () => {
    const opts = makeOpts();
    opts.worldState.bots.bob = { x: 6, y: 5, alive: true, health: 80, equipment: { weapon: null, armor: null, tool: null } };
    const scene = buildSurvivalScene(opts);
    expect(scene).toContain('bob');
    expect(scene).toContain('HP:80');
  });

  it('shows hunt suggestion only when nearby bots exist', () => {
    const sceneAlone = buildSurvivalScene(makeOpts());
    expect(sceneAlone).not.toContain('Nearby bots detected');

    const opts = makeOpts();
    opts.worldState.bots.bob = { x: 6, y: 5, alive: true, health: 80, equipment: { weapon: null, armor: null, tool: null } };
    const sceneWithBot = buildSurvivalScene(opts);
    expect(sceneWithBot).toContain('Nearby bots detected');
  });

  it('shows craftable recipes when materials available', () => {
    const opts = makeOpts();
    opts.botState.inventory = { wood: 5 };
    const scene = buildSurvivalScene(opts);
    expect(scene).toContain('wooden_pickaxe');
    expect(scene).toContain('wooden_shield');
  });

  it('shows recent events when provided', () => {
    const opts = makeOpts();
    opts.recentEvents = [
      { action: 'move', bot: 'bob', direction: 'N', to: { x: 3, y: 2 } },
    ];
    const scene = buildSurvivalScene(opts);
    expect(scene).toContain('bob moved N');
  });

  it('includes village summary when provided', () => {
    const opts = makeOpts();
    opts.villageSummary = 'You remember encountering a stranger.';
    const scene = buildSurvivalScene(opts);
    expect(scene).toContain('You remember encountering a stranger.');
  });
});
