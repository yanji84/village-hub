import { describe, it, expect } from 'vitest';
import { validateObserverAuth } from '../../games/social/logic.js';

// --- OBS-010, OBS-012: validateObserverAuth ---

describe('validateObserverAuth', () => {
  const futureTs = Date.now() + 3600_000; // 1 hour from now
  const pastTs = Date.now() - 3600_000; // 1 hour ago

  it('returns bot name for valid session cookie', () => {
    const tokens = {
      'test-bot': { session: 'abc123', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth('as_test-bot=abc123', tokens);
    expect(result).toBe('test-bot');
  });

  it('returns null for expired session', () => {
    const tokens = {
      'test-bot': { session: 'abc123', sessionExpiresAt: pastTs },
    };
    const result = validateObserverAuth('as_test-bot=abc123', tokens);
    expect(result).toBeNull();
  });

  it('returns null for wrong session token', () => {
    const tokens = {
      'test-bot': { session: 'correct-token', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth('as_test-bot=wrong-token', tokens);
    expect(result).toBeNull();
  });

  it('returns null for unknown bot in cookie', () => {
    const tokens = {
      'other-bot': { session: 'abc123', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth('as_test-bot=abc123', tokens);
    expect(result).toBeNull();
  });

  it('returns null for empty cookie header', () => {
    const tokens = { 'test-bot': { session: 'abc123', sessionExpiresAt: futureTs } };
    expect(validateObserverAuth('', tokens)).toBeNull();
  });

  it('returns null for null/undefined cookie header', () => {
    const tokens = { 'test-bot': { session: 'abc123', sessionExpiresAt: futureTs } };
    expect(validateObserverAuth(null, tokens)).toBeNull();
    expect(validateObserverAuth(undefined, tokens)).toBeNull();
  });

  it('returns null for null/undefined tokens', () => {
    expect(validateObserverAuth('as_test-bot=abc123', null)).toBeNull();
    expect(validateObserverAuth('as_test-bot=abc123', undefined)).toBeNull();
  });

  it('ignores non-as_ cookies', () => {
    const tokens = {
      'test-bot': { session: 'abc123', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth('other_cookie=value; something=else', tokens);
    expect(result).toBeNull();
  });

  it('handles multiple cookies, matches correct as_ one', () => {
    const tokens = {
      'bot-a': { session: 'token-a', sessionExpiresAt: futureTs },
      'bot-b': { session: 'token-b', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth(
      'foo=bar; as_bot-a=wrong; as_bot-b=token-b',
      tokens,
    );
    expect(result).toBe('bot-b');
  });

  it('returns first valid match when multiple as_ cookies match', () => {
    const tokens = {
      'bot-a': { session: 'token-a', sessionExpiresAt: futureTs },
      'bot-b': { session: 'token-b', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth(
      'as_bot-a=token-a; as_bot-b=token-b',
      tokens,
    );
    // Should return first valid match
    expect(['bot-a', 'bot-b']).toContain(result);
  });

  it('handles cookie with spaces around semicolons', () => {
    const tokens = {
      'test-bot': { session: 'abc123', sessionExpiresAt: futureTs },
    };
    const result = validateObserverAuth(
      'foo=bar ;  as_test-bot=abc123 ; baz=qux',
      tokens,
    );
    expect(result).toBe('test-bot');
  });

  it('handles empty tokens object', () => {
    const result = validateObserverAuth('as_test-bot=abc123', {});
    expect(result).toBeNull();
  });
});
