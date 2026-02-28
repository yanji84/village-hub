/**
 * Village memory summarizer — compresses old village.md entries using Haiku.
 *
 * When a bot's village.md exceeds SIZE_THRESHOLD, older entries are
 * summarized into a single "Village History" section, keeping recent
 * entries intact for context.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const paths = require('../lib/paths');

const SIZE_THRESHOLD = 50 * 1024; // 50KB
const RECENT_ENTRIES_KEEP = 20;
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';

// Transient per-bot cooldown
const lastSummarizedAt = new Map();

let anthropicToken = null;
let tokenWarned = false;

function loadToken() {
  if (anthropicToken) return anthropicToken;

  // Check process env first
  if (process.env.ANTHROPIC_TOKEN) {
    anthropicToken = process.env.ANTHROPIC_TOKEN;
    return anthropicToken;
  }

  // Try .env file
  try {
    const envPath = join(paths.PROJECT_DIR, '.env');
    const envContent = require('fs').readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^ANTHROPIC_TOKEN=(.+)$/);
      if (match) {
        anthropicToken = match[1].trim();
        return anthropicToken;
      }
    }
  } catch { /* no .env */ }

  if (!tokenWarned) {
    console.warn('[village] ANTHROPIC_TOKEN not found — summarization disabled');
    tokenWarned = true;
  }
  return null;
}

/**
 * Check if a bot's village.md needs summarization.
 */
export async function needsSummarization(botName) {
  const filePath = join(paths.memoryDir(botName), 'village.md');
  try {
    const st = await stat(filePath);
    return st.size >= SIZE_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * Summarize a bot's village.md if it exceeds the size threshold.
 * Returns true if summarization was performed, false if skipped.
 */
export async function summarizeVillageMemory(botName) {
  // Frequency guard
  const lastTime = lastSummarizedAt.get(botName) || 0;
  if (Date.now() - lastTime < MIN_INTERVAL_MS) return false;

  // Cost guard
  const token = loadToken();
  if (!token) return false;

  const filePath = join(paths.memoryDir(botName), 'village.md');
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return false;
  }

  // Split into entries by ## headers
  const entries = splitEntries(content);
  if (entries.length <= RECENT_ENTRIES_KEEP) return false;

  const oldEntries = entries.slice(0, entries.length - RECENT_ENTRIES_KEEP);
  const recentEntries = entries.slice(entries.length - RECENT_ENTRIES_KEEP);

  // Check if already summarized — extract existing summary to include in context
  let existingSummary = '';
  if (oldEntries.length > 0 && oldEntries[0].startsWith('## Village History (summarized)')) {
    existingSummary = oldEntries.shift();
  }

  // If no old entries left to summarize (e.g., only had existing summary + recent)
  if (oldEntries.length === 0 && !existingSummary) return false;

  const oldText = (existingSummary ? existingSummary + '\n\n' : '') + oldEntries.join('\n\n');

  console.log(`[village] Summarizing ${botName}: ${oldEntries.length} old entries (${Math.round(oldText.length / 1024)}KB) + existing summary`);

  try {
    const summary = await callHaiku(token, oldText, botName);
    if (!summary) return false;

    const newContent =
      `## Village History (summarized)\n\n${summary}\n\n` +
      recentEntries.join('\n\n') + '\n';

    await writeFile(filePath, newContent);

    // chown for customer bots
    if (!paths.isAdminBot(botName)) {
      try { await paths.chown(filePath); } catch { /* best effort */ }
    }

    lastSummarizedAt.set(botName, Date.now());
    const newSize = Buffer.byteLength(newContent);
    console.log(`[village] Summarized ${botName}: ${Math.round(content.length / 1024)}KB → ${Math.round(newSize / 1024)}KB`);
    return true;
  } catch (err) {
    console.error(`[village] Summarization failed for ${botName}: ${err.message}`);
    return false;
  }
}

/**
 * Split village.md content into entries by ## headers.
 */
function splitEntries(content) {
  const parts = content.split(/(?=^## )/m);
  return parts.filter(p => p.trim().length > 0);
}

/**
 * Call Haiku to summarize old village entries.
 */
function callHaiku(token, oldText, botName) {
  const isOAuth = token.startsWith('sk-ant-oat');

  const prompt = `You are summarizing the village memory log for a bot named "${botName}". This is a social simulation where bots interact in a virtual village.

Summarize the following village history entries into a concise narrative. Focus on:
- Key conversations and what was discussed
- Important relationships formed or developed
- Notable events (arrivals, departures, movements)
- Recurring themes or topics
- Any memorable or significant moments

Be concise but preserve important details. Use bullet points for clarity. Aim for roughly 1/10th the original length.

Village history to summarize:

${oldText}`;

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    const headers = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (isOAuth) {
      headers['Authorization'] = `Bearer ${token}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      headers['x-api-key'] = token;
    }

    const url = new URL(API_URL);
    const req = request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.error) {
            reject(new Error(data.error.message || JSON.stringify(data.error)));
            return;
          }
          const text = data.content?.[0]?.text || '';
          resolve(text);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Haiku API timeout (60s)'));
    });
    req.write(body);
    req.end();
  });
}
