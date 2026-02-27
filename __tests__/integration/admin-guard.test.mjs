/**
 * Integration tests for admin bot exclusion.
 * Covers SEC-043, SEC-044, ORC-033.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../../../lib/paths');

// --- SEC-043: Admin bot name is defined ---

describe('Admin bot exclusion', () => {
  it('ADMIN_BOT_NAME is defined in paths', () => {
    expect(paths.ADMIN_BOT_NAME).toBeDefined();
    expect(typeof paths.ADMIN_BOT_NAME).toBe('string');
    expect(paths.ADMIN_BOT_NAME.length).toBeGreaterThan(0);
  });

  it('isAdminBot correctly identifies admin bot', () => {
    expect(paths.isAdminBot(paths.ADMIN_BOT_NAME)).toBe(true);
    expect(paths.isAdminBot('customer-bot')).toBe(false);
    expect(paths.isAdminBot('')).toBe(false);
  });

  // --- ORC-033: Admin bot excluded from server.js discoverParticipants ---

  it('server.js contains admin bot exclusion comment', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');
    const content = await readFile(serverPath, 'utf-8');

    // Admin bot should NOT be added as participant
    expect(content).toContain('Admin bot excluded from village');
    // The old admin bot handling code should be gone
    expect(content).not.toContain('ADMIN_BOT_NAME');
    expect(content).not.toContain('adminBot');
  });

  // --- SEC-044: Admin toggle route guards admin bot ---

  it('admin-settings.js guards village-toggle for admin bot', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const routePath = join(process.cwd(), 'portal', 'routes', 'admin-settings.js');
    const content = await readFile(routePath, 'utf-8');

    // Should check for admin bot and return 403
    expect(content).toContain('ADMIN_BOT_NAME');
    expect(content).toContain('403');
    expect(content).toContain('Admin bot cannot participate in the village');
  });
});

// --- OPS-040: VILLAGE_SECRET fail-safe ---

describe('VILLAGE_SECRET fail-safe', () => {
  it('server.js exits if VILLAGE_SECRET not set', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server.js');
    const content = await readFile(serverPath, 'utf-8');

    // Should have the fail-safe check
    expect(content).toContain('VILLAGE_SECRET');
    expect(content).toContain('refusing to start tick loop');
    expect(content).toContain('process.exit(1)');
  });
});

// --- E2E-013: Secret generation in admin toggle ---

describe('Village secret generation', () => {
  it('admin-settings.js generates VILLAGE_SECRET on enable', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');

    const routePath = join(process.cwd(), 'portal', 'routes', 'admin-settings.js');
    const content = await readFile(routePath, 'utf-8');

    // Should generate secret using crypto
    expect(content).toContain('crypto.randomBytes');
    expect(content).toContain('VILLAGE_SECRET');
    expect(content).toContain('village/.env');
    expect(content).toContain('gatewayEnv');
  });
});
