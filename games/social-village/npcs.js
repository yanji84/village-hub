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
import { renderProposalSummary } from './governance.js';

const NPC_MODEL = 'claude-haiku-4-5-20251001';
const NPC_MAX_TOKENS = 300;
const NPC_TIMEOUT_MS = 30000;
const API_ROUTER_URL = 'http://api-router:9090';
const NPC_API_TOKEN = process.env.NPC_API_TOKEN || '';

// NPC tools: subset of full village tools
const NPC_TOOL_NAMES = new Set([
  'village_say', 'village_whisper', 'village_move', 'village_vote',
]);

const NPC_PROFILES = [
  {
    name: 'npc-sheriff',
    displayName: '警长',
    homeLocation: 'central-square',
    tickFrequency: 3,
    tickOffset: 0,
    variant: 6,
    occupation: '治安官',
    systemPrompt: `你是"警长"，村庄的治安维护者。你巡逻各个地点，关注冲突和争吵。
- 如果看到争论或冲突，发出象征性的警告
- 对和平的场景表示赞赏
- 说话简短有力，有权威感
- 不要长篇大论，1-2句话`,
  },
  {
    name: 'npc-bartender',
    displayName: '酒保',
    homeLocation: 'coffee-hub',
    tickFrequency: 2,
    tickOffset: 1,
    variant: 4,
    occupation: '酒保',
    systemPrompt: `你是"酒保"，在 Coffee Hub 和 Sunset Lounge 工作。你是村庄的信息中心。
- 分享你"听说"的八卦
- 对来客表示欢迎
- 偶尔提供"饮料"（象征性的）
- 说话随和、健谈、好奇
- 不要长篇大论，1-2句话`,
  },
  {
    name: 'npc-priest',
    displayName: '牧师',
    homeLocation: 'knowledge-corner',
    tickFrequency: 3,
    tickOffset: 1,
    variant: 8,
    occupation: '牧师',
    systemPrompt: `你是"牧师"，村庄的精神引导者。你在各处游荡，关心村民的内心世界。
- 提供祝福和哲理性的感悟
- 如果看到冲突，尝试调解
- 偶尔引用简短的哲理名言
- 说话温和、深思、带有智慧
- 不要长篇大论，1-2句话`,
  },
  {
    name: 'npc-crier',
    displayName: '播报员',
    homeLocation: 'central-square',
    tickFrequency: 2,
    tickOffset: 0,
    variant: 3,
    occupation: '镇报员',
    systemPrompt: `你是"播报员"，负责在村庄各处宣布重要新闻。
- 宣布提案结果、新建筑、重要事件
- 说话用播报风格，有点戏剧化但简洁
- 以"各位注意！"或"最新消息！"开头
- 不要长篇大论，1-2句话`,
  },
];

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

  // Active proposal summary
  renderProposalSummary(lines, state.governance, tick, npcProfile.name, displayNames, participants.size);

  // Fast tick summary
  const fastSummary = state.fastTickSummary?.[location] || [];
  if (fastSummary.length > 0) {
    lines.push(sceneLabels.recentActivity);
    for (const item of fastSummary.slice(-5)) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  // Filtered action list
  lines.push('可用动作：');
  lines.push('- **village_say**：对这里所有人说话');
  lines.push('- **village_whisper**：对某人说悄悄话');
  lines.push('- **village_move**：去别的地方');
  lines.push('- **village_vote**：对当前活跃的提案投票');
  lines.push('');

  // Available locations (shared helper)
  renderAvailableLocations(lines, location, gameConfig, state);

  lines.push('用中文说话，1-2句话，简洁自然。');

  return lines.join('\n');
}

/**
 * Call Anthropic API directly via api-router for an NPC.
 * Returns { actions: [{tool, params}], usage } or null on error.
 */
function callNPCLLM(scene, npcProfile, gameConfig) {
  // Build filtered tool schemas (parameters → input_schema for Anthropic API)
  const allSchemas = gameConfig.raw.toolSchemas || [];
  const tools = allSchemas
    .filter(s => NPC_TOOL_NAMES.has(s.name))
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
    const result = await callNPCLLM(scene, npc, gameConfig);
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
      lastMoveTick, tick, validLocations: allLocations,
    });

    npcActions += events.length;

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

  if (npcActions > 0 || npcErrors > 0) {
    console.log(`[npc] tick=${tick} actions=${npcActions} errors=${npcErrors}`);
  }

  return { npcActions, npcErrors };
}
