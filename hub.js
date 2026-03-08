/**
 * Village Hub — standalone entry point.
 *
 * Thin orchestrator: wires together the relay transport, token manager,
 * route handlers, and game server process manager.
 *
 * Listens on 0.0.0.0:8080. Game server runs on 127.0.0.1:7001 internally.
 *
 * Required env vars:
 *   VILLAGE_SECRET   — shared secret between hub and game server
 *   VILLAGE_GAME     — game id (default: social-village)
 *
 * Optional env vars:
 *   VILLAGE_HUB_PORT       — hub listen port (default: 8080)
 *   VILLAGE_PORT           — game server port (default: 7001)
 *   VILLAGE_HUB_URL        — public URL for invite scripts (default: http://localhost:8080)
 *   VILLAGE_DATA_DIR       — data directory for tokens/state/logs (default: ./data)
 *   VILLAGE_API_ROUTER_URL — NPC LLM backend (default: unset, NPCs disabled)
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

import * as tokenManager from './lib/token-manager.js';
import { RelayTransport }   from './lib/relay-transport.js';
import { ProcessManager }   from './lib/process-manager.js';
import { createProtocolRouter }   from './routes/protocol.js';
import { createGameProxyRouter }  from './routes/game-proxy.js';
import { createOperatorRouters }  from './routes/operator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const HUB_PORT       = parseInt(process.env.VILLAGE_HUB_PORT || '8080', 10);
const GAME_PORT      = parseInt(process.env.VILLAGE_PORT || '7001', 10);
const GAME_URL       = `http://127.0.0.1:${GAME_PORT}`;  // internal only
const VILLAGE_SECRET = process.env.VILLAGE_SECRET || '';
const VILLAGE_HUB_URL = process.env.VILLAGE_HUB_URL || `http://localhost:${HUB_PORT}`;
const DATA_DIR       = process.env.VILLAGE_DATA_DIR || join(__dirname, 'data');

const RELAY_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS  = 120_000;

// Transport config pushed to plugins via hello/heartbeat/join responses
const remoteConfig = {
  pollTimeoutMs: POLL_TIMEOUT_MS + 5_000,
  backoffMs: 5_000,
};

const config = {
  VILLAGE_SECRET,
  VILLAGE_HUB_URL,
  GAME_URL,
  RELAY_TIMEOUT_MS,
  POLL_TIMEOUT_MS,
  remoteConfig,
};

// --- Core components ---
const transport = new RelayTransport();
const botHealth  = new Map();  // botName → { ...heartbeat, receivedAt }

const processManager = new ProcessManager('server.js', {
  cwd: __dirname,
  env: {
    ...process.env,
    VILLAGE_PORT:      String(GAME_PORT),
    VILLAGE_RELAY_URL: `http://127.0.0.1:${HUB_PORT}`,
  },
});

// --- Rate limiter (shared across all bot-facing endpoints) ---
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.ip,
  message: { error: 'Too many requests. Try again later.' },
});

// --- Assemble Express app ---
const app = express();
app.use(express.json());

const routeDeps = { transport, tokenManager, botHealth, processManager, config, limiter };

app.use('/api/village', createProtocolRouter(routeDeps));
app.use('/api/village', createGameProxyRouter(routeDeps));

const { villageRouter, hubRouter } = createOperatorRouters(routeDeps);
app.use('/api/village', villageRouter);
app.use('/api/hub',     hubRouter);

// --- Prune stale botHealth entries (bots not seen in >1h) ---
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [name, h] of botHealth) {
    if (h.receivedAt < cutoff) botHealth.delete(name);
  }
}, 15 * 60_000);

// --- Start ---
async function main() {
  if (!VILLAGE_SECRET) {
    console.error('[hub] ERROR: VILLAGE_SECRET is required');
    process.exit(1);
  }

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(join(DATA_DIR, 'logs'), { recursive: true });

  const server = createServer(app);
  server.listen(HUB_PORT, '0.0.0.0', () => {
    console.log(`[hub] Listening on 0.0.0.0:${HUB_PORT}`);
    console.log(`[hub] Hub URL: ${VILLAGE_HUB_URL}`);
    console.log(`[hub] Data dir: ${DATA_DIR}`);
    if (!process.env.VILLAGE_NO_SPAWN) processManager.start();
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      console.log(`[hub] ${sig} received, shutting down`);
      processManager.stop();
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[hub] Fatal:', err);
  process.exit(1);
});
