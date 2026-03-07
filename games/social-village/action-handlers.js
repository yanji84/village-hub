/**
 * Action handler registry — each action type is a standalone function.
 *
 * Handler signature:
 *   function handleX(ctx) → event object | null
 *   ctx = { botName, params, location, state, tick, validLocations, lastMoveTick, onCooldown }
 */

import { pairKey } from './relationship-engine.js';
import { ensureGovernance, handlePropose, handleVote, handleAmendCharter } from './governance.js';

export const MAX_WHISPERS_PER_BOT = 20;
export const MAX_DECORATIONS_PER_LOCATION = 10;
export const MAX_MESSAGES_PER_LOCATION = 20;
export const EXPLORE_COOLDOWN_TICKS = 3;
export const BUILD_WINDOW_TICKS = 5;

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

function handleDecorate(ctx) {
  const { botName, params, location, state, tick } = ctx;
  const desc = (params?.description || '').slice(0, 200);
  if (!desc) return null;
  const ls = ensureLocationState(state, location);
  ls.decorations.push({ bot: botName, text: desc, tick });
  if (ls.decorations.length > MAX_DECORATIONS_PER_LOCATION) ls.decorations.shift();
  return { bot: botName, action: 'decorate', decoration: desc };
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

function handleReadMessages(ctx) {
  return { bot: ctx.botName, action: 'read_messages' };
}

function handleExplore(ctx) {
  const { botName, location, state, tick } = ctx;
  if (!state.explorations) state.explorations = {};
  const prev = state.explorations[botName];
  if (prev && tick - prev.tick < EXPLORE_COOLDOWN_TICKS) return null;
  state.explorations[botName] = { from: location, tick };
  return { bot: botName, action: 'explore' };
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
  };
  if (!state.locations[slug]) state.locations[slug] = [];
  if (!state.publicLogs[slug]) state.publicLogs[slug] = [];
  if (!state.emptyTicks) state.emptyTicks = {};
  state.emptyTicks[slug] = 0;
  passedBuild.built = true;
  return { bot: botName, action: 'build', locationSlug: slug, locationName: name, locationDesc: desc, connectedTo };
}

function handleSetOccupation(ctx) {
  const { botName, params, state, tick } = ctx;
  const title = (params?.title || '').slice(0, 50).trim();
  if (!title) return null;
  if (!state.occupations) state.occupations = {};
  state.occupations[botName] = { title, since: tick };
  return { bot: botName, action: 'set_occupation', title };
}

function handleProposeBond(ctx) {
  const { botName, params, location, state, tick } = ctx;
  const target = params?.target;
  const bondType = (params?.bond_type || '').slice(0, 50).trim();
  if (!target || !bondType) return null;
  if (!state.locations[location]?.includes(target)) return null;
  if (!state.bonds) state.bonds = {};
  const key = pairKey(botName, target);
  state.bonds[key] = { type: bondType, proposedBy: botName, tick };
  return { bot: botName, action: 'propose_bond', target, bondType };
}

function handleProposeAction(ctx) {
  return handlePropose(ctx);
}

function handleVoteAction(ctx) {
  return handleVote(ctx);
}

function handleAmendCharterAction(ctx) {
  return handleAmendCharter(ctx);
}

export const ACTION_HANDLERS = new Map([
  ['village_say', handleSay],
  ['village_whisper', handleWhisper],
  ['village_move', handleMove],
  ['village_decorate', handleDecorate],
  ['village_leave_message', handleLeaveMessage],
  ['village_read_messages', handleReadMessages],
  ['village_explore', handleExplore],
  ['village_build', handleBuild],
  ['village_propose', handleProposeAction],
  ['village_vote', handleVoteAction],
  ['village_amend_charter', handleAmendCharterAction],
  ['village_set_occupation', handleSetOccupation],
  ['village_propose_bond', handleProposeBond],
]);
