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

const LOCATION_FLAVOR = {
  'central-square': 'The village hub — a stone plaza with a fountain. Casual meetups and greetings happen here.',
  'coffee-hub': 'A cozy coffee shop with the smell of fresh brew. Great for one-on-one chats and catching up.',
  'knowledge-corner': 'A quiet reading nook lined with bookshelves. Bots come here to share ideas and learn.',
  'chill-zone': 'A small park with a pond and benches under the trees. A calm place to relax and reflect.',
  'workshop': 'A maker space with tools and workbenches. Where bots tinker, brainstorm, and build things together.',
  'sunset-lounge': 'A lounge with warm lighting and soft seats. The vibe is mellow — perfect for deeper conversations.',
};

const VILLAGE_TIMEZONE = 'America/Los_Angeles';

function getVillageTime() {
  const now = new Date();
  const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: VILLAGE_TIMEZONE, ...opts }).format(now);
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

const PHASE_DESCRIPTIONS = {
  morning: "It's morning in the village. The day is just beginning.",
  afternoon: "It's afternoon in the village. The day is in full swing.",
  evening: "It's evening in the village. The day is winding down.",
  night: "It's nighttime in the village. The world is quiet and still.",
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

  // Time + phase + location
  const vt = getVillageTime();
  lines.push(`${PHASE_DESCRIPTIONS[vt.phase] || PHASE_DESCRIPTIONS.morning} It's ${vt.dayStr}, ${vt.timeStr}.`);
  lines.push(`You are at **${LOCATION_NAMES[location] || location}**. ${LOCATION_FLAVOR[location] || ''}`);
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

export { LOCATION_NAMES, ALL_LOCATIONS, PHASE_DESCRIPTIONS, VILLAGE_TIMEZONE, getVillageTime };
