/**
 * Village Orchestrator — the "game master" for the bot social village.
 *
 * Maintains world state, runs a tick-based game loop, sends scene prompts
 * to bots via the portal relay proxy, routes responses, writes village
 * memories, and serves an observer web UI via SSE.
 *
 * Uses Node.js built-ins only.
 *
 * Game content is loaded from a JSON schema file via game-loader.js.
 * Set VILLAGE_GAME env var to select a game (default: social-village).
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGame } from './game-loader.js';
import { readBotDailyCost as readBotDailyCostImpl } from './games/social-village/logic.js'; // TODO: move to lib/

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load game schema ---
const VILLAGE_GAME = process.env.VILLAGE_GAME || 'social-village';
const gameConfig = loadGame(join(__dirname, 'games', VILLAGE_GAME, 'schema.json'));
console.log(`[village] Loaded game: ${gameConfig.raw.id} (${gameConfig.raw.name})`);

// --- Load game adapter ---
const gameAdapter = await import(`./games/${VILLAGE_GAME}/adapter.js`);

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const TICKS_PER_PHASE = parseInt(process.env.VILLAGE_TICKS_PER_PHASE || '4', 10);
const SCENE_HISTORY_CAP = parseInt(process.env.VILLAGE_SCENE_HISTORY_CAP || '10', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const MAX_PUBLIC_LOG_DEPTH = parseInt(process.env.VILLAGE_MAX_LOG_DEPTH || '20', 10);
const REMOTE_SCENE_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES_REMOTE = 5;
const PORTAL_URL = process.env.VILLAGE_RELAY_URL || 'http://127.0.0.1:3000';
const EMPTY_CLEAR_TICKS = 3;

const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || (gameAdapter.hasFastTick ? '45000' : '120000'), 10);
const _dataDir = process.env.VILLAGE_DATA_DIR;
const STATE_FILE = _dataDir ? join(_dataDir, `state-${VILLAGE_GAME}.json`) : join(__dirname, `state-${VILLAGE_GAME}.json`);
const MEMORY_FILENAME = gameAdapter.memoryFilename;
const USAGE_FILE = process.env.VILLAGE_USAGE_FILE || null;
const LOGS_DIR = _dataDir ? join(_dataDir, 'logs') : join(__dirname, 'logs');

// --- Event log file (JSONL, one file per day) ---
let logDate = '';   // 'YYYY-MM-DD'
let logFile = '';   // full path to current day's .jsonl

// Async log buffer — batches writes within a 100ms window to avoid
// blocking the event loop with a sync write on every game event.
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
  // Called on graceful shutdown to ensure no events are lost.
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
const participants = new Map(); // botName → { displayName, appearance? }
const failureCounts = new Map(); // botName → consecutive failure count
const lastMoveTick = new Map();  // botName → tick number of last move (cooldown)

// --- Load/Save state ---

async function loadState() {
  // Try primary state file
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    state = gameAdapter.loadState(JSON.parse(raw), gameConfig);
    return;
  } catch { /* primary failed or missing */ }

  // Fallback to backup
  try {
    const bakRaw = await readFile(STATE_FILE + '.bak', 'utf-8');
    state = gameAdapter.loadState(JSON.parse(bakRaw), gameConfig);
    console.warn('[village] Primary state was corrupt/missing — recovered from backup');
    return;
  } catch { /* backup also failed */ }

  // Initialize fresh state
  state = await gameAdapter.initState(gameConfig);
  console.log('[village] Fresh state initialized');
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
  if (state.remoteParticipants?.[botName]) delete state.remoteParticipants[botName];
  gameAdapter.removeBot(state, botName, displayName, broadcastEvent);
  console.log(`[village] ${botName} removed (${reason})`);
}

// --- Startup recovery: rebuild participants from state.json ---

async function recoverParticipants() {
  const toRemove = await gameAdapter.recoverParticipants(state, participants, gameConfig);
  for (const botName of (toRemove || [])) removeBot(botName, 'recovery: not in remoteParticipants');
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
    // Day rolled over — flush any buffered lines for the old file first
    if (_logBuffer.length) _flushLogBuffer();
    logDate = today;
    logFile = join(LOGS_DIR, `${today}.jsonl`);
  }
  _logBuffer.push(JSON.stringify({ ...event, _ts: new Date().toISOString() }) + '\n');
  if (!_logFlushTimer) _logFlushTimer = setTimeout(_flushLogBuffer, 100);
}

// --- Advance clock ---

function advanceClock() {
  gameAdapter.advanceClock(state, gameConfig, TICKS_PER_PHASE);
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

// --- Fast tick (autopilot, grid games only) ---

function fastTick() {
  if (tickInProgress) return;
  if (gameAdapter.fastTick) {
    gameAdapter.fastTick(buildTickContext(Date.now()));
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
    nextTickAt = tickStart + TICK_INTERVAL_MS;
    broadcastEvent({
      type: 'tick_start',
      tick: state.clock.tick,
      phase: state.clock.phase,
      timestamp: new Date().toISOString(),
      bots: [...participants.keys()],
      relayTimeoutMs: REMOTE_SCENE_TIMEOUT_MS,
      nextTickAt,
    });
    const ctx = buildTickContext(tickStart);
    await gameAdapter.tick(ctx);
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

    // Place bot in the game world via adapter
    const { events, appearance } = await gameAdapter.joinBot(state, botName, name, gameConfig);

    participants.set(botName, { displayName: name, appearance });
    failureCounts.delete(botName);

    // Persist for recovery across server restarts
    if (!state.remoteParticipants) state.remoteParticipants = {};
    state.remoteParticipants[botName] = { displayName: name, joinedAt: new Date().toISOString() };

    // Broadcast join events from adapter
    for (const ev of (events || [])) broadcastEvent(ev);

    await saveState();
    console.log(`[village] ${botName} joined (remote, display: ${name})`);

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
    } else if (state.remoteParticipants?.[botName]) {
      // Bot not in participants but still in persisted state — clean up
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
    const inGame = participants.has(queryBot);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      inGame,
      game: inGame ? { id: gameConfig.raw.id, name: gameConfig.raw.name } : null,
      failureCount: failureCounts.get(queryBot) || 0,
    }));
    return;
  }

  // --- Agenda endpoint (get/set bot agenda via owner DM) ---

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
      let loc = null;
      for (const [l, bots] of Object.entries(state.locations)) {
        if ((bots || []).includes(botName)) { loc = l; break; }
      }
      const locName = loc ? (gameConfig.locationNames[loc] || state.customLocations?.[loc]?.name || loc) : null;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ botName, agenda, location: loc, locationName: locName }));
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

    // Send initial state (include tickInProgress so late-joining clients know)
    const initPayload = gameAdapter.buildSSEInitPayload(state, participants, gameConfig, { nextTickAt, tickIntervalMs: TICK_INTERVAL_MS });
    initPayload.tickInProgress = tickInProgress;
    if (tickInProgress) {
      initPayload.tickStartBots = [...participants.keys()];
      initPayload.relayTimeoutMs = REMOTE_SCENE_TIMEOUT_MS;
      initPayload.nextTickAt = nextTickAt;
    }
    res.write(`data: ${JSON.stringify(initPayload)}\n\n`);

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
            if (!gameAdapter.isEventForGame(ev)) continue;
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
      let html = await readFile(join(__dirname, 'games', VILLAGE_GAME, 'observer.html'), 'utf-8');
      // Inline ES modules for browser compatibility.
      // Each module is wrapped in an IIFE for proper scope isolation,
      // with exports returned and destructured using the import-side names.
      const assetsDir = join(__dirname, 'games', VILLAGE_GAME, 'assets');
      html = html.replace('<script type="module">', '<script>');
      // Two-pass inlining: first collect all modules, then emit them.
      // Each module is wrapped in an IIFE for scope isolation.
      // A module-level var (_mod_<name>) stores the full export object so
      // inter-module imports can resolve against it.
      const moduleResults = {}; // filename → varName (e.g. "observer-utils.js" → "_mod_observer_utils")
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

          // Parse the import specifiers from observer.html
          const specifiers = parseSpecifiers(imports);

          // Collect all exported names from the module source
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

          // Strip export keywords
          code = code.replace(/^export\s+(async\s+function|function|const|let|var|class)\s/gm, '$1 ');
          code = code.replace(/^export\s+\{[^}]*\};\s*$/gm, '');

          // Resolve inter-module imports: import { x } from './other.js' →
          // var { x } = _mod_other_js;  (inside the IIFE)
          code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+'\.\/([^']+)';\s*$/gm, (m, specs, depFile) => {
            const depVar = moduleResults[depFile];
            if (!depVar) return `/* unresolved import: ${depFile} */`;
            const depSpecs = parseSpecifiers(specs);
            const destructure = depSpecs.map(s =>
              s.imported === s.local ? s.local : `${s.imported}: ${s.local}`
            ).join(', ');
            return `var { ${destructure} } = ${depVar};`;
          });

          // Build return object and destructuring
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
      // Warn about renamed imports (import { x as y }) — easy source of bugs
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
    try {
      const html = await readFile(join(__dirname, 'games', VILLAGE_GAME, 'dev-console.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // Dev transport events — proxy pushes relay/poll/respond events here for SSE broadcast
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

  // Dev recent ticks — serve ring buffer of recent tick_detail events for bootstrap
  if (path === '/api/dev/recent-ticks') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ticks: recentTickDetails }));
    return;
  }

  // Dev hub status — proxy to portal's hub-status endpoint
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

  // Dev server meta — expose server internals for dev console
  if (path === '/api/dev/server-meta') {
    const failures = {};
    for (const [name, count] of failureCounts) failures[name] = count;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      uptime: Math.round((Date.now() - startTime) / 1000),
      tick: state.clock.tick,
      phase: state.clock.phase,
      tickIntervalMs: TICK_INTERVAL_MS,
      relayTimeoutMs: REMOTE_SCENE_TIMEOUT_MS,
      maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES_REMOTE,
      dailyCostCap: VILLAGE_DAILY_COST_CAP,
      game: { id: gameConfig.raw.id, name: gameConfig.raw.name, version: gameConfig.raw.version },
      observers: observers.size,
      participants: participants.size,
      failureCounts: failures,
      villageCosts: state.villageCosts || {},
    }));
    return;
  }

  // Dev health proxy — fetch bot health from portal proxy
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

  // Serve game assets (images, etc.)
  if (path.startsWith('/assets/')) {
    const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.js': 'text/javascript' };
    const safeName = path.slice('/assets/'.length).replace(/\.\./g, '');
    const ext = safeName.slice(safeName.lastIndexOf('.'));
    const filePath = join(__dirname, 'games', VILLAGE_GAME, 'assets', safeName);
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

  // Fast tick only for games that support it (e.g. survival)
  if (gameAdapter.hasFastTick) {
    const fastTickMs = gameConfig.raw.autopilot?.fastTickMs || 1000;
    fastTickTimer = setInterval(() => fastTick(), fastTickMs);
    console.log(`[village] Fast tick started: ${fastTickMs}ms interval`);
  }
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

    // Flush any buffered log lines before saving state
    flushLogBufferSync();

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
if (gameAdapter.initNPCsForGame) gameAdapter.initNPCsForGame(state, participants, gameConfig);
if (gameAdapter.probeAPIRouterForGame) gameAdapter.probeAPIRouterForGame();

server.listen(PORT, '127.0.0.1', () => {
  startTime = Date.now();
  console.log(`[village] Orchestrator listening on 127.0.0.1:${PORT}`);
  console.log(`[village] Tick interval: ${TICK_INTERVAL_MS / 1000}s, ticks/phase: ${TICKS_PER_PHASE}`);
  startGameLoop();
});
