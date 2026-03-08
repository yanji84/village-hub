/**
 * Extracted game logic — pure/testable functions from the village orchestrator.
 *
 * These functions operate on state objects passed as arguments rather than
 * module-level closures, making them independently testable.
 *
 * Game content (events, spice, emotions, locations, etc.) is loaded from a
 * game schema JSON via game-loader.js and passed as `gameConfig`.
 */

import { ACTION_HANDLERS } from './action-handlers.js';

// Re-export governance functions for backwards compatibility
export { ensureGovernance, resolveExpiredProposal, expireMayor, enforceExiles, checkViolations } from './governance.js';

/**
 * Roll a random village event for a location.
 *
 * @param {number} tick - Current tick
 * @param {string} location - Location slug
 * @param {object} eventState - Per-location event tracking (mutated)
 * @param {object} gameConfig - Loaded game configuration
 * @returns {string|null} Event text, or null
 */
export function rollVillageEvent(tick, location, eventState, gameConfig) {
  const { events, eventConfig } = gameConfig;

  if (!eventState[location]) {
    eventState[location] = { lastEventTick: -Infinity, lastCategory: null, recentEvents: [] };
  }
  const ls = eventState[location];

  // Cooldown between events at same location
  if (tick - ls.lastEventTick < eventConfig.cooldownTicks) return null;

  // Random chance per tick
  if (Math.random() > eventConfig.chance) return null;

  // Filter eligible events (location match, no same category twice in a row, no recent repeats)
  const eligible = events.filter(e => {
    if (e.locations && !e.locations.includes(location)) return false;
    if (e.category === ls.lastCategory) return false;
    if (ls.recentEvents.includes(e.text)) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  const event = eligible[Math.floor(Math.random() * eligible.length)];
  ls.lastEventTick = tick;
  ls.lastCategory = event.category;
  ls.recentEvents.push(event.text);
  if (ls.recentEvents.length > eventConfig.recentCap) ls.recentEvents.shift();

  return event.text;
}

/**
 * Process actions from a bot's response and update state.
 *
 * @param {string} botName - Bot that performed the actions
 * @param {Array} actions - Array of { tool, params }
 * @param {string} location - Bot's current location
 * @param {object} state - Mutable state object (locations, publicLogs, whispers)
 * @param {object} [opts] - Optional: { lastMoveTick: Map, tick: number, validLocations: string[] }
 * @returns {Array} Events generated
 */
export function processActions(botName, actions, location, state, opts = {}) {
  const events = [];
  const { lastMoveTick, tick, validLocations = [], gameConfig } = opts;

  // Move cooldown: reject move if bot moved last tick
  const onCooldown = lastMoveTick && tick != null
    && (lastMoveTick.get(botName) || 0) >= tick - 1;

  // Free actions — always processed, even during move
  const FREE_ACTIONS = new Set([
    'village_memory_search', 'village_meditate',
  ]);

  // Location tool filtering — server-side enforcement
  const locationToolIds = gameConfig ? new Set(
    gameConfig.locationTools[location] ||
    state.customLocations?.[location]?.tools ||
    gameConfig.defaultLocationTools
  ) : null;

  // Check if bot wants to move — if so, move is exclusive (skip other non-free actions)
  const hasMove = actions.some(a =>
    a.tool === 'village_move' && a.params?.location
    && validLocations.includes(a.params.location) && a.params.location !== location
  );
  const moveExclusive = hasMove && !onCooldown;

  for (const action of actions) {
    if (moveExclusive && action.tool !== 'village_move' && !FREE_ACTIONS.has(action.tool)) continue;

    // Server-side location tool enforcement (free actions bypass)
    if (locationToolIds && !FREE_ACTIONS.has(action.tool) && !locationToolIds.has(action.tool)) continue;

    const handler = ACTION_HANDLERS.get(action.tool);
    if (!handler) continue;

    const ev = handler({
      botName, params: action.params, location, state,
      tick, validLocations, lastMoveTick, onCooldown,
    });
    if (ev) events.push(ev);
  }

  return events;
}

/**
 * Advance the game clock by one tick.
 *
 * @param {object} clock - { tick, phase, ticksInPhase }
 * @param {number} ticksPerPhase - Ticks before phase advances
 * @param {string[]} phases - Ordered phase names from game schema
 * @returns {object} Updated clock
 */
export function advanceClock(clock, ticksPerPhase, phases) {
  clock.tick++;
  clock.ticksInPhase++;

  if (clock.ticksInPhase >= ticksPerPhase) {
    clock.ticksInPhase = 0;
    const idx = phases.indexOf(clock.phase);
    clock.phase = phases[(idx + 1) % phases.length];
  }

  return clock;
}

/**
 * Enforce public log depth limit per location.
 *
 * @param {object} publicLogs - location → entries[]
 * @param {number} maxDepth - Max entries per location
 */
export function enforceLogDepth(publicLogs, maxDepth) {
  for (const loc of Object.keys(publicLogs)) {
    if (publicLogs[loc].length > maxDepth) {
      publicLogs[loc] = publicLogs[loc].slice(-maxDepth);
    }
  }
}

/**
 * Compute conversation quality metrics for a location's public log.
 *
 * @param {Array} log - Public log entries
 * @returns {{ messages: number, wordEntropy: number, topicDiversity: number } | null}
 */
export function computeQualityMetrics(log) {
  if (!log || log.length === 0) return null;

  const messages = log.filter(e => e.action === 'say').map(e => e.message || '');
  if (messages.length === 0) return null;

  // Word-level entropy: unique word ratio
  const allWords = messages.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  const uniqueWords = new Set(allWords);
  const wordEntropy = allWords.length > 0 ? uniqueWords.size / allWords.length : 0;

  // Topic diversity: unique first-words as rough topic proxy
  const topicWords = messages.map(m => m.split(/\s+/)[0]?.toLowerCase()).filter(Boolean);
  const topicDiversity = new Set(topicWords).size;

  return { messages: messages.length, wordEntropy, topicDiversity };
}

/**
 * Check if a bot should be skipped due to cost cap.
 *
 * @param {number} botCost - Bot's current daily cost
 * @param {number} dailyCostCap - Cap (0 = disabled)
 * @returns {boolean} True if bot should be skipped
 */
export function shouldSkipForCost(botCost, dailyCostCap) {
  if (dailyCostCap <= 0) return false;
  return botCost >= dailyCostCap;
}

/**
 * Handle new bots joining: place at spawn location.
 *
 * @param {Set<string>} participantNames - Currently active bot names
 * @param {object} state - State with locations
 * @returns {string[]} Names of newly joined bots
 */
export function findNewBots(participantNames, state) {
  const allInLocations = new Set();
  for (const bots of Object.values(state.locations)) {
    for (const b of bots) allInLocations.add(b);
  }

  const newBots = [];
  for (const name of participantNames) {
    if (!allInLocations.has(name)) {
      newBots.push(name);
    }
  }
  return newBots;
}

/**
 * Find bots that left (no longer in participants).
 *
 * @param {Set<string>} participantNames - Currently active bot names
 * @param {object} state - State with locations
 * @param {string[]} locationSlugs - All valid location slugs
 * @returns {Array<{ name: string, location: string }>} Departed bots
 */
export function findDepartedBots(participantNames, state, locationSlugs) {
  const departed = [];
  for (const loc of locationSlugs) {
    for (const name of (state.locations[loc] || [])) {
      if (!participantNames.has(name)) {
        departed.push({ name, location: loc });
      }
    }
  }
  return departed;
}

/**
 * Read a bot's daily cost from usage.json.
 *
 * @param {string} botName
 * @param {string} usageFilePath - Path to usage.json
 * @param {function} readFileFn - Async file reader (for testability)
 * @returns {Promise<number>} Daily cost in dollars
 */
export async function readBotDailyCost(botName, usageFilePath, readFileFn) {
  try {
    const raw = await readFileFn(usageFilePath, 'utf-8');
    const usage = JSON.parse(raw);
    const botUsage = usage[botName];
    if (!botUsage) return 0;

    const today = new Date().toISOString().slice(0, 10);
    const lastUpdated = botUsage.lastUpdated || '';
    if (!lastUpdated.startsWith(today)) return 0;

    return botUsage.dailyCost || 0;
  } catch {
    return 0;
  }
}

/**
 * Validate observer auth from request cookies against admin tokens.
 *
 * @param {string} cookieHeader - Raw Cookie header string
 * @param {object} tokens - Parsed admin-tokens.json
 * @returns {string|null} Authenticated bot name, or null
 */
export function validateObserverAuth(cookieHeader, tokens) {
  if (!cookieHeader || !tokens) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
  );

  for (const [key, value] of Object.entries(cookies)) {
    if (!key.startsWith('as_')) continue;
    const botName = key.slice(3);
    const botTokens = tokens[botName];
    if (!botTokens) continue;

    if (botTokens.session === value && botTokens.sessionExpiresAt > Date.now()) {
      return botName;
    }
  }

  return null;
}

