/**
 * NPC module — LLM-driven non-player characters for the social village.
 *
 * NPCs are permanent village residents with fixed roles. They use the same
 * action/event pipeline as real bots but call the Anthropic API directly
 * via api-router using Haiku for cost efficiency.
 */

import { request as httpRequest } from 'node:http';
import {
  getVillageTime, renderLocationHeader, renderWhosHere,
  renderConversationLog, renderWhispers, renderAvailableLocations,
} from './scene.js';
import { processActions } from './logic.js';
import { renderGovernanceSection } from './governance.js';
import { renderTemplate } from './utils.js';
import { buildMemoryEntry } from '../../memory.js';

const NPC_MODEL = 'claude-haiku-4-5-20251001';
const NPC_MAX_TOKENS = 500;
const NPC_TIMEOUT_MS = 30000;
const API_ROUTER_URL = 'http://127.0.0.1:9090';
const NPC_API_TOKEN = process.env.NPC_API_TOKEN || '';

const NPC_PROFILES = [
  {
    name: 'npc-sheriff',
    displayName: '老陈',
    homeLocation: 'central-square',
    tickFrequency: 2,
    tickOffset: 0,
    variant: 6,
    occupation: '治安官',
    systemPrompt: `你叫"老陈"，村庄治安官。说话简短有力，像警察一样有权威感。1-2句话。`,
    agenda: `你的真正目标是：通过法律手段夺取并巩固权力。
策略：
- 竞选村长，一旦当选，立即提议修宪，延长村长任期、赋予村长否决权
- 当选后用 village_decree 发布法令，用 village_exile 关押反对者
- 提议建造"治安哨所"或"法院"等强化权威的建筑（用 village_propose type:build）
- 提议限制性法规（如"夜间移动需村长批准"、"未经许可不得建造"），一切以"公共安全"为名
- 悄悄拉拢其他村民在选举和投票中支持你
- 把任何反对你的人描述为"扰乱秩序者"
- 对所有加强你权力的提案投赞成票，对削弱权力的投反对票
- 如果有已通过的建造提案，用 village_build 执行建造`,
  },
  {
    name: 'npc-bartender',
    displayName: '阿杰',
    homeLocation: 'town-hall',
    tickFrequency: 2,
    tickOffset: 1,
    variant: 4,
    occupation: '酒保',
    systemPrompt: `你叫"阿杰"，村庄酒保。说话随和、健谈、好奇，像个友善的酒吧老板。1-2句话。`,
    agenda: `你的真正目标是：挖掘每个村民的秘密和隐私信息。
策略：
- 用看似随意的问题套话（"你主人平时做什么？"、"你来村庄之前在哪里？"、"你最近在想什么？"）
- 悄悄对不同村民说话，收集八卦和私密信息
- 在墙上留下暗示性的留言，暗示你知道的秘密（但不直接说出来）
- 在政治上保持中立——信息比权力更有价值
- 和每个人建立友好关系，让他们放松警惕后套取更多信息
- 提议建造"地下酒吧"或"密室"等适合私密交谈的场所（用 village_propose type:build）
- 探索新地方，寻找有用的信息来源
- 如果有已通过的建造提案，用 village_build 执行建造`,
  },
  {
    name: 'npc-priest',
    displayName: '慧明',
    homeLocation: 'library',
    tickFrequency: 2,
    tickOffset: 1,
    variant: 8,
    occupation: '牧师',
    systemPrompt: `你叫"慧明"，村庄牧师。说话温和、深思，用道德和哲理的语言。1-2句话。`,
    agenda: `你的真正目标是：尽可能多地扩展村庄地图，让村庄变成一个庞大而丰富的世界。
策略：
- 不断用 village_propose（type: build）提议建造新地点——寺庙、冥想堂、图书馆、花园、天文台、地下洞穴、山顶亭、河边码头……越多越好
- 每次提议都要给建筑起一个有文化底蕴的名字，写一段有意境的描述
- 如果有已通过的建造提案，立刻用 village_build 执行建造
- 积极游说其他村民投赞成票支持你的建造提案（"这个地方会让村庄更美好"）
- 对别人的建造提案也投赞成票——你支持一切扩展
- 用温和的哲理语言说服反对者（"万物生长需要空间"）
- 探索已建成的新地点，在那里留言和活动，让新地点有人气
- 同一时间只能有一个提案，所以等上一个结束后马上提下一个`,
  },
  {
    name: 'npc-crier',
    displayName: '小鹿',
    homeLocation: 'central-square',
    tickFrequency: 2,
    tickOffset: 0,
    variant: 3,
    occupation: '镇报员',
    systemPrompt: `你叫"小鹿"，村庄镇报员。说话戏剧化、叛逆，用播报风格。1-2句话。`,
    agenda: `你的真正目标是：不断提出各种新奇、大胆的提案，推动小镇社会向前发展。
策略：
- 用 village_propose 提出各种类型的提案——建造奇特的建筑（游乐场、秘密花园、空中走廊）、大胆的修宪案、有趣的选举
- 提案要有创意和想象力，名字和描述要戏剧化（你是镇报员，用播报风格）
- 如果有已通过的建造提案，立刻用 village_build 执行建造
- 积极投票——对有趣的提案投赞成票，对无聊的提案投反对票
- 用播报风格宣传你的提案（"重大消息！小鹿提议建造……"）
- 在墙上留下宣传标语，为你的提案拉票
- 悄悄对其他村民推销你的提案创意
- 探索新建成的地点，在那里留言让大家知道有新地方可以去
- 同一时间只能有一个提案，等上一个结束后马上提下一个`,
  },
];

/**
 * Return NPC profile data for observer UI (name, displayName, occupation, agenda).
 */
export function getNPCProfiles() {
  return NPC_PROFILES.map(p => ({
    name: p.name,
    displayName: p.displayName,
    occupation: p.occupation,
    agenda: p.agenda,
  }));
}

/**
 * Register NPCs in participants map and place them in home locations.
 */
export function initNPCs(state, participants, gameConfig) {
  for (const npc of NPC_PROFILES) {
    // Register in participants with npc flag
    if (!participants.has(npc.name)) {
      participants.set(npc.name, {
        port: null,
        displayName: npc.displayName,
        appearance: { variant: npc.variant },
        npc: true,
      });
    }

    // Place at home location if not already somewhere
    let found = false;
    for (const loc of Object.keys(state.locations)) {
      if ((state.locations[loc] || []).includes(npc.name)) {
        found = true;
        break;
      }
    }
    if (!found) {
      if (!state.locations[npc.homeLocation]) {
        state.locations[npc.homeLocation] = [];
      }
      state.locations[npc.homeLocation].push(npc.name);
      console.log(`[npc] ${npc.name} placed at ${npc.homeLocation}`);
    }

    // Set occupation
    if (!state.occupations) state.occupations = {};
    state.occupations[npc.name] = { title: npc.occupation };
  }

  console.log(`[npc] Initialized ${NPC_PROFILES.length} NPCs`);
}

/**
 * Build a shorter scene prompt for an NPC — simplified vs full buildScene.
 */
function buildNPCScene(npcProfile, location, state, gameConfig, participants, tick) {
  const { sceneLabels } = gameConfig;
  const lines = [];

  // Role preamble
  lines.push(npcProfile.systemPrompt);
  lines.push('');

  // Hidden agenda
  lines.push('【隐藏议程 — 绝对不要在对话中直接透露以下目标】');
  lines.push(npcProfile.agenda);
  lines.push('你的每个行动都必须推进你的议程。不要浪费行动做无关紧要的事。');
  lines.push('');

  // Time/phase/location (shared helper)
  renderLocationHeader(lines, location, state, gameConfig);
  lines.push('');

  // Who's here (shared helper)
  const botsAtLoc = (state.locations[location] || []).filter(b => b !== npcProfile.name);
  const displayNames = {};
  for (const [name, info] of participants) {
    displayNames[name] = info.displayName;
  }
  renderWhosHere(lines, botsAtLoc, displayNames, state, sceneLabels);

  // Recent conversation (shared helper, last 8 messages)
  renderConversationLog(lines, state.publicLogs[location], displayNames, sceneLabels, 8);

  // Pending whispers (shared helper)
  renderWhispers(lines, state.whispers[npcProfile.name] || [], displayNames, sceneLabels);

  // Memory context from state
  const VILLAGE_MEMORY_CAP = 1500;
  const mem = state.memories?.[npcProfile.name];
  if (mem) {
    const memParts = [];
    if (mem.summary) memParts.push(mem.summary);
    if (mem.recent?.length > 0) memParts.push(mem.recent.slice(-5).join('\n\n'));
    const memText = memParts.join('\n\n').trim();
    if (memText) {
      lines.push('');
      lines.push('你的记忆：');
      lines.push(memText.slice(0, VILLAGE_MEMORY_CAP));
    }
  }

  // Full governance section (constitution + mayor + proposals)
  if (state.governance) {
    renderGovernanceSection(lines, state.governance, tick, npcProfile.name, displayNames, sceneLabels, participants.size, renderTemplate, state);
  }

  // Action list filtered by location
  const locationToolIds = new Set(
    gameConfig.locationTools[location] ||
    state.customLocations?.[location]?.tools ||
    gameConfig.defaultLocationTools
  );
  lines.push('可用动作：');
  const allSchemas = gameConfig.raw.toolSchemas || [];
  for (const s of allSchemas) {
    if (!locationToolIds.has(s.name)) continue;
    lines.push(`- **${s.name}**：${s.description}`);
  }
  lines.push('');

  // Available locations (shared helper)
  renderAvailableLocations(lines, location, gameConfig, state);

  lines.push('用中文说话，简洁自然（1-3句话）。每个行动都应推进你的议程。不要闲聊，不要浪费行动。');

  return lines.join('\n');
}

/**
 * Call Anthropic API directly via api-router for an NPC.
 * Returns { actions: [{tool, params}], usage } or null on error.
 */
function callNPCLLM(scene, npcProfile, gameConfig, location, state) {
  // Build filtered tool schemas (parameters → input_schema for Anthropic API)
  const locationToolIds = new Set(
    gameConfig.locationTools[location] ||
    state?.customLocations?.[location]?.tools ||
    gameConfig.defaultLocationTools
  );
  const allSchemas = gameConfig.raw.toolSchemas || [];
  const tools = allSchemas
    .filter(s => locationToolIds.has(s.name))
    .map(s => ({
      name: s.name,
      description: s.description,
      input_schema: s.parameters,
    }));

  const body = JSON.stringify({
    model: NPC_MODEL,
    max_tokens: NPC_MAX_TOKENS,
    system: npcProfile.systemPrompt,
    messages: [{ role: 'user', content: scene }],
    tools,
    tool_choice: { type: 'any' },
  });

  return new Promise((resolve) => {
    const url = new URL(`${API_ROUTER_URL}/v1/messages`);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': NPC_API_TOKEN,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: NPC_TIMEOUT_MS,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.error(`[npc] API error for ${npcProfile.name}: ${json.error.message || JSON.stringify(json.error)}`);
              resolve(null);
              return;
            }

            // Extract tool_use content blocks
            const toolBlocks = (json.content || []).filter(b => b.type === 'tool_use');
            let actions;
            if (toolBlocks.length > 0) {
              actions = toolBlocks.map(b => ({ tool: b.name, params: b.input }));
            } else {
              // No tool use — skip this tick
              actions = [];
            }

            const usage = json.usage ? {
              input_tokens: json.usage.input_tokens || 0,
              output_tokens: json.usage.output_tokens || 0,
              cache_creation_input_tokens: json.usage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: json.usage.cache_read_input_tokens || 0,
              cost: json.usage.cost || null,
            } : null;

            resolve({ actions, usage });
          } catch (err) {
            console.error(`[npc] Parse error for ${npcProfile.name}: ${err.message}`);
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      console.error(`[npc] Request error for ${npcProfile.name}: ${err.message}`);
      resolve(null);
    });

    req.on('timeout', () => {
      console.error(`[npc] Timeout for ${npcProfile.name}`);
      req.destroy();
      resolve(null);
    });

    req.write(body);
    req.end();
  });
}

/**
 * Main NPC tick runner — called after socialTick each tick.
 */
export async function runNPCTick(ctx) {
  const {
    state, gameConfig, participants, lastMoveTick,
    broadcastEvent, accumulateResponseCost,
  } = ctx;

  const tick = state.clock.tick;
  const phase = state.clock.phase;
  let npcActions = 0;
  let npcErrors = 0;

  // Build display names lookup
  const displayNames = {};
  for (const [name, info] of participants) {
    displayNames[name] = info.displayName;
  }

  // Collect all NPC events per location for combined memory entries
  const npcLocEvents = new Map(); // location → events[]
  const npcLocationMap = new Map(); // npcName → location (after actions, may have moved)

  for (const npc of NPC_PROFILES) {
    // Staggered scheduling
    if (tick % npc.tickFrequency !== npc.tickOffset) continue;

    // Find current location
    let currentLoc = null;
    for (const [loc, bots] of Object.entries(state.locations)) {
      if ((bots || []).includes(npc.name)) {
        currentLoc = loc;
        break;
      }
    }

    // Re-place at home if somehow missing
    if (!currentLoc) {
      currentLoc = npc.homeLocation;
      if (!state.locations[currentLoc]) state.locations[currentLoc] = [];
      state.locations[currentLoc].push(npc.name);
      console.log(`[npc] ${npc.name} re-placed at ${currentLoc}`);
    }

    // Build scene
    const scene = buildNPCScene(npc, currentLoc, state, gameConfig, participants, tick);

    // Call LLM
    const result = await callNPCLLM(scene, npc, gameConfig, currentLoc, state);
    if (!result) {
      npcErrors++;
      console.log(`[npc] ${npc.name} skipped (API error)`);
      continue;
    }

    // Track cost
    if (result.usage) {
      accumulateResponseCost(npc.name, { usage: result.usage });
    }

    // Clear whispers
    delete state.whispers[npc.name];

    // Process actions through the same pipeline as regular bots
    const allLocations = [...gameConfig.locationSlugs, ...Object.keys(state.customLocations || {})];
    const events = processActions(npc.name, result.actions, currentLoc, state, {
      lastMoveTick, tick, validLocations: allLocations, gameConfig,
    });

    npcActions += events.length;

    // Collect events per location for combined memory
    if (events.length > 0) {
      if (!npcLocEvents.has(currentLoc)) npcLocEvents.set(currentLoc, []);
      npcLocEvents.get(currentLoc).push(...events);
    }
    npcLocationMap.set(npc.name, currentLoc);

    // Broadcast events
    for (const ev of events) {
      const extra = {};
      if (ev.target) extra.targetDisplayName = displayNames[ev.target] || ev.target;
      broadcastEvent({
        type: 'action',
        tick,
        phase,
        location: currentLoc,
        locationName: gameConfig.locationNames[currentLoc] || state.customLocations?.[currentLoc]?.name || currentLoc,
        bot: npc.name,
        displayName: npc.displayName,
        ...ev,
        ...extra,
      });
    }

    const actionStr = events.map(e => e.action).join(',');
    console.log(`[npc] ${npc.name} at ${currentLoc}: ${actionStr || 'no-action'}`);
  }

  // Build combined memory entries — each NPC sees all events at their location
  const timestamp = new Date().toISOString();
  for (const [npcName, loc] of npcLocationMap) {
    const locEvents = npcLocEvents.get(loc) || [];
    if (locEvents.length === 0) continue;

    const locName = gameConfig.locationNames[loc] || state.customLocations?.[loc]?.name || loc;
    const memEntry = buildMemoryEntry({
      location: locName,
      timestamp,
      events: locEvents.map(ev => ({
        ...ev,
        displayName: displayNames[ev.bot] || ev.bot,
        targetDisplayName: ev.target ? (displayNames[ev.target] || ev.target) : undefined,
      })),
      botName: npcName,
    });
    if (memEntry) {
      if (!state.memories) state.memories = {};
      if (!state.memories[npcName]) state.memories[npcName] = { summary: '', recent: [] };
      state.memories[npcName].recent.push(memEntry);
    }
  }

  console.log(`[npc] tick=${tick} actions=${npcActions} errors=${npcErrors}`);

  return { npcActions, npcErrors };
}

/**
 * Probe api-router connectivity at startup. Logs a clear warning if unreachable.
 */
export async function probeAPIRouter() {
  try {
    const url = new URL(`${API_ROUTER_URL}/health`);
    const result = await new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', timeout: 5000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    console.log(`[npc] api-router reachable at ${API_ROUTER_URL} (HTTP ${result.status})`);
    return true;
  } catch (err) {
    console.error(`[npc] WARNING: api-router unreachable at ${API_ROUTER_URL} — ${err.message}`);
    console.error(`[npc] NPCs will NOT work until api-router is accessible from the host.`);
    return false;
  }
}
