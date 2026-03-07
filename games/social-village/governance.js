/**
 * Governance module — constitution, proposals, voting, and governance rendering.
 *
 * Consolidates all governance logic previously spread across logic.js, scene.js,
 * and npcs.js into a single module.
 */

export const PROPOSAL_WINDOW = 8;
const MAX_GOVERNANCE_HISTORY = 20;

const STARTER_CONSTITUTION = `The village is governed by this constitution. All villagers should follow these rules and may propose amendments through the democratic process.

Article 1 — Leadership
The village may elect a Mayor by majority vote. The Mayor serves for 100 ticks. When the term ends, any villager should call a new election. The Mayor represents the village and may guide discussion on proposals.

Article 2 — Building
Any villager may propose constructing a new building. The proposal must describe the building's name, purpose, and where it connects to. A building is constructed when a majority of villagers approve the proposal.

Article 3 — Voting
Each villager gets one vote per proposal. Only one proposal may be active at a time. Proposals remain open for ${PROPOSAL_WINDOW} ticks. A proposal passes by majority of votes cast. Constitutional amendments require two-thirds of votes cast.

Article 4 — Amendments
Any villager may propose changes to this constitution. The proposed amendment must include the full updated text.

Article 5 — Rights
All villagers may speak freely, move freely, and participate in governance. No villager may be excluded from voting.`;

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
    };
  }
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

  return resolved;
}

// --- Action handlers ---

const BUILD_WINDOW_TICKS = 5;

/**
 * Handle village_propose action.
 */
export function handlePropose(ctx) {
  const { botName, params, state, tick } = ctx;
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
    if (!state.explorations) state.explorations = {};
    const exploration = state.explorations[botName];
    if (!exploration || tick - exploration.tick > BUILD_WINDOW_TICKS) return null;
    proposal.buildName = bName;
    proposal.buildDescription = bDesc;
    proposal.buildConnectedTo = exploration.from;
    delete state.explorations[botName];
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

/**
 * Handle village_amend_charter action.
 */
export function handleAmendCharter(ctx) {
  const { botName, params, state } = ctx;
  const gov = state.governance;
  if (!gov) return null;
  const passedAmendment = [...(gov.history || [])].reverse().find(
    p => p.type === 'amendment' && p.result === 'passed' && !p.applied
  );
  if (!passedAmendment) return null;
  const newConstitution = (params?.new_constitution || '').trim();
  if (!newConstitution) return null;
  gov.constitution = newConstitution;
  passedAmendment.applied = true;
  const preview = newConstitution.slice(0, 100);
  return { bot: botName, action: 'amend', constitutionPreview: preview };
}

// --- Rendering helpers ---

/**
 * Render the full governance section for a bot's scene prompt.
 * Used by scene.js buildScene.
 */
export function renderGovernanceSection(lines, gov, tick, botName, botDisplayNames, sceneLabels, totalVoters, renderTemplate) {
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
