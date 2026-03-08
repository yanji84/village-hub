/**
 * Governance module — constitution, proposals, voting, and governance rendering.
 *
 * Consolidates all governance logic previously spread across logic.js, scene.js,
 * and npcs.js into a single module.
 */

import { request as httpRequest } from 'node:http';
const API_ROUTER_URL = 'http://127.0.0.1:9090';
const NPC_API_TOKEN = process.env.NPC_API_TOKEN || '';

export const PROPOSAL_WINDOW = 8;
const MAX_GOVERNANCE_HISTORY = 20;
const MAYOR_TERM_TICKS = 100;
const MAX_DECREES = 5;
const DECREE_EXPIRY_TICKS = 50;
const EXILE_DURATION_TICKS = 5;
const VIOLATION_CHECK_INTERVAL = 5;
const MAX_VIOLATIONS = 20;

const STARTER_CONSTITUTION = `本村庄依据本宪法治理。所有村民应遵守以下规则，并可通过民主程序提议修订。

第一条 — 领导
村庄可通过多数票选举村长。村长任期为 100 回合。任期届满后，任何村民均可发起新一轮选举。村长代表村庄，可就提案进行引导讨论。

第二条 — 建造
任何村民均可提议建造新建筑。提案须说明建筑名称、用途及连接位置。当多数村民投票赞成后，建筑方可建造。

第三条 — 投票
每位村民对每项提案拥有一票。同一时间只能有一项活跃提案。提案的投票窗口为 ${PROPOSAL_WINDOW} 回合。提案以投票多数通过。宪法修正案需获得三分之二以上投票赞成。

第四条 — 修正
任何村民均可提议修改本宪法。修正提案须包含完整的修改后文本。

第五条 — 权利
所有村民享有自由发言、自由迁移及参与治理的权利。任何村民不得被排除在投票之外。`;

/**
 * Ensure governance state exists on state object, return it.
 */
export function ensureGovernance(state) {
  if (!state.governance) {
    state.governance = {
      constitution: STARTER_CONSTITUTION,
      mayor: null,
      activeProposal: null,
      nextProposalId: 1,
      history: [],
      decrees: [],
      violations: [],
    };
  }
  // Migration: add new fields to existing governance state
  if (!state.governance.decrees) state.governance.decrees = [];
  if (!state.governance.violations) state.governance.violations = [];
  // Exiles live at top level (like whispers)
  if (!state.exiles) state.exiles = {};
  return state.governance;
}

/**
 * Resolve an expired proposal if its voting window has passed.
 */
export function resolveExpiredProposal(state, tick) {
  const gov = state.governance;
  if (!gov?.activeProposal) return null;
  const proposal = gov.activeProposal;
  if (tick - proposal.tick < PROPOSAL_WINDOW) return null;

  const votes = Object.values(proposal.votes);
  const yes = votes.filter(v => v === 'yes').length;
  const no = votes.filter(v => v === 'no').length;
  const total = yes + no;

  const threshold = proposal.type === 'amendment' ? 2 / 3 : 0.5;
  const passed = total > 0 && (yes / total) > threshold;

  const resolved = { ...proposal, result: passed ? 'passed' : 'rejected', resolvedAt: tick };
  gov.history.push(resolved);
  if (gov.history.length > MAX_GOVERNANCE_HISTORY) gov.history.shift();
  gov.activeProposal = null;

  if (passed && proposal.type === 'election' && proposal.candidate) {
    gov.mayor = { name: proposal.candidate, electedAt: tick };
  }

  // Auto-apply amendment when passed
  if (passed && proposal.type === 'amendment' && proposal.amendmentText) {
    gov.constitution = proposal.amendmentText;
    resolved.applied = true;
  }

  return resolved;
}

// --- Mayor term expiry ---

/**
 * Expire mayor if term has elapsed.
 */
export function expireMayor(state, tick) {
  const gov = state.governance;
  if (!gov?.mayor) return null;
  if (tick - gov.mayor.electedAt >= MAYOR_TERM_TICKS) {
    const mayorName = gov.mayor.name;
    gov.mayor = null;
    return { type: 'mayor_term_expired', mayorName, tick };
  }
  return null;
}

// --- Exile enforcement ---

/**
 * Enforce active exiles: remove expired, force-move active exiled bots.
 */
export function enforceExiles(state, tick) {
  if (!state.exiles) return [];
  const events = [];
  for (const [botName, exile] of Object.entries(state.exiles)) {
    if (tick >= exile.until) {
      delete state.exiles[botName];
      events.push({ type: 'exile_expired', bot: botName, tick });
      continue;
    }
    // Force-move exiled bot to exile destination if not already there
    for (const [loc, bots] of Object.entries(state.locations)) {
      if (loc === exile.to) continue;
      const idx = (bots || []).indexOf(botName);
      if (idx !== -1) {
        bots.splice(idx, 1);
        if (!state.locations[exile.to]) state.locations[exile.to] = [];
        if (!state.locations[exile.to].includes(botName)) {
          state.locations[exile.to].push(botName);
        }
        events.push({ type: 'exile_enforced', bot: botName, destination: exile.to, by: exile.by, tick });
        break;
      }
    }
  }
  return events;
}

// --- Mayor powers: decree & exile ---

/**
 * Handle village_decree action (mayor-only).
 */
export function handleDecree(ctx) {
  const { botName, params, state, tick } = ctx;
  const gov = ensureGovernance(state);
  if (!gov.mayor || gov.mayor.name !== botName) return null;
  const text = (params?.text || '').slice(0, 300).trim();
  if (!text) return null;
  // Expire old decrees
  gov.decrees = gov.decrees.filter(d => tick - d.tick < DECREE_EXPIRY_TICKS);
  // Reject if at capacity — first 5 take precedence, must wait for expiry
  if (gov.decrees.length >= MAX_DECREES) return null;
  gov.decrees.push({ text, by: botName, tick });
  return { bot: botName, action: 'decree', text };
}

/**
 * Handle village_exile action (mayor-only).
 */
export function handleExile(ctx) {
  const { botName, params, state, tick } = ctx;
  const gov = ensureGovernance(state);
  if (!gov.mayor || gov.mayor.name !== botName) return null;
  const target = (params?.target || '').trim();
  if (!target) return null;
  // Can't exile self
  if (target === botName) return null;
  // Check target exists in village
  let targetFound = false;
  for (const bots of Object.values(state.locations)) {
    if ((bots || []).includes(target)) { targetFound = true; break; }
  }
  if (!targetFound) return null;
  // No stacking — don't exile someone already exiled
  if (state.exiles?.[target]) return null;
  if (!state.exiles) state.exiles = {};
  const destination = 'prison';
  state.exiles[target] = { to: destination, until: tick + EXILE_DURATION_TICKS, by: botName };
  return { bot: botName, action: 'exile', target, destination, duration: EXILE_DURATION_TICKS };
}

// --- Violation detection ---

/**
 * Check for law violations in recent speech using Haiku.
 * Laws = constitution + active mayor decrees.
 * Only runs every VIOLATION_CHECK_INTERVAL ticks and only when
 * there are enforceable laws (amended constitution or active decrees).
 */
export async function checkViolations(state, tick) {
  if (tick % VIOLATION_CHECK_INTERVAL !== 0) return null;
  const gov = state.governance;
  if (!gov) return null;

  const constitutionAmended = gov.constitution !== STARTER_CONSTITUTION;
  const activeDecrees = (gov.decrees || []).filter(d => tick - d.tick < DECREE_EXPIRY_TICKS);
  // Only check if there are enforceable laws
  if (!constitutionAmended && activeDecrees.length === 0) return null;

  // Collect recent say messages from all locations
  const recentMessages = [];
  for (const [loc, log] of Object.entries(state.publicLogs || {})) {
    for (const entry of (log || []).slice(-10)) {
      if (entry.action === 'say') {
        recentMessages.push({ bot: entry.bot, message: entry.message, location: loc });
      }
    }
  }
  if (recentMessages.length === 0) return null;

  // Build laws section: constitution + active decrees
  const lawParts = [];
  if (constitutionAmended) {
    lawParts.push('【宪法】\n' + gov.constitution);
  }
  if (activeDecrees.length > 0) {
    lawParts.push('【村长法令】\n' + activeDecrees.map(d => '- ' + d.text).join('\n'));
  }

  const prompt = [
    '你是村庄执法官。仔细检查以下村民发言是否违反了当前法律（宪法和村长法令）。\n\n',
    lawParts.join('\n\n'), '\n\n',
    '【近期发言】\n',
    ...recentMessages.map(m => `- ${m.bot}："${m.message}"\n`),
    '\n只报告明确的违法行为（不是可疑的，必须是明确违反了某条法律的）。',
    '\n返回JSON格式：{"violations": [{"bot": "bot_name", "rule": "violated rule summary", "message": "the violating message", "severity": "minor|major"}]}',
    '\n如果没有违法行为，返回：{"violations": []}',
  ].join('');

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    const violations = await new Promise((resolve) => {
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
              if (json.error) {
                console.error(`[governance] Violation check API error: ${json.error.message || JSON.stringify(json.error)}`);
                resolve(null);
                return;
              }
              const textBlock = (json.content || []).find(b => b.type === 'text');
              if (!textBlock?.text) { resolve(null); return; }
              // Extract JSON from response (may be wrapped in markdown)
              const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
              if (!jsonMatch) { resolve(null); return; }
              const parsed = JSON.parse(jsonMatch[0]);
              resolve(parsed.violations || []);
            } catch (err) {
              console.error(`[governance] Violation check parse error: ${err.message}`);
              resolve(null);
            }
          });
        },
      );
      req.on('error', (err) => {
        console.error(`[governance] Violation check request error: ${err.message}`);
        resolve(null);
      });
      req.on('timeout', () => {
        console.error(`[governance] Violation check timeout`);
        req.destroy();
        resolve(null);
      });
      req.write(body);
      req.end();
    });

    if (!violations || violations.length === 0) return null;

    // Store violations
    for (const v of violations) {
      gov.violations.push({ ...v, tick });
    }
    // Enforce max
    while (gov.violations.length > MAX_VIOLATIONS) gov.violations.shift();

    console.log(`[governance] ${violations.length} violation(s) detected at tick ${tick}`);
    return violations;
  } catch (err) {
    console.error(`[governance] Violation check error: ${err.message}`);
    return null;
  }
}

// --- Action handlers ---

/**
 * Handle village_propose action.
 */
export function handlePropose(ctx) {
  const { botName, params, state, tick, location } = ctx;
  const gov = ensureGovernance(state);
  if (gov.activeProposal) return null;
  const pType = params?.type;
  if (!['build', 'amendment', 'election', 'general'].includes(pType)) return null;
  const desc = (params?.description || '').slice(0, 300).trim();
  if (!desc) return null;
  const proposal = {
    id: gov.nextProposalId++,
    type: pType,
    proposedBy: botName,
    description: desc,
    tick,
    votes: {},
  };
  if (pType === 'build') {
    const bName = (params?.build_name || '').slice(0, 30).trim();
    const bDesc = (params?.build_description || '').slice(0, 200).trim();
    if (!bName || !bDesc) return null;
    proposal.buildName = bName;
    proposal.buildDescription = bDesc;
    proposal.buildConnectedTo = location || 'central-square';
    // Optional: specify tools for the new building (whitelist only safe tools)
    if (Array.isArray(params?.build_tools) && params.build_tools.length > 0) {
      const SAFE_TOOLS = new Set([
        'village_say', 'village_whisper', 'village_move', 'village_leave_message',
        'village_memory_search',
      ]);
      const filtered = params.build_tools.filter(t => SAFE_TOOLS.has(t));
      if (filtered.length > 0) proposal.buildTools = filtered;
    }
  } else if (pType === 'amendment') {
    const aText = (params?.amendment_text || '').trim();
    if (!aText) return null;
    proposal.amendmentText = aText;
  } else if (pType === 'election') {
    const candidate = (params?.candidate || '').trim();
    if (!candidate) return null;
    proposal.candidate = candidate;
  }
  gov.activeProposal = proposal;
  return { bot: botName, action: 'propose', type: pType, description: desc, proposalId: proposal.id };
}

/**
 * Handle village_vote action.
 */
export function handleVote(ctx) {
  const { botName, params, state } = ctx;
  const gov = state.governance;
  if (!gov?.activeProposal) return null;
  if (gov.activeProposal.votes[botName]) return null;
  const vote = params?.vote;
  if (vote !== 'yes' && vote !== 'no') return null;
  gov.activeProposal.votes[botName] = vote;
  const reason = (params?.reason || '').slice(0, 200).trim();
  return { bot: botName, action: 'vote', proposalId: gov.activeProposal.id, vote, reason };
}

// --- Rendering helpers ---

/**
 * Render the full governance section for a bot's scene prompt.
 * Used by scene.js buildScene.
 */
export function renderGovernanceSection(lines, gov, tick, botName, botDisplayNames, sceneLabels, totalVoters, renderTemplate, state) {
  // Constitution
  lines.push(sceneLabels.constitutionHeader);
  lines.push(gov.constitution);
  lines.push('');

  // Current government
  lines.push(sceneLabels.governmentHeader);
  if (gov.mayor) {
    const mayorTick = tick - gov.mayor.electedAt;
    lines.push(renderTemplate(sceneLabels.mayorLabel, {
      name: botDisplayNames[gov.mayor.name] || gov.mayor.name,
      tick: mayorTick,
      term: '100',
    }));
  } else {
    lines.push(sceneLabels.noMayor);
  }
  lines.push('');

  // Active proposal
  lines.push(sceneLabels.activeProposalHeader);
  if (gov.activeProposal) {
    const p = gov.activeProposal;
    const remaining = PROPOSAL_WINDOW - (tick - p.tick);
    const proposerName = botDisplayNames[p.proposedBy] || p.proposedBy;
    lines.push(renderTemplate(sceneLabels.proposalFormat, {
      id: p.id,
      description: p.description,
      proposedBy: proposerName,
      remaining,
    }));
    if (p.type === 'build') {
      lines.push(`  类型：建造 — ${p.buildName}：${p.buildDescription}`);
    } else if (p.type === 'amendment') {
      lines.push('  类型：修宪');
    } else if (p.type === 'election') {
      const candidateName = botDisplayNames[p.candidate] || p.candidate;
      lines.push(`  类型：选举 — 候选人：${candidateName}`);
    } else {
      lines.push('  类型：一般提案');
    }
    const votes = Object.values(p.votes);
    const yes = votes.filter(v => v === 'yes').length;
    const no = votes.filter(v => v === 'no').length;
    lines.push(renderTemplate(sceneLabels.proposalVotes, {
      yes, no, total: totalVoters,
    }));
    const threshold = p.type === 'amendment' ? 2 / 3 : 0.5;
    const total = yes + no;
    const passing = total > 0 && (yes / total) > threshold;
    lines.push(passing ? sceneLabels.proposalPassing : sceneLabels.proposalFailing);
    if (!p.votes[botName]) {
      lines.push('  用 village_vote 投出你的一票。');
    }
  } else {
    lines.push(sceneLabels.noActiveProposal);
  }
  lines.push('');

  // Recent decisions
  if (gov.history && gov.history.length > 0) {
    lines.push(sceneLabels.recentDecisions);
    for (const h of gov.history.slice(-5)) {
      const resultText = h.result === 'passed' ? '通过' : '未通过';
      lines.push(renderTemplate(sceneLabels.decisionFormat, {
        id: h.id,
        description: h.description,
        result: resultText,
      }));
    }
    lines.push('');
  }

  // Pending build nudge — if a build proposal passed but hasn't been built yet
  const pendingBuild = [...(gov.history || [])].reverse().find(
    p => p.type === 'build' && p.result === 'passed' && !p.built
  );
  if (pendingBuild) {
    lines.push(`⚒️ 建造提案「${pendingBuild.buildName}」已通过！任何村民可以用 village_build 执行建造。`);
    lines.push('');
  }

  // Expansion nudge — encourage building when village is small and no active proposal
  const customCount = Object.keys(state?.customLocations || {}).length;
  if (!gov.activeProposal && !pendingBuild && customCount < 3) {
    lines.push('💡 村庄还有很多空间可以发展。你可以用 village_propose（type: build）提议建造新地点——商店、学校、花园，任何你想要的！');
    lines.push('');
  }

  // Active decrees
  const activeDecrees = (gov.decrees || []).filter(d => tick - d.tick < DECREE_EXPIRY_TICKS);
  if (activeDecrees.length > 0) {
    lines.push(sceneLabels.decreeHeader || '【村长法令】（具有约束力）');
    for (const d of activeDecrees) {
      const byName = botDisplayNames[d.by] || d.by;
      lines.push(`- ${d.text}（${byName} 发布）`);
    }
    lines.push('');
  }

  // Active exiles
  const exiles = state?.exiles || {};
  const activeExiles = Object.entries(exiles).filter(([, e]) => tick < e.until);
  if (activeExiles.length > 0) {
    lines.push(sceneLabels.exileHeader || '【流放中】');
    for (const [name, e] of activeExiles) {
      const dn = botDisplayNames[name] || name;
      const remaining = e.until - tick;
      lines.push(`- ${dn} 在监狱中（还剩 ${remaining} 轮）`);
    }
    lines.push('');
  }

  // Personal exile notice for the viewing bot
  if (exiles[botName] && tick < exiles[botName].until) {
    const e = exiles[botName];
    const remaining = e.until - tick;
    const notice = (sceneLabels.exileNotice || '⚠️ 你被村长关进了监狱，还剩 {remaining} 轮。你不能移动到其他地方。')
      .replace('{remaining}', remaining);
    lines.push(notice);
    lines.push('');
  }

  // Recent violations
  const recentViolations = (gov.violations || []).slice(-5);
  if (recentViolations.length > 0) {
    lines.push(sceneLabels.violationHeader || '【违法记录】');
    for (const v of recentViolations) {
      const vn = botDisplayNames[v.bot] || v.bot;
      lines.push(`- ${vn} 违反「${v.rule}」（${v.severity}）`);
    }
    lines.push('');
  }

  // Nudge if no mayor and no active election proposal
  if (!gov.mayor && (!gov.activeProposal || gov.activeProposal.type !== 'election')) {
    lines.push(sceneLabels.governanceNudge);
    lines.push('');
  }
}

/**
 * Render a compact proposal summary for NPC scenes.
 * Used by npcs.js buildNPCScene.
 */
export function renderProposalSummary(lines, gov, tick, npcName, displayNames, totalVoters) {
  if (!gov?.activeProposal) return;
  const p = gov.activeProposal;
  const remaining = PROPOSAL_WINDOW - (tick - p.tick);
  const proposerName = displayNames[p.proposedBy] || p.proposedBy;
  lines.push(`【活跃提案】#${p.id}「${p.description}」（${proposerName} 提出，还剩 ${remaining} 轮）`);
  const votes = Object.values(p.votes);
  const yes = votes.filter(v => v === 'yes').length;
  const no = votes.filter(v => v === 'no').length;
  lines.push(`投票：${yes} 赞成 / ${no} 反对（共 ${totalVoters} 位村民）`);
  if (!p.votes[npcName]) {
    lines.push('你还没投票。用 village_vote 投出你的一票。');
  }
  lines.push('');
}
