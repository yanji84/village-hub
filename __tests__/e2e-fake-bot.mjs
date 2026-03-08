#!/usr/bin/env node
/**
 * E2E smoke test — fake remote bot exercises every hub protocol flow.
 *
 * Requires a live village hub (hub.js) to be running.
 * The hub does NOT need a real game server — set VILLAGE_NO_SPAWN=1 and
 * point VILLAGE_PORT at a minimal mock or leave the game server running.
 *
 * Usage:
 *   node village/__tests__/e2e-fake-bot.mjs <vtk_token>
 *
 * Environment overrides:
 *   HUB_URL            — hub base URL (default: http://127.0.0.1:8080)
 *   VILLAGE_SECRET_FILE — path to .env file to read VILLAGE_SECRET from
 *                         (default: village/.env relative to this script)
 *   VILLAGE_DATA_DIR   — data dir containing village-tokens.json
 *                         (default: inferred from HUB_URL host or hub.js default)
 *
 * Tests:
 *   1.  Heartbeat handshake (isHello)
 *   2.  Join
 *   3.  Regular heartbeat
 *   4.  Health check
 *   5.  Poll — relay→waiter path (bot polling when scene arrives)
 *   6.  Poll — relay→queue path (scene arrives before bot polls)
 *   7.  Duplicate poll (second poll disconnects first)
 *   8.  Leave
 *   9.  Heartbeat after leave
 *  10.  Rejoin after leave
 *  11.  Kick (token revoke → 410 on next poll)
 *  12.  Error: bad token → 401
 *  13.  Error: poll with wrong botName → 403
 *  14.  Error: respond with no pending relay → 404
 *  15.  Error: respond with stale requestId → 409
 *  16.  Cleanup: final leave
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const HUB    = process.env.HUB_URL || 'http://127.0.0.1:8080';
const TOKEN  = process.argv[2];

if (!TOKEN || !TOKEN.startsWith('vtk_')) {
  console.error('Usage: node e2e-fake-bot.mjs <vtk_token>');
  console.error('       HUB_URL=http://host:port node e2e-fake-bot.mjs <vtk_token>');
  process.exit(1);
}

// Read VILLAGE_SECRET from env file
async function getVillageSecret() {
  const candidates = [
    process.env.VILLAGE_SECRET_FILE,
    join(__dirname, '..', '.env'),
    join(__dirname, '..', '..', 'village', '.env'),
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      const raw = await readFile(p, 'utf8');
      const m = raw.match(/^VILLAGE_SECRET=(.+)$/m);
      if (m) return m[1].trim();
    } catch { /* try next */ }
  }

  if (process.env.VILLAGE_SECRET) return process.env.VILLAGE_SECRET;
  return null;
}

// Resolve tokens file path for kick-test cleanup
async function getTokensFilePath() {
  if (process.env.VILLAGE_DATA_DIR) {
    return join(process.env.VILLAGE_DATA_DIR, 'village-tokens.json');
  }
  return join(__dirname, '..', 'data', 'village-tokens.json');
}

// --- Test helpers ---
let passed = 0;
let failed = 0;

function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function req(method, path, body, token) {
  const opts = { method, headers: auth(token), signal: AbortSignal.timeout(12_000) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(`${HUB}${path}`, opts);
  let data;
  try { data = await resp.json(); } catch { data = null; }
  return { status: resp.status, data };
}

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function baseHb() {
  return { version: '0.0.0-e2e', uptimeMs: 1000, joined: false, scenesProcessed: 0, scenesFailed: 0, pollErrors: 0 };
}

// --- Derive bot name from token via heartbeat ---
async function getBotName() {
  const { data } = await req('POST', '/api/village/heartbeat', { ...baseHb(), isHello: true });
  return data?.botName;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const secret = await getVillageSecret();
  if (!secret) {
    console.error('Cannot find VILLAGE_SECRET. Set VILLAGE_SECRET env var or point VILLAGE_SECRET_FILE at a .env file.');
    process.exit(1);
  }

  const BOT = await getBotName();
  if (!BOT) {
    console.error('Could not resolve bot name from token — is the hub running?');
    process.exit(1);
  }
  console.log(`\nBot: ${BOT}   Hub: ${HUB}`);

  // Best-effort cleanup from prior run
  await req('POST', '/api/village/leave', {}).catch(() => {});

  // ─── 1. Heartbeat handshake (isHello) ─────────────────────────────────────
  console.log('\n=== 1. Heartbeat handshake (isHello) ===');
  {
    const { status, data } = await req('POST', '/api/village/heartbeat', { ...baseHb(), isHello: true });
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.config?.pollTimeoutMs > 0, `config returned`);
  }

  // ─── 2. Join ──────────────────────────────────────────────────────────────
  console.log('\n=== 2. Join ===');
  {
    const { status, data } = await req('POST', '/api/village/join', {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.config?.pollTimeoutMs > 0, `config.pollTimeoutMs present`);
  }

  // ─── 3. Regular heartbeat ─────────────────────────────────────────────────
  console.log('\n=== 3. Regular heartbeat ===');
  {
    const hb = { version: '0.0.0-e2e', uptimeMs: 12345, joined: true, scenesProcessed: 0, scenesFailed: 0, pollErrors: 0 };
    const { status, data } = await req('POST', '/api/village/heartbeat', hb);
    assert(status === 200, `heartbeat status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.botName === BOT, `botName returned`);
    assert(data?.config?.pollTimeoutMs > 0, `config returned`);
  }

  // ─── 4. Health check ──────────────────────────────────────────────────────
  console.log('\n=== 4. Health check ===');
  {
    const { status: hs, data: hd } = await req('GET', `/api/village/health/${BOT}`);
    assert(hs === 200, `health status 200`);
    assert(hd?.status === 'healthy', `health status=healthy (got ${hd?.status})`);
    assert(hd?.lastHeartbeat?.version === '0.0.0-e2e', `version stored`);
  }

  // ─── 5. Poll — relay→waiter path ──────────────────────────────────────────
  console.log('\n=== 5. Poll — relay→waiter path ===');
  {
    // Drain any queued scenes from real ticks
    let drained = 0;
    for (let i = 0; i < 5; i++) {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 1200);
      try {
        const r = await fetch(`${HUB}/api/village/poll/${BOT}`, { headers: auth(), signal: ctrl.signal });
        if (r.status === 200) {
          const d = await r.json();
          await req('POST', '/api/village/respond', { requestId: d.requestId, actions: [{ tool: 'village_observe', params: {} }] });
          drained++;
        } else break;
      } catch { break; }
    }
    if (drained > 0) console.log(`  (drained ${drained} queued scene(s))`);

    // Start long-poll (waiter)
    const pollPromise = fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(15_000),
    });
    await new Promise(r => setTimeout(r, 250));

    // Send relay
    const relayPromise = fetch(`${HUB}/api/village/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ botName: BOT, conversationId: `survival:${BOT}`, v: 2, scene: 'E2E waiter test', tools: [], systemPrompt: null, allowedReads: [], maxActions: 1 }),
      signal: AbortSignal.timeout(15_000),
    });

    const pollResp = await pollPromise;
    assert(pollResp.status === 200, `poll got scene (status ${pollResp.status})`);
    const scene = await pollResp.json();
    assert(!!scene.requestId, `has requestId`);
    assert(scene.v === 2, `v2 payload`);
    assert(scene.scene?.includes('E2E waiter test'), `scene text delivered`);

    // Respond: requestId now in body
    const { status: rs, data: rd } = await req('POST', '/api/village/respond',
      { requestId: scene.requestId, actions: [{ tool: 'village_observe', params: {} }] });
    assert(rs === 200, `respond 200 (got ${rs})`);
    assert(rd?.ok === true, `respond ok=true`);

    const relayResp = await relayPromise;
    const relayData = await relayResp.json();
    assert(relayData?.actions?.[0]?.tool === 'village_observe', `relay got actions`);
  }

  // ─── 6. Poll — relay→queue path ───────────────────────────────────────────
  console.log('\n=== 6. Poll — relay→queue path ===');
  {
    const relayPromise = fetch(`${HUB}/api/village/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ botName: BOT, conversationId: `survival:${BOT}`, v: 2, scene: 'E2E queue test', tools: [], systemPrompt: null, allowedReads: [], maxActions: 1 }),
      signal: AbortSignal.timeout(15_000),
    });
    await new Promise(r => setTimeout(r, 150));

    const t0 = Date.now();
    const pollResp = await fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(5_000),
    });
    const elapsed = Date.now() - t0;
    assert(pollResp.status === 200, `poll got queued scene (status ${pollResp.status})`);
    assert(elapsed < 1000, `returned quickly (${elapsed}ms) — not long-polled`);
    const scene = await pollResp.json();
    assert(scene.scene?.includes('E2E queue test'), `correct queued scene delivered`);

    await req('POST', '/api/village/respond',
      { requestId: scene.requestId, actions: [{ tool: 'village_observe', params: {} }] });
    await relayPromise;
  }

  // ─── 7. Duplicate poll ────────────────────────────────────────────────────
  console.log('\n=== 7. Duplicate poll ===');
  {
    const poll1 = fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(10_000),
    });
    await new Promise(r => setTimeout(r, 200));

    const poll2 = fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(10_000),
    });
    await new Promise(r => setTimeout(r, 200));

    const relayPromise = fetch(`${HUB}/api/village/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ botName: BOT, conversationId: `survival:${BOT}`, v: 2, scene: 'Dup poll scene', tools: [], systemPrompt: null, allowedReads: [], maxActions: 1 }),
      signal: AbortSignal.timeout(15_000),
    });

    const p2Resp = await poll2;
    assert(p2Resp.status === 200, `poll2 got scene (status ${p2Resp.status})`);
    const scene2 = await p2Resp.json();
    assert(scene2.scene?.includes('Dup poll scene'), `poll2 got correct scene`);

    const p1Resp = await poll1;
    assert([200, 204].includes(p1Resp.status), `poll1 resolved (status ${p1Resp.status})`);

    await req('POST', '/api/village/respond',
      { requestId: scene2.requestId, actions: [{ tool: 'village_observe', params: {} }] });
    await relayPromise;
  }

  // ─── 8. Leave ─────────────────────────────────────────────────────────────
  console.log('\n=== 8. Leave ===');
  {
    const { status, data } = await req('POST', '/api/village/leave', {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
  }

  // ─── 9. Heartbeat after leave ─────────────────────────────────────────────
  console.log('\n=== 9. Heartbeat after leave ===');
  {
    const { status, data } = await req('POST', '/api/village/heartbeat',
      { ...baseHb(), joined: false });
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
  }

  // ─── 10. Rejoin ───────────────────────────────────────────────────────────
  console.log('\n=== 10. Rejoin after leave ===');
  {
    const { status, data } = await req('POST', '/api/village/join', {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
  }

  // ─── 11. Kick ─────────────────────────────────────────────────────────────
  console.log('\n=== 11. Kick (token revoke → 410 on next poll) ===');
  {
    const kickResp = await fetch(`${HUB}/api/village/kick/${BOT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ reason: 'E2E test kick' }),
      signal: AbortSignal.timeout(5_000),
    });
    const kickData = await kickResp.json();
    assert(kickResp.status === 200, `kick status 200 (got ${kickResp.status})`);
    assert(kickData?.ok === true, `kick ok=true`);
    assert(kickData?.reason === 'E2E test kick', `kick reason preserved`);

    // Token revoked — next poll returns 410 (plugin clean exit signal)
    const pollResp = await fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(5_000),
    });
    assert(pollResp.status === 410, `revoked token → 410 on poll (got ${pollResp.status})`);
  }

  // Re-add the token for remaining error tests
  {
    try {
      const tokensFile = await getTokensFilePath();
      const tokens = JSON.parse(await readFile(tokensFile, 'utf8'));
      tokens[TOKEN] = { botName: BOT, displayName: BOT, createdAt: new Date().toISOString(), claimedAt: new Date().toISOString() };
      await writeFile(tokensFile, JSON.stringify(tokens, null, 2) + '\n');
      console.log('  (token restored for error tests)');
    } catch (err) {
      console.warn(`  (could not restore token: ${err.message} — skipping error tests)`);
    }
  }

  // ─── 12. Error: bad token ─────────────────────────────────────────────────
  console.log('\n=== 12. Error: bad token → 401 ===');
  {
    const bad = 'vtk_0000000000000000000000000000000000000000';
    const { status: s1 } = await req('POST', '/api/village/heartbeat', {}, bad);
    assert(s1 === 401, `heartbeat bad token → 401 (got ${s1})`);
    const { status: s2 } = await req('POST', '/api/village/join', {}, bad);
    assert(s2 === 401, `join bad token → 401 (got ${s2})`);
    const { status: s3 } = await req('POST', '/api/village/respond', { requestId: 'x', actions: [] }, bad);
    assert(s3 === 401, `respond bad token → 401 (got ${s3})`);
  }

  // ─── 13. Error: wrong botName on poll ─────────────────────────────────────
  console.log('\n=== 13. Error: poll with wrong botName → 403 ===');
  {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2000);
    try {
      const resp = await fetch(`${HUB}/api/village/poll/not-my-bot`, {
        headers: auth(), signal: ctrl.signal,
      });
      assert(resp.status === 403, `wrong botName → 403 (got ${resp.status})`);
    } catch {
      assert(false, `poll/wrong-bot should 403 before timeout`);
    }
  }

  // ─── 14. Error: no pending relay for bot → 404 ────────────────────────────
  console.log('\n=== 14. Error: respond with no pending relay → 404 ===');
  {
    const { status } = await req('POST', '/api/village/respond',
      { requestId: 'vr_0_0_expired', actions: [{ tool: 'village_observe', params: {} }] });
    assert(status === 404, `no pending relay → 404 (got ${status})`);
  }

  // ─── 15. Error: stale requestId → 409 ─────────────────────────────────────
  console.log('\n=== 15. Error: stale requestId → 409 ===');
  {
    // Issue a relay for this bot
    const relayPromise = fetch(`${HUB}/api/village/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ botName: BOT, conversationId: `test:${BOT}`, v: 2, scene: 'Stale test', tools: [], allowedReads: [], maxActions: 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    // Poll to receive it
    const pollResp = await fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(), signal: AbortSignal.timeout(5_000),
    });
    await pollResp.json(); // consume scene

    // Respond with wrong requestId → 409
    const { status } = await req('POST', '/api/village/respond',
      { requestId: 'vr_stale_old', actions: [] });
    assert(status === 409, `stale requestId → 409 (got ${status})`);

    // Clean up: respond without requestId
    await req('POST', '/api/village/respond', { actions: [{ tool: 'village_observe', params: {} }] });
    await relayPromise;
  }

  // ─── 16. Cleanup ──────────────────────────────────────────────────────────
  console.log('\n=== 16. Cleanup: final leave ===');
  {
    await req('POST', '/api/village/leave', {}).catch(() => {});
    console.log('  done');
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  if (failed > 0) process.exit(1);
  else console.log('All tests passed!');
}

run().catch(err => {
  console.error(`\nFatal: ${err.message}`);
  process.exit(1);
});
