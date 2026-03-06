/**
 * Appearance generation — derives a unique visual config for each bot
 * from its name, personality type, and occupation.
 *
 * Appearance configs are deterministic: same bot always gets the same look.
 * The observer uses these to composite layered gray-scale sprite parts with
 * per-attribute color tinting (same pattern as buildings in TILE_ART_SPEC.md).
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../../lib/paths');

// --- Seeded PRNG (same mulberry32 used elsewhere in the codebase) ---

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

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

// --- Color palettes by personality ---

const PALETTES = {
  efficient: {
    hairColors: ['#2a2a3a', '#3a3a4a', '#4a4a5a', '#1a1a2a', '#5a5a6a', '#3a4a5a'],
    topColors: ['#4a6a8a', '#5a7a9a', '#3a5a7a', '#6a8aaa', '#7a8a9a'],
    bottomColors: ['#2a2a3a', '#3a3a4a', '#3a4a5a', '#4a4a5a'],
    shoeColors: ['#3a3a3a', '#4a4a4a', '#2a2a2a'],
    hairRange: [0, 2],   // conservative styles
    expression: 'serious',
  },
  witty: {
    hairColors: ['#8a3020', '#aa4030', '#6a2a4a', '#ba5030', '#9a3050', '#4a3060'],
    topColors: ['#e74c3c', '#e67e22', '#9b59b6', '#e91e63', '#ff5722'],
    bottomColors: ['#3a3a5c', '#4a2a4a', '#2a3a5a', '#5a3a4a'],
    shoeColors: ['#4a3728', '#5a2a2a', '#3a2a3a'],
    hairRange: [2, 5],   // wild styles
    expression: 'smirk',
  },
  caring: {
    hairColors: ['#4a3020', '#5a4030', '#3a2a1a', '#6a5040', '#7a6050', '#2a1a0a'],
    topColors: ['#2ecc71', '#1abc9c', '#3498db', '#27ae60', '#48c9b0'],
    bottomColors: ['#3a4a3a', '#2a3a3a', '#4a5a4a', '#3a3a4a'],
    shoeColors: ['#4a3728', '#5a4a3a', '#3a2a1a'],
    hairRange: [0, 3],   // soft styles
    expression: 'gentle',
  },
};

const SKIN_TONES = [
  '#fce4c8', // 0 light
  '#f0c8a0', // 1
  '#d8a878', // 2
  '#c09060', // 3
  '#8a6a48', // 4
  '#5a4030', // 5 dark
];

// --- Occupation modifiers ---

const OCCUPATION_MODIFIERS = {
  chef:      { topStyle: 4 },   // apron
  cook:      { topStyle: 4 },
  baker:     { topStyle: 4 },
  barista:   { topStyle: 4 },
  scholar:   { accessory: { style: 0 } },  // glasses
  teacher:   { accessory: { style: 0 } },
  librarian: { accessory: { style: 0 } },
  professor: { accessory: { style: 0 } },
  artist:    { accessory: { style: 4 } },  // flower
  florist:   { accessory: { style: 4 } },
  guard:     { topStyle: 3 },   // jacket
  mayor:     { topStyle: 3, accessory: { style: 1 } }, // jacket + hat
  merchant:  { topStyle: 2 },   // vest
  musician:  { accessory: { style: 3 } },  // bowtie
};

/**
 * Generate a complete appearance config for a bot.
 *
 * @param {string} botName - System name of the bot
 * @param {string} [occupation] - Current occupation title (optional)
 * @returns {Promise<object>} Appearance config
 */
export async function generateAppearance(botName, occupation) {
  const personality = await detectPersonality(botName);
  const palette = PALETTES[personality];
  const rng = mulberry32(hashStr(botName));

  // Helper: pick from array using PRNG
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const pickRange = (min, max) => min + Math.floor(rng() * (max - min + 1));

  const appearance = {
    bodyType: Math.floor(rng() * 3),                           // 0-2
    skinTone: Math.floor(rng() * SKIN_TONES.length),           // 0-5
    hairStyle: pickRange(palette.hairRange[0], palette.hairRange[1]),  // personality-biased
    hairColor: pick(palette.hairColors),
    eyeStyle: Math.floor(rng() * 4),                           // 0-3
    topStyle: Math.floor(rng() * 5),                           // 0-4
    topColor: pick(palette.topColors),
    bottomStyle: Math.floor(rng() * 3),                        // 0-2
    bottomColor: pick(palette.bottomColors),
    shoeStyle: Math.floor(rng() * 3),                          // 0-2
    shoeColor: pick(palette.shoeColors),
    accessory: null,
    expression: palette.expression,
  };

  // Apply occupation modifiers (if matching)
  if (occupation) {
    const lower = occupation.toLowerCase();
    for (const [keyword, mods] of Object.entries(OCCUPATION_MODIFIERS)) {
      if (lower.includes(keyword)) {
        if (mods.topStyle !== undefined) appearance.topStyle = mods.topStyle;
        if (mods.accessory) {
          appearance.accessory = {
            style: mods.accessory.style,
            color: appearance.topColor, // match top color
          };
        }
        break;
      }
    }
  }

  return appearance;
}
