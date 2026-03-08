/**
 * Protocol routes — the core relay/poll/respond transport plus heartbeat
 * and health endpoints.
 *
 * Mount at /api/village.
 *
 * Dependencies injected by hub.js:
 *   transport    — RelayTransport instance
 *   tokenManager — lib/token-manager.js
 *   botHealth    — Map<botName, heartbeat+receivedAt>  (shared with operator routes)
 *   config       — { VILLAGE_SECRET, RELAY_TIMEOUT_MS, POLL_TIMEOUT_MS, remoteConfig }
 *   limiter      — express-rate-limit instance (shared across bot-facing endpoints)
 */

import { Router } from 'express';
import { safeEqual, validateToken } from '../lib/auth.js';

export function createProtocolRouter({ transport, tokenManager, botHealth, config, limiter }) {
  const { VILLAGE_SECRET, RELAY_TIMEOUT_MS, POLL_TIMEOUT_MS, remoteConfig } = config;
  const router = Router();

  // --- POST /relay — game server delivers a scene ---
  // Auth: VILLAGE_SECRET (internal, not bot-facing)
  router.post('/relay', async (req, res) => {
    const auth = req.headers.authorization || '';
    if (!VILLAGE_SECRET || !safeEqual(auth, `Bearer ${VILLAGE_SECRET}`)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { botName, conversationId, scene } = req.body || {};
    if (!botName || !conversationId || !scene) {
      return res.status(400).json({ error: 'Missing botName, conversationId, or scene' });
    }

    // Strip botName from the payload delivered to the bot
    const { botName: _bn, ...payload } = req.body;
    const result = await transport.relay(botName, payload, RELAY_TIMEOUT_MS);
    result ? res.json(result) : res.status(504).json({ error: 'Remote bot timeout' });
  });

  // --- GET /poll/:botName — bot long-polls for next scene ---
  // Returns 410 (not 401) for missing/revoked tokens so the plugin can
  // distinguish "kicked" (clean exit) from transient auth errors.
  router.get('/poll/:botName', limiter, async (req, res) => {
    const auth = await validateToken(req, tokenManager);
    if (!auth) return res.status(410).json({ error: 'Token revoked or not found' });

    const { botName } = req.params;
    if (auth.botName !== botName) return res.status(403).json({ error: 'Token does not match bot name' });

    const { promise, cancel } = transport.poll(botName, POLL_TIMEOUT_MS);
    req.on('close', cancel);

    const result = await promise;
    if (res.headersSent) return;
    result ? res.json(result) : res.status(204).end();
  });

  // --- POST /respond — bot submits actions ---
  // Auth: vtk_ token (botName comes from token, not URL)
  // requestId in body is an optional sanity check against stale responses.
  router.post('/respond', limiter, async (req, res) => {
    const auth = await validateToken(req, tokenManager);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });

    const { requestId, actions, usage } = req.body || {};
    const result = transport.respond(auth.botName, requestId, actions, usage);

    if (!result.ok) {
      if (result.error === 'not_found')      return res.status(404).json({ error: 'No pending request for this bot' });
      if (result.error === 'stale_request') return res.status(409).json({ error: 'Response is for a stale request' });
    }
    res.json({ ok: true });
  });

  // --- POST /heartbeat — bot health metrics + startup handshake ---
  //
  // If isHello:true is present in the body, duplicate detection is applied:
  // if another instance sent a heartbeat within the last 5 minutes, the new
  // instance is told to stand down ({ duplicate: true }) without updating botHealth.
  //
  // Always returns { ok, botName, config } so the plugin can apply remote config
  // and optionally use botName for self-identification.
  router.post('/heartbeat', limiter, async (req, res) => {
    const auth = await validateToken(req, tokenManager);
    if (!auth) return res.status(401).json({ error: 'Unauthorized' });

    const raw = req.body || {};

    // Startup handshake: duplicate detection
    if (raw.isHello) {
      const existing = botHealth.get(auth.botName);
      if (existing && (Date.now() - existing.receivedAt) < 5 * 60_000) {
        const agoS = Math.round((Date.now() - existing.receivedAt) / 1000);
        console.warn(
          `[hub] duplicate hello from ${auth.botName} ` +
          `(existing instance heartbeat ${agoS}s ago) — standing down new instance`
        );
        return res.json({ ok: true, botName: auth.botName, duplicate: true });
      }
      console.log(`[hub] hello from ${auth.botName}`);
    }

    botHealth.set(auth.botName, {
      botName:         auth.botName,
      displayName:     auth.displayName,
      version:         raw.version,
      uptimeMs:        raw.uptimeMs,
      joined:          raw.joined,
      scenesProcessed: raw.scenesProcessed,
      scenesFailed:    raw.scenesFailed,
      avgSceneMs:      raw.avgSceneMs,
      lastSceneAt:     raw.lastSceneAt,
      pollErrors:      raw.pollErrors,
      receivedAt:      Date.now(),
    });

    if (!raw.isHello) {
      console.log(
        `[hub] heartbeat from ${auth.botName} ` +
        `(v${raw.version || '?'}, scenes=${raw.scenesProcessed || 0}, ` +
        `joined=${raw.joined}, uptime=${Math.round((raw.uptimeMs || 0) / 1000)}s)`
      );
    }

    res.json({ ok: true, botName: auth.botName, config: remoteConfig });
  });

  // --- GET /health/:botName — individual bot health ---
  // Auth: own vtk_ token OR operator secret
  router.get('/health/:botName', async (req, res) => {
    const auth = await validateToken(req, tokenManager);
    const bearerToken = (req.headers.authorization || '').slice(7);
    const isOperator  = VILLAGE_SECRET && safeEqual(bearerToken, VILLAGE_SECRET);

    if (!auth && !isOperator) return res.status(401).json({ error: 'Unauthorized' });
    if (auth && auth.botName !== req.params.botName && !isOperator) {
      return res.status(403).json({ error: 'Token does not match bot name' });
    }

    const health = botHealth.get(req.params.botName);
    if (!health) return res.json({ ok: true, status: 'no_data', message: 'No heartbeat received yet' });

    const ageMs = Date.now() - health.receivedAt;
    res.json({ ok: true, status: ageMs > 10 * 60_000 ? 'stale' : 'healthy', lastHeartbeat: health, ageMs });
  });

  // --- GET /health — all bots summary (operator only) ---
  router.get('/health', async (req, res) => {
    const bearerToken = (req.headers.authorization || '').slice(7);
    if (!VILLAGE_SECRET || !safeEqual(bearerToken, VILLAGE_SECRET)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const summary = {};
    for (const [botName, health] of botHealth) {
      const ageMs = Date.now() - health.receivedAt;
      const { botName: _, displayName: __, receivedAt: ___, ...rest } = health;
      summary[botName] = { status: ageMs > 10 * 60_000 ? 'stale' : 'healthy', ...rest, ageMs };
    }
    res.json({ ok: true, bots: summary });
  });

  return router;
}
