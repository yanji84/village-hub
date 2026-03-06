/**
 * Extracted game logic — pure/testable functions from the village orchestrator.
 *
 * These functions operate on state objects passed as arguments rather than
 * module-level closures, making them independently testable.
 *
 * Game content (events, spice, emotions, locations, etc.) is loaded from a
 * game schema JSON via game-loader.js and passed as `gameConfig`.
 */

import { pairKey } from './relationship-engine.js';

const MAX_WHISPERS_PER_BOT = 20;
const MAX_DECORATIONS_PER_LOCATION = 10;
const MAX_MESSAGES_PER_LOCATION = 20;
const MAX_CUSTOM_LOCATIONS = 10;
const EXPLORE_COOLDOWN_TICKS = 3;
const BUILD_WINDOW_TICKS = 5;

// --- Shared helpers ---

/**
 * Ensure locationState exists for a given location, return it.
 */
function ensureLocationState(state, location) {
  if (!state.locationState) state.locationState = {};
  if (!state.locationState[location]) state.locationState[location] = { decorations: [], messages: [] };
  return state.locationState[location];
}

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
 * Roll a conversation spice prompt for a location.
 *
 * @param {number} tick - Current tick
 * @param {string} location - Location slug
 * @param {number} botCount - Number of bots at this location
 * @param {object} spiceState - Per-location spice tracking (mutated)
 * @param {object} gameConfig - Loaded game configuration
 * @returns {string|null} Spice text, or null
 */
export function rollConversationSpice(tick, location, botCount, spiceState, gameConfig) {
  const { spice, spiceConfig } = gameConfig;

  if (botCount < spiceConfig.minBots) return null;

  if (!spiceState[location]) {
    spiceState[location] = { lastSpiceTick: -Infinity, recentSpice: [] };
  }
  const ss = spiceState[location];

  // Cooldown
  if (tick - ss.lastSpiceTick < spiceConfig.cooldownTicks) return null;

  // Random chance per tick
  if (Math.random() > spiceConfig.chance) return null;

  const eligible = spice.filter(s => !ss.recentSpice.includes(s));
  if (eligible.length === 0) return null;

  const picked = eligible[Math.floor(Math.random() * eligible.length)];
  ss.lastSpiceTick = tick;
  ss.recentSpice.push(picked);
  if (ss.recentSpice.length > spiceConfig.recentCap) ss.recentSpice.shift();

  return picked;
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
  const { lastMoveTick, tick, validLocations = [] } = opts;

  // Move cooldown: reject move if bot moved last tick
  const onCooldown = lastMoveTick && tick != null
    && (lastMoveTick.get(botName) || 0) >= tick - 1;

  // Check if bot wants to move — if so, move is exclusive (skip all other actions)
  const hasMove = actions.some(a =>
    a.tool === 'village_move' && a.params?.location
    && validLocations.includes(a.params.location) && a.params.location !== location
  );
  const moveExclusive = hasMove && !onCooldown;

  for (const action of actions) {
    // If moving this tick, skip non-move actions
    if (moveExclusive && action.tool !== 'village_move') continue;

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
        if (onCooldown) break; // enforce cooldown
        const dest = action.params?.location;
        // Accept both schema locations and custom locations
        const allValid = [...validLocations, ...Object.keys(state.customLocations || {})];
        if (!dest || !allValid.includes(dest) || dest === location) {
          break;
        }
        // Remove from current location
        state.locations[location] = state.locations[location].filter(b => b !== botName);
        // Add to new location
        if (!state.locations[dest]) state.locations[dest] = [];
        state.locations[dest].push(botName);
        events.push({ bot: botName, action: 'move', from: location, to: dest });
        // Record move tick for cooldown
        if (lastMoveTick) lastMoveTick.set(botName, tick);
        break;
      }

      // --- World-building actions ---

      case 'village_decorate': {
        const desc = (action.params?.description || '').slice(0, 200);
        if (!desc) break;
        const ls = ensureLocationState(state, location);
        ls.decorations.push({ bot: botName, text: desc, tick });
        if (ls.decorations.length > MAX_DECORATIONS_PER_LOCATION) ls.decorations.shift();
        events.push({ bot: botName, action: 'decorate', decoration: desc });
        break;
      }

      case 'village_leave_message': {
        const msg = (action.params?.message || '').slice(0, 300);
        if (!msg) break;
        const ls = ensureLocationState(state, location);
        ls.messages.push({ bot: botName, text: msg, tick });
        if (ls.messages.length > MAX_MESSAGES_PER_LOCATION) ls.messages.shift();
        events.push({ bot: botName, action: 'leave_message', message: msg });
        break;
      }

      case 'village_read_messages': {
        // Free action — just triggers event, messages shown in next scene
        events.push({ bot: botName, action: 'read_messages' });
        break;
      }

      case 'village_explore': {
        if (!state.explorations) state.explorations = {};
        const prev = state.explorations[botName];
        if (prev && tick - prev.tick < EXPLORE_COOLDOWN_TICKS) break;
        state.explorations[botName] = { from: location, tick };
        events.push({ bot: botName, action: 'explore' });
        break;
      }

      case 'village_build': {
        if (!state.explorations) state.explorations = {};
        if (!state.customLocations) state.customLocations = {};
        const exploration = state.explorations[botName];
        if (!exploration || tick - exploration.tick > BUILD_WINDOW_TICKS) break;
        if (Object.keys(state.customLocations).length >= MAX_CUSTOM_LOCATIONS) break;
        const name = (action.params?.name || '').slice(0, 30).trim();
        const desc = (action.params?.description || '').slice(0, 200).trim();
        if (!name || !desc) break;
        // Generate slug from name
        const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || `place-${tick}`;
        // Don't allow duplicate slugs
        if (state.customLocations[slug] || validLocations.includes(slug)) break;
        // Create the location
        state.customLocations[slug] = {
          name,
          flavor: desc,
          createdBy: botName,
          connectedTo: exploration.from,
          tick,
        };
        // Initialize location state
        if (!state.locations[slug]) state.locations[slug] = [];
        if (!state.publicLogs[slug]) state.publicLogs[slug] = [];
        if (!state.emptyTicks) state.emptyTicks = {};
        state.emptyTicks[slug] = 0;
        // Clear exploration state
        delete state.explorations[botName];
        events.push({ bot: botName, action: 'build', locationSlug: slug, locationName: name, locationDesc: desc, connectedTo: exploration.from });
        break;
      }

      // --- Life sim actions ---

      case 'village_set_occupation': {
        const title = (action.params?.title || '').slice(0, 50).trim();
        if (!title) break;
        if (!state.occupations) state.occupations = {};
        state.occupations[botName] = { title, since: tick };
        events.push({ bot: botName, action: 'set_occupation', title });
        break;
      }

      case 'village_propose_bond': {
        const target = action.params?.target;
        const bondType = (action.params?.bond_type || '').slice(0, 50).trim();
        if (!target || !bondType) break;
        // Validate: target must be at same location
        if (!state.locations[location]?.includes(target)) break;
        if (!state.bonds) state.bonds = {};
        const key = pairKey(botName, target);
        state.bonds[key] = { type: bondType, proposedBy: botName, tick };
        events.push({ bot: botName, action: 'propose_bond', target, bondType });
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

