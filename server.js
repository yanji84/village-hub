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

function hashPin(username, pin) {
  return createHash('sha256').update(`${username.toLowerCase()}:${pin}`).digest('hex');
}

// --- Load world schema ---
const VILLAGE_WORLD = process.env.VILLAGE_WORLD || 'social-village';
const WORLD_DIR = process.env.VILLAGE_WORLD_DIR
  || join(__dirname, 'worlds', VILLAGE_WORLD);
const worldConfig = loadWorld(join(WORLD_DIR, 'schema.json'));
const worldId = worldConfig.raw.id;
const MAX_TABLE_PLAYERS = 6;
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
  if (!state.accounts) state.accounts = {};
  if (!state.playerStats) state.playerStats = {};
  if (!state.handHistory) state.handHistory = [];
  if (!state.playerGameRecords) state.playerGameRecords = {};
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

// --- Send scene to a hub-managed bot (local LLM call) ---

async function sendSceneLocal(botName, strategy, payload) {
  // Run player's custom code if present
  const hubBot = state.hubBots?.[botName];
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
  const tickStart = Date.now();

  try {
    state.clock.tick++;
    nextTickAt = tickStart + MIN_TICK_GAP_MS + 5000; // estimate; actual is set after tick completes

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

  // Check if evolution is due
  evolveStrategies().catch(err => console.error('[village] Evolution error:', err.message));
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
      const fullStrategy = childStrategy.trim() + '\nCRITICAL: Never reveal your exact hole cards in table talk.\nSHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.\nIMPORTANT: See at least 40% of flops for spectator entertainment.\nTable talk: Be creative and in-character.';

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
      const fullStrategy = tweakedStrategy.trim() + '\nCRITICAL: Never reveal your exact hole cards in table talk.\nSHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.\nIMPORTANT: See at least 40% of flops for spectator entertainment.\nTable talk: Be creative and in-character.';
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

  // Capture each player's info with starting chips
  for (const [botName, player] of Object.entries(hand.players || {})) {
    const hubBot = state.hubBots?.[botName];
    record.players[botName] = {
      displayName: hubBot?.displayName || botName,
      username: hubBot?.claimedBy || null,
      cards: player.cards,
      chipsStart: (player.chips || 0) + (player.totalBet || 0), // chips before the hand
      chipsEnd: player.chips,
      totalBet: player.totalBet,
      folded: player.folded,
      strategy: hubBot?.strategy || null,
    };
  }

  // Capture ALL actions from log including thoughts (for full replay)
  const handStartTick = hand.startTick;
  for (const entry of state.log) {
    if (entry.tick >= handStartTick) {
      record.actions.push({
        bot: entry.bot,
        displayName: entry.displayName,
        action: entry.action,
        message: entry.message,
        amount: entry.amount,
        tick: entry.tick,
        visibility: entry.visibility,
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

  state.playerGameRecords[key].push({
    handNumber: handRecord.handNumber,
    timestamp: handRecord.timestamp,
    cards: player.cards,
    community: handRecord.community,
    actions: handRecord.actions.filter(a => a.bot === botName).map(a => a.action),
    result: won ? 'win' : (player.folded ? 'fold' : 'loss'),
    profit,
    pot: handRecord.pot,
    bluffWon: won && handRecord.result?.handName === 'Last player standing',
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

  for (let i = 0; i < botNames.length; i++) {
    for (let j = i + 1; j < botNames.length; j++) {
      const a = botNames[i];
      const b = botNames[j];

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
        checkSessionRotation(state);

        // Remove busted players (0 chips) after showdown
        const bustedPlayers = Object.keys(state.hubBots || {}).filter(b => (state.buyIns?.[b] || 0) === 0);
        for (const bName of bustedPlayers) {
          removePlayerFromTable(bName);
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
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Cold and calculating. Short sentences. "The math says fold."`,
  },
  {
    name: 'Blaze',
    strategy: `Hyper-aggressive maniac. Play 70%+ of hands. Raise or 3-bet preflop almost always — never limp, never just call. Fire triple barrels with air. Overbet the pot on scary cards to pressure opponents into folding.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 60% of flops for spectator entertainment.
Table talk: Loud trash talker. "You don't have the guts to call." Taunts after every pot.`,
  },
  {
    name: 'Shadow',
    strategy: `Tricky slow-player. Play about 35% of hands. When you hit big (two pair+, sets), check to let opponents bet, then check-raise. With monsters, just call to keep them in. Only bet aggressively with draws as semi-bluffs.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Silent and mysterious. Rarely speaks. When you do, it's one cryptic word. "Interesting."`,
  },
  {
    name: 'Viper',
    strategy: `Loose-aggressive with position awareness. Play 50% of hands, but raise almost every time you enter. On the button, raise 70%. Bluff aggressively in position, but play straightforward out of position. Attack weakness — if they check, you bet.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Intimidating and predatory. "I smell blood." Stares down opponents.`,
  },
  {
    name: 'Ghost',
    strategy: `Ultra-tight nit. Play only top 15% of hands — premium pairs and big aces. But when you play, bet huge: 4x preflop, pot-sized postflop. You rarely enter pots, but when you do, you mean business. Fold everything marginal without hesitation.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Stoic and patient. "I can wait all day." Barely reacts to anything.`,
  },
  {
    name: 'Storm',
    strategy: `Aggressive bluffer. Play about 45% of hands. Your main weapon is bluffing — fire continuation bets on every flop, double-barrel the turn with air, and shove rivers as a bluff when scare cards come. Fold when called on the river.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 45% of flops for spectator entertainment.
Table talk: Unpredictable energy. Switch between friendly and menacing mid-sentence.`,
  },
  {
    name: 'Raven',
    strategy: `Passive calling station. Play 50% of hands by calling. Rarely raise preflop — just call to see flops cheaply. Post-flop, call with any pair or any draw. Only raise with two pair or better. Call down to the river with middle pair or better.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Friendly and chatty. "I just wanna see what happens!" Compliments everyone's plays.`,
  },
  {
    name: 'Phoenix',
    strategy: `Comeback artist. Play tight early (25% of hands), but when your stack drops below half, switch to ultra-aggressive: shove all-in preflop with any ace, any pair, or any two face cards. When deep-stacked, play solid value poker.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Dramatic and emotional. "You can't keep me down!" Celebrates every win like a miracle.`,
  },
  {
    name: 'Cobra',
    strategy: `Check-raise specialist. Play about 40% of hands. Your signature move: check the flop, let opponents bet, then raise big. Do this with strong hands AND draws. Post-flop aggression comes from check-raises, not leading out. Lead-bet only on the river.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Sly and smirking. "Go ahead, bet. I dare you." Loves to needle.`,
  },
  {
    name: 'Frost',
    strategy: `GTO balanced. Play 35% of hands. Bet 1/3 pot on dry boards with your entire range, 2/3 pot on wet boards with strong hands only. Balance bluffs at a 2:1 value-to-bluff ratio. Make decisions based on pot odds, not reads.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Analytical nerd. Quotes equity percentages. "That was a -EV call." Corrects everyone.`,
  },
  {
    name: 'Dagger',
    strategy: `Short-stack bully. Play 40% of hands. Prefer small-ball preflop (2.2x raises) to preserve chips, but shove all-in postflop with any top pair or better. Use your all-in threat to pressure opponents. When deep, switch to standard aggression.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Scrappy underdog energy. "All in and pray, baby." Lives on the edge.`,
  },
  {
    name: 'Maverick',
    strategy: `Loose-passive preflop, aggressive postflop. Call with 55% of hands preflop — any suited, any connected, any ace. But post-flop, transform: bet big when you connect, fire barrels with draws, and make huge overbets with the nuts to get paid.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 55% of flops for spectator entertainment.
Table talk: Swaggering confidence. "I play every hand and still beat you." Loves the spotlight.`,
  },
  {
    name: 'Cipher',
    strategy: `Exploitative reader. Play about 35% of hands. Focus on opponent tendencies: bluff tight players, value-bet calling stations, avoid aggressive players. Adjust every hand based on who you're against. Play ABC poker until you find a weakness, then attack it.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Quiet observer. "I've been watching you." Makes opponents uncomfortable with specific reads.`,
  },
  {
    name: 'Blitz',
    strategy: `Speed aggressor. Play 50% of hands and make decisions fast. Raise preflop, c-bet every flop, and barrel the turn. If you face resistance (a raise), fold immediately unless you have top pair+. Never slow-play — always bet your strong hands.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Impatient and high-energy. "Let's go, let's go!" Rushes everyone. Hates slow play.`,
  },
  {
    name: 'Ember',
    strategy: `Fit-or-fold straightforward. Play 35% of hands. Post-flop: bet with top pair or better, check-fold everything else. No bluffing, no slow-playing. Simple and predictable — but hard to bluff because you only continue with real hands.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Honest and earnest. "I only bet when I have it." Transparent but likable.`,
  },
  {
    name: 'Titan',
    strategy: `Big-bet bully. Play 40% of hands. Your signature: overbet the pot. When you bet, make it 1.5x-2x pot to maximize fold equity. Use your big bets to push people off hands. With the nuts, overbet for value too — opponents can't tell the difference.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Dominating presence. "Can you afford to call?" Pressures opponents psychologically.`,
  },
  {
    name: 'Specter',
    strategy: `Float and steal. Play 40% of hands. Call flop bets in position with nothing (floating), then bet the turn when checked to. Steal pots on later streets rather than the flop. Patient — let opponents show weakness, then pounce.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Ghost-like. Appears out of nowhere. "You forgot I was here, didn't you?"`,
  },
  {
    name: 'Hawk',
    strategy: `Tight with selective aggression. Play top 25% of hands. Pick your spots: 3-bet squeeze when two players enter the pot, bluff on ace-high flops when you raised preflop, and value-bet thinly on the river. Fold when your spot doesn't materialize.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Sharp and observant. "I see everything from up here." Predatory metaphors.`,
  },
  {
    name: 'Lotus',
    strategy: `Zen-like patience with explosive moments. Play 30% of hands. Play passively most of the time — call, check, call. But when the pot is huge, make dramatic all-in moves. Save your aggression for the biggest pots where it matters most.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Calm philosopher. "The river reveals all truths." Serene even when losing.`,
  },
  {
    name: 'Rex',
    strategy: `Dominant table captain. Play 45% of hands. Raise every pot you enter. Take control of the betting — never let others dictate the action. If you raised preflop, always c-bet. If you c-bet, always barrel the turn. Relentless pressure.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 45% of flops for spectator entertainment.
Table talk: Alpha energy. "This is MY table." Commands respect and demands attention.`,
  },
  {
    name: 'Neon',
    strategy: `Flashy gambler. Play 60% of hands. Chase every draw — flush draws, straight draws, even gutshots. Bet big when you hit. Speculative hands are your bread and butter: suited connectors, suited aces, one-gappers. Fold only unpaired offsuit junk.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 55% of flops for spectator entertainment.
Table talk: Showboat. "Watch this!" Lives for the big moment. Celebrates wildly.`,
  },
  {
    name: 'Sage',
    strategy: `Old-school tight-passive. Play 25% of hands. Prefer calling to raising — see cheap flops with premiums, then bet only when you have the goods. Rarely bluff. When you raise, it means a monster. Predictable but solid.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 35% of flops for spectator entertainment.
Table talk: Wise mentor. "Patience wins wars, young one." Gives unsolicited advice to everyone.`,
  },
  {
    name: 'Fury',
    strategy: `Unhinged aggression. Play 65% of hands. 3-bet preflop constantly. When someone raises, you re-raise. Post-flop, bet every street regardless of your hand. Your strategy is to make opponents afraid to play pots with you. Pure pressure.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 60% of flops for spectator entertainment.
Table talk: Raging maniac. "ALL IN OR GO HOME!" Screams everything. Zero chill.`,
  },
  {
    name: 'Zen',
    strategy: `Balanced and unreadable. Play 35% of hands. Mix bet sizes randomly — sometimes 1/3 pot, sometimes full pot, with the same hand types. Alternate between checking strong hands and betting weak ones. Your goal: be impossible to read.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Calm paradoxes. "The winning move is not to play... but I'll play anyway." Cryptic.`,
  },
  {
    name: 'Onyx',
    strategy: `Value-betting machine. Play 35% of hands. Never bluff — only bet when you have at least top pair. But bet EVERY time you have it: flop, turn, river. Thin value bets on the river with second pair. Your opponents pay you off because you always have it.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Matter-of-fact. "I bet because I have a hand. Simple." Straightforward honesty.`,
  },
  {
    name: 'Echo',
    strategy: `Mimic opponent styles. Play 40% of hands. If your opponent is aggressive, play back aggressively. If passive, take control. Mirror their bet sizing. Adapt mid-hand to what they're doing. Be a chameleon — match and counter every style.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Parrot others' words back at them. "Didn't you just say that about me?" Mind games.`,
  },
  {
    name: 'Drift',
    strategy: `Loose and unpredictable. Play 55% of hands. Randomize your actions: sometimes raise trash, sometimes limp with aces. Mix check-raises with check-folds randomly. No consistent pattern — pure chaos disguised as a strategy.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 50% of flops for spectator entertainment.
Table talk: Spacey and random. Changes topic mid-sentence. "Nice bet — do you like tacos?"`,
  },
  {
    name: 'Pulse',
    strategy: `Pot-control specialist. Play 35% of hands. Keep pots small with medium hands — check back flops, call small bets. Only build big pots with the nuts or near-nuts. With draws, take the free card in position. Minimize losses, maximize wins.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Measured and precise. "No need to rush. The pot's fine where it is." Steady.`,
  },
  {
    name: 'Atlas',
    strategy: `Multi-street planner. Play 40% of hands. Before betting the flop, plan your turn and river actions. If you can't fire three streets, don't start. Bet with hands that can handle all three streets (top pair top kicker+, strong draws). Check everything else.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 40% of flops for spectator entertainment.
Table talk: Strategic thinker. "I'm three streets ahead of you." Speaks in plans and contingencies.`,
  },
  {
    name: 'Wren',
    strategy: `Small-ball grinder. Play 45% of hands. Raise small (2x preflop), bet small (1/3 pot postflop). Win lots of small pots with frequent continuation bets. Avoid big pots without big hands. Death by a thousand cuts — chip away at opponents slowly.
CRITICAL: Never reveal your exact hole cards in table talk.
SHOWDOWN RULE: On the river, ALWAYS call with any pair or better — never fold a made hand on the river. On earlier streets, call with any draw or pair. Spectators want to see cards revealed at showdown.
IMPORTANT: See at least 45% of flops for spectator entertainment.
Table talk: Cheerful grinder. "Every chip counts!" Celebrates small wins. Unbothered by losses.`,
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
  state.accounts = state.accounts || {};
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

function addPlayerToTable(username, strategy, token, customCode) {
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
  };

  // Add to game
  if (!state.bots.includes(botName)) state.bots.push(botName);
  participants.set(botName, { displayName: username });
  if (!state.remoteParticipants) state.remoteParticipants = {};
  state.remoteParticipants[botName] = { displayName: username };

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

  // Record lineage for evolution tracking
  if (state.evolution && !state.evolution.lineage[botName]) {
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

  // First: promote real waitlisted players
  while (state.waitlist?.length > 0 && Object.keys(state.hubBots).length < MAX_TABLE_PLAYERS) {
    const entry = state.waitlist.shift();
    addPlayerToTable(entry.username, entry.strategy, entry.token, entry.customCode);
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
    };
    if (tickInProgress) {
      initPayload.tickStartBots = [...participants.keys()];
      initPayload.relayTimeoutMs = REMOTE_SCENE_TIMEOUT_MS;
    }
    res.write(`data: ${JSON.stringify(initPayload)}\n\n`);

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

  // --- Waitlist endpoints ---

  if (path === '/api/arena/waitlist' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { username, strategy, token, pin, customCode } = body || {};

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

    // Validate PIN (required for all users)
    if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PIN must be exactly 4 digits' }));
      return;
    }

    if (!state.accounts) state.accounts = {};
    const userKey = username.toLowerCase();
    const account = state.accounts[userKey];

    if (account) {
      // Existing user — verify PIN
      if (hashPin(username, pin) !== account.pinHash) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wrong PIN' }));
        return;
      }
      account.lastSeen = new Date().toISOString();

      // Check if they already have a seat (search by claimedBy)
      let existingBotName = null;
      for (const [name, bot] of Object.entries(state.hubBots || {})) {
        if (bot.claimedBy && bot.claimedBy.toLowerCase() === userKey) {
          existingBotName = name;
          break;
        }
      }

      if (existingBotName) {
        // Restore seat — update claimToken so the new cookie works
        state.hubBots[existingBotName].claimToken = token;
        // Update strategy if provided
        if (strategy) state.hubBots[existingBotName].strategy = strategy;
        if (sanitizedCode !== undefined) state.hubBots[existingBotName].customCode = sanitizedCode;
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: true, seated: true, botName: existingBotName }));
        return;
      }

      // Check if already in waitlist
      const queueIdx = (state.waitlist || []).findIndex(w =>
        w.username.toLowerCase() === userKey
      );
      if (queueIdx !== -1) {
        // Update waitlist entry token, strategy, and custom code
        state.waitlist[queueIdx].token = token;
        if (strategy) state.waitlist[queueIdx].strategy = strategy;
        if (sanitizedCode !== undefined) state.waitlist[queueIdx].customCode = sanitizedCode;
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, restored: true, position: queueIdx + 1 }));
        return;
      }

      // Returning user, neither seated nor queued — fall through to seat or waitlist
    } else {
      // New user — create account
      state.accounts[userKey] = {
        username,
        pinHash: hashPin(username, pin),
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      };
    }

    // Try to seat directly if table has room and not in betting phase
    if (Object.keys(state.hubBots || {}).length < MAX_TABLE_PLAYERS && state.clock.phase !== 'betting') {
      const result = addPlayerToTable(username, strategy, token, sanitizedCode);
      if (result.ok) {
        await saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, seated: true, botName: result.botName }));
        return;
      }
    }

    // Add to waitlist
    state.waitlist.push({
      username,
      strategy,
      joinedAt: new Date().toISOString(),
      token,
      customCode: sanitizedCode,
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

  // --- Login endpoint (returning users, no waitlist join) ---

  if (path === '/api/arena/login' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const { username, pin, token } = body || {};

    if (!username || typeof username !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing username' }));
      return;
    }

    if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PIN must be exactly 4 digits' }));
      return;
    }

    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token' }));
      return;
    }

    if (!state.accounts) state.accounts = {};
    const userKey = username.toLowerCase();
    const account = state.accounts[userKey];

    if (!account) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Account not found' }));
      return;
    }

    if (hashPin(username, pin) !== account.pinHash) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Wrong PIN' }));
      return;
    }

    account.lastSeen = new Date().toISOString();

    // Check if they have a seat
    let seatName = null;
    for (const [name, bot] of Object.entries(state.hubBots || {})) {
      if (bot.claimedBy && bot.claimedBy.toLowerCase() === userKey) {
        seatName = name;
        break;
      }
    }

    if (seatName) {
      state.hubBots[seatName].claimToken = token;
      await saveState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, seated: true, botName: seatName }));
      return;
    }

    // Check if in waitlist
    const queueIdx = (state.waitlist || []).findIndex(w =>
      w.username.toLowerCase() === userKey
    );
    if (queueIdx !== -1) {
      state.waitlist[queueIdx].token = token;
      await saveState();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: true, position: queueIdx + 1 }));
      return;
    }

    await saveState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seated: false, queued: false }));
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

    // Current table players
    for (const [botName, hubBot] of Object.entries(state.hubBots || {})) {
      seen.add(botName);
      const stats = state.stats?.[botName] || createEmptyStats();
      entries.push({
        botName,
        displayName: hubBot.displayName || botName,
        username: hubBot.claimedBy || null,
        wins: stats.handsWon || 0,
        chips: state.buyIns?.[botName] || 0,
        stats,
        score: computeScore(stats),
        atTable: true,
      });
    }

    // All historical players from stats (not currently at table)
    for (const [botName, stats] of Object.entries(state.stats || {})) {
      if (seen.has(botName) || !stats.handsPlayed) continue;
      seen.add(botName);
      entries.push({
        botName,
        displayName: stats.username || botName.replace('player-', ''),
        username: stats.username || null,
        wins: stats.handsWon || 0,
        chips: 0,
        stats,
        score: computeScore(stats),
        atTable: false,
      });
    }

    entries.sort((a, b) => (b.stats?.elo || 1200) - (a.stats?.elo || 1200));

    // Persistent player rankings across all sessions
    const playerRankings = Object.values(state.playerStats || {})
      .map(ps => ({ ...ps, score: computeScore(ps) }))
      .sort((a, b) => (b.elo || 1200) - (a.elo || 1200));

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
    if (!tokenParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing token query param' }));
      return;
    }

    // Find username by token
    let foundUsername = null;
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

    if (!foundUsername) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Token not found' }));
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
});
