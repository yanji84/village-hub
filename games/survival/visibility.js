/**
 * Fog of war and ASCII map rendering for grid-based survival games.
 *
 * Computes visibility radius based on day/night phase, terrain, and equipment.
 * Renders a small ASCII viewport centered on the bot.
 */

/**
 * Compute visibility radius for a bot.
 *
 * @param {object} botState - { x, y, equipment }
 * @param {string} terrain - Row-major terrain string
 * @param {object} dayNightPhase - { visibilityBase }
 * @param {object} gameConfig - Full game config
 * @returns {number} Visibility radius in tiles
 */
export function computeVisibility(botState, terrain, dayNightPhase, gameConfig) {
  const { width } = gameConfig.raw.world;
  const idx = botState.y * width + botState.x;
  const ch = terrain[idx];

  // Find terrain type for visibility modifier
  let visibilityMod = 0;
  for (const [, cfg] of Object.entries(gameConfig.raw.world.terrain)) {
    if (cfg.char === ch) {
      visibilityMod = cfg.visibilityMod;
      break;
    }
  }

  const base = dayNightPhase.visibilityBase || 5;
  let radius = base + visibilityMod;

  // Equipment bonus (e.g., tools could grant visibility in future)
  // Currently no items grant visibility, but the hook is here

  return Math.max(2, Math.min(radius, 15));
}

/**
 * Get all visible tile coordinates within radius.
 *
 * @param {number} x - Bot x position
 * @param {number} y - Bot y position
 * @param {number} radius - Visibility radius
 * @param {number} width - World width
 * @param {number} height - World height
 * @returns {Set<string>} Set of "x,y" strings
 */
export function getVisibleTiles(x, y, radius, width, height) {
  const visible = new Set();
  const r2 = radius * radius;

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const tx = x + dx;
      const ty = y + dy;
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;
      visible.add(`${tx},${ty}`);
    }
  }

  return visible;
}

/**
 * Build an ASCII map viewport centered on a bot.
 *
 * @param {object} opts
 * @param {number} opts.botX - Bot x position
 * @param {number} opts.botY - Bot y position
 * @param {number} opts.radius - Visibility radius
 * @param {string} opts.terrain - Row-major terrain string
 * @param {object} opts.tileData - { "x,y": { resources: [...] } }
 * @param {object} opts.allBots - { botName: { x, y, alive } }
 * @param {string} opts.botName - This bot's name
 * @param {number} opts.width - World width
 * @param {number} opts.height - World height
 * @returns {string} ASCII map string with legend
 */
export function buildAsciiMap({ botX, botY, radius, terrain, tileData, allBots, botName, width, height }) {
  const visible = getVisibleTiles(botX, botY, radius, width, height);

  // Build bot position lookup
  const botPositions = new Map(); // "x,y" → botName
  for (const [name, bs] of Object.entries(allBots)) {
    if (name === botName) continue;
    if (!bs.alive) continue;
    const key = `${bs.x},${bs.y}`;
    if (visible.has(key)) {
      botPositions.set(key, name);
    }
  }

  // Build resource position lookup
  const resourcePositions = new Set();
  for (const [key, tile] of Object.entries(tileData)) {
    if (tile.resources && tile.resources.length > 0 && visible.has(key)) {
      resourcePositions.add(key);
    }
  }

  const lines = [];
  const mapRadius = Math.min(radius, 10); // Cap viewport size for readability

  for (let dy = -mapRadius; dy <= mapRadius; dy++) {
    let row = '';
    for (let dx = -mapRadius; dx <= mapRadius; dx++) {
      const tx = botX + dx;
      const ty = botY + dy;
      const key = `${tx},${ty}`;

      if (tx === botX && ty === botY) {
        row += '*';
        continue;
      }

      if (!visible.has(key)) {
        row += ' ';
        continue;
      }

      if (botPositions.has(key)) {
        row += 'B';
        continue;
      }

      if (resourcePositions.has(key)) {
        row += '@';
        continue;
      }

      // Terrain
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
        row += ' ';
        continue;
      }

      const idx = ty * width + tx;
      row += terrain[idx] || ' ';
    }
    lines.push(row);
  }

  return lines.join('\n');
}
