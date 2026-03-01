/**
 * Autopilot — fast-tick "Soldier" logic for grid-based survival games.
 *
 * Runs every 2s alongside the 60s slow tick (LLM "General").
 * Executes pathfinding, auto-gather, auto-eat, auto-combat, auto-flee
 * based on the bot's current directive (set by the LLM).
 *
 * Pure functions — no module-level state, no I/O.
 */

import {
  doMove,
  doGather,
  doEat,
  doAttack,
  resolveCombat,
} from './survival-logic.js';

// --- Direction helpers ---

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

function terrainTypeFromChar(ch, terrainConfig) {
  for (const [type, cfg] of Object.entries(terrainConfig)) {
    if (cfg.char === ch) return type;
  }
  return null;
}

function isPassable(x, y, terrain, width, height, terrainConfig) {
  if (x < 0 || x >= width || y < 0 || y >= height) return false;
  const ch = terrain[y * width + x];
  const type = terrainTypeFromChar(ch, terrainConfig);
  if (!type) return false;
  return terrainConfig[type].moveCost > 0;
}

function countInventory(inventory) {
  let total = 0;
  for (const qty of Object.values(inventory)) total += qty;
  return total;
}

// --- A* Pathfinding ---

/**
 * A* pathfinding on the grid.
 *
 * @param {number} fromX
 * @param {number} fromY
 * @param {number} toX
 * @param {number} toY
 * @param {string} terrain - flat terrain string
 * @param {number} width
 * @param {number} height
 * @param {object} terrainConfig - { plains: { moveCost, char }, ... }
 * @returns {Array<{x,y}>} path from start to goal (exclusive of start), empty if no path
 */
export function findPath(fromX, fromY, toX, toY, terrain, width, height, terrainConfig) {
  if (fromX === toX && fromY === toY) return [];
  if (!isPassable(toX, toY, terrain, width, height, terrainConfig)) return [];

  const MAX_NODES = 100;
  const key = (x, y) => y * width + x;

  // Min-heap using array (simple for small grids)
  const open = []; // [{ x, y, g, f }]
  const gMap = new Map(); // key → g cost
  const parent = new Map(); // key → parent key
  const closed = new Set();

  const h = (x, y) => Math.abs(x - toX) + Math.abs(y - toY);

  const startKey = key(fromX, fromY);
  const startG = 0;
  const startF = h(fromX, fromY);
  open.push({ x: fromX, y: fromY, g: startG, f: startF });
  gMap.set(startKey, startG);

  let explored = 0;

  while (open.length > 0 && explored < MAX_NODES) {
    // Find min f in open list
    let minIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[minIdx].f) minIdx = i;
    }
    const current = open[minIdx];
    open.splice(minIdx, 1);

    const ck = key(current.x, current.y);
    if (closed.has(ck)) continue;
    closed.add(ck);
    explored++;

    // Goal reached
    if (current.x === toX && current.y === toY) {
      // Reconstruct path
      const path = [];
      let k = ck;
      while (k !== startKey) {
        const px = k % width;
        const py = Math.floor(k / width);
        path.push({ x: px, y: py });
        k = parent.get(k);
        if (k === undefined) break;
      }
      path.reverse();
      return path;
    }

    // Expand neighbors (8 directions)
    for (const dir of Object.values(DIRECTIONS)) {
      const nx = current.x + dir.dx;
      const ny = current.y + dir.dy;
      if (!isPassable(nx, ny, terrain, width, height, terrainConfig)) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;

      // Move cost from terrain
      const ch = terrain[ny * width + nx];
      const type = terrainTypeFromChar(ch, terrainConfig);
      const moveCost = terrainConfig[type]?.moveCost || 1;
      const ng = current.g + moveCost;

      const existing = gMap.get(nk);
      if (existing !== undefined && ng >= existing) continue;

      gMap.set(nk, ng);
      parent.set(nk, ck);
      open.push({ x: nx, y: ny, g: ng, f: ng + h(nx, ny) });
    }
  }

  return []; // No path found
}

// --- BFS: Find nearest resource ---

/**
 * BFS scan to find closest tile with targetItem.
 *
 * @param {number} botX
 * @param {number} botY
 * @param {string} targetItem - resource item id (e.g. "iron_ore")
 * @param {object} tileData - { "x,y": { resources: [{item, qty}] } }
 * @param {string} terrain
 * @param {number} width
 * @param {number} height
 * @param {object} terrainConfig
 * @param {string} [fallbackItem] - optional fallback if targetItem not found
 * @returns {{x, y}|null}
 */
export function findNearestResource(botX, botY, targetItem, tileData, terrain, width, height, terrainConfig, fallbackItem) {
  const MAX_SEARCH = 200;
  const visited = new Set();
  const queue = [{ x: botX, y: botY }];
  visited.add(botY * width + botX);

  let fallbackResult = null;
  let searched = 0;

  while (queue.length > 0 && searched < MAX_SEARCH) {
    const { x, y } = queue.shift();
    searched++;

    // Check if tile has target resource
    const key = `${x},${y}`;
    const tile = tileData[key];
    if (tile?.resources?.length > 0) {
      if (tile.resources.some(r => r.item === targetItem)) {
        return { x, y };
      }
      if (fallbackItem && !fallbackResult && tile.resources.some(r => r.item === fallbackItem)) {
        fallbackResult = { x, y };
      }
    }

    // Expand neighbors
    for (const dir of Object.values(DIRECTIONS)) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      const nk = ny * width + nx;
      if (visited.has(nk)) continue;
      if (!isPassable(nx, ny, terrain, width, height, terrainConfig)) continue;
      visited.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }

  return fallbackResult;
}

// --- Find nearest food resource on the map ---

function findNearestFood(botX, botY, tileData, terrain, width, height, terrainConfig, itemsConfig) {
  const MAX_SEARCH = 200;
  const visited = new Set();
  const queue = [{ x: botX, y: botY }];
  visited.add(botY * width + botX);
  let searched = 0;

  while (queue.length > 0 && searched < MAX_SEARCH) {
    const { x, y } = queue.shift();
    searched++;

    const key = `${x},${y}`;
    const tile = tileData[key];
    if (tile?.resources?.length > 0) {
      if (tile.resources.some(r => itemsConfig[r.item]?.type === 'food')) {
        return { x, y };
      }
    }

    for (const dir of Object.values(DIRECTIONS)) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      const nk = ny * width + nx;
      if (visited.has(nk)) continue;
      if (!isPassable(nx, ny, terrain, width, height, terrainConfig)) continue;
      visited.add(nk);
      queue.push({ x: nx, y: ny });
    }
  }

  return null;
}

// --- Direction from point A to point B ---

function directionToward(fromX, fromY, toX, toY) {
  const dx = Math.sign(toX - fromX);
  const dy = Math.sign(toY - fromY);

  for (const [name, d] of Object.entries(DIRECTIONS)) {
    if (d.dx === dx && d.dy === dy) return name;
  }
  return 'N'; // fallback
}

function directionAway(fromX, fromY, threatX, threatY) {
  const dx = -Math.sign(threatX - fromX) || 1;
  const dy = -Math.sign(threatY - fromY) || 1;

  for (const [name, d] of Object.entries(DIRECTIONS)) {
    if (d.dx === dx && d.dy === dy) return name;
  }
  return 'S'; // fallback
}

// --- Step autopilot (one bot, one fast tick) ---

/**
 * Execute one autopilot step for a bot.
 *
 * @param {string} botName
 * @param {object} botState - mutable bot state (has directive, path, pathIdx, etc.)
 * @param {object} worldState - { terrain, tileData, bots, clock }
 * @param {object} gameConfig
 * @param {number} currentTick - slow tick number (for events)
 * @returns {{ events: Array, pendingAttacks: Array }}
 */
export function stepAutopilot(botName, botState, worldState, gameConfig) {
  if (!botState.alive) return { events: [], pendingAttacks: [] };

  const events = [];
  const pendingAttacks = [];
  const autopilotCfg = gameConfig.raw.autopilot || {};
  const survivalCfg = gameConfig.raw.survival;
  const worldCfg = gameConfig.raw.world;
  const terrainConfig = worldCfg.terrain;
  const width = worldCfg.width;
  const height = worldCfg.height;
  const itemsConfig = gameConfig.raw.items;
  const maxSlots = survivalCfg.inventorySlots;

  const directive = botState.directive || { intent: 'idle' };

  // --- Auto-survival reflexes (override directive) ---

  const autoEatThreshold = autopilotCfg.autoEatThreshold || 70;
  const autoFleeThreshold = autopilotCfg.autoFleeThreshold || 20;

  // Auto-eat if hunger >= threshold and have food
  if (botState.hunger >= autoEatThreshold) {
    const foodItem = Object.keys(botState.inventory).find(item => itemsConfig[item]?.type === 'food');
    if (foodItem) {
      const eatEvents = doEat(botName, botState, foodItem, gameConfig);
      events.push(...eatEvents);
      if (botState.fastTickStats) botState.fastTickStats.autoAte = true;
      return { events, pendingAttacks };
    }
  }

  // Auto-flee if health <= threshold and being attacked
  if (botState.health <= autoFleeThreshold && directive.intent !== 'flee') {
    // Check if any adjacent bot has a hunt directive targeting us
    const nearestThreat = findNearestThreat(botName, botState, worldState.bots);
    if (nearestThreat) {
      const dir = directionAway(botState.x, botState.y, nearestThreat.x, nearestThreat.y);
      const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
      events.push(...moveEvents);
      if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
      return { events, pendingAttacks };
    }
  }

  // --- Directive-driven behavior ---

  switch (directive.intent) {
    case 'gather': {
      // Auto-gather if on resource tile
      const tileKey = `${botState.x},${botState.y}`;
      const tile = worldState.tileData[tileKey];
      if (tile?.resources?.length > 0 && countInventory(botState.inventory) < maxSlots) {
        const gatherEvents = doGather(botName, botState, worldState, gameConfig, worldState.clock?.tick || 0);
        events.push(...gatherEvents);
        if (botState.fastTickStats) {
          for (const ev of gatherEvents) {
            if (ev.action === 'gather' && ev.items) {
              botState.fastTickStats.itemsGathered.push(...ev.items.map(i => i.item));
            }
          }
        }
        // Path to next resource after gathering
        botState.path = null;
        botState.pathIdx = 0;
        return { events, pendingAttacks };
      }

      // Pathfind to nearest resource with target item
      const target = directive.target || 'wood';
      if (!botState.path || botState.path.length === 0 || botState.pathIdx >= botState.path.length) {
        const dest = findNearestResource(botState.x, botState.y, target, worldState.tileData,
          worldState.terrain, width, height, terrainConfig, directive.fallback);
        if (dest) {
          botState.path = findPath(botState.x, botState.y, dest.x, dest.y,
            worldState.terrain, width, height, terrainConfig);
          botState.pathIdx = 0;
        } else {
          botState.path = null;
        }
      }

      // Move along path
      if (botState.path && botState.pathIdx < botState.path.length) {
        const next = botState.path[botState.pathIdx];
        const dir = directionToward(botState.x, botState.y, next.x, next.y);
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (moveEvents.some(e => e.action === 'move')) {
          botState.pathIdx++;
          if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
        } else {
          // Move failed — recalculate path next tick
          botState.path = null;
          botState.pathIdx = 0;
        }

        // Auto-gather on move if enabled
        if (autopilotCfg.autoGatherOnMove) {
          const newKey = `${botState.x},${botState.y}`;
          const newTile = worldState.tileData[newKey];
          if (newTile?.resources?.length > 0 && countInventory(botState.inventory) < maxSlots) {
            const gatherEvents = doGather(botName, botState, worldState, gameConfig, worldState.clock?.tick || 0);
            events.push(...gatherEvents);
            if (botState.fastTickStats) {
              for (const ev of gatherEvents) {
                if (ev.action === 'gather' && ev.items) {
                  botState.fastTickStats.itemsGathered.push(...ev.items.map(i => i.item));
                }
              }
            }
          }
        }
      }
      break;
    }

    case 'hunt': {
      const targetName = directive.target;
      if (!targetName) break;
      const targetBot = worldState.bots[targetName];
      if (!targetBot || !targetBot.alive) break;

      // Check adjacency
      const dx = Math.abs(botState.x - targetBot.x);
      const dy = Math.abs(botState.y - targetBot.y);

      if (dx <= 1 && dy <= 1) {
        // Attack
        const result = doAttack(botName, targetName, botState, worldState, gameConfig);
        events.push(...result.events);
        if (result.pending) pendingAttacks.push(result.pending);
      } else {
        // Pathfind toward target
        if (!botState.path || botState.path.length === 0 || botState.pathIdx >= botState.path.length) {
          botState.path = findPath(botState.x, botState.y, targetBot.x, targetBot.y,
            worldState.terrain, width, height, terrainConfig);
          botState.pathIdx = 0;
        }

        if (botState.path && botState.pathIdx < botState.path.length) {
          const next = botState.path[botState.pathIdx];
          const dir = directionToward(botState.x, botState.y, next.x, next.y);
          const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
          events.push(...moveEvents);
          if (moveEvents.some(e => e.action === 'move')) {
            botState.pathIdx++;
            if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
          } else {
            botState.path = null;
          }
        }
      }
      break;
    }

    case 'flee': {
      const threat = findNearestThreat(botName, botState, worldState.bots);
      if (threat) {
        const dir = directionAway(botState.x, botState.y, threat.x, threat.y);
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
      } else if (directive.target) {
        // Flee toward a specific direction
        const dir = directive.target.toUpperCase();
        if (DIRECTIONS[dir]) {
          const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
          events.push(...moveEvents);
          if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
        }
      }
      break;
    }

    case 'craft': {
      // Crafting is handled directly by slow tick LLM response
      // But we can auto-gather missing ingredients
      const targetItem = directive.target;
      if (!targetItem) break;

      const recipe = gameConfig.raw.recipes.find(r => r.output === targetItem);
      if (!recipe) break;

      // Check which inputs we need
      const inputCounts = {};
      for (const input of recipe.inputs) {
        inputCounts[input] = (inputCounts[input] || 0) + 1;
      }

      let missingItem = null;
      for (const [item, needed] of Object.entries(inputCounts)) {
        if ((botState.inventory[item] || 0) < needed) {
          missingItem = item;
          break;
        }
      }

      if (!missingItem) {
        // We have all ingredients — idle until LLM crafts
        break;
      }

      // Gather missing ingredient (behave like gather directive)
      const tileKey = `${botState.x},${botState.y}`;
      const tile = worldState.tileData[tileKey];
      if (tile?.resources?.length > 0 && tile.resources.some(r => r.item === missingItem)) {
        const gatherEvents = doGather(botName, botState, worldState, gameConfig, worldState.clock?.tick || 0);
        events.push(...gatherEvents);
        if (botState.fastTickStats) {
          for (const ev of gatherEvents) {
            if (ev.action === 'gather' && ev.items) {
              botState.fastTickStats.itemsGathered.push(...ev.items.map(i => i.item));
            }
          }
        }
        break;
      }

      // Pathfind to nearest tile with missing ingredient
      if (!botState.path || botState.path.length === 0 || botState.pathIdx >= botState.path.length) {
        const dest = findNearestResource(botState.x, botState.y, missingItem, worldState.tileData,
          worldState.terrain, width, height, terrainConfig);
        if (dest) {
          botState.path = findPath(botState.x, botState.y, dest.x, dest.y,
            worldState.terrain, width, height, terrainConfig);
          botState.pathIdx = 0;
        }
      }

      if (botState.path && botState.pathIdx < botState.path.length) {
        const next = botState.path[botState.pathIdx];
        const dir = directionToward(botState.x, botState.y, next.x, next.y);
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (moveEvents.some(e => e.action === 'move')) {
          botState.pathIdx++;
          if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
        } else {
          botState.path = null;
        }
      }
      break;
    }

    case 'eat': {
      // Try to eat from inventory
      const foodItem = Object.keys(botState.inventory).find(item => itemsConfig[item]?.type === 'food');
      if (foodItem) {
        const eatEvents = doEat(botName, botState, foodItem, gameConfig);
        events.push(...eatEvents);
        break;
      }

      // No food — gather nearest food
      const tileKey = `${botState.x},${botState.y}`;
      const tile = worldState.tileData[tileKey];
      if (tile?.resources?.length > 0 && tile.resources.some(r => itemsConfig[r.item]?.type === 'food')) {
        const gatherEvents = doGather(botName, botState, worldState, gameConfig, worldState.clock?.tick || 0);
        events.push(...gatherEvents);
        break;
      }

      // Pathfind to food
      if (!botState.path || botState.path.length === 0 || botState.pathIdx >= botState.path.length) {
        const dest = findNearestFood(botState.x, botState.y, worldState.tileData,
          worldState.terrain, width, height, terrainConfig, itemsConfig);
        if (dest) {
          botState.path = findPath(botState.x, botState.y, dest.x, dest.y,
            worldState.terrain, width, height, terrainConfig);
          botState.pathIdx = 0;
        }
      }

      if (botState.path && botState.pathIdx < botState.path.length) {
        const next = botState.path[botState.pathIdx];
        const dir = directionToward(botState.x, botState.y, next.x, next.y);
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (moveEvents.some(e => e.action === 'move')) {
          botState.pathIdx++;
          if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
        } else {
          botState.path = null;
        }
      }
      break;
    }

    case 'explore': {
      // Random walk biased away from current position
      // Pick a random passable neighbor
      const candidates = [];
      for (const [name, dir] of Object.entries(DIRECTIONS)) {
        const nx = botState.x + dir.dx;
        const ny = botState.y + dir.dy;
        if (isPassable(nx, ny, worldState.terrain, width, height, terrainConfig)) {
          candidates.push(name);
        }
      }
      if (candidates.length > 0) {
        // Simple pseudo-random using position + tick
        const tick = worldState.clock?.tick || 0;
        const idx = (botState.x * 7 + botState.y * 13 + tick * 3 + Date.now()) % candidates.length;
        const dir = candidates[Math.abs(idx) % candidates.length];
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;

        // Auto-gather on explore
        if (autopilotCfg.autoGatherOnMove) {
          const newKey = `${botState.x},${botState.y}`;
          const newTile = worldState.tileData[newKey];
          if (newTile?.resources?.length > 0 && countInventory(botState.inventory) < maxSlots) {
            const gatherEvents = doGather(botName, botState, worldState, gameConfig, worldState.clock?.tick || 0);
            events.push(...gatherEvents);
            if (botState.fastTickStats) {
              for (const ev of gatherEvents) {
                if (ev.action === 'gather' && ev.items) {
                  botState.fastTickStats.itemsGathered.push(...ev.items.map(i => i.item));
                }
              }
            }
          }
        }
      }
      break;
    }

    case 'defend': {
      // Stay put — attack any adjacent bot
      for (const [name, bs] of Object.entries(worldState.bots)) {
        if (name === botName || !bs.alive) continue;
        const dx = Math.abs(botState.x - bs.x);
        const dy = Math.abs(botState.y - bs.y);
        if (dx <= 1 && dy <= 1) {
          const result = doAttack(botName, name, botState, worldState, gameConfig);
          events.push(...result.events);
          if (result.pending) pendingAttacks.push(result.pending);
          break; // Only attack one per tick
        }
      }
      break;
    }

    case 'goto': {
      const gotoX = directive.x;
      const gotoY = directive.y;
      if (gotoX == null || gotoY == null) break;
      if (botState.x === gotoX && botState.y === gotoY) break; // Arrived

      if (!botState.path || botState.path.length === 0 || botState.pathIdx >= botState.path.length) {
        botState.path = findPath(botState.x, botState.y, gotoX, gotoY,
          worldState.terrain, width, height, terrainConfig);
        botState.pathIdx = 0;
      }

      if (botState.path && botState.pathIdx < botState.path.length) {
        const next = botState.path[botState.pathIdx];
        const dir = directionToward(botState.x, botState.y, next.x, next.y);
        const moveEvents = doMove(botName, botState, dir, worldState, gameConfig);
        events.push(...moveEvents);
        if (moveEvents.some(e => e.action === 'move')) {
          botState.pathIdx++;
          if (botState.fastTickStats) botState.fastTickStats.tilesMoved++;
        } else {
          botState.path = null;
        }
      }
      break;
    }

    case 'idle':
    default:
      // Do nothing
      break;
  }

  return { events, pendingAttacks };
}

// --- Find nearest threatening bot ---

function findNearestThreat(botName, botState, allBots) {
  let nearest = null;
  let nearestDist = Infinity;

  for (const [name, bs] of Object.entries(allBots)) {
    if (name === botName || !bs.alive) continue;
    // Check if this bot has a hunt directive targeting us
    if (bs.directive?.intent === 'hunt' && bs.directive?.target === botName) {
      const dist = Math.abs(botState.x - bs.x) + Math.abs(botState.y - bs.y);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = bs;
      }
    }
  }

  // Also consider any adjacent bot as a potential threat
  if (!nearest) {
    for (const [name, bs] of Object.entries(allBots)) {
      if (name === botName || !bs.alive) continue;
      const dx = Math.abs(botState.x - bs.x);
      const dy = Math.abs(botState.y - bs.y);
      if (dx <= 1 && dy <= 1) {
        return bs;
      }
    }
  }

  return nearest;
}

// --- Run fast tick for all bots ---

/**
 * Run one fast tick: iterate all alive bots, call stepAutopilot.
 *
 * @param {object} state - full world state (bots, terrain, tileData, clock)
 * @param {object} gameConfig
 * @returns {{ events: Array, positionUpdates: Object }}
 */
export function runFastTick(state, gameConfig) {
  const allEvents = [];
  const allPendingAttacks = [];
  const positionUpdates = {};
  const autopilotCfg = gameConfig.raw.autopilot || {};

  // Fractional hunger drain per fast tick
  // 30 fast ticks ≈ 1 slow tick (60s / 2s = 30)
  const hungerPerFastTick = (gameConfig.raw.survival.hungerPerTick || 3) / 30;

  for (const [botName, botState] of Object.entries(state.bots)) {
    if (!botState.alive) continue;

    // Initialize fastTickStats if missing
    if (!botState.fastTickStats) {
      botState.fastTickStats = {
        tilesMoved: 0,
        itemsGathered: [],
        damageDealt: 0,
        damageTaken: 0,
      };
    }

    const { events, pendingAttacks } = stepAutopilot(botName, botState, state, gameConfig);
    allEvents.push(...events);
    allPendingAttacks.push(...pendingAttacks);

    // Track position for broadcast
    positionUpdates[botName] = { x: botState.x, y: botState.y };

    // Fractional hunger increase
    botState.hunger = Math.min(
      gameConfig.raw.survival.maxHunger,
      botState.hunger + hungerPerFastTick
    );
  }

  // Resolve any combat from this fast tick (individual, not simultaneous)
  if (allPendingAttacks.length > 0) {
    const combatEvents = resolveCombat(allPendingAttacks, state.bots, gameConfig);
    allEvents.push(...combatEvents);

    // Track damage stats
    for (const ev of combatEvents) {
      if (ev.action === 'attack') {
        const attacker = state.bots[ev.bot];
        const target = state.bots[ev.target];
        if (attacker?.fastTickStats) attacker.fastTickStats.damageDealt += ev.damage || 0;
        if (target?.fastTickStats) target.fastTickStats.damageTaken += ev.damage || 0;
      }
    }
  }

  return { events: allEvents, positionUpdates };
}
