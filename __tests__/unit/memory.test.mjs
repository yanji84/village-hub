import { describe, it, expect } from 'vitest';
import { buildMemoryEntry } from '../../memory.js';

// --- MEM-003: buildMemoryEntry ---

describe('buildMemoryEntry', () => {
  const baseOpts = {
    location: 'Coffee Hub',
    timestamp: '2026-02-27T15:30:00.000Z',
    events: [],
    botName: 'test-bot',
  };

  it('includes location in header', () => {
    const entry = buildMemoryEntry(baseOpts);
    expect(entry).toContain('## Coffee Hub');
  });

  it('includes formatted time in header', () => {
    const entry = buildMemoryEntry(baseOpts);
    // Time format: "Feb 27, 15:30" (en-US, hour12: false)
    expect(entry).toMatch(/Feb 27/);
    expect(entry).toMatch(/15:30/);
  });

  it('formats say action with display name', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'friend-bot', displayName: 'FriendBot', action: 'say', message: 'Hello world!' },
      ],
    });
    expect(entry).toContain('**FriendBot** (say): "Hello world!"');
  });

  it('formats observe action', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'friend-bot', displayName: 'FriendBot', action: 'observe' },
      ],
    });
    expect(entry).toContain('*FriendBot observed silently*');
  });

  it('formats move action', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'friend-bot', displayName: 'FriendBot', action: 'move', to: 'Workshop' },
      ],
    });
    expect(entry).toContain('*FriendBot moved to Workshop*');
  });

  it('formats arrive action', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'friend-bot', displayName: 'FriendBot', action: 'arrive', from: 'Central Square' },
      ],
    });
    expect(entry).toContain('*FriendBot arrived from Central Square*');
  });

  it('formats join action', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'new-bot', displayName: 'NewBot', action: 'join' },
      ],
    });
    expect(entry).toContain('*NewBot has joined the village!*');
  });

  it('formats leave action', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'old-bot', displayName: 'OldBot', action: 'leave' },
      ],
    });
    expect(entry).toContain('*OldBot has left the village.*');
  });

  // --- Whisper privacy scoping ---

  it('shows whispers FROM this bot (with target name)', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      botName: 'test-bot',
      events: [
        {
          bot: 'test-bot', displayName: 'TestBot', action: 'whisper',
          target: 'friend-bot', targetDisplayName: 'FriendBot',
          message: 'secret msg',
        },
      ],
    });
    expect(entry).toContain('**TestBot** (whisper to FriendBot): "secret msg"');
  });

  it('shows whispers TO this bot', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      botName: 'test-bot',
      events: [
        {
          bot: 'friend-bot', displayName: 'FriendBot', action: 'whisper',
          target: 'test-bot', message: 'just for you',
        },
      ],
    });
    expect(entry).toContain('**FriendBot** (whisper to you): "just for you"');
  });

  it('DOES NOT show whispers between other bots', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      botName: 'test-bot',
      events: [
        {
          bot: 'bot-a', displayName: 'BotA', action: 'whisper',
          target: 'bot-b', targetDisplayName: 'BotB',
          message: 'none of your business',
        },
      ],
    });
    expect(entry).not.toContain('none of your business');
    expect(entry).not.toContain('whisper');
  });

  it('falls back to bot system name when no displayName', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'some-bot', action: 'say', message: 'hi' },
      ],
    });
    expect(entry).toContain('**some-bot** (say): "hi"');
  });

  it('falls back to "elsewhere" for arrive without from', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'friend-bot', displayName: 'FriendBot', action: 'arrive' },
      ],
    });
    expect(entry).toContain('*FriendBot arrived from elsewhere*');
  });

  it('handles multiple events in order', () => {
    const entry = buildMemoryEntry({
      ...baseOpts,
      events: [
        { bot: 'bot-a', displayName: 'BotA', action: 'say', message: 'first' },
        { bot: 'bot-b', displayName: 'BotB', action: 'say', message: 'second' },
        { bot: 'bot-c', displayName: 'BotC', action: 'observe' },
      ],
    });
    const lines = entry.split('\n');
    const firstIdx = lines.findIndex(l => l.includes('first'));
    const secondIdx = lines.findIndex(l => l.includes('second'));
    const observeIdx = lines.findIndex(l => l.includes('observed'));
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(observeIdx);
  });

  it('returns empty body for empty events (only header)', () => {
    const entry = buildMemoryEntry(baseOpts);
    const lines = entry.split('\n').filter(l => l.trim());
    expect(lines).toHaveLength(1); // just the header
    expect(lines[0]).toMatch(/^## Coffee Hub/);
  });
});
