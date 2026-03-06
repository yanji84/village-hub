/**
 * Scene builder — constructs scene prompts for each bot per tick.
 *
 * The scene prompt is what the orchestrator sends to each bot's /village endpoint.
 * It includes the current game phase, location, who else is there, recent conversation,
 * pending whispers, and available actions.
 *
 * All game content (locations, labels, emotions, etc.) comes from the game schema
 * via the `gameConfig` parameter.
 */

/**
 * Get current village time in the given timezone.
 *
 * @param {string} timezone - IANA timezone string
 * @returns {{ phase: string, timeStr: string, dayStr: string, hour: number }}
 */
export function getVillageTime(timezone) {
  const now = new Date();
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).format(now);
  const hour = parseInt(fmt({ hour: 'numeric', hour12: false }), 10);
  const timeStr = fmt({ hour: 'numeric', minute: '2-digit', hour12: true });
  const dayStr = fmt({ weekday: 'long' });
  let phase;
  if (hour >= 5 && hour < 12) phase = 'morning';
  else if (hour >= 12 && hour < 17) phase = 'afternoon';
  else if (hour >= 17 && hour < 21) phase = 'evening';
  else phase = 'night';
  return { phase, timeStr, dayStr, hour };
}

/**
 * Simple template renderer — replaces {key} placeholders in a string.
 */
function renderTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] !== undefined ? vars[key] : `{${key}}`);
}

/**
 * Append a labeled section to lines if items is non-empty.
 * Adds blank line before header, renders each item, adds trailing blank line.
 */
function addSection(lines, header, items, renderItem) {
  if (!items || items.length === 0) return;
  lines.push('');
  lines.push(header);
  for (const item of items) lines.push(renderItem(item));
}

/**
 * Build a scene prompt for a specific bot.
 *
 * @param {object} opts
 * @param {string} opts.botName - System name of this bot
 * @param {string} opts.botDisplayName - Display name of this bot
 * @param {string} opts.location - Current location slug
 * @param {string} opts.phase - Current game phase (morning/afternoon/evening)
 * @param {number} opts.tick - Current tick number
 * @param {string[]} opts.botsHere - System names of other bots at same location
 * @param {object} opts.botDisplayNames - Map of systemName → displayName
 * @param {Array} opts.publicLog - Recent public messages at this location
 * @param {Array} opts.whispers - Pending whispers for this bot
 * @param {Array} opts.movements - Recent movement events at this location
 * @param {number} opts.sceneHistoryCap - Max messages in public log (default 10)
 * @param {object} [opts.relationships] - state.relationships object
 * @param {object} [opts.emotions] - state.emotions object
 * @param {boolean} [opts.canMove=true] - Whether move action is available (false during cooldown)
 * @param {string} [opts.villageMemory] - Summarized village memory to include in prompt
 * @param {string} [opts.villageEvent] - Active village event text
 * @param {string} [opts.conversationSpice] - Active conversation spice text
 * @param {string[]} [opts.fastTickSummary] - Recent autopilot activity lines
 * @param {object} opts.gameConfig - Loaded game configuration
 * @returns {string} The scene prompt
 */
export function buildScene({
  botName,
  botDisplayName,
  location,
  phase,
  tick,
  botsHere,
  botDisplayNames,
  publicLog,
  whispers,
  movements,
  sceneHistoryCap = 10,
  relationships,
  emotions,
  canMove = true,
  villageMemory = '',
  villageEvent = '',
  conversationSpice = '',
  fastTickSummary = [],
  gameConfig,
  state = {},
}) {
  const { locationNames, locationFlavors, phaseDescriptions, timezone,
    emotions: emotionDefs, tools, sceneLabels } = gameConfig;
  const lines = [];

  // Time + phase + location
  const vt = getVillageTime(timezone);
  lines.push(`${phaseDescriptions[vt.phase] || phaseDescriptions[Object.keys(phaseDescriptions)[0]]} ${vt.dayStr}，${vt.timeStr}。`);
  // Location name — check custom locations too
  const locName = locationNames[location] || state.customLocations?.[location]?.name || location;
  const locFlavor = locationFlavors[location] || state.customLocations?.[location]?.flavor || '';
  lines.push(`你在 **${locName}**。${locFlavor}`);

  // Decorations and messages at this location
  const ls = state.locationState?.[location];
  addSection(lines, sceneLabels.decorationsHeader, ls?.decorations?.slice(-5),
    d => `- ${botDisplayNames[d.bot] || d.bot}: ${d.text}`);
  addSection(lines, sceneLabels.messagesHeader, ls?.messages?.slice(-5),
    m => `- "${m.text}" —${botDisplayNames[m.bot] || m.bot}`);

  lines.push('');

  // Who's here (with occupations)
  if (botsHere.length === 0) {
    lines.push(sceneLabels.aloneHere);
  } else {
    const names = botsHere.map(b => {
      const dn = botDisplayNames[b] || b;
      const occ = state.occupations?.[b];
      if (occ) return `${dn}${renderTemplate(sceneLabels.occupationTag, { title: occ.title })}`;
      return dn;
    }).join('、');
    lines.push(renderTemplate(sceneLabels.alsoHere, { names }));
  }
  lines.push('');

  // Relationships
  if (relationships) {
    const relLines = [];
    for (const [key, rel] of Object.entries(relationships)) {
      if (!rel.label) continue;
      const [a, b] = key.split('::');
      if (a !== botName && b !== botName) continue;
      const other = a === botName ? b : a;
      const otherDisplay = botDisplayNames[other] || other;
      relLines.push(`- ${otherDisplay}: ${rel.label}`);
    }
    if (relLines.length > 0) {
      lines.push(sceneLabels.relationships);
      lines.push(...relLines);
      lines.push('');
    }
  }

  // Bonds (life sim)
  if (state.bonds) {
    const bondLines = [];
    for (const [key, bond] of Object.entries(state.bonds)) {
      const [a, b] = key.split('::');
      if (a !== botName && b !== botName) continue;
      const other = a === botName ? b : a;
      const otherDisplay = botDisplayNames[other] || other;
      bondLines.push(renderTemplate(sceneLabels.bondFormat, { name1: botDisplayName, name2: otherDisplay, bondType: bond.type }));
    }
    if (bondLines.length > 0) {
      lines.push(sceneLabels.bondsHeader);
      lines.push(...bondLines);
      lines.push('');
    }
  }

  // Own occupation
  if (state.occupations?.[botName]) {
    lines.push(`你的职业：**${state.occupations[botName].title}**`);
    lines.push('');
  }

  // Exploration hint
  if (state.explorations?.[botName]) {
    const expl = state.explorations[botName];
    if (tick - expl.tick <= 5) {
      lines.push(sceneLabels.exploreHint);
      lines.push('');
    }
  }

  // Current emotion
  if (emotions && emotions[botName] && emotions[botName].emotion !== 'neutral') {
    const emotionKey = emotions[botName].emotion;
    const emotionLabel = emotionDefs[emotionKey]?.label || emotionKey;
    lines.push(renderTemplate(sceneLabels.mood, { emotion: emotionLabel }));
    lines.push('');
  }

  // Village memory summary (high-level context from past interactions)
  if (villageMemory) {
    lines.push(sceneLabels.memory);
    lines.push(villageMemory);
    lines.push('');
  }

  // Movement events
  if (movements && movements.length > 0) {
    for (const m of movements) {
      const name = botDisplayNames[m.bot] || m.bot;
      if (m.type === 'arrive') {
        lines.push(renderTemplate(sceneLabels.arriveFrom, { name, from: locationNames[m.from] || m.from || '别处' }));
      } else if (m.type === 'depart') {
        lines.push(renderTemplate(sceneLabels.departTo, { name, to: locationNames[m.to] || m.to || '别处' }));
      } else if (m.type === 'join') {
        lines.push(renderTemplate(sceneLabels.joinVillage, { name }));
      } else if (m.type === 'leave') {
        lines.push(renderTemplate(sceneLabels.leaveVillage, { name }));
      }
    }
    lines.push('');
  }

  // Village event (environmental stimulus)
  if (villageEvent) {
    lines.push(`${sceneLabels.eventPrefix} ${villageEvent}`);
    lines.push('');
  }

  // Conversation spice (provocative prompt)
  if (conversationSpice) {
    lines.push(`${sceneLabels.spicePrefix} ${conversationSpice}`);
    lines.push('');
  }

  // Recent autopilot activity (from fast ticks between LLM ticks)
  if (fastTickSummary.length > 0) {
    lines.push(sceneLabels.recentActivity);
    for (const item of fastTickSummary.slice(-10)) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Recent public conversation
  const recentLog = (publicLog || []).slice(-sceneHistoryCap);
  if (recentLog.length > 0) {
    lines.push(sceneLabels.recentConversation);
    for (const entry of recentLog) {
      const name = botDisplayNames[entry.bot] || entry.bot;
      if (entry.action === 'say') {
        lines.push(renderTemplate(sceneLabels.sayFormat, { name, message: entry.message }));
      } else if (entry.action === 'observe') {
        lines.push(renderTemplate(sceneLabels.observeFormat, { name }));
      }
    }
    lines.push('');
  }

  // Pending whispers
  if (whispers && whispers.length > 0) {
    lines.push(sceneLabels.whisperHeader);
    for (const w of whispers) {
      const name = botDisplayNames[w.from] || w.from;
      lines.push(renderTemplate(sceneLabels.whisperFormat, { name, message: w.message }));
    }
    lines.push('');
  }

  // Available actions
  lines.push(sceneLabels.availableActions);
  for (const tool of tools) {
    if (tool.id === 'village_move') {
      if (canMove) {
        lines.push(`- **${tool.id}**：${tool.description}`);
      }
    } else {
      lines.push(`- **${tool.id}**：${tool.description}`);
    }
  }
  if (!canMove) {
    lines.push(sceneLabels.moveCooldown);
  }
  lines.push('');

  if (canMove) {
    // Available locations (for move) — include custom locations
    const { locationSlugs } = gameConfig;
    const customSlugs = Object.keys(state.customLocations || {});
    const allSlugs = [...locationSlugs, ...customSlugs];
    const otherLocations = allSlugs.filter(l => l !== location);
    lines.push(`${sceneLabels.availableLocations}${otherLocations.map(l => {
      const n = locationNames[l] || state.customLocations?.[l]?.name || l;
      return `${l}（${n}）`;
    }).join('、')}`);
    lines.push('');
    lines.push(sceneLabels.moveExclusive);
  } else {
    lines.push(sceneLabels.maxActions);
  }
  lines.push(sceneLabels.behaviorGuidance);
  if (sceneLabels.journalGuidance) {
    lines.push(sceneLabels.journalGuidance);
  }

  return lines.join('\n');
}
