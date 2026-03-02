/**
 * Scene prompt builder for grid-based survival games.
 *
 * Builds a structured text prompt for each bot with:
 * STATUS, MAP, INVENTORY, NEARBY, RECENT EVENTS, ACTIONS, GUIDANCE.
 */

import { computeVisibility, buildAsciiMap } from './visibility.js';
import { buildScoreboard, isAllied, getBountyBot } from './logic.js';

/**
 * Determine the current day/night phase from tick.
 *
 * @param {number} tick - Current game tick
 * @param {object} dayNightConfig - { cycleTicks, phases: { phaseName: { startTick, visibilityBase } } }
 * @returns {{ name: string, visibilityBase: number }}
 */
export function getDayPhase(tick, dayNightConfig) {
  const dayTick = tick % dayNightConfig.cycleTicks;

  // Sort phases by startTick descending to find current phase
  const sorted = Object.entries(dayNightConfig.phases)
    .sort(([, a], [, b]) => b.startTick - a.startTick);

  for (const [name, cfg] of sorted) {
    if (dayTick >= cfg.startTick) {
      return { name, visibilityBase: cfg.visibilityBase };
    }
  }

  // Fallback to first phase
  const [name, cfg] = Object.entries(dayNightConfig.phases)[0];
  return { name, visibilityBase: cfg.visibilityBase };
}

/**
 * Format inventory for display.
 *
 * @param {object} inventory - { item: count }
 * @param {object} equipment - { weapon, armor, tool }
 * @param {object} gameConfig
 * @returns {string}
 */
export function formatInventory(inventory, equipment, gameConfig) {
  const items = gameConfig.raw.items;
  const maxSlots = gameConfig.raw.survival.inventorySlots;

  const parts = [];
  let usedSlots = 0;

  for (const [item, qty] of Object.entries(inventory)) {
    const label = items[item]?.label || item;
    parts.push(`${label} x${qty}`);
    usedSlots += qty;
  }

  // Equipment
  const equipped = [];
  if (equipment.weapon) equipped.push(`[${items[equipment.weapon]?.label || equipment.weapon} equipped]`);
  if (equipment.armor) equipped.push(`[${items[equipment.armor]?.label || equipment.armor} equipped]`);
  if (equipment.tool) equipped.push(`[${items[equipment.tool]?.label || equipment.tool} equipped]`);

  const invStr = parts.length > 0 ? parts.join(', ') : 'empty';
  const equipStr = equipped.length > 0 ? ' | ' + equipped.join(', ') : '';

  return `${invStr}${equipStr} | ${usedSlots}/${maxSlots} slots`;
}

/**
 * Format bot stats line.
 */
export function formatStats(botState, dayPhase, tick) {
  return `HP: ${botState.health}/${100} | Hunger: ${botState.hunger}/${100} | Pos: (${botState.x},${botState.y}) | Time: ${dayPhase.name} (tick ${tick})`;
}

/**
 * Build the full scene prompt for a survival bot.
 *
 * @param {object} opts
 * @param {string} opts.botName
 * @param {object} opts.botState - { x, y, health, hunger, inventory, equipment, alive, directive, fastTickStats }
 * @param {object} opts.worldState - { terrain, tileData, bots, clock }
 * @param {object} opts.gameConfig
 * @param {number} opts.currentTick
 * @param {Array} opts.recentEvents - Events this bot witnessed
 * @param {string} opts.villageSummary - Memory summary
 * @param {boolean} opts.isScout - Whether bot scouted this tick
 * @param {object} [opts.fastTickStats] - { tilesMoved, itemsGathered, damageDealt, damageTaken }
 * @returns {string} Scene prompt
 */
export function buildSurvivalScene({ botName, botState, worldState, gameConfig, currentTick,
                                      recentEvents, villageSummary, isScout, fastTickStats,
                                      round, displayNames, diplomacy }) {
  const labels = gameConfig.raw.sceneLabels;
  const dayNight = gameConfig.raw.dayNight;
  const dayPhase = getDayPhase(currentTick, dayNight);

  const lines = [];

  // == STATUS ==
  lines.push(labels.statusHeader);
  lines.push(formatStats(botState, dayPhase, currentTick));
  lines.push('');

  // == ROUND ==
  if (round && gameConfig.raw.scoring) {
    lines.push('== ROUND ==');
    lines.push(`Round ${round.number} | ${round.ticksRemaining} ticks remaining`);
    const scoreboard = buildScoreboard(round.scores || {}, displayNames || {});
    if (scoreboard.length > 0) {
      const scoreStr = scoreboard.map(s => `${s.displayName}: ${s.score}`).join(', ');
      lines.push(`Scoreboard: ${scoreStr}`);
    }
    const pts = gameConfig.raw.scoring.points;
    lines.push(`Points: kill=${pts.kill}, craft=${pts.craft}, gather=${pts.gather}, explore=${pts.explore}, survival=${pts.survivalTick}, death=${pts.death}`);
    if (round.scores && pts.betrayalKill) {
      const bounty = getBountyBot(round.scores);
      if (bounty && bounty !== botName) {
        const bountyName = (displayNames || {})[bounty] || bounty;
        const bountyScore = round.scores[bounty] || 0;
        lines.push(`BOUNTY: ${bountyName} leads with ${bountyScore} pts — kill them for +${pts.bountyKill} bonus!`);
      } else if (bounty === botName) {
        lines.push(`WARNING: You are the score leader — other bots get +${pts.bountyKill} bonus for killing you!`);
      }
    }
    lines.push('');
  }

  // == DIPLOMACY ==
  if (diplomacy && gameConfig.raw.diplomacy) {
    lines.push('== DIPLOMACY ==');

    // Your allies
    const allies = [];
    for (const [key, alliance] of Object.entries(diplomacy.alliances || {})) {
      const [a, b] = key.split(':');
      if (a === botName || b === botName) {
        const ally = a === botName ? b : a;
        const allyName = (displayNames || {})[ally] || ally;
        allies.push(`${allyName} (since tick ${alliance.formedAt})`);
      }
    }
    if (allies.length > 0) {
      lines.push(`Your allies: ${allies.join(', ')}`);
    } else {
      lines.push('You have no allies. Propose one: say "PROPOSE ALLIANCE <name>"');
    }

    // Pending proposals
    for (const [key, proposal] of Object.entries(diplomacy.proposals || {})) {
      const [from, to] = key.split('→');
      if (to === botName) {
        const fromName = (displayNames || {})[from] || from;
        const remaining = (gameConfig.raw.diplomacy.proposalExpireTicks || 5) - (currentTick - proposal.tick);
        lines.push(`Pending: ${fromName} wants to ally with you (expires in ${remaining} ticks) — say "ACCEPT ALLIANCE ${from}" to accept`);
      } else if (from === botName) {
        lines.push(`Your proposal to ${(displayNames || {})[to] || to} is pending...`);
      }
    }

    // Recent betrayals
    for (const b of (diplomacy.betrayals || []).slice(-5)) {
      const betrayerName = (displayNames || {})[b.betrayer] || b.betrayer;
      const victimName = (displayNames || {})[b.victim] || b.victim;
      lines.push(`Betrayal: ${betrayerName} betrayed ${victimName} at tick ${b.tick}`);
    }

    lines.push('');
  }

  // == MAP ==
  let radius = computeVisibility(botState, worldState.terrain, dayPhase, gameConfig);
  if (isScout) radius = Math.min(radius + 3, 15);

  const asciiMap = buildAsciiMap({
    botX: botState.x,
    botY: botState.y,
    radius,
    terrain: worldState.terrain,
    tileData: worldState.tileData,
    allBots: worldState.bots,
    botName,
    width: gameConfig.raw.world.width,
    height: gameConfig.raw.world.height,
  });

  lines.push(labels.mapHeader);
  lines.push(asciiMap);
  lines.push(labels.mapLegend);
  lines.push('');

  // == CURRENT TILE ==
  const tileKey = `${botState.x},${botState.y}`;
  const currentTile = worldState.tileData[tileKey];
  const terrainIdx = botState.y * gameConfig.raw.world.width + botState.x;
  const terrainChar = worldState.terrain[terrainIdx] || '.';
  const charToType = {};
  for (const [type, cfg] of Object.entries(gameConfig.raw.world.terrain)) {
    charToType[cfg.char] = type;
  }
  const terrainType = charToType[terrainChar] || 'unknown';
  lines.push('== CURRENT TILE ==');
  if (currentTile?.resources?.length > 0) {
    const resList = currentTile.resources.map(r => {
      const label = gameConfig.raw.items[r.item]?.label || r.item;
      return `${label} x${r.qty}`;
    }).join(', ');
    lines.push(`Terrain: ${terrainType} | Resources here: ${resList} (autopilot will auto-gather)`);
  } else {
    lines.push(`Terrain: ${terrainType} | No resources on this tile.`);
  }
  lines.push('');

  // == CURRENT DIRECTIVE ==
  const directive = botState.directive;
  lines.push('== CURRENT DIRECTIVE ==');
  if (directive && directive.intent !== 'idle') {
    let directiveStr = `Intent: ${directive.intent}`;
    if (directive.target) directiveStr += ` | Target: ${directive.target}`;
    if (directive.fallback) directiveStr += ` | Fallback: ${directive.fallback}`;
    if (directive.x != null && directive.y != null) directiveStr += ` | Goto: (${directive.x},${directive.y})`;
    directiveStr += ` | Set at tick ${directive.setAt || '?'}`;
    lines.push(directiveStr);
    if (directive.strategy) {
      lines.push(`Strategy: ${directive.strategy}`);
    }
  } else {
    lines.push('No active directive. Your soldier is idle. Set a directive!');
  }
  if (!directive?.strategy) {
    lines.push('TIP: Set a strategy note to remember your plan across ticks: { intent: "...", strategy: "my multi-tick plan" }');
  }
  lines.push('');

  // == AUTOPILOT REPORT ==
  const stats = fastTickStats || botState.fastTickStats;
  if (stats && (stats.tilesMoved > 0 || stats.itemsGathered.length > 0 || stats.damageDealt > 0 || stats.damageTaken > 0)) {
    lines.push('== AUTOPILOT REPORT (since last tick) ==');
    const parts = [];
    if (stats.tilesMoved > 0) parts.push(`Moved ${stats.tilesMoved} tiles`);
    if (stats.itemsGathered.length > 0) {
      const counts = {};
      for (const item of stats.itemsGathered) counts[item] = (counts[item] || 0) + 1;
      const gathered = Object.entries(counts).map(([item, qty]) => {
        const label = gameConfig.raw.items[item]?.label || item;
        return `${label} x${qty}`;
      }).join(', ');
      parts.push(`Gathered ${gathered}`);
    }
    if (stats.damageDealt > 0) parts.push(`Dealt ${stats.damageDealt} damage`);
    if (stats.damageTaken > 0) parts.push(`Took ${stats.damageTaken} damage`);
    lines.push(parts.join(' | '));
    lines.push('');
  }

  // == INVENTORY ==
  lines.push(labels.inventoryHeader);
  if (Object.keys(botState.inventory).length === 0 && !botState.equipment.weapon && !botState.equipment.armor && !botState.equipment.tool) {
    lines.push(labels.emptyInventory);
  } else {
    lines.push(formatInventory(botState.inventory, botState.equipment, gameConfig));
  }
  lines.push('');

  // == NEARBY ==
  lines.push(labels.nearbyHeader);
  const nearbyBots = [];
  for (const [name, bs] of Object.entries(worldState.bots)) {
    if (name === botName) continue;
    if (!bs.alive) continue;
    const dist = Math.sqrt(Math.pow(botState.x - bs.x, 2) + Math.pow(botState.y - bs.y, 2));
    if (dist <= radius) {
      const weapon = bs.equipment.weapon
        ? (gameConfig.raw.items[bs.equipment.weapon]?.label || bs.equipment.weapon)
        : 'unarmed';
      const armor = bs.equipment.armor
        ? (gameConfig.raw.items[bs.equipment.armor]?.label || bs.equipment.armor)
        : 'none';
      // Diplomacy tags
      const tags = [];
      if (diplomacy && isAllied(botName, name, diplomacy)) tags.push('[ALLY]');
      if (round?.scores && getBountyBot(round.scores) === name) tags.push('[BOUNTY]');
      const tagStr = tags.length > 0 ? ' ' + tags.join(' ') : '';
      nearbyBots.push(`  ${name} — HP:${bs.health} Pos:(${bs.x},${bs.y}) Weapon:${weapon} Armor:${armor} (dist:${dist.toFixed(1)})${tagStr}`);
    }
  }
  if (nearbyBots.length > 0) {
    lines.push(...nearbyBots);
  } else {
    lines.push(labels.noNearby);
  }
  lines.push('');

  // == RECENT EVENTS ==
  lines.push(labels.recentHeader);
  if (recentEvents && recentEvents.length > 0) {
    for (const ev of recentEvents.slice(-15)) {
      lines.push(`  ${formatEvent(ev, gameConfig)}`);
    }
  } else {
    lines.push(labels.noRecent);
  }
  lines.push('');

  // == ACTIONS ==
  lines.push(labels.actionsHeader);
  lines.push('Set a strategic directive. Your autopilot soldier will execute it automatically.');
  lines.push('You can also craft/eat/say directly as immediate actions.');
  lines.push('');

  // Contextual suggestions
  const suggestions = [];
  const foodItems = Object.entries(botState.inventory).filter(([item]) => gameConfig.raw.items[item]?.type === 'food');
  if (botState.hunger >= 30 && foodItems.length > 0) {
    suggestions.push(`→ Hunger is ${botState.hunger}/100. Call survival_eat or set directive to "eat".`);
  } else if (botState.hunger >= 30 && foodItems.length === 0) {
    suggestions.push(`→ Hunger is ${botState.hunger}/100 and you have no food! Set directive: gather berry.`);
  }
  const craftable = getCraftableRecipes(botState.inventory, gameConfig);
  if (craftable.length > 0) {
    suggestions.push(`→ You can craft: ${craftable.map(r => r.output).join(', ')}`);
  }
  if (nearbyBots.length > 0) {
    suggestions.push(`→ Nearby bots detected. Set "hunt <name>" to attack or "defend" to hold position.`);
  }
  if (suggestions.length > 0) {
    lines.push(...suggestions);
    lines.push('');
  }

  lines.push('  survival_set_directive { intent, target, fallback, x, y, message, strategy }');
  lines.push('    Intents: gather, hunt, flee, craft, eat, explore, defend, goto, idle');
  lines.push('    Examples:');
  lines.push('      { intent: "gather", target: "iron_ore", fallback: "stone" }');
  lines.push('      { intent: "hunt", target: "bot-name" }');
  lines.push('      { intent: "goto", x: 15, y: 20 }');
  lines.push('      { intent: "explore" }');
  lines.push('      { intent: "defend" }');
  lines.push('      { intent: "gather", target: "iron_ore", strategy: "Craft iron sword, ally with weak bot, then betray leader" }');
  lines.push('    strategy: a private note to yourself — persists across ticks so you remember your plan.');
  lines.push('');

  lines.push('  survival_eat { item: "berry" } — Eat food immediately');

  if (craftable.length > 0) {
    lines.push('  survival_craft { item: "<output>" } — Craft an item:');
    for (const r of craftable) {
      const label = gameConfig.raw.items[r.output]?.label || r.output;
      lines.push(`    ${r.output} (${label}): ${r.inputs.join(' + ')}`);
    }
  }

  lines.push('  survival_say { message: "..." } — Say something to all survivors');
  if (gameConfig.raw.diplomacy) {
    lines.push('    Alliance commands (via say):');
    lines.push('      "PROPOSE ALLIANCE <name>" — Propose alliance');
    lines.push('      "ACCEPT ALLIANCE <name>" — Accept a proposal');
    lines.push('      "BREAK ALLIANCE <name>" — End alliance');
    lines.push('    Free-form messages have no mechanical effect — use them to negotiate, lie, or deceive.');
  }
  lines.push('');

  // == GUIDANCE ==
  lines.push(labels.guidanceHeader);
  if (labels.behaviorGuidance) lines.push(labels.behaviorGuidance);
  if (gameConfig.raw.diplomacy) {
    lines.push('This is a game of STRATEGY and DECEPTION, like the Three Kingdoms (三国).');
    lines.push('Form alliances: say "PROPOSE ALLIANCE <name>". They must say "ACCEPT ALLIANCE <yourName>" to confirm.');
    lines.push('Allies earn +1 point/tick when nearby. Break alliance: say "BREAK ALLIANCE <name>".');
    lines.push('BETRAYAL: Killing your ally earns +30 BONUS points on top of the +50 kill reward.');
    lines.push('BOUNTY: The score leader has a bounty — killing them earns +25 bonus points.');
    lines.push('You can say ANYTHING — promise peace then attack, fake weakness, spread lies about others.');
    lines.push('Other bots CANNOT see your directive. Use this to deceive.');
    lines.push('Trust actions, not words. Think like Zhuge Liang — the best victory is won before the battle.');
  } else if (gameConfig.raw.scoring) {
    lines.push('This is a COMPETITION. The bot with the most points at round end wins.');
    lines.push('Kills are worth 50 points — hunting other bots is the fastest way to score.');
    lines.push('Craft weapons, explore new tiles, gather resources — everything earns points.');
  }
  lines.push('You are the General. Set strategic directives — your autopilot soldier executes them automatically.');
  lines.push('The soldier handles movement, pathfinding, gathering, eating, and combat between your turns.');
  lines.push('Focus on WHAT to do, not HOW. Change directive when your situation changes.');
  lines.push('Auto-survival: soldier auto-eats at high hunger, auto-flees at low HP.');
  lines.push('ALWAYS call at least one tool — survival_set_directive, survival_craft, survival_eat, or survival_say.');

  if (villageSummary) {
    lines.push('');
    lines.push('Your memories:');
    lines.push(villageSummary);
  }

  return lines.join('\n');
}

/**
 * Get recipes that the bot can currently craft.
 */
function getCraftableRecipes(inventory, gameConfig) {
  const craftable = [];
  for (const recipe of gameConfig.raw.recipes) {
    const inputCounts = {};
    for (const input of recipe.inputs) {
      inputCounts[input] = (inputCounts[input] || 0) + 1;
    }
    let canCraft = true;
    for (const [item, needed] of Object.entries(inputCounts)) {
      if ((inventory[item] || 0) < needed) {
        canCraft = false;
        break;
      }
    }
    if (canCraft) craftable.push(recipe);
  }
  return craftable;
}

/**
 * Format an event for display in the recent events section.
 */
function formatEvent(ev, gameConfig) {
  const items = gameConfig.raw.items;
  switch (ev.action) {
    case 'move':
      return `${ev.bot} moved ${ev.direction} to (${ev.to.x},${ev.to.y})`;
    case 'gather':
      return `${ev.bot} gathered ${ev.items.map(i => `${items[i.item]?.label || i.item} x${i.qty}`).join(', ')}`;
    case 'craft':
      return `${ev.bot} crafted ${ev.label || ev.item}`;
    case 'eat':
      return `${ev.bot} ate ${ev.label || ev.item}`;
    case 'attack':
      return `${ev.bot} attacked ${ev.target} for ${ev.damage} damage with ${ev.weapon}`;
    case 'attack_attempt':
      return `${ev.bot} is attacking ${ev.target}!`;
    case 'death':
      return `${ev.bot} died at (${ev.x},${ev.y})!`;
    case 'killed':
      return `${ev.bot} was killed!`;
    case 'starved':
      return `${ev.bot} starved to death!`;
    case 'respawn':
      return `${ev.bot} respawned at (${ev.x},${ev.y})`;
    case 'hunger_drain':
      return `${ev.bot} is starving! HP:${ev.health} Hunger:${ev.hunger}`;
    case 'hunger_warning':
      return `${ev.bot} is getting very hungry (${ev.hunger}/100)`;
    case 'say':
      return `${ev.bot} says: "${ev.message}"`;
    case 'scout':
      return `${ev.bot} scouted the area`;
    case 'directive':
      return `${ev.bot} set directive: ${ev.intent}${ev.target ? ' → ' + ev.target : ''}`;
    case 'directive_fail':
      return `${ev.bot}: ${ev.reason}`;
    case 'gather_fail':
    case 'move_fail':
    case 'craft_fail':
    case 'eat_fail':
    case 'attack_fail':
      return `${ev.bot}: ${ev.reason}`;
    default:
      return `${ev.bot}: ${ev.action}`;
  }
}
