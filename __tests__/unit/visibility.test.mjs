import { describe, it, expect } from 'vitest';
import { computeVisibility, getVisibleTiles, buildAsciiMap } from '../../games/survival/visibility.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(__dirname, '../../games/survival/schema.json'), 'utf-8'));

// Override world size to 8x8 for test convenience
const smallWidth = 8;
const smallHeight = 8;
const gameConfig = {
  raw: { ...schema, world: { ...schema.world, width: smallWidth, height: smallHeight } },
  isGridGame: true,
};

// Simple 8x8 terrain of all plains
const smallTerrain = '.'.repeat(smallWidth * smallHeight);

describe('computeVisibility', () => {
  it('returns base visibility for plains during day', () => {
    const botState = { x: 4, y: 4, equipment: {} };
    const dayPhase = { visibilityBase: 7 }; // day
    const radius = computeVisibility(botState, smallTerrain, dayPhase, gameConfig);
    // plains has visibilityMod 0, so radius = 7
    expect(radius).toBe(7);
  });

  it('reduces visibility in forest', () => {
    // Create terrain with forest at (4,4)
    const terrain = '.'.repeat(4 * 8 + 4) + 'T' + '.'.repeat(8 * 8 - 4 * 8 - 5);
    const botState = { x: 4, y: 4, equipment: {} };
    const dayPhase = { visibilityBase: 7 };
    const radius = computeVisibility(botState, terrain, dayPhase, gameConfig);
    // forest has visibilityMod -1, so radius = 6
    expect(radius).toBe(6);
  });

  it('increases visibility on mountain', () => {
    const terrain = '.'.repeat(4 * 8 + 4) + '^' + '.'.repeat(8 * 8 - 4 * 8 - 5);
    const botState = { x: 4, y: 4, equipment: {} };
    const dayPhase = { visibilityBase: 7 };
    const radius = computeVisibility(botState, terrain, dayPhase, gameConfig);
    // mountain has visibilityMod +2, so radius = 9
    expect(radius).toBe(9);
  });

  it('clamps minimum visibility to 2', () => {
    const botState = { x: 4, y: 4, equipment: {} };
    const dayPhase = { visibilityBase: 1 };
    const terrain = '.'.repeat(4 * 8 + 4) + 'O' + '.'.repeat(8 * 8 - 4 * 8 - 5);
    const radius = computeVisibility(botState, terrain, dayPhase, gameConfig);
    // cave visibilityMod -2, base 1, so raw = -1, clamped to 2
    expect(radius).toBe(2);
  });

  it('clamps maximum visibility to 15', () => {
    const botState = { x: 4, y: 4, equipment: {} };
    const dayPhase = { visibilityBase: 20 };
    const radius = computeVisibility(botState, smallTerrain, dayPhase, gameConfig);
    expect(radius).toBe(15);
  });
});

describe('getVisibleTiles', () => {
  it('returns set of visible tiles within radius', () => {
    const visible = getVisibleTiles(5, 5, 2, 10, 10);
    expect(visible).toBeInstanceOf(Set);
    expect(visible.has('5,5')).toBe(true); // center
    expect(visible.has('5,3')).toBe(true); // 2 north
    expect(visible.has('5,7')).toBe(true); // 2 south
    expect(visible.has('3,5')).toBe(true); // 2 west
    expect(visible.has('7,5')).toBe(true); // 2 east
  });

  it('excludes tiles outside euclidean radius', () => {
    const visible = getVisibleTiles(5, 5, 2, 10, 10);
    // (5+2, 5+2) = (7,7), distance = sqrt(8) ≈ 2.83, which is > 2
    expect(visible.has('7,7')).toBe(false);
  });

  it('excludes tiles outside grid bounds', () => {
    const visible = getVisibleTiles(0, 0, 3, 5, 5);
    expect(visible.has('-1,0')).toBe(false);
    expect(visible.has('0,-1')).toBe(false);
    expect(visible.has('0,0')).toBe(true);
  });

  it('center tile is always visible', () => {
    const visible = getVisibleTiles(3, 3, 1, 10, 10);
    expect(visible.has('3,3')).toBe(true);
  });
});

describe('buildAsciiMap', () => {
  it('places * at bot position (center)', () => {
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 3,
      terrain: smallTerrain,
      tileData: {},
      allBots: { me: { x: 4, y: 4, alive: true } },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // Center of 7x7 viewport = line 3, col 3
    expect(lines[3][3]).toBe('*');
  });

  it('shows other bots as B', () => {
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 3,
      terrain: smallTerrain,
      tileData: {},
      allBots: {
        me: { x: 4, y: 4, alive: true },
        enemy: { x: 5, y: 4, alive: true },
      },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // enemy is 1 tile east of center, so col 4 in row 3
    expect(lines[3][4]).toBe('B');
  });

  it('shows resources as @', () => {
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 3,
      terrain: smallTerrain,
      tileData: { '3,4': { resources: [{ item: 'wood', qty: 2 }] } },
      allBots: { me: { x: 4, y: 4, alive: true } },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // resource is 1 tile west of center, so col 2 in row 3
    expect(lines[3][2]).toBe('@');
  });

  it('does not show dead bots', () => {
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 3,
      terrain: smallTerrain,
      tileData: {},
      allBots: {
        me: { x: 4, y: 4, alive: true },
        dead: { x: 5, y: 4, alive: false },
      },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // dead bot at (5,4) should not show as B
    expect(lines[3][4]).toBe('.');
  });

  it('shows fog (space) for tiles outside visibility', () => {
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 2,
      terrain: smallTerrain,
      tileData: {},
      allBots: { me: { x: 4, y: 4, alive: true } },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // Corners of 5x5 viewport (radius 2) should be fog
    expect(lines[0][0]).toBe(' ');
    expect(lines[0][4]).toBe(' ');
    expect(lines[4][0]).toBe(' ');
    expect(lines[4][4]).toBe(' ');
  });

  it('shows terrain characters', () => {
    // Place a forest tile at (5,4)
    const terrain = '.'.repeat(4 * 8 + 5) + 'T' + '.'.repeat(8 * 8 - 4 * 8 - 6);
    const map = buildAsciiMap({
      botX: 4, botY: 4, radius: 3,
      terrain,
      tileData: {},
      allBots: { me: { x: 4, y: 4, alive: true } },
      botName: 'me',
      width: smallWidth, height: smallHeight,
    });
    const lines = map.split('\n');
    // (5,4) is 1 east of center → col 4 in row 3
    expect(lines[3][4]).toBe('T');
  });
});
