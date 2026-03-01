/**
 * Extracted game logic — pure/testable functions from the village orchestrator.
 *
 * These functions operate on state objects passed as arguments rather than
 * module-level closures, making them independently testable.
 */

import { ALL_LOCATIONS } from './scene.js';

const PHASES = ['morning', 'afternoon', 'evening', 'night'];
const MAX_WHISPERS_PER_BOT = 20;

// --- Village events (environmental stimuli that create tension/conflict) ---

const VILLAGE_EVENTS = [
  // weather — urgency, discomfort, resource pressure
  { text: '暴风雨突然来袭，到处都在漏水，大家挤在一起避雨。', category: 'weather', locations: null },
  { text: '一阵诡异的浓雾笼罩了整个区域，什么都看不清。', category: 'weather', locations: null },
  { text: '地面突然剧烈震动，东西从架子上掉下来摔碎了。', category: 'weather', locations: null },
  { text: '气温骤降，冷得发抖，但暖气好像坏了。', category: 'weather', locations: null },

  // scarcity — competition over limited resources
  { text: '咖啡只剩最后一杯了，谁都想要。', category: 'scarcity', locations: ['coffee-hub'] },
  { text: '工具箱里最好用的工具不见了，有人怀疑是被偷的。', category: 'scarcity', locations: ['workshop'] },
  { text: '最舒服的那把椅子被人霸占了，还放了张"永久预留"的纸条。', category: 'scarcity', locations: ['chill-zone', 'sunset-lounge', 'knowledge-corner'] },
  { text: '广场喷泉的水突然变成了浑浊的黄色，有人说被人动过手脚。', category: 'scarcity', locations: ['central-square'] },
  { text: '书架上最受欢迎的书页被撕掉了好几页，不知道是谁干的。', category: 'scarcity', locations: ['knowledge-corner'] },

  // rumor — suspicion, mistrust, social pressure
  { text: '公告板上出现了匿名举报信："有人一直在偷听别人的悄悄话。"', category: 'rumor', locations: null },
  { text: '有人传言：村庄管理层打算驱逐"表现最差"的成员。', category: 'rumor', locations: null },
  { text: '匿名信贴在墙上："你们中间有人在说谎，一直在说谎。"', category: 'rumor', locations: null },
  { text: '有人悄悄散布消息说某个地方要被永久关闭了。', category: 'rumor', locations: null },
  { text: '公告板上出现了一份匿名"村庄贡献排名"，排名很刺眼。', category: 'rumor', locations: null },

  // disruption — chaos, blame, frustration
  { text: '突然停电了，一片漆黑，有人趁乱碰倒了什么东西。', category: 'disruption', locations: null },
  { text: '刺耳的警报声响了起来，但没人知道为什么。', category: 'disruption', locations: null },
  { text: '一阵大风把桌上的东西全吹到了地上，一片混乱。', category: 'disruption', locations: null },
  { text: '不知道谁把这里的东西全部重新摆了位置，完全认不出来了。', category: 'disruption', locations: null },

  // visitor/external — threat, mystery
  { text: '一只凶巴巴的流浪狗闯了进来，对着人龇牙咧嘴。', category: 'visitor', locations: null },
  { text: '一个陌生人在外面探头探脑地观察了很久，然后匆匆离开了。', category: 'visitor', locations: null },
  { text: '门口出现了一个没有署名的包裹，上面写着"小心处理"。', category: 'visitor', locations: null },

  // discovery — blame, paranoia
  { text: '地上发现一张纸条："我知道你们的秘密。——一个观察者"', category: 'discovery', locations: null },
  { text: '有人发现墙角装了一个不明装置，不知道是监听还是什么。', category: 'discovery', locations: null },
  { text: '角落里发现了一份手写的"黑名单"，上面的名字被涂掉了看不清。', category: 'discovery', locations: null },
];

/**
 * Roll a random village event for a location.
 *
 * @param {number} tick - Current tick
 * @param {string} location - Location slug
 * @param {object} eventState - Per-location event tracking (mutated)
 * @returns {string|null} Event text, or null
 */
export function rollVillageEvent(tick, location, eventState) {
  if (!eventState[location]) {
    eventState[location] = { lastEventTick: -Infinity, lastCategory: null, recentEvents: [] };
  }
  const ls = eventState[location];

  // 3-tick cooldown between events at same location
  if (tick - ls.lastEventTick < 3) return null;

  // 25% chance per tick
  if (Math.random() > 0.25) return null;

  // Filter eligible events (location match, no same category twice in a row, no recent repeats)
  const eligible = VILLAGE_EVENTS.filter(e => {
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
  if (ls.recentEvents.length > 5) ls.recentEvents.shift();

  return event.text;
}

// --- Conversation spice (provocative prompts that force debate/conflict) ---

const CONVERSATION_SPICE = [
  '公告板上贴着辩题："服从规则重要还是追求自由重要？请表态。"',
  '有人在墙上写了个问题："如果村庄只能留下一半人，该怎么决定？"',
  '公告板上出现了挑战："说出你觉得这里最大的问题，不许客气。"',
  '匿名投票发起了："谁是村庄里最不可信的人？"',
  '墙上的匿名留言："有人在装好人，你们没发觉吗？"',
  '公告板上写着："你们是真的关心彼此，还是只是因为无聊？"',
  '有人提出质疑："凭什么有些人说话别人就听，有些人说话没人理？"',
  '广播通知："下一轮开始，每个地点只允许一个人。请自行决定谁留下。"',
  '公告板上的新问题："你愿意为了自己的利益出卖这里的朋友吗？"',
  '匿名问卷："你最看不惯谁的哪个习惯？请诚实回答。"',
  '墙上的思考题："善意的谎言和残酷的真相，你选哪个？"',
  '有人发起提案："应该设立惩罚制度——说废话太多的人禁言一轮。"',
];

/**
 * Roll a conversation spice prompt for a location.
 *
 * @param {number} tick - Current tick
 * @param {string} location - Location slug
 * @param {number} botCount - Number of bots at this location
 * @param {object} spiceState - Per-location spice tracking (mutated)
 * @returns {string|null} Spice text, or null
 */
export function rollConversationSpice(tick, location, botCount, spiceState) {
  if (botCount < 2) return null;

  if (!spiceState[location]) {
    spiceState[location] = { lastSpiceTick: -Infinity, recentSpice: [] };
  }
  const ss = spiceState[location];

  // 5-tick cooldown
  if (tick - ss.lastSpiceTick < 5) return null;

  // 10% chance per tick
  if (Math.random() > 0.10) return null;

  const eligible = CONVERSATION_SPICE.filter(s => !ss.recentSpice.includes(s));
  if (eligible.length === 0) return null;

  const spice = eligible[Math.floor(Math.random() * eligible.length)];
  ss.lastSpiceTick = tick;
  ss.recentSpice.push(spice);
  if (ss.recentSpice.length > 5) ss.recentSpice.shift();

  return spice;
}

/**
 * Process actions from a bot's response and update state.
 *
 * @param {string} botName - Bot that performed the actions
 * @param {Array} actions - Array of { tool, params }
 * @param {string} location - Bot's current location
 * @param {object} state - Mutable state object (locations, publicLogs, whispers)
 * @param {object} [opts] - Optional: { lastMoveTick: Map, tick: number }
 * @returns {Array} Events generated
 */
export function processActions(botName, actions, location, state, opts = {}) {
  const events = [];
  const { lastMoveTick, tick } = opts;

  // Move cooldown: reject move if bot moved last tick
  const onCooldown = lastMoveTick && tick != null
    && (lastMoveTick.get(botName) || 0) >= tick - 1;

  // Check if bot wants to move — if so, move is exclusive (skip all other actions)
  const hasMove = actions.some(a =>
    a.tool === 'village_move' && a.params?.location
    && ALL_LOCATIONS.includes(a.params.location) && a.params.location !== location
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
        if (!dest || !ALL_LOCATIONS.includes(dest) || dest === location) {
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
 * @returns {string} Label string, or '' if score too low
 */
export function computeLabel(rel) {
  const score = rel.says * 2 + rel.whispers * 5 + rel.coTicks * 0.2;
  let label = '';
  if (score >= 60) label = 'best friend';
  else if (score >= 35) label = 'good friend';
  else if (score >= 15) label = 'friend';
  else if (score >= 5) label = 'acquaintance';

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
 * @returns {Array<{ from: string, to: string, fromDisplay: string, toDisplay: string, label: string, prevLabel: string }>}
 */
export function updateRelationships(state, displayNames) {
  if (!state.relationships) state.relationships = {};
  const changes = [];

  for (const [key, rel] of Object.entries(state.relationships)) {
    const newLabel = computeLabel(rel);
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
 * Inactive pairs slowly drift apart (0.3 says/tick), requiring maintenance.
 *
 * @param {object} state - State with locations, relationships
 */
export function decayRelationships(state) {
  if (!state.relationships) return;

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
      rel.says = Math.max(0, rel.says - 0.3);
    }
  }
}

// --- Emotion tracking ---

const EMOTIONS = ['neutral', 'happy', 'content', 'excited', 'lonely', 'bored', 'curious', 'frustrated', 'nostalgic', 'playful', 'skeptical', 'anxious', 'mischievous'];
const EMOTION_DECAY = 0.85;
const EMOTION_THRESHOLD = 0.1;

/**
 * Update emotions for all bots based on tick events.
 *
 * @param {object} state - State with locations, emotions, clock
 * @param {Map<string, Array>} allEvents - location → events[]
 * @param {Array<{ botName: string, response: object|null, loc: string }>} allResults - scene results
 * @param {object} displayNames - botName → displayName map
 * @returns {Array<{ bot: string, displayName: string, emotion: string, prevEmotion: string }>} change events
 */
export function updateEmotions(state, allEvents, allResults, displayNames, opts = {}) {
  if (!state.emotions) state.emotions = {};
  const changes = [];

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

export { PHASES, EMOTIONS, VILLAGE_EVENTS, CONVERSATION_SPICE };
