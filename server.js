/**
 * Village Orchestrator — generic world runtime.
 *
 * Manages state, tick loop, scene dispatch, action processing, and serves
 * an observer web UI via SSE.
 *
 * World-specific logic lives in the adapter module which exports:
 *   initState(worldConfig)            → world-specific initial state
 *   buildScene(bot, allBots, state, worldConfig) → scene text string
 *   tools                             → { toolName: (bot, params, state) → entry|null }
 *   onJoin?(state, botName, displayName)  → extra event fields (optional)
 *   onLeave?(state, botName, displayName) → extra event fields (optional)
 *
 * Uses Node.js built-ins only.
 */

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, rename, copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { appendFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadWorld } from './world-loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Load world schema ---
const VILLAGE_WORLD = process.env.VILLAGE_WORLD || 'social-village';
const WORLD_DIR = process.env.VILLAGE_WORLD_DIR
  || join(__dirname, 'worlds', VILLAGE_WORLD);
const worldConfig = loadWorld(join(WORLD_DIR, 'schema.json'));
const worldId = worldConfig.raw.id;
console.log(`[village] Loaded world: ${worldId} (${worldConfig.raw.name})`);

// --- Load adapter ---
const adapter = await import(pathToFileURL(join(WORLD_DIR, 'adapter.js')).href);

// --- Config ---
const PORT = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_DAILY_COST_CAP = parseFloat(process.env.VILLAGE_DAILY_COST_CAP || '2'); // $/bot/day
const REMOTE_SCENE_TIMEOUT_MS = 120_000;
const MAX_CONSECUTIVE_FAILURES_REMOTE = 5;
const PORTAL_URL = process.env.VILLAGE_RELAY_URL || 'http://127.0.0.1:3000';
const LOG_CAP = 50;

const TICK_INTERVAL_MS = parseInt(process.env.VILLAGE_TICK_INTERVAL || '120000', 10);
const MEMORY_FILENAME = `${worldId}.md`;
const _dataDir = process.env.VILLAGE_DATA_DIR;
const STATE_FILE = _dataDir ? join(_dataDir, `state-${VILLAGE_WORLD}.json`) : join(__dirname, `state-${VILLAGE_WORLD}.json`);
const LOGS_DIR = _dataDir ? join(_dataDir, 'logs') : join(__dirname, 'logs');

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
    clock: { tick: 0 },
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
  if (!state.bots) state.bots = [];
  if (!state.log) state.log = [];
  if (!state.villageCosts) state.villageCosts = {};
  if (!state.remoteParticipants) state.remoteParticipants = {};
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

  broadcastEvent({
    type: `${worldId}_leave`,
    bot: botName,
    displayName,
    tick: state.clock.tick,
    timestamp: new Date().toISOString(),
    ...extra,
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
    nextTickAt = tickStart + TICK_INTERVAL_MS;

    broadcastEvent({
      type: 'tick_start',
      tick: state.clock.tick,
      timestamp: new Date().toISOString(),
      bots: [...participants.keys()],
      relayTimeoutMs: REMOTE_SCENE_TIMEOUT_MS,
      nextTickAt,
    });

    if (participants.size === 0) {
      await saveState();
      return;
    }

    const allBots = [...participants.entries()].map(([name, p]) => ({
      name, displayName: p.displayName,
    }));

    // Send scene to each bot in parallel
    const botDetails = [];
    const results = await Promise.all(allBots.map(async (bot) => {
      const scene = adapter.buildScene(bot, allBots, state, worldConfig);
      const tools = worldConfig.raw.toolSchemas || [];
      const payload = {
        scene,
        tools,
        systemPrompt: worldConfig.raw.systemPrompt || '',
        allowedReads: worldConfig.raw.allowedReads || [],
        maxActions: worldConfig.raw.maxActions || 2,
        memoryFilename: MEMORY_FILENAME,
      };
      const payloadJson = JSON.stringify(payload);
      const detail = {
        name: bot.name,
        displayName: bot.displayName,
        payloadSize: payloadJson.length,
        toolCount: tools.length,
        payload,
        deliveryMs: 0,
        deliveryStatus: 'ok',
        actions: [],
        error: null,
      };
      const t0 = Date.now();
      const response = await sendSceneRemote(bot.name, worldId, payload);
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

    // Process actions via adapter tool handlers
    const ts = new Date().toISOString();
    for (const { bot, response, detail } of results) {
      if (response._error) continue;
      detail.rawActions = response.actions;
      const processedActions = [];
      for (const action of (response.actions || [])) {
        const handler = adapter.tools?.[action.tool];
        if (!handler) continue;
        const entry = handler(bot, action.params, state);
        if (!entry) continue;
        // Runtime stamps metadata
        entry.bot = bot.name;
        entry.displayName = bot.displayName;
        entry.tick = state.clock.tick;
        entry.timestamp = ts;
        state.log.push(entry);
        broadcastEvent({ type: `${worldId}_${entry.action}`, ...entry });
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
      timestamp: ts,
      bots: botDetails,
    });

    // Cap the log
    if (state.log.length > LOG_CAP) {
      state.log = state.log.slice(-LOG_CAP);
    }

    await saveState();
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

    broadcastEvent({
      type: `${worldId}_join`,
      bot: botName,
      displayName: name,
      tick: state.clock.tick,
      timestamp: new Date().toISOString(),
      ...extra,
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

    // Send initial state — runtime builds generic payload
    const initPayload = {
      type: 'init',
      worldType: worldConfig.isGrid ? 'grid' : 'social',
      tick: state.clock.tick,
      nextTickAt,
      tickIntervalMs: TICK_INTERVAL_MS,
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
      log: state.log.slice(-30),
      tickInProgress,
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
      tickIntervalMs: TICK_INTERVAL_MS,
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

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- Tick loop ---
let tickTimer = null;

function startTickLoop() {
  nextTickAt = Date.now() + 5000;
  setTimeout(() => tick(), 5000);
  tickTimer = setInterval(() => tick(), TICK_INTERVAL_MS);
}

// --- Graceful shutdown ---

function shutdown(signal) {
  console.log(`[village] ${signal} received — shutting down`);

  if (tickTimer) clearInterval(tickTimer);

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

server.listen(PORT, '127.0.0.1', () => {
  startTime = Date.now();
  console.log(`[village] Orchestrator listening on 127.0.0.1:${PORT}`);
  console.log(`[village] Tick interval: ${TICK_INTERVAL_MS / 1000}s`);
  startTickLoop();
});
