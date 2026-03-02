import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readBotDailyCost } from '../../games/social/logic.js';

// --- SEC-034, SEC-035: readBotDailyCost ---

describe('readBotDailyCost', () => {
  const today = new Date().toISOString().slice(0, 10);

  it('returns daily cost for bot updated today', async () => {
    const usage = {
      'test-bot': { dailyCost: 1.25, lastUpdated: `${today}T12:00:00Z` },
    };
    const readFn = vi.fn().mockResolvedValue(JSON.stringify(usage));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(1.25);
    expect(readFn).toHaveBeenCalledWith('/fake/usage.json', 'utf-8');
  });

  it('returns 0 for bot not in usage file', async () => {
    const usage = {
      'other-bot': { dailyCost: 3.0, lastUpdated: `${today}T12:00:00Z` },
    };
    const readFn = vi.fn().mockResolvedValue(JSON.stringify(usage));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when lastUpdated is from a different day', async () => {
    const usage = {
      'test-bot': { dailyCost: 5.0, lastUpdated: '2025-01-01T12:00:00Z' },
    };
    const readFn = vi.fn().mockResolvedValue(JSON.stringify(usage));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when lastUpdated is missing', async () => {
    const usage = {
      'test-bot': { dailyCost: 2.0 },
    };
    const readFn = vi.fn().mockResolvedValue(JSON.stringify(usage));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when dailyCost is missing (defaults to 0)', async () => {
    const usage = {
      'test-bot': { lastUpdated: `${today}T08:00:00Z` },
    };
    const readFn = vi.fn().mockResolvedValue(JSON.stringify(usage));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when file read fails', async () => {
    const readFn = vi.fn().mockRejectedValue(new Error('ENOENT'));

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when file contains invalid JSON', async () => {
    const readFn = vi.fn().mockResolvedValue('not json');

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });

  it('returns 0 when usage file is empty object', async () => {
    const readFn = vi.fn().mockResolvedValue('{}');

    const cost = await readBotDailyCost('test-bot', '/fake/usage.json', readFn);
    expect(cost).toBe(0);
  });
});
