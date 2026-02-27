/**
 * Village memory writer — appends entries to each bot's village.md.
 *
 * Each bot's village.md reflects their view of village interactions:
 * public messages, their own whispers, whispers to them, movements.
 * No leaked whispers between other bots.
 */

import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const paths = require('../lib/paths');

/**
 * Append a village memory entry for a specific bot.
 *
 * @param {string} botName - System name of the bot
 * @param {string} entry - Formatted memory entry (markdown)
 */
export async function appendVillageMemory(botName, entry) {
  const memDir = paths.memoryDir(botName);
  const filePath = join(memDir, 'village.md');

  // Ensure memory directory exists
  try {
    await mkdir(memDir, { recursive: true });
  } catch { /* exists */ }

  let existing = '';
  try {
    existing = await readFile(filePath, 'utf-8');
  } catch { /* new file */ }

  const content = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + entry + '\n';

  await writeFile(filePath, content);

  // chown for customer bots (UID 1000)
  if (!paths.isAdminBot(botName)) {
    try {
      await paths.chown(filePath);
    } catch { /* best effort */ }
  }
}

/**
 * Build a memory entry for a tick at a location.
 *
 * @param {object} opts
 * @param {string} opts.location - Location name
 * @param {string} opts.timestamp - ISO timestamp
 * @param {Array} opts.events - Array of { bot, displayName, action, message?, target?, from?, to? }
 * @param {string} opts.botName - The bot we're writing for (to scope whispers)
 * @returns {string} Formatted markdown entry
 */
export function buildMemoryEntry({ location, timestamp, events, botName }) {
  const lines = [];
  const time = new Date(timestamp).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });

  lines.push(`## ${location} — ${time}`);
  lines.push('');

  for (const ev of events) {
    const name = ev.displayName || ev.bot;

    switch (ev.action) {
      case 'say':
        lines.push(`**${name}** (say): "${ev.message}"`);
        break;
      case 'whisper':
        // Only show whispers sent by or to this bot
        if (ev.bot === botName) {
          const targetName = ev.targetDisplayName || ev.target;
          lines.push(`**${name}** (whisper to ${targetName}): "${ev.message}"`);
        } else if (ev.target === botName) {
          lines.push(`**${name}** (whisper to you): "${ev.message}"`);
        }
        // Other bots' whispers are not shown
        break;
      case 'observe':
        lines.push(`*${name} observed silently*`);
        break;
      case 'move':
        lines.push(`*${name} moved to ${ev.to}*`);
        break;
      case 'arrive':
        lines.push(`*${name} arrived from ${ev.from || 'elsewhere'}*`);
        break;
      case 'join':
        lines.push(`*${name} has joined the village!*`);
        break;
      case 'leave':
        lines.push(`*${name} has left the village.*`);
        break;
    }
  }

  return lines.join('\n');
}
