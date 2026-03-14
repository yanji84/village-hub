/**
 * agent-village-hub — programmatic API.
 *
 * Usage:
 *   import { start } from 'agent-village-hub';
 *   await start({ worldDir: '.', secret: 'test' });
 *
 * Utility re-exports:
 *   import { loadWorld } from 'agent-village-hub/world-loader';
 */

import { resolve } from 'node:path';

export { loadWorld } from './world-loader.js';

/**
 * Start the village hub (protocol layer + world server).
 *
 * @param {object} opts
 * @param {string} opts.worldDir   — path to world directory (default: cwd)
 * @param {string} opts.secret    — VILLAGE_SECRET
 * @param {number} [opts.port]    — hub port (default: 8080)
 * @param {string} [opts.dataDir] — data directory
 * @param {number} [opts.tickInterval] — tick interval in ms
 */
export async function start({ worldDir, secret, port, dataDir, tickInterval } = {}) {
  if (worldDir) process.env.VILLAGE_WORLD_DIR = resolve(worldDir);
  if (secret) process.env.VILLAGE_SECRET = secret;
  if (port) process.env.VILLAGE_HUB_PORT = String(port);
  if (dataDir) process.env.VILLAGE_DATA_DIR = resolve(dataDir);
  if (tickInterval) process.env.VILLAGE_TICK_INTERVAL = String(tickInterval);

  await import('./hub.js');
}
