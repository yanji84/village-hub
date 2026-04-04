/**
 * Arena routes — competitive poker arena with dynamic player seating.
 *
 * Thin proxy layer to the world server's /api/arena/* endpoints,
 * with cookie-based auth for player sessions.
 *
 * Mount at /api/arena.
 *
 * Dependencies injected by hub.js:
 *   config  — { VILLAGE_SECRET, SERVER_URL }
 *   limiter — express-rate-limit instance
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';

function parseCookies(req) {
  const obj = {};
  for (const pair of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) obj[k] = v.join('=');
  }
  return obj;
}

export function createArenaRouter({ config, limiter }) {
  const { VILLAGE_SECRET, SERVER_URL } = config;
  const router = Router();

  function serverHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (VILLAGE_SECRET) h['Authorization'] = `Bearer ${VILLAGE_SECRET}`;
    return h;
  }

  const claimLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many claim attempts. Try again later.' },
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => req.ip,
    message: { error: 'Too many login attempts. Try again later.' },
  });

  // --- GET /seats ---
  router.get('/seats', async (req, res) => {
    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/seats`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena seats failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /strategy ---
  router.post('/strategy', async (req, res) => {
    const { botName, strategy, customCode } = req.body || {};
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token cookie' });
    if (!botName) return res.status(400).json({ error: 'Missing botName' });
    if (typeof strategy !== 'string' || strategy.trim().length === 0) {
      return res.status(400).json({ error: 'Strategy is required' });
    }
    if (strategy.length > 2000) {
      return res.status(400).json({ error: 'Strategy must be 2000 chars or less' });
    }
    if (customCode && typeof customCode === 'string' && customCode.length > 5000) {
      return res.status(400).json({ error: 'Custom code must be 5000 chars or less' });
    }

    try {
      const payload = { seat: botName, strategy, claimToken: token };
      if (customCode !== undefined) payload.customCode = customCode;
      const resp = await fetch(`${SERVER_URL}/api/arena/strategy`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      res.json({ ok: true });
    } catch (err) {
      console.error(`[hub] arena strategy failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /action ---
  router.post('/action', async (req, res) => {
    const { action, amount, say, thought } = req.body || {};
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token' });

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/action`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify({ action, amount, say, thought, claimToken: token }),
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena action failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /waitlist ---
  router.post('/waitlist', claimLimiter, async (req, res) => {
    const { username, strategy, pin, customCode, playMode } = req.body || {};

    if (!username || typeof username !== 'string' || username.length < 1 || username.length > 20 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username: 1-20 chars, alphanumeric/underscore/hyphen only' });
    }
    if (playMode !== 'human' && (typeof strategy !== 'string' || strategy.trim().length === 0)) {
      return res.status(400).json({ error: 'Strategy is required' });
    }
    if (strategy.length > 2000) {
      return res.status(400).json({ error: 'Strategy must be 2000 chars or less' });
    }
    if (customCode && typeof customCode === 'string' && customCode.length > 5000) {
      return res.status(400).json({ error: 'Custom code must be 5000 chars or less' });
    }
    if (pin && (typeof pin !== 'string' || !/^\d{4}$/.test(pin))) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const token = crypto.randomUUID();

    try {
      const waitlistBody = { username, strategy, token, playMode: playMode || 'bot' };
      if (pin) waitlistBody.pin = pin;
      if (customCode !== undefined) waitlistBody.customCode = customCode;
      const resp = await fetch(`${SERVER_URL}/api/arena/waitlist`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify(waitlistBody),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      res.cookie('arena_token', token, {
        path: '/',
        httpOnly: false,
        sameSite: 'Strict',
        maxAge: 604800 * 1000,
      });

      // Set appropriate cookies based on response
      if (data.botName) {
        // Restored to a seat
        res.cookie('arena_bot', data.botName, {
          path: '/',
          httpOnly: false,
          sameSite: 'Strict',
          maxAge: 604800 * 1000,
        });
      } else {
        res.cookie('arena_waitlist_user', username, {
          path: '/',
          httpOnly: false,
          sameSite: 'Strict',
          maxAge: 604800 * 1000,
        });
      }

      res.json({ ok: true, position: data.position, restored: data.restored || false, botName: data.botName || null });
    } catch (err) {
      console.error(`[hub] arena waitlist join failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /my-cards (returns only the requesting player's hole cards) ---
  router.get('/my-cards', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.arena_token;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/my-cards?token=${encodeURIComponent(token)}`, {
        headers: serverHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /waitlist ---
  router.get('/waitlist', async (req, res) => {
    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/waitlist`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena waitlist get failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /leave-waitlist ---
  router.post('/leave-waitlist', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token cookie' });

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/leave-waitlist`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      res.clearCookie('arena_token', { path: '/' });
      res.clearCookie('arena_waitlist_user', { path: '/' });

      res.json({ ok: true });
    } catch (err) {
      console.error(`[hub] arena leave-waitlist failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /leave-seat ---
  router.post('/leave-seat', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token cookie' });

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/leave-seat`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      res.clearCookie('arena_token', { path: '/' });
      res.clearCookie('arena_waitlist_user', { path: '/' });

      res.json({ ok: true });
    } catch (err) {
      console.error(`[hub] arena leave-seat failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- POST /login ---
  router.post('/login', loginLimiter, async (req, res) => {
    const { username, pin } = req.body || {};

    if (!username || typeof username !== 'string' || username.length < 1 || username.length > 20 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Invalid username: 1-20 chars, alphanumeric/underscore/hyphen only' });
    }
    if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const token = crypto.randomUUID();

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/login`, {
        method: 'POST',
        headers: serverHeaders(),
        body: JSON.stringify({ username, pin, token }),
        signal: AbortSignal.timeout(10_000),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      // Set arena_token cookie
      res.cookie('arena_token', token, {
        path: '/',
        httpOnly: false,
        sameSite: 'Strict',
        maxAge: 604800 * 1000,
      });

      if (data.seated && data.botName) {
        res.cookie('arena_bot', data.botName, {
          path: '/',
          httpOnly: false,
          sameSite: 'Strict',
          maxAge: 604800 * 1000,
        });
      } else if (data.queued) {
        res.cookie('arena_waitlist_user', username, {
          path: '/',
          httpOnly: false,
          sameSite: 'Strict',
          maxAge: 604800 * 1000,
        });
      }

      res.json(data);
    } catch (err) {
      console.error(`[hub] arena login failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /player-stats/me --- (must be before /player-stats to avoid route shadowing)
  router.get('/player-stats/me', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token cookie' });

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/player-stats/me?token=${encodeURIComponent(token)}`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena player-stats/me failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /player-stats ---
  router.get('/player-stats', async (req, res) => {
    try {
      const username = req.query.username || '';
      const qs = username ? `?username=${encodeURIComponent(username)}` : '';
      const resp = await fetch(`${SERVER_URL}/api/arena/player-stats${qs}`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena player-stats failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /leaderboard ---
  router.get('/leaderboard', async (req, res) => {
    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/leaderboard`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena leaderboard failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /hand-history ---
  router.get('/hand-history', async (req, res) => {
    try {
      const limit = req.query.limit || '20';
      const offset = req.query.offset || '0';
      const resp = await fetch(`${SERVER_URL}/api/arena/hand-history?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena hand-history failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /my-records ---
  router.get('/my-records', async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies.arena_token;

    if (!token) return res.status(401).json({ error: 'No arena token cookie' });

    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/my-records?token=${encodeURIComponent(token)}`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena my-records failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  // --- GET /hand/:handNumber ---
  router.get('/hand/:handNumber', async (req, res) => {
    const handNumber = req.params.handNumber;
    try {
      const resp = await fetch(`${SERVER_URL}/api/arena/hand/${encodeURIComponent(handNumber)}`, {
        headers: VILLAGE_SECRET ? { 'Authorization': `Bearer ${VILLAGE_SECRET}` } : {},
        signal: AbortSignal.timeout(10_000),
      });
      res.status(resp.status).json(await resp.json());
    } catch (err) {
      console.error(`[hub] arena hand/${handNumber} failed: ${err.message}`);
      res.status(502).json({ error: 'World server unreachable' });
    }
  });

  return router;
}
