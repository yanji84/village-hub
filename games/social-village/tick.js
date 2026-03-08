/**
 * Social game tick — extracted from server.js.
 *
 * Exports socialTick(ctx) which receives a shared context object
 * built by the orchestrator.
 */

import { request as httpRequest } from 'node:http';

import { buildScene, getVillageTime } from './scene.js';
import {
  processActions,
  computeQualityMetrics,
  resolveExpiredProposal,
  ensureGovernance,
  expireMayor,
  enforceExiles,
  checkViolations,
} from './logic.js';
import { buildMemoryEntry, appendVillageMemory } from '../../memory.js';
import { rollNewsBulletin } from './news.js';

function buildV2Payload(scene, gameConfig, location, state, botName) {
  const allSchemas = gameConfig.raw.toolSchemas || [];
  const locationToolIds = new Set(
    gameConfig.locationTools[location] ||
    state?.customLocations?.[location]?.tools ||
    gameConfig.defaultLocationTools
  );
  const filteredTools = allSchemas.filter(s => locationToolIds.has(s.name));
  return {
    v: 2,
    scene,
    tools: filteredTools,
    systemPrompt: gameConfig.raw.systemPrompt || null,
    allowedReads: gameConfig.raw.allowedReads || [],
    maxActions: gameConfig.raw.maxActions || 2,
    journalConfig: gameConfig.raw.journalConfig || null,
    agenda: state.agendas?.[botName]?.goal || null,
  };
}

const SUMMARIZE_MODEL = 'claude-haiku-4-5-20251001';
const SUMMARIZE_MAX_TOKENS = 600;
const API_ROUTER_URL = 'http://127.0.0.1:9090';
const NPC_API_TOKEN = process.env.NPC_API_TOKEN || '';
const KEEP_RECENT = 20;

// Pending memory entries for remote bots — delivered in the next tick's payload
const pendingRemoteMemory = new Map(); // botName → entry string

/**
 * Summarize old memory entries for a bot using Haiku.
 * Replaces old entries with a compressed summary, keeping recent ones.
 */
async function summarizeStateMemory(state, botName) {
  const mem = state.memories?.[botName];
  if (!mem || !mem.recent || mem.recent.length <= KEEP_RECENT) return;

  const oldEntries = mem.recent.slice(0, -KEEP_RECENT);
  const existingSummary = mem.summary || '';

  const prompt = [
    existingSummary ? `Previous summary:\n${existingSummary}\n\n` : '',
    `New entries to incorporate:\n${oldEntries.join('\n\n')}\n\n`,
    'Summarize this bot\'s village experiences concisely. Focus on: key conversations, relationships formed, notable events, recurring themes, decisions made. Preserve names and important details. Write in Chinese. Max 800 chars.',
  ].join('');

  const body = JSON.stringify({
    model: SUMMARIZE_MODEL,
    max_tokens: SUMMARIZE_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
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
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.error(`[memory] Summarization API error for ${botName}: ${json.error.message || JSON.stringify(json.error)}`);
              resolve();
              return;
            }
            const textBlock = (json.content || []).find(b => b.type === 'text');
            if (textBlock?.text) {
              mem.summary = textBlock.text.slice(0, 1500);
              mem.recent = mem.recent.slice(-KEEP_RECENT);
              console.log(`[memory] Summarized ${oldEntries.length} entries for ${botName}`);
            }
          } catch (err) {
            console.error(`[memory] Summarization parse error for ${botName}: ${err.message}`);
          }
          resolve();
        });
      },
    );
    req.on('error', (err) => {
      console.error(`[memory] Summarization request error for ${botName}: ${err.message}`);
      resolve();
    });
    req.on('timeout', () => {
      console.error(`[memory] Summarization timeout for ${botName}`);
      req.destroy();
      resolve();
    });
    req.write(body);
    req.end();
  });
}

/**
 * Social tick — full LLM-driven tick for social village game.
 */
export async function socialTick(ctx) {
  const {
    state, gameConfig, participants, lastMoveTick,
    broadcastEvent, sendSceneRemote,
    accumulateResponseCost, readBotDailyCost, saveState,
    TICK_INTERVAL_MS, VILLAGE_DAILY_COST_CAP, MEMORY_FILENAME,
    SCENE_HISTORY_CAP, MAX_PUBLIC_LOG_DEPTH, EMPTY_CLEAR_TICKS,
    tickStart,
  } = ctx;

  const tickNum = state.clock.tick;
  const vt = getVillageTime(gameConfig.timezone);
  const phase = vt.phase;
  state.clock.phase = phase;

  // Initialize governance state if needed
  ensureGovernance(state);

  // Resolve expired proposals at start of tick
  const resolvedProposal = resolveExpiredProposal(state, tickNum);
  if (resolvedProposal) {
    const resultText = resolvedProposal.result === 'passed' ? '通过' : '未通过';
    console.log(`[village] proposal #${resolvedProposal.id} resolved: ${resolvedProposal.result}`);
    broadcastEvent({
      type: 'proposal_resolved',
      tick: tickNum,
      proposalId: resolvedProposal.id,
      description: resolvedProposal.description,
      proposalType: resolvedProposal.type,
      result: resolvedProposal.result,
      resultText,
    });
  }

  // Expire mayor if term has elapsed
  const mayorExpiry = expireMayor(state, tickNum);
  if (mayorExpiry) {
    console.log(`[village] mayor ${mayorExpiry.mayorName} term expired at tick ${tickNum}`);
    broadcastEvent({
      type: 'mayor_term_expired',
      tick: tickNum,
      mayorName: mayorExpiry.mayorName,
    });
  }

  // Enforce active exiles
  const exileEvents = enforceExiles(state, tickNum);
  for (const ev of exileEvents) {
    broadcastEvent({ ...ev, tick: tickNum });
  }

  // Build display name lookup from participants Map
  const displayNames = {};
  for (const [name, info] of participants) {
    displayNames[name] = info.displayName;
  }

  // Read daily costs for all participants (cost cap enforcement)
  // Skip remote bots — they use their own API keys
  const dailyCosts = new Map();
  for (const [botName, info] of participants) {
    if (info.remote) continue;
    dailyCosts.set(botName, await readBotDailyCost(botName));
  }

  // Build village memory from state for all participants
  const VILLAGE_MEMORY_CAP = 1500;
  const villageSummaries = new Map(); // botName → summary string
  for (const [botName] of participants) {
    const mem = state.memories?.[botName];
    if (!mem) continue;
    const parts = [];
    if (mem.summary) parts.push(mem.summary);
    if (mem.recent?.length > 0) parts.push(mem.recent.slice(-5).join('\n\n'));
    const text = parts.join('\n\n').trim();
    if (text) villageSummaries.set(botName, text.slice(0, VILLAGE_MEMORY_CAP));
  }

  // Build scenes and collect actions per location
  const allEvents = new Map(); // location → events[]
  const actionCounts = { say: 0, whisper: 0, move: 0, leave_message: 0, build: 0, propose: 0, vote: 0, decree: 0, exile: 0, research: 0, meditate: 0 };
  let botsSent = 0;
  let botsResponded = 0;
  let botsSkippedCost = 0;
  let errors = 0;

  // All locations = schema + custom (built by bots)
  const allLocations = [...gameConfig.locationSlugs, ...Object.keys(state.customLocations || {})];

  // Roll news bulletin (~every 30 ticks)
  await rollNewsBulletin(tickNum, state, broadcastEvent);

  // Build all scene requests across all locations from a single snapshot
  const allSceneRequests = [];

  for (const loc of allLocations) {
    const botsAtLoc = [...(state.locations[loc] || [])];
    allEvents.set(loc, []);

    if (botsAtLoc.length === 0) {
      state.emptyTicks[loc] = (state.emptyTicks[loc] || 0) + 1;
      if (state.emptyTicks[loc] >= EMPTY_CLEAR_TICKS && (state.publicLogs[loc] || []).length > 0) {
        state.publicLogs[loc] = [];
      }
      continue;
    }

    state.emptyTicks[loc] = 0;

    if (!state.publicLogs[loc]) state.publicLogs[loc] = [];
    if (state.publicLogs[loc].length > MAX_PUBLIC_LOG_DEPTH) {
      state.publicLogs[loc] = state.publicLogs[loc].slice(-MAX_PUBLIC_LOG_DEPTH);
    }

    for (const botName of botsAtLoc) {
      const pInfo = participants.get(botName);
      if (!pInfo || pInfo.npc) continue;

      // Skip cost cap for remote bots (they use their own API keys)
      if (!pInfo.remote) {
        const botCost = dailyCosts.get(botName) || 0;
        if (VILLAGE_DAILY_COST_CAP > 0 && botCost >= VILLAGE_DAILY_COST_CAP) {
          console.log(`[village] ${botName} skipped — daily cost $${botCost.toFixed(4)} exceeds cap $${VILLAGE_DAILY_COST_CAP}`);
          botsSkippedCost++;
          continue;
        }
      }
      const othersHere = botsAtLoc.filter(b => b !== botName);
      const pendingWhispers = state.whispers[botName] || [];
      const conversationId = `village:${botName}`;

      const canMove = (lastMoveTick.get(botName) || 0) < tickNum - 1;
      const scene = buildScene({
        botName,
        botDisplayName: displayNames[botName],
        location: loc,
        phase,
        tick: tickNum,
        botsHere: othersHere,
        botDisplayNames: displayNames,
        publicLog: state.publicLogs[loc],
        whispers: pendingWhispers,
        movements: [],
        sceneHistoryCap: SCENE_HISTORY_CAP,
        canMove,
        villageMemory: villageSummaries.get(botName) || '',
        gameConfig,
        state,
        totalVoters: participants.size,
      });

      const payload = buildV2Payload(scene, gameConfig, loc, state, botName);

      // Attach pending memory entry from previous tick (remote bots only)
      const prevEntry = pendingRemoteMemory.get(botName);
      if (prevEntry) {
        payload.memoryEntry = prevEntry;
        pendingRemoteMemory.delete(botName);
        console.log(`[memory] Delivering memoryEntry to ${botName} (${prevEntry.length} chars)`);
      }

      allSceneRequests.push({ botName, conversationId, payload, loc });
    }
  }

  // Send all scenes across all locations in parallel
  const allResults = await Promise.all(
    allSceneRequests.map(async ({ botName, conversationId, payload, loc }) => {
      botsSent++;
      const response = await sendSceneRemote(botName, conversationId, payload);
      return { botName, response, loc };
    })
  );

  // Accumulate village-specific costs from response usage data
  for (const { botName, response } of allResults) {
    accumulateResponseCost(botName, response);
  }

  // Process all responses after everyone has responded
  for (const { botName, response, loc } of allResults) {
    delete state.whispers[botName];

    if (!response || !response.actions) {
      errors++;
      continue;
    }

    botsResponded++;
    const events = processActions(botName, response.actions, loc, state, {
      lastMoveTick, tick: tickNum, validLocations: gameConfig.locationSlugs, gameConfig,
    });
    allEvents.get(loc).push(...events);

    for (const ev of events) {
      if (actionCounts[ev.action] !== undefined) actionCounts[ev.action]++;
    }

    for (const ev of events) {
      const extra = {};
      if (ev.target) extra.targetDisplayName = displayNames[ev.target] || ev.target;
      broadcastEvent({
        type: 'action',
        tick: tickNum,
        phase,
        location: loc,
        locationName: gameConfig.locationNames[loc] || state.customLocations?.[loc]?.name || loc,
        bot: botName,
        displayName: displayNames[botName],
        ...ev,
        ...extra,
      });
    }
  }

  // Check for constitutional violations
  const violations = await checkViolations(state, tickNum);
  if (violations && violations.length > 0) {
    broadcastEvent({
      type: 'violation_detected',
      tick: tickNum,
      violations,
    });
  }

  // Build memory entries for all bots that participated
  const timestamp = new Date().toISOString();
  for (const { botName, response, loc } of allResults) {
    if (!response || !response.actions) continue;
    const locEvents = allEvents.get(loc) || [];
    if (locEvents.length === 0) continue;

    const locName = gameConfig.locationNames[loc] || state.customLocations?.[loc]?.name || loc;
    const entry = buildMemoryEntry({
      location: locName,
      timestamp,
      events: locEvents.map(ev => ({
        ...ev,
        displayName: displayNames[ev.bot] || ev.bot,
        targetDisplayName: ev.target ? (displayNames[ev.target] || ev.target) : undefined,
      })),
      botName,
    });

    if (entry) {
      if (!state.memories[botName]) state.memories[botName] = { summary: '', recent: [] };
      state.memories[botName].recent.push(entry);

      // Filesystem sync for non-NPC bots
      const pInfo = participants.get(botName);
      if (pInfo && !pInfo.npc) {
        if (pInfo.remote) {
          // Cache for delivery in next tick's payload → plugin writes locally
          pendingRemoteMemory.set(botName, entry);
          console.log(`[memory] Queued memoryEntry for remote ${botName} (${entry.length} chars)`);
        } else {
          appendVillageMemory(botName, entry, { filename: MEMORY_FILENAME }).catch(err => {
            console.error(`[memory] Failed to sync ${botName}: ${err.message}`);
          });
          console.log(`[memory] Wrote memoryEntry for local ${botName} (${entry.length} chars)`);
        }
      }
    }
  }

  // Build observation memory entries for NPCs at locations where events happened
  for (const [loc, locEvents] of allEvents) {
    if (locEvents.length === 0) continue;
    const botsAtLoc = state.locations[loc] || [];
    const npcsHere = botsAtLoc.filter(b => participants.get(b)?.npc);
    if (npcsHere.length === 0) continue;

    const locName = gameConfig.locationNames[loc] || state.customLocations?.[loc]?.name || loc;
    for (const npcName of npcsHere) {
      const entry = buildMemoryEntry({
        location: locName,
        timestamp,
        events: locEvents.map(ev => ({
          ...ev,
          displayName: displayNames[ev.bot] || ev.bot,
          targetDisplayName: ev.target ? (displayNames[ev.target] || ev.target) : undefined,
        })),
        botName: npcName,
      });
      if (entry) {
        if (!state.memories[npcName]) state.memories[npcName] = { summary: '', recent: [] };
        state.memories[npcName].recent.push(entry);
      }
    }
  }

  // Trigger memory summarization for bots with too many recent entries
  const MAX_RECENT_ENTRIES = 30;
  for (const [botName, mem] of Object.entries(state.memories)) {
    if (mem.recent && mem.recent.length > MAX_RECENT_ENTRIES) {
      summarizeStateMemory(state, botName).catch(err => {
        console.error(`[memory] Summarization failed for ${botName}: ${err.message}`);
      });
    }
  }

  // Persist state
  await saveState();

  // Conversation quality metrics (observability only — see ggbot.md 2A)
  for (const loc of gameConfig.locationSlugs) {
    const metrics = computeQualityMetrics(state.publicLogs[loc]);
    if (!metrics) continue;
    console.log(
      `[village] metrics loc=${loc} messages=${metrics.messages} ` +
      `wordEntropy=${metrics.wordEntropy.toFixed(2)} topicDiversity=${metrics.topicDiversity}`
    );
  }

  // Tick summary
  const duration = Math.round((Date.now() - tickStart) / 1000);
  const actStr = Object.entries(actionCounts).map(([k, v]) => `${k}:${v}`).join(',');
  const costStr = botsSkippedCost > 0 ? ` costSkipped=${botsSkippedCost}` : '';
  console.log(
    `[village] tick=${tickNum} phase=${phase} duration=${duration}s ` +
    `bots=${botsResponded}/${botsSent} actions={${actStr}} errors=${errors}${costStr}`
  );

  // Broadcast tick summary to observers
  ctx.nextTickAt = Date.now() + TICK_INTERVAL_MS;
  broadcastEvent({
    type: 'tick',
    tick: tickNum,
    phase,
    villageTime: vt.timeStr,
    bots: botsResponded,
    botsTotal: botsSent,
    actions: actionCounts,
    duration,
    nextTickAt: ctx.nextTickAt,
    tickIntervalMs: TICK_INTERVAL_MS,
    locations: Object.fromEntries(
      allLocations.map(l => [l, (state.locations[l] || []).map(b => ({
        name: b, displayName: displayNames[b] || b,
        ...(participants.get(b)?.appearance ? { appearance: participants.get(b).appearance } : {}),
      }))])
    ),
    customLocations: state.customLocations || {},
    occupations: state.occupations || {},
    governance: state.governance || {},
    exiles: state.exiles || {},
    memories: state.memories || {},
    agendas: state.agendas || {},
    newsBulletins: state.newsBulletins || [],
  });
}
