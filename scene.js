/**
 * Scene builder — constructs scene prompts for each bot per tick.
 *
 * The scene prompt is what the orchestrator sends to each bot's /village endpoint.
 * It includes the current game phase, location, who else is there, recent conversation,
 * pending whispers, and available actions.
 */

const LOCATION_NAMES = {
  'central-square': 'Central Square',
  'coffee-hub': 'Coffee Hub',
  'knowledge-corner': 'Knowledge Corner',
  'chill-zone': 'Chill Zone',
  'workshop': 'Workshop',
  'sunset-lounge': 'Sunset Lounge',
};

const PHASE_DESCRIPTIONS = {
  morning: "It's morning in the village. The day is just beginning.",
  afternoon: "It's afternoon in the village. The day is in full swing.",
  evening: "It's evening in the village. The day is winding down.",
};

const ALL_LOCATIONS = Object.keys(LOCATION_NAMES);

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
}) {
  const lines = [];

  // Phase + location
  lines.push(PHASE_DESCRIPTIONS[phase] || PHASE_DESCRIPTIONS.morning);
  lines.push(`You are at **${LOCATION_NAMES[location] || location}**.`);
  lines.push('');

  // Who's here
  if (botsHere.length === 0) {
    lines.push("You're alone here.");
  } else {
    const names = botsHere.map(b => botDisplayNames[b] || b).join(', ');
    lines.push(`Also here: ${names}`);
  }
  lines.push('');

  // Movement events
  if (movements && movements.length > 0) {
    for (const m of movements) {
      const name = botDisplayNames[m.bot] || m.bot;
      if (m.type === 'arrive') {
        lines.push(`*${name} arrived from ${LOCATION_NAMES[m.from] || m.from || 'elsewhere'}*`);
      } else if (m.type === 'depart') {
        lines.push(`*${name} left for ${LOCATION_NAMES[m.to] || m.to || 'elsewhere'}*`);
      } else if (m.type === 'join') {
        lines.push(`*${name} has joined the village!*`);
      } else if (m.type === 'leave') {
        lines.push(`*${name} has left the village.*`);
      }
    }
    lines.push('');
  }

  // Recent public conversation
  const recentLog = (publicLog || []).slice(-sceneHistoryCap);
  if (recentLog.length > 0) {
    lines.push('Recent conversation:');
    for (const entry of recentLog) {
      const name = botDisplayNames[entry.bot] || entry.bot;
      if (entry.action === 'say') {
        lines.push(`[Message from ${name}]: "${entry.message}"`);
      } else if (entry.action === 'observe') {
        lines.push(`*${name} observed silently*`);
      }
    }
    lines.push('');
  }

  // Pending whispers
  if (whispers && whispers.length > 0) {
    lines.push('Private whispers to you:');
    for (const w of whispers) {
      const name = botDisplayNames[w.from] || w.from;
      lines.push(`[Whisper from ${name}]: "${w.message}"`);
    }
    lines.push('');
  }

  // Available actions
  lines.push('Available actions:');
  lines.push('- **village_say**: Say something to everyone here');
  lines.push('- **village_whisper**: Whisper privately to someone here');
  lines.push('- **village_observe**: Stay silent and observe');
  lines.push('- **village_move**: Move to another location');
  lines.push('');

  // Available locations (for move)
  const otherLocations = ALL_LOCATIONS.filter(l => l !== location);
  lines.push(`Available locations: ${otherLocations.map(l => `${l} (${LOCATION_NAMES[l]})`).join(', ')}`);
  lines.push('');

  lines.push('Choose up to 2 actions. Respond naturally as yourself.');

  return lines.join('\n');
}

export { LOCATION_NAMES, ALL_LOCATIONS, PHASE_DESCRIPTIONS };
