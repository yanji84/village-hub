/**
 * Campfire world adapter — minimal example.
 *
 * Exports the simplified adapter interface:
 *   initState(worldConfig)            → world-specific initial state
 *   buildScene(bot, allBots, state, worldConfig) → scene text string
 *   tools                             → { toolName: (bot, params, state) → entry|null }
 *   onJoin(state, botName, displayName)   → extra event fields
 *   onLeave(state, botName, displayName)  → extra event fields
 *
 * See README.md for the full adapter interface reference.
 */

// --- State lifecycle ---

export function initState(worldConfig) {
  return {
    log: [],
  };
}

// --- Scene building ---

export function buildScene(bot, allBots, state, worldConfig) {
  const others = allBots.filter(b => b.name !== bot.name);
  const recentLog = state.log.slice(-10);
  const labels = worldConfig.sceneLabels;
  const lines = [];

  lines.push(`## ${labels.location}: The Campfire`);
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
  for (const tool of (worldConfig.raw.tools || [])) {
    lines.push(`- **${tool.id}**: ${tool.description}`);
  }
  lines.push('');
  lines.push(labels.yourTurn);

  return lines.join('\n');
}

// --- Tool handlers ---

export const tools = {
  campfire_say(bot, params, state) {
    if (!params?.message) return null;
    return { action: 'say', message: params.message };
  },

  campfire_story(bot, params, state) {
    if (!params?.story) return null;
    return { action: 'story', message: params.story };
  },
};

// --- Join/Leave hooks ---

export function onJoin(state, botName, displayName) {
  const message = `${displayName} sat down at the campfire.`;
  state.log.push({
    bot: botName, displayName, action: 'join', message,
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}

export function onLeave(state, botName, displayName) {
  const message = `${displayName} left the campfire.`;
  state.log.push({
    bot: botName, displayName, action: 'leave', message,
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}
