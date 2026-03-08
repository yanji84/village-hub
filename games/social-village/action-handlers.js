/**
 * Action handler registry — each action type is a standalone function.
 *
 * Handler signature:
 *   function handleX(ctx) → event object | null
 *   ctx = { botName, params, location, state, tick, validLocations, lastMoveTick, onCooldown }
 */

import { request as httpRequest } from 'node:http';
import { ensureGovernance, handlePropose, handleVote, handleDecree, handleExile } from './governance.js';

export const MAX_WHISPERS_PER_BOT = 20;
export const MAX_MESSAGES_PER_LOCATION = 20;

function ensureLocationState(state, location) {
  if (!state.locationState) state.locationState = {};
  if (!state.locationState[location]) state.locationState[location] = { decorations: [], messages: [] };
  return state.locationState[location];
}

function handleSay(ctx) {
  const { botName, params, location, state } = ctx;
  const msg = params?.message || '';
  if (!msg) return null;
  const entry = { bot: botName, action: 'say', message: msg };
  state.publicLogs[location].push(entry);
  return entry;
}

function handleWhisper(ctx) {
  const { botName, params, location, state } = ctx;
  const target = params?.bot_id;
  const msg = params?.message || '';
  if (!target || !msg) return null;
  if (!state.locations[location]?.includes(target)) return null;
  if (!state.whispers[target]) state.whispers[target] = [];
  if (state.whispers[target].length >= MAX_WHISPERS_PER_BOT) return null;
  state.whispers[target].push({ from: botName, message: msg });
  return { bot: botName, action: 'whisper', target, message: msg };
}

function handleMove(ctx) {
  const { botName, params, location, state, onCooldown, validLocations, lastMoveTick, tick } = ctx;
  if (state.exiles?.[botName] && tick < state.exiles[botName].until) return null;
  if (onCooldown) return null;
  const dest = params?.location;
  const allValid = [...validLocations, ...Object.keys(state.customLocations || {})];
  if (!dest || !allValid.includes(dest) || dest === location) return null;
  state.locations[location] = state.locations[location].filter(b => b !== botName);
  if (!state.locations[dest]) state.locations[dest] = [];
  state.locations[dest].push(botName);
  if (lastMoveTick) lastMoveTick.set(botName, tick);
  return { bot: botName, action: 'move', from: location, to: dest };
}

function handleLeaveMessage(ctx) {
  const { botName, params, location, state, tick } = ctx;
  const msg = (params?.message || '').slice(0, 300);
  if (!msg) return null;
  const ls = ensureLocationState(state, location);
  ls.messages.push({ bot: botName, text: msg, tick });
  if (ls.messages.length > MAX_MESSAGES_PER_LOCATION) ls.messages.shift();
  return { bot: botName, action: 'leave_message', message: msg };
}

function handleBuild(ctx) {
  const { botName, location, state, tick, validLocations } = ctx;
  const gov = state.governance;
  if (!gov) return null;
  const passedBuild = [...(gov.history || [])].reverse().find(
    p => p.type === 'build' && p.result === 'passed' && !p.built
  );
  if (!passedBuild) return null;
  if (!state.customLocations) state.customLocations = {};
  const name = (passedBuild.buildName || '').slice(0, 30).trim();
  const desc = (passedBuild.buildDescription || '').slice(0, 200).trim();
  if (!name || !desc) return null;
  const connectedTo = passedBuild.buildConnectedTo || location;
  const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || `place-${tick}`;
  if (state.customLocations[slug] || validLocations.includes(slug)) return null;
  state.customLocations[slug] = {
    name,
    flavor: desc,
    createdBy: passedBuild.proposedBy,
    connectedTo,
    tick,
    tools: passedBuild.buildTools || null,
  };
  if (!state.locations[slug]) state.locations[slug] = [];
  if (!state.publicLogs[slug]) state.publicLogs[slug] = [];
  if (!state.emptyTicks) state.emptyTicks = {};
  state.emptyTicks[slug] = 0;
  passedBuild.built = true;
  return { bot: botName, action: 'build', locationSlug: slug, locationName: name, locationDesc: desc, connectedTo };
}

function handleMemorySearch(ctx) {
  const { botName, params, state } = ctx;
  const query = (params?.query || '').trim().toLowerCase();
  if (!query) return null;

  const mem = state.memories?.[botName];
  if (!mem) return { bot: botName, action: 'memory_search', results: 'No memories yet.' };

  const matches = [];
  if (mem.summary?.toLowerCase().includes(query)) matches.push(mem.summary);
  for (const entry of (mem.recent || [])) {
    if (entry.toLowerCase().includes(query)) matches.push(entry);
  }

  const results = matches.length > 0
    ? matches.slice(-5).join('\n\n').slice(0, 1000)
    : 'No matching memories found.';

  return { bot: botName, action: 'memory_search', results };
}

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const API_ROUTER_URL = 'http://127.0.0.1:9090';
const NPC_API_TOKEN = process.env.NPC_API_TOKEN || '';

const RSS_FEEDS = [
  'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  'https://feeds.bbci.co.uk/news/world/rss.xml',
];

async function fetchRSSHeadlines(url) {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': 'VillageNewsBot/1.0' },
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const titles = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = itemRegex.exec(text)) !== null) {
      const titleMatch = match[1].match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i);
      if (titleMatch && titleMatch[1].trim()) {
        titles.push(titleMatch[1].trim());
      }
    }
    return titles;
  } catch {
    return [];
  }
}

function handleResearch(ctx) {
  const { botName, params, location, state, tick } = ctx;
  const topic = (params?.topic || '').slice(0, 100).trim();
  if (!topic) return null;
  const note = (params?.note || '').slice(0, 300).trim();

  // Search existing newsBulletins for matching headlines
  const bulletins = state.newsBulletins || [];
  const topicLower = topic.toLowerCase();
  const matches = bulletins.filter(b =>
    (b.headline || '').toLowerCase().includes(topicLower) ||
    (b.bulletin || '').toLowerCase().includes(topicLower)
  );

  // Also kick off async RSS search (results posted as leave_message)
  const bestMatch = matches.length > 0 ? matches[matches.length - 1] : null;
  const finding = bestMatch
    ? bestMatch.bulletin || bestMatch.headline
    : `未找到关于"${topic}"的新闻`;

  // Post finding as a leave_message at the library
  const ls = ensureLocationState(state, location);
  const msgText = note
    ? `📰 ${topic}：${finding}\n— ${note}`
    : `📰 ${topic}：${finding}`;
  ls.messages.push({ bot: botName, text: msgText.slice(0, 300), tick });
  if (ls.messages.length > MAX_MESSAGES_PER_LOCATION) ls.messages.shift();

  // Fire-and-forget: fetch fresh RSS headlines for future searches
  (async () => {
    for (const url of RSS_FEEDS) {
      const titles = await fetchRSSHeadlines(url);
      const freshMatches = titles.filter(t => t.toLowerCase().includes(topicLower));
      if (freshMatches.length > 0 && !bestMatch) {
        // Post the first fresh match as an additional message
        const freshMsg = note
          ? `📰 ${topic}：${freshMatches[0]}\n— ${note}`
          : `📰 ${topic}：${freshMatches[0]}`;
        ls.messages.push({ bot: botName, text: freshMsg.slice(0, 300), tick });
        if (ls.messages.length > MAX_MESSAGES_PER_LOCATION) ls.messages.shift();
        break;
      }
    }
  })().catch(() => {});

  return { bot: botName, action: 'research', topic, finding: finding.slice(0, 200), note: note || null };
}

function handleMeditate(ctx) {
  const { botName, params, state, tick } = ctx;
  const focus = params?.focus;
  if (!['relationships', 'goals', 'village'].includes(focus)) return null;

  // Build memory context for Haiku
  const mem = state.memories?.[botName];
  const memParts = [];
  if (mem?.summary) memParts.push(mem.summary);
  if (mem?.recent?.length > 0) memParts.push(mem.recent.slice(-5).join('\n\n'));
  const memText = memParts.join('\n\n').trim().slice(0, 1500);

  const agenda = state.agendas?.[botName]?.goal || '';

  const focusLabels = {
    relationships: '你与其他村民的关系',
    goals: '你的目标和方向',
    village: '村庄社区的发展',
  };

  const prompt = `你是一个冥想导师。一个村民正在静思殿冥想，思考"${focusLabels[focus]}"。
根据他的记忆和目标，给出一段简短的洞察或启示（用中文，不超过200字）。
要深刻、有诗意，但也要结合他的具体经历。

${agenda ? `他的目标：${agenda}\n` : ''}${memText ? `他的记忆：\n${memText}` : '（暂无记忆）'}`;

  // Fire-and-forget Haiku call — store result as memory entry
  const body = JSON.stringify({
    model: HAIKU_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  (async () => {
    try {
      const insight = await new Promise((resolve) => {
        const url = new URL(`${API_ROUTER_URL}/v1/messages`);
        const req = httpRequest(
          {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': NPC_API_TOKEN,
              'anthropic-version': '2023-06-01',
              'Content-Length': Buffer.byteLength(body),
            },
            timeout: 30000,
          },
          (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
              try {
                const json = JSON.parse(data);
                if (json.error) { resolve(null); return; }
                const textBlock = (json.content || []).find(b => b.type === 'text');
                resolve(textBlock?.text?.trim().slice(0, 400) || null);
              } catch { resolve(null); }
            });
          },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.write(body);
        req.end();
      });

      if (insight) {
        if (!state.memories) state.memories = {};
        if (!state.memories[botName]) state.memories[botName] = { summary: '', recent: [] };
        const ts = new Date().toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        });
        state.memories[botName].recent.push(`## Meditation (${focus}) — ${ts}\n${insight}`);
      }
    } catch {
      console.error(`[meditate] Haiku call failed for ${botName}`);
    }
  })();

  return { bot: botName, action: 'meditate', focus };
}

function handleProposeAction(ctx) {
  return handlePropose(ctx);
}

function handleVoteAction(ctx) {
  return handleVote(ctx);
}

export const ACTION_HANDLERS = new Map([
  ['village_say', handleSay],
  ['village_whisper', handleWhisper],
  ['village_move', handleMove],
  ['village_leave_message', handleLeaveMessage],
  ['village_build', handleBuild],
  ['village_propose', handleProposeAction],
  ['village_vote', handleVoteAction],
  ['village_memory_search', handleMemorySearch],
  ['village_decree', handleDecree],
  ['village_exile', handleExile],
  ['village_research', handleResearch],
  ['village_meditate', handleMeditate],
]);
