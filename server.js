/**
 * Village Orchestrator — the "game master" for the bot social village.
 *
 * Maintains world state, runs a tick-based game loop, sends scene prompts
 * to each bot's /village endpoint, routes responses, writes village memories,
 * and serves an observer web UI via SSE.
 *
 * Uses Node.js built-ins only. Imports CJS lib/ modules via createRequire.
 *
 * Game content is loaded from a JSON schema file via game-loader.js.
 * Set VILLAGE_GAME env var to select a game (default: social-village).
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rename, copyFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadGame } from './game-loader.js';
import { buildScene, getVillageTime } from './scene.js';
import { appendVillageMemory, buildMemoryEntry } from './memory.js';
import { needsSummarization, summarizeVillageMemory } from './summarize.js';
import {
  processActions,
  advanceClock as advanceClockImpl,
  enforceLogDepth,
  computeQualityMetrics,
  shouldSkipForCost,
  readBotDailyCost as readBotDailyCostImpl,
  validateObserverAuth as validateObserverAuthImpl,
  trackInteractions,
  updateCoLocation,
  updateRelationships,
  updateEmotions,
  rollVillageEvent,
  rollConversationSpice,
  decayRelationships,
} from './logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Import CJS lib modules ---
const paths = require('../lib/paths');
const villageManager = require('../lib/village-manager');
const configManager = require('../lib/config-manager');
const identityManager = require('../lib/identity-manager');

// --- Load game schema ---
const VILLAGE_GAME = process.env.VILLAGE_GAME || 'social-village';
const gameConfig = loadGame(join(__dirname, 'games', VILLAGE_GAME + '.json'));
console.log(`[village] Loaded game: ${gameConfig.raw.id} (${gameConfig.raw.name})`);

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || '120000', 10); // 2 minutes
const TICKS_PER_PHASE = parseInt(process.env.VILLAGE_TICKS_PER_PHASE || '4', 10);
const SCENE_HISTORY_CAP = parseInt(process.env.VILLAGE_SCENE_HISTORY_CAP || '10', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const MAX_PUBLIC_LOG_DEPTH = parseInt(process.env.VILLAGE_MAX_LOG_DEPTH || '20', 10);
const SCENE_TIMEOUT_MS = 45_000;
const EMPTY_CLEAR_TICKS = 3;

const STATE_FILE = join(__dirname, 'state.json');
const USAGE_FILE = join(paths.PROJECT_DIR, 'api-router', 'usage.json');
const ADMIN_TOKENS_FILE = join(paths.PROJECT_DIR, 'portal', 'admin-tokens.json');
const LOGS_DIR = join(__dirname, 'logs');

// --- Event log file (JSONL, one file per day) ---
let logDate = '';   // 'YYYY-MM-DD'
let logFile = '';   // full path to current day's .jsonl

// --- State ---
let state = {
  locations: {},
  whispers: {},
  publicLogs: {},
  clock: { tick: 0, phase: 'morning', ticksInPhase: 0 },
  emptyTicks: {},
  relationships: {},
  emotions: {},
  eventState: {},
  spiceState: {},
  stagnation: {},
};
let paused = false;
let tickInProgress = false;
let nextTickAt = 0;
let startTime = Date.now();

// --- Observer SSE connections ---
const observers = new Set(); // { res, botName }

// --- Participants (event-driven, updated by /api/join and /api/leave) ---
const participants = new Map(); // botName → { port, displayName }
const failureCounts = new Map(); // botName → consecutive sendScene failure count
const lastMoveTick = new Map();  // botName → tick number of last move (cooldown)
const MAX_CONSECUTIVE_FAILURES = 3;

// --- Load/Save state ---

async function loadState() {
  function applyState(loaded, source) {
    state = {
      locations: loaded.locations || {},
      whispers: loaded.whispers || {},
      publicLogs: loaded.publicLogs || {},
      clock: loaded.clock || { tick: 0, phase: 'morning', ticksInPhase: 0 },
      emptyTicks: loaded.emptyTicks || {},
      relationships: loaded.relationships || {},
      emotions: loaded.emotions || {},
      villageCosts: loaded.villageCosts || {},
      eventState: loaded.eventState || {},
      spiceState: loaded.spiceState || {},
      stagnation: loaded.stagnation || {},
    };
    for (const loc of gameConfig.locationSlugs) {
      if (!state.locations[loc]) state.locations[loc] = [];
      if (!state.publicLogs[loc]) state.publicLogs[loc] = [];
      if (!state.emptyTicks[loc]) state.emptyTicks[loc] = 0;
    }
    console.log(`[village] State loaded from ${source}: tick=${state.clock.tick} phase=${state.clock.phase}`);
  }

  // Try primary state file
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    applyState(JSON.parse(raw), 'state.json');
    return;
  } catch { /* primary failed or missing */ }

  // Fallback to backup
  try {
    const bakRaw = await readFile(STATE_FILE + '.bak', 'utf-8');
    applyState(JSON.parse(bakRaw), 'state.json.bak');
    console.warn('[village] Primary state.json was corrupt/missing — recovered from backup');
    return;
  } catch { /* backup also failed */ }

  // Initialize fresh state
  for (const loc of gameConfig.locationSlugs) {
    state.locations[loc] = [];
    state.publicLogs[loc] = [];
    state.emptyTicks[loc] = 0;
  }
  state.relationships = {};
  console.log('[village] Fresh state initialized');
}

async function saveState() {
  try {
    const tmpFile = STATE_FILE + '.tmp';
    const bakFile = STATE_FILE + '.bak';

    // Write to tmp file first
    await writeFile(tmpFile, JSON.stringify(state, null, 2) + '\n');

    // Backup current state.json before overwriting
    try { await copyFile(STATE_FILE, bakFile); } catch { /* no existing state to backup */ }

    // Atomic rename (same filesystem)
    await rename(tmpFile, STATE_FILE);
  } catch (err) {
    console.error(`[village] Failed to save state: ${err.message}`);
  }
}

// --- Cost tracking ---

function readBotDailyCost(botName) {
  return readBotDailyCostImpl(botName, USAGE_FILE, readFile);
}

function accumulateResponseCost(botName, response) {
  if (!response?.usage) return;
  const cost = response.usage.cost?.total
    || response.usage.cost
    || 0;
  if (typeof cost === 'number' && cost > 0) {
    state.villageCosts[botName] = (state.villageCosts[botName] || 0) + cost;
  }
}

// --- Auth helper for /api/join and /api/leave ---

function validateVillageSecret(req) {
  if (!VILLAGE_SECRET) return false;
  const auth = req.headers.authorization || '';
  return auth === `Bearer ${VILLAGE_SECRET}`;
}

// --- JSON body parser for raw http.createServer ---

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// --- Remove bot helper (shared by /api/leave, dead bot detection, startup recovery) ---

function removeBot(botName, reason) {
  const displayName = participants.get(botName)?.displayName || botName;
  participants.delete(botName);
  failureCounts.delete(botName);

  // Remove from all locations
  for (const loc of gameConfig.locationSlugs) {
    const idx = state.locations[loc].indexOf(botName);
    if (idx !== -1) {
      state.locations[loc].splice(idx, 1);
      broadcastEvent({
        type: 'movement', bot: botName, displayName,
        action: 'leave', location: loc, tick: state.clock.tick,
      });
      state.publicLogs[loc].push({
        bot: botName, action: 'say',
        message: `*${displayName} has left the village.*`,
      });
    }
  }

  // Clean up pending whispers
  delete state.whispers[botName];

  console.log(`[village] ${botName} removed (${reason})`);
}

// --- Startup recovery: rebuild participants from state.json ---

async function recoverParticipants() {
  // Collect all bot names currently in any location
  const botsInState = new Set();
  for (const loc of gameConfig.locationSlugs) {
    for (const name of state.locations[loc]) botsInState.add(name);
  }

  if (botsInState.size === 0) {
    console.log('[village] Recovery: no bots in state');
    return;
  }

  console.log(`[village] Recovery: checking ${botsInState.size} bot(s) from state...`);
  const toRemove = [];

  for (const botName of botsInState) {
    try {
      const village = await villageManager.read(botName);
      if (!village.enabled) {
        toRemove.push({ botName, reason: 'village disabled' });
        continue;
      }

      const config = await configManager.read(botName);
      const port = config?.gateway?.port;
      if (!port) {
        toRemove.push({ botName, reason: 'no port in config' });
        continue;
      }

      // Health check
      try {
        await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        toRemove.push({ botName, reason: 'unreachable' });
        continue;
      }

      const identity = await identityManager.read(botName);
      const displayName = identity?.self?.displayName || botName;
      participants.set(botName, { port, displayName });
      console.log(`[village] Recovery: ${botName} OK (port ${port})`);
    } catch {
      toRemove.push({ botName, reason: 'error reading config' });
    }
  }

  for (const { botName, reason } of toRemove) {
    removeBot(botName, `recovery: ${reason}`);
  }

  console.log(`[village] Recovery complete: ${participants.size} active participant(s)`);
}

// --- Send scene to a bot ---

async function sendScene(botName, port, conversationId, scene) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (VILLAGE_SECRET) {
      headers['Authorization'] = `Bearer ${VILLAGE_SECRET}`;
    }

    const resp = await fetch(`http://127.0.0.1:${port}/village`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ conversationId, scene }),
      signal: AbortSignal.timeout(SCENE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      console.error(`[village] ${botName} HTTP ${resp.status}`);
      trackFailure(botName);
      return null;
    }

    // Success — reset failure count
    failureCounts.delete(botName);
    return await resp.json();
  } catch (err) {
    console.error(`[village] ${botName} ${err.name === 'TimeoutError' ? 'timeout (60s)' : err.message} — skipped`);
    trackFailure(botName);
    return null;
  }
}

function trackFailure(botName) {
  const count = (failureCounts.get(botName) || 0) + 1;
  failureCounts.set(botName, count);
  if (count >= MAX_CONSECUTIVE_FAILURES) {
    console.warn(`[village] ${botName} failed ${count} consecutive times — auto-removing`);
    removeBot(botName, `${count} consecutive failures`);
  }
}

// --- Process actions from a bot (delegated to logic.js) ---
// processActions imported from './logic.js'

// --- Broadcast to observers ---

function broadcastEvent(event) {
  const data = JSON.stringify(event);
  for (const obs of observers) {
    try {
      obs.res.write(`data: ${data}\n\n`);
    } catch {
      observers.delete(obs);
    }
  }

  // Persist to JSONL log file
  try {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== logDate) {
      logDate = today;
      logFile = join(LOGS_DIR, `${today}.jsonl`);
    }
    const line = JSON.stringify({ ...event, _ts: new Date().toISOString() }) + '\n';
    appendFileSync(logFile, line);
  } catch (err) {
    console.error(`[village] Failed to write event log: ${err.message}`);
  }
}

// --- Advance clock (delegated to logic.js) ---

function advanceClock() {
  advanceClockImpl(state.clock, TICKS_PER_PHASE, gameConfig.phases);
}

// --- Main tick ---

async function tick() {
  // Safe in Node.js — synchronous check+set before any await; no concurrent callers possible
  if (paused || tickInProgress) return;
  tickInProgress = true;
  const tickStart = Date.now();

  try {
    advanceClock();
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
    const dailyCosts = new Map();
    for (const botName of participants.keys()) {
      dailyCosts.set(botName, await readBotDailyCost(botName));
    }

    // Read village memory summaries for all participants
    const VILLAGE_MEMORY_CAP = 1500;
    const villageSummaries = new Map(); // botName → summary string
    for (const botName of participants.keys()) {
      try {
        const memPath = join(paths.memoryDir(botName), 'village.md');
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
    const actionCounts = { say: 0, whisper: 0, observe: 0, move: 0 };
    let botsSent = 0;
    let botsResponded = 0;
    let botsSkippedCost = 0;
    let errors = 0;

    // Roll village events and conversation spice for occupied locations
    const activeEvents = new Map();  // location → event text
    const activeSpice = new Map();   // location → spice text
    for (const loc of gameConfig.locationSlugs) {
      const botsAtLoc = state.locations[loc];
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

    for (const loc of gameConfig.locationSlugs) {
      const botsAtLoc = [...state.locations[loc]];
      allEvents.set(loc, []);

      if (botsAtLoc.length === 0) {
        state.emptyTicks[loc] = (state.emptyTicks[loc] || 0) + 1;
        if (state.emptyTicks[loc] >= EMPTY_CLEAR_TICKS && state.publicLogs[loc].length > 0) {
          state.publicLogs[loc] = [];
        }
        continue;
      }

      state.emptyTicks[loc] = 0;

      if (state.publicLogs[loc].length > MAX_PUBLIC_LOG_DEPTH) {
        state.publicLogs[loc] = state.publicLogs[loc].slice(-MAX_PUBLIC_LOG_DEPTH);
      }

      for (const botName of botsAtLoc) {
        if (!participants.has(botName)) continue;

        const botCost = dailyCosts.get(botName) || 0;
        if (VILLAGE_DAILY_COST_CAP > 0 && botCost >= VILLAGE_DAILY_COST_CAP) {
          console.log(`[village] ${botName} skipped — daily cost $${botCost.toFixed(4)} exceeds cap $${VILLAGE_DAILY_COST_CAP}`);
          botsSkippedCost++;
          continue;
        }

        const { port } = participants.get(botName);
        const othersHere = botsAtLoc.filter(b => b !== botName);
        const pendingWhispers = state.whispers[botName] || [];
        const conversationId = `village:${loc}`;

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
          gameConfig,
        });

        allSceneRequests.push({ botName, port, conversationId, scene, loc });
      }
    }

    // Send all scenes across all locations in parallel
    const allResults = await Promise.all(
      allSceneRequests.map(async ({ botName, port, conversationId, scene, loc }) => {
        botsSent++;
        const response = await sendScene(botName, port, conversationId, scene);
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
          locationName: gameConfig.locationNames[loc],
          bot: botName,
          displayName: displayNames[botName],
          ...ev,
          ...extra,
        });
      }
    }

    // Track relationships
    trackInteractions(allEvents, state, displayNames);
    updateCoLocation(state);
    const relChanges = updateRelationships(state, displayNames, gameConfig);
    for (const change of relChanges) {
      broadcastEvent({
        type: 'relationship',
        tick: tickNum,
        from: change.from,
        to: change.to,
        fromDisplay: change.fromDisplay,
        toDisplay: change.toDisplay,
        label: change.label,
        prevLabel: change.prevLabel,
      });
      console.log(`[village] relationship: ${change.fromDisplay} & ${change.toDisplay} → ${change.label || '(none)'}`);
    }

    // Decay relationships for non-co-located pairs
    decayRelationships(state, gameConfig);

    // Track emotions (pass active events/spice for impulse triggers)
    const emotionChanges = updateEmotions(state, allEvents, allResults, displayNames, { activeEvents, activeSpice }, gameConfig);
    for (const change of emotionChanges) {
      broadcastEvent({
        type: 'emotion',
        tick: tickNum,
        bot: change.bot,
        displayName: change.displayName,
        emotion: change.emotion,
        prevEmotion: change.prevEmotion,
      });
      console.log(`[village] emotion: ${change.displayName} → ${change.emotion}`);
    }

    // Write village memories per bot
    const timestamp = new Date().toISOString();
    for (const [loc, events] of allEvents) {
      if (events.length === 0) continue;

      // Each bot at this location gets a memory entry scoped to their view
      const botsAtLoc = state.locations[loc];
      for (const botName of botsAtLoc) {
        if (!participants.has(botName)) continue;
        try {
          const entry = buildMemoryEntry({
            location: gameConfig.locationNames[loc] || loc,
            timestamp,
            events,
            botName,
          });
          if (entry.trim()) {
            await appendVillageMemory(botName, entry);
          }
        } catch (err) {
          console.error(`[village] Failed to write memory for ${botName}: ${err.message}`);
        }
      }
    }

    // Summarize oversized village.md files (fire-and-forget, don't block tick)
    for (const botName of participants.keys()) {
      needsSummarization(botName).then(needed => {
        if (needed) summarizeVillageMemory(botName);
      }).catch(() => {});
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
    nextTickAt = Date.now() + TICK_INTERVAL_MS;
    broadcastEvent({
      type: 'tick',
      tick: tickNum,
      phase,
      villageTime: vt.timeStr,
      bots: botsResponded,
      botsTotal: botsSent,
      actions: actionCounts,
      duration,
      nextTickAt,
      tickIntervalMs: TICK_INTERVAL_MS,
      locations: Object.fromEntries(
        gameConfig.locationSlugs.map(l => [l, state.locations[l].map(b => ({
          name: b, displayName: displayNames[b] || b,
        }))])
      ),
      relationships: state.relationships,
      emotions: state.emotions,
    });
  } catch (err) {
    console.error(`[village] Tick error: ${err.message}`);
  } finally {
    tickInProgress = false;
  }
}

// --- Auth helper ---

async function validateObserverAuth(req) {
  const cookieHeader = req.headers.cookie || '';
  try {
    const tokensRaw = await readFile(ADMIN_TOKENS_FILE, 'utf-8');
    const tokens = JSON.parse(tokensRaw);
    return validateObserverAuthImpl(cookieHeader, tokens);
  } catch { /* no tokens file */ }
  return null;
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
      status: paused ? 'paused' : 'running',
      tick: state.clock.tick,
      phase: state.clock.phase,
      activeBots: participants.size,
      lastTickAt: new Date().toISOString(),
      uptime: Math.round((Date.now() - startTime) / 1000),
      game: gameConfig.raw.id,
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

    const { botName, port, displayName } = body || {};
    if (!botName || !port) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing botName or port' }));
      return;
    }

    if (participants.has(botName)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already joined' }));
      return;
    }

    // Health-check the bot before accepting
    try {
      await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bot unreachable' }));
      return;
    }

    const name = displayName || botName;

    // Add to participants map
    participants.set(botName, { port, displayName: name });
    failureCounts.delete(botName);

    // Place at spawn location if not already in any location
    const alreadyInLocation = gameConfig.locationSlugs.some(loc => state.locations[loc].includes(botName));
    if (!alreadyInLocation) {
      state.locations[gameConfig.spawnLocation].push(botName);
      broadcastEvent({
        type: 'movement', bot: botName, displayName: name,
        action: 'join', location: gameConfig.spawnLocation, tick: state.clock.tick,
      });
      state.publicLogs[gameConfig.spawnLocation].push({
        bot: botName, action: 'say',
        message: `*${name} has joined the village!*`,
      });
    }

    await saveState();
    console.log(`[village] ${botName} joined (port ${port}, display: ${name})`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      game: {
        id: gameConfig.raw.id,
        name: gameConfig.raw.name,
        description: gameConfig.raw.description,
        version: gameConfig.raw.version,
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
      await saveState();
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/events' && req.method === 'GET') {
    const authedBot = await validateObserverAuth(req);
    if (!authedBot) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — log in via admin page first' }));
      return;
    }

    // SSE stream
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const observer = { res, botName: authedBot };
    observers.add(observer);

    // Send initial state
    const initVt = getVillageTime(gameConfig.timezone);
    const initData = JSON.stringify({
      type: 'init',
      tick: state.clock.tick,
      phase: initVt.phase,
      villageTime: initVt.timeStr,
      paused,
      nextTickAt,
      tickIntervalMs: TICK_INTERVAL_MS,
      game: {
        id: gameConfig.raw.id,
        name: gameConfig.raw.name,
        description: gameConfig.raw.description,
        version: gameConfig.raw.version,
      },
      locations: Object.fromEntries(
        gameConfig.locationSlugs.map(l => [l, (state.locations[l] || []).map(b => ({
          name: b, displayName: participants.get(b)?.displayName || b,
        }))])
      ),
      relationships: state.relationships,
      emotions: state.emotions,
      publicLogs: Object.fromEntries(
        gameConfig.locationSlugs.filter(l => (state.publicLogs[l] || []).length > 0)
          .map(l => [l, state.publicLogs[l].map(e => ({
            ...e,
            displayName: participants.get(e.bot)?.displayName || e.bot,
          }))])
      ),
    });
    res.write(`data: ${initData}\n\n`);

    // Keepalive
    const keepalive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 3000);

    req.on('close', () => {
      clearInterval(keepalive);
      observers.delete(observer);
    });
    return;
  }

  if (path === '/api/logs' && req.method === 'GET') {
    const authedBot = await validateObserverAuth(req);
    if (!authedBot) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const beforeTick = url.searchParams.has('before') ? parseInt(url.searchParams.get('before'), 10) : Infinity;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    try {
      // List log files sorted descending (newest first)
      const files = (await readdir(LOGS_DIR)).filter(f => f.endsWith('.jsonl')).sort().reverse();
      const events = [];
      let hasMore = false;

      outer:
      for (const file of files) {
        const raw = await readFile(join(LOGS_DIR, file), 'utf-8');
        const lines = raw.trim().split('\n').filter(Boolean);
        // Iterate in reverse (newest first within file)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const ev = JSON.parse(lines[i]);
            if (ev.tick !== undefined && ev.tick >= beforeTick) continue;
            if (events.length >= limit) { hasMore = true; break outer; }
            events.push(ev);
          } catch { /* skip malformed lines */ }
        }
      }

      // Return oldest-first order for client rendering
      events.reverse();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events, hasMore }));
    } catch (err) {
      // No log files yet — return empty
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events: [], hasMore: false }));
    }
    return;
  }

  if (path === '/pause' && req.method === 'POST') {
    paused = true;
    console.log('[village] Paused');
    broadcastEvent({ type: 'status', paused: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paused: true }));
    return;
  }

  if (path === '/resume' && req.method === 'POST') {
    paused = false;
    console.log('[village] Resumed');
    broadcastEvent({ type: 'status', paused: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ paused: false }));
    return;
  }

  // Serve static files
  if (path === '/' || path === '/index.html') {
    try {
      const html = await readFile(join(__dirname, 'public', 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Game loop ---
let tickTimer = null;

function startGameLoop() {
  // Run first tick after a short delay
  nextTickAt = Date.now() + 5000;
  setTimeout(() => tick(), 5000);
  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS);
}

// --- Graceful shutdown ---

function shutdown(signal) {
  console.log(`[village] ${signal} received — shutting down`);

  if (tickTimer) clearInterval(tickTimer);

  // Wait for current tick to finish
  const waitForTick = () => {
    if (tickInProgress) {
      setTimeout(waitForTick, 500);
      return;
    }

    // Save state
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
      // Force exit after 5s
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
await recoverParticipants();

server.listen(PORT, '127.0.0.1', () => {
  startTime = Date.now();
  console.log(`[village] Orchestrator listening on 127.0.0.1:${PORT}`);
  console.log(`[village] Tick interval: ${TICK_INTERVAL_MS / 1000}s, ticks/phase: ${TICKS_PER_PHASE}`);
  startGameLoop();
});
