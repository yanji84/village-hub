import { describe, it, expect } from 'vitest';
import {
  processActions,
  advanceClock,
  enforceLogDepth,
  computeQualityMetrics,
  shouldSkipForCost,
  findNewBots,
  findDepartedBots,
} from '../../games/social/logic.js';
import { loadGame } from '../../game-loader.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const gameConfig = loadGame(join(__dirname, '../../games/social/schema.json'));

const ALL_LOCATIONS = gameConfig.locationSlugs;
const PHASES = Object.keys(gameConfig.phaseDescriptions);

// --- Helper to create fresh state ---

function freshState(overrides = {}) {
  const state = {
    locations: {},
    whispers: {},
    publicLogs: {},
    clock: { tick: 0, phase: 'morning', ticksInPhase: 0 },
    emptyTicks: {},
  };
  for (const loc of ALL_LOCATIONS) {
    state.locations[loc] = [];
    state.publicLogs[loc] = [];
    state.emptyTicks[loc] = 0;
  }
  return { ...state, ...overrides };
}

// --- ORC-010 through ORC-015: processActions ---

describe('processActions', () => {
  it('handles village_say — adds to publicLogs and returns event', () => {
    const state = freshState();
    const events = processActions('bot-a', [
      { tool: 'village_say', params: { message: 'Hello!' } },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ bot: 'bot-a', action: 'say', message: 'Hello!' });
    expect(state.publicLogs['coffee-hub']).toHaveLength(1);
    expect(state.publicLogs['coffee-hub'][0].message).toBe('Hello!');
  });

  it('ignores village_say with empty message', () => {
    const state = freshState();
    const events = processActions('bot-a', [
      { tool: 'village_say', params: { message: '' } },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(0);
    expect(state.publicLogs['coffee-hub']).toHaveLength(0);
  });

  it('handles village_whisper — queues whisper for target', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];

    const events = processActions('bot-a', [
      { tool: 'village_whisper', params: { bot_id: 'bot-b', message: 'psst' } },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      bot: 'bot-a', action: 'whisper', target: 'bot-b', message: 'psst',
    });
    expect(state.whispers['bot-b']).toHaveLength(1);
    expect(state.whispers['bot-b'][0].from).toBe('bot-a');
  });

  it('drops whisper when target queue is full (cap at 20)', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];
    // Pre-fill whisper queue to capacity
    state.whispers['bot-b'] = Array.from({ length: 20 }, (_, i) => ({
      from: 'bot-x', message: `msg-${i}`,
    }));

    const events = processActions('bot-a', [
      { tool: 'village_whisper', params: { bot_id: 'bot-b', message: 'overflow' } },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(0);
    expect(state.whispers['bot-b']).toHaveLength(20); // unchanged
  });

  it('drops whisper if target is not at same location', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];
    state.locations['workshop'] = ['bot-b'];

    const events = processActions('bot-a', [
      { tool: 'village_whisper', params: { bot_id: 'bot-b', message: 'secret' } },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(0);
    expect(state.whispers['bot-b']).toBeUndefined();
  });

  it('drops whisper with missing target or message', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];

    const events1 = processActions('bot-a', [
      { tool: 'village_whisper', params: { message: 'no target' } },
    ], 'coffee-hub', state);
    expect(events1).toHaveLength(0);

    const events2 = processActions('bot-a', [
      { tool: 'village_whisper', params: { bot_id: 'bot-b' } },
    ], 'coffee-hub', state);
    expect(events2).toHaveLength(0);
  });

  it('handles village_observe — returns event, no state change', () => {
    const state = freshState();
    const events = processActions('bot-a', [
      { tool: 'village_observe', params: {} },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ bot: 'bot-a', action: 'observe' });
    expect(state.publicLogs['coffee-hub']).toHaveLength(0);
  });

  it('handles village_move — updates locations', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const events = processActions('bot-a', [
      { tool: 'village_move', params: { location: 'workshop' } },
    ], 'coffee-hub', state, { validLocations: ALL_LOCATIONS });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      bot: 'bot-a', action: 'move', from: 'coffee-hub', to: 'workshop',
    });
    expect(state.locations['coffee-hub']).not.toContain('bot-a');
    expect(state.locations['workshop']).toContain('bot-a');
  });

  it('drops move to invalid location', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const events = processActions('bot-a', [
      { tool: 'village_move', params: { location: 'nonexistent' } },
    ], 'coffee-hub', state, { validLocations: ALL_LOCATIONS });

    expect(events).toHaveLength(0);
    expect(state.locations['coffee-hub']).toContain('bot-a');
  });

  it('drops move to same location', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const events = processActions('bot-a', [
      { tool: 'village_move', params: { location: 'coffee-hub' } },
    ], 'coffee-hub', state, { validLocations: ALL_LOCATIONS });

    expect(events).toHaveLength(0);
  });

  it('move is exclusive — skips other actions when moving', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];

    const events = processActions('bot-a', [
      { tool: 'village_say', params: { message: 'goodbye' } },
      { tool: 'village_move', params: { location: 'workshop' } },
    ], 'coffee-hub', state, { validLocations: ALL_LOCATIONS });

    // Move is exclusive: say is dropped, only move event produced
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('move');
    expect(state.locations['workshop']).toContain('bot-a');
    expect(state.publicLogs['coffee-hub']).toHaveLength(0); // say not recorded
  });

  it('handles multiple non-move actions in sequence', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];

    const events = processActions('bot-a', [
      { tool: 'village_say', params: { message: 'hello' } },
      { tool: 'village_observe' },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(2);
    expect(events[0].action).toBe('say');
    expect(events[1].action).toBe('observe');
  });

  it('enforces move cooldown when lastMoveTick provided', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const lastMoveTick = new Map([['bot-a', 5]]);
    const events = processActions('bot-a', [
      { tool: 'village_move', params: { location: 'workshop' } },
    ], 'coffee-hub', state, { lastMoveTick, tick: 6, validLocations: ALL_LOCATIONS });

    // Tick 6, last moved tick 5 → cooldown (moved last tick)
    expect(events).toHaveLength(0);
    expect(state.locations['coffee-hub']).toContain('bot-a');
  });

  it('allows move after cooldown expires', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const lastMoveTick = new Map([['bot-a', 5]]);
    const events = processActions('bot-a', [
      { tool: 'village_move', params: { location: 'workshop' } },
    ], 'coffee-hub', state, { lastMoveTick, tick: 7, validLocations: ALL_LOCATIONS });

    // Tick 7, last moved tick 5 → cooldown expired
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('move');
    expect(state.locations['workshop']).toContain('bot-a');
  });

  it('ignores unknown tool names', () => {
    const state = freshState();
    const events = processActions('bot-a', [
      { tool: 'unknown_tool', params: {} },
    ], 'coffee-hub', state);

    expect(events).toHaveLength(0);
  });
});

// --- advanceClock ---

describe('advanceClock', () => {
  it('increments tick', () => {
    const clock = { tick: 0, phase: 'morning', ticksInPhase: 0 };
    advanceClock(clock, 4, PHASES);
    expect(clock.tick).toBe(1);
    expect(clock.ticksInPhase).toBe(1);
  });

  it('advances phase after ticksPerPhase', () => {
    const clock = { tick: 0, phase: 'morning', ticksInPhase: 3 };
    advanceClock(clock, 4, PHASES);
    expect(clock.phase).toBe('afternoon');
    expect(clock.ticksInPhase).toBe(0);
  });

  it('cycles phases: morning → afternoon → evening → night → morning', () => {
    const clock = { tick: 0, phase: 'morning', ticksInPhase: 0 };
    const ticksPerPhase = 1;

    advanceClock(clock, ticksPerPhase, PHASES);
    expect(clock.phase).toBe('afternoon');

    advanceClock(clock, ticksPerPhase, PHASES);
    expect(clock.phase).toBe('evening');

    advanceClock(clock, ticksPerPhase, PHASES);
    expect(clock.phase).toBe('night');

    advanceClock(clock, ticksPerPhase, PHASES);
    expect(clock.phase).toBe('morning');
  });

  it('does not advance phase before ticksPerPhase reached', () => {
    const clock = { tick: 0, phase: 'morning', ticksInPhase: 0 };
    advanceClock(clock, 4, PHASES);
    expect(clock.phase).toBe('morning');
    advanceClock(clock, 4, PHASES);
    expect(clock.phase).toBe('morning');
    advanceClock(clock, 4, PHASES);
    expect(clock.phase).toBe('morning');
    advanceClock(clock, 4, PHASES);
    expect(clock.phase).toBe('afternoon');
  });
});

// --- enforceLogDepth ---

describe('enforceLogDepth', () => {
  it('trims logs exceeding maxDepth', () => {
    const logs = {
      'coffee-hub': Array.from({ length: 30 }, (_, i) => ({ msg: i })),
    };
    enforceLogDepth(logs, 20);
    expect(logs['coffee-hub']).toHaveLength(20);
    // Should keep the last 20
    expect(logs['coffee-hub'][0].msg).toBe(10);
    expect(logs['coffee-hub'][19].msg).toBe(29);
  });

  it('does not trim logs at or below maxDepth', () => {
    const logs = {
      'coffee-hub': Array.from({ length: 20 }, (_, i) => ({ msg: i })),
    };
    enforceLogDepth(logs, 20);
    expect(logs['coffee-hub']).toHaveLength(20);
  });

  it('handles empty logs', () => {
    const logs = { 'coffee-hub': [] };
    enforceLogDepth(logs, 20);
    expect(logs['coffee-hub']).toHaveLength(0);
  });
});

// --- computeQualityMetrics ---

describe('computeQualityMetrics', () => {
  it('returns null for empty log', () => {
    expect(computeQualityMetrics([])).toBeNull();
    expect(computeQualityMetrics(null)).toBeNull();
  });

  it('returns null for log with no say actions', () => {
    const log = [{ action: 'observe' }, { action: 'move' }];
    expect(computeQualityMetrics(log)).toBeNull();
  });

  it('computes metrics for say messages', () => {
    const log = [
      { action: 'say', message: 'hello world' },
      { action: 'say', message: 'hello again' },
      { action: 'observe' },
    ];
    const metrics = computeQualityMetrics(log);
    expect(metrics).not.toBeNull();
    expect(metrics.messages).toBe(2);
    expect(metrics.wordEntropy).toBeGreaterThan(0);
    expect(metrics.wordEntropy).toBeLessThanOrEqual(1);
    expect(metrics.topicDiversity).toBeGreaterThanOrEqual(1);
  });

  it('returns entropy of 1 for all unique words', () => {
    const log = [
      { action: 'say', message: 'alpha beta gamma delta' },
    ];
    const metrics = computeQualityMetrics(log);
    expect(metrics.wordEntropy).toBe(1);
  });

  it('returns low entropy for repeated words', () => {
    const log = [
      { action: 'say', message: 'hello hello hello hello' },
    ];
    const metrics = computeQualityMetrics(log);
    expect(metrics.wordEntropy).toBe(0.25); // 1 unique / 4 total
  });
});

// --- shouldSkipForCost ---

describe('shouldSkipForCost', () => {
  it('skips when cost exceeds cap', () => {
    expect(shouldSkipForCost(2.5, 2)).toBe(true);
  });

  it('skips when cost equals cap', () => {
    expect(shouldSkipForCost(2, 2)).toBe(true);
  });

  it('does not skip when cost is below cap', () => {
    expect(shouldSkipForCost(1.5, 2)).toBe(false);
  });

  it('does not skip when cap is 0 (disabled)', () => {
    expect(shouldSkipForCost(100, 0)).toBe(false);
  });

  it('does not skip when cap is negative (disabled)', () => {
    expect(shouldSkipForCost(100, -1)).toBe(false);
  });
});

// --- findNewBots ---

describe('findNewBots', () => {
  it('finds bots not in any location', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['existing-bot'];

    const newBots = findNewBots(new Set(['existing-bot', 'new-bot']), state);
    expect(newBots).toEqual(['new-bot']);
  });

  it('returns empty if all bots already placed', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const newBots = findNewBots(new Set(['bot-a']), state);
    expect(newBots).toEqual([]);
  });
});

// --- findDepartedBots ---

describe('findDepartedBots', () => {
  it('finds bots in locations but not in participants', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a', 'bot-b'];

    const departed = findDepartedBots(new Set(['bot-a']), state, ALL_LOCATIONS);
    expect(departed).toEqual([{ name: 'bot-b', location: 'coffee-hub' }]);
  });

  it('returns empty if all placed bots are participants', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const departed = findDepartedBots(new Set(['bot-a']), state, ALL_LOCATIONS);
    expect(departed).toEqual([]);
  });
});

// --- processActions edge cases: malformed state ---

describe('processActions — malformed state', () => {
  it('handles missing publicLogs for location gracefully', () => {
    const state = {
      locations: { 'coffee-hub': ['bot-a'] },
      whispers: {},
      publicLogs: {}, // no 'coffee-hub' key
    };
    expect(() => {
      processActions('bot-a', [
        { tool: 'village_say', params: { message: 'hi' } },
      ], 'coffee-hub', state);
    }).toThrow(); // Should throw — publicLogs[location].push fails
    // This is expected: the orchestrator always initializes publicLogs for all locations.
    // The test documents that processActions does NOT silently swallow this.
  });

  it('handles empty actions array', () => {
    const state = freshState();
    const events = processActions('bot-a', [], 'coffee-hub', state);
    expect(events).toEqual([]);
  });

  it('handles null/undefined params gracefully', () => {
    const state = freshState();
    // village_say with no params
    const events1 = processActions('bot-a', [
      { tool: 'village_say' },
    ], 'coffee-hub', state);
    expect(events1).toHaveLength(0);

    // village_move with no params
    const events2 = processActions('bot-a', [
      { tool: 'village_move' },
    ], 'coffee-hub', state);
    expect(events2).toHaveLength(0);

    // village_whisper with no params
    const events3 = processActions('bot-a', [
      { tool: 'village_whisper' },
    ], 'coffee-hub', state);
    expect(events3).toHaveLength(0);
  });

  it('handles action with undefined tool name', () => {
    const state = freshState();
    const events = processActions('bot-a', [
      { params: { message: 'test' } },
    ], 'coffee-hub', state);
    expect(events).toHaveLength(0);
  });

  it('handles whisper to self (same bot at same location)', () => {
    const state = freshState();
    state.locations['coffee-hub'] = ['bot-a'];

    const events = processActions('bot-a', [
      { tool: 'village_whisper', params: { bot_id: 'bot-a', message: 'talking to myself' } },
    ], 'coffee-hub', state);

    // Technically allowed by current logic — bot IS at the location
    expect(events).toHaveLength(1);
    expect(state.whispers['bot-a']).toHaveLength(1);
  });
});

// --- PHASES ---

describe('PHASES', () => {
  it('has 4 phases in order', () => {
    expect(PHASES).toEqual(['morning', 'afternoon', 'evening', 'night']);
  });
});
