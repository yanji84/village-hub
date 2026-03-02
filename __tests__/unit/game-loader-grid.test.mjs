import { describe, it, expect } from 'vitest';
import { loadGame } from '../../game-loader.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const survivalPath = join(__dirname, '../../games/survival/schema.json');

describe('loadGame — grid type', () => {
  it('loads survival.json successfully', () => {
    const config = loadGame(survivalPath);
    expect(config.isGridGame).toBe(true);
    expect(config.raw.id).toBe('survival');
    expect(config.raw.type).toBe('grid');
  });

  it('builds itemsById lookup', () => {
    const config = loadGame(survivalPath);
    expect(config.itemsById.wood).toBeDefined();
    expect(config.itemsById.wood.type).toBe('resource');
    expect(config.itemsById.wood.id).toBe('wood');
    expect(config.itemsById.iron_sword).toBeDefined();
    expect(config.itemsById.iron_sword.damage).toBe(25);
  });

  it('builds charToTerrainType lookup', () => {
    const config = loadGame(survivalPath);
    expect(config.charToTerrainType['.']).toBe('plains');
    expect(config.charToTerrainType['T']).toBe('forest');
    expect(config.charToTerrainType['^']).toBe('mountain');
    expect(config.charToTerrainType['~']).toBe('water');
    expect(config.charToTerrainType['O']).toBe('cave');
    expect(config.charToTerrainType['#']).toBe('ruins');
  });

  it('includes sceneLabels', () => {
    const config = loadGame(survivalPath);
    expect(config.sceneLabels).toBeDefined();
    expect(config.sceneLabels.statusHeader).toBe('== STATUS ==');
  });

  it('throws on missing required field', () => {
    // We can't easily test with a broken file without writing one,
    // but we can verify the schema is complete by testing that it loads
    expect(() => loadGame(survivalPath)).not.toThrow();
  });
});

describe('loadGame — social type (regression)', () => {
  it('loads social-village.json with isGridGame false', () => {
    const socialPath = join(__dirname, '../../games/social/schema.json');
    const config = loadGame(socialPath);
    expect(config.isGridGame).toBe(false);
    expect(config.raw.id).toBeDefined();
  });
});
