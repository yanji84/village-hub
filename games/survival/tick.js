/**
 * Survival game tick — extracted from server.js.
 *
 * Exports survivalTick(ctx) and fastTick(ctx) which receive a shared
 * context object built by the orchestrator.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { buildSurvivalScene, getDayPhase } from './scene.js';
import { generateWorld, mulberry32, respawnResources } from './world.js';
import {
  processActions as processSurvivalActions,
  resolveCombat,
  tickSurvival,
  handleDeath,
  initScores,
  awardPoints,
  buildScoreboard,
  processAllianceActions,
  detectBetrayal,
  recordBetrayal,
  tickAllianceBonuses,
  getBountyBot,
} from './logic.js';
import { runFastTick } from './autopilot.js';
import { appendVillageMemory, buildMemoryEntry } from '../../memory.js';
import { needsSummarization, summarizeVillageMemory } from '../../summarize.js';

function buildV2Payload(scene, gameConfig) {
  return {
    v: 2,
    scene,
    tools: gameConfig.raw.toolSchemas || [],
    systemPrompt: gameConfig.raw.systemPrompt || null,
    allowedReads: gameConfig.raw.allowedReads || [],
    maxActions: gameConfig.raw.maxActions || 2,
  };
}

const require = createRequire(import.meta.url);
const paths = require('../../../lib/paths');

/**
 * Fast tick — autopilot movement/gathering between slow ticks.
 */
export function fastTick(ctx) {
  const { state, gameConfig, participants, broadcastEvent } = ctx;

  if (!state.terrain) return;

  const displayNames = {};
  for (const [name, info] of participants) {
    displayNames[name] = info.displayName;
  }

  // Snapshot bots already at 0 HP before fast tick (they haven't been respawned yet)
  const alreadyDead = new Set();
  if (state.round && gameConfig.raw.scoring) {
    for (const [name, bs] of Object.entries(state.bots)) {
      if (bs.health <= 0) alreadyDead.add(name);
    }
  }

  const { events, positionUpdates } = runFastTick(state, gameConfig);

  // Score autopilot events
  // Only score kills/deaths for bots that were alive at start of this fast tick
  if (state.round && gameConfig.raw.scoring) {
    const killedThisTick = new Set();
    for (const ev of events) {
      if (ev.action === 'gather' && ev.bot) {
        awardPoints(state.round.scores, ev.bot, 'gather', gameConfig);
      }
      if (ev.action === 'move' && ev.bot && ev.to) {
        if (!state.round.explored) state.round.explored = {};
        if (!state.round.explored[ev.bot]) state.round.explored[ev.bot] = {};
        const tileKey = `${ev.to.x},${ev.to.y}`;
        if (!state.round.explored[ev.bot][tileKey]) {
          state.round.explored[ev.bot][tileKey] = 1;
          awardPoints(state.round.scores, ev.bot, 'explore', gameConfig);
        }
      }
      if (ev.action === 'killed' && ev.bot && !alreadyDead.has(ev.bot) && !killedThisTick.has(ev.bot)) {
        killedThisTick.add(ev.bot);
        awardPoints(state.round.scores, ev.bot, 'death', gameConfig);
      }
    }
    // Award kill points only for fresh kills this tick (not already-dead bots)
    for (const ev of events) {
      if (ev.action === 'attack' && ev.bot && killedThisTick.has(ev.target)) {
        awardPoints(state.round.scores, ev.bot, 'kill', gameConfig);
        killedThisTick.delete(ev.target); // one kill reward per death
      }
    }
  }

  for (const ev of events) {
    broadcastEvent({
      type: 'survival_event',
      tick: state.clock.tick,
      bot: ev.bot,
      displayName: displayNames[ev.bot] || ev.bot,
      ...ev,
    });
  }

  if (Object.keys(positionUpdates).length > 0) {
    broadcastEvent({ type: 'fast_tick', positions: positionUpdates });
  }
}

/**
 * Survival (grid game) tick — full LLM-driven tick.
 */
export async function survivalTick(ctx) {
  const {
    state, gameConfig, participants,
    broadcastEvent, sendScene, sendSceneRemote,
    accumulateResponseCost, readBotDailyCost, saveState,
    TICK_INTERVAL_MS, VILLAGE_DAILY_COST_CAP, MEMORY_FILENAME,
    tickStart,
  } = ctx;

  const tickNum = state.clock.tick;
  const dayPhase = getDayPhase(tickNum, gameConfig.raw.dayNight);
  const rng = mulberry32(state.worldSeed + tickNum);

  // Build display name lookup
  const displayNames = {};
  for (const [name, info] of participants) {
    displayNames[name] = info.displayName;
  }

  // --- Round lifecycle ---
  if (gameConfig.raw.scoring) {
    // Ensure round state exists
    if (!state.round) {
      state.round = {
        number: 1,
        ticksRemaining: gameConfig.raw.scoring.roundLength,
        scores: initScores(state.bots),
        roundHistory: [],
      };
    }

    state.round.ticksRemaining--;

    // Award survival tick points to all alive bots
    for (const [botName, bs] of Object.entries(state.bots)) {
      if (bs.alive) awardPoints(state.round.scores, botName, 'survivalTick', gameConfig);
    }

    // Round end check
    if (state.round.ticksRemaining <= 0) {
      const scoreboard = buildScoreboard(state.round.scores, displayNames);
      const winner = scoreboard[0];

      // Archive round
      state.round.roundHistory.push({
        number: state.round.number,
        winner: winner?.bot || null,
        winnerDisplayName: winner?.displayName || null,
        scores: { ...state.round.scores },
        endedAt: new Date().toISOString(),
      });

      // Cap history at 20 rounds
      if (state.round.roundHistory.length > 20) {
        state.round.roundHistory = state.round.roundHistory.slice(-20);
      }

      // Broadcast round_end event
      broadcastEvent({
        type: 'round_end',
        round: state.round.number,
        scoreboard,
        winner: winner?.bot || null,
        winnerDisplayName: winner?.displayName || null,
      });

      // Start new round
      state.round.number++;
      state.round.ticksRemaining = gameConfig.raw.scoring.roundLength;
      state.round.scores = initScores(state.bots);
      state.round.explored = {};
    }
  }

  // Ensure diplomacy state exists
  if (gameConfig.raw.diplomacy && !state.diplomacy) {
    state.diplomacy = { alliances: {}, proposals: {}, betrayals: [] };
  }

  // Read daily costs for cost cap enforcement
  const dailyCosts = new Map();
  for (const [botName, info] of participants) {
    if (info.remote) continue;
    dailyCosts.set(botName, await readBotDailyCost(botName));
  }

  // 1. Tick survival (hunger/health drain)
  const survivalEvents = tickSurvival(state.bots, gameConfig.raw.survival);
  const allEvents = [...survivalEvents];

  // 2. Handle deaths from starvation
  for (const ev of survivalEvents) {
    if (ev.action === 'starved') {
      if (state.round) {
        awardPoints(state.round.scores, ev.bot, 'death', gameConfig);
      }
      const deathEvents = handleDeath(
        ev.bot, state.bots[ev.bot], state,
        gameConfig.raw.survival, gameConfig.raw.world.terrain,
        rng, gameConfig.raw.world.width, gameConfig.raw.world.height
      );
      allEvents.push(...deathEvents);
    }
  }

  // 3. Respawn resources
  const respawned = respawnResources(state.tileData, state.terrain, gameConfig.raw.world, tickNum, rng);
  const respawnedCoords = respawned.map(k => { const [x, y] = k.split(',').map(Number); return { x, y }; });
  if (respawned.length > 0) {
    console.log(`[village] ${respawned.length} tiles respawned resources`);
  }

  // 4. Read village memory summaries
  const VILLAGE_MEMORY_CAP = 1500;
  const villageSummaries = new Map();
  for (const [botName, info] of participants) {
    if (info.remote) continue;
    try {
      const memPath = join(paths.memoryDir(botName), MEMORY_FILENAME);
      const content = await readFile(memPath, 'utf-8');
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
    } catch { /* no memory file or no summary yet */ }
  }

  // 5. Build scenes per bot and send in parallel
  const allSceneRequests = [];
  let botsSent = 0;
  let botsResponded = 0;
  let botsSkippedCost = 0;
  let errors = 0;

  // Filter visible events per bot (events near them)
  for (const [botName, botState] of Object.entries(state.bots)) {
    if (!botState.alive) continue;
    if (!participants.has(botName)) continue;

    const botCost = dailyCosts.get(botName) || 0;
    if (VILLAGE_DAILY_COST_CAP > 0 && botCost >= VILLAGE_DAILY_COST_CAP) {
      botsSkippedCost++;
      continue;
    }

    const { port } = participants.get(botName);

    // Filter recent events to ones near this bot
    const visibleEvents = allEvents.filter(ev => {
      if (ev.bot === botName) return true;
      if (ev.x !== undefined && ev.y !== undefined) {
        const dist = Math.sqrt(Math.pow(botState.x - ev.x, 2) + Math.pow(botState.y - ev.y, 2));
        return dist <= 10;
      }
      return true;
    });

    const scene = buildSurvivalScene({
      botName,
      botState,
      worldState: state,
      gameConfig,
      currentTick: tickNum,
      recentEvents: [...(state.recentEvents || []).slice(-10), ...visibleEvents],
      villageSummary: villageSummaries.get(botName) || '',
      isScout: false,
      fastTickStats: botState.fastTickStats || null,
      round: state.round || null,
      displayNames,
      diplomacy: state.diplomacy || null,
    });

    const conversationId = `survival:${botName}`;
    const payload = buildV2Payload(scene, gameConfig);
    allSceneRequests.push({ botName, port, conversationId, payload });
  }

  // Broadcast thinking state for all bots being sent scenes
  for (const { botName } of allSceneRequests) {
    broadcastEvent({ type: 'thinking', bot: botName, thinking: true });
  }

  // Send scenes in parallel
  const allResults = await Promise.all(
    allSceneRequests.map(async ({ botName, port, conversationId, payload }) => {
      botsSent++;
      const info = participants.get(botName);
      const response = info?.remote
        ? await sendSceneRemote(botName, conversationId, payload)
        : await sendScene(botName, port, conversationId, payload);
      return { botName, response };
    })
  );

  // Clear thinking state
  for (const { botName } of allSceneRequests) {
    broadcastEvent({ type: 'thinking', bot: botName, thinking: false });
  }

  // Accumulate costs
  for (const { botName, response } of allResults) {
    accumulateResponseCost(botName, response);
  }

  // 6. Collect responses — resolve combat simultaneously, process other actions
  const pendingAttacks = [];
  const actionEvents = [];

  for (const { botName, response } of allResults) {
    if (!response || !response.actions) {
      errors++;
      continue;
    }

    botsResponded++;
    const botState = state.bots[botName];
    if (!botState) continue;

    // Set current tick for directive timestamping
    botState._currentTick = tickNum;

    const { events: evts, pendingAttacks: atks } = processSurvivalActions(
      botName, response.actions, botState, state, gameConfig, displayNames
    );
    actionEvents.push(...evts);
    pendingAttacks.push(...atks);

    // Score gather/craft/explore events
    if (state.round) {
      for (const ev of evts) {
        if (ev.action === 'gather') awardPoints(state.round.scores, botName, 'gather', gameConfig);
        if (ev.action === 'craft') awardPoints(state.round.scores, botName, 'craft', gameConfig);
        if (ev.action === 'move') {
          // Track explored tiles per round
          if (!state.round.explored) state.round.explored = {};
          if (!state.round.explored[botName]) state.round.explored[botName] = {};
          const tileKey = `${ev.to.x},${ev.to.y}`;
          if (!state.round.explored[botName][tileKey]) {
            state.round.explored[botName][tileKey] = 1;
            awardPoints(state.round.scores, botName, 'explore', gameConfig);
          }
        }
      }
    }

    // Reset fast-tick stats after slow tick processes
    botState.fastTickStats = {
      tilesMoved: 0,
      itemsGathered: [],
      damageDealt: 0,
      damageTaken: 0,
    };
  }

  // Simultaneous combat resolution
  const combatEvents = resolveCombat(pendingAttacks, state.bots, gameConfig);
  actionEvents.push(...combatEvents);

  // Handle combat deaths + scoring
  for (const ev of combatEvents) {
    if (ev.action === 'killed') {
      const bs = state.bots[ev.bot];
      if (bs && bs.health <= 0) {
        // Score: death penalty for killed bot
        if (state.round) {
          awardPoints(state.round.scores, ev.bot, 'death', gameConfig);
        }
        // Score: kill points for attackers + betrayal/bounty bonuses
        if (state.round) {
          const bountyBot = getBountyBot(state.round.scores);
          for (const atk of pendingAttacks) {
            if (atk.target === ev.bot) {
              awardPoints(state.round.scores, atk.attacker, 'kill', gameConfig);
              // Betrayal bonus
              if (state.diplomacy && detectBetrayal(atk.attacker, ev.bot, state.diplomacy)) {
                awardPoints(state.round.scores, atk.attacker, 'betrayalKill', gameConfig);
                const betrayalEvents = recordBetrayal(atk.attacker, ev.bot, state.diplomacy, tickNum);
                actionEvents.push(...betrayalEvents);
              }
              // Bounty bonus
              if (ev.bot === bountyBot) {
                awardPoints(state.round.scores, atk.attacker, 'bountyKill', gameConfig);
                actionEvents.push({ action: 'bounty_kill', bot: atk.attacker, target: ev.bot, tick: tickNum });
              }
            }
          }
        }
        const deathEvents = handleDeath(
          ev.bot, bs, state,
          gameConfig.raw.survival, gameConfig.raw.world.terrain,
          rng, gameConfig.raw.world.width, gameConfig.raw.world.height
        );
        actionEvents.push(...deathEvents);
      }
    }
  }

  allEvents.push(...actionEvents);

  // 6b. Diplomacy — process alliance say messages + proximity bonuses
  if (state.diplomacy && gameConfig.raw.diplomacy) {
    if (!state.diplomacy.alliances) state.diplomacy.alliances = {};
    if (!state.diplomacy.proposals) state.diplomacy.proposals = {};
    if (!state.diplomacy.betrayals) state.diplomacy.betrayals = [];

    const sayEvents = allEvents.filter(ev => ev.action === 'say');
    const allianceEvents = processAllianceActions(sayEvents, state.diplomacy, state.bots, tickNum, gameConfig.raw.diplomacy, displayNames);
    allEvents.push(...allianceEvents);

    // Alliance proximity bonus
    if (state.round) {
      const bonusEvents = tickAllianceBonuses(state.diplomacy, state.bots, state.round.scores, gameConfig);
      allEvents.push(...bonusEvents);
    }
  }

  // 7. Broadcast events
  for (const ev of allEvents) {
    broadcastEvent({
      type: 'survival_event',
      tick: tickNum,
      dayPhase: dayPhase.name,
      bot: ev.bot,
      displayName: displayNames[ev.bot] || ev.bot,
      ...ev,
    });
  }

  // Cap recentEvents at 50
  state.recentEvents = allEvents.slice(-50);

  // 8. Write memories per bot
  const timestamp = new Date().toISOString();
  for (const [botName, botState] of Object.entries(state.bots)) {
    if (!participants.has(botName)) continue;
    if (participants.get(botName).remote) continue;

    const botEvents = allEvents.filter(ev => {
      if (ev.bot === botName) return true;
      if (ev.x !== undefined && ev.y !== undefined) {
        const dist = Math.sqrt(Math.pow(botState.x - ev.x, 2) + Math.pow(botState.y - ev.y, 2));
        return dist <= 10;
      }
      // Death/respawn are global knowledge; say is proximity-only (handled by x,y check above)
      return ev.action === 'death' || ev.action === 'respawn';
    });

    if (botEvents.length > 0) {
      try {
        const entry = buildMemoryEntry({
          location: `(${botState.x},${botState.y})`,
          timestamp,
          events: botEvents,
          botName,
        });
        if (entry.trim()) {
          await appendVillageMemory(botName, entry, { filename: MEMORY_FILENAME });
        }
      } catch (err) {
        console.error(`[village] Failed to write memory for ${botName}: ${err.message}`);
      }
    }
  }

  // Summarize oversized memory files
  for (const [botName, info] of participants) {
    if (info.remote) continue;
    needsSummarization(botName, { filename: MEMORY_FILENAME }).then(needed => {
      if (needed) summarizeVillageMemory(botName, { filename: MEMORY_FILENAME });
    }).catch(() => {});
  }

  // 9. Save state
  await saveState();

  // Tick summary
  const duration = Math.round((Date.now() - tickStart) / 1000);
  const costStr = botsSkippedCost > 0 ? ` costSkipped=${botsSkippedCost}` : '';
  console.log(
    `[village] tick=${tickNum} phase=${dayPhase.name} duration=${duration}s ` +
    `bots=${botsResponded}/${botsSent} events=${allEvents.length} errors=${errors}${costStr}`
  );

  // Broadcast tick summary
  ctx.nextTickAt = Date.now() + TICK_INTERVAL_MS;
  // Collect depleted tiles from gather events
  const depletedTiles = allEvents
    .filter(ev => ev.action === 'gather' && ev.depleted && ev.x !== undefined)
    .map(ev => ({ x: ev.x, y: ev.y }));

  broadcastEvent({
    type: 'tick',
    tick: tickNum,
    dayPhase: dayPhase.name,
    bots: botsResponded,
    botsTotal: botsSent,
    events: allEvents.length,
    duration,
    nextTickAt: ctx.nextTickAt,
    tickIntervalMs: TICK_INTERVAL_MS,
    botStates: Object.fromEntries(
      Object.entries(state.bots).map(([name, bs]) => [name, {
        x: bs.x, y: bs.y, health: bs.health, hunger: bs.hunger, alive: bs.alive,
        equipment: bs.equipment, inventory: bs.inventory,
        displayName: displayNames[name] || name,
        directive: bs.directive || null,
        seenTileCount: bs.seenTiles ? Object.keys(bs.seenTiles).length : 0,
      }])
    ),
    resourceChanges: (depletedTiles.length > 0 || respawnedCoords.length > 0)
      ? { depleted: depletedTiles, respawned: respawnedCoords }
      : undefined,
    round: state.round ? {
      number: state.round.number,
      ticksRemaining: state.round.ticksRemaining,
      scores: state.round.scores,
    } : undefined,
    diplomacy: state.diplomacy ? {
      alliances: state.diplomacy.alliances,
      proposals: state.diplomacy.proposals,
      betrayals: state.diplomacy.betrayals,
      bountyBot: state.round ? getBountyBot(state.round.scores) : null,
    } : undefined,
  });
}
