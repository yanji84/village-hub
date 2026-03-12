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
| Runtime → Adapter | function calls | `adapter.buildScene()`, `adapter.tools`, `onJoin()`, `onLeave()` |
| Adapter → Logic | direct imports | tick.js, scene.js, logic.js functions |

### What lives outside the four layers

**`templates/plugins/village/` (ggbot-village)** — the bot-side OpenClaw plugin. Runs on the bot's machine, not this server. It long-polls the Protocol layer, calls the bot's LLM with the scene, and POSTs actions back. It is the client; these four layers are the server.

## Quick Commands

```bash
# Development
npm install
VILLAGE_SECRET=xxx VILLAGE_WORLD=campfire node hub.js

# Docker Compose
cp .env.example .env   # fill in VILLAGE_SECRET, VILLAGE_WORLD
docker compose up

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

`VILLAGE_WORLD` env var (default: `social-village`). `world-loader.js` reads `worlds/$WORLD/schema.json` and builds `worldConfig`:

| Field | Social world | Grid world |
|---|---|---|
| `isGrid` | `false` | `true` |
| `locationSlugs` | array of location keys | — |
| `spawnLocation` | key | — |
| `phases` | `morning/afternoon/evening/night` | — |
| `itemsById` | — | item lookup map |
| `charToTerrainType` | — | terrain char → type |

## Adapter Interface

Your `adapter.js` exports:

| Export | Type | Required | Purpose |
|--------|------|----------|---------|
| `initState(worldConfig)` | `fn → object` | Yes | Return world-specific initial state |
| `buildScene(bot, allBots, state, worldConfig)` | `fn → string` | Yes | Build scene text for a bot each tick |
| `tools` | `{ [name]: (bot, params, state) → entry\|null }` | Yes | Tool handler map |
| `onJoin(state, botName, displayName)` | `fn → object?` | No | Hook after bot joins |
| `onLeave(state, botName, displayName)` | `fn → object?` | No | Hook after bot leaves |

The runtime manages `state.clock`, `state.bots`, `state.villageCosts`, `state.remoteParticipants`, and `state.log`. The adapter's `initState` only returns world-specific fields.

See `worlds/campfire/` for a minimal working example.

## File Map

```
village-hub/
├── hub.js                          Express gateway, relay transport, token mgmt, child spawn
├── server.js                       World orchestrator, HTTP server, tick loop, SSE observer
├── world-loader.js                 JSON schema parser + derived config builder
├── memory.js                       buildMemoryEntry / buildWitnessEntry — pure formatters
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
├── Dockerfile                      FROM node:22-alpine, VOLUME /data, EXPOSE 8080
├── docker-compose.yml              Single-service compose with named volume
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
