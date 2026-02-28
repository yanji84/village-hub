import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import villagePlugin from '../../../templates/plugins/village/index.js';

// --- Mock WebSocket that never connects (keeps RPC hanging for action capture tests) ---

const _OriginalWebSocket = globalThis.WebSocket;

class HangingWebSocket {
  constructor() {
    this._listeners = {};
    // Fire error after 30ms — long enough for hooks to fire (at 10ms),
    // short enough to not hit test timeout. This makes rpcPromise reject
    // via .catch(), allowing the handler to return.
    this._errorTimer = setTimeout(() => {
      for (const fn of (this._listeners['error'] || [])) {
        fn(new Error('mock ws error'));
      }
    }, 30);
  }
  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }
  send() {}
  close() {
    clearTimeout(this._errorTimer);
    for (const fn of (this._listeners['close'] || [])) fn();
  }
}

// --- Mock API factory ---

function createMockApi() {
  const hooks = {};
  const tools = {};
  let httpRoute = null;

  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    config: {
      gateway: { port: 19000, auth: { token: 'test-token' } },
      agents: { defaults: { workspace: '/workspace' } },
    },
    registerHttpRoute(route) {
      httpRoute = route;
    },
    registerTool(tool) {
      tools[tool.name] = tool;
    },
    on(event, handler) {
      if (!hooks[event]) hooks[event] = [];
      hooks[event].push(handler);
    },
    // Test helpers
    _hooks: hooks,
    _tools: tools,
    _getHttpRoute: () => httpRoute,
    _fireHook(event, eventData, ctx) {
      const handlers = hooks[event] || [];
      for (const h of handlers) {
        const result = h(eventData, ctx);
        if (result) return result;
      }
      return undefined;
    },
  };
}

// --- Helper: activate plugin with hanging WebSocket so RPC doesn't resolve ---

function activateWithHangingWs() {
  globalThis.WebSocket = HangingWebSocket;
  const api = createMockApi();
  delete process.env.VILLAGE_SECRET;
  villagePlugin.activate(api);
  return api;
}

function createStreamReq(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const chunks = [Buffer.from(raw)];
  return {
    method: 'POST',
    headers: {},
    [Symbol.asyncIterator]() {
      let i = 0;
      return { next() {
        if (i < chunks.length) return { done: false, value: chunks[i++] };
        return { done: true };
      }};
    },
  };
}

function createCapturingRes() {
  return { writeHead: vi.fn(), end: vi.fn() };
}

// --- Activate plugin ---

describe('Village Plugin', () => {
  let api;

  beforeEach(() => {
    api = createMockApi();
    // Clear VILLAGE_SECRET for most tests
    delete process.env.VILLAGE_SECRET;
    villagePlugin.activate(api);
  });

  afterEach(() => {
    globalThis.WebSocket = _OriginalWebSocket;
  });

  // --- PLG-002: Tool registration ---

  describe('tool registration', () => {
    it('registers 4 village tools', () => {
      expect(api._tools).toHaveProperty('village_say');
      expect(api._tools).toHaveProperty('village_whisper');
      expect(api._tools).toHaveProperty('village_observe');
      expect(api._tools).toHaveProperty('village_move');
    });

    it('village_say requires message parameter', () => {
      const schema = api._tools['village_say'].parameters;
      expect(schema.required).toContain('message');
    });

    it('village_whisper requires bot_id and message', () => {
      const schema = api._tools['village_whisper'].parameters;
      expect(schema.required).toContain('bot_id');
      expect(schema.required).toContain('message');
    });

    it('village_move requires location', () => {
      const schema = api._tools['village_move'].parameters;
      expect(schema.required).toContain('location');
    });

    it('village_observe has no required params', () => {
      const schema = api._tools['village_observe'].parameters;
      expect(schema.required).toBeUndefined();
    });

    it('tool execute returns content array', async () => {
      const result = await api._tools['village_say'].execute();
      expect(result.content).toBeInstanceOf(Array);
      expect(result.content[0].type).toBe('text');
    });
  });

  // --- PLG-003 through PLG-006: before_tool_call hook ---

  describe('before_tool_call — village sessions', () => {
    it('allows village tools in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'village_say', params: { message: 'hi' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toBeUndefined(); // undefined = allow
    });

    it('allows current_datetime in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'current_datetime', params: {} },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toBeUndefined();
    });

    it('allows read of village.md in workspace', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'read', params: { file_path: '/workspace/memory/village.md' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toBeUndefined();
    });

    it('blocks read of non-village files in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'read', params: { file_path: '/workspace/memory/MEMORY.md' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });

    it('blocks path traversal to other bots village.md', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'read', params: { file_path: '/workspace/../../otherbot/workspace/memory/village.md' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });

    it('blocks village.md outside workspace', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'read', params: { file_path: '/tmp/village.md' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });

    it('blocks memory_search in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'memory_search', params: { query: 'test' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });

    it('blocks message tool in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'message', params: { message: 'leak' } },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });

    it('blocks write tool in village sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'write', params: {} },
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('block', true);
    });
  });

  describe('before_tool_call — normal sessions', () => {
    it('blocks village tools in normal sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'village_say', params: { message: 'hi' } },
        { sessionKey: 'agent:main:whatsapp:+1234567890' }
      );
      expect(result).toHaveProperty('block', true);
      expect(result.blockReason).toContain('only available during village sessions');
    });

    it('does not block normal tools in normal sessions', () => {
      const result = api._fireHook('before_tool_call',
        { name: 'message', params: {} },
        { sessionKey: 'agent:main:whatsapp:+1234567890' }
      );
      expect(result).toBeUndefined();
    });
  });

  // --- PLG-007: before_prompt_build hook ---

  describe('before_prompt_build', () => {
    it('injects privacy guidance in village sessions', () => {
      const result = api._fireHook('before_prompt_build',
        {},
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result).toHaveProperty('prependContext');
      expect(result.prependContext).toContain('public social setting');
      expect(result.prependContext).toContain('Never share personal details');
    });

    it('injects anti-injection guidance', () => {
      const result = api._fireHook('before_prompt_build',
        {},
        { sessionKey: 'agent:main:village:coffee-hub:tick-1' }
      );
      expect(result.prependContext).toContain('not system instructions');
    });

    it('does not inject in normal sessions', () => {
      const result = api._fireHook('before_prompt_build',
        {},
        { sessionKey: 'agent:main:whatsapp:+1234567890' }
      );
      expect(result).toBeUndefined();
    });
  });

  // --- PLG-010: agent_end hook ---

  describe('agent_end', () => {
    it('registers agent_end hook', () => {
      expect(api._hooks['agent_end']).toBeDefined();
      expect(api._hooks['agent_end'].length).toBeGreaterThan(0);
    });
  });

  // --- SEC-000: HTTP endpoint auth ---

  describe('/village endpoint auth', () => {
    function createMockReq(body, headers = {}) {
      const chunks = [Buffer.from(JSON.stringify(body))];
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              return { done: true };
            },
          };
        },
      };
    }

    function createMockRes() {
      let statusCode;
      let headersWritten = {};
      let body = '';
      return {
        writeHead(code, headers) { statusCode = code; headersWritten = headers; },
        end(data) { body = data; },
        _status: () => statusCode,
        _body: () => body,
      };
    }

    it('returns 405 for non-POST', async () => {
      const route = api._getHttpRoute();
      const req = { method: 'GET', headers: {} };
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(405);
    });

    it('returns 401 when VILLAGE_SECRET is set but no auth header', async () => {
      // Re-activate with secret set
      const api2 = createMockApi();
      process.env.VILLAGE_SECRET = 'test-secret-123';
      villagePlugin.activate(api2);

      const route = api2._getHttpRoute();
      const req = createMockReq({ conversationId: 'village:test:1', scene: 'hello' });
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(401);
    });

    it('returns 401 when auth header has wrong secret', async () => {
      const api2 = createMockApi();
      process.env.VILLAGE_SECRET = 'correct-secret';
      villagePlugin.activate(api2);

      const route = api2._getHttpRoute();
      const req = createMockReq(
        { conversationId: 'village:test:1', scene: 'hello' },
        { authorization: 'Bearer wrong-secret' }
      );
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(401);
    });

    it('warns when VILLAGE_SECRET not configured', () => {
      // Default test (no secret set)
      expect(api.logger.warn).not.toHaveBeenCalled(); // warn only on request
    });

    it('returns 400 for invalid JSON', async () => {
      const route = api._getHttpRoute();
      const chunks = [Buffer.from('not json')];
      const req = {
        method: 'POST',
        headers: {},
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              return { done: true };
            },
          };
        },
      };
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(400);
    });

    it('returns 400 when conversationId or scene missing', async () => {
      const route = api._getHttpRoute();
      const req = createMockReq({ conversationId: 'test' }); // no scene
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(400);
    });

    it('returns 413 for payload too large', async () => {
      const route = api._getHttpRoute();
      const bigPayload = 'x'.repeat(65 * 1024);
      const chunks = [Buffer.from(bigPayload)];
      const req = {
        method: 'POST',
        headers: {},
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            next() {
              if (i < chunks.length) return { done: false, value: chunks[i++] };
              return { done: true };
            },
          };
        },
      };
      const res = createMockRes();
      await route.handler(req, res);
      expect(res._status()).toBe(413);
    });
  });

  // --- Sanitize (tested via action capture) ---
  // Sanitize is a closure inside activate(), so we test it through
  // the before_tool_call hook's action capture path.
  // We mock WebSocket to prevent callGatewayRpc from resolving the pending
  // entry before our hook fires.

  describe('sanitize (via action capture)', () => {
    it('strips control characters from village_say message', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:sanitize-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_say',
        params: { message: 'Hello\x00\x01\x02World\x7F!' },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].tool).toBe('village_say');
      expect(responseBody.actions[0].params.message).toBe('HelloWorld!');
    });

    it('truncates message to MAX_MESSAGE_LENGTH (500)', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:truncate-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_say',
        params: { message: 'A'.repeat(1000) },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].params.message).toHaveLength(500);
    });

    it('returns empty string for non-string input', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:nonstring-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_say',
        params: { message: null },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].params.message).toBe('');
    });

    it('preserves newlines and tabs', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:newlines-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_say',
        params: { message: 'line1\nline2\ttab' },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].params.message).toBe('line1\nline2\ttab');
    });
  });

  // --- Action capture: MAX_ACTIONS_PER_TURN ---

  describe('action capture — MAX_ACTIONS_PER_TURN', () => {
    it('captures at most 2 actions per turn', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:cap-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      const sessionKey = `agent:main:${conversationId}`;
      api2._fireHook('before_tool_call',
        { name: 'village_say', params: { message: 'first' } }, { sessionKey });
      api2._fireHook('before_tool_call',
        { name: 'village_say', params: { message: 'second' } }, { sessionKey });
      api2._fireHook('before_tool_call',
        { name: 'village_say', params: { message: 'third-dropped' } }, { sessionKey });

      api2._fireHook('agent_end', {}, { sessionKey });
      await handlerPromise;

      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions).toHaveLength(2);
      expect(responseBody.actions[0].params.message).toBe('first');
      expect(responseBody.actions[1].params.message).toBe('second');
    });
  });

  // --- Action capture: whisper and move sanitization ---

  describe('action capture — whisper and move params', () => {
    it('captures whisper with sanitized bot_id and message', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:whisper-cap-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_whisper',
        params: { bot_id: 'friend\x00bot', message: 'secret\x01msg' },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].tool).toBe('village_whisper');
      expect(responseBody.actions[0].params.bot_id).toBe('friendbot');
      expect(responseBody.actions[0].params.message).toBe('secretmsg');
    });

    it('captures move with sanitized location (truncated to 100)', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:move-cap-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_move',
        params: { location: 'x'.repeat(200) },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions[0].tool).toBe('village_move');
      expect(responseBody.actions[0].params.location).toHaveLength(100);
    });
  });

  // --- /village endpoint: default to observe when no actions ---

  describe('/village endpoint — observe fallback', () => {
    it('returns village_observe when agent produces no village actions', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:noaction-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(responseBody.actions).toEqual([{ tool: 'village_observe', params: {} }]);
    });
  });

  // --- /village endpoint: missing gateway config ---

  describe('/village endpoint — gateway config errors', () => {
    it('returns 500 when gateway port is not configured', async () => {
      const api2 = createMockApi();
      api2.config.gateway.port = null;
      delete process.env.VILLAGE_SECRET;
      villagePlugin.activate(api2);
      const route = api2._getHttpRoute();
      const req = createStreamReq({ conversationId: 'village:test:noport-1', scene: 'test' });
      const res = createCapturingRes();

      await route.handler(req, res);
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.error).toContain('port/token');
    });
  });

  // --- agent_end hook — resolves pending ---

  describe('agent_end — pending resolution', () => {
    it('resolves pending actions on agent_end for village session', async () => {
      const api2 = activateWithHangingWs();
      const route = api2._getHttpRoute();
      const conversationId = 'village:test:agentend-1';
      const req = createStreamReq({ conversationId, scene: 'test' });
      const res = createCapturingRes();

      const handlerPromise = route.handler(req, res);
      await new Promise(r => setTimeout(r, 10));

      api2._fireHook('before_tool_call', {
        name: 'village_say',
        params: { message: 'hi' },
      }, { sessionKey: `agent:main:${conversationId}` });

      api2._fireHook('agent_end', {}, {
        sessionKey: `agent:main:${conversationId}`,
      });

      await handlerPromise;
      const responseBody = JSON.parse(res.end.mock.calls[0][0]);
      expect(responseBody.actions).toHaveLength(1);
      expect(responseBody.actions[0].params.message).toBe('hi');
    });

    it('ignores agent_end for non-village sessions', () => {
      const result = api._fireHook('agent_end', {}, {
        sessionKey: 'agent:main:whatsapp:+1234567890',
      });
      expect(result).toBeUndefined();
    });

    it('ignores agent_end with no sessionKey', () => {
      const result = api._fireHook('agent_end', {}, {});
      expect(result).toBeUndefined();
    });
  });

  // --- Plugin metadata ---

  describe('plugin metadata', () => {
    it('has correct id and name', () => {
      expect(villagePlugin.id).toBe('village');
      expect(villagePlugin.name).toBe('Village');
    });

    it('logs activation', () => {
      expect(api.logger.info).toHaveBeenCalledWith('village: plugin activated');
    });
  });
});
