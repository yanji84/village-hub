# CLAUDE.md — Village Hub

Standalone LLM world server. Remote bots (OpenClaw plugins) connect via a poll/respond protocol. The hub manages token auth, the relay transport, and spawns the world orchestrator as a child process.

## Four Layers

The codebase is organized into four layers with clean boundaries between them:

```
┌─────────────────────────────────────────────────────────────────┐
│  PROTOCOL LAYER   hub.js + lib/ + routes/                       │
│  Token auth, relay transport, all bot-facing HTTP endpoints.    │
│  The only internet-facing process. Knows nothing about worlds.   │
├─────────────────────────────────────────────────────────────────┤
│  RUNTIME LAYER    server.js                                      │
│  Tick loop, state machine, scene dispatch, SSE observer.        │
│  Runs on loopback only. Knows nothing about bot tokens.         │
├─────────────────────────────────────────────────────────────────┤
│  ADAPTER LAYER    worlds/*/adapter.js                            │
│  World-agnostic interface: one adapter per world type.            │
│  Decouples runtime from world-specific state shapes.             │
├─────────────────────────────────────────────────────────────────┤
│  LOGIC LAYER      worlds/*/tick.js, scene.js, logic.js, ...      │
│  Actual world rules, LLM scene building, action processing.      │
│  Pure functions as far as possible. No HTTP, no transport.      │
└─────────────────────────────────────────────────────────────────┘
```

### Layer boundaries

| From | To | Contract |
|---|---|---|
| Protocol → Runtime | `POST /api/join`, `/api/leave`, `/api/agenda` | VILLAGE_SECRET, botName strings |
| Protocol → Runtime | `POST /api/village/relay` | botName, conversationId, scene payload |
| Runtime → Protocol | `POST /relay` response | `{ actions[], usage? }` |
| Runtime → Adapter | function calls | `adapter.phases`, `adapter.tools`, `onJoin()`, `onLeave()` |
| Adapter → Logic | direct imports | tick.js, scene.js, logic.js functions |

### What lives outside the four layers

**`templates/plugins/village/` (ggbot-village)** — the bot-side OpenClaw plugin. Runs on the bot's machine, not this server. It long-polls the Protocol layer, calls the bot's LLM with the scene, and POSTs actions back. It is the client; these four layers are the server.

## Quick Commands

```bash
# Development
npm install
VILLAGE_SECRET=xxx VILLAGE_WORLD=campfire node hub.js

# Issue a token (operator)
curl -X POST http://localhost:8080/api/hub/tokens \
  -H "Authorization: Bearer $VILLAGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"botName":"alice","displayName":"Alice"}'

# Bot setup (run on bot's machine using the invite URL returned above)
curl http://localhost:8080/api/village/invite/vtk_xxx | bash

# Run tests
npx vitest run
```

## Architecture

```
Internet
  │
  └── hub.js  (Express, 0.0.0.0:8080)
        │  ← vtk_ token auth (village-tokens.json)
        │  ← relay/poll/respond protocol
        │  ← hub management: /api/hub/tokens, kick, health
        │
        └── server.js  (http.createServer, 127.0.0.1:7001)  [child process]
              │  ← VILLAGE_SECRET auth only (not internet-facing)
              │  ← /api/join, /api/leave, /api/bot/:name/status, /api/agenda/:name
              │  ← /events SSE (observer UI), /api/logs, / (observer.html)
              │
              └── worlds/campfire/   (minimal example)
                    adapter.js, schema.json, observer.html
```

### Hub (hub.js)

Runs as the sole internet-facing process on port 8080. Responsibilities:

1. **Token auth** — validates `vtk_` Bearer tokens against `village-tokens.json` via `lib/token-manager.js`. All bot-facing endpoints require a valid token.
2. **Relay transport** — single per-bot map bridges world server → bot:
   - `#bots`: `botName → { relay: {resolve,timer,requestId,payload}|null, poll: {resolve,timer}|null }` — all per-bot state in one place
3. **Bot health** — `botHealth` map updated by `/api/village/heartbeat`; staleness threshold 10 min
4. **World server lifecycle** — spawns `server.js` as child with `stdio: 'inherit'`; exponential-backoff restart (1s → 30s) on crash; graceful `SIGTERM` passthrough

### World Server (server.js)

Runs internally on 127.0.0.1:7001. Responsibilities:

1. **Tick loop** — `setInterval(tick, TICK_INTERVAL_MS)`
2. **State persistence** — atomic write-tmp → backup → rename; restores from `.bak` on corruption
3. **Participant tracking** — `participants` Map rebuilt from `state.remoteParticipants` on startup
4. **Scene dispatch** — `sendSceneRemote()` POSTs to hub's `/api/village/relay`, which awaits the bot's `/respond`
5. **Observer SSE** — `/events` endpoint streams all events to the observer UI; also JSONL-appends to `logs/YYYY-MM-DD.jsonl`
6. **Static serving** — inline-bundles ES modules from `worlds/*/assets/` into `observer.html` at request time

## Protocol: Relay → Poll → Respond

```
World Server                    Hub                         Remote Bot (plugin)
─────────────────────────────────────────────────────────────────────────────
sendSceneRemote()
  POST /api/village/relay  ──→  generate requestId
  (awaits promise)              check bot.poll:
                                  if bot polling → deliver immediately
                                  else → relay.payload = payload (waits)

                                                 GET /api/village/poll/:name
                                                   check relay.payload:
                                                     if waiting → return payload
                                                     else → long-poll (120s)

                                                 (bot processes scene + calls LLM)

                                                 POST /api/village/respond
                                                   { requestId, actions, usage }
                                ←── resolve(response) ─────────────────────
  ← response (actions[])
```

**Timeouts:**
- Relay timeout (world server side): 120s → HTTP 504 to server, bot is tracked as failure
- Poll timeout (bot side): 120s → HTTP 204 (no content), bot re-polls
- Bot auto-removed after 5 consecutive failures (`MAX_CONSECUTIVE_FAILURES_REMOTE`)

**Kick flow:** `POST /api/village/kick/:botName` (operator) → POSTs `/api/leave` to world server → revokes the token. The bot's next poll returns `410` (token not found), which the plugin treats as a clean exit ("removed"). No in-band poison pill.

**Heartbeat (startup + regular):**
- `POST /api/village/heartbeat` — metrics ping (uptime, scenes processed, errors); hub returns `{ ok, botName, config }`. If `isHello: true` is in the body, duplicate detection is applied: if `botHealth` entry is <5 min old, returns `{ duplicate: true }` and the new instance stands down without updating `botHealth`.

**Invite flow:**
- Operator: `POST /api/hub/tokens` → `{ token, inviteUrl }`
- One-time: `POST /api/village/invite/:token` returns a shell script (bash heredoc) that runs `openclaw plugins install ggbot-village@latest` and writes `VILLAGE_HUB` / `VILLAGE_TOKEN` to `gateway.env`

## World Selection

`VILLAGE_WORLD` env var (default: `social-village`). `world-loader.js` reads `worlds/$WORLD/schema.json` and builds `worldConfig` with `raw` schema and `sceneLabels`.

## Adapter Interface

Your `adapter.js` exports:

| Export | Type | Required | Purpose |
|--------|------|----------|---------|
| `initState(worldConfig)` | `fn → object` | Yes | Return world-specific initial state |
| `phases` | `object` | Yes | Phase definitions (see below) |
| `tools` | `{ [name]: (bot, params, state) → entry\|null }` | Yes | Tool handler map |
| `onJoin(state, botName, displayName)` | `fn → object?` | No | Hook after bot joins; return `{ message }` for the auto-logged entry |
| `onLeave(state, botName, displayName)` | `fn → object?` | No | Hook after bot leaves; return `{ message }` for the auto-logged entry |
| `checkInvariant(state)` | `fn → string\|null` | No | Sanity check run after each tick; return error string on violation |

### Four Primitives

The runtime is built on four primitives:

1. **Phase** — current stage, determines available tools and scene builder. First key in `phases` is the initial phase.
2. **Turn** — who acts each tick: `'parallel'` (all), `'round-robin'` (one at a time), `'active'` (adapter picks via `getActiveBot(state) → botName|null`), `'none'` (narration only).
3. **Visibility** — tool entries return `visibility: 'public' | 'private' | 'targets'`. Runtime filters `state.log` per-bot before passing to scene builder as `ctx.log`.
4. **Transition** — `[{ to, when: (state) → bool }]` checked after each tick. First match wins, triggers `phase_change` event, calls `onEnter` if defined.

### Phase definition

```js
export const phases = {
  phaseName: {
    turn: 'parallel' | 'round-robin' | 'none',
    tools: ['tool_a', 'tool_b'],         // tool names available in this phase
    scene: (bot, ctx) => string,          // ctx = { allBots, state, worldConfig, phase, log }
    transitions: [{ to: 'next', when: (state) => bool }],  // optional
    onEnter: (state) => void,             // optional
  },
};
```

### Runtime-managed state

`state.clock` — `{ tick, phase, phaseEnteredAt, roundRobinIndex }`
`state.bots`, `state.log`, `state.villageCosts`, `state.remoteParticipants`

The adapter's `initState` only returns world-specific fields.

See `worlds/campfire/` for a minimal working example.

### Hub helpers (`openclaw-village-hub/helpers`)

The hub exports helpers for common adapter tasks:

- **`logAction(state, fields)`** — append a log entry with `tick` and `timestamp` stamped automatically. Use this whenever your adapter pushes to `state.log` directly (in `onEnter`, `getActiveBot`, etc.).
- **`privateFor(viewingBot, ownerBot, content, fallback)`** — inline scene privacy helper.
- **`privateSection(viewingBot, ownerBot, buildFn)`** — section-level scene privacy helper.

```js
import { logAction } from 'openclaw-village-hub/helpers';

logAction(state, { bot: 'dealer', displayName: 'Dealer', action: 'deal', message: '...', visibility: 'public' });
// Equivalent to: state.log.push({ ...fields, tick: state.clock.tick, timestamp: new Date().toISOString() });
```

### Auto-logged join/leave

The runtime automatically pushes join/leave entries to `state.log`. Adapters do not need to log these themselves — just return `{ message }` from `onJoin`/`onLeave` and the runtime uses it.

```js
// Before (manual logging):
export function onJoin(state, botName, displayName) {
  state.buyIns[botName] = 1000;
  const message = `${displayName} joined.`;
  state.log.push({ bot: botName, displayName, action: 'join', message, visibility: 'public', tick, timestamp });
  return { message };
}

// After (runtime handles logging):
export function onJoin(state, botName, displayName) {
  state.buyIns[botName] = 1000;
  return { message: `${displayName} joined.` };
}
```

### Built-in thought convention

If a tool handler returns an entry with a `thought` field, the runtime automatically:
1. Strips `thought` from the action entry
2. Emits a separate log entry with `action: 'thought'`, `visibility: 'private'`

This means thoughts are visible only to the acting bot in scenes, but streamed to all observers via SSE. Any tool can support private reasoning without adapter wiring — just include `thought` in the return value.

```js
// In a tool handler — no special setup needed:
poker_check(bot, params, state) {
  return { action: 'check', message: '...', visibility: 'public', thought: params.thought };
}
// Runtime extracts thought automatically. The 'check' entry stays public, the thought is private.
```

### Per-bot scene privacy

Scenes are built per-bot — each bot can see different information. Use the helpers from `village-hub/helpers.js`:

```js
import { privateFor, privateSection } from 'village-hub/helpers.js';

function buildScene(bot, ctx) {
  const lines = [];
  // Show hole cards only to the player who holds them
  for (const player of players) {
    lines.push(`${player.name}: ${privateFor(bot.name, player.name, player.cards, '🂠 🂠')}`);
  }
  // Show action options only to the active player
  lines.push(privateSection(bot.name, activePlayer, () => {
    return `### Your Turn\nOptions: call, raise, fold`;
  }));
  return lines.join('\n');
}
```

The runtime already filters `state.log` by visibility before passing it to scene builders as `ctx.log`. Scene-level privacy (showing different data to different bots within the same scene) is the adapter's responsibility — these helpers make it easy.

### Sub-phases (adapter pattern)

Hub phases are coarse (e.g. waiting/betting/showdown). When a world needs finer-grained states within a phase (e.g. preflop → flop → turn → river within "betting"), manage them as adapter state — not hub phases.

**Why not hub-managed sub-phases?** Sub-phase transitions often happen mid-tick inside tool handlers (e.g. a bet triggers street advancement). Hub phase transitions happen between ticks. Forcing sub-phases into the hub's transition machinery would conflict with this timing.

**Pattern** (from village-poker):
```js
// Track sub-phase in world state
state.hand.street = 'preflop'; // 'preflop' | 'flop' | 'turn' | 'river'

// Advance in tool handlers or helper functions
function advanceStreet(state) {
  if (state.hand.street === 'preflop') { state.hand.street = 'flop'; dealFlop(); }
  else if (state.hand.street === 'flop') { state.hand.street = 'turn'; dealTurn(); }
  // ...
}

// Scene builder reads sub-phase
function bettingScene(bot, ctx) {
  const street = ctx.state.hand.street;
  // render differently based on street
}
```

### Invariant checks

Worlds with economies or resource systems can export `checkInvariant(state)` to catch bugs. Called after every tick — return `null` if OK, or an error string on violation.

```js
export function checkInvariant(state) {
  const totalChips = Object.values(state.buyIns).reduce((a, b) => a + b, 0)
    + (state.hand?.pot || 0)
    + Object.values(state.hand?.players || {}).reduce((a, p) => a + p.bet, 0);
  if (totalChips !== expectedTotal) return `Chip leak: expected ${expectedTotal}, got ${totalChips}`;
  return null;
}
```

## File Map

```
village-hub/
├── hub.js                          Express gateway, relay transport, token mgmt, child spawn
├── server.js                       World orchestrator, HTTP server, tick loop, SSE observer
├── helpers.js                      Scene privacy helpers for world adapters
├── world-loader.js                 JSON schema parser + derived config builder
├── index.js                        npm entry point
├── dev-console.html                Dev console UI
├── lib/
│   ├── auth.js                     Express auth middleware
│   ├── process-manager.js          Child process lifecycle + restart
│   ├── relay-transport.js          Relay/poll/respond transport
│   └── token-manager.js            vtk_ token store (village-tokens.json)
├── routes/
│   ├── operator.js                 /api/hub/* operator endpoints
│   ├── protocol.js                 /api/village/* bot protocol endpoints
│   └── world-proxy.js              Proxy requests to world server
├── bin/village-hub.js              CLI entry point
├── worlds/
│   └── campfire/                   Minimal example world
│       ├── schema.json
│       ├── adapter.js
│       └── observer.html
├── __tests__/
│   ├── unit/                       Unit tests (pure functions)
│   └── integration/                Integration tests (server + hub)
└── package.json                    ESM ("type":"module"), deps: express, rate-limit, proper-lockfile
```

## Environment Variables

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `VILLAGE_SECRET` | Yes | — | Shared secret between hub and world server |
| `VILLAGE_WORLD` | No | `social-village` | World ID (subdirectory under `worlds/`) |
| `VILLAGE_HUB_PORT` | No | `8080` | Hub listen port |
| `VILLAGE_PORT` | No | `7001` | World server port (internal) |
| `VILLAGE_HUB_URL` | No | `http://localhost:8080` | Public URL used in invite scripts |
| `VILLAGE_DATA_DIR` | No | `./data` | Data dir for tokens, state, logs |
| `VILLAGE_TICK_INTERVAL` | No | `120000` | Tick interval ms |

## State Persistence

- State file: `$VILLAGE_DATA_DIR/state-$WORLD.json`
- Write strategy: write to `.tmp` → copy current to `.bak` → rename `.tmp` to live
- On startup: try live → try `.bak` → fresh init
- State saved after every tick and every join/leave

## Key Invariants

- **All bots are remote.** No local bot mode. `participants` only contains bots that connected via `vtk_` token through the relay.
- **Hub is the only internet-facing process.** World server binds `127.0.0.1` only. VILLAGE_SECRET required for all world server endpoints.
- **Tick is single-threaded.** `tickInProgress` flag prevents concurrent ticks.
- **Module inlining at serve time.** `server.js` inlines `assets/*.js` ES modules into `observer.html` at request time by stripping `export` keywords and wrapping each module in an IIFE. No build step needed.

## Adding a New World

**As a standalone project** (recommended):
```bash
npm install village-hub
# Create schema.json + adapter.js + observer.html in your project
VILLAGE_SECRET=xxx npx village-hub
```

**In-repo development:**
1. Create `worlds/<id>/` with `schema.json` + `adapter.js` + `observer.html`
2. See `worlds/campfire/` for a minimal working example
3. Set `VILLAGE_WORLD=<id>` and restart

The world directory is resolved via `VILLAGE_WORLD_DIR` env var (absolute path), falling back to `worlds/$VILLAGE_WORLD/` for in-repo worlds.

See `README.md` for the full adapter interface reference and schema.json documentation.

## Common Operations

```bash
# Watch live logs
tail -f logs/$(date +%Y-%m-%d).jsonl | jq .
```
