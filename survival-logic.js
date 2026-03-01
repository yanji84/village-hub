/**
 * Core simulation logic for grid-based survival games.
 *
 * Pure functions — no module-level state, no I/O.
 * Handles movement, gathering, crafting, eating, combat, and survival mechanics.
 */

// --- Direction mapping ---

const DIRECTIONS = {
  N:  { dx: 0,  dy: -1 },
  S:  { dx: 0,  dy: 1 },
  E:  { dx: 1,  dy: 0 },
  W:  { dx: -1, dy: 0 },
  NE: { dx: 1,  dy: -1 },
  NW: { dx: -1, dy: -1 },
  SE: { dx: 1,  dy: 1 },
  SW: { dx: -1, dy: 1 },
};

// --- Helpers ---

function terrainTypeFromChar(ch, worldConfig) {
  for (const [type, cfg] of Object.entries(worldConfig.terrain)) {
    if (cfg.char === ch) return type;
  }
  return null;
}

function countInventory(inventory) {
  let total = 0;
  for (const qty of Object.values(inventory)) total += qty;
  return total;
}

function inventoryWeight(inventory, itemsConfig) {
  let total = 0;
  for (const [item, qty] of Object.entries(inventory)) {
    const cfg = itemsConfig[item];
    if (cfg) total += cfg.weight * qty;
  }
  return total;
}

function removeFromInventory(inventory, item, count = 1) {
  if (!inventory[item] || inventory[item] < count) return false;
  inventory[item] -= count;
  if (inventory[item] <= 0) delete inventory[item];
  return true;
}

function addToInventory(inventory, item, count = 1) {
  inventory[item] = (inventory[item] || 0) + count;
}

// --- Action processing ---

/**
 * Process a bot's actions for one tick.
 * Enforces exclusivity: if an exclusive action is present, non-exclusive actions are ignored.
 *
 * @param {string} botName
 * @param {Array} actions - [{ tool, params }]
 * @param {object} botState - Mutable bot state { x, y, health, hunger, inventory, equipment, alive }
 * @param {object} worldState - { terrain, tileData, bots, clock }
 * @param {object} gameConfig - Full game config
 * @returns {{ events: Array, pendingAttacks: Array }}
 */
export function processActions(botName, actions, botState, worldState, gameConfig) {
  if (!botState.alive) return { events: [], pendingAttacks: [] };

  const events = [];
  const pendingAttacks = [];
  const actionsConfig = gameConfig.raw.actions;

  // Classify actions
  let hasExclusive = false;
  let exclusiveAction = null;
  const nonExclusiveActions = [];

  for (const action of actions) {
    // Map tool names to action types
    const actionType = toolToActionType(action.tool);
    if (!actionType || !actionsConfig[actionType]) continue;

    if (actionsConfig[actionType].exclusive) {
      if (!hasExclusive) {
        hasExclusive = true;
        exclusiveAction = action;
      }
      // Ignore additional exclusive actions
    } else {
      nonExclusiveActions.push(action);
    }
  }

  // If exclusive action present, only process that one
  const toProcess = hasExclusive ? [exclusiveAction] : nonExclusiveActions;

  for (const action of toProcess) {
    const actionType = toolToActionType(action.tool);
    const params = action.params || {};

    switch (actionType) {
      case 'move': {
        const result = doMove(botName, botState, params.direction, worldState, gameConfig);
        events.push(...result);
        break;
      }
      case 'gather': {
        const result = doGather(botName, botState, worldState, gameConfig, worldState.clock.tick);
        events.push(...result);
        break;
      }
      case 'craft': {
        const result = doCraft(botName, botState, params.item, gameConfig);
        events.push(...result);
        break;
      }
      case 'eat': {
        const result = doEat(botName, botState, params.item, gameConfig);
        events.push(...result);
        break;
      }
      case 'attack': {
        const result = doAttack(botName, params.target, botState, worldState, gameConfig);
        if (result.pending) {
          pendingAttacks.push(result.pending);
        }
        events.push(...result.events);
        break;
      }
      case 'say': {
        events.push({
          action: 'say',
          bot: botName,
          message: (params.message || '').slice(0, 500),
          x: botState.x,
          y: botState.y,
        });
        break;
      }
      case 'scout': {
        const result = doScout(botName, botState, worldState, gameConfig);
        events.push(...result);
        break;
      }
      case 'set_directive': {
        const result = applyDirective(botName, botState, params);
        events.push(...result);
        break;
      }
    }
  }

  return { events, pendingAttacks };
}

function toolToActionType(tool) {
  const map = {
    survival_move: 'move',
    survival_gather: 'gather',
    survival_craft: 'craft',
    survival_eat: 'eat',
    survival_attack: 'attack',
    survival_say: 'say',
    survival_scout: 'scout',
    survival_set_directive: 'set_directive',
  };
  return map[tool] || null;
}

// --- Directive ---

const VALID_INTENTS = new Set([
  'gather', 'hunt', 'flee', 'craft', 'eat', 'explore', 'defend', 'goto', 'idle',
]);

/**
 * Validate and store a directive on the bot state.
 *
 * @param {string} botName
 * @param {object} botState - Mutable
 * @param {object} params - { intent, target, fallback, x, y, message }
 * @returns {Array} events
 */
export function applyDirective(botName, botState, params) {
  const intent = params.intent || 'idle';
  if (!VALID_INTENTS.has(intent)) {
    return [{ action: 'directive_fail', bot: botName, reason: `Unknown intent: ${intent}` }];
  }

  botState.directive = {
    intent,
    target: params.target || null,
    fallback: params.fallback || null,
    x: params.x != null ? params.x : null,
    y: params.y != null ? params.y : null,
    setAt: botState._currentTick || 0,
  };

  // Reset pathfinding when directive changes
  botState.path = null;
  botState.pathIdx = 0;

  const events = [{
    action: 'directive',
    bot: botName,
    intent,
    target: params.target || null,
    x: botState.x,
    y: botState.y,
  }];

  // Handle optional speech
  if (params.message) {
    events.push({
      action: 'say',
      bot: botName,
      message: (params.message || '').slice(0, 500),
      x: botState.x,
      y: botState.y,
    });
  }

  return events;
}

// --- Move ---

export function doMove(botName, botState, direction, worldState, gameConfig) {
  const dir = DIRECTIONS[(direction || '').toUpperCase()];
  if (!dir) {
    return [{ action: 'move_fail', bot: botName, reason: `Invalid direction: ${direction}` }];
  }

  const newX = botState.x + dir.dx;
  const newY = botState.y + dir.dy;
  const { width, height } = gameConfig.raw.world;

  // Bounds check
  if (newX < 0 || newX >= width || newY < 0 || newY >= height) {
    return [{ action: 'move_fail', bot: botName, reason: 'Edge of the world' }];
  }

  // Terrain passability
  const idx = newY * width + newX;
  const ch = worldState.terrain[idx];
  const type = terrainTypeFromChar(ch, gameConfig.raw.world);
  if (!type || gameConfig.raw.world.terrain[type].moveCost < 0) {
    return [{ action: 'move_fail', bot: botName, reason: `Impassable terrain (${type || 'unknown'})` }];
  }

  const oldX = botState.x;
  const oldY = botState.y;
  botState.x = newX;
  botState.y = newY;

  return [{
    action: 'move',
    bot: botName,
    from: { x: oldX, y: oldY },
    to: { x: newX, y: newY },
    direction: (direction || '').toUpperCase(),
    terrain: type,
  }];
}

// --- Gather ---

export function doGather(botName, botState, worldState, gameConfig, currentTick) {
  const key = `${botState.x},${botState.y}`;
  const tile = worldState.tileData[key];

  if (!tile || !tile.resources || tile.resources.length === 0) {
    return [{ action: 'gather_fail', bot: botName, reason: 'No resources here' }];
  }

  const maxSlots = gameConfig.raw.survival.inventorySlots;
  const currentSlots = countInventory(botState.inventory);

  // Calculate gather bonus from equipped tool
  let gatherBonus = 0;
  if (botState.equipment.tool) {
    const toolCfg = gameConfig.raw.items[botState.equipment.tool];
    if (toolCfg && toolCfg.gatherBonus) gatherBonus = toolCfg.gatherBonus;
  }

  const gathered = [];
  const remaining = [];

  for (const res of tile.resources) {
    const qty = Math.min(res.qty, 1 + gatherBonus);
    const canAdd = maxSlots - currentSlots - gathered.reduce((s, g) => s + g.qty, 0);
    const actualQty = Math.min(qty, canAdd);

    if (actualQty > 0) {
      addToInventory(botState.inventory, res.item, actualQty);
      gathered.push({ item: res.item, qty: actualQty });
      const leftover = res.qty - actualQty;
      if (leftover > 0) remaining.push({ item: res.item, qty: leftover });
    } else {
      remaining.push(res);
    }
  }

  if (gathered.length === 0) {
    return [{ action: 'gather_fail', bot: botName, reason: 'Inventory full' }];
  }

  // Update tile
  if (remaining.length > 0) {
    tile.resources = remaining;
  } else {
    tile.resources = [];
    tile.depletedAt = currentTick;
  }

  const depleted = remaining.length === 0;
  return [{
    action: 'gather',
    bot: botName,
    items: gathered,
    x: botState.x,
    y: botState.y,
    depleted,
  }];
}

// --- Craft ---

export function doCraft(botName, botState, recipeOutput, gameConfig) {
  if (!recipeOutput) {
    return [{ action: 'craft_fail', bot: botName, reason: 'No item specified' }];
  }

  // Find recipe
  const recipe = gameConfig.raw.recipes.find(r => r.output === recipeOutput);
  if (!recipe) {
    return [{ action: 'craft_fail', bot: botName, reason: `Unknown recipe: ${recipeOutput}` }];
  }

  // Count required inputs
  const inputCounts = {};
  for (const input of recipe.inputs) {
    inputCounts[input] = (inputCounts[input] || 0) + 1;
  }

  // Check inventory has all inputs
  for (const [item, needed] of Object.entries(inputCounts)) {
    if ((botState.inventory[item] || 0) < needed) {
      return [{ action: 'craft_fail', bot: botName, reason: `Missing ${item} (need ${needed}, have ${botState.inventory[item] || 0})` }];
    }
  }

  // Check inventory space (consuming inputs frees slots, output takes 1)
  const maxSlots = gameConfig.raw.survival.inventorySlots;
  const currentSlots = countInventory(botState.inventory);
  const inputTotal = recipe.inputs.length;
  const afterCraft = currentSlots - inputTotal + 1;
  if (afterCraft > maxSlots) {
    return [{ action: 'craft_fail', bot: botName, reason: 'Not enough inventory space' }];
  }

  // Consume inputs
  for (const [item, needed] of Object.entries(inputCounts)) {
    removeFromInventory(botState.inventory, item, needed);
  }

  // Add output
  addToInventory(botState.inventory, recipeOutput);

  // Auto-equip if equipment slot is empty
  const outputCfg = gameConfig.raw.items[recipeOutput];
  if (outputCfg) {
    if (outputCfg.type === 'weapon' && !botState.equipment.weapon) {
      botState.equipment.weapon = recipeOutput;
      removeFromInventory(botState.inventory, recipeOutput);
    } else if (outputCfg.type === 'armor' && !botState.equipment.armor) {
      botState.equipment.armor = recipeOutput;
      removeFromInventory(botState.inventory, recipeOutput);
    } else if (outputCfg.type === 'tool' && !botState.equipment.tool) {
      botState.equipment.tool = recipeOutput;
      removeFromInventory(botState.inventory, recipeOutput);
    }
  }

  return [{
    action: 'craft',
    bot: botName,
    item: recipeOutput,
    label: outputCfg?.label || recipeOutput,
    inputs: recipe.inputs,
  }];
}

// --- Eat ---

export function doEat(botName, botState, itemId, gameConfig) {
  if (!itemId) {
    return [{ action: 'eat_fail', bot: botName, reason: 'No item specified' }];
  }

  const itemCfg = gameConfig.raw.items[itemId];
  if (!itemCfg || itemCfg.type !== 'food') {
    return [{ action: 'eat_fail', bot: botName, reason: `${itemId} is not food` }];
  }

  if ((botState.inventory[itemId] || 0) < 1) {
    return [{ action: 'eat_fail', bot: botName, reason: `No ${itemId} in inventory` }];
  }

  removeFromInventory(botState.inventory, itemId);

  const hungerBefore = botState.hunger;
  botState.hunger = Math.max(0, botState.hunger - (itemCfg.hungerRestore || 0));

  // Optional health restore
  if (itemCfg.healthRestore) {
    botState.health = Math.min(gameConfig.raw.survival.maxHealth, botState.health + itemCfg.healthRestore);
  }

  return [{
    action: 'eat',
    bot: botName,
    item: itemId,
    label: itemCfg.label || itemId,
    hungerBefore,
    hungerAfter: botState.hunger,
  }];
}

// --- Attack ---

export function doAttack(botName, targetName, botState, worldState, gameConfig) {
  const events = [];

  if (!targetName) {
    return { events: [{ action: 'attack_fail', bot: botName, reason: 'No target specified' }], pending: null };
  }

  const targetState = worldState.bots[targetName];
  if (!targetState || !targetState.alive) {
    return { events: [{ action: 'attack_fail', bot: botName, reason: `${targetName} not found or dead` }], pending: null };
  }

  // Adjacency check (within 1 tile in any direction)
  const dx = Math.abs(botState.x - targetState.x);
  const dy = Math.abs(botState.y - targetState.y);
  if (dx > 1 || dy > 1) {
    return { events: [{ action: 'attack_fail', bot: botName, reason: `${targetName} is too far away` }], pending: null };
  }

  // Queue for simultaneous resolution
  return {
    events: [{ action: 'attack_attempt', bot: botName, target: targetName }],
    pending: { attacker: botName, target: targetName },
  };
}

// --- Scout (enhanced visibility for one turn) ---

export function doScout(botName, botState, worldState, gameConfig) {
  // Scout reveals a larger area — handled in scene building
  // Here we just emit the event
  return [{
    action: 'scout',
    bot: botName,
    x: botState.x,
    y: botState.y,
  }];
}

// --- Simultaneous combat resolution ---

/**
 * Resolve all pending attacks simultaneously.
 * Damage is computed for all pairs, then applied all at once.
 *
 * @param {Array} attacks - [{ attacker, target }]
 * @param {object} botsState - { botName: { health, equipment, ... } }
 * @param {object} gameConfig
 * @returns {Array} events
 */
export function resolveCombat(attacks, botsState, gameConfig) {
  if (attacks.length === 0) return [];

  const events = [];
  const damageMap = {}; // botName → total damage to apply

  for (const { attacker, target } of attacks) {
    const attackerState = botsState[attacker];
    const targetState = botsState[target];
    if (!attackerState?.alive || !targetState?.alive) continue;

    // Calculate damage
    let damage = gameConfig.raw.combat.unarmedDamage;
    if (attackerState.equipment.weapon) {
      const weaponCfg = gameConfig.raw.items[attackerState.equipment.weapon];
      if (weaponCfg?.damage) damage = weaponCfg.damage;
    }

    // Apply defense
    let defense = 0;
    if (targetState.equipment.armor) {
      const armorCfg = gameConfig.raw.items[targetState.equipment.armor];
      if (armorCfg?.defense) defense = armorCfg.defense;
    }

    const actualDamage = Math.max(1, damage - defense);
    damageMap[target] = (damageMap[target] || 0) + actualDamage;

    events.push({
      action: 'attack',
      bot: attacker,
      target,
      damage: actualDamage,
      weapon: attackerState.equipment.weapon || 'unarmed',
    });
  }

  // Apply all damage simultaneously
  for (const [botName, totalDamage] of Object.entries(damageMap)) {
    const bs = botsState[botName];
    if (!bs) continue;
    bs.health = Math.max(0, bs.health - totalDamage);

    if (bs.health <= 0) {
      events.push({ action: 'killed', bot: botName });
    }
  }

  return events;
}

// --- Survival tick (hunger/health drain) ---

/**
 * Apply hunger increase and health drain per tick.
 *
 * @param {object} botsState - { botName: { health, hunger, alive, ... } }
 * @param {object} survivalConfig
 * @returns {Array} events
 */
export function tickSurvival(botsState, survivalConfig) {
  const events = [];

  for (const [botName, bs] of Object.entries(botsState)) {
    if (!bs.alive) continue;

    bs.hunger = Math.min(survivalConfig.maxHunger, bs.hunger + survivalConfig.hungerPerTick);

    if (bs.hunger >= survivalConfig.hungerDrainThreshold) {
      const drain = survivalConfig.healthDrainRate;
      bs.health = Math.max(0, bs.health - drain);

      events.push({
        action: 'hunger_drain',
        bot: botName,
        hunger: bs.hunger,
        health: bs.health,
        drain,
      });

      if (bs.health <= 0) {
        events.push({ action: 'starved', bot: botName });
      }
    } else if (bs.hunger >= survivalConfig.hungerDrainThreshold - 10) {
      events.push({
        action: 'hunger_warning',
        bot: botName,
        hunger: bs.hunger,
      });
    }
  }

  return events;
}

// --- Death handling ---

/**
 * Handle bot death: drop inventory, reset to edge tile.
 *
 * @param {string} botName
 * @param {object} botState - Mutable
 * @param {object} worldState - { terrain, tileData, ... }
 * @param {object} survivalConfig
 * @param {object} terrainConfig
 * @param {Function} rng
 * @param {number} width
 * @param {number} height
 * @returns {Array} events
 */
export function handleDeath(botName, botState, worldState, survivalConfig, terrainConfig, rng, width, height) {
  const events = [];

  // Drop inventory at death position
  const dropKey = `${botState.x},${botState.y}`;
  const droppedItems = { ...botState.inventory };

  // Also drop equipment
  for (const [slot, item] of Object.entries(botState.equipment)) {
    if (item) {
      droppedItems[item] = (droppedItems[item] || 0) + 1;
      botState.equipment[slot] = null;
    }
  }

  if (Object.keys(droppedItems).length > 0) {
    // Add to tile data
    if (!worldState.tileData[dropKey]) {
      worldState.tileData[dropKey] = { resources: [], depletedAt: 0 };
    }
    const tile = worldState.tileData[dropKey];
    for (const [item, qty] of Object.entries(droppedItems)) {
      const existing = tile.resources.find(r => r.item === item);
      if (existing) {
        existing.qty += qty;
      } else {
        tile.resources.push({ item, qty });
      }
    }
    tile.depletedAt = 0; // Dropped items are always available
  }

  events.push({
    action: 'death',
    bot: botName,
    x: botState.x,
    y: botState.y,
    droppedItems,
  });

  // Reset bot state
  botState.inventory = {};
  botState.equipment = { weapon: null, armor: null, tool: null };
  botState.health = survivalConfig.respawnHealth;
  botState.hunger = survivalConfig.respawnHunger;
  botState.alive = true;

  // Find respawn position on grid edge
  const pos = findRespawnPosition(worldState.terrain, width, height, terrainConfig, rng);
  botState.x = pos.x;
  botState.y = pos.y;

  events.push({
    action: 'respawn',
    bot: botName,
    x: pos.x,
    y: pos.y,
  });

  return events;
}

/**
 * Find a respawn position on the grid edge.
 * Inlined to avoid circular import.
 */
function findRespawnPosition(terrain, width, height, terrainConfig, rng) {
  const edges = [];
  for (let x = 0; x < width; x++) {
    for (const y of [0, height - 1]) {
      const ch = terrain[y * width + x];
      const type = terrainTypeFromChar(ch, { terrain: terrainConfig });
      if (type && terrainConfig[type].moveCost > 0) {
        edges.push({ x, y });
      }
    }
  }
  for (let y = 1; y < height - 1; y++) {
    for (const x of [0, width - 1]) {
      const ch = terrain[y * width + x];
      const type = terrainTypeFromChar(ch, { terrain: terrainConfig });
      if (type && terrainConfig[type].moveCost > 0) {
        edges.push({ x, y });
      }
    }
  }

  if (edges.length === 0) return { x: 0, y: 0 };
  return edges[Math.floor(rng() * edges.length)];
}
