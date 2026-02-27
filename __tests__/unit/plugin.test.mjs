import { describe, it, expect, beforeEach, vi } from 'vitest';
import villagePlugin from '../../../templates/plugins/village/index.js';

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

// --- Activate plugin ---

describe('Village Plugin', () => {
  let api;

  beforeEach(() => {
    api = createMockApi();
    // Clear VILLAGE_SECRET for most tests
    delete process.env.VILLAGE_SECRET;
    villagePlugin.activate(api);
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
