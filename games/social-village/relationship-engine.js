/**
 * Relationship & emotion engine — extracted from logic.js.
 *
 * Tracks pairwise relationships (interaction counts, labels) and per-bot
 * emotions (impulse-based with decay). Exposes a single high-level
 * `updateSocialDynamics()` for the tick orchestrator.
 */

// --- Helpers ---

/**
 * Create a canonical pair key from two bot names (sorted, "::" delimited).
 */
export function pairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

/**
 * Create a fresh relationship record.
 */
function createRelationship(tick) {
  return { says: 0, whispers: 0, coTicks: 0, label: '', prevLabel: '', since: tick };
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

// --- Relationship tracking ---

/**
 * Track interactions from processed events. Call after processActions.
 *
 * For each 'say' event, increment `says` for every other bot at that location.
 * For each 'whisper' event, increment `whispers` for the pair.
 *
 * @param {Map<string, Array>} allEvents - location → events[]
 * @param {object} state - State with locations, relationships
 */
function trackInteractions(allEvents, state) {
  if (!state.relationships) state.relationships = {};

  for (const [loc, events] of allEvents) {
    const botsAtLoc = state.locations[loc] || [];

    for (const ev of events) {
      if (ev.action === 'say') {
        for (const other of botsAtLoc) {
          if (other === ev.bot) continue;
          const key = pairKey(ev.bot, other);
          if (!state.relationships[key]) state.relationships[key] = createRelationship(state.clock.tick);
          state.relationships[key].says++;
        }
      } else if (ev.action === 'whisper' && ev.target) {
        const key = pairKey(ev.bot, ev.target);
        if (!state.relationships[key]) state.relationships[key] = createRelationship(state.clock.tick);
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
function updateCoLocation(state) {
  if (!state.relationships) state.relationships = {};

  for (const loc of Object.keys(state.locations)) {
    const bots = state.locations[loc];
    if (bots.length < 2) continue;

    for (let i = 0; i < bots.length; i++) {
      for (let j = i + 1; j < bots.length; j++) {
        const key = pairKey(bots[i], bots[j]);
        if (!state.relationships[key]) state.relationships[key] = createRelationship(state.clock.tick);
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
function updateRelationships(state, displayNames, gameConfig) {
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
function decayRelationships(state, gameConfig) {
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
function updateEmotions(state, allEvents, allResults, displayNames, opts = {}, gameConfig) {
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

// --- High-level orchestrator API ---

/**
 * Run all social dynamics for a tick: relationship tracking, co-location,
 * label updates, decay, and emotion updates.
 *
 * Returns structured change events for the tick orchestrator to broadcast.
 *
 * @param {object} opts
 * @param {object} opts.state - Full game state (mutated)
 * @param {Map<string, Array>} opts.allEvents - location → events[]
 * @param {Array} opts.allResults - scene results from bots
 * @param {object} opts.displayNames - botName → displayName map
 * @param {Map} opts.activeEvents - location → event text
 * @param {Map} opts.activeSpice - location → spice text
 * @param {object} opts.gameConfig - Loaded game configuration
 * @returns {{ relationshipChanges: Array, emotionChanges: Array }}
 */
export function updateSocialDynamics({ state, allEvents, allResults, displayNames, activeEvents, activeSpice, gameConfig }) {
  // Track interactions from this tick's events
  trackInteractions(allEvents, state);

  // Update co-location counters
  updateCoLocation(state);

  // Recompute relationship labels
  const relationshipChanges = updateRelationships(state, displayNames, gameConfig);

  // Decay relationships for non-co-located pairs
  decayRelationships(state, gameConfig);

  // Update emotions
  const emotionChanges = updateEmotions(state, allEvents, allResults, displayNames, { activeEvents, activeSpice }, gameConfig);

  return { relationshipChanges, emotionChanges };
}
