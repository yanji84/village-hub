/**
 * Extracted game logic — pure/testable functions from the village orchestrator.
 *
 * These functions operate on state objects passed as arguments rather than
 * module-level closures, making them independently testable.
 *
 * Game content (events, spice, emotions, locations, etc.) is loaded from a
 * game schema JSON via game-loader.js and passed as `gameConfig`.
 */

const MAX_WHISPERS_PER_BOT = 20;

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
        if (!dest || !validLocations.includes(dest) || dest === location) {
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

// --- Relationship tracking ---

/**
 * Create a canonical pair key from two bot names (sorted, "::" delimited).
 */
export function pairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Compute a relationship label from interaction counts.
 *
 * @param {{ says: number, whispers: number, coTicks: number }} rel
 * @param {object} gameConfig - Loaded game configuration
 * @returns {string} Label string, or '' if score too low
 */
export function computeLabel(rel, gameConfig) {
  const { scoring, labels } = gameConfig.relationships;
  const score = rel.says * scoring.sayWeight + rel.whispers * scoring.whisperWeight + rel.coTicks * scoring.coTickWeight;

  let label = '';
  for (const tier of labels) {
    if (score >= tier.minScore) {
      label = tier.label;
      break;
    }
  }

  if (label && rel.whispers > rel.says) {
    label += ' & confidant';
  }
  return label;
}

/**
 * Track interactions from processed events. Call after processActions.
 *
 * For each 'say' event, increment `says` for every other bot at that location.
 * For each 'whisper' event, increment `whispers` for the pair.
 *
 * @param {Map<string, Array>} allEvents - location → events[]
 * @param {object} state - State with locations, relationships
 * @param {object} displayNames - botName → displayName map
 */
export function trackInteractions(allEvents, state, displayNames) {
  if (!state.relationships) state.relationships = {};

  for (const [loc, events] of allEvents) {
    const botsAtLoc = state.locations[loc] || [];

    for (const ev of events) {
      if (ev.action === 'say') {
        for (const other of botsAtLoc) {
          if (other === ev.bot) continue;
          const key = pairKey(ev.bot, other);
          if (!state.relationships[key]) {
            state.relationships[key] = { says: 0, whispers: 0, coTicks: 0, label: '', prevLabel: '', since: state.clock.tick };
          }
          state.relationships[key].says++;
        }
      } else if (ev.action === 'whisper' && ev.target) {
        const key = pairKey(ev.bot, ev.target);
        if (!state.relationships[key]) {
          state.relationships[key] = { says: 0, whispers: 0, coTicks: 0, label: '', prevLabel: '', since: state.clock.tick };
        }
        state.relationships[key].whispers++;
      }
    }
  }
}

/**
 * Increment coTicks for all pairs of bots at the same location.
 *
 * @param {object} state - State with locations, relationships
 */
export function updateCoLocation(state) {
  if (!state.relationships) state.relationships = {};

  for (const loc of Object.keys(state.locations)) {
    const bots = state.locations[loc];
    if (bots.length < 2) continue;

    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const key = pairKey(bots[i], bots[j]);
        if (!state.relationships[key]) {
          state.relationships[key] = { says: 0, whispers: 0, coTicks: 0, label: '', prevLabel: '', since: state.clock.tick };
        }
        state.relationships[key].coTicks++;
      }
    }
  }
}

/**
 * Recompute labels for all relationships and detect changes.
 *
 * @param {object} state - State with relationships
 * @param {object} displayNames - botName → displayName map
 * @param {object} gameConfig - Loaded game configuration
 * @returns {Array<{ from: string, to: string, fromDisplay: string, toDisplay: string, label: string, prevLabel: string }>}
 */
export function updateRelationships(state, displayNames, gameConfig) {
  if (!state.relationships) state.relationships = {};
  const changes = [];

  for (const [key, rel] of Object.entries(state.relationships)) {
    const newLabel = computeLabel(rel, gameConfig);
    if (newLabel !== rel.label) {
      rel.prevLabel = rel.label;
      rel.label = newLabel;
      const [a, b] = key.split('::');
      changes.push({
        from: a,
        to: b,
        fromDisplay: displayNames[a] || a,
        toDisplay: displayNames[b] || b,
        label: newLabel,
        prevLabel: rel.prevLabel,
      });
    }
  }

  return changes;
}

/**
 * Decay relationships for pairs NOT co-located. Called once per tick.
 * Inactive pairs slowly drift apart, requiring maintenance.
 *
 * @param {object} state - State with locations, relationships
 * @param {object} gameConfig - Loaded game configuration
 */
export function decayRelationships(state, gameConfig) {
  if (!state.relationships) return;

  const decayPerTick = gameConfig.relationships.decayPerTick;

  // Build co-location set
  const coLocated = new Set();
  for (const loc of Object.keys(state.locations)) {
    const bots = state.locations[loc];
    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        coLocated.add(pairKey(bots[i], bots[j]));
      }
    }
  }

  for (const [key, rel] of Object.entries(state.relationships)) {
    if (coLocated.has(key)) continue;
    if (rel.says > 0) {
      rel.says = Math.max(0, rel.says - decayPerTick);
    }
  }
}

// --- Emotion tracking ---

/**
 * Update emotions for all bots based on tick events.
 *
 * @param {object} state - State with locations, emotions, clock
 * @param {Map<string, Array>} allEvents - location → events[]
 * @param {Array<{ botName: string, response: object|null, loc: string }>} allResults - scene results
 * @param {object} displayNames - botName → displayName map
 * @param {object} [opts] - Optional: { activeEvents, activeSpice }
 * @param {object} gameConfig - Loaded game configuration
 * @returns {Array<{ bot: string, displayName: string, emotion: string, prevEmotion: string }>} change events
 */
export function updateEmotions(state, allEvents, allResults, displayNames, opts = {}, gameConfig) {
  if (!state.emotions) state.emotions = {};
  const changes = [];

  const { decay: EMOTION_DECAY, threshold: EMOTION_THRESHOLD } = gameConfig.emotionConfig;

  // Build sets for quick lookup
  const botsWithActions = new Set();
  const botsWhispered = new Set();
  const botsSaid = new Map(); // bot → count of others present when they spoke
  const botsMoved = new Set();

  for (const [loc, events] of allEvents) {
    for (const ev of events) {
      if (ev.action === 'say') {
        botsWithActions.add(ev.bot);
        const othersCount = (state.locations[loc] || []).filter(b => b !== ev.bot).length;
        // Track max others present across all say events for this bot
        const prev = botsSaid.get(ev.bot) || 0;
        if (othersCount > prev) botsSaid.set(ev.bot, othersCount);
      } else if (ev.action === 'whisper' && ev.target) {
        botsWithActions.add(ev.bot);
        botsWhispered.add(ev.target);
      } else if (ev.action === 'move') {
        botsWithActions.add(ev.bot);
        botsMoved.add(ev.bot);
      } else if (ev.action === 'observe') {
        botsWithActions.add(ev.bot);
      }
    }
  }

  // Build set of bots that were sent a scene this tick
  const botsSent = new Set(allResults.map(r => r.botName));

  // Process each bot in any location
  const allBots = new Set();
  for (const loc of Object.keys(state.locations)) {
    for (const bot of state.locations[loc]) allBots.add(bot);
  }

  // Update stagnation counters (consecutive ticks at same location)
  if (!state.stagnation) state.stagnation = {};
  for (const bot of allBots) {
    if (botsMoved.has(bot)) {
      state.stagnation[bot] = 0;
    } else if (botsSent.has(bot)) {
      state.stagnation[bot] = (state.stagnation[bot] || 0) + 1;
    }
  }

  for (const bot of allBots) {
    if (!botsSent.has(bot)) continue; // skip bots that weren't active this tick

    if (!state.emotions[bot]) {
      state.emotions[bot] = { emotion: 'neutral', intensity: 0, prevEmotion: 'neutral', since: state.clock.tick };
    }

    const emo = state.emotions[bot];

    // 1. Decay current intensity
    emo.intensity *= EMOTION_DECAY;

    // 2. Compute impulses
    const impulses = [];

    if (botsWhispered.has(bot)) {
      impulses.push({ emotion: 'happy', intensity: 0.8 });
    }

    if (botsSaid.has(bot)) {
      const othersCount = botsSaid.get(bot);
      if (othersCount >= 2) {
        impulses.push({ emotion: 'content', intensity: 0.6 });
      } else if (othersCount >= 1) {
        impulses.push({ emotion: 'content', intensity: 0.4 });
      }
    }

    if (botsMoved.has(bot)) {
      impulses.push({ emotion: 'excited', intensity: 0.5 });
    }

    // Find bot's current location
    let botLoc = null;
    for (const loc of Object.keys(state.locations)) {
      if (state.locations[loc].includes(bot)) { botLoc = loc; break; }
    }

    if (botLoc) {
      const othersHere = (state.locations[botLoc] || []).filter(b => b !== bot);
      if (othersHere.length === 0) {
        // Alone — additive lonely
        if (emo.emotion === 'lonely') {
          impulses.push({ emotion: 'lonely', intensity: emo.intensity + 0.15 });
        } else {
          impulses.push({ emotion: 'lonely', intensity: 0.15 });
        }
      } else if (!botsWithActions.has(bot)) {
        // Others present but no actions
        impulses.push({ emotion: 'bored', intensity: 0.4 });
      }
    }

    // --- Additional impulse triggers (environmental & random) ---

    // Curious: village event active at bot's location
    if (opts.activeEvents && botLoc && opts.activeEvents.get(botLoc)) {
      impulses.push({ emotion: 'curious', intensity: 0.6 });
    }

    // Frustrated: stagnation — same location for 5+ ticks
    if (state.stagnation && (state.stagnation[bot] || 0) >= 5) {
      impulses.push({ emotion: 'frustrated', intensity: 0.5 });
    }

    // Playful: 5% random chance per tick
    if (Math.random() < 0.05) {
      impulses.push({ emotion: 'playful', intensity: 0.55 });
    }

    // Mischievous: 3% random chance per tick
    if (Math.random() < 0.03) {
      impulses.push({ emotion: 'mischievous', intensity: 0.6 });
    }

    // Skeptical: 10% chance when in a high-familiarity relationship (prevents mutual admiration lock)
    if (state.relationships && botLoc) {
      for (const [key, rel] of Object.entries(state.relationships)) {
        const [a, b] = key.split('::');
        if (a !== bot && b !== bot) continue;
        if (rel.says > 50 && Math.random() < 0.10) {
          impulses.push({ emotion: 'skeptical', intensity: 0.5 });
          break;
        }
      }
    }

    // Nostalgic: 8% chance during evening/night
    if (['evening', 'night'].includes(state.clock.phase) && Math.random() < 0.08) {
      impulses.push({ emotion: 'nostalgic', intensity: 0.45 });
    }

    // Anxious: 6% chance when conversation spice is active at location
    if (opts.activeSpice && botLoc && opts.activeSpice.get(botLoc)) {
      if (Math.random() < 0.4) {
        impulses.push({ emotion: 'anxious', intensity: 0.5 });
      }
    }

    // 3. Pick strongest impulse
    let best = null;
    for (const imp of impulses) {
      if (!best || imp.intensity > best.intensity) best = imp;
    }

    if (best && best.intensity > emo.intensity) {
      const prevEmotion = emo.emotion;
      emo.emotion = best.emotion;
      emo.intensity = Math.min(best.intensity, 1.0);
      emo.since = state.clock.tick;

      if (prevEmotion !== emo.emotion) {
        emo.prevEmotion = prevEmotion;
        changes.push({
          bot,
          displayName: displayNames[bot] || bot,
          emotion: emo.emotion,
          prevEmotion,
        });
      }
    }

    // 4. Reset to neutral if below threshold
    if (emo.intensity < EMOTION_THRESHOLD) {
      if (emo.emotion !== 'neutral') {
        const prevEmotion = emo.emotion;
        emo.prevEmotion = prevEmotion;
        emo.emotion = 'neutral';
        emo.intensity = 0;
        emo.since = state.clock.tick;
        changes.push({
          bot,
          displayName: displayNames[bot] || bot,
          emotion: 'neutral',
          prevEmotion,
        });
      }
    }
  }

  return changes;
}
