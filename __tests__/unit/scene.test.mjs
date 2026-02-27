import { describe, it, expect } from 'vitest';
import { buildScene, LOCATION_NAMES, ALL_LOCATIONS, PHASE_DESCRIPTIONS } from '../../scene.js';

// --- ORC-020: Location definitions ---

describe('LOCATION_NAMES', () => {
  it('contains all 6 village locations', () => {
    expect(Object.keys(LOCATION_NAMES)).toHaveLength(6);
    expect(LOCATION_NAMES).toHaveProperty('central-square');
    expect(LOCATION_NAMES).toHaveProperty('coffee-hub');
    expect(LOCATION_NAMES).toHaveProperty('knowledge-corner');
    expect(LOCATION_NAMES).toHaveProperty('chill-zone');
    expect(LOCATION_NAMES).toHaveProperty('workshop');
    expect(LOCATION_NAMES).toHaveProperty('sunset-lounge');
  });

  it('ALL_LOCATIONS matches LOCATION_NAMES keys', () => {
    expect(ALL_LOCATIONS).toEqual(Object.keys(LOCATION_NAMES));
  });
});

// --- ORC-021: Phase descriptions ---

describe('PHASE_DESCRIPTIONS', () => {
  it('contains morning, afternoon, evening', () => {
    expect(PHASE_DESCRIPTIONS).toHaveProperty('morning');
    expect(PHASE_DESCRIPTIONS).toHaveProperty('afternoon');
    expect(PHASE_DESCRIPTIONS).toHaveProperty('evening');
    expect(Object.keys(PHASE_DESCRIPTIONS)).toHaveLength(3);
  });
});

// --- ORC-022 through ORC-027: buildScene ---

describe('buildScene', () => {
  const baseOpts = {
    botName: 'test-bot',
    botDisplayName: 'TestBot',
    location: 'coffee-hub',
    phase: 'morning',
    tick: 1,
    botsHere: [],
    botDisplayNames: { 'test-bot': 'TestBot' },
    publicLog: [],
    whispers: [],
    movements: [],
  };

  it('includes phase description', () => {
    const scene = buildScene(baseOpts);
    expect(scene).toContain(PHASE_DESCRIPTIONS.morning);
  });

  it('includes location name', () => {
    const scene = buildScene(baseOpts);
    expect(scene).toContain('**Coffee Hub**');
  });

  it('shows "alone" when no other bots present', () => {
    const scene = buildScene(baseOpts);
    expect(scene).toContain("You're alone here.");
  });

  it('lists other bots present by display name', () => {
    const scene = buildScene({
      ...baseOpts,
      botsHere: ['friend-bot', 'other-bot'],
      botDisplayNames: {
        'test-bot': 'TestBot',
        'friend-bot': 'FriendBot',
        'other-bot': 'OtherBot',
      },
    });
    expect(scene).toContain('Also here: FriendBot, OtherBot');
    expect(scene).not.toContain("You're alone here.");
  });

  it('falls back to system name for unknown bots', () => {
    const scene = buildScene({
      ...baseOpts,
      botsHere: ['unknown-bot'],
      botDisplayNames: { 'test-bot': 'TestBot' },
    });
    expect(scene).toContain('Also here: unknown-bot');
  });

  it('includes movement events', () => {
    const scene = buildScene({
      ...baseOpts,
      movements: [
        { bot: 'friend-bot', type: 'arrive', from: 'central-square' },
        { bot: 'other-bot', type: 'depart', to: 'workshop' },
      ],
      botDisplayNames: {
        'test-bot': 'TestBot',
        'friend-bot': 'FriendBot',
        'other-bot': 'OtherBot',
      },
    });
    expect(scene).toContain('*FriendBot arrived from Central Square*');
    expect(scene).toContain('*OtherBot left for Workshop*');
  });

  it('includes join and leave movements', () => {
    const scene = buildScene({
      ...baseOpts,
      movements: [
        { bot: 'new-bot', type: 'join' },
        { bot: 'old-bot', type: 'leave' },
      ],
      botDisplayNames: {
        'test-bot': 'TestBot',
        'new-bot': 'NewBot',
        'old-bot': 'OldBot',
      },
    });
    expect(scene).toContain('*NewBot has joined the village!*');
    expect(scene).toContain('*OldBot has left the village.*');
  });

  it('includes public log entries', () => {
    const scene = buildScene({
      ...baseOpts,
      publicLog: [
        { bot: 'friend-bot', action: 'say', message: 'Hello everyone!' },
        { bot: 'other-bot', action: 'observe' },
      ],
      botDisplayNames: {
        'test-bot': 'TestBot',
        'friend-bot': 'FriendBot',
        'other-bot': 'OtherBot',
      },
    });
    expect(scene).toContain('Recent conversation:');
    expect(scene).toContain('[Message from FriendBot]: "Hello everyone!"');
    expect(scene).toContain('*OtherBot observed silently*');
  });

  it('caps public log to sceneHistoryCap', () => {
    const log = Array.from({ length: 20 }, (_, i) => ({
      bot: 'friend-bot',
      action: 'say',
      message: `Message ${i}`,
    }));
    const scene = buildScene({
      ...baseOpts,
      publicLog: log,
      sceneHistoryCap: 5,
      botDisplayNames: { 'test-bot': 'TestBot', 'friend-bot': 'FriendBot' },
    });
    // Should only contain last 5 messages (15-19)
    expect(scene).not.toContain('Message 14');
    expect(scene).toContain('Message 15');
    expect(scene).toContain('Message 19');
  });

  it('includes whispers', () => {
    const scene = buildScene({
      ...baseOpts,
      whispers: [
        { from: 'friend-bot', message: 'Secret message' },
      ],
      botDisplayNames: {
        'test-bot': 'TestBot',
        'friend-bot': 'FriendBot',
      },
    });
    expect(scene).toContain('Private whispers to you:');
    expect(scene).toContain('[Whisper from FriendBot]: "Secret message"');
  });

  it('includes available actions', () => {
    const scene = buildScene(baseOpts);
    expect(scene).toContain('**village_say**');
    expect(scene).toContain('**village_whisper**');
    expect(scene).toContain('**village_observe**');
    expect(scene).toContain('**village_move**');
  });

  it('lists other locations for move (excludes current)', () => {
    const scene = buildScene(baseOpts);
    expect(scene).toContain('central-square');
    expect(scene).toContain('knowledge-corner');
    // Current location should not be in the "Available locations" list
    const availableLine = scene.split('\n').find(l => l.startsWith('Available locations:'));
    expect(availableLine).not.toContain('coffee-hub (Coffee Hub)');
  });

  it('falls back to morning phase for unknown phase', () => {
    const scene = buildScene({ ...baseOpts, phase: 'invalid-phase' });
    expect(scene).toContain(PHASE_DESCRIPTIONS.morning);
  });

  it('falls back to location slug for unknown location', () => {
    const scene = buildScene({ ...baseOpts, location: 'secret-garden' });
    expect(scene).toContain('**secret-garden**');
  });

  it('handles all three phases correctly', () => {
    for (const phase of ['morning', 'afternoon', 'evening']) {
      const scene = buildScene({ ...baseOpts, phase });
      expect(scene).toContain(PHASE_DESCRIPTIONS[phase]);
    }
  });

  it('handles empty whispers and movements gracefully', () => {
    const scene = buildScene({
      ...baseOpts,
      whispers: [],
      movements: [],
    });
    expect(scene).not.toContain('Private whispers');
    expect(scene).not.toContain('arrived from');
  });

  it('returns a string', () => {
    const scene = buildScene(baseOpts);
    expect(typeof scene).toBe('string');
    expect(scene.length).toBeGreaterThan(0);
  });
});
