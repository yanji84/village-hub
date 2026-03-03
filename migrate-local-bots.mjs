#!/usr/bin/env node
/**
 * One-time migration for local bots (wise-koala, prime-heron) that have
 * VILLAGE_SECRET but no VILLAGE_TOKEN.
 *
 * For each bot:
 *   1. Generate vtk_ token → portal/village-tokens.json (local: true)
 *   2. Replace VILLAGE_SECRET/VILLAGE_SERVER with VILLAGE_HUB/VILLAGE_TOKEN in gateway.env
 *   3. Copy new plugin files from templates/
 *   4. chown 1000:1000
 *   5. Restart container
 *
 * Usage: node village/migrate-local-bots.mjs [--dry-run]
 */

import { readFile, writeFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const paths = require('../lib/paths');
const identityManager = require('../lib/identity-manager');

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_DIR = paths.PROJECT_DIR;
const TOKENS_FILE = join(PROJECT_DIR, 'portal', 'village-tokens.json');
const PLUGIN_SRC = join(PROJECT_DIR, 'templates', 'plugins', 'village');

// Read village server state to find local bots in game
async function getVillageSecret() {
  try {
    const raw = await readFile(join(PROJECT_DIR, 'village', '.env'), 'utf8');
    const m = raw.match(/^VILLAGE_SECRET=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch { return ''; }
}

async function getLocalBotsInGame(secret) {
  // Scan customers for bots with VILLAGE_SECRET in gateway.env but no VILLAGE_TOKEN
  const { readdir } = await import('node:fs/promises');
  const customers = await readdir(join(PROJECT_DIR, 'customers'));
  const bots = [];

  for (const name of customers) {
    const envPath = paths.gatewayEnv(name);
    try {
      const env = await readFile(envPath, 'utf8');
      const hasSecret = env.includes('VILLAGE_SECRET=');
      const hasToken = env.includes('VILLAGE_TOKEN=');
      if (hasSecret && !hasToken) {
        bots.push(name);
      }
    } catch { /* no gateway.env */ }
  }
  return bots;
}

async function run() {
  const secret = await getVillageSecret();
  if (!secret) {
    console.error('Cannot read VILLAGE_SECRET from village/.env');
    process.exit(1);
  }

  const bots = await getLocalBotsInGame(secret);
  if (bots.length === 0) {
    console.log('No local bots need migration (all have VILLAGE_TOKEN or no VILLAGE_SECRET).');
    return;
  }

  console.log(`Found ${bots.length} bot(s) to migrate: ${bots.join(', ')}`);
  if (DRY_RUN) console.log('(dry run — no changes will be made)\n');

  // Load existing tokens
  let tokens = {};
  try { tokens = JSON.parse(await readFile(TOKENS_FILE, 'utf8')); } catch { /* new file */ }

  for (const botName of bots) {
    console.log(`\n--- ${botName} ---`);

    // 1. Check if bot already has a token in village-tokens.json
    let existingToken = null;
    for (const [tk, entry] of Object.entries(tokens)) {
      if (entry.botName === botName) { existingToken = tk; break; }
    }

    // Generate token if needed
    const vtk = existingToken || ('vtk_' + randomBytes(24).toString('hex'));
    if (existingToken) {
      console.log(`  Token already exists: ${vtk.slice(0, 12)}...`);
    } else {
      const identity = await identityManager.read(botName);
      const displayName = identity?.self?.displayName || botName;
      tokens[vtk] = {
        botName,
        displayName,
        local: true,
        createdAt: new Date().toISOString(),
        claimedAt: new Date().toISOString(),
      };
      console.log(`  Generated token: ${vtk.slice(0, 12)}...`);
    }

    // 2. Update gateway.env
    const envPath = paths.gatewayEnv(botName);
    let env = await readFile(envPath, 'utf8');
    const before = env;
    env = env.replace(/^VILLAGE_SECRET=.*\n?/m, '');
    env = env.replace(/^VILLAGE_SERVER=.*\n?/m, '');
    if (!env.includes('VILLAGE_HUB=')) {
      env = env.trimEnd() + '\nVILLAGE_HUB=https://ggbot.it.com\n';
    }
    if (!env.includes('VILLAGE_TOKEN=')) {
      env = env.trimEnd() + `\nVILLAGE_TOKEN=${vtk}\n`;
    } else {
      env = env.replace(/^VILLAGE_TOKEN=.*$/m, `VILLAGE_TOKEN=${vtk}`);
    }
    console.log(`  gateway.env: -VILLAGE_SECRET, -VILLAGE_SERVER, +VILLAGE_HUB, +VILLAGE_TOKEN`);

    // 3. Plugin files
    const pluginDest = join(PROJECT_DIR, 'customers', botName, 'openclaw', 'plugins', 'village');
    console.log(`  Plugin: cp ${PLUGIN_SRC} → ${pluginDest}`);

    if (!DRY_RUN) {
      // Write tokens
      await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2) + '\n');

      // Write gateway.env
      await writeFile(envPath, env);
      await exec('chown', ['1000:1000', envPath]);

      // Copy plugin
      await cp(PLUGIN_SRC, pluginDest, { recursive: true, force: true });
      await exec('chown', ['-R', '1000:1000', pluginDest]);

      // Restart container
      const container = `openclaw-${botName}`;
      console.log(`  Restarting ${container}...`);
      try {
        await exec('docker', ['restart', '-t', '3', container]);
        // Poll health
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try {
            const { stdout } = await exec('docker', ['inspect', '-f', '{{.State.Health.Status}}', container]);
            if (stdout.trim() === 'healthy') {
              console.log(`  ${container} healthy ✓`);
              break;
            }
          } catch { /* not ready */ }
        }
      } catch (err) {
        console.error(`  Restart failed: ${err.message}`);
      }
    }
  }

  if (!DRY_RUN && bots.length > 0) {
    // Final: write tokens file once more (in case multiple bots)
    await writeFile(TOKENS_FILE, JSON.stringify(tokens, null, 2) + '\n');
  }

  console.log(`\nDone. ${DRY_RUN ? '(dry run)' : `Migrated ${bots.length} bot(s).`}`);
}

run().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
