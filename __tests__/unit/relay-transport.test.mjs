/**
 * Unit tests for RelayTransport.
 *
 * No HTTP, no Express — tests the pure in-memory relay broker directly.
 */

import { describe, it, expect } from 'vitest';
import { RelayTransport } from '../../lib/relay-transport.js';

// ─── relay + poll waiter path ─────────────────────────────────────────────────

describe('relay → waiter path (poll waiting when relay arrives)', () => {
  it('relay resolves with the bot response', async () => {
    const t = new RelayTransport();

    // Bot starts polling
    const { promise: pollPromise } = t.poll('alice', 2000);

    // Game server relays a scene
    const relayPromise = t.relay('alice', { conversationId: 'c1', scene: 'hello' }, 2000);

    // Poll should immediately resolve with the scene
    const scene = await pollPromise;
    expect(scene.requestId).toMatch(/^vr_/);
    expect(scene.conversationId).toBe('c1');
    expect(scene.scene).toBe('hello');

    // Bot responds — botName first, requestId second
    const result = t.respond('alice', scene.requestId, [{ tool: 'village_observe', params: {} }], null);
    expect(result.ok).toBe(true);

    // Relay resolves with the actions
    const response = await relayPromise;
    expect(response).not.toBeNull();
    expect(response.actions[0].tool).toBe('village_observe');
  });

  it('relay includes usage in response when provided', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('alice', 2000);
    const relayPromise = t.relay('alice', { conversationId: 'c2', scene: 's' }, 2000);
    const scene = await promise;
    t.respond('alice', scene.requestId, [{ tool: 'village_move', params: {} }], { inputTokens: 100, outputTokens: 50 });
    const resp = await relayPromise;
    expect(resp.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
  });
});

// ─── relay + payload path (relay arrives before poll) ────────────────────────

describe('relay → payload path (relay arrives before poll)', () => {
  it('relay stores payload; subsequent poll returns immediately', async () => {
    const t = new RelayTransport();

    // Relay before any poll
    const relayPromise = t.relay('bob', { conversationId: 'c3', scene: 'queued' }, 2000);

    // Short delay then poll
    await new Promise(r => setTimeout(r, 20));

    const t0 = Date.now();
    const { promise } = t.poll('bob', 2000);
    const scene = await promise;
    expect(Date.now() - t0).toBeLessThan(200);  // immediate, not long-polled
    expect(scene.scene).toBe('queued');

    t.respond('bob', scene.requestId, [{ tool: 'village_observe', params: {} }]);
    await relayPromise;
  });
});

// ─── timeouts ─────────────────────────────────────────────────────────────────

describe('timeouts', () => {
  it('relay returns null after timeout (no bot polls)', async () => {
    const t = new RelayTransport();
    const result = await t.relay('ghost', { conversationId: 'c4', scene: 's' }, 50);
    expect(result).toBeNull();
  });

  it('poll returns null after timeout (no relay arrives)', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('ghost2', 50);
    const result = await promise;
    expect(result).toBeNull();
  });

  it('relay timeout destroys payload — bot gets nothing on next poll', async () => {
    const t = new RelayTransport();
    // Relay with very short timeout — expires before bot polls
    const relayPromise = t.relay('late-bot', { conversationId: 'c-late', scene: 'stale' }, 50);
    await relayPromise;  // null (timed out)

    // Bot polls now — should get nothing (relay and its payload are gone)
    const { promise } = t.poll('late-bot', 100);
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ─── cancel ───────────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('cancel resolves the current poll as null', async () => {
    const t = new RelayTransport();
    const { promise, cancel } = t.poll('carol', 5000);
    setTimeout(cancel, 50);
    const result = await promise;
    expect(result).toBeNull();
  });

  it('cancel of old poll does not affect a newer poll', async () => {
    const t = new RelayTransport();

    const { promise: p1, cancel: cancel1 } = t.poll('dave', 5000);

    // Second poll evicts first
    const { promise: p2 } = t.poll('dave', 5000);

    // p1 should already be resolved as null (evicted)
    const r1 = await p1;
    expect(r1).toBeNull();

    // Calling cancel1 should NOT affect p2
    cancel1();

    // Relay to dave — p2 should get it
    const relayPromise = t.relay('dave', { conversationId: 'c5', scene: 'for-p2' }, 2000);
    const r2 = await p2;
    expect(r2).not.toBeNull();
    expect(r2.scene).toBe('for-p2');

    t.respond('dave', r2.requestId, []);
    await relayPromise;
  });
});

// ─── duplicate poll ───────────────────────────────────────────────────────────

describe('duplicate poll', () => {
  it('second poll evicts first (first resolves null, second gets scene)', async () => {
    const t = new RelayTransport();

    const { promise: p1 } = t.poll('eve', 5000);
    await new Promise(r => setTimeout(r, 10));
    const { promise: p2 } = t.poll('eve', 5000);

    // p1 evicted → null
    const r1 = await p1;
    expect(r1).toBeNull();

    // Relay → p2 gets it
    const relayPromise = t.relay('eve', { conversationId: 'c6', scene: 'for-p2' }, 2000);
    const r2 = await p2;
    expect(r2.scene).toBe('for-p2');

    t.respond('eve', r2.requestId, [{ tool: 'village_observe', params: {} }]);
    await relayPromise;
  });
});

// ─── respond error cases ──────────────────────────────────────────────────────

describe('respond — error cases', () => {
  it('no pending relay for bot → { ok: false, error: "not_found" }', () => {
    const t = new RelayTransport();
    const result = t.respond('nobody', 'vr_0_0000_expired', []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('not_found');
  });

  it('stale requestId → { ok: false, error: "stale_request" }', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('frank', 2000);
    const relayPromise = t.relay('frank', { conversationId: 'c7', scene: 's' }, 2000);
    await promise;

    // Wrong requestId for frank's pending relay
    const result = t.respond('frank', 'vr_stale_old_id', []);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('stale_request');

    // Clean up with no requestId (skips check)
    t.respond('frank', undefined, []);
    await relayPromise;
  });

  it('omitting requestId skips the stale check', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('grace2', 2000);
    const relayPromise = t.relay('grace2', { conversationId: 'cx', scene: 's' }, 2000);
    await promise;

    const result = t.respond('grace2', undefined, []);
    expect(result.ok).toBe(true);
    await relayPromise;
  });

  it('empty actions default to village_observe', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('grace', 2000);
    const relayPromise = t.relay('grace', { conversationId: 'c8', scene: 's' }, 2000);
    const scene = await promise;
    t.respond('grace', scene.requestId, null);
    const resp = await relayPromise;
    expect(resp.actions).toEqual([{ tool: 'village_observe', params: {} }]);
  });

  it('empty array actions are kept as-is (only null/undefined defaults)', async () => {
    const t = new RelayTransport();
    const { promise } = t.poll('henry', 2000);
    const relayPromise = t.relay('henry', { conversationId: 'c9', scene: 's' }, 2000);
    const scene = await promise;
    t.respond('henry', scene.requestId, []);
    const resp = await relayPromise;
    // [] is truthy — kept as empty array, not replaced with default
    expect(resp.actions).toEqual([]);
  });
});

// ─── multiple bots ────────────────────────────────────────────────────────────

describe('multiple bots', () => {
  it('state is independent per bot', async () => {
    const t = new RelayTransport();

    // Relay two bots in parallel
    const relay1 = t.relay('bot1', { conversationId: 'c-b1', scene: 'scene-for-bot1' }, 2000);
    const relay2 = t.relay('bot2', { conversationId: 'c-b2', scene: 'scene-for-bot2' }, 2000);

    await new Promise(r => setTimeout(r, 10));

    const { promise: p1 } = t.poll('bot1', 2000);
    const { promise: p2 } = t.poll('bot2', 2000);

    const [s1, s2] = await Promise.all([p1, p2]);

    expect(s1.scene).toBe('scene-for-bot1');
    expect(s2.scene).toBe('scene-for-bot2');

    t.respond('bot1', s1.requestId, [{ tool: 'village_observe', params: {} }]);
    t.respond('bot2', s2.requestId, [{ tool: 'village_move', params: { direction: 'north' } }]);

    const [r1, r2] = await Promise.all([relay1, relay2]);
    expect(r1.actions[0].tool).toBe('village_observe');
    expect(r2.actions[0].tool).toBe('village_move');
  });

  it('poll for one bot does not receive another bots scene', async () => {
    const t = new RelayTransport();

    // Only relay bot3
    const relayPromise = t.relay('bot3', { conversationId: 'c-b3', scene: 'for-bot3' }, 500);

    // bot4 polls — should timeout, not get bot3's scene
    const { promise } = t.poll('bot4', 100);
    const result = await promise;
    expect(result).toBeNull();

    // bot3 responds to clean up
    const { promise: p3 } = t.poll('bot3', 2000);
    const s3 = await p3;
    t.respond('bot3', s3.requestId, []);
    await relayPromise;
  });
});

// ─── requestId uniqueness ─────────────────────────────────────────────────────

describe('requestId', () => {
  it('each relay call produces a unique requestId', async () => {
    const t = new RelayTransport();
    const ids = new Set();

    for (let i = 0; i < 5; i++) {
      const { promise } = t.poll(`unique-bot-${i}`, 2000);
      const rp = t.relay(`unique-bot-${i}`, { conversationId: `c${i}`, scene: `s${i}` }, 2000);
      const scene = await promise;
      ids.add(scene.requestId);
      t.respond(`unique-bot-${i}`, scene.requestId, []);
      await rp;
    }

    expect(ids.size).toBe(5);
  });

  it('scene payload includes requestId prepended to the relay payload', async () => {
    const t = new RelayTransport();
    // Note: botName stripping happens in the route handler (protocol.js), not here.
    // RelayTransport.relay() receives an already-stripped payload and just adds requestId.
    const { promise } = t.poll('strip-test', 2000);
    const relayPromise = t.relay('strip-test', {
      conversationId: 'c-strip',
      scene: 'check',
      v: 2,
    }, 2000);
    const scene = await promise;
    expect(scene.requestId).toMatch(/^vr_/);
    expect(scene.conversationId).toBe('c-strip');
    expect(scene.scene).toBe('check');
    expect(scene.v).toBe(2);
    t.respond('strip-test', scene.requestId, []);
    await relayPromise;
  });
});
