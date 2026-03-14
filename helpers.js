/**
 * Village Hub — helpers for world adapters.
 *
 * Import from 'village-hub/helpers.js' in your adapter or scene builder.
 */

/**
 * Append a log entry with tick and timestamp stamped automatically.
 *
 * Every world needs to push events to state.log with tick/timestamp metadata.
 * This helper eliminates that boilerplate.
 *
 * @param {object} state  - The world state (must have state.clock.tick)
 * @param {object} fields - The log entry fields (action, message, visibility, etc.)
 *
 * @example
 * import { logAction } from 'village-hub/helpers.js';
 *
 * logAction(state, {
 *   bot: botName, displayName, action: 'join',
 *   message: `${displayName} joined.`, visibility: 'public',
 * });
 */
export function logAction(state, fields) {
  state.log.push({
    ...fields,
    tick: state.clock.tick,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Per-bot scene privacy helper.
 *
 * Returns `content` only when `viewingBot` matches `ownerBot`, otherwise
 * returns `fallback`. Use this in scene builders to show private information
 * (e.g. hole cards, secret roles, private inventory) only to the bot that
 * owns it.
 *
 * @param {string} viewingBot  - The bot the scene is being built for (bot.name)
 * @param {string} ownerBot    - The bot who owns the private data
 * @param {string} content     - The private content to show
 * @param {string} [fallback]  - What to show to other bots (default: '')
 * @returns {string}
 *
 * @example
 * // In a scene builder:
 * import { privateFor } from 'village-hub/helpers.js';
 *
 * function buildScene(bot, ctx) {
 *   const lines = [];
 *   for (const player of state.players) {
 *     // Only show hole cards to the player who holds them
 *     lines.push(`${player.name}: ${privateFor(bot.name, player.name, player.cards, '🂠 🂠')}`);
 *   }
 *   return lines.join('\n');
 * }
 */
export function privateFor(viewingBot, ownerBot, content, fallback = '') {
  return viewingBot === ownerBot ? content : fallback;
}

/**
 * Build a section that only appears for a specific bot.
 *
 * Similar to privateFor but designed for multi-line scene sections
 * rather than inline substitutions.
 *
 * @param {string} viewingBot  - The bot the scene is being built for
 * @param {string} ownerBot    - The bot who should see this section
 * @param {function} buildFn   - Function that returns the section content (called only if visible)
 * @returns {string}
 *
 * @example
 * lines.push(privateSection(bot.name, activePlayer, () => {
 *   return `### Your Turn\nCurrent bet: ${currentBet}\nOptions: call, raise, fold`;
 * }));
 */
export function privateSection(viewingBot, ownerBot, buildFn) {
  return viewingBot === ownerBot ? buildFn() : '';
}
