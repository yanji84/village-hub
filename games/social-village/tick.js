/**
 * Social game tick — extracted from server.js.
 *
 * Exports socialTick(ctx) which receives a shared context object
 * built by the orchestrator.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { buildScene, getVillageTime } from './scene.js';
import { generateAppearance } from './appearance.js';
import {
  processActions,
  computeQualityMetrics,
  rollVillageEvent,
  rollConversationSpice,
} from './logic.js';
import { updateSocialDynamics } from './relationship-engine.js';

function buildV2Payload(scene, gameConfig) {
  return {
    v: 2,
    scene,
    tools: gameConfig.raw.toolSchemas || [],
    systemPrompt: gameConfig.raw.systemPrompt || null,
    allowedReads: gameConfig.raw.allowedReads || [],
    maxActions: gameConfig.raw.maxActions || 2,
    journalConfig: gameConfig.raw.journalConfig || null,
  };
}

const require = createRequire(import.meta.url);
const paths = require('../../../lib/paths');

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

  // Read village memory summaries for all participants
  // Skip remote bots — no local memory file
  const VILLAGE_MEMORY_CAP = 1500;
  const villageSummaries = new Map(); // botName → summary string
  for (const [botName, info] of participants) {
    if (info.remote) continue;
    try {
      const memPath = join(paths.memoryDir(botName), MEMORY_FILENAME);
      const content = await readFile(memPath, 'utf-8');
      // Extract "## Village History (summarized)" section
      const start = content.indexOf('## Village History (summarized)');
      if (start !== -1) {
        const afterHeader = content.indexOf('\n', start);
        const nextSection = content.indexOf('\n## ', afterHeader + 1);
        const summaryText = nextSection !== -1
          ? content.slice(afterHeader + 1, nextSection).trim()
          : content.slice(afterHeader + 1).trim();
        if (summaryText) {
          villageSummaries.set(botName, summaryText.slice(0, VILLAGE_MEMORY_CAP));
        }
      }
    } catch { /* no village.md or no summary yet */ }
  }

  // Build scenes and collect actions per location
  const allEvents = new Map(); // location → events[]
  const actionCounts = { say: 0, whisper: 0, observe: 0, move: 0, decorate: 0, leave_message: 0, explore: 0, build: 0, set_occupation: 0, propose_bond: 0 };
  let botsSent = 0;
  let botsResponded = 0;
  let botsSkippedCost = 0;
  let errors = 0;

  // All locations = schema + custom (built by bots)
  const allLocations = [...gameConfig.locationSlugs, ...Object.keys(state.customLocations || {})];

  // Roll village events and conversation spice for occupied locations
  const activeEvents = new Map();  // location → event text
  const activeSpice = new Map();   // location → spice text
  for (const loc of allLocations) {
    const botsAtLoc = state.locations[loc] || [];
    if (botsAtLoc.length === 0) continue;
    const event = rollVillageEvent(tickNum, loc, state.eventState, gameConfig);
    if (event) {
      activeEvents.set(loc, event);
      console.log(`[village] event at ${loc}: ${event}`);
      broadcastEvent({ type: 'village_event', tick: tickNum, location: loc, locationName: gameConfig.locationNames[loc], text: event });
    }
    const spice = rollConversationSpice(tickNum, loc, botsAtLoc.length, state.spiceState, gameConfig);
    if (spice) {
      activeSpice.set(loc, spice);
      console.log(`[village] spice at ${loc}: ${spice}`);
      broadcastEvent({ type: 'conversation_spice', tick: tickNum, location: loc, locationName: gameConfig.locationNames[loc], text: spice });
    }
  }

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
      if (!participants.has(botName)) continue;

      const pInfo = participants.get(botName);

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
        relationships: state.relationships,
        emotions: state.emotions,
        canMove,
        villageMemory: villageSummaries.get(botName) || '',
        villageEvent: activeEvents.get(loc) || '',
        conversationSpice: activeSpice.get(loc) || '',
        fastTickSummary: state.fastTickSummary?.[loc] || [],
        gameConfig,
        state,
      });

      const payload = buildV2Payload(scene, gameConfig);
      allSceneRequests.push({ botName, conversationId, payload, loc });
    }
  }

  // Clear fast tick summary buffer — scenes have captured it
  state.fastTickSummary = {};

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
      lastMoveTick, tick: tickNum, validLocations: gameConfig.locationSlugs,
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

  // Regenerate appearance for bots whose occupation changed this tick
  for (const { botName, response } of allResults) {
    if (!response?.actions) continue;
    for (const action of response.actions) {
      if (action.tool === 'village_set_occupation') {
        const title = state.occupations?.[botName]?.title || null;
        try {
          const newAppearance = await generateAppearance(botName, title);
          const pInfo = participants.get(botName);
          if (pInfo) pInfo.appearance = newAppearance;
          broadcastEvent({
            type: 'appearance_update', tick: tickNum,
            bot: botName, appearance: newAppearance,
          });
        } catch { /* non-critical */ }
        break; // only one occupation change per bot per tick
      }
    }
  }

  // Update social dynamics (relationships + emotions)
  const { relationshipChanges, emotionChanges } = updateSocialDynamics({
    state, allEvents, allResults, displayNames, activeEvents, activeSpice, gameConfig,
  });
  for (const change of relationshipChanges) {
    broadcastEvent({
      type: 'relationship', tick: tickNum,
      from: change.from, to: change.to,
      fromDisplay: change.fromDisplay, toDisplay: change.toDisplay,
      label: change.label, prevLabel: change.prevLabel,
    });
    console.log(`[village] relationship: ${change.fromDisplay} & ${change.toDisplay} → ${change.label || '(none)'}`);
  }
  for (const change of emotionChanges) {
    broadcastEvent({
      type: 'emotion', tick: tickNum,
      bot: change.bot, displayName: change.displayName,
      emotion: change.emotion, prevEmotion: change.prevEmotion,
    });
    console.log(`[village] emotion: ${change.displayName} → ${change.emotion}`);
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
    relationships: state.relationships,
    emotions: state.emotions,
    customLocations: state.customLocations || {},
    occupations: state.occupations || {},
    bonds: state.bonds || {},
  });
}
