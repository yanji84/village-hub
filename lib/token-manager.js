/**
 * Village token manager (ESM) — locked read-modify-write for village-tokens.json.
 *
 * Used by village-hub standalone deployment. Stores vtk_ tokens mapping remote
 * bots to their identities.
 *
 * File location: $VILLAGE_DATA_DIR/village-tokens.json
 * (default: village/data/village-tokens.json for local dev)
 */

import { readFile, writeFile, access, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const lockfile = require('proper-lockfile');

const DATA_DIR = process.env.VILLAGE_DATA_DIR || join(__dirname, '..', 'data');
export const TOKENS_FILE = join(DATA_DIR, 'village-tokens.json');

const LOCK_OPTIONS = {
  retries: { retries: 5, factor: 2, minTimeout: 100, maxTimeout: 2000 },
  stale: 10000,
};

// Short-lived read cache — avoids a disk read on every authenticated request.
// Invalidated immediately on any write (generate/revoke/update).
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL = 5_000;

function _invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

/**
 * Read village-tokens.json without locking. Returns {} on error.
 * Cached for CACHE_TTL ms; invalidated on any write.
 */
export async function read() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL) return _cache;
  try {
    _cache = JSON.parse(await readFile(TOKENS_FILE, 'utf8'));
    _cacheAt = now;
    return _cache;
  } catch {
    return {};
  }
}

/**
 * Locked read-modify-write of village-tokens.json.
 * @param {(data: object) => object|void} mutator
 * @returns {object} the written data
 */
export async function update(mutator) {
  // Ensure data dir and file exist before locking
  await mkdir(DATA_DIR, { recursive: true });
  try {
    await access(TOKENS_FILE);
  } catch {
    await writeFile(TOKENS_FILE, '{}\n', { mode: 0o600 });
  }

  const release = await lockfile.lock(TOKENS_FILE, LOCK_OPTIONS);
  try {
    let data;
    try {
      data = JSON.parse(await readFile(TOKENS_FILE, 'utf8'));
    } catch {
      data = {};
    }
    const result = mutator(data);
    const toWrite = result !== undefined ? result : data;
    await writeFile(TOKENS_FILE, JSON.stringify(toWrite, null, 2) + '\n', { mode: 0o600 });
    _invalidateCache();
    return toWrite;
  } finally {
    await release();
  }
}

/**
 * Generate a new vtk_ token for a bot.
 * @param {string} botName
 * @param {string} [displayName]
 * @returns {string} the new token
 */
export async function generate(botName, displayName) {
  const token = 'vtk_' + randomBytes(20).toString('hex');
  await update((tokens) => {
    tokens[token] = {
      botName,
      displayName: displayName || botName,
      createdAt: new Date().toISOString(),
    };
  });
  return token;
}

/**
 * Revoke all tokens for a bot.
 * @param {string} botName
 */
export async function revoke(botName) {
  await update((tokens) => {
    for (const [tk, entry] of Object.entries(tokens)) {
      if (entry.botName === botName) delete tokens[tk];
    }
  });
}
