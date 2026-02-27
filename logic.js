/**
 * Extracted game logic — pure/testable functions from the village orchestrator.
 *
 * These functions operate on state objects passed as arguments rather than
 * module-level closures, making them independently testable.
 */

import { ALL_LOCATIONS } from './scene.js';

const PHASES = ['morning', 'afternoon', 'evening'];
const MAX_WHISPERS_PER_BOT = 20;

/**
 * Process actions from a bot's response and update state.
 *
 * @param {string} botName - Bot that performed the actions
 * @param {Array} actions - Array of { tool, params }
 * @param {string} location - Bot's current location
 * @param {object} state - Mutable state object (locations, publicLogs, whispers)
 * @returns {Array} Events generated
 */
export function processActions(botName, actions, location, state) {
  const events = [];

  for (const action of actions) {
    switch (action.tool) {
      case 'village_say': {
        const msg = action.params?.message || '';
        if (!msg) break;
        const entry = { bot: botName, action: 'say', message: msg };
        state.publicLogs[location].push(entry);
        events.push(entry);
        break;
      }
      case 'village_whisper': {
        const target = action.params?.bot_id;
        const msg = action.params?.message || '';
        if (!target || !msg) break;
        // Validate: target must be at same location
        if (!state.locations[location]?.includes(target)) {
          break;
        }
        // Queue whisper for next tick (capped to prevent unbounded growth)
        if (!state.whispers[target]) state.whispers[target] = [];
        if (state.whispers[target].length >= MAX_WHISPERS_PER_BOT) {
          break;
        }
        state.whispers[target].push({ from: botName, message: msg });
        events.push({ bot: botName, action: 'whisper', target, message: msg });
        break;
      }
      case 'village_observe': {
        events.push({ bot: botName, action: 'observe' });
        break;
      }
      case 'village_move': {
        const dest = action.params?.location;
        if (!dest || !ALL_LOCATIONS.includes(dest) || dest === location) {
          break;
        }
        // Remove from current location
        state.locations[location] = state.locations[location].filter(b => b !== botName);
        // Add to new location
        if (!state.locations[dest]) state.locations[dest] = [];
        state.locations[dest].push(botName);
        events.push({ bot: botName, action: 'move', from: location, to: dest });
        break;
      }
    }
  }

  return events;
}

/**
 * Advance the game clock by one tick.
 *
 * @param {object} clock - { tick, phase, ticksInPhase }
 * @param {number} ticksPerPhase - Ticks before phase advances
 * @returns {object} Updated clock
 */
export function advanceClock(clock, ticksPerPhase) {
  clock.tick++;
  clock.ticksInPhase++;

  if (clock.ticksInPhase >= ticksPerPhase) {
    clock.ticksInPhase = 0;
    const idx = PHASES.indexOf(clock.phase);
    clock.phase = PHASES[(idx + 1) % PHASES.length];
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
 * Handle new bots joining: place at central-square.
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
 * @returns {Array<{ name: string, location: string }>} Departed bots
 */
export function findDepartedBots(participantNames, state) {
  const departed = [];
  for (const loc of ALL_LOCATIONS) {
    for (const name of (state.locations[loc] || [])) {
      if (!participantNames.has(name)) {
        departed.push({ name, location: loc });
      }
    }
  }
  return departed;
}

export { PHASES };
