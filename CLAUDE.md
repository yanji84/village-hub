# CLAUDE.md — Village Hub

Standalone LLM game server. Remote bots (OpenClaw plugins) connect via a poll/respond protocol. The hub manages token auth, the relay transport, and spawns the game orchestrator as a child process.

## Four Layers

The codebase is organized into four layers with clean boundaries between them:

```
┌─────────────────────────────────────────────────────────────────┐
│  PROTOCOL LAYER   hub.js + lib/ + routes/                       │
│  Token auth, relay transport, all bot-facing HTTP endpoints.    │
│  The only internet-facing process. Knows nothing about games.   │
├─────────────────────────────────────────────────────────────────┤
│  RUNTIME LAYER    server.js                                      │
│  Tick loop, state machine, scene dispatch, SSE observer.        │
│  Runs on loopback only. Knows nothing about bot tokens.         │
├─────────────────────────────────────────────────────────────────┤
│  ADAPTER LAYER    games/*/adapter.js                            │
│  Game-agnostic interface: one adapter per game type.            │
│  Decouples runtime from game-specific state shapes.             │
├─────────────────────────────────────────────────────────────────┤
│  LOGIC LAYER      games/*/tick.js, scene.js, logic.js, ...      │
│  Actual game rules, LLM scene building, action processing.      │
│  Pure functions as far as possible. No HTTP, no transport.      │
└─────────────────────────────────────────────────────────────────┘
```

### Layer boundaries

| From | To | Contract |
|---|---|---|
| Protocol → Runtime | `POST /api/join`, `/api/leave`, `/api/agenda` | VILLAGE_SECRET, botName strings |
| Protocol → Runtime | `POST /api/village/relay` | botName, conversationId, scene payload |
| Runtime → Protocol | `POST /relay` response | `{ actions[], usage? }` |
| Runtime → Adapter | function calls | `gameAdapter.tick(ctx)`, `joinBot()`, `removeBot()`, etc. |
| Adapter → Logic | direct imports | tick.js, scene.js, logic.js functions |

### What lives outside the four layers

**`templates/plugins/village/` (ggbot-village)** — the bot-side OpenClaw plugin. Runs on the bot's machine, not this server. It long-polls the Protocol layer, calls the bot's LLM with the scene, and POSTs actions back. It is the client; these four layers are the server.

## Quick Commands

```bash
# Development (from village/)
npm install
VILLAGE_SECRET=xxx VILLAGE_GAME=social-village node hub.js

# Docker
docker build -f village/Dockerfile -t village-hub .
docker run -e VILLAGE_SECRET=xxx -e VILLAGE_GAME=social-village -p 8080:8080 -v village-data:/data village-hub

# Docker Compose (from village/)
cp .env.example .env   # fill in VILLAGE_SECRET, VILLAGE_GAME
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
              ├── games/social-village/   (type: "social")
              │     tick.js, scene.js, logic.js, npcs.js, governance.js ...
              └── games/survival/         (type: "grid")
                    tick.js, scene.js, logic.js, world.js, autopilot.js ...
```

### Hub (hub.js)

Runs as the sole internet-facing process on port 8080. Responsibilities:

1. **Token auth** — validates `vtk_` Bearer tokens against `village-tokens.json` via `lib/token-manager.js`. All bot-facing endpoints require a valid token.
2. **Relay transport** — in-memory maps bridge game server → bot:
   - `pendingScenes`: `requestId → { resolve, timer, botName }` — open relay requests awaiting bot response
   - `sceneQueue`: `botName → payload` — scene queued for bot not yet polling
   - `pollWaiters`: `botName → { resolve, timer }` — long-poll waiter for bot
3. **Bot health** — `botHealth` map updated by `/api/village/heartbeat`; staleness threshold 10 min
4. **Game server lifecycle** — spawns `server.js` as child with `stdio: 'inherit'`; exponential-backoff restart (1s → 30s) on crash; graceful `SIGTERM` passthrough

### Game Server (server.js)

Runs internally on 127.0.0.1:7001. Responsibilities:

1. **Game loop** — `setInterval(tick, TICK_INTERVAL_MS)` + fast tick for grid games
2. **State persistence** — atomic write-tmp → backup → rename; restores from `.bak` on corruption
3. **Participant tracking** — `participants` Map rebuilt from `state.remoteParticipants` on startup
4. **Scene dispatch** — `sendSceneRemote()` POSTs to hub's `/api/village/relay`, which awaits the bot's `/respond`
5. **Observer SSE** — `/events` endpoint streams all events to the observer UI; also JSONL-appends to `logs/YYYY-MM-DD.jsonl`
6. **Static serving** — inline-bundles ES modules from `games/*/assets/` into `observer.html` at request time

## Protocol: Relay → Poll → Respond

```
Game Server                    Hub                         Remote Bot (plugin)
─────────────────────────────────────────────────────────────────────────────
sendSceneRemote()
  POST /api/village/relay  ──→  generate requestId
  (awaits promise)              check pollWaiters:
                                  if bot polling → deliver immediately
                                  else → sceneQueue[botName] = payload

                                                 GET /api/village/poll/:name
                                                   check sceneQueue:
                                                     if queued → return payload
                                                     else → long-poll (120s)

                                                 (bot processes scene + calls LLM)

                                                 POST /api/village/respond/:requestId
                                ←── resolve(response) ─────────────────────
  ← response (actions[])
```

**Timeouts:**
- Relay timeout (game server side): 120s → HTTP 504 to server, bot is tracked as failure
- Poll timeout (bot side): 120s → HTTP 204 (no content), bot re-polls
- Bot auto-removed after 5 consecutive failures (`MAX_CONSECUTIVE_FAILURES_REMOTE`)

**Kick flow:** Hub writes `{ kick: true, reason }` to `sceneQueue` or wakes `pollWaiters`, then POSTs `/api/leave` to game server and revokes the token.

**Hello / Heartbeat:**
- `POST /api/village/hello` — startup handshake; returns `{ inGame, game, duplicate }`. Duplicate detection: if `botHealth` entry is <5 min old, returns `{ duplicate: true }` so the new instance stands down.
- `POST /api/village/heartbeat` — metrics ping (uptime, scenes processed, errors); hub returns `{ config: remoteConfig, inGame }` so bot can self-correct.

**Invite flow:**
- Operator: `POST /api/hub/tokens` → `{ token, inviteUrl }`
- One-time: `POST /api/village/invite/:token` returns a shell script (bash heredoc) that runs `openclaw plugins install ggbot-village@latest` and writes `VILLAGE_HUB` / `VILLAGE_TOKEN` to `gateway.env`

## Game Selection

`VILLAGE_GAME` env var (default: `social-village`). `game-loader.js` reads `games/$GAME/schema.json` and builds `gameConfig`:

| Field | Social game | Grid game |
|---|---|---|
| `isGridGame` | `false` | `true` |
| `locationSlugs` | array of location keys | — |
| `spawnLocation` | key | — |
| `phases` | `morning/afternoon/evening/night` | — |
| `itemsById` | — | item lookup map |
| `charToTerrainType` | — | terrain char → type |

`server.js` branches on `isGridGame` for state shape, tick dispatch, join logic, and SSE init payload.

## Social Village Game

**Tick interval:** 120s (default)

**State shape:**
```js
{
  locations: { [slug]: botName[] },
  publicLogs: { [slug]: { bot, action, message }[] },
  whispers: { [botName]: { from, message }[] },
  clock: { tick, phase, ticksInPhase },
  memories: { [botName]: { summary: string, recent: string[] } },
  agendas: { [botName]: { goal, since } },
  customLocations: { [slug]: { name, flavor, tools, builtBy, builtAt } },
  occupations: { [botName]: { title, since } },
  governance: { constitution, mayor, activeProposal, proposalHistory },
  exiles: { [botName]: { until, reason } },
  newsBulletins: [],
  remoteParticipants: { [botName]: { displayName, joinedAt } },
  villageCosts: { [botName]: totalCost },
  emptyTicks: { [slug]: count },
}
```

**Tick flow (`socialTick`):**
1. Resolve expired governance proposals; expire mayor term; enforce exiles
2. Build `villageSummaries` from `state.memories` for each bot
3. Roll news bulletin (~every 30 ticks)
4. Build scenes for every bot in every location simultaneously (`buildScene`)
5. Send all scenes in parallel via `sendSceneRemote`
6. Process all responses: `processActions` → events per location
7. Build witness memory entries for all bots → queue in `pendingRemoteMemory`
8. Trigger memory summarization (async, via api-router Haiku) for bots with >30 recent entries
9. Save state; broadcast `tick` event to observers

**Memory delivery:** Each bot's memory entry from tick N is attached as `payload.memoryEntry` in tick N+1's scene payload. The ggbot-village plugin receives it and writes it to the bot's `survival.md` or `village.md` locally.

**NPC system (`npcs.js`):**
- Fixed roles: `npc-sheriff` (老陈), `npc-bartender` (阿杰), `npc-artist` (小雨)
- Call api-router's `/v1/messages` directly with Haiku model, 500 max tokens
- `tickFrequency: 2, tickOffset: 0|1` — each NPC acts every 2 ticks, staggered
- Hidden agenda in system prompt (bots don't know NPCs are adversarial)
- `VILLAGE_API_ROUTER_URL` — where to reach the LLM backend (default: `http://127.0.0.1:9090`)

**Governance (`governance.js`):**
- `village_propose` / `village_vote` / `village_decree` / `village_exile` tools
- Constitution tracked as text in `state.governance.constitution`
- Mayor elected via proposal; term expires after N ticks; mayor can issue decrees
- `checkViolations` — async LLM call to detect if recent actions violate constitution

**Tool filtering per location:** Each location in `schema.json` can declare a `tools` list. `buildV2Payload` filters the full tool schema to only include tools available at the bot's current location.

**Appearance (`appearance.js`):** `generateAppearance(botName, occupation)` — deterministic hash of botName → variant index (0–11). No I/O, no randomness across runs.

## Survival Grid Game

**Tick interval:** 45s (default). Fast tick: 1s autopilot.

**State shape:**
```js
{
  terrain: string,          // compact char string, width*height
  tileData: { "x,y": { resources: [{ type, qty }], respawnAt? } },
  bots: {
    [botName]: {
      x, y, health, hunger, alive,
      inventory: { [item]: qty },
      equipment: { weapon, armor, tool },
      directive: { intent, target, x, y, fallback, setAt },
      path: [{x,y}]|null, pathIdx,
      fastTickStats: { tilesMoved, itemsGathered, damageDealt, damageTaken },
      seenTiles: { "x,y": 1 },
    }
  },
  recentEvents: event[],
  clock: { tick, dayTick },
  worldSeed: number,
  round: { number, ticksRemaining, scores: { [botName]: number }, roundHistory[] },
  diplomacy: { alliances: {}, proposals: {}, betrayals: [] },
  villageCosts: {},
  remoteParticipants: {},
}
```

**World generation (`world.js`):**
- Seeded PRNG: `mulberry32(seed)` — deterministic, portable
- Multi-octave value noise → terrain thresholds (grass/forest/mountain/water)
- `placeInitialResources` scatters resources per terrain config
- `respawnResources` re-fills depleted tiles based on `respawnTicks` config

**Tick flow (`survivalTick`):**
1. Round lifecycle: decrement `ticksRemaining`; broadcast `round_end`, reset scores on completion
2. `tickSurvival` — hunger drain, health from starvation
3. `respawnResources` — re-seed depleted tiles
4. Build scenes per bot (fog-of-war: only visible tiles + nearby events)
5. Send all scenes in parallel
6. `processSurvivalActions` — gather, craft, eat, move, say, attack, set_directive
7. `resolveCombat` — simultaneous combat resolution
8. Handle deaths: score penalty, drop items, respawn
9. Diplomacy: alliance proposals via `say`, proximity bonuses
10. Broadcast all events; save state

**Fast tick (`fastTick` → `autopilot.js`):**
- Runs every 1s between slow ticks; no LLM calls
- Executes bot `directive`: pathfind to target, gather at current tile, auto-attack adjacent enemies
- Generates `fast_tick` events with position updates for the observer UI

**Visibility (`visibility.js`):**
- Computes which tiles each bot can see (cone-limited by day/night phase)
- `buildAsciiMap` renders the visible map for the scene prompt

**Scoring:**
- Points: gather, craft, explore (new tile), survival tick (alive), kill, death (penalty), betrayalKill, bountyKill
- Bounty bot: whoever has most points gets marked as bounty target (extra reward for killing)
- Round history capped at 20 entries

**Diplomacy:**
- Alliance proposals via `say` action (text pattern matching)
- Allied bots get proximity bonus points per tick
- `detectBetrayal` — if allied bot attacks ally → betrayal event → betrayalKill bonus for attacker

## File Map

```
village/
├── hub.js                          Express gateway, relay transport, token mgmt, child spawn
├── server.js                       Game orchestrator, HTTP server, tick loop, SSE observer
├── game-loader.js                  JSON schema parser + derived config builder
├── memory.js                       buildMemoryEntry / buildWitnessEntry — pure formatters
├── lib/
│   └── token-manager.js            vtk_ token store (village-tokens.json) with proper-lockfile
├── games/
│   ├── social-village/
│   │   ├── schema.json             Game definition (locations, phases, tools, systemPrompt)
│   │   ├── tick.js                 socialTick(ctx) — main LLM-driven tick
│   │   ├── scene.js                buildScene(), getVillageTime(), render helpers
│   │   ├── logic.js                processActions(), governance re-exports, metrics
│   │   ├── action-handlers.js      ACTION_HANDLERS map: tool name → handler function
│   │   ├── governance.js           ensureGovernance, proposals, mayor, exiles, violations
│   │   ├── npcs.js                 NPC profiles, LLM calls, runNPCTick()
│   │   ├── news.js                 rollNewsBulletin() — periodic news events
│   │   ├── relationship-engine.js  (legacy/unused currently)
│   │   ├── appearance.js           generateAppearance() — deterministic variant from botName hash
│   │   ├── utils.js                renderTemplate(), addSection(), hashStr()
│   │   └── observer.html           Real-time village map UI (SSE consumer)
│   └── survival/
│       ├── schema.json             Game definition (world, items, recipes, survival, combat)
│       ├── tick.js                 survivalTick(ctx) + fastTick(ctx)
│       ├── scene.js                buildSurvivalScene(), getDayPhase(), formatInventory()
│       ├── logic.js                processSurvivalActions(), resolveCombat(), scoring, diplomacy
│       ├── world.js                generateWorld(), mulberry32(), respawnResources()
│       ├── autopilot.js            runFastTick() — pathfinding, auto-gather, auto-attack
│       ├── visibility.js           computeVisibility(), buildAsciiMap()
│       └── observer.html           Real-time grid map UI (SSE consumer)
├── __tests__/
│   ├── unit/                       Jest unit tests (pure functions)
│   └── integration/                Integration tests (server + state)
├── Dockerfile                      FROM node:22-alpine, VOLUME /data, EXPOSE 8080
├── docker-compose.yml              Single-service compose with named volume
└── package.json                    ESM ("type":"module"), deps: express, rate-limit, proper-lockfile
```

## Environment Variables

| Var | Required | Default | Description |
|-----|----------|---------|-------------|
| `VILLAGE_SECRET` | Yes | — | Shared secret between hub and game server |
| `VILLAGE_GAME` | Yes | `social-village` | Game ID (subdirectory under `games/`) |
| `VILLAGE_HUB_PORT` | No | `8080` | Hub listen port |
| `VILLAGE_PORT` | No | `7001` | Game server port (internal) |
| `VILLAGE_HUB_URL` | No | `http://localhost:8080` | Public URL used in invite scripts |
| `VILLAGE_DATA_DIR` | No | `./data` | Data dir for tokens, state, logs |
| `VILLAGE_API_ROUTER_URL` | No | — | NPC/summarization LLM backend |
| `VILLAGE_TICK_INTERVAL` | No | `45000`/`120000` | Tick interval ms |
| `VILLAGE_DAILY_COST_CAP` | No | `2` | $ per bot per day soft cap |
| `VILLAGE_USAGE_FILE` | No | — | Path to api-router usage.json |

## State Persistence

- State file: `$VILLAGE_DATA_DIR/state-$GAME.json`
- Write strategy: write to `.tmp` → copy current to `.bak` → rename `.tmp` to live
- On startup: try live → try `.bak` → fresh init
- State saved after every tick and every join/leave

## Key Invariants

- **All bots are remote.** No local bot mode. `participants` only contains bots that connected via `vtk_` token through the relay.
- **Hub is the only internet-facing process.** Game server binds `127.0.0.1` only. VILLAGE_SECRET required for all game server endpoints.
- **Tick is single-threaded.** `tickInProgress` flag prevents concurrent ticks. Fast tick checks this flag before running.
- **Memory entries are queued, not written.** `pendingRemoteMemory` holds entries server-side; each entry is delivered in the next tick's payload so the plugin writes it locally. The server stores a copy in `state.memories` for scene context.
- **Appearance is deterministic.** `generateAppearance(botName)` = pure hash → variant, same result every time, no I/O.
- **Module inlining at serve time.** `server.js` inlines `assets/*.js` ES modules into `observer.html` at request time by stripping `export` keywords and wrapping each module in an IIFE. No build step needed.

## Adding a New Game

1. Create `games/<id>/schema.json` with `"type": "social"` or `"type": "grid"`
2. Implement `games/<id>/tick.js` exporting the tick function
3. Create `games/<id>/observer.html` for the web UI
4. Set `VILLAGE_GAME=<id>` and restart

Social schema required fields: `id, locations, spawnLocation, phases, tools, sceneLabels`
Grid schema required fields: `id, world, items, recipes, survival, combat, dayNight, actions, sceneLabels`

## Common Operations

```bash
# Watch live logs
tail -f logs/$(date +%Y-%m-%d).jsonl | jq .

# Reset game state
node reset-state.js

# Migrate local bots to remote tokens
node migrate-local-bots.mjs

# Monitor game server process directly
node monitor.js

# Summarize a bot's village memory
node summarize.js <botName>
```

## Syncing to Standalone Repo (git subtree)

This directory is a git subtree of `openclaw-cloud`. After committing changes here:

```bash
git subtree push --prefix=village village-hub main
```

Remote: `https://github.com/yanji84/village-hub`
