/**
 * Village Orchestrator — the "game master" for the bot social village.
 *
 * Maintains world state, runs a tick-based game loop, sends scene prompts
 * to bots via the portal relay proxy, routes responses, writes village
 * memories, and serves an observer web UI via SSE.
 *
 * Uses Node.js built-ins only. Imports CJS lib/ modules via createRequire.
 *
 * Game content is loaded from a JSON schema file via game-loader.js.
 * Set VILLAGE_GAME env var to select a game (default: social-village).
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, copyFile, mkdir, readdir } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { loadGame } from './game-loader.js';
import { advanceClock as advanceClockImpl, readBotDailyCost as readBotDailyCostImpl } from './games/social-village/logic.js';
import { getVillageTime } from './games/social-village/scene.js';
import { generateWorld, placeInitialResources, mulberry32, randomEdgeTile } from './games/survival/world.js';
import { getDayPhase } from './games/survival/scene.js';
import { survivalTick, fastTick as survivalFastTick } from './games/survival/tick.js';
import { socialTick } from './games/social-village/tick.js';
import { runSocialFastTick } from './games/social-village/autopilot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// --- Import CJS lib modules ---
const paths = require('../lib/paths');
const villageManager = require('../lib/village-manager');
const configManager = require('../lib/config-manager');
const identityManager = require('../lib/identity-manager');

// --- Load game schema ---
const VILLAGE_GAME = process.env.VILLAGE_GAME || 'social-village';
const gameConfig = loadGame(join(__dirname, 'games', VILLAGE_GAME, 'schema.json'));
console.log(`[village] Loaded game: ${gameConfig.raw.id} (${gameConfig.raw.name})`);

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const TICKS_PER_PHASE = parseInt(process.env.VILLAGE_TICKS_PER_PHASE || '4', 10);
const SCENE_HISTORY_CAP = parseInt(process.env.VILLAGE_SCENE_HISTORY_CAP || '10', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const MAX_PUBLIC_LOG_DEPTH = parseInt(process.env.VILLAGE_MAX_LOG_DEPTH || '20', 10);
const REMOTE_SCENE_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES_REMOTE = 5;
const PORTAL_URL = 'http://127.0.0.1:3000';
const EMPTY_CLEAR_TICKS = 3;

const isGridGame = gameConfig.isGridGame;
const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || (isGridGame ? '45000' : '120000'), 10);
const FAST_TICK_MS = gameConfig.raw.autopilot?.fastTickMs || 1000;
const STATE_FILE = join(__dirname, `state-${VILLAGE_GAME}.json`);
const MEMORY_FILENAME = isGridGame ? 'survival.md' : 'village.md';
const USAGE_FILE = join(paths.PROJECT_DIR, 'api-router', 'usage.json');
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
  locationState: {},
  customLocations: {},
  occupations: {},
  bonds: {},
  explorations: {},
};

let tickInProgress = false;
let nextTickAt = 0;
let startTime = Date.now();

// --- Observer SSE connections ---
const observers = new Set(); // { res, botName }

// --- Participants (event-driven, updated by /api/join and /api/leave) ---
const participants = new Map(); // botName → { port, displayName }
const failureCounts = new Map(); // botName → consecutive failure count
const lastMoveTick = new Map();  // botName → tick number of last move (cooldown)
const MAX_CONSECUTIVE_FAILURES = 3;

// --- Load/Save state ---

async function loadState() {
  function applySocialState(loaded, source) {
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
      locationState: loaded.locationState || {},
      customLocations: loaded.customLocations || {},
      occupations: loaded.occupations || {},
      bonds: loaded.bonds || {},
      explorations: loaded.explorations || {},
      fastTickSummary: loaded.fastTickSummary || {},
      autopilotState: loaded.autopilotState || { ambientCooldowns: {}, moveCooldowns: {} },
    };
    // Initialize schema locations
    for (const loc of gameConfig.locationSlugs) {
      if (!state.locations[loc]) state.locations[loc] = [];
      if (!state.publicLogs[loc]) state.publicLogs[loc] = [];
      if (!state.emptyTicks[loc]) state.emptyTicks[loc] = 0;
    }
    // Initialize custom locations (built by bots)
    for (const loc of Object.keys(state.customLocations)) {
      if (!state.locations[loc]) state.locations[loc] = [];
      if (!state.publicLogs[loc]) state.publicLogs[loc] = [];
      if (!state.emptyTicks[loc]) state.emptyTicks[loc] = 0;
    }
    console.log(`[village] State loaded from ${source}: tick=${state.clock.tick} phase=${state.clock.phase} customLocations=${Object.keys(state.customLocations).length}`);
  }

  function applyGridState(loaded, source) {
    state = {
      terrain: loaded.terrain || '',
      tileData: loaded.tileData || {},
      bots: loaded.bots || {},
      recentEvents: loaded.recentEvents || [],
      clock: loaded.clock || { tick: 0, dayTick: 0 },
      worldSeed: loaded.worldSeed || gameConfig.raw.world.seed,
      villageCosts: loaded.villageCosts || {},
    };
    // Round state for scoring
    state.round = loaded.round || {
      number: 1,
      ticksRemaining: gameConfig.raw.scoring?.roundLength || 50,
      scores: {},
      roundHistory: [],
    };
    // Diplomacy state
    state.diplomacy = loaded.diplomacy || { alliances: {}, proposals: {}, betrayals: [] };
    console.log(`[village] Grid state loaded from ${source}: tick=${state.clock.tick} bots=${Object.keys(state.bots).length}`);
  }

  const applyState = isGridGame ? applyGridState : applySocialState;

  // Try primary state file
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    applyState(JSON.parse(raw), STATE_FILE);
    return;
  } catch { /* primary failed or missing */ }

  // Fallback to backup
  try {
    const bakRaw = await readFile(STATE_FILE + '.bak', 'utf-8');
    applyState(JSON.parse(bakRaw), STATE_FILE + '.bak');
    console.warn('[village] Primary state was corrupt/missing — recovered from backup');
    return;
  } catch { /* backup also failed */ }

  // Initialize fresh state
  if (isGridGame) {
    console.log('[village] Generating world...');
    const worldConfig = gameConfig.raw.world;
    const rng = mulberry32(worldConfig.seed);
    const { terrain } = generateWorld(worldConfig);
    const tileData = placeInitialResources(terrain, worldConfig, rng);
    state = {
      terrain,
      tileData,
      bots: {},
      recentEvents: [],
      clock: { tick: 0, dayTick: 0 },
      worldSeed: worldConfig.seed,
      villageCosts: {},
      round: {
        number: 1,
        ticksRemaining: gameConfig.raw.scoring?.roundLength || 50,
        scores: {},
        roundHistory: [],
      },
      diplomacy: { alliances: {}, proposals: {}, betrayals: [] },
    };
    const resourceCount = Object.keys(tileData).length;
    console.log(`[village] World generated: ${worldConfig.width}x${worldConfig.height}, ${resourceCount} resource tiles`);
  } else {
    for (const loc of gameConfig.locationSlugs) {
      state.locations[loc] = [];
      state.publicLogs[loc] = [];
      state.emptyTicks[loc] = 0;
    }
    state.relationships = {};
    state.locationState = {};
    state.customLocations = {};
    state.occupations = {};
    state.bonds = {};
    state.explorations = {};
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
  const expected = `Bearer ${VILLAGE_SECRET}`;
  if (auth.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
}

// --- JSON body parser for raw http.createServer ---

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

// --- Helper: all location slugs (schema + custom) ---

function allLocationSlugs() {
  return [...gameConfig.locationSlugs, ...Object.keys(state.customLocations || {})];
}

// --- Remove bot helper (shared by /api/leave, dead bot detection, startup recovery) ---

function removeBot(botName, reason) {
  const displayName = participants.get(botName)?.displayName || botName;
  participants.delete(botName);
  failureCounts.delete(botName);

  if (isGridGame) {
    // Grid game: remove from bots map
    if (state.bots[botName]) {
      broadcastEvent({
        type: 'survival_event', bot: botName, displayName,
        action: 'leave', tick: state.clock.tick,
      });
      delete state.bots[botName];
    }
  } else {
    // Social game: remove from all locations (including custom)
    for (const loc of allLocationSlugs()) {
      if (!state.locations[loc]) continue;
      const idx = state.locations[loc].indexOf(botName);
      if (idx !== -1) {
        state.locations[loc].splice(idx, 1);
        broadcastEvent({
          type: 'movement', bot: botName, displayName,
          action: 'leave', location: loc, tick: state.clock.tick,
        });
        state.publicLogs[loc]?.push({
          bot: botName, action: 'say',
          message: `*${displayName} has left the village.*`,
        });
      }
    }

    // Clean up pending whispers
    delete state.whispers[botName];
  }

  console.log(`[village] ${botName} removed (${reason})`);
}

// --- Startup recovery: rebuild participants from state.json ---

async function recoverParticipants() {
  // Collect all bot names currently in state
  const botsInState = new Set();
  if (isGridGame) {
    for (const name of Object.keys(state.bots)) botsInState.add(name);
  } else {
    for (const loc of allLocationSlugs()) {
      for (const name of (state.locations[loc] || [])) botsInState.add(name);
    }
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

  // Second pass: check unrecovered bots against village-tokens.json (remote bots)
  const stillUnrecovered = toRemove.filter(({ botName }) => !participants.has(botName));
  if (stillUnrecovered.length > 0) {
    try {
      const tokensPath = join(paths.PROJECT_DIR, 'portal', 'village-tokens.json');
      const raw = await readFile(tokensPath, 'utf-8');
      const tokens = JSON.parse(raw);
      // Build botName → token entry lookup
      const tokensByBot = new Map();
      for (const [, entry] of Object.entries(tokens)) {
        if (entry.botName) tokensByBot.set(entry.botName, entry);
      }

      for (let i = stillUnrecovered.length - 1; i >= 0; i--) {
        const { botName } = stillUnrecovered[i];
        const tokenEntry = tokensByBot.get(botName);
        if (tokenEntry) {
          participants.set(botName, {
            port: null,
            displayName: tokenEntry.displayName || botName,
            remote: true,
          });
          stillUnrecovered.splice(i, 1);
          console.log(`[village] Recovery: ${botName} OK (remote)`);
        }
      }
    } catch { /* no village-tokens.json */ }
  }

  // Remove bots that couldn't be recovered locally or remotely
  for (const { botName, reason } of stillUnrecovered) {
    removeBot(botName, `recovery: ${reason}`);
  }

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
      console.error(`[village] ${botName} (remote) HTTP ${resp.status}`);
      trackFailure(botName);
      return null;
    }

    failureCounts.delete(botName);
    return await resp.json();
  } catch (err) {
    console.error(`[village] ${botName} (remote) ${err.name === 'TimeoutError' ? 'timeout (60s)' : err.message} — skipped`);
    trackFailure(botName);
    return null;
  }
}

function trackFailure(botName) {
  const count = (failureCounts.get(botName) || 0) + 1;
  failureCounts.set(botName, count);
  const isRemote = participants.get(botName)?.remote;
  const limit = isRemote ? MAX_CONSECUTIVE_FAILURES_REMOTE : MAX_CONSECUTIVE_FAILURES;
  if (count >= limit) {
    console.warn(`[village] ${botName} failed ${count} consecutive times — auto-removing`);
    removeBot(botName, `${count} consecutive failures`);
  }
}

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
  if (isGridGame) {
    state.clock.tick++;
    state.clock.dayTick = state.clock.tick % gameConfig.raw.dayNight.cycleTicks;
  } else {
    advanceClockImpl(state.clock, TICKS_PER_PHASE, gameConfig.phases);
  }
}

// --- Build tick context (shared state passed to game tick modules) ---

function buildTickContext(tickStart) {
  return {
    state, gameConfig, participants, lastMoveTick,
    broadcastEvent, sendSceneRemote,
    accumulateResponseCost, readBotDailyCost, saveState,
    TICK_INTERVAL_MS, VILLAGE_DAILY_COST_CAP, MEMORY_FILENAME,
    SCENE_HISTORY_CAP, MAX_PUBLIC_LOG_DEPTH, EMPTY_CLEAR_TICKS,
    tickStart,
    nextTickAt, // initial value; tick modules write back via ctx.nextTickAt
  };
}

// --- Fast tick (autopilot) ---

function fastTick() {
  if (tickInProgress) return; // skip if slow tick is running

  if (isGridGame) {
    if (!state.terrain) return;
    survivalFastTick(buildTickContext(Date.now()));
  } else {
    socialFastTick();
  }
}

function socialFastTick() {
  const { events } = runSocialFastTick(state, gameConfig, participants);
  for (const ev of events) {
    broadcastEvent({ ...ev, tick: state.clock.tick, _ts: new Date().toISOString() });
  }
}

// --- Main tick ---

async function tick() {
  // Safe in Node.js — synchronous check+set before any await; no concurrent callers possible
  if (tickInProgress) return;
  tickInProgress = true;
  const tickStart = Date.now();

  try {
    advanceClock();
    const ctx = buildTickContext(tickStart);
    if (isGridGame) {
      await survivalTick(ctx);
    } else {
      await socialTick(ctx);
    }
    nextTickAt = ctx.nextTickAt;
  } catch (err) {
    console.error(`[village] Tick error: ${err.message}`);
  } finally {
    tickInProgress = false;
  }
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

    const { botName, port, displayName, remote } = body || {};
    if (!botName || (!port && !remote)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing botName or port' }));
      return;
    }

    if (participants.has(botName)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Already joined' }));
      return;
    }

    // Health-check the bot before accepting (skip for remote bots)
    if (!remote) {
      try {
        await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bot unreachable' }));
        return;
      }
    }

    // For local bots, always read identity.json on the server to get the correct display name
    // (the plugin may send the system name if identity.json wasn't ready at activation time)
    let name = displayName || botName;
    if (!remote) {
      try {
        const identity = await identityManager.read(botName);
        if (identity?.self?.displayName) name = identity.self.displayName;
      } catch { /* use what was provided */ }
    }

    // Add to participants map
    participants.set(botName, remote
      ? { port: null, displayName: name, remote: true }
      : { port, displayName: name });
    failureCounts.delete(botName);

    // Place bot in the world
    if (isGridGame) {
      if (!state.bots[botName]) {
        const rng = mulberry32(state.worldSeed + Date.now());
        const pos = randomEdgeTile(state.terrain, gameConfig.raw.world.width, gameConfig.raw.world.height, gameConfig.raw.world.terrain, rng);
        state.bots[botName] = {
          x: pos.x, y: pos.y,
          health: gameConfig.raw.survival.maxHealth,
          hunger: 0,
          inventory: {},
          equipment: { weapon: null, armor: null, tool: null },
          alive: true,
          directive: { intent: 'idle', target: null, fallback: null, x: null, y: null, setAt: 0 },
          path: null,
          pathIdx: 0,
          fastTickStats: { tilesMoved: 0, itemsGathered: [], damageDealt: 0, damageTaken: 0 },
        };
        broadcastEvent({
          type: 'survival_event', bot: botName, displayName: name,
          action: 'join', x: pos.x, y: pos.y, tick: state.clock.tick,
        });
        console.log(`[village] ${botName} spawned at (${pos.x},${pos.y})`);
      }
      // Init score for new/rejoining bot
      if (gameConfig.raw.scoring && state.round) {
        if (state.round.scores[botName] === undefined) {
          state.round.scores[botName] = 0;
        }
      }
    } else {
      const alreadyInLocation = allLocationSlugs().some(loc => (state.locations[loc] || []).includes(botName));
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
    }

    await saveState();
    console.log(`[village] ${botName} joined (${remote ? 'remote' : `port ${port}`}, display: ${name})`);

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

  // --- Bot status endpoint (used by admin portal) ---

  const botStatusMatch = path.match(/^\/api\/bot\/([^/]+)\/status$/);
  if (botStatusMatch && req.method === 'GET') {
    if (!validateVillageSecret(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const queryBot = botStatusMatch[1];
    const inGame = participants.has(queryBot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inGame,
      game: inGame ? { id: gameConfig.raw.id, name: gameConfig.raw.name } : null,
      failureCount: failureCounts.get(queryBot) || 0,
    }));
    return;
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

    // Send initial state
    let initData;
    if (isGridGame) {
      const dayPhase = getDayPhase(state.clock.tick, gameConfig.raw.dayNight);
      initData = JSON.stringify({
        type: 'init',
        gameType: 'grid',
        tick: state.clock.tick,
        dayPhase: dayPhase.name,
        paused: false,
        nextTickAt,
        tickIntervalMs: TICK_INTERVAL_MS,
        game: {
          id: gameConfig.raw.id,
          name: gameConfig.raw.name,
          version: gameConfig.raw.version,
        },
        world: { width: gameConfig.raw.world.width, height: gameConfig.raw.world.height },
        terrain: state.terrain,
        bots: Object.fromEntries(
          Object.entries(state.bots).map(([name, bs]) => [name, {
            x: bs.x, y: bs.y, health: bs.health, hunger: bs.hunger, alive: bs.alive,
            equipment: bs.equipment, inventory: bs.inventory,
            displayName: participants.get(name)?.displayName || name,
            seenTiles: bs.seenTiles ? Object.keys(bs.seenTiles) : [],
          }])
        ),
        resources: Object.keys(state.tileData)
          .filter(k => state.tileData[k].resources?.length > 0)
          .map(k => { const [x, y] = k.split(',').map(Number); return { x, y }; }),
        recentEvents: (state.recentEvents || []).slice(-20),
        round: state.round ? {
          number: state.round.number,
          ticksRemaining: state.round.ticksRemaining,
          scores: state.round.scores,
          roundHistory: state.round.roundHistory,
        } : null,
        diplomacy: state.diplomacy || null,
      });
    } else {
      const initVt = getVillageTime(gameConfig.timezone);
      const initAllLocs = allLocationSlugs();
      initData = JSON.stringify({
        type: 'init',
        gameType: 'social',
        tick: state.clock.tick,
        phase: initVt.phase,
        villageTime: initVt.timeStr,
        paused: false,
        nextTickAt,
        tickIntervalMs: TICK_INTERVAL_MS,
        game: {
          id: gameConfig.raw.id,
          name: gameConfig.raw.name,
          description: gameConfig.raw.description,
          version: gameConfig.raw.version,
        },
        locations: Object.fromEntries(
          initAllLocs.map(l => [l, (state.locations[l] || []).map(b => ({
            name: b, displayName: participants.get(b)?.displayName || b,
          }))])
        ),
        relationships: state.relationships,
        emotions: state.emotions,
        publicLogs: Object.fromEntries(
          initAllLocs.filter(l => (state.publicLogs[l] || []).length > 0)
            .map(l => [l, state.publicLogs[l].map(e => ({
              ...e,
              displayName: participants.get(e.bot)?.displayName || e.bot,
            }))])
        ),
        customLocations: state.customLocations || {},
        occupations: state.occupations || {},
        bonds: state.bonds || {},
        autopilotEnabled: !!gameConfig.raw.autopilot,
      });
    }
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
    // Public — no auth required
    const beforeTick = url.searchParams.has('before') ? parseInt(url.searchParams.get('before'), 10) : Infinity;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

    // Filter events by current game type so survival events don't show in social UI and vice versa
    const SURVIVAL_TYPES = new Set(['survival_event', 'survival_tick', 'fast_tick', 'thinking']);
    const SOCIAL_TYPES = new Set(['action', 'village_event', 'conversation_spice', 'ambient', 'idle', 'autopilot_move']);
    function matchesGameType(ev) {
      if (isGridGame) {
        if (SOCIAL_TYPES.has(ev.type)) return false;
        // Skip social-format tick events (have 'actions' but no 'botStates')
        if (ev.type === 'tick' && ev.actions && !ev.botStates) return false;
      } else {
        if (SURVIVAL_TYPES.has(ev.type)) return false;
        // Skip survival-format tick events (have 'botStates' but no 'actions')
        if (ev.type === 'tick' && ev.botStates && !ev.actions) return false;
      }
      return true;
    }

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
            if (!matchesGameType(ev)) continue;
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

  // Serve static files
  if (path === '/' || path === '/index.html') {
    try {
      const html = await readFile(join(__dirname, 'games', VILLAGE_GAME, 'observer.html'), 'utf-8');
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
let fastTickTimer = null;

function startGameLoop() {
  // Run first tick after a short delay
  nextTickAt = Date.now() + 5000;
  setTimeout(() => tick(), 5000);
  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS);

  // Start fast tick (autopilot for both grid and social games)
  fastTickTimer = setInterval(() => fastTick(), FAST_TICK_MS);
  console.log(`[village] Fast tick started: ${FAST_TICK_MS}ms interval`);
}

// --- Graceful shutdown ---

function shutdown(signal) {
  console.log(`[village] ${signal} received — shutting down`);

  if (tickTimer) clearInterval(tickTimer);
  if (fastTickTimer) clearInterval(fastTickTimer);

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
