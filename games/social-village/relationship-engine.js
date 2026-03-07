/**
 * Relationship engine — extracted from logic.js.
 *
 * Tracks pairwise relationships (interaction counts, labels).
 * Exposes a single high-level `updateSocialDynamics()` for the tick orchestrator.
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

// --- High-level orchestrator API ---

/**
 * Run all social dynamics for a tick: relationship tracking, co-location,
 * label updates, and decay.
 *
 * Returns structured change events for the tick orchestrator to broadcast.
 *
 * @param {object} opts
 * @param {object} opts.state - Full game state (mutated)
 * @param {Map<string, Array>} opts.allEvents - location → events[]
 * @param {object} opts.displayNames - botName → displayName map
 * @param {object} opts.gameConfig - Loaded game configuration
 * @returns {{ relationshipChanges: Array }}
 */
export function updateSocialDynamics({ state, allEvents, displayNames, gameConfig }) {
  // Track interactions from this tick's events
  trackInteractions(allEvents, state);

  // Update co-location counters
  updateCoLocation(state);

  // Recompute relationship labels
  const relationshipChanges = updateRelationships(state, displayNames, gameConfig);

  // Decay relationships for non-co-located pairs
  decayRelationships(state, gameConfig);

  return { relationshipChanges };
}
