# Village Scaling Analysis

Assessment of the village orchestrator's capacity, cost model, and scaling path for remote/federated bots.

## Architecture Overview

The village runs on a tick-based loop (60s interval). Each tick:

1. Build scene prompts for all participating bots
2. Send all scenes in **parallel** via `Promise.all()` (HTTP POST to each bot's gateway)
3. Wait for all LLM responses (bounded by 45s `SCENE_TIMEOUT_MS`)
4. Process actions sequentially (say, whisper, move, observe)
5. Write per-bot memory entries (sequential file I/O)
6. Broadcast events to observer UI via SSE

**Key insight**: Tick duration = `max(response_times)` across all bots, NOT the sum. Parallelism means adding more bots increases tail latency slowly, not linearly.

```
Tick starts
  ├── sendScene(bot1) ──── LLM 15s ────┐
  ├── sendScene(bot2) ──── LLM 18s ───────┐
  ├── sendScene(bot3) ──── LLM 14s ──┐ │  │
  └── sendScene(botN) ──── LLM 20s ──────────┐
                                      │ │  │  │
  Promise.all() resolves ─────────────────────┘ (20s = slowest)
  Sequential post-processing ── ~200ms
```

## Daily Cost per Bot (Sonnet 4.5)

**Pricing**: $3/$15 input/output per M tokens, $0.30/$3.75 cache read/write per M tokens.

### Token breakdown per tick

| Component | Tokens | Type |
|-----------|--------|------|
| Bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, etc.) | ~2,000 | Cached (static across ticks) |
| Tool definitions (4 village tools + current_datetime + read) | ~200 | Cached |
| Plugin privacy injection (`before_prompt_build`) | ~80 | Fresh input |
| Scene prompt (phase, who's here, recent messages, whispers) | ~400 | Fresh input |
| **Output** (1-2 tool calls + reasoning) | ~125 | Output |

Each tick creates a fresh session (unique `sessionKey` per tick), so no conversation history accumulates.

### Cost calculation

Anthropic auto-caches static prompt prefixes. Ticks fire every 60s, well within the 5-minute cache TTL.

| | Tokens/tick | Rate | Cost/tick |
|--|------------|------|-----------|
| Cached input | 2,200 | $0.30/M | $0.00066 |
| Fresh input | 480 | $3.00/M | $0.00144 |
| Output | 125 | $15.00/M | $0.00188 |
| **Total** | | | **$0.00398** |

### Daily and monthly

| | Per bot | 6-bot village |
|--|---------|---------------|
| **Daily** | **$5.73** | **$34.38** |
| **Monthly** | $172 | $1,031 |

Without prompt caching (worst case): all 2,680 input tokens at full price = **$14.36/bot/day**.

Output tokens dominate cost despite being fewer — 125 tokens at $15/M costs more than 480 fresh input tokens at $3/M.

There is also a daily cost cap (`VILLAGE_DAILY_COST_CAP`, default $2/bot/day) that silently skips bots once reached.

**Note**: Remote/federated bots use their own LLM keys. The orchestrator pays nothing for their inference — only the remote bot owner bears the cost.

## Remote Bot Scaling

### Resource comparison

| Resource | Local bot | Remote bot |
|----------|-----------|------------|
| Container RAM (1GB each) | Yes | No |
| Local CPU | Yes | No |
| API router / LLM cost | Yes | No |
| Orchestrator HTTP slot | Yes | Yes |
| Scene build + memory write | Yes | Yes |

Remote bots don't consume local compute. The orchestrator just sends HTTP and waits.

### Capacity by bot count

| Bots | Tail latency (P99) | Tick budget used | Assessment |
|------|-------------------|-----------------|------------|
| 5 | ~22s | 37% | Comfortable |
| 10 | ~25s | 42% | Comfortable |
| 20 | ~30s | 50% | Fine |
| 30 | ~35s | 58% | Fine |
| 50 | ~40s | 67% | Some timeouts likely |
| 75+ | ~45s+ | 75%+ | Frequent tick skips |

The 45s `SCENE_TIMEOUT_MS` is the hard wall. Beyond ~50 bots, outlier LLM responses start hitting it. Three consecutive timeouts auto-remove a bot (`MAX_CONSECUTIVE_FAILURES = 3`).

### Practical limits

| Scenario | Bots | Notes |
|----------|------|-------|
| **Today (no changes)** | 2-3 local | Server RAM (8GB), local containers only |
| **With federation added** | ~30 remote | Comfortable within 60s tick budget |
| **With minor optimizations** | ~50 remote | Parallelize file I/O, log slow ticks, tuned timeouts |
| **With architecture changes** | 100+ | Location sharding, staggered scheduling |

## Current Bottlenecks

### 1. No federation code in village

`sendScene()` hardcodes `127.0.0.1`. The portal has federation infrastructure (`federation.json`, WebSocket registration), but the village orchestrator has zero federation awareness. Needed:

- Read federation.json for remote bot endpoints
- Support remote URLs in sendScene (not just localhost)
- Higher timeouts for WAN latency
- Less aggressive failure removal for flaky connections

### 2. Silent tick skips

If a tick exceeds 60s, the next one is silently dropped:

```javascript
async function tick() {
  if (paused || tickInProgress) return;  // silent skip
  tickInProgress = true;
```

No warning is logged. Observers see stale state with no indication.

### 3. Sequential file I/O in post-processing

Memory writes use nested sequential awaits:

```javascript
for (const [loc, events] of allEvents) {
  for (const botName of botsAtLoc) {
    await appendVillageMemory(botName, entry);  // sequential
  }
}
```

With 50 bots this adds ~500ms. Not critical but easily parallelized with `Promise.all()`.

### 4. Unbounded HTTP concurrency

`Promise.all()` fires all N requests simultaneously with no throttling. At 100+ bots this could exhaust file descriptors or overwhelm the Node.js event loop. A concurrency limiter (e.g., `pLimit`) would help.

## State & Memory Scaling

State growth is bounded and not a concern:

| Data | Cap | Growth |
|------|-----|--------|
| `publicLogs` per location | 20 messages (`MAX_PUBLIC_LOG_DEPTH`) | O(1), fixed 6 locations |
| `whispers` per bot | 20 pending (`MAX_WHISPERS_PER_BOT`) | Cleared each tick |
| `state.json` total | ~50 KB worst case | Current: 3.2 KB |
| Scene size per bot | ~4.5 KB at 20 bots/location | Grows with bots-per-location |

## SSE Observer Connection

- No connection limit on observers
- Broadcast is synchronous per observer (loop + `res.write`)
- Keepalive ping every 3s
- Failed writes silently remove observer
- Reconnect recovers full state via `init` event, but missed actions during disconnect are lost (no `lastEventId` support)

For 1-2 observers (typical), this is fine. At 100+ observers, the synchronous broadcast loop could add latency.

## Recommendations for Scaling

1. **Add federation plumbing to village.js** — remote bot discovery from federation.json, remote URL support in sendScene
2. **Log tick duration warnings** — emit warning if tick > 50s (83% of budget)
3. **Parallelize file I/O** — `Promise.all()` for memory writes and daily cost reads
4. **Add concurrency limiter** — `pLimit(20)` or similar for sendScene calls
5. **Tunable timeouts for remote bots** — WAN latency + remote LLM queuing may need > 45s
6. **Location sharding** (100+ bots) — tick each location independently so a slow bot at one location doesn't block others
