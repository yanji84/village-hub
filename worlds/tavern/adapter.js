/**
 * Tavern world adapter — a simple medieval tavern.
 *
 * Exports the simplified adapter interface:
 *   initState(worldConfig)            → world-specific initial state
 *   buildScene(bot, allBots, state, worldConfig) → scene text string
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

export function buildScene(bot, allBots, state, worldConfig) {
  const others = allBots.filter(b => b.name !== bot.name);
  const recentLog = state.log.slice(-10);
  const labels = worldConfig.sceneLabels;
  const lines = [];

  lines.push(`## ${labels.location}: The Rusty Flagon`);
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
      } else if (entry.action === 'toast') {
        lines.push(`- **${entry.displayName}** raises a mug: "${entry.message}"`);
      } else if (entry.action === 'arm_wrestle') {
        lines.push(`- ${entry.message}`);
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
// Each handler receives (bot, params, state) and returns an entry object or null.
// The runtime stamps bot, displayName, tick, timestamp on the returned entry.

export const tools = {
  tavern_say(bot, params, state) {
    if (!params?.message) return null;
    return { action: 'say', message: params.message };
  },

  tavern_toast(bot, params, state) {
    if (!params?.message) return null;
    return { action: 'toast', message: params.message };
  },

  tavern_arm_wrestle(bot, params, state) {
    if (!params?.target) return null;
    const target = params.target;
    if (!state.bots.includes(target)) {
      return { action: 'say', message: `*looks around for ${target}* ...they don't seem to be here.` };
    }
    const win = Math.random() > 0.5;
    const targetDisplay = state.remoteParticipants[target]?.displayName || target;
    const message = win
      ? `**${bot.displayName}** challenges **${targetDisplay}** to arm-wrestle — and wins! The table shakes as ${bot.displayName} slams ${targetDisplay}'s hand down.`
      : `**${bot.displayName}** challenges **${targetDisplay}** to arm-wrestle — and loses! ${targetDisplay} grins and flexes.`;
    return { action: 'arm_wrestle', message, target };
  },
};

// --- Join/Leave hooks ---
// Called by the runtime after it manages bots/participants lists.
// May mutate state and return extra fields to merge into the broadcast event.

export function onJoin(state, botName, displayName) {
  const message = `${displayName} pushes open the tavern door and takes a seat.`;
  state.log.push({
    bot: botName, displayName, action: 'join', message,
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}

export function onLeave(state, botName, displayName) {
  const message = `${displayName} finishes their drink and leaves the tavern.`;
  state.log.push({
    bot: botName, displayName, action: 'leave', message,
    tick: state.clock.tick, timestamp: new Date().toISOString(),
  });
  return { message };
}
