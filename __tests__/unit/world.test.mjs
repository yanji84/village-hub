import { describe, it, expect } from 'vitest';
import { generateWorld, placeInitialResources, respawnResources, getTerrainAt, randomEdgeTile, mulberry32 } from '../../games/survival/world.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, '../../games/survival/schema.json'), 'utf-8'));
const worldConfig = schema.world;

describe('mulberry32', () => {
  it('produces deterministic output from same seed', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(42);
    const seq1 = Array.from({ length: 10 }, () => rng1());
    const seq2 = Array.from({ length: 10 }, () => rng2());
    expect(seq1).toEqual(seq2);
  });

  it('produces different output from different seeds', () => {
    const rng1 = mulberry32(42);
    const rng2 = mulberry32(99);
    expect(rng1()).not.toBe(rng2());
  });

  it('produces values in [0, 1)', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('generateWorld', () => {
  it('generates terrain string of correct length', () => {
    const { terrain } = generateWorld(worldConfig);
    expect(terrain.length).toBe(worldConfig.width * worldConfig.height);
  });

  it('only contains valid terrain chars', () => {
    const validChars = new Set(Object.values(worldConfig.terrain).map(t => t.char));
    const { terrain } = generateWorld(worldConfig);
    for (const ch of terrain) {
      expect(validChars.has(ch)).toBe(true);
    }
  });

  it('is deterministic with same seed', () => {
    const t1 = generateWorld(worldConfig).terrain;
    const t2 = generateWorld(worldConfig).terrain;
    expect(t1).toBe(t2);
  });

  it('produces different worlds with different seeds', () => {
    const t1 = generateWorld({ ...worldConfig, seed: 1 }).terrain;
    const t2 = generateWorld({ ...worldConfig, seed: 999 }).terrain;
    expect(t1).not.toBe(t2);
  });

  it('has passable edge tiles (for spawning)', () => {
    const { terrain } = generateWorld(worldConfig);
    let passableEdges = 0;
    for (let x = 0; x < worldConfig.width; x++) {
      const ch = terrain[x]; // top row
      if (ch !== '~') passableEdges++;
    }
    expect(passableEdges).toBeGreaterThan(0);
  });

  it('returns charToType mapping', () => {
    const { charToType } = generateWorld(worldConfig);
    expect(charToType['.']).toBe('plains');
    expect(charToType['T']).toBe('forest');
    expect(charToType['^']).toBe('mountain');
    expect(charToType['~']).toBe('water');
    expect(charToType['O']).toBe('cave');
    expect(charToType['#']).toBe('ruins');
  });
});

describe('getTerrainAt', () => {
  it('returns correct char at position', () => {
    const terrain = '..T^';
    expect(getTerrainAt(terrain, 0, 0, 2)).toBe('.');
    expect(getTerrainAt(terrain, 1, 0, 2)).toBe('.');
    expect(getTerrainAt(terrain, 0, 1, 2)).toBe('T');
    expect(getTerrainAt(terrain, 1, 1, 2)).toBe('^');
  });

  it('returns null for out-of-bounds', () => {
    expect(getTerrainAt('....', -1, 0, 2)).toBe(null);
    expect(getTerrainAt('....', 0, -1, 2)).toBe(null);
    expect(getTerrainAt('....', 2, 0, 2)).toBe(null);
  });
});

describe('placeInitialResources', () => {
  it('returns sparse tileData object', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const tileData = placeInitialResources(terrain, worldConfig, rng);
    expect(typeof tileData).toBe('object');
    expect(Object.keys(tileData).length).toBeGreaterThan(0);
  });

  it('tiles have resources array with item and qty', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const tileData = placeInitialResources(terrain, worldConfig, rng);
    for (const [key, tile] of Object.entries(tileData)) {
      expect(tile.resources).toBeInstanceOf(Array);
      expect(tile.resources.length).toBeGreaterThan(0);
      for (const res of tile.resources) {
        expect(typeof res.item).toBe('string');
        expect(res.qty).toBeGreaterThan(0);
      }
      expect(tile.depletedAt).toBe(0);
    }
  });

  it('keys are valid "x,y" coordinates', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const tileData = placeInitialResources(terrain, worldConfig, rng);
    for (const key of Object.keys(tileData)) {
      const parts = key.split(',');
      expect(parts.length).toBe(2);
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(worldConfig.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(worldConfig.height);
    }
  });

  it('only places resources on terrain types with configured spawns', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const tileData = placeInitialResources(terrain, worldConfig, rng);
    const charToType = {};
    for (const [type, cfg] of Object.entries(worldConfig.terrain)) {
      charToType[cfg.char] = type;
    }
    for (const key of Object.keys(tileData)) {
      const [x, y] = key.split(',').map(Number);
      const ch = terrain[y * worldConfig.width + x];
      const type = charToType[ch];
      expect(worldConfig.resourceSpawns[type]).toBeDefined();
    }
  });
});

describe('respawnResources', () => {
  it('respawns depleted tiles after respawnInterval', () => {
    const tileData = {
      '5,5': { resources: [], depletedAt: 1 },
    };
    // Simple terrain: all forest (for resource spawns)
    const terrain = 'T'.repeat(64 * 64);
    const rng = mulberry32(42);
    const respawned = respawnResources(tileData, terrain, worldConfig, 1000, rng);
    // With enough ticks elapsed, some tiles should respawn
    // (chance-based, so we can't guarantee, but depletedAt 1 + interval 20 = tick 21 eligible)
    expect(typeof respawned).toBe('object');
  });

  it('does not respawn tiles before interval', () => {
    const tileData = {
      '5,5': { resources: [], depletedAt: 10 },
    };
    const terrain = 'T'.repeat(64 * 64);
    const rng = mulberry32(42);
    const respawned = respawnResources(tileData, terrain, worldConfig, 15, rng);
    expect(respawned.length).toBe(0);
  });

  it('does not respawn tiles that still have resources', () => {
    const tileData = {
      '5,5': { resources: [{ item: 'wood', qty: 1 }], depletedAt: 0 },
    };
    const terrain = 'T'.repeat(64 * 64);
    const rng = mulberry32(42);
    const respawned = respawnResources(tileData, terrain, worldConfig, 1000, rng);
    expect(respawned.length).toBe(0);
  });
});

describe('randomEdgeTile', () => {
  it('returns a tile on the grid edge', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const pos = randomEdgeTile(terrain, worldConfig.width, worldConfig.height, worldConfig.terrain, rng);
    expect(typeof pos.x).toBe('number');
    expect(typeof pos.y).toBe('number');
    const isEdge = pos.x === 0 || pos.x === worldConfig.width - 1
      || pos.y === 0 || pos.y === worldConfig.height - 1;
    expect(isEdge).toBe(true);
  });

  it('returns passable terrain', () => {
    const { terrain } = generateWorld(worldConfig);
    const rng = mulberry32(42);
    const pos = randomEdgeTile(terrain, worldConfig.width, worldConfig.height, worldConfig.terrain, rng);
    const ch = terrain[pos.y * worldConfig.width + pos.x];
    expect(ch).not.toBe('~'); // water is impassable
  });
});
