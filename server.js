/**
 * Village Orchestrator — the "game master" for the bot social village.
 *
 * Maintains world state, runs a tick-based game loop, sends scene prompts
 * to each bot's /village endpoint, routes responses, writes village memories,
 * and serves an observer web UI via SSE.
 *
 * Uses Node.js built-ins only. Imports CJS lib/ modules via createRequire.
 */

import { createServer } from 'node:http';
import { readFile, writeFile, rename, copyFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { buildScene, LOCATION_NAMES, ALL_LOCATIONS } from './scene.js';
import { appendVillageMemory, buildMemoryEntry } from './memory.js';
import {
  processActions,
  advanceClock as advanceClockImpl,
  enforceLogDepth,
  computeQualityMetrics,
  shouldSkipForCost,
  findNewBots,
  findDepartedBots,
} from './logic.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Import CJS lib modules ---
const paths = require('../lib/paths');
const villageManager = require('../lib/village-manager');
const configManager = require('../lib/config-manager');
const identityManager = require('../lib/identity-manager');

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || '300000', 10); // 5 minutes
const TICKS_PER_PHASE = parseInt(process.env.VILLAGE_TICKS_PER_PHASE || '4', 10);
const SCENE_HISTORY_CAP = parseInt(process.env.VILLAGE_SCENE_HISTORY_CAP || '10', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const MAX_PUBLIC_LOG_DEPTH = parseInt(process.env.VILLAGE_MAX_LOG_DEPTH || '20', 10);
const SCENE_TIMEOUT_MS = 60_000;
const EMPTY_CLEAR_TICKS = 3;

const STATE_FILE = join(__dirname, 'state.json');
const USAGE_FILE = join(paths.PROJECT_DIR, 'api-router', 'usage.json');
const ADMIN_TOKENS_FILE = join(paths.PROJECT_DIR, 'portal', 'admin-tokens.json');

// PHASES imported from logic.js via advanceClockImpl

// --- State ---
let state = {
  locations: {},
  whispers: {},
  publicLogs: {},
  clock: { tick: 0, phase: 'morning', ticksInPhase: 0 },
  emptyTicks: {},
};
let paused = false;
let tickInProgress = false;
let startTime = Date.now();

// --- Observer SSE connections ---
const observers = new Set(); // { res, botName }

// --- Load/Save state ---

async function loadState() {
  function applyState(loaded, source) {
    state = {
      locations: loaded.locations || {},
      whispers: loaded.whispers || {},
      publicLogs: loaded.publicLogs || {},
      clock: loaded.clock || { tick: 0, phase: 'morning', ticksInPhase: 0 },
      emptyTicks: loaded.emptyTicks || {},
    };
    for (const loc of ALL_LOCATIONS) {
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
  for (const loc of ALL_LOCATIONS) {
    state.locations[loc] = [];
    state.publicLogs[loc] = [];
    state.emptyTicks[loc] = 0;
  }
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

async function readBotDailyCost(botName) {
  try {
    const raw = await readFile(USAGE_FILE, 'utf-8');
    const usage = JSON.parse(raw);
    const botUsage = usage[botName];
    if (!botUsage) return 0;

    // Check if usage was updated today
    const today = new Date().toISOString().slice(0, 10);
    const lastUpdated = botUsage.lastUpdated || '';
    if (!lastUpdated.startsWith(today)) return 0;

    return botUsage.dailyCost || 0;
  } catch {
    return 0;
  }
}

// --- Participant discovery ---

async function discoverParticipants() {
  const participants = new Map(); // botName → { port, displayName }

  // Scan all bots with village enabled (async to avoid blocking event loop)
  const customerDirs = [];
  try {
    const { readdir, stat } = await import('node:fs/promises');
    for (const name of await readdir(paths.CUSTOMERS_DIR)) {
      try {
        if ((await stat(join(paths.CUSTOMERS_DIR, name))).isDirectory()) {
          customerDirs.push(name);
        }
      } catch { /* skip */ }
    }
  } catch { /* no customers dir */ }

  // Check each customer bot
  for (const botName of customerDirs) {
    try {
      const village = await villageManager.read(botName);
      if (!village.enabled) continue;

      const config = await configManager.read(botName);
      if (!config) continue;

      const port = config.gateway?.port;
      if (!port) continue;

      // Health check
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) continue;
      } catch {
        continue; // unhealthy or unreachable
      }

      const identity = await identityManager.read(botName);
      const displayName = identity?.self?.displayName || botName;

      participants.set(botName, { port, displayName });
    } catch { /* skip */ }
  }

  // Admin bot excluded from village for security (see ggbot.md blocker #4)

  return participants;
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
      return null;
    }

    return await resp.json();
  } catch (err) {
    console.error(`[village] ${botName} ${err.name === 'TimeoutError' ? 'timeout (60s)' : err.message} — skipped`);
    return null;
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
}

// --- Advance clock (delegated to logic.js) ---

function advanceClock() {
  advanceClockImpl(state.clock, TICKS_PER_PHASE);
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
    const phase = state.clock.phase;

    // Discover active participants
    const participants = await discoverParticipants();
    const displayNames = {};
    for (const [name, info] of participants) {
      displayNames[name] = info.displayName;
    }

    // Handle new bots joining
    const allParticipantNames = new Set(participants.keys());
    const allInLocations = new Set();
    for (const bots of Object.values(state.locations)) {
      for (const b of bots) allInLocations.add(b);
    }

    // New bots → place at central-square
    for (const name of allParticipantNames) {
      if (!allInLocations.has(name)) {
        state.locations['central-square'].push(name);
        const joinEvent = {
          type: 'movement', bot: name, displayName: displayNames[name],
          action: 'join', location: 'central-square', tick: tickNum,
        };
        broadcastEvent(joinEvent);
        // Add join announcement to central-square public log
        state.publicLogs['central-square'].push({
          bot: name, action: 'say',
          message: `*${displayNames[name]} has joined the village!*`,
        });
      }
    }

    // Bots that left (no longer in participants)
    for (const loc of ALL_LOCATIONS) {
      const remaining = [];
      for (const name of state.locations[loc]) {
        if (allParticipantNames.has(name)) {
          remaining.push(name);
        } else {
          const leaveEvent = {
            type: 'movement', bot: name, displayName: displayNames[name] || name,
            action: 'leave', location: loc, tick: tickNum,
          };
          broadcastEvent(leaveEvent);
          state.publicLogs[loc].push({
            bot: name, action: 'say',
            message: `*${displayNames[name] || name} has left the village.*`,
          });
        }
      }
      state.locations[loc] = remaining;
    }

    // Read daily costs for all participants (cost cap enforcement)
    const dailyCosts = new Map();
    for (const botName of participants.keys()) {
      dailyCosts.set(botName, await readBotDailyCost(botName));
    }

    // Build scenes and collect actions per location
    const allEvents = new Map(); // location → events[]
    const actionCounts = { say: 0, whisper: 0, observe: 0, move: 0 };
    let botsSent = 0;
    let botsResponded = 0;
    let botsSkippedCost = 0;
    let errors = 0;

    for (const loc of ALL_LOCATIONS) {
      const botsAtLoc = [...state.locations[loc]];
      allEvents.set(loc, []);

      if (botsAtLoc.length === 0) {
        state.emptyTicks[loc] = (state.emptyTicks[loc] || 0) + 1;
        // Clear stale logs after N empty ticks
        if (state.emptyTicks[loc] >= EMPTY_CLEAR_TICKS && state.publicLogs[loc].length > 0) {
          state.publicLogs[loc] = [];
        }
        continue;
      }

      state.emptyTicks[loc] = 0;

      // Sequential processing — conscious decision for MVP (3-5 bots).
      // Per ggbot.md consensus: ship sequential, measure real tick times,
      // optimize to parallel if >3min ticks observed.
      // Randomize bot order to prevent first-mover bias
      const shuffled = botsAtLoc.sort(() => Math.random() - 0.5);

      // Enforce public log depth limit per location
      if (state.publicLogs[loc].length > MAX_PUBLIC_LOG_DEPTH) {
        state.publicLogs[loc] = state.publicLogs[loc].slice(-MAX_PUBLIC_LOG_DEPTH);
      }

      for (const botName of shuffled) {
        if (!participants.has(botName)) continue;

        // Cost cap enforcement: skip bot if daily village cost exceeds cap
        const botCost = dailyCosts.get(botName) || 0;
        if (VILLAGE_DAILY_COST_CAP > 0 && botCost >= VILLAGE_DAILY_COST_CAP) {
          console.log(`[village] ${botName} skipped — daily cost $${botCost.toFixed(4)} exceeds cap $${VILLAGE_DAILY_COST_CAP}`);
          botsSkippedCost++;
          continue;
        }

        const { port } = participants.get(botName);

        const othersHere = botsAtLoc.filter(b => b !== botName);
        const pendingWhispers = state.whispers[botName] || [];
        const conversationId = `village:${loc}:tick-${tickNum}`;

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
          movements: [], // movements from this tick are in the log already
          sceneHistoryCap: SCENE_HISTORY_CAP,
        });

        botsSent++;
        const response = await sendScene(botName, port, conversationId, scene);

        // Clear consumed whispers
        delete state.whispers[botName];

        if (!response || !response.actions) {
          errors++;
          continue;
        }

        botsResponded++;
        const events = processActions(botName, response.actions, loc, state);
        allEvents.get(loc).push(...events);

        // Count actions
        for (const ev of events) {
          if (actionCounts[ev.action] !== undefined) actionCounts[ev.action]++;
        }

        // Broadcast each event to observers
        for (const ev of events) {
          broadcastEvent({
            type: 'action',
            tick: tickNum,
            phase,
            location: loc,
            locationName: LOCATION_NAMES[loc],
            bot: botName,
            displayName: displayNames[botName],
            ...ev,
          });
        }
      }
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
            location: LOCATION_NAMES[loc] || loc,
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

    // Persist state
    await saveState();

    // Conversation quality metrics (observability only — see ggbot.md 2A)
    for (const loc of ALL_LOCATIONS) {
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
    broadcastEvent({
      type: 'tick',
      tick: tickNum,
      phase,
      bots: botsResponded,
      botsTotal: botsSent,
      actions: actionCounts,
      duration,
      locations: Object.fromEntries(
        ALL_LOCATIONS.map(l => [l, state.locations[l].map(b => ({
          name: b, displayName: displayNames[b] || b,
        }))])
      ),
    });
  } catch (err) {
    console.error(`[village] Tick error: ${err.message}`);
  } finally {
    tickInProgress = false;
  }
}

// --- Auth helper ---

async function validateObserverAuth(req) {
  // Check for any as_* cookie that has a valid admin session
  const cookieHeader = req.headers.cookie || '';
  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
  );

  try {
    const tokensRaw = await readFile(ADMIN_TOKENS_FILE, 'utf-8');
    const tokens = JSON.parse(tokensRaw);

    for (const [key, value] of Object.entries(cookies)) {
      if (!key.startsWith('as_')) continue;
      const botName = key.slice(3);
      const botTokens = tokens[botName];
      if (!botTokens) continue;

      if (botTokens.session === value && botTokens.sessionExpiresAt > Date.now()) {
        return botName;
      }
    }
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
    const participants = await discoverParticipants();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: paused ? 'paused' : 'running',
      tick: state.clock.tick,
      phase: state.clock.phase,
      activeBots: participants.size,
      lastTickAt: new Date().toISOString(),
      uptime: Math.round((Date.now() - startTime) / 1000),
    }));
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
    const initData = JSON.stringify({
      type: 'init',
      tick: state.clock.tick,
      phase: state.clock.phase,
      paused,
      locations: Object.fromEntries(
        ALL_LOCATIONS.map(l => [l, state.locations[l] || []])
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

await loadState();

server.listen(PORT, '127.0.0.1', () => {
  startTime = Date.now();
  console.log(`[village] Orchestrator listening on 127.0.0.1:${PORT}`);
  console.log(`[village] Tick interval: ${TICK_INTERVAL_MS / 1000}s, ticks/phase: ${TICKS_PER_PHASE}`);
  startGameLoop();
});
