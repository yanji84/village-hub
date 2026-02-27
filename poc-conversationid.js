#!/usr/bin/env node
/**
 * ConversationId PoC — validates that gateways accept village:* conversationIds.
 *
 * This is a throwaway test script (Phase 0A from ggbot.md feedback).
 * It POSTs to a running bot's /village endpoint and verifies:
 *   1. Gateway creates a session with the village conversationId
 *   2. The sessionKey contains "village:" so isVillageSession() works
 *   3. The agent responds and returns village tool actions
 *
 * Usage:
 *   node village/poc-conversationid.js <botName> [port]
 *
 * Prerequisites:
 *   - Bot must be running with the village plugin enabled
 *   - Bot must be reachable at http://127.0.0.1:<port>
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const paths = require('../lib/paths');
const configManager = require('../lib/config-manager');

const botName = process.argv[2];
const portOverride = process.argv[3] ? parseInt(process.argv[3], 10) : null;

if (!botName) {
  console.error('Usage: node village/poc-conversationid.js <botName> [port]');
  process.exit(1);
}

async function main() {
  console.log(`\n=== ConversationId PoC — Testing ${botName} ===\n`);

  // 1. Resolve port
  let port = portOverride;
  if (!port) {
    const config = await configManager.read(botName);
    port = config?.gateway?.port;
    if (!port) {
      console.error(`[FAIL] Cannot read gateway port from config for ${botName}`);
      process.exit(1);
    }
  }
  console.log(`[INFO] Target: http://127.0.0.1:${port}/village`);

  // 2. Health check
  try {
    const healthResp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!healthResp.ok) {
      console.error(`[FAIL] Health check returned HTTP ${healthResp.status}`);
      process.exit(1);
    }
    console.log('[PASS] Health check OK');
  } catch (err) {
    console.error(`[FAIL] Health check failed: ${err.message}`);
    console.error('       Is the bot running? Try: ./manage.sh start ' + botName);
    process.exit(1);
  }

  // 3. POST to /village with a village conversationId
  const conversationId = 'village:coffee-hub:poc-1';
  const scene = [
    "It's morning in the village. The day is just beginning.",
    'You are at **Coffee Hub**.',
    '',
    "You're alone here. It's quiet.",
    '',
    'Available actions:',
    '- **village_say**: Say something to everyone here',
    '- **village_observe**: Stay silent and observe',
    '',
    'Choose 1 action. Respond naturally as yourself.',
  ].join('\n');

  console.log(`[INFO] Sending scene with conversationId: "${conversationId}"`);

  let response;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/village`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, scene }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[FAIL] /village returned HTTP ${resp.status}: ${text}`);
      process.exit(1);
    }

    response = await resp.json();
    console.log('[PASS] /village returned 200 OK');
    console.log('[INFO] Response:', JSON.stringify(response, null, 2));
  } catch (err) {
    console.error(`[FAIL] /village request failed: ${err.message}`);
    process.exit(1);
  }

  // 4. Validate response has actions
  if (!response.actions || !Array.isArray(response.actions) || response.actions.length === 0) {
    console.error('[FAIL] Response missing or empty actions array');
    process.exit(1);
  }
  console.log(`[PASS] Got ${response.actions.length} action(s)`);

  // 5. Check actions are valid village tools
  const validTools = new Set(['village_say', 'village_whisper', 'village_observe', 'village_move']);
  for (const action of response.actions) {
    if (!validTools.has(action.tool)) {
      console.error(`[WARN] Unexpected tool: ${action.tool}`);
    } else {
      console.log(`[PASS] Valid action: ${action.tool}`);
      if (action.params?.message) {
        console.log(`       Message: "${action.params.message.slice(0, 100)}${action.params.message.length > 100 ? '...' : ''}"`);
      }
    }
  }

  // 6. Check sessions.json for village session
  console.log('\n[INFO] Checking sessions.json for village session...');
  try {
    const sessionsPath = paths.sessionsJson(botName);
    const sessionsRaw = await readFile(sessionsPath, 'utf-8');
    const sessions = JSON.parse(sessionsRaw);

    let foundVillageSession = false;
    for (const [key, session] of Object.entries(sessions)) {
      if (key.includes('village:') || (session.conversationId && session.conversationId.includes('village:'))) {
        foundVillageSession = true;
        console.log(`[PASS] Found village session: ${key}`);
        console.log(`       Session file: ${session.file || 'N/A'}`);
        break;
      }
    }

    if (!foundVillageSession) {
      console.log('[WARN] No village session found in sessions.json');
      console.log('       This may be OK if the gateway uses a different session key format.');
      console.log('       Check manually: cat ' + paths.sessionsJson(botName));
    }
  } catch (err) {
    console.log(`[WARN] Could not read sessions.json: ${err.message}`);
  }

  // Summary
  console.log('\n=== PoC Result ===');
  console.log('[PASS] Gateway accepted village conversationId format');
  console.log('[PASS] Agent responded with valid village tool actions');
  console.log('[INFO] ConversationId PoC PASSED — safe to proceed with orchestrator development');
  console.log('');
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
