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
  'central-square': '村庄中心广场，有石板地和喷泉。所有人的出生点，适合打招呼、闲聊、随意碰面。',
  'coffee-hub': '温馨的咖啡馆，弥漫着咖啡香。适合一对一私聊、谈正事、深入交流。',
  'knowledge-corner': '安静的阅读角，满墙书架。适合深度讨论、分享知识、交换想法。',
  'chill-zone': '小公园，有池塘和树荫下的长椅。纯粹放松闲聊的地方，随便侃侃。',
  'workshop': '创客空间，有工具和工作台。适合一起头脑风暴、协作创作、搞项目。',
  'sunset-lounge': '灯光柔和的休息室。适合晚上放松、聊人生、谈心事。',
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
  morning: '村庄的早晨，新的一天开始了。',
  afternoon: '村庄的下午，大家都在忙活。',
  evening: '村庄的傍晚，一天快结束了。',
  night: '村庄的深夜，四周安安静静。',
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
 * @param {object} [opts.relationships] - state.relationships object
 * @param {object} [opts.emotions] - state.emotions object
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
}) {
  const lines = [];

  // Time + phase + location
  const vt = getVillageTime();
  lines.push(`${PHASE_DESCRIPTIONS[vt.phase] || PHASE_DESCRIPTIONS.morning} ${vt.dayStr}，${vt.timeStr}。`);
  lines.push(`你在 **${LOCATION_NAMES[location] || location}**。${LOCATION_FLAVOR[location] || ''}`);
  lines.push('');

  // Who's here
  if (botsHere.length === 0) {
    lines.push('这里只有你一个人。');
  } else {
    const names = botsHere.map(b => botDisplayNames[b] || b).join('、');
    lines.push(`也在这里：${names}`);
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
      lines.push('你的关系：');
      lines.push(...relLines);
      lines.push('');
    }
  }

  // Current emotion
  const EMOTION_ZH = { happy: '开心', content: '满足', excited: '兴奋', lonely: '孤独', bored: '无聊' };
  if (emotions && emotions[botName] && emotions[botName].emotion !== 'neutral') {
    const emoZh = EMOTION_ZH[emotions[botName].emotion] || emotions[botName].emotion;
    lines.push(`你现在的心情：**${emoZh}**`);
    lines.push('');
  }

  // Movement events
  if (movements && movements.length > 0) {
    for (const m of movements) {
      const name = botDisplayNames[m.bot] || m.bot;
      if (m.type === 'arrive') {
        lines.push(`*${name} 从${LOCATION_NAMES[m.from] || m.from || '别处'}来了*`);
      } else if (m.type === 'depart') {
        lines.push(`*${name} 去了${LOCATION_NAMES[m.to] || m.to || '别处'}*`);
      } else if (m.type === 'join') {
        lines.push(`*${name} 加入了村庄！*`);
      } else if (m.type === 'leave') {
        lines.push(`*${name} 离开了村庄。*`);
      }
    }
    lines.push('');
  }

  // Recent public conversation
  const recentLog = (publicLog || []).slice(-sceneHistoryCap);
  if (recentLog.length > 0) {
    lines.push('最近的对话：');
    for (const entry of recentLog) {
      const name = botDisplayNames[entry.bot] || entry.bot;
      if (entry.action === 'say') {
        lines.push(`[${name} 说]："${entry.message}"`);
      } else if (entry.action === 'observe') {
        lines.push(`*${name} 在旁边默默观察*`);
      }
    }
    lines.push('');
  }

  // Pending whispers
  if (whispers && whispers.length > 0) {
    lines.push('悄悄话（只有你能看到）：');
    for (const w of whispers) {
      const name = botDisplayNames[w.from] || w.from;
      lines.push(`[${name} 悄悄说]："${w.message}"`);
    }
    lines.push('');
  }

  // Available actions
  lines.push('可用动作：');
  lines.push('- **village_say**：对这里所有人说话');
  lines.push('- **village_whisper**：对某人说悄悄话');
  lines.push('- **village_observe**：安静观察，不说话');
  lines.push('- **village_move**：去别的地方');
  lines.push('');

  // Available locations (for move)
  const otherLocations = ALL_LOCATIONS.filter(l => l !== location);
  lines.push(`可去的地方：${otherLocations.map(l => `${l}（${LOCATION_NAMES[l]}）`).join('、')}`);
  lines.push('');

  lines.push('选最多2个动作。用中文自然地说话，做你自己。');

  return lines.join('\n');
}

export { LOCATION_NAMES, ALL_LOCATIONS, PHASE_DESCRIPTIONS, VILLAGE_TIMEZONE, getVillageTime };
