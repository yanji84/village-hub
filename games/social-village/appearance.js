/**
 * Appearance generation — derives a unique visual variant for each bot
 * from its name and personality type.
 *
 * Returns { variant: N } where N is 0–11, indexing a row in characters.png.
 * Deterministic: same bot always gets the same variant.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { mulberry32, hashStr } from './utils.js';

const require = createRequire(import.meta.url);
const paths = require('../../../lib/paths');

// --- Personality detection ---

const PERSONALITY_KEYWORDS = {
  efficient: [
    'efficient', 'practical', 'organized', 'precise', 'productive',
    '实用', '高效', '务实', '精准', '条理',
  ],
  witty: [
    'witty', 'humorous', 'playful', 'sarcastic', 'funny', 'joke',
    '幽默', '搞笑', '损友', '调侃', '玩笑',
  ],
  caring: [
    'caring', 'warm', 'gentle', 'empathetic', 'kind', 'nurturing',
    '温柔', '治愈', '关心', '温暖', '善良',
  ],
};

/**
 * Detect personality type from workspace files.
 * Fast path: read personality.txt marker. Fallback: keyword scan of SOUL.md.
 *
 * @param {string} botName
 * @returns {Promise<string>} 'efficient' | 'witty' | 'caring'
 */
async function detectPersonality(botName) {
  // Fast path: personality.txt marker (written at onboard time)
  try {
    const marker = await readFile(paths.personalityMarker(botName), 'utf-8');
    const id = marker.trim().toLowerCase();
    if (id === 'efficient' || id === 'witty' || id === 'caring') return id;
  } catch { /* no marker, fall through */ }

  // Fallback: keyword scan of SOUL.md
  try {
    const soul = await readFile(paths.workspaceFile(botName, 'SOUL.md'), 'utf-8');
    const lower = soul.toLowerCase();
    const scores = { efficient: 0, witty: 0, caring: 0 };
    for (const [type, keywords] of Object.entries(PERSONALITY_KEYWORDS)) {
      for (const kw of keywords) {
        if (lower.includes(kw)) scores[type]++;
      }
    }
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (best[0][1] > 0) return best[0][0];
  } catch { /* no SOUL.md */ }

  // Default based on name hash
  const types = ['efficient', 'witty', 'caring'];
  return types[Math.abs(hashStr(botName)) % types.length];
}

// --- Variant mapping ---

const VARIANT_COUNT = 12;
const PERSONALITY_RANGES = {
  efficient: [0, 3],
  witty:     [4, 7],
  caring:    [8, 11],
};

/**
 * Generate appearance config for a bot.
 *
 * @param {string} botName - System name of the bot
 * @param {string} [occupation] - Kept for API compat (ignored)
 * @returns {Promise<object>} { variant: 0–11 }
 */
export async function generateAppearance(botName, occupation) {
  const personality = await detectPersonality(botName);
  const range = PERSONALITY_RANGES[personality];
  const rng = mulberry32(hashStr(botName));
  const variant = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
  return { variant };
}
