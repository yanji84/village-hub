#!/usr/bin/env node
// village/monitor.js — 24/7 live test monitor for a remote village bot
//
// Daemon mode (default):
//   BOT_NAME=wise-koala node village/monitor.js
//   Tails live logs, emits JSON alerts, prints a summary every 6 hours.
//
// Report mode (one-shot, exits with 0=PASS / 1=FAIL):
//   BOT_NAME=wise-koala node village/monitor.js --report [--window=24h]

import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────

const BOT_NAME   = process.env.BOT_NAME   || "wise-koala";
const LOG_DIR    = process.env.LOG_DIR    || new URL("logs", import.meta.url).pathname;
const STATE_FILE = process.env.STATE_FILE || new URL("state-social-village.json", import.meta.url).pathname;

const MIN_TOOLS        = 1;   // warn if payload has zero tools (tools vary by location)
const STALE_TICK_MS    = 10 * 60 * 1000;
const STATE_CHECK_MS   =  5 * 60 * 1000;
const SUMMARY_MS       =  6 * 60 * 60 * 1000;
const NO_ACTION_STREAK = 60;          // bot-specific: ~2h of no actions before soft FAIL (gameplay can be passive)
const MAX_RPC_FAILS    = 3;           // RPC failures before soft FAIL
const MIN_RESPONSE_RATE = 0.95;       // bot must respond in ≥95% of ticks

const REPORT_MODE = process.argv.includes("--report");
const WINDOW_ARG  = process.argv.find(a => a.startsWith("--window=")) || "--window=24h";
const WINDOW_H    = parseInt(WINDOW_ARG.split("=")[1]) || 24;

// ── Logging ───────────────────────────────────────────────────────────────────

function emit(level, msg, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, bot: BOT_NAME, ...data }));
}
const info  = (msg, d) => emit("info",  msg, d);
const warn  = (msg, d) => emit("WARN",  msg, d);
const alert = (msg, d) => emit("ALERT", msg, d);

// ── Accumulator ───────────────────────────────────────────────────────────────
// Single shared stats object used by both daemon and report modes.

function makeAccumulator() {
  return {
    ticksTotal:        0,
    ticksExpected:     0,   // ticks where botsTotal > 0 (bot was registered as remote)
    ticksBotResponded: 0,
    ticksWithActions:  0,
    noActionStreak:    0,   // global village no-action streak
    maxNoActionStreak: 0,

    // Bot-specific action tracking (from docker logs, wise-koala only)
    botPayloads:          0,   // ticks bot received
    botActionsTotal:      0,   // ticks bot took ≥1 action
    botNoActionStreak:    0,
    botMaxNoActionStreak: 0,

    memoryEntryMissing:    0,   // count of ticks with no memoryEntry (informational)
    memoryEntryReceived:   0,   // count of ticks WITH memoryEntry
    agendaMissing:         0,   // Hard FAIL if > 0
    villageMdShrank:       false, // Hard FAIL
    writeFailed:           0,   // Hard FAIL if > 0

    rpcFailed:         0,
    toolsIncomplete:   0,

    villageMdSizeStart: null,
    villageMdSizeLast:  null,
    villageMdLastGrowAt: null,  // timestamp of last size increase

    hardFails:  [],   // reasons for hard FAIL
    softFails:  [],   // reasons for soft FAIL
    warnings:   [],   // non-failing issues
  };
}

const acc = makeAccumulator();

// ── Accumulate events ─────────────────────────────────────────────────────────

function accBotEvent(e) {
  switch (e.type) {
    case "payload":
      acc.botPayloads++;
      if (!e.memoryEntry) {
        acc.memoryEntryMissing++;
        // memoryEntry is only sent when the previous tick generated events —
        // missing on individual ticks is normal (first tick, none actions, stale scenes).
      } else {
        acc.memoryEntryReceived++;
      }
      if (!e.agenda) {
        acc.agendaMissing++;
        acc.hardFails.push(`agenda missing from payload`);
        alert("agenda missing from payload — Hard FAIL");
      }
      if (e.tools < MIN_TOOLS) {
        acc.toolsIncomplete++;
        warn("payload has no tools", { got: e.tools });
      }
      if (e.v !== 2)
        warn("unexpected payload version", { v: e.v });
      break;

    case "memory_write":
      if (acc.villageMdSizeStart === null) acc.villageMdSizeStart = e.mdSize;
      if (acc.villageMdSizeLast !== null) {
        if (e.mdSize < acc.villageMdSizeLast) {
          acc.villageMdShrank = true;
          acc.hardFails.push(`village.md shrank: ${acc.villageMdSizeLast} → ${e.mdSize}`);
          alert("village.md shrank — Hard FAIL", { was: acc.villageMdSizeLast, now: e.mdSize });
        } else if (e.mdSize === acc.villageMdSizeLast) {
          warn("village.md size unchanged after write — possible FS issue", { size: e.mdSize });
        } else {
          acc.villageMdLastGrowAt = Date.now();
        }
      } else {
        acc.villageMdLastGrowAt = Date.now();
      }
      acc.villageMdSizeLast = e.mdSize;
      break;

    case "actions": {
      if (e.cost === 0)
        warn("cost=0 — LLM may not have been called");
      const acted = e.actions.length > 0 && e.actions[0] !== "none";
      if (acted) {
        acc.botActionsTotal++;
        acc.botNoActionStreak = 0;
      } else {
        acc.botNoActionStreak++;
        if (acc.botNoActionStreak > acc.botMaxNoActionStreak)
          acc.botMaxNoActionStreak = acc.botNoActionStreak;
      }
      break;
    }

    case "rpc_failed":
      acc.rpcFailed++;
      alert("agent RPC failed", { count: acc.rpcFailed });
      break;

    case "memory_write_failed":
      acc.writeFailed++;
      acc.hardFails.push(`village.md write failed`);
      alert("village.md write failed — Hard FAIL");
      break;
  }
}

function accServerTick(entry) {
  if (entry.type !== "tick") return;

  acc.ticksTotal++;
  const { tick, bots, botsTotal, actions, memories } = entry;

  if (botsTotal > 0) acc.ticksExpected++;
  if (bots > 0) acc.ticksBotResponded++;

  const totalActions = Object.values(actions || {}).reduce((s, n) => s + n, 0);
  if (totalActions > 0) {
    acc.ticksWithActions++;
    acc.noActionStreak = 0;
  } else {
    acc.noActionStreak++;
    if (acc.noActionStreak > acc.maxNoActionStreak)
      acc.maxNoActionStreak = acc.noActionStreak;
    if (acc.noActionStreak >= NO_ACTION_STREAK)
      alert("no actions for 10+ consecutive ticks — possible game loop stall", { tick, streak: acc.noActionStreak });
  }

  const mem = memories?.[BOT_NAME];
  if (mem) {
    info("tick ok", { tick, bots: `${bots}/${botsTotal}`, actions: totalActions, memRecent: mem.recent?.length ?? 0 });
  }
}

// ── Judgement ─────────────────────────────────────────────────────────────────

function judge() {
  // Response rate: only count ticks where the bot was registered as remote (botsTotal > 0).
  // Ticks before the bot joined (botsTotal=0) are excluded — they're not a connectivity failure.
  const responseRate = acc.ticksExpected > 0
    ? acc.ticksBotResponded / acc.ticksExpected : 1;

  // Soft FAILs
  // Only enforce if enough expected ticks have accumulated.
  if (acc.ticksExpected >= 10 && responseRate < MIN_RESPONSE_RATE)
    acc.softFails.push(`response rate ${(responseRate * 100).toFixed(1)}% < ${MIN_RESPONSE_RATE * 100}%`);

  if (acc.rpcFailed > MAX_RPC_FAILS)
    acc.softFails.push(`${acc.rpcFailed} RPC failures (max ${MAX_RPC_FAILS})`);

  // Bot-specific no-action streak (wise-koala actions only, from docker logs)
  if (acc.botMaxNoActionStreak >= NO_ACTION_STREAK)
    acc.softFails.push(`bot no-action streak: ${acc.botMaxNoActionStreak} consecutive ticks`);

  // memoryEntry: only flag if bot has been active for many ticks but never received one.
  // memoryEntry is only sent after a tick that generated events — missing per tick is normal.
  const MEMORY_ENTRY_MIN_TICKS = 30;
  if (acc.botPayloads >= MEMORY_ENTRY_MIN_TICKS && acc.memoryEntryReceived === 0) {
    acc.softFails.push(`memoryEntry never received after ${acc.botPayloads} active ticks — possible memory pipeline issue`);
  }

  if (acc.villageMdLastGrowAt) {
    const gapH = (Date.now() - acc.villageMdLastGrowAt) / 3_600_000;
    if (gapH > 6)
      acc.softFails.push(`village.md did not grow for ${gapH.toFixed(1)}h`);
  }

  const result =
    acc.hardFails.length > 0 ? "FAIL" :
    acc.softFails.length > 0 ? "FAIL" :
    "PASS";

  return {
    result,
    failReasons: [...acc.hardFails, ...acc.softFails],
    ticks: {
      total:          acc.ticksTotal,
      expected:       acc.ticksExpected,
      botResponded:   acc.ticksBotResponded,
      responseRate:   +responseRate.toFixed(4),
      withActions:    acc.ticksWithActions,
      noActionStreak: acc.maxNoActionStreak,
    },
    bot: {
      payloads:          acc.botPayloads,
      actionsTotal:      acc.botActionsTotal,
      noActionStreak:    acc.botMaxNoActionStreak,
    },
    payload: {
      agendaMissing:      acc.agendaMissing,
      memoryEntryMissing: acc.memoryEntryMissing,
      memoryEntryReceived: acc.memoryEntryReceived,
      toolsIncomplete:    acc.toolsIncomplete,
    },
    memory: {
      sizeStart:    acc.villageMdSizeStart,
      sizeEnd:      acc.villageMdSizeLast,
      grew:         acc.villageMdSizeLast > acc.villageMdSizeStart,
      shrank:       acc.villageMdShrank,
    },
    errors: {
      rpcFailed:   acc.rpcFailed,
      writeFailed: acc.writeFailed,
    },
    warnings: acc.warnings,
  };
}

// ── Report mode ───────────────────────────────────────────────────────────────

async function execCollect(cmd, args) {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", d => out += d);
    proc.stderr.on("data", d => out += d);
    proc.on("exit",  code  => resolve({ code, out: out.trim() }));
    proc.on("error", err   => resolve({ code: -1, out: err.message }));
  });
}

async function installLatestPlugin() {
  const container = `openclaw-${BOT_NAME}`;

  // 1. Check installed version inside container
  const { out: pkgRaw } = await execCollect("docker", [
    "exec", container,
    "cat", "/home/node/.openclaw/extensions/ggbot-village/package.json",
  ]);
  let installedVersion = null;
  try { installedVersion = JSON.parse(pkgRaw).version; } catch {}

  // 2. Check latest published version
  const { out: latestRaw } = await execCollect("npm", ["view", "ggbot-village", "version"]);
  const latestVersion = latestRaw.trim() || null;

  if (!latestVersion) {
    warn("could not determine latest ggbot-village version — skipping install");
    return;
  }

  if (installedVersion === latestVersion) {
    info("plugin already at latest", { version: installedVersion });
    return;
  }

  // 3. Install + restart (only when version differs)
  info("upgrading plugin", { from: installedVersion, to: latestVersion });
  const { code, out } = await execCollect("docker", [
    "exec", container, "sh", "-c",
    `rm -rf /home/node/.openclaw/extensions/ggbot-village && npm_config_cache=/tmp/.npm openclaw plugins install ggbot-village@${latestVersion}`,
  ]);
  if (code !== 0) {
    warn("plugin install failed", { code, output: out });
    return;
  }

  // 4. Restart container so new version loads as the sole process
  info("restarting container to activate new plugin version");
  const { code: rc } = await execCollect("docker", ["restart", container]);
  if (rc !== 0) {
    warn("container restart failed — new version may not be active");
    return;
  }

  // 5. Wait for healthy
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3_000));
    const { out: status } = await execCollect("docker", ["inspect", "--format={{.State.Health.Status}}", container]);
    if (status.trim() === "healthy") {
      info("plugin upgrade complete", { version: latestVersion });
      return;
    }
  }
  warn("container did not become healthy after restart within 60s");
}

async function runReport() {
  const sinceMs   = Date.now() - WINDOW_H * 3_600_000;
  const sinceDate = new Date(sinceMs);

  await installLatestPlugin();
  info(`report mode: scanning last ${WINDOW_H}h`, { since: sinceDate.toISOString() });

  // 1. Replay JSONL logs (may span two calendar days)
  const days = new Set([
    sinceDate.toISOString().slice(0, 10),
    new Date().toISOString().slice(0, 10),
  ]);

  for (const day of days) {
    const path = join(LOG_DIR, `${day}.jsonl`);
    if (!existsSync(path)) continue;
    await new Promise(resolve => {
      const rl = createInterface({ input: createReadStream(path) });
      rl.on("line", line => {
        if (!line.trim()) return;
        try {
          const entry = JSON.parse(line);
          // Only process entries within the time window
          const ts = entry.nextTickAt ? entry.nextTickAt - (entry.tickIntervalMs || 120000) : null;
          if (ts && ts < sinceMs) return;
          accServerTick(entry);
        } catch {}
      });
      rl.on("close", resolve);
    });
  }

  // 2. Replay docker logs for the bot
  await new Promise((resolve, reject) => {
    const container = `openclaw-${BOT_NAME}`;
    const sinceArg  = `${WINDOW_H}h`;
    const proc = spawn("docker", ["logs", `--since=${sinceArg}`, container], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const handleLine = line => {
      const e = parseBotLine(line);
      if (e) accBotEvent(e);
    };
    createInterface({ input: proc.stdout }).on("line", handleLine);
    createInterface({ input: proc.stderr }).on("line", handleLine);
    proc.on("exit", resolve);
    proc.on("error", reject);
  });

  // 3. Check current state.json
  checkStateSync();

  // 4. Output report
  const report = {
    ts: new Date().toISOString(),
    window: `${WINDOW_H}h`,
    ...judge(),
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.result === "PASS" ? 0 : 1);
}

// ── Daemon mode ───────────────────────────────────────────────────────────────

let lastTickAt    = null;
let memRecentLen  = null;

function handleServerEntry(entry) {
  if (entry.type !== "tick") return;
  lastTickAt = Date.now();
  accServerTick(entry);

  const mem = entry.memories?.[BOT_NAME];
  if (mem) {
    const len = mem.recent?.length ?? 0;
    if (memRecentLen !== null && len < memRecentLen)
      alert("recent memory count shrank in state", { was: memRecentLen, now: len });
    memRecentLen = len;
  }
}

function handleBotEvent(e) {
  accBotEvent(e);
  // Extra daemon-only real-time logging
  if (e.type === "memory_write" && !acc.villageMdShrank)
    info("memory write ok", { size: e.mdSize });
  if (e.type === "actions" && e.actions?.length > 0)
    info("output ok", { actions: e.actions, cost: e.cost });
}

function todayLogPath() {
  return join(LOG_DIR, new Date().toISOString().slice(0, 10) + ".jsonl");
}

function tailJsonlLog() {
  const path = todayLogPath();
  if (!existsSync(path)) {
    info("log file not found yet, retrying in 30s", { path });
    setTimeout(tailJsonlLog, 30_000);
    return;
  }
  const startSize = statSync(path).size;
  const stream    = createReadStream(path, { start: startSize });
  const rl        = createInterface({ input: stream });
  rl.on("line", line => {
    if (!line.trim()) return;
    try { handleServerEntry(JSON.parse(line)); } catch {}
  });
  stream.on("end", () => {
    const nextPath = todayLogPath();
    if (nextPath !== path) { tailJsonlLog(); return; }
    setTimeout(() => {
      try {
        const newSize = statSync(path).size;
        if (newSize > startSize) tailJsonlLog();
        else setTimeout(tailJsonlLog, 5_000);
      } catch { setTimeout(tailJsonlLog, 5_000); }
    }, 2_000);
  });
}

function tailDockerLogs() {
  const container = `openclaw-${BOT_NAME}`;
  const proc = spawn("docker", ["logs", "-f", "--tail=0", container], { stdio: ["ignore", "pipe", "pipe"] });
  const handleLine = line => { const e = parseBotLine(line); if (e) handleBotEvent(e); };
  createInterface({ input: proc.stdout }).on("line", handleLine);
  createInterface({ input: proc.stderr }).on("line", handleLine);
  proc.on("exit", code => { info("docker logs exited, restarting in 10s", { code }); setTimeout(tailDockerLogs, 10_000); });
  proc.on("error", err  => { alert("docker logs spawn failed", { err: err.message }); setTimeout(tailDockerLogs, 30_000); });
}

function checkStateSync() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!state.remoteParticipants?.[BOT_NAME]) {
      acc.hardFails.push("bot not in remoteParticipants");
      alert("bot not in remoteParticipants — Hard FAIL");
    }
    if (!state.agendas?.[BOT_NAME]?.goal) {
      acc.hardFails.push("bot has no agenda in state.json");
      alert("bot has no agenda in state.json — Hard FAIL");
    }
    if (!state.memories?.[BOT_NAME]?.recent?.length) {
      acc.hardFails.push("bot has no recent memories in state.json");
      alert("bot has no recent memories in state.json — Hard FAIL");
    }
  } catch (err) {
    alert("state.json read failed", { err: err.message });
  }
}

function checkStaleness() {
  if (lastTickAt && Date.now() - lastTickAt > STALE_TICK_MS)
    alert("no tick activity for 10+ minutes", { lastTickAt: new Date(lastTickAt).toISOString() });
}

function printSummary() {
  const report = { ts: new Date().toISOString(), window: "6h (rolling)", ...judge() };
  emit("SUMMARY", "periodic health summary", report);
}

// ── Shared parsers ────────────────────────────────────────────────────────────

function parseBotLine(line) {
  let m;
  m = line.match(/village: payload v=(\d+) agenda=(\w+) memoryEntry=(\w+) tools=(\d+) scene=(\d+)chars/);
  if (m) return { type: "payload", v: +m[1], agenda: m[2]==="true", memoryEntry: m[3]==="true", tools: +m[4], sceneChars: +m[5] };

  m = line.match(/village: wrote memory entry \((\d+) chars, village\.md=(\d+)bytes\)/);
  if (m) return { type: "memory_write", entryChars: +m[1], mdSize: +m[2] };

  m = line.match(/village: actions=\[([^\]]*)\] cost=([\d.]+)/);
  if (m) return { type: "actions", actions: m[1] ? m[1].split(",") : [], cost: +m[2] };

  if (line.includes("village: agent RPC failed:"))          return { type: "rpc_failed",          line };
  if (line.includes("village: memory entry write failed:")) return { type: "memory_write_failed", line };
  return null;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (REPORT_MODE) {
  runReport().catch(err => { alert("report failed", { err: err.message }); process.exit(1); });
} else {
  info("daemon starting", { bot: BOT_NAME, logDir: LOG_DIR });
  tailJsonlLog();
  tailDockerLogs();
  checkStateSync();
  setInterval(checkStateSync,  STATE_CHECK_MS);
  setInterval(checkStaleness,  STALE_TICK_MS);
  setInterval(printSummary,    SUMMARY_MS);
}
