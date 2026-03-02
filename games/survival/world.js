/**
 * Procedural world generation for grid-based survival games.
 *
 * Seeded PRNG (mulberry32) → multi-octave value noise → terrain thresholds.
 * Zero external dependencies.
 */

// --- Seeded PRNG (mulberry32) ---

export function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Value noise with multi-octave ---

function hashGrid(x, y, seed) {
  // Simple integer hash for grid-based noise
  let h = seed;
  h = (h ^ (x * 374761393)) | 0;
  h = (h ^ (y * 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smoothstep interpolation
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);

  const n00 = hashGrid(ix, iy, seed);
  const n10 = hashGrid(ix + 1, iy, seed);
  const n01 = hashGrid(ix, iy + 1, seed);
  const n11 = hashGrid(ix + 1, iy + 1, seed);

  const nx0 = n00 + sx * (n10 - n00);
  const nx1 = n01 + sx * (n11 - n01);
  return nx0 + sy * (nx1 - nx0);
}

function multiOctaveNoise(x, y, seed, octaves = 4, persistence = 0.5) {
  let value = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;

  for (let i = 0; i < octaves; i++) {
    value += smoothNoise(x * frequency, y * frequency, seed + i * 1000) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }

  return value / maxValue;
}

// --- Terrain classification ---

const TERRAIN_CHARS = {
  plains: '.',
  forest: 'T',
  mountain: '^',
  water: '~',
  cave: 'O',
  ruins: '#',
};

function classifyTerrain(elevation, moisture, rng) {
  // Water at very low elevations
  if (elevation < 0.25) return 'water';

  // Mountains at high elevations
  if (elevation > 0.75) {
    // Rare caves in mountains
    if (rng() < 0.08) return 'cave';
    return 'mountain';
  }

  // Mid-range: forest, plains, ruins based on moisture
  if (elevation > 0.55) {
    if (moisture > 0.6) return 'forest';
    if (rng() < 0.03) return 'ruins';
    return 'mountain';
  }

  // Low-mid range
  if (moisture > 0.55) return 'forest';
  if (rng() < 0.02) return 'ruins';
  return 'plains';
}

/**
 * Generate the terrain grid for a world.
 *
 * @param {object} worldConfig - world section of game schema
 * @returns {{ terrain: string, charToType: object }}
 *   terrain: row-major string of terrain chars (width*height)
 *   charToType: map from char to terrain type name
 */
export function generateWorld(worldConfig) {
  const { width, height, seed } = worldConfig;
  const rng = mulberry32(seed);

  // Build char→type lookup from config
  const charToType = {};
  for (const [type, cfg] of Object.entries(worldConfig.terrain)) {
    charToType[cfg.char] = type;
  }

  const chars = [];
  const elevationSeed = seed;
  const moistureSeed = seed + 9999;

  // Scale factor for noise — larger = more zoomed-in features
  const scale = 0.06;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const elevation = multiOctaveNoise(x * scale, y * scale, elevationSeed, 4, 0.5);
      const moisture = multiOctaveNoise(x * scale, y * scale, moistureSeed, 3, 0.6);
      const type = classifyTerrain(elevation, moisture, rng);
      chars.push(TERRAIN_CHARS[type]);
    }
  }

  // Ensure edges have at least some passable tiles (for spawning)
  // Walk perimeter and convert water to plains at random intervals
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const idx = y * width + x;
      if (chars[idx] === '~' && rng() < 0.5) chars[idx] = '.';
    }
  }
  for (let y = 0; y < height; y++) {
    for (const x of [0, width - 1]) {
      const idx = y * width + x;
      if (chars[idx] === '~' && rng() < 0.5) chars[idx] = '.';
    }
  }

  return { terrain: chars.join(''), charToType };
}

/**
 * Place initial resources on the terrain.
 *
 * @param {string} terrain - Row-major terrain string
 * @param {object} worldConfig - world section of game schema
 * @param {Function} rng - Seeded PRNG function
 * @returns {object} tileData: { "x,y": { resources: [{item, qty}], depletedAt: 0 } }
 */
export function placeInitialResources(terrain, worldConfig, rng) {
  const { width, height, resourceSpawns } = worldConfig;
  const charToType = {};
  for (const [type, cfg] of Object.entries(worldConfig.terrain)) {
    charToType[cfg.char] = type;
  }

  const tileData = {};

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const ch = terrain[idx];
      const type = charToType[ch];
      if (!type) continue;

      const spawns = resourceSpawns[type];
      if (!spawns) continue;

      const resources = [];
      for (const spawn of spawns) {
        if (rng() < spawn.chance) {
          resources.push({ item: spawn.item, qty: 1 });
        }
      }

      if (resources.length > 0) {
        tileData[`${x},${y}`] = { resources, depletedAt: 0 };
      }
    }
  }

  return tileData;
}

/**
 * Respawn resources on depleted tiles.
 *
 * @param {object} tileData - Current tile data (mutated in place)
 * @param {string} terrain - Row-major terrain string
 * @param {object} worldConfig - world section of game schema
 * @param {number} currentTick - Current game tick
 * @param {Function} rng - Seeded PRNG function
 * @returns {string[]} List of "x,y" keys that were respawned
 */
export function respawnResources(tileData, terrain, worldConfig, currentTick, rng) {
  const { width, respawnInterval, respawnChance, resourceSpawns } = worldConfig;
  const charToType = {};
  for (const [type, cfg] of Object.entries(worldConfig.terrain)) {
    charToType[cfg.char] = type;
  }

  const respawned = [];

  for (const [key, tile] of Object.entries(tileData)) {
    // Only respawn depleted tiles
    if (tile.depletedAt === 0) continue;
    if (tile.resources && tile.resources.length > 0) continue;

    if (currentTick - tile.depletedAt < respawnInterval) continue;
    if (rng() > respawnChance) continue;

    // Parse coordinates
    const [x, y] = key.split(',').map(Number);
    const idx = y * width + x;
    const ch = terrain[idx];
    const type = charToType[ch];
    if (!type) continue;

    const spawns = resourceSpawns[type];
    if (!spawns) continue;

    const resources = [];
    for (const spawn of spawns) {
      if (rng() < spawn.chance) {
        resources.push({ item: spawn.item, qty: 1 });
      }
    }

    if (resources.length > 0) {
      tile.resources = resources;
      tile.depletedAt = 0;
      respawned.push(key);
    }
  }

  return respawned;
}

/**
 * Get terrain char at a position.
 */
export function getTerrainAt(terrain, x, y, width) {
  if (x < 0 || x >= width || y < 0) return null;
  const idx = y * width + x;
  if (idx >= terrain.length) return null;
  return terrain[idx];
}

/**
 * Get a random passable tile on the grid edge.
 *
 * @param {string} terrain - Row-major terrain string
 * @param {number} width
 * @param {number} height
 * @param {object} terrainConfig - terrain definitions from game schema
 * @param {Function} rng - Seeded PRNG function
 * @returns {{ x: number, y: number }}
 */
export function randomEdgeTile(terrain, width, height, terrainConfig, rng) {
  const charToType = {};
  for (const [type, cfg] of Object.entries(terrainConfig)) {
    charToType[cfg.char] = type;
  }

  // Collect all passable edge tiles
  const edges = [];
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const ch = terrain[y * width + x];
      const type = charToType[ch];
      if (type && terrainConfig[type].moveCost > 0) {
        edges.push({ x, y });
      }
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      const ch = terrain[y * width + x];
      const type = charToType[ch];
      if (type && terrainConfig[type].moveCost > 0) {
        edges.push({ x, y });
      }
    }
  }

  if (edges.length === 0) {
    // Fallback: just pick corner
    return { x: 0, y: 0 };
  }

  return edges[Math.floor(rng() * edges.length)];
}
