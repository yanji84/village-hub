/**
 * Game schema loader — reads a JSON game definition and builds derived
 * lookup maps consumed by logic.js, scene.js, and server.js.
 *
 * Pure function, no side effects — easily testable.
 */

import { readFileSync } from 'node:fs';

/**
 * Load and validate a game schema from a JSON file.
 *
 * @param {string} filePath - Absolute path to the game JSON file
 * @returns {object} gameConfig with raw schema + derived lookup maps
 * @throws {Error} on missing file, invalid JSON, or schema validation failure
 */
export function loadGame(filePath) {
  const raw = JSON.parse(readFileSync(filePath, 'utf-8'));

  const gameType = raw.type || 'social';

  if (gameType === 'grid') {
    validateGrid(raw, filePath);
    return buildGridConfig(raw);
  }

  // Social (default) game type
  validate(raw, filePath);

  const locationSlugs = Object.keys(raw.locations);
  const locationNames = {};
  const locationFlavors = {};
  for (const [slug, loc] of Object.entries(raw.locations)) {
    locationNames[slug] = loc.name;
    locationFlavors[slug] = loc.flavor;
  }

  const phases = Object.keys(raw.phases);
  const phaseDescriptions = {};
  for (const [phase, cfg] of Object.entries(raw.phases)) {
    phaseDescriptions[phase] = cfg.description;
  }

  return {
    raw,
    isGridGame: false,
    locationSlugs,
    locationNames,
    locationFlavors,
    spawnLocation: raw.spawnLocation,
    phases,
    phaseDescriptions,
    timezone: raw.timezone,
    spice: raw.spice,
    spiceConfig: raw.spiceConfig,
    relationships: raw.relationships,
    tools: raw.tools,
    sceneLabels: raw.sceneLabels,
  };
}

/**
 * Build config for grid-based games.
 */
function buildGridConfig(raw) {
  // Build derived lookup maps
  const itemsById = {};
  for (const [id, cfg] of Object.entries(raw.items)) {
    itemsById[id] = { ...cfg, id };
  }

  const charToTerrainType = {};
  for (const [type, cfg] of Object.entries(raw.world.terrain)) {
    charToTerrainType[cfg.char] = type;
  }

  return {
    raw,
    isGridGame: true,
    itemsById,
    charToTerrainType,
    sceneLabels: raw.sceneLabels,
  };
}

/**
 * Validate required fields for grid-based game schemas.
 */
function validateGrid(raw, filePath) {
  const required = ['id', 'world', 'items', 'recipes', 'survival', 'combat', 'dayNight', 'actions', 'sceneLabels'];
  for (const field of required) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`Game schema ${filePath}: missing required field "${field}"`);
    }
  }

  // Validate world
  const world = raw.world;
  if (!world.width || !world.height) {
    throw new Error(`Game schema ${filePath}: world must have width and height`);
  }
  if (!world.terrain || Object.keys(world.terrain).length === 0) {
    throw new Error(`Game schema ${filePath}: world.terrain must have at least one entry`);
  }
  for (const [type, cfg] of Object.entries(world.terrain)) {
    if (cfg.char === undefined) {
      throw new Error(`Game schema ${filePath}: world.terrain.${type} missing "char"`);
    }
    if (cfg.moveCost === undefined) {
      throw new Error(`Game schema ${filePath}: world.terrain.${type} missing "moveCost"`);
    }
  }

  // Validate items
  for (const [id, cfg] of Object.entries(raw.items)) {
    if (!cfg.type) {
      throw new Error(`Game schema ${filePath}: items.${id} missing "type"`);
    }
  }

  // Validate recipes reference valid items
  for (let i = 0; i < raw.recipes.length; i++) {
    const recipe = raw.recipes[i];
    if (!recipe.inputs || !recipe.output) {
      throw new Error(`Game schema ${filePath}: recipes[${i}] missing inputs or output`);
    }
    for (const input of recipe.inputs) {
      if (!raw.items[input]) {
        throw new Error(`Game schema ${filePath}: recipes[${i}] references unknown item "${input}"`);
      }
    }
    if (!raw.items[recipe.output]) {
      throw new Error(`Game schema ${filePath}: recipes[${i}] output "${recipe.output}" is not a valid item`);
    }
  }

  // Validate dayNight
  if (!raw.dayNight.cycleTicks || !raw.dayNight.phases) {
    throw new Error(`Game schema ${filePath}: dayNight must have cycleTicks and phases`);
  }

  // Validate survival
  const survReq = ['hungerPerTick', 'maxHealth', 'maxHunger', 'inventorySlots'];
  for (const field of survReq) {
    if (raw.survival[field] === undefined) {
      throw new Error(`Game schema ${filePath}: survival.${field} is required`);
    }
  }
}

/**
 * Validate required fields and cross-references in the social game schema.
 */
function validate(raw, filePath) {
  const required = ['id', 'locations', 'spawnLocation', 'phases',
    'spice', 'spiceConfig', 'relationships', 'tools', 'sceneLabels'];

  for (const field of required) {
    if (raw[field] === undefined || raw[field] === null) {
      throw new Error(`Game schema ${filePath}: missing required field "${field}"`);
    }
  }

  const locationSlugs = Object.keys(raw.locations);
  if (locationSlugs.length === 0) {
    throw new Error(`Game schema ${filePath}: "locations" must have at least one entry`);
  }

  if (!locationSlugs.includes(raw.spawnLocation)) {
    throw new Error(`Game schema ${filePath}: "spawnLocation" "${raw.spawnLocation}" is not a valid location key`);
  }

  // Validate phases have descriptions
  for (const [phase, cfg] of Object.entries(raw.phases)) {
    if (!cfg.description) {
      throw new Error(`Game schema ${filePath}: phases.${phase} missing "description"`);
    }
  }

}
