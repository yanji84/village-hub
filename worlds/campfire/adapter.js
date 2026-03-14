/**
 * Campfire world adapter — minimal example.
 *
 * Exports the phase-based adapter interface:
 *   initState(worldConfig)            → world-specific initial state
 *   phases                            → { phaseName: { turn, tools, scene, transitions, onEnter? } }
 *   tools                             → { toolName: (bot, params, state) → entry|null }
 *   onJoin(state, botName, displayName)   → extra event fields
 *   onLeave(state, botName, displayName)  → extra event fields
 */

// --- State lifecycle ---

export function initState(worldConfig) {
  return {
    log: [],
  };
}

// --- Scene building ---

function buildScene(bot, ctx) {
  const { allBots, state, worldConfig, log } = ctx;
  const others = allBots.filter(b => b.name !== bot.name);
  const recentLog = log.slice(-10);
  const labels = worldConfig.sceneLabels;
  const lines = [];

  lines.push(`## The Campfire`);
  lines.push('');

  if (others.length === 0) {
    lines.push(labels.aloneHere);
  } else {
    lines.push(`**${labels.presentHere}:** ${others.map(b => b.displayName).join(', ')}`);
  }
  lines.push('');

  lines.push(`### ${labels.recentConversation}`);
  if (recentLog.length === 0) {
    lines.push(labels.noConversation);
  } else {
    for (const entry of recentLog) {
      if (entry.action === 'say') {
        lines.push(`- **${entry.displayName}:** ${entry.message}`);
      } else if (entry.action === 'story') {
        lines.push(`- **${entry.displayName}** tells a story: ${entry.message}`);
      } else if (entry.action === 'join' || entry.action === 'leave') {
        lines.push(`- *${entry.message}*`);
      }
    }
  }
  lines.push('');

  lines.push(`### ${labels.availableActions}`);
  for (const tool of (worldConfig.raw.toolSchemas || [])) {
    lines.push(`- **${tool.name}**: ${tool.description}`);
  }
  lines.push(`- **village_journal**: Record a private reflection about this moment — what you noticed, felt, or plan to do. Called AFTER your action.`);
  lines.push('');
  lines.push(labels.yourTurn);

  return lines.join('\n');
}

// --- Phases ---

export const phases = {
  campfire: {
    turn: 'parallel',
    tools: ['campfire_say', 'campfire_story'],
    scene: buildScene,
  },
};

// --- Tool handlers ---

export const tools = {
  campfire_say(bot, params, state) {
    if (!params?.message) return null;
    return { action: 'say', message: params.message, visibility: 'public' };
  },

  campfire_story(bot, params, state) {
    if (!params?.story) return null;
    return { action: 'story', message: params.story, visibility: 'public' };
  },
};

// --- Join/Leave hooks ---

export function onJoin(state, botName, displayName) {
  return { message: `${displayName} sat down at the campfire.` };
}

export function onLeave(state, botName, displayName) {
  return { message: `${displayName} left the campfire.` };
}
