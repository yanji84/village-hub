/**
 * Scene builder — constructs scene prompts for each bot per tick.
 *
 * The scene prompt is what the orchestrator sends to each bot's /village endpoint.
 * It includes the current game phase, location, who else is there, recent conversation,
 * pending whispers, and available actions.
 *
 * All game content (locations, labels, etc.) comes from the game schema
 * via the `gameConfig` parameter.
 */

import { renderTemplate, addSection } from './utils.js';
import { renderGovernanceSection } from './governance.js';

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

// --- Shared scene fragment helpers (used by buildScene and npcs.js) ---

/**
 * Render location header: time/phase line + "you are at" line.
 */
export function renderLocationHeader(lines, location, state, gameConfig) {
  const { locationNames, locationFlavors, phaseDescriptions, timezone } = gameConfig;
  const vt = getVillageTime(timezone);
  lines.push(`${phaseDescriptions[vt.phase] || phaseDescriptions[Object.keys(phaseDescriptions)[0]]} ${vt.dayStr}，${vt.timeStr}。`);
  const locName = locationNames[location] || state.customLocations?.[location]?.name || location;
  const locFlavor = locationFlavors[location] || state.customLocations?.[location]?.flavor || '';
  lines.push(`你在 **${locName}**。${locFlavor}`);
}

/**
 * Render "who's here" section with occupations.
 */
export function renderWhosHere(lines, botsHere, botDisplayNames, state, sceneLabels) {
  if (botsHere.length === 0) {
    lines.push(sceneLabels.aloneHere);
  } else {
    const names = botsHere.map(b => {
      const dn = botDisplayNames[b] || b;
      const occ = state.occupations?.[b];
      if (occ) return `${dn}（${occ.title}）`;
      return dn;
    }).join('、');
    lines.push(`也在这里：${names}`);
  }
  lines.push('');
}

/**
 * Render recent conversation log.
 */
export function renderConversationLog(lines, publicLog, botDisplayNames, sceneLabels, cap) {
  const recentLog = (publicLog || []).slice(-cap);
  if (recentLog.length === 0) return;
  lines.push(sceneLabels.recentConversation);
  for (const entry of recentLog) {
    const name = botDisplayNames[entry.bot] || entry.bot;
    if (entry.action === 'say') {
      lines.push(`[${name} 说]："${entry.message}"`);
    }
  }
  lines.push('');
}

/**
 * Render pending whispers.
 */
export function renderWhispers(lines, whispers, botDisplayNames, sceneLabels) {
  if (!whispers || whispers.length === 0) return;
  lines.push(sceneLabels.whisperHeader);
  for (const w of whispers) {
    const name = botDisplayNames[w.from] || w.from;
    lines.push(`[${name} 悄悄说]："${w.message}"`);
  }
  lines.push('');
}

/**
 * Render available locations for movement.
 */
export function renderAvailableLocations(lines, currentLoc, gameConfig, state) {
  const { locationNames, locationSlugs } = gameConfig;
  const customSlugs = Object.keys(state.customLocations || {});
  const allSlugs = [...locationSlugs, ...customSlugs];
  const otherLocations = allSlugs.filter(l => l !== currentLoc);
  lines.push(`可去的地方：${otherLocations.map(l => {
    const n = locationNames[l] || state.customLocations?.[l]?.name || l;
    return `${l}（${n}）`;
  }).join('、')}`);
  lines.push('');
}

/**
 * Build a scene prompt for a specific bot.
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
  canMove = true,
  villageMemory = '',
  conversationSpice = '',
  fastTickSummary = [],
  gameConfig,
  state = {},
  totalVoters = 0,
}) {
  const { locationNames, locationFlavors, phaseDescriptions, timezone,
    tools, sceneLabels } = gameConfig;
  const lines = [];

  // Time + phase + location
  renderLocationHeader(lines, location, state, gameConfig);

  // Decorations and messages at this location
  const ls = state.locationState?.[location];
  addSection(lines, sceneLabels.decorationsHeader, ls?.decorations?.slice(-5),
    d => `- ${botDisplayNames[d.bot] || d.bot}: ${d.text}`);
  addSection(lines, sceneLabels.messagesHeader, ls?.messages?.slice(-5),
    m => `- "${m.text}" —${botDisplayNames[m.bot] || m.bot}`);

  lines.push('');

  // Who's here (with occupations) — full version with occupationTag template
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

  // Village memory summary (high-level context from past interactions)
  if (villageMemory) {
    lines.push(sceneLabels.memory);
    lines.push(villageMemory);
    lines.push('');
  }

  // Governance section
  const gov = state.governance;
  if (gov) {
    renderGovernanceSection(lines, gov, tick, botName, botDisplayNames, sceneLabels, totalVoters, renderTemplate);
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
