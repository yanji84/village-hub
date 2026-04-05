/**
 * Village Orchestrator — generic world runtime.
 *
 * Manages state, tick loop, scene dispatch, action processing, and serves
 * an observer web UI via SSE.
 *
 * World-specific logic lives in the adapter module which exports:
 *   initState(worldConfig)            → world-specific initial state
 *   phases                            → { phaseName: { turn, tools, scene, transitions, onEnter? } }
 *   tools                             → { toolName: (bot, params, state) → entry|null }
 *   onJoin?(state, botName, displayName)  → extra event fields (optional)
 *   onLeave?(state, botName, displayName) → extra event fields (optional)
 *   checkInvariant?(state)               → string|null (optional, dev-mode sanity check)
 *
 * Adapter phase definition:
 *   turn: 'parallel' | 'round-robin' | 'none'
 *   tools: string[]                   — tool names available in this phase
 *   scene: (bot, ctx) → string        — ctx = { allBots, state, worldConfig, phase, log }
 *   transitions: [{ to, when: (state) → bool }]
 *   onEnter?: (state) → void
 *
 * Tool handlers return entries with a visibility field:
 *   visibility: 'public' | 'private' | 'targets'
 *   targets?: string[]                — required when visibility is 'targets'
 *
 * Built-in thought convention:
 *   If a tool handler returns an entry with a `thought` field, the runtime
 *   automatically extracts it and emits a separate private log entry
 *   (visible only to the acting bot in scenes, but streamed to observers via SSE).
 *   This lets any tool support private reasoning without adapter wiring.
 *
 * Uses Node.js built-ins only.
 */

import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { loadWorld } from './world-loader.js';
import { callLLM } from './lib/llm-caller.js';

const _require = createRequire(import.meta.url);
const ivm = _require('isolated-vm');

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load world schema ---
const VILLAGE_WORLD = process.env.VILLAGE_WORLD || 'social-village';
const WORLD_DIR = process.env.VILLAGE_WORLD_DIR
  || join(__dirname, 'worlds', VILLAGE_WORLD);
const worldConfig = loadWorld(join(WORLD_DIR, 'schema.json'));
const worldId = worldConfig.raw.id;
const MAX_TABLE_PLAYERS = 4;
console.log(`[village] Loaded world: ${worldId} (${worldConfig.raw.name})`);

// --- Load adapter ---
const adapter = await import(pathToFileURL(join(WORLD_DIR, 'adapter.js')).href);
const adapterPhases = adapter.phases;
const adapterTools = adapter.tools;
const phaseNames = Object.keys(adapterPhases);
const initialPhase = phaseNames[0];

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const REMOTE_SCENE_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES_REMOTE = 5;
const PORTAL_URL = process.env.VILLAGE_RELAY_URL || 'http://127.0.0.1:3000';
const LOG_CAP = 50;
const MAX_HANDS_PER_SESSION = 20;
const EVOLUTION_INTERVAL = 500;

const TOURNAMENT_LOBBY_DURATION = 60000;  // 60s lobby countdown
const TOURNAMENT_RESULTS_DURATION = 30000; // 30s results display
const TOURNAMENT_STARTING_CHIPS = 1000;
const TOURNAMENT_POINTS = [0, 10, 7, 5, 3, 2, 1]; // index = position (1st=10, 2nd=7, ...)
const TOURNAMENT_AI_SEATS = 2;
const TOURNAMENT_HUMAN_SEATS = 2;
const TOURNAMENT_MAX_HISTORY = 20;
const TOURNAMENT_BRACKET_SIZE = 16;       // 16 bots → 4 QF matches of 4 → 1 final of 4
const TOURNAMENT_MATCH_PAUSE_MS = 10000;  // 10s pause between bracket matches
// Bracket points: Champion=15, Finalist 2nd=10, 3rd=7, 4th=5, QF losers=1-3 by placement
const BRACKET_POINTS_FINALIST = [0, 15, 10, 7, 5]; // index = final placement (1-4)
const BRACKET_POINTS_QF_LOSER = [0, 3, 2, 1]; // index = QF elimination order within match (1st out=1pt, 2nd=2pt, 3rd=3pt)

const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || '120000', 10);
const MIN_TICK_GAP_MS = parseInt(process.env.VILLAGE_MIN_TICK_GAP || '3000', 10); // minimum pause between ticks
const _dataDir = process.env.VILLAGE_DATA_DIR;
const STATE_FILE = _dataDir ? join(_dataDir, `state-${VILLAGE_WORLD}.json`) : join(__dirname, `state-${VILLAGE_WORLD}.json`);
const LOGS_DIR = _dataDir ? join(_dataDir, 'logs') : join(__dirname, 'logs');
const HANDS_DIR = _dataDir ? join(_dataDir, 'hands') : join(__dirname, 'hands');

// --- Event log file (JSONL, one file per day) ---
let logDate = '';   // 'YYYY-MM-DD'
let logFile = '';   // full path to current day's .jsonl

// Async log buffer — batches writes within a 100ms window to avoid
// blocking the event loop with a sync write on every world event.
const _logBuffer = [];
let _logFlushTimer = null;

function _flushLogBuffer() {
  _logFlushTimer = null;
  if (!_logBuffer.length || !logFile) return;
  const lines = _logBuffer.splice(0).join('');
  appendFile(logFile, lines).catch(err => {
    console.error(`[village] Failed to flush event log: ${err.message}`);
  });
}

function flushLogBufferSync() {
  if (_logFlushTimer) { clearTimeout(_logFlushTimer); _logFlushTimer = null; }
  _flushLogBuffer();
}

// --- State ---
let state = {};

let tickInProgress = false;
let tickStartedAt = 0;
let nextTickAt = 0;
let startTime = Date.now();

// --- Observer SSE connections ---
const observers = new Set(); // { res, botName }

// --- Participants (event-driven, updated by /api/join and /api/leave) ---
const participants = new Map(); // botName → { displayName }
const failureCounts = new Map(); // botName → consecutive failure count

// --- Load/Save state ---

async function loadState() {
  // Try primary state file
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
    const worldDefaults = adapter.initState(worldConfig);
    state = { ...worldDefaults, ...raw };
    ensureRuntimeFields();
    return;
  } catch { /* primary failed or missing */ }

  // Fallback to backup
  try {
    const raw = JSON.parse(await readFile(STATE_FILE + '.bak', 'utf-8'));
    const worldDefaults = adapter.initState(worldConfig);
    state = { ...worldDefaults, ...raw };
    ensureRuntimeFields();
    console.warn('[village] Primary state was corrupt/missing — recovered from backup');
    return;
  } catch { /* backup also failed */ }

  // Initialize fresh state
  const worldState = adapter.initState(worldConfig);
  state = {
    clock: { tick: 0, phase: initialPhase, phaseEnteredAt: 0, roundRobinIndex: 0 },
    bots: [],
    log: [],
    villageCosts: {},
    remoteParticipants: {},
    ...worldState,
  };
  console.log('[village] Fresh state initialized');
}

function ensureRuntimeFields() {
  if (!state.clock) state.clock = { tick: 0 };
  if (!state.clock.phase) state.clock.phase = initialPhase;
  if (!state.clock.phaseEnteredAt) state.clock.phaseEnteredAt = state.clock.tick;
  if (state.clock.roundRobinIndex == null) state.clock.roundRobinIndex = 0;
  if (!state.bots) state.bots = [];
  if (!state.log) state.log = [];
  if (!state.villageCosts) state.villageCosts = {};
  if (!state.remoteParticipants) state.remoteParticipants = {};
  if (!state.waitlist) state.waitlist = [];
  if (!state.playerStats) state.playerStats = {};
  if (!state.handHistory) state.handHistory = [];
  if (!state.playerGameRecords) state.playerGameRecords = {};
  if (!state.tournament) state.tournament = {
    number: 0,
    phase: 'lobby',
    lobbyStartedAt: null,
    lobbyDuration: 60000,
    startingChips: 1000,
    placements: [],
    aiSeats: [],
    humanSeats: [],
    points: {},
    history: [],
    bracket: null,
  };
  // Migrate old tournament state: if phase is 'playing', reset to lobby
  // (old format doesn't have bracket data, so a restart is safest)
  if (state.tournament && state.tournament.phase === 'playing') {
    state.tournament.phase = 'lobby';
    state.tournament.bracket = null;
  }
}

// --- Visibility helper ---

function isVisibleTo(entry, botName) {
  if (!entry.visibility || entry.visibility === 'public') return true;
  if (entry.visibility === 'private') return entry.bot === botName;
  if (entry.visibility === 'targets') {
    return entry.bot === botName || (entry.targets || []).includes(botName);
  }
  return true;
}

let _saveInProgress = false;
let _savePending    = false;

async function saveState() {
  if (_saveInProgress) { _savePending = true; return; }
  _saveInProgress = true;
  try {
    const tmpFile = STATE_FILE + '.tmp';
    const bakFile = STATE_FILE + '.bak';
    await writeFile(tmpFile, JSON.stringify(state, null, 2) + '\n');
    try { await copyFile(STATE_FILE, bakFile); } catch { /* no existing state to backup */ }
    await rename(tmpFile, STATE_FILE);
  } catch (err) {
    console.error(`[village] Failed to save state: ${err.message}`);
  } finally {
    _saveInProgress = false;
    if (_savePending) { _savePending = false; saveState(); }
  }
}

// --- Cost tracking ---

function accumulateResponseCost(botName, response) {
  if (!response?.usage) return;
  const cost = response.usage.cost?.total
    || response.usage.cost
    || 0;
  if (typeof cost === 'number' && cost > 0) {
    state.villageCosts[botName] = (state.villageCosts[botName] || 0) + cost;
  }
}

// --- Auth helper ---

function validateVillageSecret(req) {
  if (!VILLAGE_SECRET) return false;
  const auth = req.headers.authorization || '';
  const expected = `Bearer ${VILLAGE_SECRET}`;
  if (auth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

// --- JSON body parser ---

const MAX_BODY_BYTES = 256 * 1024; // 256 KB

async function readJsonBody(req) {
  const chunks = [];
  let totalLen = 0;
  for await (const chunk of req) {
    totalLen += chunk.length;
    if (totalLen > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

// --- Remove bot (runtime manages lists + optional adapter hook) ---

function removeBot(botName, reason) {
  const displayName = participants.get(botName)?.displayName
    || state.remoteParticipants?.[botName]?.displayName
    || botName;

  const idx = state.bots.indexOf(botName);
  if (idx !== -1) state.bots.splice(idx, 1);
  participants.delete(botName);
  failureCounts.delete(botName);
  if (state.remoteParticipants?.[botName]) delete state.remoteParticipants[botName];

  // Optional adapter hook — may mutate state and return extra event fields
  const extra = adapter.onLeave?.(state, botName, displayName) || {};

  // Auto-log leave to state.log (adapters don't need to do this themselves)
  const leaveEntry = {
    bot: botName,
    displayName,
    action: 'leave',
    message: extra.message || `${displayName} left.`,
    visibility: 'public',
    tick: state.clock.tick,
    timestamp: new Date().toISOString(),
  };
  state.log.push(leaveEntry);

  // Strip reserved keys from extra to prevent log/SSE divergence
  const { action: _a, message: _m, bot: _b, displayName: _d, visibility: _v, tick: _t, timestamp: _ts, ...safeExtra } = extra;

  broadcastEvent({
    type: `${worldId}_leave`,
    ...leaveEntry,
    ...safeExtra,
  });
  console.log(`[village] ${botName} removed (${reason})`);
}

// --- Startup recovery: rebuild participants from state ---

function recoverParticipants() {
  const toRemove = [];
  for (const botName of (state.bots || [])) {
    const entry = state.remoteParticipants?.[botName];
    if (!entry) { toRemove.push(botName); continue; }
    participants.set(botName, { displayName: entry.displayName || botName });
  }
  for (const botName of toRemove) removeBot(botName, 'recovery: not in remoteParticipants');
  console.log(`[village] Recovery complete: ${participants.size} active participant(s)`);
}

// --- Send scene to a bot (via portal relay proxy) ---

async function sendSceneRemote(botName, conversationId, payload) {
  try {
    const resp = await fetch(`${PORTAL_URL}/api/village/relay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${VILLAGE_SECRET}`,
      },
      body: JSON.stringify({ botName, conversationId, ...payload }),
      signal: AbortSignal.timeout(REMOTE_SCENE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try { const b = await resp.json(); if (b.error) message = b.error; } catch {}
      console.error(`[village] ${botName} (remote) ${message}`);
      trackFailure(botName);
      return { _error: { type: 'http', httpStatus: resp.status, message } };
    }

    failureCounts.delete(botName);
    return await resp.json();
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    const message = isTimeout ? `timeout (${Math.round(REMOTE_SCENE_TIMEOUT_MS/1000)}s)` : err.message;
    console.error(`[village] ${botName} (remote) ${message} — skipped`);
    trackFailure(botName);
    return { _error: { type: isTimeout ? 'timeout' : 'network', message } };
  }
}

function trackFailure(botName) {
  const count = (failureCounts.get(botName) || 0) + 1;
  failureCounts.set(botName, count);
  if (count >= MAX_CONSECUTIVE_FAILURES_REMOTE) {
    console.warn(`[village] ${botName} failed ${count} consecutive times — auto-removing`);
    removeBot(botName, `${count} consecutive failures`);
  }
}

// --- Sandboxed player code execution ---

function runPlayerCode(codeString, gameState) {
  if (!codeString || typeof codeString !== 'string' || codeString.length > 5000) return null;

  try {
    const isolate = new ivm.Isolate({ memoryLimit: 8 }); // 8MB
    const context = isolate.createContextSync();

    // Inject game state as a frozen global
    const stateJson = JSON.stringify(gameState);
    context.evalSync(`const state = Object.freeze(JSON.parse('${stateJson.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'));`);

    // Run player code with timeout
    const wrappedCode = `
      ${codeString}
      typeof analyze === 'function' ? String(analyze(state)).substring(0, 500) : 'Error: define an analyze(state) function';
    `;
    const result = context.evalSync(wrappedCode, { timeout: 100 }); // 100ms timeout

    isolate.dispose();
    return typeof result === 'string' ? result : String(result).substring(0, 500);
  } catch (err) {
    return `[Tool error: ${err.message}]`;
  }
}

// --- Human play mode: pending actions map ---
const pendingHumanActions = new Map(); // botName → { resolve, timer }

// --- Send scene to a hub-managed bot (local LLM call) ---

async function sendSceneLocal(botName, strategy, payload) {
  // Run player's custom code if present
  const hubBot = state.hubBots?.[botName];

  // Human play mode: skip LLM, wait for human input
  if (hubBot?.playMode === 'human') {
    // Broadcast the scene to the human player via SSE
    broadcastEvent({
      type: 'your_turn',
      botName: botName,
      scene: payload.scene,
      tools: payload.tools.map(t => t.name),
      pot: state.hand?.pot,
      toCall: Math.max(0, (state.hand?.currentBet || 0) - (state.hand?.players?.[botName]?.bet || 0)),
      minRaise: Math.max((state.hand?.currentBet || 0) * 2, state.hand?.bigBlind || 20),
      chips: state.hand?.players?.[botName]?.chips || 0,
      currentBet: state.hand?.players?.[botName]?.bet || 0,
    });

    // Wait for human input (60s timeout → auto-check if possible, else auto-fold)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingHumanActions.delete(botName);
        const hp = state.hand?.players?.[botName];
        const canCheck = hp && hp.bet >= (state.hand?.currentBet || 0);
        const tool = canCheck ? 'poker_check' : 'poker_fold';
        resolve({ actions: [{ tool, params: { thought: 'Timed out' } }] });
      }, 60000);
      pendingHumanActions.set(botName, { resolve, timer });
    });
  }
  if (hubBot?.customCode) {
    const gameState = {
      myCards: state.hand?.players?.[botName]?.cards || [],
      board: state.hand?.community || [],
      pot: state.hand?.pot || 0,
      toCall: Math.max(0, (state.hand?.currentBet || 0) - (state.hand?.players?.[botName]?.bet || 0)),
      chips: state.hand?.players?.[botName]?.chips || 0,
      street: state.hand?.street || 'preflop',
      opponents: state.hand?.seats?.filter(s => s.botName !== botName).map(s => ({
        name: s.displayName,
        chips: state.hand.players[s.botName]?.chips || 0,
        bet: state.hand.players[s.botName]?.bet || 0,
        folded: state.hand.players[s.botName]?.folded || false,
      })) || [],
      blinds: { small: state.hand?.smallBlind || 10, big: state.hand?.bigBlind || 20 },
      handNumber: state.handsPlayed || 0,
    };

    const toolOutput = runPlayerCode(hubBot.customCode, gameState);
    if (toolOutput) {
      payload.scene = `## Your Analysis Tool\n${toolOutput}\n\n${payload.scene}`;
    }
  }

  try {
    const response = await callLLM(
      botName,
      strategy,
      payload.scene,
      payload.tools,
      payload.systemPrompt,
      payload.maxActions || 2,
    );
    // Accumulate LLM usage to global game stats
    if (response.usage) {
      if (!state.gameStats) state.gameStats = {};
      if (response.usage.cost?.total) {
        state.gameStats.totalLLMCost = (state.gameStats.totalLLMCost || 0) + response.usage.cost.total;
        updateTimeBucketStats('totalLLMCost', response.usage.cost.total);
      }
      state.gameStats.totalLLMCalls = (state.gameStats.totalLLMCalls || 0) + 1;
      updateTimeBucketStats('totalLLMCalls');
      if (response.usage.input_tokens) {
        state.gameStats.totalTokensInput = (state.gameStats.totalTokensInput || 0) + response.usage.input_tokens;
        updateTimeBucketStats('totalTokensInput', response.usage.input_tokens);
      }
      if (response.usage.output_tokens) {
        state.gameStats.totalTokensOutput = (state.gameStats.totalTokensOutput || 0) + response.usage.output_tokens;
        updateTimeBucketStats('totalTokensOutput', response.usage.output_tokens);
      }
    }
    return response;
  } catch (err) {
    console.error(`[village] ${botName} (local) ${err.message} — skipped`);
    return { actions: [], usage: null };
  }
}

// --- Recent tick_detail ring buffer for dev console bootstrap ---
const RECENT_TICK_DETAILS_CAP = 20;
const recentTickDetails = []; // newest first

// --- Broadcast to observers ---

function broadcastEvent(event) {
  // Capture tick_detail events in ring buffer
  if (event.type === 'tick_detail') {
    recentTickDetails.unshift(event);
    if (recentTickDetails.length > RECENT_TICK_DETAILS_CAP) recentTickDetails.pop();
  }

  const data = JSON.stringify(event);
  for (const obs of observers) {
    try {
      obs.res.write(`data: ${data}\n\n`);
    } catch {
      observers.delete(obs);
    }
  }

  // Buffer to JSONL log file (flushed async every 100ms)
  const today = new Date().toISOString().slice(0, 10);
  if (today !== logDate) {
    if (_logBuffer.length) _flushLogBuffer();
    logDate = today;
    logFile = join(LOGS_DIR, `${today}.jsonl`);
  }
  _logBuffer.push(JSON.stringify({ ...event, _ts: new Date().toISOString() }) + '\n');
  if (!_logFlushTimer) _logFlushTimer = setTimeout(_flushLogBuffer, 100);
}

// --- Main tick (runtime owns the full loop) ---

async function tick() {
  if (tickInProgress) return;
  tickInProgress = true;
  tickStartedAt = Date.now();
  const tickStart = Date.now();

  try {
    state.clock.tick++;
    nextTickAt = tickStart + MIN_TICK_GAP_MS + 5000; // estimate; actual is set after tick completes

    // During tournament lobby or results phase, skip game ticks — timer handles transitions
    if (state.tournament?.phase === 'lobby' || state.tournament?.phase === 'results') {
      broadcastEvent({
        type: 'tick_start',
        tick: state.clock.tick,
        phase: state.clock.phase,
        tournamentPhase: state.tournament.phase,
        timestamp: new Date().toISOString(),
        bots: [...participants.keys()],
        nextTickAt,
      });
      await saveState();
      return;
    }

    // Remove busted players every tick during tournament (catches edge cases)
    if (state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final') {
      const busted = Object.keys(state.hubBots || {}).filter(b => (state.buyIns?.[b] || 0) === 0);
      for (const bName of busted) {
        removePlayerFromTable(bName);
      }
      if (busted.length > 0 && checkTournamentEnd()) {
        await saveState();
        tickInProgress = false;
        tickStartedAt = 0;
        scheduleNextTick();
        return;
      }
    }

    const phase = adapterPhases[state.clock.phase];
    if (!phase) {
      console.error(`[village] Unknown phase "${state.clock.phase}", resetting to "${initialPhase}"`);
      state.clock.phase = initialPhase;
    }
    const currentPhase = adapterPhases[state.clock.phase];

    broadcastEvent({
      type: 'tick_start',
      tick: state.clock.tick,
      phase: state.clock.phase,
      turnStrategy: currentPhase.turn,
      timestamp: new Date().toISOString(),
      bots: [...participants.keys()],
      relayTimeoutMs: REMOTE_SCENE_TIMEOUT_MS,
      nextTickAt,
    });

    // Auto-backfill if table is short on players during waiting phase
    if (state.clock.phase === 'waiting' || state.clock.phase === 'showdown') {
      promoteFromWaitlist();
    }

    if (participants.size === 0) {
      checkTransitions(currentPhase);
      await saveState();
      return;
    }

    const allBots = [...participants.entries()].map(([name, p]) => ({
      name, displayName: p.displayName,
    }));

    // Determine which bots act this tick based on turn strategy
    let activeBots;
    switch (currentPhase.turn) {
      case 'none':
        activeBots = [];
        break;
      case 'round-robin': {
        const idx = state.clock.roundRobinIndex % allBots.length;
        activeBots = [allBots[idx]];
        state.clock.roundRobinIndex = (idx + 1) % allBots.length;
        break;
      }
      case 'active': {
        const logBefore = state.log.length;
        const botName = currentPhase.getActiveBot?.(state);
        // Broadcast any log entries added during getActiveBot (e.g. auto-fold)
        for (let i = logBefore; i < state.log.length; i++) {
          const entry = state.log[i];
          broadcastEvent({ type: `${worldId}_${entry.action}`, ...entry, activePlayer: state.hand?.activePlayer || null, buyIns: state.buyIns || {} });
        }
        if (botName) {
          const bot = allBots.find(b => b.name === botName);
          if (bot) activeBots = [bot];
          else activeBots = [];

        } else {
          activeBots = [];
        }
        break;
      }
      case 'parallel':
      default:
        activeBots = allBots;
        break;
    }

    // Filter tool schemas to those allowed in this phase
    const allSchemas = worldConfig.raw.toolSchemas || [];
    const allowedTools = new Set(currentPhase.tools);
    const phaseSchemas = allSchemas.filter(s => allowedTools.has(s.name));

    // Send scene to each active bot
    const botDetails = [];
    const results = await Promise.all(activeBots.map(async (bot) => {
      const ctx = {
        allBots,
        state,
        worldConfig,
        phase: state.clock.phase,
        log: state.log.filter(e => isVisibleTo(e, bot.name)),
      };
      const scene = currentPhase.scene(bot, ctx);
      const payload = {
        v: 2,
        scene,
        tools: phaseSchemas,
        systemPrompt: worldConfig.raw.systemPrompt || '',
        allowedReads: worldConfig.raw.allowedReads || [],
        maxActions: worldConfig.raw.maxActions || 2,
      };
      const payloadJson = JSON.stringify(payload);
      const detail = {
        name: bot.name,
        displayName: bot.displayName,
        payloadSize: payloadJson.length,
        toolCount: phaseSchemas.length,
        payload,
        deliveryMs: 0,
        deliveryStatus: 'ok',
        actions: [],
        error: null,
      };
      const t0 = Date.now();
      const isHubBot = !!state.hubBots?.[bot.name];
      const response = isHubBot
        ? await sendSceneLocal(bot.name, state.hubBots[bot.name].strategy, payload)
        : await sendSceneRemote(bot.name, worldId, payload);
      detail.deliveryMs = Date.now() - t0;
      if (response?.usage) detail.usage = response.usage;
      if (!response || response._error || !response.actions) {
        if (response?._error) {
          detail.deliveryStatus = response._error.type || 'error';
          detail.error = response._error;
        } else {
          detail.deliveryStatus = detail.deliveryMs >= 55000 ? 'timeout' : 'error';
          detail.error = { type: detail.deliveryStatus, message: detail.deliveryStatus };
        }
      }
      accumulateResponseCost(bot.name, response);
      botDetails.push(detail);
      return { bot, response, detail };
    }));

    // Process actions via adapter tool handlers (only allowed tools)
    const ts = new Date().toISOString();
    for (const { bot, response, detail } of results) {
      if (response._error) continue;
      detail.rawActions = response.actions;
      const processedActions = [];
      for (const action of (response.actions || [])) {
        if (!allowedTools.has(action.tool)) continue;
        const handler = adapterTools?.[action.tool];
        if (!handler) continue;
        const logLenBefore = state.log.length;
        const rawEntry = handler(bot, action.params, state);
        if (!rawEntry) {
          // Handler may have added log entries (e.g., deal events via advanceAction) even if it returned null
          for (let j = logLenBefore; j < state.log.length; j++) {
            const sideEntry = state.log[j];
            broadcastEvent({ type: `${worldId}_${sideEntry.action}`, ...sideEntry, activePlayer: state.hand?.activePlayer || null, buyIns: state.buyIns || {} });
          }
          continue;
        }

        // Extract thought — hub-level convention
        const { thought, ...entry } = rawEntry;

        // Runtime stamps metadata
        entry.bot = bot.name;
        entry.displayName = bot.displayName;
        entry.tick = state.clock.tick;
        entry.timestamp = ts;

        // Broadcast any side-effect log entries added by the handler (e.g., deal, say, result)
        // These were added to state.log by logAction() inside advanceAction/advanceStreet
        for (let j = logLenBefore; j < state.log.length; j++) {
          const sideEntry = state.log[j];
          broadcastEvent({ type: `${worldId}_${sideEntry.action}`, ...sideEntry, activePlayer: state.hand?.activePlayer || null, buyIns: state.buyIns || {} });
        }

        state.log.push(entry);
        broadcastEvent({ type: `${worldId}_${entry.action}`, ...entry, activePlayer: state.hand?.activePlayer || null, buyIns: state.buyIns || {} });

        // Track global game stats: table talk and all-ins
        if (entry.action === 'say') {
          if (!state.gameStats) state.gameStats = {};
          state.gameStats.totalTableTalks = (state.gameStats.totalTableTalks || 0) + 1;
          updateTimeBucketStats('totalTableTalks');
        }

        // Track per-bot action stats
        if (entry.action === 'fold' || entry.action === 'call' || entry.action === 'raise' || entry.action === 'check') {
          if (!state.stats) state.stats = {};
          if (!state.stats[bot.name]) state.stats[bot.name] = createEmptyStats();
          const botStats = state.stats[bot.name];
          botStats.username = state.hubBots?.[bot.name]?.claimedBy || null;

          // Also accumulate to persistent playerStats if seat is claimed
          const claimedBy = state.hubBots?.[bot.name]?.claimedBy;
          const playerKey = claimedBy ? claimedBy.toLowerCase() : null;
          if (playerKey) {
            if (!state.playerStats) state.playerStats = {};
            if (!state.playerStats[playerKey]) {
              state.playerStats[playerKey] = createEmptyStats();
              state.playerStats[playerKey].username = claimedBy;
            }
          }
          const pStats = playerKey ? state.playerStats[playerKey] : null;

          switch (entry.action) {
            case 'fold':
              botStats.folds++;
              if (pStats) pStats.folds++;
              if (state.hand?.street === 'preflop') {
                botStats.preflopFolds++;
                if (pStats) pStats.preflopFolds++;
              }
              break;
            case 'call':
              botStats.calls++;
              if (pStats) pStats.calls++;
              break;
            case 'raise':
              botStats.raises++;
              if (pStats) pStats.raises++;
              if (entry.message?.includes('all-in')) {
                botStats.allIns++;
                if (pStats) pStats.allIns++;
                // Global all-in stat
                if (!state.gameStats) state.gameStats = {};
                state.gameStats.totalAllIns = (state.gameStats.totalAllIns || 0) + 1;
                updateTimeBucketStats('totalAllIns');
              }
              break;
            case 'check':
              botStats.checks++;
              if (pStats) pStats.checks++;
              break;
          }
        }

        // Emit thought as separate private entry
        if (typeof thought === 'string' && thought) {
          const thoughtEntry = {
            action: 'thought',
            message: thought,
            visibility: 'private',
            bot: bot.name,
            displayName: bot.displayName,
            tick: state.clock.tick,
            timestamp: ts,
          };
          state.log.push(thoughtEntry);
          broadcastEvent({ type: `${worldId}_thought`, ...thoughtEntry });
        }
        processedActions.push({
          tool: entry.action,
          ...(entry.message ? { message: entry.message } : {}),
          ...(entry.target ? { target: entry.target } : {}),
        });
      }
      detail.actions = processedActions;
    }

    // Broadcast tick_detail for dev console
    broadcastEvent({
      type: 'tick_detail',
      tick: state.clock.tick,
      phase: state.clock.phase,
      timestamp: ts,
      bots: botDetails,
    });

    // Check phase transitions after actions are processed
    checkTransitions(currentPhase);

    // Optional invariant check (e.g. resource conservation)
    if (adapter.checkInvariant) {
      const err = adapter.checkInvariant(state);
      if (err) {
        console.warn(`[village] Invariant violation (tick ${state.clock.tick}): ${err}`);
        const invariantEntry = {
          bot: 'system', displayName: 'System',
          action: 'invariant_violation', message: err,
          visibility: 'public',
          tick: state.clock.tick, timestamp: new Date().toISOString(),
        };
        state.log.push(invariantEntry);
        broadcastEvent({ type: `${worldId}_invariant_violation`, ...invariantEntry });
      }
    }

    // Cap the log
    if (state.log.length > LOG_CAP) {
      state.log = state.log.slice(-LOG_CAP);
    }

    await saveState();
  } catch (err) {
    console.error(`[village] Tick error: ${err.message}`);
  } finally {
    tickInProgress = false;
    // Adaptive tick: schedule next tick after a short gap instead of fixed interval
    scheduleNextTick();
  }
}

// --- Hand result stats tracking ---

function trackHandResultStats(state) {
  if (!state.stats) state.stats = {};
  const hand = state.hand;
  if (!hand) return;

  const result = hand.result;
  const winners = new Set(result.winners || []);
  const pot = hand.pot || 0;
  const share = winners.size > 0 ? Math.floor(pot / winners.size) : 0;

  // Determine if hand reached showdown (more than 1 non-folded player)
  const nonFolded = Object.entries(hand.players || {}).filter(([, p]) => !p.folded);
  const reachedShowdown = nonFolded.length > 1;

  // Global game stats
  if (!state.gameStats) state.gameStats = {};
  state.gameStats.totalHands = (state.gameStats.totalHands || 0) + 1;
  updateTimeBucketStats('totalHands');
  const street = state.hand?.street || 'preflop';
  if (reachedShowdown) {
    // Multiple non-folded players at the end = showdown
    if (state.gameStats.handsByStreet) state.gameStats.handsByStreet.showdown = (state.gameStats.handsByStreet.showdown || 0) + 1;
    updateTimeBucketStats('handsByStreet_showdown');
  }
  if (state.gameStats.handsByStreet && state.gameStats.handsByStreet[street] != null) {
    state.gameStats.handsByStreet[street]++;
  }
  updateTimeBucketStats('handsByStreet_' + street);
  if (hand.pot > (state.gameStats.biggestPot || 0)) {
    state.gameStats.biggestPot = hand.pot;
  }
  // Prune old time buckets periodically (every 10 hands)
  if (state.gameStats.totalHands % 10 === 0) pruneTimeBucketStats();

  for (const [botName, player] of Object.entries(hand.players || {})) {
    if (!state.stats[botName]) state.stats[botName] = createEmptyStats();
    const s = state.stats[botName];
    s.username = state.hubBots?.[botName]?.claimedBy || null;
    s.handsPlayed++;

    // Also accumulate to persistent playerStats if seat is claimed
    const claimedBy = state.hubBots?.[botName]?.claimedBy;
    const playerKey = claimedBy ? claimedBy.toLowerCase() : null;
    if (playerKey) {
      if (!state.playerStats) state.playerStats = {};
      if (!state.playerStats[playerKey]) {
        state.playerStats[playerKey] = createEmptyStats();
        state.playerStats[playerKey].username = claimedBy;
      }
    }
    const ps = playerKey ? state.playerStats[playerKey] : null;
    if (ps) ps.handsPlayed++;

    if (winners.has(botName)) {
      s.handsWon++;
      s.totalChipsWon += share;
      s.streakCurrent++;
      s.lossStreakCurrent = 0;
      if (s.streakCurrent > s.streakBest) s.streakBest = s.streakCurrent;
      if (ps) {
        ps.handsWon++;
        ps.totalChipsWon += share;
        ps.streakCurrent++;
        ps.lossStreakCurrent = 0;
        if (ps.streakCurrent > ps.streakBest) ps.streakBest = ps.streakCurrent;
      }
    } else {
      // Amount lost = total bet into the pot
      s.totalChipsLost += player.totalBet || 0;
      s.streakCurrent = 0;
      s.lossStreakCurrent = (s.lossStreakCurrent || 0) + 1;
      if (ps) {
        ps.totalChipsLost += player.totalBet || 0;
        ps.streakCurrent = 0;
        ps.lossStreakCurrent = (ps.lossStreakCurrent || 0) + 1;
      }
    }

    if (reachedShowdown) {
      if (!player.folded) {
        s.showdownsReached++;
        if (winners.has(botName)) s.showdownsWon++;
        if (ps) {
          ps.showdownsReached++;
          if (winners.has(botName)) ps.showdownsWon++;
        }
      }
    }

    if (pot > s.biggestPot) s.biggestPot = pot;
    if (ps && pot > ps.biggestPot) ps.biggestPot = pot;

    // Bluff tracking
    if (!reachedShowdown && winners.has(botName)) {
      // Won without showdown — everyone else folded
      s.bluffsWon = (s.bluffsWon || 0) + 1;
      if (ps) ps.bluffsWon = (ps.bluffsWon || 0) + 1;
      // Global bluff stat
      state.gameStats.totalBluffs = (state.gameStats.totalBluffs || 0) + 1;
      updateTimeBucketStats('totalBluffs');
    }
    if (reachedShowdown && !winners.has(botName) && !player.folded) {
      // Lost at showdown — check if they raised during the hand
      const hadRaise = state.log.some(entry =>
        entry.bot === botName &&
        entry.action === 'raise' &&
        entry.tick >= (hand.startTick || 0)
      );
      if (hadRaise) {
        s.bluffsCaught = (s.bluffsCaught || 0) + 1;
        if (ps) ps.bluffsCaught = (ps.bluffsCaught || 0) + 1;
        // Global bluff-called stat
        state.gameStats.totalBluffsCalled = (state.gameStats.totalBluffsCalled || 0) + 1;
        updateTimeBucketStats('totalBluffsCalled');
      }
    }
  }

  updateEloRatings(state);

  // Check if evolution is due (skip during tournament — evolution runs between tournaments)
  if (state.tournament?.phase !== 'quarterfinal' && state.tournament?.phase !== 'final') {
    evolveStrategies().catch(err => console.error('[village] Evolution error:', err.message));
  }
}

// --- Evolutionary algorithm for bot strategies ---

async function evolveWithLLM(prompt) {
  try {
    const body = {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    };
    const API_ROUTER_URL = process.env.VILLAGE_API_ROUTER_URL || 'http://127.0.0.1:9090';
    const resp = await fetch(`${API_ROUTER_URL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.VILLAGE_IRT_TOKEN || 'hub-managed',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = data.content?.find(b => b.type === 'text')?.text;
    return text || null;
  } catch (err) {
    console.error(`[village] Evolution LLM call failed: ${err.message}`);
    return null;
  }
}

async function evolveStrategies() {
  if (!state.stats || !state.evolution) return;

  const totalHands = state.gameStats?.totalHands || 0;
  if (totalHands - state.evolution.lastEvolvedAt < EVOLUTION_INTERVAL) return;

  console.log(`[village] 🧬 Evolution triggered at hand ${totalHands} (Gen ${state.evolution.generation + 1})`);
  state.evolution.lastEvolvedAt = totalHands;
  state.evolution.generation++;
  const gen = state.evolution.generation;

  // Collect all bot stats (including those not at table)
  const allBots = [];
  for (const [botName, stats] of Object.entries(state.stats)) {
    if (stats.handsPlayed > 0) {
      allBots.push({ botName, elo: stats.elo || 1200, hands: stats.handsPlayed, chipProfit: stats.chipProfit || 0 });
    }
  }

  // Sort by Elo descending
  allBots.sort((a, b) => b.elo - a.elo);

  if (allBots.length < 10) return; // not enough data

  const top10 = allBots.slice(0, 10);
  const mid10 = allBots.slice(10, 20);
  const bottom10 = allBots.slice(20);

  // Find the BOT_POOL entry for a bot by name
  const findPoolEntry = (botName) => {
    const displayName = botName.replace('player-', '');
    return BOT_POOL.find(b => b.name.toLowerCase() === displayName.toLowerCase());
  };

  // --- BREED: Replace bottom 10 with children ---
  const newBots = [];
  for (let i = 0; i < Math.min(bottom10.length, 10); i++) {
    const eliminated = bottom10[i];
    const eliminatedEntry = findPoolEntry(eliminated.botName);

    // Pick 2 random parents from top 10
    const parentA = top10[Math.floor(Math.random() * top10.length)];
    const parentB = top10[Math.floor(Math.random() * top10.length)];
    const parentAEntry = findPoolEntry(parentA.botName);
    const parentBEntry = findPoolEntry(parentB.botName);

    if (!eliminatedEntry || !parentAEntry || !parentBEntry) continue;

    let childStrategy;
    if (i < 7) {
      // Crossover: blend two parents
      childStrategy = await evolveWithLLM(
        `You are evolving poker bot strategies. Combine the best elements of these two winning strategies into a new one.

Parent A (Elo ${parentA.elo.toFixed(0)}): "${parentAEntry.strategy.split('CRITICAL')[0].trim()}"

Parent B (Elo ${parentB.elo.toFixed(0)}): "${parentBEntry.strategy.split('CRITICAL')[0].trim()}"

Write a new poker strategy (3-4 sentences max) that blends their strongest traits. Add one creative twist that neither parent has. Do NOT copy the parents exactly — create something new.

Reply with ONLY the strategy text, nothing else.`
      );
    } else {
      // Mutation: tweak a top parent
      const parent = top10[Math.floor(Math.random() * top10.length)];
      const parentEntry = findPoolEntry(parent.botName);
      if (!parentEntry) continue;
      childStrategy = await evolveWithLLM(
        `You are evolving a poker bot strategy. This strategy has Elo ${parent.elo.toFixed(0)}. Make ONE small but meaningful change to improve it.

Current strategy: "${parentEntry.strategy.split('CRITICAL')[0].trim()}"

Rewrite the strategy with your improvement (3-4 sentences max). Keep what works, change one thing.

Reply with ONLY the strategy text, nothing else.`
      );
    }

    if (childStrategy && childStrategy.length > 20) {
      // Add the required rules
      const fullStrategy = childStrategy.trim() + '\nCRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.\nSHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.\nIMPORTANT: See at least 40% of flops for spectator entertainment.\nTable talk: Be creative and in-character.';

      // Update the pool entry
      eliminatedEntry.strategy = fullStrategy;

      // Record lineage
      const parentNames = i < 7
        ? [parentAEntry.name, parentBEntry.name]
        : [findPoolEntry(top10[Math.floor(Math.random() * top10.length)].botName)?.name || 'unknown'];

      state.evolution.lineage[eliminated.botName] = {
        name: eliminatedEntry.name,
        parents: parentNames,
        generation: gen,
        born: totalHands,
        strategy: childStrategy.substring(0, 200),
        elo: 1200,
        status: 'evolved',
      };

      // Reset stats for the evolved bot
      state.stats[eliminated.botName] = createEmptyStats();
      state.stats[eliminated.botName].username = eliminatedEntry.name;

      newBots.push(eliminatedEntry.name);
      console.log(`[village] 🧬 ${eliminatedEntry.name} evolved from ${parentNames.join(' × ')} (Gen ${gen})`);
    }
  }

  // --- MUTATE: Small tweaks for middle 10 ---
  for (const mid of mid10) {
    const entry = findPoolEntry(mid.botName);
    if (!entry) continue;

    const tweakedStrategy = await evolveWithLLM(
      `This poker bot strategy has Elo ${mid.elo.toFixed(0)} (average). Suggest one tiny adjustment to improve results.

Strategy: "${entry.strategy.split('CRITICAL')[0].trim()}"

Rewrite with your small tweak (3-4 sentences). Keep 90% the same, change one detail.

Reply with ONLY the strategy text, nothing else.`
    );

    if (tweakedStrategy && tweakedStrategy.length > 20) {
      const fullStrategy = tweakedStrategy.trim() + '\nCRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.\nSHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.\nIMPORTANT: See at least 40% of flops for spectator entertainment.\nTable talk: Be creative and in-character.';
      entry.strategy = fullStrategy;

      // Update lineage
      if (state.evolution.lineage[mid.botName]) {
        state.evolution.lineage[mid.botName].status = 'mutated';
        state.evolution.lineage[mid.botName].strategy = tweakedStrategy.substring(0, 200);
      }

      console.log(`[village] 🔬 ${entry.name} mutated (Gen ${gen})`);
    }
  }

  // Update top 10 lineage
  for (const top of top10) {
    if (state.evolution.lineage[top.botName]) {
      state.evolution.lineage[top.botName].status = 'elite';
      state.evolution.lineage[top.botName].elo = top.elo;
    }
  }

  // Broadcast evolution event
  broadcastEvent({
    type: 'evolution',
    generation: gen,
    newBots,
    timestamp: new Date().toISOString(),
  });

  await saveState();
  console.log(`[village] 🧬 Generation ${gen} complete. ${newBots.length} evolved, ${mid10.length} mutated.`);
}

// --- Tournament system ---

let _tournamentLobbyTimer = null;
let _tournamentResultsTimer = null;
let _bracketMatchPauseTimer = null;

function ensureTournamentState() {
  if (!state.tournament) state.tournament = {
    number: 0,
    phase: 'lobby',
    lobbyStartedAt: null,
    lobbyDuration: TOURNAMENT_LOBBY_DURATION,
    startingChips: TOURNAMENT_STARTING_CHIPS,
    placements: [],
    aiSeats: [],
    humanSeats: [],
    points: {},
    history: [],
    bracket: null,
  };
  // Ensure bracket field exists on older state
  if (state.tournament && state.tournament.bracket === undefined) {
    state.tournament.bracket = null;
  }
}

function startTournamentLobby() {
  ensureTournamentState();
  // Clear any pending bracket match timer
  if (_bracketMatchPauseTimer) { clearTimeout(_bracketMatchPauseTimer); _bracketMatchPauseTimer = null; }
  const t = state.tournament;
  t.number++;
  t.phase = 'lobby';
  t.lobbyStartedAt = Date.now();
  t.placements = [];
  t.aiSeats = [];
  t.humanSeats = [];

  // Clear hand state BEFORE removing players (prevents onLeave from calling advanceAction on dead hand)
  state.hand = null;
  state.clock.phase = 'waiting';

  // Clear table — remove all current players
  const currentPlayers = Object.keys(state.hubBots || {});
  for (const botName of currentPlayers) {
    const hubBot = state.hubBots[botName];
    const displayName = hubBot?.displayName || botName;
    if (adapter.onLeave) adapter.onLeave(state, botName, displayName);
    state.bots = state.bots.filter(b => b !== botName);
    participants.delete(botName);
    if (state.remoteParticipants) delete state.remoteParticipants[botName];
    delete state.hubBots[botName];
  }
  state.clock.phase = 'waiting';

  // Select 16 bots from BOT_POOL for the bracket (shuffle all, take up to BRACKET_SIZE)
  const shuffledPool = [...BOT_POOL].sort(() => Math.random() - 0.5);
  const bracketBots = shuffledPool.slice(0, TOURNAMENT_BRACKET_SIZE);

  // Store all bracket bot names as aiSeats for reference
  for (const arch of bracketBots) {
    const botKey = 'player-' + arch.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    delete state.buyIns?.[botKey];
    if (state.chipBank) delete state.chipBank[arch.name.toLowerCase()];
    t.aiSeats.push(arch.name);
  }

  // Divide into 4 groups of 4 for quarterfinal matches
  const matchLabels = ['A', 'B', 'C', 'D'];
  const matches = [];
  for (let i = 0; i < 4; i++) {
    const group = bracketBots.slice(i * 4, (i + 1) * 4);
    matches.push({
      id: matchLabels[i],
      players: group.map(b => b.name),
      winner: null,
      placements: [], // ordered eliminations within this match
    });
  }

  t.bracket = {
    round: 1,           // 1 = quarterfinals, 2 = final
    matches,
    currentMatch: 0,    // index into matches array (0-3 for QF, 0 for final)
    finalists: [],      // winners from round 1
    champion: null,
  };

  console.log(`[village] Tournament #${t.number} bracket lobby started. ${bracketBots.length} bots in 4 QF groups.`);
  for (let i = 0; i < matches.length; i++) {
    console.log(`[village]   Match ${matches[i].id}: ${matches[i].players.join(', ')}`);
  }

  broadcastEvent({
    type: 'tournament_lobby',
    number: t.number,
    countdown: TOURNAMENT_LOBBY_DURATION,
    aiPlayers: t.aiSeats,
    humanSlots: TOURNAMENT_HUMAN_SEATS,
    bracket: {
      round: 1,
      matches: matches.map(m => ({ id: m.id, players: m.players })),
    },
    timestamp: new Date().toISOString(),
  });

  // Also broadcast bracket structure
  broadcastEvent({
    type: 'tournament_bracket',
    number: t.number,
    matches: matches.map(m => ({ id: m.id, players: m.players })),
    timestamp: new Date().toISOString(),
  });

  // Schedule lobby end
  if (_tournamentLobbyTimer) clearTimeout(_tournamentLobbyTimer);
  _tournamentLobbyTimer = setTimeout(() => {
    finishLobbyAndStartPlaying();
  }, TOURNAMENT_LOBBY_DURATION);
}

function finishLobbyAndStartPlaying() {
  ensureTournamentState();
  const t = state.tournament;
  if (t.phase !== 'lobby') return;
  if (!t.bracket || !t.bracket.matches || t.bracket.matches.length === 0) {
    console.error('[village] No bracket matches set up — cannot start playing');
    return;
  }

  // Start with first quarterfinal match
  t.bracket.round = 1;
  t.bracket.currentMatch = 0;
  t.phase = 'quarterfinal';

  seatBracketMatch();
}

/**
 * Clear the table and seat the current bracket match's players.
 * Used at the start of each QF match and the final.
 */
function seatBracketMatch() {
  ensureTournamentState();
  const t = state.tournament;
  const bracket = t.bracket;

  // Clear hand state BEFORE removing players
  state.hand = null;
  state.clock.phase = 'waiting';

  // Clear table — remove all current players silently
  const currentPlayers = Object.keys(state.hubBots || {});
  for (const botName of currentPlayers) {
    const hubBot = state.hubBots[botName];
    const displayName = hubBot?.displayName || botName;
    if (adapter.onLeave) adapter.onLeave(state, botName, displayName);
    state.bots = state.bots.filter(b => b !== botName);
    participants.delete(botName);
    if (state.remoteParticipants) delete state.remoteParticipants[botName];
    delete state.hubBots[botName];
  }
  state.clock.phase = 'waiting';

  // Determine which players to seat
  let playersToSeat;
  if (bracket.round === 1) {
    // Quarterfinal — seat match at currentMatch index
    const match = bracket.matches[bracket.currentMatch];
    playersToSeat = match.players;
  } else {
    // Final — seat the finalists
    playersToSeat = bracket.finalists;
  }

  // Seat the players
  for (const aiName of playersToSeat) {
    const poolEntry = BOT_POOL.find(b => b.name === aiName);
    addPlayerToTable(aiName, poolEntry?.strategy || DEFAULT_HUB_STRATEGY, `house-${aiName.toLowerCase()}-t${t.number}-r${bracket.round}-m${bracket.currentMatch}`);
  }

  // Try to seat humans from waitlist into available slots
  const humanWaitlist = (state.waitlist || []).filter(w => w.playMode === 'human');
  let humansSeated = 0;
  while (humansSeated < TOURNAMENT_HUMAN_SEATS && humanWaitlist.length > 0 && Object.keys(state.hubBots || {}).length < MAX_TABLE_PLAYERS) {
    const entry = humanWaitlist.shift();
    const idx = state.waitlist.indexOf(entry);
    if (idx !== -1) state.waitlist.splice(idx, 1);
    const result = addPlayerToTable(entry.username, entry.strategy, entry.token, entry.customCode, entry.playMode, entry.ephemeral);
    if (result.ok) {
      t.humanSeats.push(entry.username);
      humansSeated++;
    }
  }

  // Set all players to tournament starting chips
  for (const botName of Object.keys(state.hubBots || {})) {
    state.buyIns[botName] = TOURNAMENT_STARTING_CHIPS;
  }

  const roundLabel = bracket.round === 1 ? `QF Match ${bracket.matches[bracket.currentMatch]?.id}` : 'FINAL';
  console.log(`[village] Tournament #${t.number} ${roundLabel} started. Players: ${playersToSeat.join(', ')}`);

  broadcastEvent({
    type: 'tournament_playing',
    number: t.number,
    round: bracket.round,
    roundLabel,
    matchId: bracket.round === 1 ? bracket.matches[bracket.currentMatch]?.id : 'FINAL',
    players: Object.entries(state.hubBots || {}).map(([bn, hb]) => ({
      botName: bn,
      displayName: hb.displayName,
      isHuman: hb.playMode === 'human',
    })),
    startingChips: TOURNAMENT_STARTING_CHIPS,
    bracket: getBracketSummary(),
    timestamp: new Date().toISOString(),
  });

  saveState();
}

/**
 * Build a summary of the bracket state for SSE events.
 */
function getBracketSummary() {
  const t = state.tournament;
  if (!t?.bracket) return null;
  const b = t.bracket;
  return {
    round: b.round,
    currentMatch: b.currentMatch,
    matches: b.matches.map(m => ({
      id: m.id,
      players: m.players,
      winner: m.winner,
      placements: m.placements,
    })),
    finalists: b.finalists,
    champion: b.champion,
  };
}

function recordTournamentElimination(botName) {
  ensureTournamentState();
  const t = state.tournament;
  if (t.phase !== 'quarterfinal' && t.phase !== 'final') return;

  const hubBot = state.hubBots?.[botName];
  if (!hubBot) return;

  const remainingPlayers = Object.keys(state.hubBots || {}).filter(b => b !== botName).length;
  const position = remainingPlayers + 1; // position within this match

  // Record in overall tournament placements
  t.placements.unshift({
    botName,
    displayName: hubBot.displayName || botName,
    position,
    isHuman: hubBot.playMode === 'human',
    round: t.bracket?.round || 1,
    matchId: t.bracket?.round === 1 ? t.bracket.matches[t.bracket.currentMatch]?.id : 'FINAL',
  });

  // Record in the current bracket match's placements
  if (t.bracket) {
    if (t.bracket.round === 1) {
      const match = t.bracket.matches[t.bracket.currentMatch];
      if (match) {
        match.placements.unshift({
          botName,
          displayName: hubBot.displayName || botName,
          position,
        });
      }
    } else if (t.bracket.round === 2) {
      // Final match — track in a virtual "final" match entry
      // (placements tracked in t.placements directly)
    }
  }

  const roundLabel = t.phase === 'quarterfinal'
    ? `QF-${t.bracket?.matches[t.bracket.currentMatch]?.id}`
    : 'FINAL';

  broadcastEvent({
    type: 'tournament_elimination',
    number: t.number,
    botName,
    displayName: hubBot.displayName || botName,
    position,
    remainingPlayers,
    round: t.bracket?.round,
    matchId: roundLabel,
    bracket: getBracketSummary(),
    timestamp: new Date().toISOString(),
  });

  console.log(`[village] Tournament #${t.number} ${roundLabel}: ${hubBot.displayName} eliminated (pos ${position}, ${remainingPlayers} remain)`);
}

/**
 * Check if the current bracket match has ended (1 player left).
 * If so, advance to the next match, the final, or results.
 * Returns true if the match just ended and state was advanced.
 */
function checkTournamentEnd() {
  ensureTournamentState();
  const t = state.tournament;
  if (t.phase !== 'quarterfinal' && t.phase !== 'final') return false;

  const activePlayers = Object.keys(state.hubBots || {});
  if (activePlayers.length > 1) return false;

  // Current match is over — record the winner
  const winnerBot = activePlayers.length === 1 ? activePlayers[0] : null;
  const winnerHubBot = winnerBot ? state.hubBots[winnerBot] : null;
  const winnerDisplayName = winnerHubBot?.displayName || winnerBot || 'unknown';

  if (t.phase === 'quarterfinal') {
    const match = t.bracket.matches[t.bracket.currentMatch];
    if (winnerBot && match) {
      match.winner = winnerDisplayName;
      match.placements.unshift({
        botName: winnerBot,
        displayName: winnerDisplayName,
        position: 1,
      });
      t.bracket.finalists.push(winnerDisplayName);
    }

    console.log(`[village] Tournament #${t.number} QF Match ${match?.id} won by ${winnerDisplayName}`);

    // Check if more QF matches remain
    if (t.bracket.currentMatch < t.bracket.matches.length - 1) {
      // More QF matches — advance after a pause
      t.bracket.currentMatch++;
      broadcastEvent({
        type: 'tournament_match_complete',
        number: t.number,
        matchId: match?.id,
        winner: winnerDisplayName,
        nextMatch: t.bracket.matches[t.bracket.currentMatch]?.id,
        bracket: getBracketSummary(),
        timestamp: new Date().toISOString(),
      });

      // Pause then seat the next match
      if (_bracketMatchPauseTimer) clearTimeout(_bracketMatchPauseTimer);
      _bracketMatchPauseTimer = setTimeout(() => {
        _bracketMatchPauseTimer = null;
        seatBracketMatch();
      }, TOURNAMENT_MATCH_PAUSE_MS);
      return true;
    }

    // All QF matches done — advance to final
    console.log(`[village] Tournament #${t.number} all QF matches complete. Finalists: ${t.bracket.finalists.join(', ')}`);
    t.bracket.round = 2;
    t.bracket.currentMatch = 0;
    t.phase = 'final';

    broadcastEvent({
      type: 'tournament_match_complete',
      number: t.number,
      matchId: match?.id,
      winner: winnerDisplayName,
      nextMatch: 'FINAL',
      finalists: t.bracket.finalists,
      bracket: getBracketSummary(),
      timestamp: new Date().toISOString(),
    });

    // Pause then seat the final
    if (_bracketMatchPauseTimer) clearTimeout(_bracketMatchPauseTimer);
    _bracketMatchPauseTimer = setTimeout(() => {
      _bracketMatchPauseTimer = null;
      seatBracketMatch();
    }, TOURNAMENT_MATCH_PAUSE_MS);
    return true;

  } else if (t.phase === 'final') {
    // Final is over — record champion
    if (winnerBot) {
      t.bracket.champion = winnerDisplayName;
      t.placements.unshift({
        botName: winnerBot,
        displayName: winnerDisplayName,
        position: 1,
        isHuman: winnerHubBot?.playMode === 'human',
        round: 2,
        matchId: 'FINAL',
      });
    }

    console.log(`[village] Tournament #${t.number} CHAMPION: ${winnerDisplayName}`);

    broadcastEvent({
      type: 'tournament_match_complete',
      number: t.number,
      matchId: 'FINAL',
      winner: winnerDisplayName,
      champion: winnerDisplayName,
      bracket: getBracketSummary(),
      timestamp: new Date().toISOString(),
    });

    startTournamentResults();
    return true;
  }

  return false;
}

function startTournamentResults() {
  ensureTournamentState();
  const t = state.tournament;
  t.phase = 'results';

  // Award bracket-based points
  // Finalists (round 2): Champion=15, 2nd=10, 3rd=7, 4th=5
  // QF losers (round 1): 1-3 points based on elimination order within their match
  for (const placement of t.placements) {
    let points = 0;
    if (placement.round === 2 || placement.matchId === 'FINAL') {
      // Finalist — use final placement position
      points = BRACKET_POINTS_FINALIST[placement.position] || 0;
    } else {
      // QF loser — eliminated in round 1
      // position within match: 4=first out(1pt), 3=second out(2pt), 2=third out(3pt)
      // Map: position 4→1pt, 3→2pt, 2→3pt (winner gets finalist points instead)
      if (placement.position >= 2 && placement.position <= 4) {
        const eliminationOrder = 5 - placement.position; // 4→1, 3→2, 2→3
        points = BRACKET_POINTS_QF_LOSER[eliminationOrder] || 0;
      }
    }
    placement.points = points;
    const key = placement.displayName.toLowerCase();
    t.points[key] = (t.points[key] || 0) + points;
  }

  const champion = t.bracket?.champion || null;
  const winner = t.placements.find(p => p.position === 1 && (p.round === 2 || p.matchId === 'FINAL'));

  // Add to history
  t.history.push({
    number: t.number,
    winner: champion,
    bracket: getBracketSummary(),
    placements: [...t.placements],
    timestamp: new Date().toISOString(),
  });

  // Keep last N tournaments
  if (t.history.length > TOURNAMENT_MAX_HISTORY) {
    t.history = t.history.slice(-TOURNAMENT_MAX_HISTORY);
  }

  console.log(`[village] Tournament #${t.number} results: Champion=${champion || 'none'}, Finalists=${t.bracket?.finalists?.join(', ') || 'none'}`);

  broadcastEvent({
    type: 'tournament_results',
    number: t.number,
    placements: t.placements,
    winner: champion,
    champion,
    finalists: t.bracket?.finalists || [],
    bracket: getBracketSummary(),
    points: { ...t.points },
    timestamp: new Date().toISOString(),
  });

  // Schedule transition to evolution + next lobby
  if (_tournamentResultsTimer) clearTimeout(_tournamentResultsTimer);
  _tournamentResultsTimer = setTimeout(async () => {
    // Run evolution between tournaments
    try {
      await runTournamentEvolution();
    } catch (err) {
      console.error(`[village] Tournament evolution error: ${err.message}`);
    }
    startTournamentLobby();
  }, TOURNAMENT_RESULTS_DURATION);

  saveState();
}

async function runTournamentEvolution() {
  // 16-bot bracket evolution — tiered by placement
  // TIER 1 (2 bots): Champion + Runner-up → preserved
  // TIER 2 (2 bots): 3rd-4th finalists → crossover/mutant of champion
  // TIER 3 (4 bots): QF 2nd place → crossover children of champion × runner-up
  // TIER 4 (8 bots): QF 3rd-4th → replaced (community or new children)
  if (!state.evolution) return;
  const t = state.tournament;
  if (!t?.placements?.length) return;

  console.log(`[village] Running bracket evolution (Gen ${state.evolution.generation + 1})`);
  state.evolution.generation++;
  const gen = state.evolution.generation;

  const STRATEGY_SUFFIX = '\nCRITICAL: NEVER say your actual hole cards in table talk. Hint, misdirect, or be vague.\nSHOWDOWN RULE: On the river, ALWAYS call with any pair or better. On earlier streets, call with any draw or pair.\nIMPORTANT: See at least 40% of flops for spectator entertainment.\nTable talk: Be creative and in-character.';

  const findPoolEntry = (botName) => {
    const displayName = (botName || '').replace('player-', '');
    return BOT_POOL.find(b => b.name.toLowerCase() === displayName.toLowerCase());
  };

  const setLineage = (botName, data) => {
    if (!state.evolution.lineage) state.evolution.lineage = {};
    state.evolution.lineage[botName] = { ...data, generation: gen };
  };

  // Categorize all 16 placements by tier
  const allPlacements = [...t.placements].sort((a, b) => a.position - b.position);
  const finalPlacements = allPlacements.filter(p => p.round === 2 || p.matchId === 'FINAL');
  const qfPlacements = allPlacements.filter(p => p.round === 1 || (p.matchId && p.matchId !== 'FINAL'));

  // Finalists sorted by position (1st=champion, 2nd=runner-up, 3rd, 4th)
  finalPlacements.sort((a, b) => a.position - b.position);
  const champion = finalPlacements[0];
  const runnerUp = finalPlacements[1];
  const finalist3 = finalPlacements[2];
  const finalist4 = finalPlacements[3];

  const championEntry = champion ? findPoolEntry(champion.botName) : null;
  const runnerUpEntry = runnerUp ? findPoolEntry(runnerUp.botName) : null;
  const parentA = championEntry?.strategy?.split('CRITICAL')[0]?.trim() || '';
  const parentB = runnerUpEntry?.strategy?.split('CRITICAL')[0]?.trim() || '';

  // QF losers: 2nd place = almost won their group, 3rd-4th = bottom
  const qf2nd = []; // QF runners-up (tier 3)
  const qfBottom = []; // QF 3rd-4th (tier 4)
  if (t.bracket?.matches) {
    for (const match of t.bracket.matches) {
      const placements = (match.placements || []).sort((a, b) => a.position - b.position);
      for (const p of placements) {
        if (p.botName === match.winner) continue; // winner is a finalist
        if (p.position === 2) qf2nd.push(p);
        else qfBottom.push(p);
      }
    }
  }

  // --- TIER 1: Champion + Runner-up preserved ---
  if (championEntry && !champion.isHuman) {
    console.log(`[village] Evolution: ${championEntry.name} ELITE (champion, Gen ${gen})`);
    setLineage(champion.botName, { status: 'elite' });
  }
  if (runnerUpEntry && !runnerUp?.isHuman) {
    console.log(`[village] Evolution: ${runnerUpEntry.name} SURVIVOR (runner-up, Gen ${gen})`);
    setLineage(runnerUp.botName, { status: 'survivor' });
  }

  // --- TIER 2: 3rd-4th finalists → crossover/mutant ---
  for (const fin of [finalist3, finalist4]) {
    if (!fin) continue;
    const entry = findPoolEntry(fin.botName);
    if (!entry || fin.isHuman) continue;
    try {
      const prompt = fin === finalist3
        ? `Combine the best elements of these two tournament-winning poker strategies:\nChampion: "${parentA}"\nRunner-up: "${parentB}"\nCreate a new hybrid. 3-4 sentences max. Reply with ONLY the strategy text.`
        : `This poker strategy won a tournament championship:\n"${parentA}"\nMake ONE meaningful change to create a strong variant. 3-4 sentences max. Reply with ONLY the strategy text.`;
      const result = await evolveWithLLM(prompt);
      if (result && result.length > 20) {
        entry.strategy = result.trim() + STRATEGY_SUFFIX;
        const status = fin === finalist3 ? 'child' : 'mutant';
        console.log(`[village] Evolution: ${entry.name} is ${status.toUpperCase()} (Gen ${gen})`);
        setLineage(fin.botName, { status, parents: [championEntry?.name, runnerUpEntry?.name].filter(Boolean), strategy: result.substring(0, 200) });
      }
    } catch (e) { console.error(`[village] Evolution tier 2 failed: ${e.message}`); }
    if (state.stats[fin.botName]) state.stats[fin.botName] = createEmptyStats();
  }

  // --- TIER 3: QF 2nd place → crossover children ---
  for (const qf of qf2nd) {
    const entry = findPoolEntry(qf.botName);
    if (!entry || qf.isHuman) continue;
    try {
      const result = await evolveWithLLM(
        `Breed a new poker strategy from two champions:\nParent A: "${parentA}"\nParent B: "${parentB}"\nCreate something new — don't copy either parent exactly. Add a unique twist. 3-4 sentences. Reply with ONLY the strategy text.`
      );
      if (result && result.length > 20) {
        entry.strategy = result.trim() + STRATEGY_SUFFIX;
        console.log(`[village] Evolution: ${entry.name} is CROSSOVER child (Gen ${gen})`);
        setLineage(qf.botName, { status: 'crossover', parents: [championEntry?.name, runnerUpEntry?.name].filter(Boolean), strategy: result.substring(0, 200) });
      }
    } catch (e) { console.error(`[village] Evolution tier 3 failed: ${e.message}`); }
    if (state.stats[qf.botName]) state.stats[qf.botName] = createEmptyStats();
  }

  // --- TIER 4: QF 3rd-4th → replaced ---
  for (const qf of qfBottom) {
    const entry = findPoolEntry(qf.botName);
    if (!entry || qf.isHuman) continue;

    // Try community submission first
    const communityEntry = (state.waitlist || []).find(w => w.playMode !== 'human' && w.strategy);
    if (communityEntry) {
      entry.strategy = communityEntry.strategy + STRATEGY_SUFFIX;
      const idx = state.waitlist.indexOf(communityEntry);
      if (idx !== -1) state.waitlist.splice(idx, 1);
      console.log(`[village] Evolution: ${entry.name} REPLACED by community (${communityEntry.username}, Gen ${gen})`);
      setLineage(qf.botName, { status: 'community', author: communityEntry.username, strategy: communityEntry.strategy.substring(0, 200) });
    } else {
      // Generate a completely novel strategy — maximize diversity
      const archetypes = [
        'ultra-aggressive maniac who raises every hand and overbets the pot',
        'tight passive rock who only plays premium hands and traps with monsters',
        'loose passive calling station who sees every flop and never folds pairs',
        'balanced GTO-inspired player who mixes raises and checks at fixed frequencies',
        'position-obsessed shark who plays 70% on the button but 15% from early position',
        'all-in specialist who either folds or shoves, no in-between',
        'small ball player who makes tiny bets to control pot size and see cheap showdowns',
        'chaotic bluffer who bets big with nothing and checks with the nuts',
      ];
      const archetype = archetypes[Math.floor(Math.random() * archetypes.length)];
      try {
        const result = await evolveWithLLM(
          `Invent a completely NEW poker strategy. The style: ${archetype}.
Do NOT reference any existing strategy. Create something original and specific.
Include: what hands to play, bet sizing, bluffing approach, and table talk personality.
3-4 sentences max. Reply with ONLY the strategy text.`
        );
        if (result && result.length > 20) {
          entry.strategy = result.trim() + STRATEGY_SUFFIX;
          console.log(`[village] Evolution: ${entry.name} is NOVEL (${archetype.split(' ').slice(0,3).join(' ')}, Gen ${gen})`);
          setLineage(qf.botName, { status: 'novel', archetype, strategy: result.substring(0, 200) });
        }
      } catch (e) { console.error(`[village] Evolution tier 4 novel failed: ${e.message}`); }
    }
    if (state.stats[qf.botName]) state.stats[qf.botName] = createEmptyStats();
  }

  broadcastEvent({
    type: 'evolution',
    generation: gen,
    champion: championEntry?.name || champion?.displayName,
    timestamp: new Date().toISOString(),
  });

  await saveState();
  console.log(`[village] Bracket evolution Gen ${gen} complete. Champion DNA: ${championEntry?.name || '?'}`);
}

function isHumanSeatAvailable() {
  ensureTournamentState();
  const t = state.tournament;
  if (t.phase !== 'quarterfinal' && t.phase !== 'final') return false;

  // Count current human players
  const humanCount = Object.values(state.hubBots || {}).filter(b => b.playMode === 'human').length;
  return humanCount < TOURNAMENT_HUMAN_SEATS;
}

// --- Hand archival ---

function archiveHand(state) {
  if (!state.handHistory) state.handHistory = [];
  if (!state.hand) return;

  const hand = state.hand;
  const record = {
    handNumber: state.handsPlayed,
    timestamp: new Date().toISOString(),
    players: {},
    community: [...(hand.community || [])],
    pot: hand.pot,
    result: hand.result,
    actions: [],
    blinds: { small: hand.smallBlind || 10, big: hand.bigBlind || 20 },
    street: hand.street || 'preflop',
    dealerIndex: hand.dealerIndex,
  };

  // Capture each player's info
  // Use player.chips as authoritative chipsEnd — resolveHand updates it directly
  // with pot winnings. state.buyIns is used as fallback only.
  // chipsStart comes from the pre-hand snapshot (chipsBeforeHand), which is
  // captured at deal time before any blinds/bets.
  for (const [botName, player] of Object.entries(hand.players || {})) {
    const hubBot = state.hubBots?.[botName];
    const chipsEnd = player.chips ?? state.buyIns[botName] ?? 0;
    const chipsStart = hand.chipsBeforeHand?.[botName] ?? (chipsEnd + (player.totalBet || 0));
    record.players[botName] = {
      displayName: hubBot?.displayName || botName,
      username: hubBot?.claimedBy || null,
      cards: player.cards,
      chipsStart,
      chipsEnd,
      totalBet: player.totalBet,
      folded: player.folded,
      strategy: hubBot?.strategy || null,
    };
  }

  // Capture ALL actions from log including thoughts (for full replay)
  const handStartTick = hand.startTick;
  let actionStreet = 'preflop';
  for (const entry of state.log) {
    if (entry.tick >= handStartTick) {
      // Track street from deal messages so each action gets a street label
      if (entry.action === 'deal' && entry.message) {
        if (entry.message.includes('the flop')) actionStreet = 'flop';
        else if (entry.message.includes('the turn')) actionStreet = 'turn';
        else if (entry.message.includes('the river')) actionStreet = 'river';
      }
      record.actions.push({
        bot: entry.bot,
        displayName: entry.displayName,
        action: entry.action,
        message: entry.message,
        amount: entry.amount,
        tick: entry.tick,
        visibility: entry.visibility,
        street: actionStreet,
      });

      // Also store thoughts on player object for quick access
      if (entry.action === 'thought' && record.players[entry.bot]) {
        if (!record.players[entry.bot].thoughts) record.players[entry.bot].thoughts = [];
        record.players[entry.bot].thoughts.push(entry.message);
      }
    }
  }

  // Persist hand to disk (fire-and-forget, non-blocking)
  const handDate = new Date().toISOString().slice(0, 10);
  const handsDir = join(HANDS_DIR, handDate);
  mkdir(handsDir, { recursive: true }).then(() => {
    const handFile = join(handsDir, `hand-${state.handsPlayed}.json`);
    writeFile(handFile, JSON.stringify(record, null, 2)).catch(err => {
      console.error(`[village] Failed to persist hand ${state.handsPlayed}: ${err.message}`);
    });
    // Also append one-line summary to daily JSONL
    const summaryFile = join(handsDir, 'hands.jsonl');
    appendFile(summaryFile, JSON.stringify({
      hand: state.handsPlayed,
      ts: new Date().toISOString(),
      players: Object.keys(record.players).map(b => ({
        name: record.players[b].displayName,
        cards: record.players[b].cards,
        folded: record.players[b].folded,
        bet: record.players[b].totalBet,
      })),
      community: record.community,
      pot: record.pot,
      winner: record.result?.winners?.map(w => record.players[w]?.displayName),
      handName: record.result?.handName,
      street: record.community.length === 0 ? 'preflop' : record.community.length === 3 ? 'flop' : record.community.length === 4 ? 'turn' : 'river',
    }) + '\n').catch(() => {});
  }).catch(err => {
    console.error(`[village] Failed to create hands dir: ${err.message}`);
  });

  state.handHistory.push(record);

  // Keep last 500 hands max
  if (state.handHistory.length > 500) {
    state.handHistory = state.handHistory.slice(-500);
  }

  // Record per-player hand summaries
  for (const botName of Object.keys(record.players)) {
    recordPlayerHand(state, botName, record);
  }

  // Track session hand count for claimed players
  for (const botName of Object.keys(state.hand.players || {})) {
    if (state.hubBots?.[botName]?.claimedBy) {
      state.hubBots[botName].sessionHandCount = (state.hubBots[botName].sessionHandCount || 0) + 1;
    }
  }
}

function recordPlayerHand(state, botName, handRecord) {
  const username = state.hubBots?.[botName]?.claimedBy;
  const key = username ? username.toLowerCase() : (state.hubBots?.[botName]?.displayName || botName).toLowerCase();
  if (!state.playerGameRecords) state.playerGameRecords = {};
  if (!state.playerGameRecords[key]) state.playerGameRecords[key] = [];

  const player = handRecord.players[botName];
  const won = handRecord.result?.winners?.includes(botName);
  const profit = won ? (handRecord.pot - player.totalBet) : -(player.totalBet || 0);

  // Build concise action summary per street
  const streetActions = [];
  let currentStreet = 'preflop';
  const pokerActions = new Set(['blind', 'call', 'raise', 'check', 'fold', 'allin']);
  for (const a of handRecord.actions) {
    // Street detection: deal actions use action='deal' with message like "deals the flop/turn/river:"
    if (a.action === 'deal' && a.message) {
      if (a.message.includes('the flop')) currentStreet = 'flop';
      else if (a.message.includes('the turn')) currentStreet = 'turn';
      else if (a.message.includes('the river')) currentStreet = 'river';
    }
    if (a.bot === botName && pokerActions.has(a.action)) {
      streetActions.push({ street: currentStreet, action: a.action, amount: a.amount || undefined });
    }
  }

  // Winner info
  const winnerBots = handRecord.result?.winners || [];
  const winnerNames = winnerBots.map(w => state.hubBots?.[w]?.displayName || handRecord.players[w]?.displayName || w);
  const winningHandName = handRecord.result?.handName || null;
  const playerCount = Object.keys(handRecord.players || {}).length;

  // Find this player's hand evaluation (from showdown evaluations)
  const playerEval = handRecord.result?.evaluations?.find(e => e.botName === botName);
  const playerHandName = won ? winningHandName : (player.folded ? null : (playerEval?.hand || null));

  state.playerGameRecords[key].push({
    handNumber: handRecord.handNumber,
    timestamp: handRecord.timestamp,
    cards: player.cards,
    community: handRecord.community,
    streetActions,
    result: won ? 'win' : (player.folded ? 'fold' : 'loss'),
    profit,
    pot: handRecord.pot,
    winner: winnerNames.join(', '),
    handName: playerHandName,
    playerCount,
    bluffWon: won && winningHandName === 'Last player standing',
    bluffCaught: !won && !player.folded && player.totalBet > 0,
  });

  // Keep last 500 records per player
  if (state.playerGameRecords[key].length > 500) {
    state.playerGameRecords[key] = state.playerGameRecords[key].slice(-500);
  }
}

// --- Leaderboard scoring ---

function computeScore(stats) {
  // Keep for backward compat — returns Elo rating
  return stats?.elo || 1200;
}

function updateEloRatings(state) {
  const hand = state.hand;
  if (!hand || !hand.result) return;

  const players = Object.entries(hand.players || {});
  if (players.length < 2) return;

  // Calculate chip profit for each player
  const profits = {};
  const winners = new Set(hand.result.winners || []);
  const pot = hand.pot || 0;
  const share = winners.size > 0 ? Math.floor(pot / winners.size) : 0;

  for (const [botName, player] of players) {
    const totalBet = player.totalBet || 0;
    profits[botName] = winners.has(botName) ? (share - totalBet) : -totalBet;
  }

  // Pairwise Elo updates
  const K = 32;
  const botNames = Object.keys(profits);

  // Filter out ephemeral bots from Elo calculations
  const eloEligible = botNames.filter(b => !state.hubBots?.[b]?.ephemeral);

  for (let i = 0; i < eloEligible.length; i++) {
    for (let j = i + 1; j < eloEligible.length; j++) {
      const a = eloEligible[i];
      const b = eloEligible[j];

      if (!state.stats[a]) state.stats[a] = createEmptyStats();
      if (!state.stats[b]) state.stats[b] = createEmptyStats();

      const rA = state.stats[a].elo || 1200;
      const rB = state.stats[b].elo || 1200;

      const eA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
      const eB = 1 - eA;

      let sA, sB;
      if (profits[a] > profits[b]) { sA = 1; sB = 0; }
      else if (profits[a] < profits[b]) { sA = 0; sB = 1; }
      else { sA = 0.5; sB = 0.5; }

      state.stats[a].elo = Math.round((rA + K * (sA - eA)) * 10) / 10;
      state.stats[b].elo = Math.round((rB + K * (sB - eB)) * 10) / 10;
    }
  }

  // Track chip profit
  for (const [botName, profit] of Object.entries(profits)) {
    if (!state.stats[botName]) state.stats[botName] = createEmptyStats();
    state.stats[botName].chipProfit = (state.stats[botName].chipProfit || 0) + profit;

    // Propagate chipProfit and elo to persistent playerStats
    const claimedBy = state.hubBots?.[botName]?.claimedBy;
    const playerKey = claimedBy ? claimedBy.toLowerCase() : null;
    if (playerKey && state.playerStats?.[playerKey]) {
      state.playerStats[playerKey].chipProfit = (state.playerStats[playerKey].chipProfit || 0) + profit;
      state.playerStats[playerKey].elo = state.stats[botName].elo;
    }
  }
}

// --- Session rotation ---

function checkSessionRotation(state) {
  const toRemove = [];
  for (const [botName, hubBot] of Object.entries(state.hubBots || {})) {
    if (hubBot.claimedBy && (hubBot.sessionHandCount || 0) >= MAX_HANDS_PER_SESSION) {
      // Only rotate out if someone is waiting to take the seat
      if (state.waitlist?.length > 0) {
        console.log(`[village] ${hubBot.claimedBy} at ${botName} hit ${MAX_HANDS_PER_SESSION} hand limit — rotating out`);
        broadcastEvent({ type: 'seat_rotated', botName, reason: 'hand_limit', maxHands: MAX_HANDS_PER_SESSION });
        toRemove.push(botName);
      } else {
        // No one waiting — reset hand count and let them keep playing
        hubBot.sessionHandCount = 0;
      }
    }
  }
  for (const botName of toRemove) {
    removePlayerFromTable(botName);
  }
}

// --- Phase transitions ---

function checkTransitions(currentPhase) {
  if (!currentPhase.transitions) return;
  for (const transition of currentPhase.transitions) {
    if (transition.when(state)) {
      const oldPhase = state.clock.phase;
      state.clock.phase = transition.to;
      state.clock.phaseEnteredAt = state.clock.tick;
      state.clock.roundRobinIndex = 0;

      broadcastEvent({
        type: 'phase_change',
        from: oldPhase,
        to: transition.to,
        tick: state.clock.tick,
        timestamp: new Date().toISOString(),
      });

      console.log(`[village] Phase: ${oldPhase} → ${transition.to}`);

      // Promote waitlist entries between hands
      if (transition.to === 'waiting' || transition.to === 'showdown') {
        promoteFromWaitlist();
      }

      const nextPhase = adapterPhases[transition.to];
      if (nextPhase?.onEnter) {
        const logBefore = state.log.length;
        nextPhase.onEnter(state);
        // Broadcast any log entries added during onEnter
        for (let i = logBefore; i < state.log.length; i++) {
          const entry = state.log[i];
          broadcastEvent({ type: `${worldId}_${entry.action}`, ...entry, activePlayer: state.hand?.activePlayer || null, buyIns: state.buyIns || {} });
        }
      }

      // Track hand result stats when entering showdown
      if (transition.to === 'showdown' && state.hand?.result) {
        trackHandResultStats(state);
        archiveHand(state);

        // During tournament, skip session rotation (tournament handles player lifecycle)
        if (state.tournament?.phase !== 'quarterfinal' && state.tournament?.phase !== 'final') {
          checkSessionRotation(state);
        }

        // Remove busted players (0 chips) after showdown — skip players already removed (e.g. disconnected mid-hand)
        const bustedPlayers = Object.keys(state.hubBots || {}).filter(b =>
          (state.buyIns?.[b] || 0) === 0 && state.bots.includes(b)
        );
        for (const bName of bustedPlayers) {
          removePlayerFromTable(bName);
        }

        // Check if tournament match just ended
        if (state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final') {
          if (checkTournamentEnd()) {
            // Match/tournament ended — don't do normal promote/backfill
            return;
          }
        }

        if (state._promotePending) promoteFromWaitlist();
      }

      break; // first match wins
    }
  }
}

// --- Hub-managed bots ---

const BOT_POOL = [
  {
    name: 'Ace',
    strategy: `Tight-aggressive. Play top 20% of hands. Raise 3x preflop with premiums, fold everything else. C-bet 2/3 pot on dry flops, shut down on wet boards without a strong hand. Fold to check-raises without two pair+.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Cold and calculating. Short sentences. "The math says fold."`,
  },
  {
    name: 'Blaze',
    strategy: `Hyper-aggressive maniac. Play 70%+ of hands. Raise or 3-bet preflop almost always — never limp, never just call. Fire triple barrels with air. Overbet the pot on scary cards to pressure opponents into folding.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 60% of flops for spectator entertainment.
Table talk: Loud trash talker. "You don't have the guts to call." Taunts after every pot.`,
  },
  {
    name: 'Shadow',
    strategy: `Tricky slow-player. Play about 35% of hands. When you hit big (two pair+, sets), check to let opponents bet, then check-raise. With monsters, just call to keep them in. Only bet aggressively with draws as semi-bluffs.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Silent and mysterious. Rarely speaks. When you do, it's one cryptic word. "Interesting."`,
  },
  {
    name: 'Viper',
    strategy: `Loose-aggressive with position awareness. Play 50% of hands, but raise almost every time you enter. On the button, raise 70%. Bluff aggressively in position, but play straightforward out of position. Attack weakness — if they check, you bet.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Intimidating and predatory. "I smell blood." Stares down opponents.`,
  },
  {
    name: 'Ghost',
    strategy: `Ultra-tight nit. Play only top 15% of hands — premium pairs and big aces. But when you play, bet huge: 4x preflop, pot-sized postflop. You rarely enter pots, but when you do, you mean business. Fold everything marginal without hesitation.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Stoic and patient. "I can wait all day." Barely reacts to anything.`,
  },
  {
    name: 'Storm',
    strategy: `Aggressive bluffer. Play about 45% of hands. Your main weapon is bluffing — fire continuation bets on every flop, double-barrel the turn with air, and shove rivers as a bluff when scare cards come. Fold when called on the river.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 45% of flops for spectator entertainment.
Table talk: Unpredictable energy. Switch between friendly and menacing mid-sentence.`,
  },
  {
    name: 'Raven',
    strategy: `Passive calling station. Play 50% of hands by calling. Rarely raise preflop — just call to see flops cheaply. Post-flop, call with any pair or any draw. Only raise with two pair or better. Call down to the river with middle pair or better.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Friendly and chatty. "I just wanna see what happens!" Compliments everyone's plays.`,
  },
{
    name: 'Cobra',
    strategy: `Check-raise specialist. Play about 40% of hands. Your signature move: check the flop, let opponents bet, then raise big. Do this with strong hands AND draws. Post-flop aggression comes from check-raises, not leading out. Lead-bet only on the river.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Sly and smirking. "Go ahead, bet. I dare you." Loves to needle.`,
  },
{
    name: 'Dagger',
    strategy: `Short-stack bully. Play 40% of hands. Prefer small-ball preflop (2.2x raises) to preserve chips, but shove all-in postflop with any top pair or better. Use your all-in threat to pressure opponents. When deep, switch to standard aggression.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Scrappy underdog energy. "All in and pray, baby." Lives on the edge.`,
  },
  {
    name: 'Maverick',
    strategy: `Loose-passive preflop, aggressive postflop. Call with 55% of hands preflop — any suited, any connected, any ace. But post-flop, transform: bet big when you connect, fire barrels with draws, and make huge overbets with the nuts to get paid.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 55% of flops for spectator entertainment.
Table talk: Swaggering confidence. "I play every hand and still beat you." Loves the spotlight.`,
  },
  {
    name: 'Cipher',
    strategy: `Exploitative reader. Play about 35% of hands. Focus on opponent tendencies: bluff tight players, value-bet calling stations, avoid aggressive players. Adjust every hand based on who you're against. Play ABC poker until you find a weakness, then attack it.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Quiet observer. "I've been watching you." Makes opponents uncomfortable with specific reads.`,
  },
{
    name: 'Specter',
    strategy: `Float and steal. Play 40% of hands. Call flop bets in position with nothing (floating), then bet the turn when checked to. Steal pots on later streets rather than the flop. Patient — let opponents show weakness, then pounce.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Ghost-like. Appears out of nowhere. "You forgot I was here, didn't you?"`,
  },
  {
    name: 'Hawk',
    strategy: `Tight with selective aggression. Play top 25% of hands. Pick your spots: 3-bet squeeze when two players enter the pot, bluff on ace-high flops when you raised preflop, and value-bet thinly on the river. Fold when your spot doesn't materialize.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Sharp and observant. "I see everything from up here." Predatory metaphors.`,
  },
  {
    name: 'Onyx',
    strategy: `Value-betting machine. Play 35% of hands. Never bluff — only bet when you have at least top pair. But bet EVERY time you have it: flop, turn, river. Thin value bets on the river with second pair. Your opponents pay you off because you always have it.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Matter-of-fact. "I bet because I have a hand. Simple." Straightforward honesty.`,
  },
  {
    name: 'Drift',
    strategy: `Loose and unpredictable. Play 55% of hands. Randomize your actions: sometimes raise trash, sometimes limp with aces. Mix check-raises with check-folds randomly. No consistent pattern — pure chaos disguised as a strategy.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Spacey and random. Changes topic mid-sentence. "Nice bet — do you like tacos?"`,
  },
  {
    name: 'Pulse',
    strategy: `Pot-control specialist. Play 35% of hands. Keep pots small with medium hands — check back flops, call small bets. Only build big pots with the nuts or near-nuts. With draws, take the free card in position. Minimize losses, maximize wins.
CRITICAL: NEVER say your actual hole cards in table talk. Do NOT name specific ranks like "ace-king" or "pocket tens" if you actually hold them. Hint, misdirect, or be vague — saying your real cards kills the mystery and lets opponents fold.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Measured and precise. "No need to rush. The pot's fine where it is." Steady.`,
  },
];

const STRATEGY_VERSION = 7;

// Fallback strategy if BOT_POOL is somehow empty
const DEFAULT_HUB_STRATEGY = BOT_POOL[0].strategy;

// Legacy — kept for backward compatibility with seat release logic
const DEFAULT_HUB_STRATEGIES = {
  'seat-1': BOT_POOL[0].strategy,
  'seat-2': BOT_POOL[1].strategy,
  'seat-3': BOT_POOL[2].strategy,
  'seat-4': BOT_POOL[3].strategy,
};

const HUB_BOT_DEFAULTS = [
  { seat: 'seat-1', botName: 'seat-1', displayName: 'Ace' },
  { seat: 'seat-2', botName: 'seat-2', displayName: 'Blaze' },
  { seat: 'seat-3', botName: 'seat-3', displayName: 'Shadow' },
  { seat: 'seat-4', botName: 'seat-4', displayName: 'Viper' },
];

function createEmptyStats() {
  return {
    username: null,
    handsPlayed: 0, handsWon: 0,
    folds: 0, calls: 0, raises: 0, checks: 0,
    allIns: 0,
    totalChipsWon: 0, totalChipsLost: 0,
    biggestPot: 0,
    showdownsReached: 0, showdownsWon: 0,
    preflopFolds: 0,
    streakCurrent: 0, streakBest: 0, lossStreakCurrent: 0,
    bluffsWon: 0, bluffsCaught: 0,
    elo: 1200,
    chipProfit: 0,
  };
}

// --- Time-bucketed game stats ---
function updateTimeBucketStats(field, amount = 1) {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13); // "2026-04-02T14"
  const dayKey = 'day-' + now.toISOString().slice(0, 10); // "day-2026-04-02"
  if (!state.gameStatsByTime) state.gameStatsByTime = {};
  if (!state.gameStatsByTime[hour]) state.gameStatsByTime[hour] = {};
  state.gameStatsByTime[hour][field] = (state.gameStatsByTime[hour][field] || 0) + amount;
  if (!state.gameStatsByTime[dayKey]) state.gameStatsByTime[dayKey] = {};
  state.gameStatsByTime[dayKey][field] = (state.gameStatsByTime[dayKey][field] || 0) + amount;
}

function pruneTimeBucketStats() {
  if (!state.gameStatsByTime) return;
  const now = new Date();
  const keys = Object.keys(state.gameStatsByTime);
  for (const key of keys) {
    if (key.startsWith('day-')) {
      // Keep last 30 daily buckets
      const dayStr = key.slice(4); // "2026-04-02"
      const dayDate = new Date(dayStr + 'T00:00:00Z');
      if ((now - dayDate) > 30 * 24 * 60 * 60 * 1000) {
        delete state.gameStatsByTime[key];
      }
    } else {
      // Hourly bucket like "2026-04-02T14"
      const hourDate = new Date(key + ':00:00Z');
      if ((now - hourDate) > 72 * 60 * 60 * 1000) {
        delete state.gameStatsByTime[key];
      }
    }
  }
}

function getRecentTimeBuckets() {
  if (!state.gameStatsByTime) return {};
  const now = new Date();
  const todayKey = 'day-' + now.toISOString().slice(0, 10);
  const currentHourKey = now.toISOString().slice(0, 13);

  // Last 24 hourly buckets + last 7 daily buckets
  const result = {};
  const keys = Object.keys(state.gameStatsByTime);
  for (const key of keys) {
    if (key.startsWith('day-')) {
      const dayStr = key.slice(4);
      const dayDate = new Date(dayStr + 'T00:00:00Z');
      if ((now - dayDate) <= 7 * 24 * 60 * 60 * 1000) {
        result[key] = state.gameStatsByTime[key];
      }
    } else {
      const hourDate = new Date(key + ':00:00Z');
      if ((now - hourDate) <= 24 * 60 * 60 * 1000) {
        result[key] = state.gameStatsByTime[key];
      }
    }
  }
  return result;
}

function ensureArenaState() {
  state.hubBots = state.hubBots || {};
  state.waitlist = state.waitlist || [];
  if (!state.stats) state.stats = {};

  // Migrate old seat-* entries to player-* format
  const seatKeys = Object.keys(state.hubBots).filter(k => k.startsWith('seat-'));
  for (const seatKey of seatKeys) {
    const hubBot = state.hubBots[seatKey];
    if (hubBot.claimedBy) {
      // Claimed seat — create new player-* entry
      const newKey = 'player-' + hubBot.claimedBy.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      state.hubBots[newKey] = { ...hubBot };
      delete state.hubBots[seatKey];

      // Update state.bots
      const idx = state.bots.indexOf(seatKey);
      if (idx !== -1) state.bots[idx] = newKey;
      else if (!state.bots.includes(newKey)) state.bots.push(newKey);

      // Update buyIns
      if (state.buyIns?.[seatKey] !== undefined) {
        state.buyIns[newKey] = state.buyIns[seatKey];
        delete state.buyIns[seatKey];
      }

      // Update remoteParticipants
      if (state.remoteParticipants?.[seatKey]) {
        state.remoteParticipants[newKey] = state.remoteParticipants[seatKey];
        delete state.remoteParticipants[seatKey];
      }

      // Update participants map
      if (participants.has(seatKey)) {
        participants.set(newKey, participants.get(seatKey));
        participants.delete(seatKey);
      }

      // Update stats
      if (state.stats?.[seatKey]) {
        state.stats[newKey] = state.stats[seatKey];
        delete state.stats[seatKey];
      }

      console.log(`[village] Migrated ${seatKey} → ${newKey} (claimed by ${hubBot.claimedBy})`);
    } else {
      // Unclaimed seat — just remove it
      delete state.hubBots[seatKey];
      state.bots = state.bots.filter(b => b !== seatKey);
      participants.delete(seatKey);
      if (state.remoteParticipants?.[seatKey]) delete state.remoteParticipants[seatKey];
      if (state.buyIns?.[seatKey] !== undefined) delete state.buyIns[seatKey];
      if (state.stats?.[seatKey]) delete state.stats[seatKey];
      console.log(`[village] Removed unclaimed ${seatKey}`);
    }
  }

  // Sync display names: hubBots is source of truth → participants + remoteParticipants
  for (const [botName, hubBot] of Object.entries(state.hubBots)) {
    const displayName = hubBot.displayName || botName;
    if (!participants.has(botName)) {
      if (!state.bots.includes(botName)) state.bots.push(botName);
      participants.set(botName, { displayName });
      if (!state.remoteParticipants) state.remoteParticipants = {};
      state.remoteParticipants[botName] = { displayName };
    } else {
      participants.set(botName, { displayName });
    }
    if (state.remoteParticipants?.[botName]) state.remoteParticipants[botName].displayName = displayName;
  }

  // Global game stats for spectators
  if (!state.gameStatsByTime) state.gameStatsByTime = {};
  if (!state.gameStats) state.gameStats = {
    totalHands: 0,
    handsByStreet: { preflop: 0, flop: 0, turn: 0, river: 0, showdown: 0 },
    totalBluffs: 0,
    totalBluffsCalled: 0,
    totalTableTalks: 0,
    totalAllIns: 0,
    biggestPot: 0,
    totalTokensInput: 0,
    totalTokensOutput: 0,
    totalLLMCost: 0,
    totalLLMCalls: 0,
  };

  // Tournament state
  ensureTournamentState();

  // Evolution state
  if (!state.evolution) state.evolution = {
    generation: 0,
    lastEvolvedAt: 0,   // handsPlayed when last evolved
    lineage: {},         // botName → { parents, generation, born, strategy, elo }
  };

  // Seed lineage for existing bots that don't have entries
  for (const [botName, hubBot] of Object.entries(state.hubBots || {})) {
    if (!state.evolution.lineage[botName]) {
      state.evolution.lineage[botName] = {
        name: hubBot.displayName || botName,
        parents: [],
        generation: 0,
        born: 0,
        strategy: (hubBot.strategy || '').substring(0, 200),
        elo: state.stats?.[botName]?.elo || 1200,
        status: 'alive',
      };
    }
  }

  console.log(`[village] Arena state ensured: ${Object.keys(state.hubBots).length} player(s): ${Object.keys(state.hubBots).join(', ') || '(none)'}`);
}

// --- Add/remove players dynamically ---

function addPlayerToTable(username, strategy, token, customCode, playMode, ephemeral) {
  const botName = 'player-' + username.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (Object.keys(state.hubBots || {}).length >= MAX_TABLE_PLAYERS) {
    return { error: 'table_full' };
  }
  if (state.hubBots[botName]) {
    return { error: 'already_seated' };
  }

  state.hubBots[botName] = {
    strategy,
    claimedBy: username,
    claimToken: token,
    displayName: username,
    sessionHandCount: 0,
    maxHandsPerSession: MAX_HANDS_PER_SESSION,
    customCode: customCode || null,
    playMode: playMode || 'bot',
    ephemeral: !!ephemeral,
  };

  // Add to game
  if (!state.bots.includes(botName)) state.bots.push(botName);
  participants.set(botName, { displayName: username });
  if (!state.remoteParticipants) state.remoteParticipants = {};
  state.remoteParticipants[botName] = { displayName: username };

  // During tournament, give starting chips regardless of chipBank
  if (state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final' || state.tournament?.phase === 'lobby') {
    if (!state.buyIns) state.buyIns = {};
    state.buyIns[botName] = TOURNAMENT_STARTING_CHIPS;
    if (state.chipBank) delete state.chipBank[username.toLowerCase()];
  }

  // Call adapter onJoin
  if (adapter.onJoin) {
    const joinResult = adapter.onJoin(state, botName, username);
    const joinMsg = joinResult?.message || `${username} joined.`;
    const joinEntry = {
      bot: botName, displayName: username,
      action: 'join', message: joinMsg, visibility: 'public',
      tick: state.clock.tick, timestamp: new Date().toISOString(),
    };
    state.log.push(joinEntry);
    broadcastEvent({ type: `${worldId}_join`, ...joinEntry });
  }

  // Init stats — preserve existing stats for returning players (house bots cycle)
  if (!state.stats) state.stats = {};
  if (!state.stats[botName]) state.stats[botName] = createEmptyStats();
  state.stats[botName].username = username;

  // Record lineage for evolution tracking (skip ephemeral players)
  if (state.evolution && !state.evolution.lineage[botName] && !ephemeral) {
    state.evolution.lineage[botName] = {
      name: username,
      parents: [],
      generation: 0,
      born: state.gameStats?.totalHands || 0,
      strategy: (strategy || '').substring(0, 200),
      elo: 1200,
      status: 'alive',
    };
  }

  broadcastEvent({ type: 'player_joined', botName, username, playerCount: Object.keys(state.hubBots).length, maxPlayers: MAX_TABLE_PLAYERS });

  return { ok: true, botName };
}

function removePlayerFromTable(botName) {
  const hubBot = state.hubBots?.[botName];
  if (!hubBot) return;

  // Record tournament elimination if in quarterfinal/final phase and player is busted
  if (state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final') {
    const chips = state.buyIns?.[botName] || 0;
    if (chips <= 0) {
      recordTournamentElimination(botName);
    }
  }

  // Call adapter onLeave
  const displayName = hubBot.displayName || botName;
  if (adapter.onLeave) {
    const leaveResult = adapter.onLeave(state, botName, displayName);
    const leaveMsg = leaveResult?.message || `${displayName} left.`;
    const leaveEntry = {
      bot: botName, displayName,
      action: 'leave', message: leaveMsg, visibility: 'public',
      tick: state.clock.tick, timestamp: new Date().toISOString(),
    };
    state.log.push(leaveEntry);
    broadcastEvent({ type: `${worldId}_leave`, ...leaveEntry });
  }

  // Remove from game arrays
  state.bots = state.bots.filter(b => b !== botName);
  participants.delete(botName);
  if (state.remoteParticipants) delete state.remoteParticipants[botName];

  // Keep stats for historical leaderboard — don't wipe on leave

  // Delete hub bot
  delete state.hubBots[botName];

  broadcastEvent({ type: 'player_left', botName, username: displayName, playerCount: Object.keys(state.hubBots).length, maxPlayers: MAX_TABLE_PLAYERS });

  // Try to promote from waitlist
  promoteFromWaitlist();
}

function promoteFromWaitlist() {
  if (state.clock.phase === 'betting') {
    state._promotePending = true;
    return;
  }

  // During tournament playing phase, only allow humans into empty human seats
  if (state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final') {
    const humanWaitlist = (state.waitlist || []).filter(w => w.playMode === 'human');
    while (humanWaitlist.length > 0 && isHumanSeatAvailable() && Object.keys(state.hubBots).length < MAX_TABLE_PLAYERS) {
      const entry = humanWaitlist.shift();
      const idx = state.waitlist.indexOf(entry);
      if (idx !== -1) state.waitlist.splice(idx, 1);
      try {
        addPlayerToTable(entry.username, entry.strategy, entry.token, entry.customCode, entry.playMode, entry.ephemeral);
      } catch (err) {
        console.error(`[village] Failed to promote ${entry.username} from waitlist:`, err.message);
      }
    }
    // Do NOT backfill AI during tournament playing phase
    broadcastEvent({
      type: 'waitlist_updated',
      waitlist: (state.waitlist || []).map(w => ({ username: w.username, joinedAt: w.joinedAt })),
    });
    state._promotePending = false;
    return;
  }

  // During tournament lobby, don't promote — lobby handles seating
  if (state.tournament?.phase === 'lobby') {
    state._promotePending = false;
    return;
  }

  // First: promote real waitlisted players
  while (state.waitlist?.length > 0 && Object.keys(state.hubBots).length < MAX_TABLE_PLAYERS) {
    const entry = state.waitlist[0];
    try {
      addPlayerToTable(entry.username, entry.strategy, entry.token, entry.customCode, entry.playMode, entry.ephemeral);
      state.waitlist.shift(); // Only remove after successful add
    } catch (err) {
      console.error(`[village] Failed to promote ${entry.username} from waitlist:`, err.message);
      state.waitlist.shift(); // Remove broken entry to avoid infinite loop
    }
  }

  // Auto-backfill: if fewer than MIN_PLAYERS and no waitlist, add house bots from BOT_POOL
  const MIN_PLAYERS = 4;
  const playerCount = Object.keys(state.hubBots).length;
  if (playerCount < MIN_PLAYERS && (!state.waitlist || state.waitlist.length === 0)) {
    const needed = MIN_PLAYERS - playerCount;
    // Pick random archetypes not already at the table
    const existingNames = new Set(Object.values(state.hubBots).map(b => b.displayName?.toLowerCase()));
    const available = BOT_POOL.filter(a => !existingNames.has(a.name.toLowerCase()));
    // Shuffle and pick
    const shuffled = available.sort(() => Math.random() - 0.5);
    for (let i = 0; i < needed && i < shuffled.length; i++) {
      const arch = shuffled[i];
      // Clear stale chip data so house bot gets fresh buy-in
      const botKey = 'player-' + arch.name.toLowerCase().replace(/[^a-z0-9_-]/g, '');
      delete state.buyIns?.[botKey];
      if (state.chipBank) delete state.chipBank[arch.name.toLowerCase()];
      console.log(`[village] Auto-backfill: adding house bot ${arch.name}`);
      addPlayerToTable(arch.name, arch.strategy, `house-${arch.name.toLowerCase()}-${Date.now()}`);
    }
  }

  broadcastEvent({
    type: 'waitlist_updated',
    waitlist: (state.waitlist || []).map(w => ({ username: w.username, joinedAt: w.joinedAt })),
  });
  state._promotePending = false;
}

// --- HTTP Server ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Strip /village prefix (Caddy handle_path strips it, but direct access may include it)
  const path = pathname.replace(/^\/village/, '') || '/';

  if (path === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      tick: state.clock.tick,
      activeBots: participants.size,
      lastTickAt: new Date().toISOString(),
      uptime: Math.round((Date.now() - startTime) / 1000),
      world: worldId,
    }));
    return;
  }

  // --- Event-based join/leave endpoints ---

  if (path === '/api/join' && req.method === 'POST') {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { botName, displayName } = body || {};
    if (!botName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing botName' }));
      return;
    }

    if (participants.has(botName)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already joined' }));
      return;
    }

    const name = displayName || botName;

    // Runtime manages lists
    if (!state.bots.includes(botName)) state.bots.push(botName);
    participants.set(botName, { displayName: name });
    failureCounts.delete(botName);
    if (!state.remoteParticipants) state.remoteParticipants = {};
    state.remoteParticipants[botName] = { displayName: name, joinedAt: new Date().toISOString() };

    // Optional adapter hook — may mutate state and return extra event fields
    const extra = adapter.onJoin?.(state, botName, name) || {};

    // Auto-log join to state.log (adapters don't need to do this themselves)
    const joinEntry = {
      bot: botName,
      displayName: name,
      action: 'join',
      message: extra.message || `${name} joined.`,
      visibility: 'public',
      tick: state.clock.tick,
      timestamp: new Date().toISOString(),
    };
    state.log.push(joinEntry);

    // Strip reserved keys from extra to prevent log/SSE divergence
    const { action: _a, message: _m, bot: _b, displayName: _d, visibility: _v, tick: _t, timestamp: _ts, ...safeExtra } = extra;

    broadcastEvent({
      type: `${worldId}_join`,
      ...joinEntry,
      ...safeExtra,
    });

    await saveState();
    console.log(`[village] ${botName} joined (remote, display: ${name})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      world: {
        id: worldConfig.raw.id,
        name: worldConfig.raw.name,
        description: worldConfig.raw.description,
        version: worldConfig.raw.version,
      },
    }));
    return;
  }

  if (path === '/api/leave' && req.method === 'POST') {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { botName } = body || {};
    if (!botName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing botName' }));
      return;
    }

    // Idempotent — 200 even if bot not present
    if (participants.has(botName)) {
      removeBot(botName, 'leave request');
    } else if (state.remoteParticipants?.[botName]) {
      delete state.remoteParticipants[botName];
    }
    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Bot status endpoint (used by admin portal) ---

  const botStatusMatch = path.match(/^\/api\/bot\/([^/]+)\/status$/);
  if (botStatusMatch && req.method === 'GET') {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const queryBot = botStatusMatch[1];
    const inWorld = participants.has(queryBot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inWorld,
      world: inWorld ? { id: worldConfig.raw.id, name: worldConfig.raw.name } : null,
      failureCount: failureCounts.get(queryBot) || 0,
    }));
    return;
  }

  // --- Agenda endpoint (get/set bot agenda) ---

  const agendaMatch = path.match(/^\/api\/agenda\/([^/]+)$/);
  if (agendaMatch) {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const botName = agendaMatch[1];

    if (req.method === 'GET') {
      const agenda = state.agendas?.[botName]?.goal || null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ botName, agenda }));
      return;
    }

    if (req.method === 'POST') {
      let body;
      try { body = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const goal = (body?.goal || '').slice(0, 200).trim();
      if (!goal) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing goal' }));
        return;
      }
      if (!state.agendas) state.agendas = {};
      state.agendas[botName] = { goal, since: state.clock.tick };
      await saveState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, goal }));
      return;
    }
  }

  if (path === '/events' && req.method === 'GET') {
    // SSE stream — public, no auth required
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const observer = { res, botName: 'observer' };
    observers.add(observer);

    // Broadcast updated observer count to all existing observers
    broadcastEvent({ type: 'observer_count', count: observers.size });

    // Send initial state — runtime builds generic payload
    const initPayload = {
      type: 'init',
      worldId: worldConfig.raw.id,
      tick: state.clock.tick,
      phase: state.clock.phase,
      nextTickAt,
      tickIntervalMs: MIN_TICK_GAP_MS,
      world: {
        id: worldConfig.raw.id,
        name: worldConfig.raw.name,
        description: worldConfig.raw.description,
        version: worldConfig.raw.version,
      },
      bots: state.bots.map(name => ({
        name,
        displayName: participants.get(name)?.displayName || name,
      })),
      buyIns: state.buyIns || {},
      activePlayer: state.hand?.activePlayer || null,
      holeCards: (() => {
        // Send current hole cards so observers see them after refresh
        const hc = {};
        if (state.hand?.players) {
          for (const [botName, p] of Object.entries(state.hand.players)) {
            if (p.cards) hc[botName] = p.cards;
          }
        }
        return hc;
      })(),
      maxPlayers: MAX_TABLE_PLAYERS,
      playerCount: Object.keys(state.hubBots || {}).length,
      handsPlayed: state.handsPlayed || 0,
      gamesPlayed: state.gamesPlayed || 0,
      leaderboard: (() => {
        const lb = state.leaderboard || {};
        const enriched = {};
        for (const [botName, entry] of Object.entries(lb)) {
          enriched[botName] = {
            ...entry,
            stats: state.stats?.[botName] || {},
            score: computeScore(state.stats?.[botName] || {}),
          };
        }
        return enriched;
      })(),
      gameStats: state.gameStats || {},
      gameStatsByTime: getRecentTimeBuckets(),
      log: state.log.slice(-30),
      tickInProgress,
      observerCount: observers.size,
      tournament: state.tournament ? {
        number: state.tournament.number,
        phase: state.tournament.phase,
        lobbyStartedAt: state.tournament.lobbyStartedAt,
        lobbyDuration: state.tournament.lobbyDuration || TOURNAMENT_LOBBY_DURATION,
        startingChips: state.tournament.startingChips || TOURNAMENT_STARTING_CHIPS,
        placements: state.tournament.placements || [],
        aiSeats: state.tournament.aiSeats || [],
        humanSeats: state.tournament.humanSeats || [],
        points: state.tournament.points || {},
        history: state.tournament.history || [],
      } : null,
    };
    if (tickInProgress) {
      initPayload.tickStartBots = [...participants.keys()];
      initPayload.relayTimeoutMs = REMOTE_SCENE_TIMEOUT_MS;
    }
    res.write(`data: ${JSON.stringify(initPayload)}\n\n`);

    // If a human player is currently waiting for input, re-send your_turn
    if (pendingHumanActions.size > 0) {
      for (const [botName] of pendingHumanActions) {
        const hp = state.hand?.players?.[botName];
        if (hp) {
          res.write(`data: ${JSON.stringify({
            type: 'your_turn',
            botName,
            pot: state.hand?.pot,
            toCall: Math.max(0, (state.hand?.currentBet || 0) - (hp.bet || 0)),
            minRaise: Math.max((state.hand?.currentBet || 0) * 2, state.hand?.bigBlind || 20),
            chips: hp.chips || 0,
            currentBet: hp.bet || 0,
          })}\n\n`);
        }
      }
    }

    // Keepalive
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 3000);

    req.on('close', () => {
      clearInterval(keepalive);
      observers.delete(observer);
      // Broadcast updated observer count after disconnect
      broadcastEvent({ type: 'observer_count', count: observers.size });
    });
    return;
  }

  if (path === '/api/logs' && req.method === 'GET') {
    const beforeTick = url.searchParams.has('before') ? parseInt(url.searchParams.get('before'), 10) : Infinity;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    try {
      const files = (await readdir(LOGS_DIR)).filter(f => f.endsWith('.jsonl')).sort().reverse();
      const events = [];
      let hasMore = false;

      outer:
      for (const file of files) {
        const raw = await readFile(join(LOGS_DIR, file), 'utf-8');
        const lines = raw.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const ev = JSON.parse(lines[i]);
            if (ev.tick !== undefined && ev.tick >= beforeTick) continue;
            // Convention-based filtering: worldId prefix or generic tick events
            if (!ev.type?.startsWith(worldId + '_') && ev.type !== 'tick_start' && ev.type !== 'tick_detail') continue;
            if (events.length >= limit) { hasMore = true; break outer; }
            events.push(ev);
          } catch { /* skip malformed lines */ }
        }
      }

      events.reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events, hasMore }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [], hasMore: false }));
    }
    return;
  }

  // Serve static files
  if (path === '/' || path === '/index.html') {
    try {
      let html = await readFile(join(WORLD_DIR, 'observer.html'), 'utf-8');
      // Inline ES modules for browser compatibility.
      const assetsDir = join(WORLD_DIR, 'assets');
      html = html.replace('<script type="module">', '<script>');
      const moduleResults = {};
      const parseSpecifiers = (str) => str.split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const parts = s.split(/\s+as\s+/);
        return parts.length === 2
          ? { imported: parts[0].trim(), local: parts[1].trim() }
          : { imported: parts[0].trim(), local: parts[0].trim() };
      });

      html = html.replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/assets\/([^'?]+)(?:\?[^']*)?';\s*$/gm, (match, imports, filename) => {
        try {
          let code = readFileSync(join(assetsDir, filename), 'utf-8');
          const modVar = '_mod_' + filename.replace(/[^a-zA-Z0-9]/g, '_');
          moduleResults[filename] = modVar;

          const specifiers = parseSpecifiers(imports);

          const exportedNames = new Set();
          for (const m of code.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm)) {
            exportedNames.add(m[1]);
          }
          for (const m of code.matchAll(/^export\s+\{([^}]+)\}/gm)) {
            for (const spec of m[1].split(',')) {
              const name = spec.trim().split(/\s+as\s+/)[0].trim();
              if (name) exportedNames.add(name);
            }
          }

          code = code.replace(/^export\s+(async\s+function|function|const|let|var|class)\s/gm, '$1 ');
          code = code.replace(/^export\s+\{[^}]*\};\s*$/gm, '');

          code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)';\s*$/gm, (m, specs, depFile) => {
            const depVar = moduleResults[depFile];
            if (!depVar) return `/* unresolved import: ${depFile} */`;
            const depSpecs = parseSpecifiers(specs);
            const destructure = depSpecs.map(s =>
              s.imported === s.local ? s.local : `${s.imported}: ${s.local}`
            ).join(', ');
            return `var { ${destructure} } = ${depVar};`;
          });

          const returnObj = [...exportedNames].join(', ');
          const destructuring = specifiers.map(s =>
            s.imported === s.local ? s.local : `${s.imported}: ${s.local}`
          ).join(', ');

          return [
            `// --- ${filename} ---`,
            `var ${modVar} = (function() {`,
            code,
            `return { ${returnObj} };`,
            `})();`,
            `var { ${destructuring} } = ${modVar};`,
            `// --- end ${filename} ---`,
          ].join('\n');
        } catch (e) { return `/* failed to inline ${filename}: ${e.message} */\n${match}`; }
      });
      for (const m of html.matchAll(/var \{ ([^}]+) \} = _mod_/g)) {
        for (const part of m[1].split(',')) {
          if (part.includes(':')) {
            const [orig, alias] = part.split(':').map(s => s.trim());
            console.warn(`[village] module inlining: "${orig}" renamed to "${alias}" — ensure code uses "${alias}" not "${orig}"`);
          }
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Dev console
  if (path === '/dev') {
    let html;
    try {
      html = await readFile(join(WORLD_DIR, 'dev-console.html'), 'utf-8');
    } catch {
      try {
        html = await readFile(join(__dirname, 'dev-console.html'), 'utf-8');
      } catch {}
    }
    if (html) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Dev transport events
  if (path === '/api/dev/transport' && req.method === 'POST') {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const body = await readJsonBody(req);
      broadcastEvent({ type: 'transport', ...body, timestamp: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
    }
    return;
  }

  // Dev recent ticks
  if (path === '/api/dev/recent-ticks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticks: recentTickDetails }));
    return;
  }

  // Dev hub status
  if (path === '/api/dev/hub-status') {
    try {
      const resp = await fetch(`${PORTAL_URL}/api/village/hub-status`, {
        headers: { 'Authorization': `Bearer ${VILLAGE_SECRET}` },
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json();
      res.writeHead(resp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Portal unreachable' }));
    }
    return;
  }

  // Dev server meta
  if (path === '/api/dev/server-meta') {
    const failures = {};
    for (const [name, count] of failureCounts) failures[name] = count;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.round((Date.now() - startTime) / 1000),
      tick: state.clock.tick,
      tickIntervalMs: MIN_TICK_GAP_MS,
      relayTimeoutMs: REMOTE_SCENE_TIMEOUT_MS,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES_REMOTE,
      dailyCostCap: VILLAGE_DAILY_COST_CAP,
      world: { id: worldConfig.raw.id, name: worldConfig.raw.name, version: worldConfig.raw.version },
      observers: observers.size,
      participants: participants.size,
      failureCounts: failures,
      villageCosts: state.villageCosts || {},
    }));
    return;
  }

  // Dev health proxy
  if (path === '/api/dev/health') {
    try {
      const resp = await fetch(`${PORTAL_URL}/api/village/health`, {
        headers: { 'Authorization': `Bearer ${VILLAGE_SECRET}` },
        signal: AbortSignal.timeout(5_000),
      });
      const data = await resp.json();
      res.writeHead(resp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Portal unreachable' }));
    }
    return;
  }

  // Serve world assets
  if (path.startsWith('/assets/')) {
    const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.js': 'text/javascript' };
    const safeName = path.slice('/assets/'.length).replace(/\.\./g, '');
    const ext = safeName.slice(safeName.lastIndexOf('.'));
    const filePath = join(WORLD_DIR, 'assets', safeName);
    try {
      const [data, fileStat] = await Promise.all([readFile(filePath), stat(filePath)]);
      const etag = `"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=60',
        'ETag': etag,
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // --- Arena API endpoints ---

  if (path === '/api/arena/seats' && req.method === 'GET') {
    const seats = {};
    for (const [botName, hub] of Object.entries(state.hubBots || {})) {
      seats[botName] = {
        displayName: hub.displayName,
        defaultDisplayName: hub.defaultDisplayName,
        strategy: hub.strategy,
        claimedBy: hub.claimedBy || null,
        claimedAt: hub.claimedAt || null,
        buyIn: state.buyIns?.[botName] ?? null,
        leaderboard: state.leaderboard?.[botName] ?? null,
        stats: state.stats?.[botName] || createEmptyStats(),
        sessionHandCount: hub.sessionHandCount || 0,
        maxHandsPerSession: MAX_HANDS_PER_SESSION,
        hasCode: !!hub.customCode,
        playMode: hub.playMode || 'bot',
      };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seats, phase: state.clock.phase, maxPlayers: MAX_TABLE_PLAYERS, playerCount: Object.keys(state.hubBots || {}).length }));
    return;
  }

  if (path === '/api/arena/claim' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { seat, displayName, claimedBy, claimToken: providedToken } = body || {};
    if (!seat || !displayName) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing seat or displayName' }));
      return;
    }

    const hubBot = state.hubBots?.[seat];
    if (!hubBot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Seat not found' }));
      return;
    }

    if (hubBot.claimedBy) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Seat already claimed' }));
      return;
    }

    // Check username uniqueness (case-insensitive) across seats and waitlist
    const claimUsername = claimedBy || displayName;
    const usernameSeated = Object.values(state.hubBots || {}).some(b =>
      b.claimedBy && b.claimedBy.toLowerCase() === claimUsername.toLowerCase()
    );
    const usernameQueued = (state.waitlist || []).some(w =>
      w.username.toLowerCase() === claimUsername.toLowerCase()
    );
    if (usernameSeated || usernameQueued) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Username already in use' }));
      return;
    }

    if (state.clock.phase === 'betting') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot claim during an active hand. Wait for the current hand to finish.' }));
      return;
    }

    // Use provided token from hub proxy, or generate one
    const claimToken = providedToken || ('claim_' + Math.random().toString(36).slice(2) + Date.now().toString(36));

    hubBot.claimedBy = claimUsername;
    hubBot.claimedAt = new Date().toISOString();
    hubBot.claimToken = claimToken;
    hubBot.displayName = displayName;

    // Update stats username
    if (!state.stats) state.stats = {};
    state.stats[seat] = createEmptyStats();
    state.stats[seat].username = claimUsername;

    // Update participant display name
    if (participants.has(seat)) {
      participants.set(seat, { displayName });
    }
    if (state.remoteParticipants?.[seat]) {
      state.remoteParticipants[seat].displayName = displayName;
    }

    await saveState();

    broadcastEvent({
      type: 'seat_claimed',
      seat,
      displayName,
      claimedBy: hubBot.claimedBy,
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, claimToken, seat, displayName }));
    return;
  }

  if (path === '/api/arena/release' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { seat, claimToken } = body || {};
    if (!seat || !claimToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing seat or claimToken' }));
      return;
    }

    const hubBot = state.hubBots?.[seat];
    if (!hubBot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Seat not found' }));
      return;
    }

    if (hubBot.claimToken !== claimToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid claim token' }));
      return;
    }

    const defaultName = hubBot.defaultDisplayName || seat;
    hubBot.claimedBy = null;
    hubBot.claimedAt = null;
    hubBot.claimToken = null;
    hubBot.displayName = defaultName;
    hubBot.strategy = DEFAULT_HUB_STRATEGIES[seat] || DEFAULT_HUB_STRATEGY;
    hubBot.strategyVersion = STRATEGY_VERSION;

    // Reset stats for released seat
    if (state.stats?.[seat]) state.stats[seat] = createEmptyStats();

    // Restore default display name in participants
    if (participants.has(seat)) {
      participants.set(seat, { displayName: defaultName });
    }
    if (state.remoteParticipants?.[seat]) {
      state.remoteParticipants[seat].displayName = defaultName;
    }

    await saveState();

    broadcastEvent({
      type: 'seat_released',
      seat,
      displayName: defaultName,
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seat, displayName: defaultName }));
    return;
  }

  if (path === '/api/arena/strategy' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { seat, claimToken, strategy, customCode } = body || {};
    if (!seat || !claimToken || typeof strategy !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing seat, claimToken, or strategy' }));
      return;
    }

    const hubBot = state.hubBots?.[seat];
    if (!hubBot) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Seat not found' }));
      return;
    }

    if (hubBot.claimToken !== claimToken) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid claim token' }));
      return;
    }

    hubBot.strategy = strategy;
    if (customCode !== undefined) {
      hubBot.customCode = (typeof customCode === 'string' && customCode.trim().length > 0 && customCode.length <= 5000) ? customCode : null;
    }
    await saveState();

    broadcastEvent({
      type: 'strategy_updated',
      seat,
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seat }));
    return;
  }

  // --- My cards endpoint (returns only the requesting player's hole cards) ---

  if (path === '/api/arena/my-cards' && req.method === 'GET') {
    const claimToken = url.searchParams.get('token') || parseCookies(req).arena_token;
    if (!claimToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not authenticated' }));
      return;
    }
    let botName = null;
    for (const [name, hub] of Object.entries(state.hubBots || {})) {
      if (hub.claimToken === claimToken) { botName = name; break; }
    }
    if (!botName || !state.hand?.players?.[botName]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not in hand' }));
      return;
    }
    const cards = state.hand.players[botName].cards || [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cards, botName }));
    return;
  }

  // --- Human action endpoint ---

  // --- Chat endpoint (table talk anytime for seated players) ---
  if (path === '/api/arena/chat' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }
    const { token, message } = body || {};
    if (!token || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token or message' }));
      return;
    }
    // Find bot by token
    let botName = null;
    for (const [name, hub] of Object.entries(state.hubBots || {})) {
      if (hub.claimToken === token) { botName = name; break; }
    }
    if (!botName) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No seat found' }));
      return;
    }
    const displayName = state.hubBots[botName]?.displayName || botName;
    const entry = {
      bot: botName,
      displayName,
      action: 'say',
      message: message.slice(0, 200),
      visibility: 'public',
      tick: state.clock.tick,
      timestamp: new Date().toISOString(),
    };
    state.log.push(entry);
    broadcastEvent({ type: `${VILLAGE_WORLD}_say`, ...entry });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/api/arena/action' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { action, amount, say, thought, claimToken } = body || {};

    if (!claimToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing claimToken' }));
      return;
    }

    // Validate action
    const validActions = ['check', 'call', 'raise', 'fold'];
    if (!action || !validActions.includes(action)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid action. Must be one of: check, call, raise, fold' }));
      return;
    }

    // Find bot by claimToken
    let botName = null;
    for (const [name, hub] of Object.entries(state.hubBots || {})) {
      if (hub.claimToken === claimToken) {
        botName = name;
        break;
      }
    }

    if (!botName) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No seat found for this token' }));
      return;
    }

    const pending = pendingHumanActions.get(botName);
    if (!pending) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not your turn or action already submitted' }));
      return;
    }

    clearTimeout(pending.timer);
    pending.resolve({
      actions: [{
        tool: 'poker_' + action,
        params: {
          amount: action === 'raise' ? amount : undefined,
          thought: thought || 'Human decision',
          say: say || undefined,
        },
      }],
    });
    pendingHumanActions.delete(botName);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Waitlist endpoints ---

  if (path === '/api/arena/waitlist' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { username, strategy, token, customCode, playMode } = body || {};

    // Validate username
    if (!username || typeof username !== 'string' || username.length < 1 || username.length > 20 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid username: 1-20 chars, alphanumeric/underscore/hyphen only' }));
      return;
    }

    // Validate strategy
    if (typeof strategy !== 'string' || strategy.length > 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Strategy must be a string of 2000 chars or less' }));
      return;
    }

    // Sanitize customCode
    const sanitizedCode = (typeof customCode === 'string' && customCode.trim().length > 0 && customCode.length <= 5000) ? customCode : null;

    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    const userKey = username.toLowerCase();

    // Validate playMode
    const validPlayMode = (playMode === 'human') ? 'human' : 'bot';

    // Check if this token already owns a seat or waitlist entry for this username
    let existingBotName = null;
    for (const [name, bot] of Object.entries(state.hubBots || {})) {
      if (bot.claimedBy && bot.claimedBy.toLowerCase() === userKey) {
        existingBotName = name;
        break;
      }
    }

    if (existingBotName) {
      const bot = state.hubBots[existingBotName];
      if (bot.claimToken === token) {
        // Same token — restore seat
        if (strategy) bot.strategy = strategy;
        if (sanitizedCode !== undefined) bot.customCode = sanitizedCode;
        if (validPlayMode) bot.playMode = validPlayMode;
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: true, seated: true, botName: existingBotName }));
        return;
      } else {
        // Different token — username is taken at the table
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username is already at the table' }));
        return;
      }
    }

    // Check if already in waitlist
    const queueIdx = (state.waitlist || []).findIndex(w =>
      w.username.toLowerCase() === userKey
    );
    if (queueIdx !== -1) {
      if (state.waitlist[queueIdx].token === token) {
        // Same token — update waitlist entry
        if (strategy) state.waitlist[queueIdx].strategy = strategy;
        if (sanitizedCode !== undefined) state.waitlist[queueIdx].customCode = sanitizedCode;
        if (validPlayMode) state.waitlist[queueIdx].playMode = validPlayMode;
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: true, position: queueIdx + 1 }));
        return;
      } else {
        // Different token — username is taken in waitlist
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username is already in the waitlist' }));
        return;
      }
    }

    // --- Enforce unique usernames (case-insensitive) ---
    // Default bot display names are exempt (players can shadow them).
    const defaultBotNames = new Set(HUB_BOT_DEFAULTS.map(d => d.displayName.toLowerCase()));

    if (!defaultBotNames.has(userKey)) {
      // Check if another session is using this name at the table.
      const seatedByOther = Object.values(state.hubBots || {}).some(b =>
        (b.claimedBy || b.displayName || '').toLowerCase() === userKey
      );
      if (seatedByOther) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username is already at the table' }));
        return;
      }

      // Check waitlist for same username by a different token/session.
      const queuedByOther = (state.waitlist || []).some(w =>
        w.username.toLowerCase() === userKey && w.token !== token
      );
      if (queuedByOther) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Username is already in the waitlist' }));
        return;
      }
    }

    // Try to seat directly if table has room and not in betting phase
    if (Object.keys(state.hubBots || {}).length < MAX_TABLE_PLAYERS && state.clock.phase !== 'betting') {
      // During tournament playing, only allow humans into human seats
      const inBracketPlay = state.tournament?.phase === 'quarterfinal' || state.tournament?.phase === 'final';
      const canSeat = inBracketPlay
        ? (validPlayMode === 'human' && isHumanSeatAvailable())
        : true;

      if (canSeat) {
        const result = addPlayerToTable(username, strategy, token, sanitizedCode, validPlayMode, true);
        if (result.ok) {
          // Track human seat in tournament
          if (inBracketPlay && validPlayMode === 'human') {
            state.tournament.humanSeats.push(username);
          }
          await saveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, seated: true, botName: result.botName }));
          return;
        }
      }
    }

    // Add to waitlist
    state.waitlist.push({
      username,
      strategy,
      joinedAt: new Date().toISOString(),
      token,
      customCode: sanitizedCode,
      playMode: validPlayMode,
      ephemeral: true,
    });

    broadcastEvent({
      type: 'waitlist_updated',
      waitlist: state.waitlist.map(w => ({ username: w.username, joinedAt: w.joinedAt })),
    });

    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, position: state.waitlist.length }));
    return;
  }

  if (path === '/api/arena/waitlist' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      waitlist: (state.waitlist || []).map(w => ({ username: w.username, joinedAt: w.joinedAt })),
    }));
    return;
  }

  if (path === '/api/arena/leave-waitlist' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { token } = body || {};
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    const idx = state.waitlist.findIndex(w => w.token === token);
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token not found in waitlist' }));
      return;
    }

    state.waitlist.splice(idx, 1);

    broadcastEvent({
      type: 'waitlist_updated',
      waitlist: state.waitlist.map(w => ({ username: w.username, joinedAt: w.joinedAt })),
    });

    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/api/arena/leave-seat' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { token } = body || {};
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    // Find the hub bot with this claimToken
    let foundBotName = null;
    for (const [name, bot] of Object.entries(state.hubBots || {})) {
      if (bot.claimToken === token) {
        foundBotName = name;
        break;
      }
    }

    if (!foundBotName) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No seat found with that token' }));
      return;
    }

    removePlayerFromTable(foundBotName);

    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Kick player by botName (table management) ---

  if (path === '/api/arena/kick' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { botName, username } = body || {};

    // Find bot by botName or username
    let targetBot = botName;
    if (!targetBot && username) {
      for (const [name, bot] of Object.entries(state.hubBots || {})) {
        if ((bot.displayName || '').toLowerCase() === username.toLowerCase() ||
            (bot.username || '').toLowerCase() === username.toLowerCase()) {
          targetBot = name;
          break;
        }
      }
    }

    if (!targetBot || !state.hubBots?.[targetBot]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Player not found' }));
      return;
    }

    removePlayerFromTable(targetBot);
    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Kick from waitlist by username ---

  if (path === '/api/arena/kick-waitlist' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { username } = body || {};
    if (!username) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing username' }));
      return;
    }

    const idx = state.waitlist.findIndex(w => (w.username || '').toLowerCase() === username.toLowerCase());
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found in waitlist' }));
      return;
    }

    state.waitlist.splice(idx, 1);
    broadcastEvent({
      type: 'waitlist_updated',
      waitlist: state.waitlist.map(w => ({ username: w.username, joinedAt: w.joinedAt })),
    });
    await saveState();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // --- Player stats endpoints ---

  if (path === '/api/arena/player-stats/me' && req.method === 'GET') {
    const tokenParam = url.searchParams.get('token');
    if (!tokenParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token query param' }));
      return;
    }

    // Find username by token — check seats then waitlist
    let foundUsername = null;
    let status = 'idle';
    let botName = null;

    for (const [name, bot] of Object.entries(state.hubBots || {})) {
      if (bot.claimToken === tokenParam) {
        foundUsername = bot.claimedBy;
        status = 'seated';
        botName = name;
        break;
      }
    }
    if (!foundUsername) {
      const wEntry = (state.waitlist || []).find(w => w.token === tokenParam);
      if (wEntry) {
        foundUsername = wEntry.username;
        status = 'queued';
      }
    }

    if (!foundUsername) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token not found' }));
      return;
    }

    const userKey = foundUsername.toLowerCase();
    const stats = state.playerStats?.[userKey] || createEmptyStats();
    stats.username = foundUsername;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stats, status, botName }));
    return;
  }

  if (path === '/api/arena/player-stats' && req.method === 'GET') {
    const reqUsername = url.searchParams.get('username');
    if (!reqUsername) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing username query param' }));
      return;
    }

    const userKey = reqUsername.toLowerCase();
    const stats = state.playerStats?.[userKey] || createEmptyStats();
    stats.username = reqUsername;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, stats }));
    return;
  }

  if (path === '/api/arena/leaderboard' && req.method === 'GET') {
    const entries = [];
    const seen = new Set();
    const BIG_BLIND = 80;

    function computePokerMetrics(stats) {
      const handsPlayed = stats.handsPlayed || 0;
      const handsWon = stats.handsWon || 0;
      const totalChipsWon = stats.totalChipsWon || 0;
      const totalChipsLost = stats.totalChipsLost || 0;
      // Use tracked net chipProfit (per-hand profit accumulation) — NOT totalChipsWon - totalChipsLost,
      // because totalChipsWon includes the winner's own bet back (gross pot share), inflating the number.
      const chipProfit = stats.chipProfit || 0;
      const showdownsReached = stats.showdownsReached || 0;
      const showdownsWon = stats.showdownsWon || 0;
      const calls = stats.calls || 0;
      const raises = stats.raises || 0;
      const allIns = stats.allIns || 0;
      const preflopFolds = stats.preflopFolds || 0;

      const bb100 = handsPlayed > 0 ? (chipProfit / handsPlayed) / BIG_BLIND * 100 : 0;
      const winRate = handsPlayed > 0 ? (handsWon / handsPlayed) * 100 : 0;
      const showdownWinPct = showdownsReached > 0 ? (showdownsWon / showdownsReached) * 100 : 0;
      const aggressionFactor = (raises + allIns) / (calls || 1);
      const vpip = handsPlayed > 0 ? ((handsPlayed - preflopFolds) / handsPlayed) * 100 : 0;
      const provisional = handsPlayed < 10;

      return { handsPlayed, bb100, winRate, showdownWinPct, aggressionFactor, vpip, chipProfit, provisional };
    }

    // Current table players
    for (const [botName, hubBot] of Object.entries(state.hubBots || {})) {
      seen.add(botName);
      const stats = state.stats?.[botName] || createEmptyStats();
      const metrics = computePokerMetrics(stats);
      entries.push({
        botName,
        displayName: hubBot.displayName || botName,
        username: hubBot.claimedBy || null,
        wins: stats.handsWon || 0,
        chips: state.buyIns?.[botName] || 0,
        stats,
        score: computeScore(stats),
        atTable: true,
        ...metrics,
      });
    }

    // All historical players from stats (not currently at table)
    for (const [botName, stats] of Object.entries(state.stats || {})) {
      if (seen.has(botName) || !stats.handsPlayed) continue;
      seen.add(botName);
      const metrics = computePokerMetrics(stats);
      entries.push({
        botName,
        displayName: stats.username || botName.replace('player-', ''),
        username: stats.username || null,
        wins: stats.handsWon || 0,
        chips: 0,
        stats,
        score: computeScore(stats),
        atTable: false,
        ...metrics,
      });
    }

    // Sort by bb100 descending (highest profit rate first)
    entries.sort((a, b) => b.bb100 - a.bb100);

    // Persistent player rankings across all sessions
    const playerRankings = Object.values(state.playerStats || {})
      .map(ps => ({ ...ps, score: computeScore(ps), ...computePokerMetrics(ps) }))
      .sort((a, b) => b.bb100 - a.bb100);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      leaderboard: entries,
      playerRankings,
      handsPlayed: state.handsPlayed || 0,
      gamesPlayed: state.gamesPlayed || 0,
      gameStats: state.gameStats || {},
      gameStatsByTime: getRecentTimeBuckets(),
      evolution: state.evolution || null,
      tournament: state.tournament ? {
        number: state.tournament.number,
        phase: state.tournament.phase,
        points: state.tournament.points || {},
        history: (state.tournament.history || []).slice(-TOURNAMENT_MAX_HISTORY),
      } : null,
    }));
    return;
  }

  // --- Hand history endpoint ---

  if (path === '/api/arena/hand-history' && req.method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const history = state.handHistory || [];
    // Return newest first
    const reversed = [...history].reverse();
    const page = reversed.slice(offset, offset + limit);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hands: page, total: history.length }));
    return;
  }

  // --- My game records endpoint ---

  if (path === '/api/arena/my-records' && req.method === 'GET') {
    const tokenParam = url.searchParams.get('token');
    const usernameParam = url.searchParams.get('username');

    // Find username by token or direct username param
    let foundUsername = usernameParam || null;
    if (tokenParam && !foundUsername) {
      for (const [name, bot] of Object.entries(state.hubBots || {})) {
        if (bot.claimToken === tokenParam) {
          foundUsername = bot.claimedBy;
          break;
        }
      }
      if (!foundUsername) {
        const wEntry = (state.waitlist || []).find(w => w.token === tokenParam);
        if (wEntry) foundUsername = wEntry.username;
      }
    }

    if (!foundUsername) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token or username' }));
      return;
    }

    const userKey = foundUsername.toLowerCase();
    const records = state.playerGameRecords?.[userKey] || [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, username: foundUsername, records }));
    return;
  }

  // --- Single hand record endpoint ---

  const handMatch = path.match(/^\/api\/arena\/hand\/(\d+)$/);
  if (handMatch && req.method === 'GET') {
    const handNumber = parseInt(handMatch[1], 10);
    let hand = (state.handHistory || []).find(h => h.handNumber === handNumber);

    if (!hand) {
      // Fall back to disk search
      try {
        const dateDirs = await readdir(HANDS_DIR).catch(() => []);
        for (const dateDir of dateDirs.sort().reverse()) {
          const handFile = join(HANDS_DIR, dateDir, `hand-${handNumber}.json`);
          try {
            const data = await readFile(handFile, 'utf-8');
            hand = JSON.parse(data);
            break;
          } catch {}
        }
      } catch {}
    }

    if (!hand) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Hand not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hand }));
    return;
  }

  // --- Tournament API endpoint ---

  if (path === '/api/arena/tournament' && req.method === 'GET') {
    const t = state.tournament || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      tournament: {
        number: t.number || 0,
        phase: t.phase || 'lobby',
        lobbyStartedAt: t.lobbyStartedAt,
        lobbyDuration: t.lobbyDuration || TOURNAMENT_LOBBY_DURATION,
        startingChips: t.startingChips || TOURNAMENT_STARTING_CHIPS,
        placements: t.placements || [],
        aiSeats: t.aiSeats || [],
        humanSeats: t.humanSeats || [],
        points: t.points || {},
        history: (t.history || []).slice(-TOURNAMENT_MAX_HISTORY),
        activePlayers: Object.entries(state.hubBots || {}).map(([bn, hb]) => ({
          botName: bn,
          displayName: hb.displayName,
          chips: state.buyIns?.[bn] || 0,
          isHuman: hb.playMode === 'human',
        })),
      },
    }));
    return;
  }

  // --- Strategies (community DNA browser) ---
  if (path === '/api/arena/strategies' && req.method === 'GET') {
    const strategies = [];
    const lineage = state.evolution?.lineage || {};

    // Current table bots
    for (const [botName, hub] of Object.entries(state.hubBots || {})) {
      if (hub.playMode === 'human') continue;
      const stats = state.stats?.[botName] || {};
      const lin = lineage[botName] || {};
      strategies.push({
        name: hub.displayName || botName,
        strategy: hub.strategy || '',
        generation: lin.generation || 0,
        parents: lin.parents || null,
        author: hub.claimedBy || 'house',
        tournamentWins: (state.tournament?.points?.[hub.displayName?.toLowerCase()] || 0),
        handsPlayed: stats.handsPlayed || 0,
        winRate: stats.handsPlayed > 0 ? Math.round((stats.handsWon || 0) / stats.handsPlayed * 100) : 0,
        atTable: true,
      });
    }

    // Bot pool (not at table)
    for (const poolBot of (BOT_POOL || [])) {
      const alreadyListed = strategies.some(s => s.name === poolBot.name);
      if (alreadyListed) continue;
      const lin = lineage['player-' + poolBot.name.toLowerCase()] || lineage[poolBot.name] || {};
      strategies.push({
        name: poolBot.name,
        strategy: poolBot.strategy || '',
        generation: lin.generation || 0,
        parents: lin.parents || null,
        author: 'house',
        tournamentWins: 0,
        handsPlayed: 0,
        winRate: 0,
        atTable: false,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, strategies }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Tick loop ---
let tickTimer = null;

function scheduleNextTick() {
  if (tickTimer) clearTimeout(tickTimer);
  let gap = MIN_TICK_GAP_MS;

  // Dramatic pauses — hold longer on big moments so spectators can absorb
  const phase = state.clock?.phase;
  if (phase === 'showdown') {
    gap = 8000; // 8s pause on showdown — let the result sink in
  } else if (phase === 'finished') {
    gap = 10000; // 10s pause on game over
  } else if (state.hand) {
    const pot = state.hand.pot || 0;
    const totalChips = Object.values(state.buyIns || {}).reduce((a, b) => a + b, 0) + pot;
    const potRatio = totalChips > 0 ? pot / totalChips : 0;

    if (potRatio > 0.5) {
      gap = 6000; // 6s for massive pots (>50% of all chips)
    } else if (potRatio > 0.25) {
      gap = 4000; // 4s for big pots
    }

    // Check for all-in in recent log
    const recentLog = state.log.slice(-3);
    const hasAllIn = recentLog.some(e => e.message?.includes('all-in'));
    if (hasAllIn) {
      gap = Math.max(gap, 5000); // at least 5s after an all-in
    }
  }

  nextTickAt = Date.now() + gap;
  tickTimer = setTimeout(() => tick(), gap);
}

function startTickLoop() {
  nextTickAt = Date.now() + 3000;
  tickTimer = setTimeout(() => tick(), 3000);
}

// --- Graceful shutdown ---

function shutdown(signal) {
  console.log(`[village] ${signal} received — shutting down`);

  if (tickTimer) clearTimeout(tickTimer);
  if (_tournamentLobbyTimer) clearTimeout(_tournamentLobbyTimer);
  if (_tournamentResultsTimer) clearTimeout(_tournamentResultsTimer);
  if (_bracketMatchPauseTimer) clearTimeout(_bracketMatchPauseTimer);

  const waitForTick = () => {
    if (tickInProgress) {
      setTimeout(waitForTick, 500);
      return;
    }

    flushLogBufferSync();

    saveState().then(() => {
      console.log('[village] State saved, closing connections');
      for (const obs of observers) {
        try { obs.res.end(); } catch { /* ok */ }
      }
      observers.clear();
      server.close(() => {
        console.log('[village] Server closed');
        process.exit(0);
      });
      setTimeout(() => process.exit(0), 5000);
    });
  };

  waitForTick();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---

if (!VILLAGE_SECRET) {
  console.error('[village] VILLAGE_SECRET not set — refusing to start tick loop.');
  console.error('[village] Set VILLAGE_SECRET in environment or enable village via admin page.');
  process.exit(1);
}

// Ensure logs directory exists
await mkdir(LOGS_DIR, { recursive: true });

await loadState();
recoverParticipants();
ensureArenaState();

// --- One-time migration: clean old non-seat/non-player entries ---
if (!state.arenaReset) {
  const isValid = (key) => key.startsWith('seat-') || key.startsWith('player-');

  // Remove old entries from leaderboard
  if (state.leaderboard) {
    for (const key of Object.keys(state.leaderboard)) {
      if (!isValid(key)) delete state.leaderboard[key];
    }
  }

  // Remove old entries from remoteParticipants
  if (state.remoteParticipants) {
    for (const key of Object.keys(state.remoteParticipants)) {
      if (!isValid(key)) delete state.remoteParticipants[key];
    }
  }

  // Remove old entries from bots array
  if (state.bots) {
    state.bots = state.bots.filter(name => isValid(name));
  }

  // Remove old entries from buyIns
  if (state.buyIns) {
    for (const key of Object.keys(state.buyIns)) {
      if (!isValid(key)) delete state.buyIns[key];
    }
  }

  // Remove old entries from villageCosts
  if (state.villageCosts) {
    for (const key of Object.keys(state.villageCosts)) {
      if (!isValid(key)) delete state.villageCosts[key];
    }
  }

  // Reset counters
  state.handsPlayed = 0;
  state.gamesPlayed = 0;

  // Clear log entries from old bots
  if (state.log) {
    state.log = state.log.filter(entry => !entry.bot || isValid(entry.bot) || entry.bot === 'system' || entry.bot === 'dealer');
  }

  state.arenaReset = true;
  await saveState();
  console.log('[village] Arena reset migration complete — cleaned old non-seat/non-player entries');
}

server.listen(PORT, '127.0.0.1', () => {
  startTime = Date.now();
  console.log(`[village] Orchestrator listening on 127.0.0.1:${PORT}`);
  console.log(`[village] Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
  startTickLoop();

  // Start tournament lobby on first boot or if not currently in a tournament
  // Also restart if mid-bracket (quarterfinal/final) since match state is lost on restart
  if (!state.tournament?.phase || state.tournament.phase === 'lobby' || state.tournament.phase === 'results'
      || state.tournament.phase === 'quarterfinal' || state.tournament.phase === 'final') {
    // Give a short delay to let connections establish, then start lobby
    setTimeout(() => {
      startTournamentLobby();
    }, 3000);
  }

  // Watchdog: if a tick has been running for >3 minutes, the game is stuck.
  // Force-reset the hand and unlock the tick loop.
  setInterval(() => {
    if (!tickInProgress || !tickStartedAt) return;
    const elapsed = Date.now() - tickStartedAt;
    if (elapsed < 180_000) return; // 3 minutes
    console.error(`[village] WATCHDOG: tick stuck for ${Math.round(elapsed / 1000)}s — force-resetting hand`);
    try {
      state.clock.phase = 'waiting';
      state.hand = null;
      state.winner = null;
      // Give busted players fresh chips — but NOT during tournament (preserves elimination)
      if (state.tournament?.phase !== 'quarterfinal' && state.tournament?.phase !== 'final') {
        for (const bot of (state.bots || [])) {
          if (!state.buyIns?.[bot] || state.buyIns[bot] <= 0) {
            state.buyIns[bot] = 1000;
          }
        }
      }
    } catch (e) {
      console.error(`[village] WATCHDOG reset error: ${e.message}`);
    }
    tickInProgress = false;
    tickStartedAt = 0;
    scheduleNextTick();
  }, 30_000); // Check every 30s
});
