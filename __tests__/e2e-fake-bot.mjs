#!/usr/bin/env node
/**
 * E2E smoke test — fake remote bot exercises every proxy flow.
 *
 * Usage: node village/__tests__/e2e-fake-bot.mjs <vtk_token>
 *
 * Tests:
 *   1. Hello handshake (not in game)
 *   2. Join
 *   3. Hello handshake (in game / reconnect)
 *   4. Heartbeat
 *   5. Poll (long-poll timeout → 204)
 *   6. Poll + scene delivery + respond (via relay)
 *   7. Leave
 *   8. Hello after leave (not in game)
 *   9. Rejoin after leave
 *  10. Error: bad token
 *  11. Error: poll with wrong botName
 *  12. Error: respond with expired requestId
 *  13. Leave (cleanup)
 */

const HUB = 'http://127.0.0.1:3000';
const VILLAGE = 'http://127.0.0.1:7001';
const TOKEN = process.argv[2];
if (!TOKEN || !TOKEN.startsWith('vtk_')) {
  console.error('Usage: node e2e-fake-bot.mjs <vtk_token>');
  process.exit(1);
}

const BOT = 'test-phantom';
let passed = 0;
let failed = 0;

function auth(token = TOKEN) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

async function req(method, url, body, token) {
  const opts = { method, headers: auth(token) };
  if (body !== undefined) opts.body = JSON.stringify(body);
  opts.signal = AbortSignal.timeout(10_000);
  const resp = await fetch(url, opts);
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

// Read VILLAGE_SECRET for relay test
async function getVillageSecret() {
  const { readFile } = await import('fs/promises');
  try {
    const raw = await readFile('/root/openclaw-cloud/village/.env', 'utf8');
    const m = raw.match(/^VILLAGE_SECRET=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

// --- Tests ---

async function run() {
  const secret = await getVillageSecret();
  if (!secret) {
    console.error('Cannot read VILLAGE_SECRET from village/.env');
    process.exit(1);
  }

  // Make sure bot is not already in the game
  await req('POST', `${HUB}/api/village/leave`, {});

  console.log('\n=== 1. Hello handshake (not in game) ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/hello`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.inGame === false, `inGame=false (got ${data?.inGame})`);
  }

  console.log('\n=== 2. Join ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/join`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.config?.pollTimeoutMs > 0, `config.pollTimeoutMs=${data?.config?.pollTimeoutMs}`);
  }

  console.log('\n=== 3. Hello handshake (in game / reconnect) ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/hello`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.inGame === true, `inGame=true (got ${data?.inGame})`);
  }

  console.log('\n=== 4. Heartbeat ===');
  {
    const hb = {
      version: '0.0.0-test',
      uptimeMs: 12345,
      joined: true,
      scenesProcessed: 0,
      scenesFailed: 0,
      pollErrors: 0,
    };
    const { status, data } = await req('POST', `${HUB}/api/village/heartbeat`, hb);
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
    assert(data?.config?.pollTimeoutMs > 0, `config returned`);
  }

  // Check heartbeat was stored
  {
    const { status, data } = await req('GET', `${HUB}/api/village/health/${BOT}`);
    assert(status === 200, `health status 200`);
    assert(data?.status === 'healthy', `health status=healthy (got ${data?.status})`);
    assert(data?.lastHeartbeat?.version === '0.0.0-test', `heartbeat version stored`);
  }

  console.log('\n=== 5. Poll (long-poll behavior) ===');
  {
    // Drain any queued scenes from real game ticks first
    let drained = 0;
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1_500);
      try {
        const resp = await fetch(`${HUB}/api/village/poll/${BOT}`, {
          headers: auth(),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (resp.status === 200) {
          const data = await resp.json();
          await req('POST', `${HUB}/api/village/respond/${data.requestId}`, {
            actions: [{ tool: 'village_observe', params: {} }],
          });
          drained++;
        } else {
          break; // 204 = queue empty
        }
      } catch {
        clearTimeout(timer);
        break; // timeout = queue empty, long-poll working
      }
    }
    if (drained > 0) console.log(`  (drained ${drained} queued scene(s) from game ticks)`);

    // Now test long-poll hold: should block then timeout (no scene)
    const controller = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
      const resp = await fetch(`${HUB}/api/village/poll/${BOT}`, {
        headers: auth(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      if (resp.status === 200) {
        // A real tick scene arrived during our wait — that's OK, drain it
        const data = await resp.json();
        await req('POST', `${HUB}/api/village/respond/${data.requestId}`, {
          actions: [{ tool: 'village_observe', params: {} }],
        });
        assert(true, `poll got real scene during wait (${elapsed}ms) — drained`);
      } else {
        assert(resp.status === 204, `poll returned 204 (got ${resp.status})`);
      }
    } catch (err) {
      clearTimeout(timer);
      const elapsed = Date.now() - t0;
      if (err.name === 'AbortError') {
        assert(elapsed >= 1800, `poll held for ${elapsed}ms (long-poll working)`);
      } else {
        assert(false, `poll error: ${err.message}`);
      }
    }
  }

  console.log('\n=== 6. Poll + relay scene + respond ===');
  {
    // Start poll in background (don't await — it blocks until scene arrives)
    const pollPromise = fetch(`${HUB}/api/village/poll/${BOT}`, {
      headers: auth(),
      signal: AbortSignal.timeout(15_000),
    });

    // Give poll a moment to register as a waiter
    await new Promise(r => setTimeout(r, 300));

    // Simulate village server sending a scene via relay (don't await — it blocks until respond)
    const relayPromise = fetch(`${HUB}/api/village/relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({
        botName: BOT,
        conversationId: 'survival:test-phantom',
        v: 2,
        scene: 'You are standing in a test world. What do you do?',
        tools: [{ name: 'survival_set_directive', description: 'Set directive', parameters: { type: 'object', properties: { intent: { type: 'string' } } } }],
        systemPrompt: 'Test system prompt',
        allowedReads: [],
        maxActions: 1,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    // Poll should resolve with the scene (relay delivers to waiting poll)
    const pollResp = await pollPromise;
    assert(pollResp.status === 200, `poll got scene (status ${pollResp.status})`);
    const scene = await pollResp.json();
    assert(!!scene.requestId, `scene has requestId=${scene.requestId}`);
    assert(scene.conversationId === 'survival:test-phantom', `conversationId matches`);
    assert(scene.scene?.includes('test world'), `scene text delivered`);
    assert(scene.v === 2, `v2 payload`);

    // Respond with actions (this unblocks the held relay request)
    const { status: rStatus, data: rData } = await req(
      'POST',
      `${HUB}/api/village/respond/${scene.requestId}`,
      { actions: [{ tool: 'survival_set_directive', params: { intent: 'explore' } }] }
    );
    assert(rStatus === 200, `respond status 200 (got ${rStatus})`);
    assert(rData?.ok === true, `respond ok=true`);

    // Relay should have resolved now
    const relayResp = await relayPromise;
    const relayData = await relayResp.json();
    assert(relayData?.actions?.[0]?.tool === 'survival_set_directive', `relay got actions back`);
    assert(relayData?.actions?.[0]?.params?.intent === 'explore', `relay got correct params`);
  }

  console.log('\n=== 7. Leave ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/leave`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.ok === true, `ok=true`);
  }

  console.log('\n=== 8. Hello after leave (not in game) ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/hello`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.inGame === false, `inGame=false after leave (got ${data?.inGame})`);
  }

  console.log('\n=== 9. Rejoin after leave ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/join`, {});
    assert(status === 200, `status 200 (got ${status})`);
    assert(data?.botName === BOT, `botName=${data?.botName}`);
    assert(data?.ok === true, `ok=true`);
  }

  // Verify in game
  {
    const { data } = await req('POST', `${HUB}/api/village/hello`, {});
    assert(data?.inGame === true, `inGame=true after rejoin`);
  }

  console.log('\n=== 10. Error: bad token ===');
  {
    const { status } = await req('POST', `${HUB}/api/village/hello`, {}, 'vtk_invalid_garbage_token_000000000000');
    assert(status === 401, `bad token → 401 (got ${status})`);
  }
  {
    const { status } = await req('POST', `${HUB}/api/village/join`, {}, 'vtk_invalid_garbage_token_000000000000');
    assert(status === 401, `bad token join → 401 (got ${status})`);
  }
  {
    const { status } = await req('POST', `${HUB}/api/village/heartbeat`, {}, 'vtk_invalid_garbage_token_000000000000');
    assert(status === 401, `bad token heartbeat → 401 (got ${status})`);
  }

  console.log('\n=== 11. Error: poll with wrong botName ===');
  {
    const resp = await fetch(`${HUB}/api/village/poll/wrong-bot-name`, {
      headers: auth(),
      signal: AbortSignal.timeout(5_000),
    });
    assert(resp.status === 403, `wrong botName → 403 (got ${resp.status})`);
  }

  console.log('\n=== 12. Error: respond with expired requestId ===');
  {
    const { status, data } = await req('POST', `${HUB}/api/village/respond/vr_999_expired`, {
      actions: [{ tool: 'village_observe', params: {} }],
    });
    assert(status === 404, `expired requestId → 404 (got ${status})`);
  }

  console.log('\n=== 13. Cleanup: leave ===');
  {
    const { status } = await req('POST', `${HUB}/api/village/leave`, {});
    assert(status === 200, `cleanup leave status 200 (got ${status})`);
  }

  // Final hello confirms we're out
  {
    const { data } = await req('POST', `${HUB}/api/village/hello`, {});
    assert(data?.inGame === false, `cleanup confirmed: inGame=false`);
  }

  // --- Summary ---
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed!');
  }
}

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
