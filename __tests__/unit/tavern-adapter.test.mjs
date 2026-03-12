import { describe, it, expect } from 'vitest';
import { initState, buildScene, tools, onJoin, onLeave } from '../../worlds/tavern/adapter.js';
import { loadWorld } from '../../world-loader.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const worldConfig = loadWorld(join(__dirname, '../../worlds/tavern/schema.json'));

// Helper: create a state with runtime bookkeeping fields (as server.js would)
function freshState() {
  return {
    clock: { tick: 0 },
    bots: [],
    log: [],
    villageCosts: {},
    remoteParticipants: {},
    ...initState(worldConfig),
  };
}

describe('initState', () => {
  it('returns world-specific state with log', () => {
    const ws = initState(worldConfig);
    expect(ws.log).toEqual([]);
    // Should NOT include runtime fields
    expect(ws.clock).toBeUndefined();
    expect(ws.bots).toBeUndefined();
    expect(ws.villageCosts).toBeUndefined();
    expect(ws.remoteParticipants).toBeUndefined();
  });
});

describe('buildScene', () => {
  it('renders scene with other bots', () => {
    const state = freshState();
    const bot = { name: 'alice', displayName: 'Alice' };
    const allBots = [
      { name: 'alice', displayName: 'Alice' },
      { name: 'bob', displayName: 'Bob' },
    ];
    const scene = buildScene(bot, allBots, state, worldConfig);
    expect(scene).toContain('The Rusty Flagon');
    expect(scene).toContain('Bob');
    expect(scene).not.toContain('Alice');  // current bot excluded from "present"
  });

  it('renders alone message when no other bots', () => {
    const state = freshState();
    const bot = { name: 'alice', displayName: 'Alice' };
    const scene = buildScene(bot, [bot], state, worldConfig);
    expect(scene).toContain(worldConfig.sceneLabels.aloneHere);
  });

  it('includes recent log entries', () => {
    const state = freshState();
    state.log.push({ action: 'say', displayName: 'Bob', message: 'Hello!', bot: 'bob', tick: 0, timestamp: '' });
    const bot = { name: 'alice', displayName: 'Alice' };
    const scene = buildScene(bot, [bot], state, worldConfig);
    expect(scene).toContain('Hello!');
  });

  it('lists available actions', () => {
    const state = freshState();
    const bot = { name: 'alice', displayName: 'Alice' };
    const scene = buildScene(bot, [bot], state, worldConfig);
    expect(scene).toContain('tavern_say');
    expect(scene).toContain('tavern_toast');
    expect(scene).toContain('tavern_arm_wrestle');
  });
});

describe('tools', () => {
  it('exports a tools map with expected handlers', () => {
    expect(typeof tools.tavern_say).toBe('function');
    expect(typeof tools.tavern_toast).toBe('function');
    expect(typeof tools.tavern_arm_wrestle).toBe('function');
  });

  describe('tavern_say', () => {
    it('returns say entry', () => {
      const bot = { name: 'alice', displayName: 'Alice' };
      const entry = tools.tavern_say(bot, { message: 'hello' }, freshState());
      expect(entry).toEqual({ action: 'say', message: 'hello' });
    });

    it('returns null without message', () => {
      const bot = { name: 'alice', displayName: 'Alice' };
      expect(tools.tavern_say(bot, {}, freshState())).toBeNull();
      expect(tools.tavern_say(bot, null, freshState())).toBeNull();
    });
  });

  describe('tavern_toast', () => {
    it('returns toast entry', () => {
      const bot = { name: 'alice', displayName: 'Alice' };
      const entry = tools.tavern_toast(bot, { message: 'to glory!' }, freshState());
      expect(entry).toEqual({ action: 'toast', message: 'to glory!' });
    });
  });

  describe('tavern_arm_wrestle', () => {
    it('returns arm_wrestle entry when target exists', () => {
      const state = freshState();
      state.bots = ['alice', 'bob'];
      state.remoteParticipants = { bob: { displayName: 'Bob' } };
      const bot = { name: 'alice', displayName: 'Alice' };
      const entry = tools.tavern_arm_wrestle(bot, { target: 'bob' }, state);
      expect(entry.action).toBe('arm_wrestle');
      expect(entry.target).toBe('bob');
      expect(entry.message).toContain('Alice');
      expect(entry.message).toContain('Bob');
    });

    it('returns say entry when target not found', () => {
      const bot = { name: 'alice', displayName: 'Alice' };
      const entry = tools.tavern_arm_wrestle(bot, { target: 'nobody' }, freshState());
      expect(entry.action).toBe('say');
      expect(entry.message).toContain('nobody');
    });

    it('returns null without target', () => {
      const bot = { name: 'alice', displayName: 'Alice' };
      expect(tools.tavern_arm_wrestle(bot, {}, freshState())).toBeNull();
    });
  });
});

describe('onJoin', () => {
  it('adds join entry to log and returns message', () => {
    const state = freshState();
    const extra = onJoin(state, 'bob', 'Bob');
    expect(state.log).toHaveLength(1);
    expect(state.log[0].action).toBe('join');
    expect(state.log[0].bot).toBe('bob');
    expect(extra.message).toContain('Bob');
  });
});

describe('onLeave', () => {
  it('adds leave entry to log and returns message', () => {
    const state = freshState();
    const extra = onLeave(state, 'bob', 'Bob');
    expect(state.log).toHaveLength(1);
    expect(state.log[0].action).toBe('leave');
    expect(state.log[0].bot).toBe('bob');
    expect(extra.message).toContain('Bob');
  });
});
