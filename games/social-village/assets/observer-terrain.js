/**
 * Observer terrain — chunked terrain rendering with LRU cache.
 */

import { mulberry32 } from './observer-utils.js';

const CHUNK_SIZE = 512;
const CHUNK_CACHE_MAX = 64;
const chunkCache = new Map(); // key "cx,cy" → { sprite, lastUsed }

let _terrainLayer = null;
let _LOCS = null;
let _frame = 0;

export function initTerrain(terrainLayer, LOCS) {
  _terrainLayer = terrainLayer;
  _LOCS = LOCS;
}

export function setFrame(f) { _frame = f; }

function drawTreeOnCanvas(c, x, y) {
  const TD = 6;
  c.fillStyle = '#5a3a1a'; c.fillRect(x + 6, y + 16, 6, 12);
  c.fillStyle = '#4a2a10';
  c.beginPath();
  c.moveTo(x + 12, y + 16); c.lineTo(x + 12 + TD, y + 16 - TD * 0.6);
  c.lineTo(x + 12 + TD, y + 28 - TD * 0.6); c.lineTo(x + 12, y + 28);
  c.fill();
  c.fillStyle = '#2a7a2a'; c.fillRect(x, y + 6, 18, 14);
  c.fillStyle = '#3a9a3a'; c.fillRect(x + 2, y, 14, 12);
  c.fillStyle = '#1a6a1a';
  c.beginPath();
  c.moveTo(x + 18, y + 6); c.lineTo(x + 18 + TD, y + 6 - TD * 0.6);
  c.lineTo(x + 18 + TD, y + 20 - TD * 0.6); c.lineTo(x + 18, y + 20);
  c.fill();
  c.fillStyle = '#4aaa4a'; c.fillRect(x + 5, y + 3, 4, 4);
}

function drawRockOnCanvas(c, x, y) {
  c.fillStyle = '#7a7a6a'; c.fillRect(x, y, 10, 6);
  c.fillStyle = '#8a8a7a'; c.fillRect(x + 1, y, 8, 4);
  c.fillStyle = '#9a9a8a'; c.fillRect(x + 2, y + 1, 4, 2);
}

function chunkSeed(cx, cy) {
  let h = 42;
  h = ((h << 5) - h + cx) | 0;
  h = ((h << 5) - h + cy) | 0;
  return h;
}

function isNearLocWorld(px, py, margin) {
  for (const L of Object.values(_LOCS)) {
    if (px > L.x - margin && px < L.x + L.w + margin &&
        py > L.y - margin && py < L.y + L.h + margin) return true;
  }
  return false;
}

function renderChunk(cx, cy) {
  const tc = document.createElement('canvas');
  tc.width = CHUNK_SIZE; tc.height = CHUNK_SIZE;
  const c = tc.getContext('2d');
  const ox = cx * CHUNK_SIZE, oy = cy * CHUNK_SIZE;
  const rng = mulberry32(chunkSeed(cx, cy));

  // Grass base
  c.fillStyle = '#3b7d34';
  c.fillRect(0, 0, CHUNK_SIZE, CHUNK_SIZE);

  // Grass variation
  for (let x = 0; x < CHUNK_SIZE; x += 6) {
    for (let y = 0; y < CHUNK_SIZE; y += 6) {
      const v = rng();
      if (v < 0.3) { c.fillStyle = '#4a8b3f'; c.fillRect(x, y, 4, 4); }
      else if (v < 0.4) { c.fillStyle = '#55a048'; c.fillRect(x, y, 2, 4); }
      if (rng() < 0.005) {
        c.fillStyle = ['#ff6','#f8f','#6ef','#fa5'][Math.floor(rng() * 4)];
        c.fillRect(x, y, 2, 2);
      }
    }
  }

  // Trees (2-4 per chunk)
  const treeCount = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < treeCount; i++) {
    const tx = rng() * (CHUNK_SIZE - 40);
    const ty = rng() * (CHUNK_SIZE - 40);
    if (!isNearLocWorld(ox + tx, oy + ty, 80)) drawTreeOnCanvas(c, tx, ty);
  }

  // Rocks (1-2 per chunk)
  const rockCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < rockCount; i++) {
    const rx = rng() * (CHUNK_SIZE - 20);
    const ry = rng() * (CHUNK_SIZE - 20);
    if (!isNearLocWorld(ox + rx, oy + ry, 60)) drawRockOnCanvas(c, rx, ry);
  }

  const tex = PIXI.Texture.from(tc);
  const sprite = new PIXI.Sprite(tex);
  sprite.position.set(ox, oy);
  return sprite;
}

function getOrCreateChunk(cx, cy) {
  const key = cx + ',' + cy;
  let entry = chunkCache.get(key);
  if (entry) {
    entry.lastUsed = _frame;
    return entry;
  }
  // Evict oldest if over limit
  if (chunkCache.size >= CHUNK_CACHE_MAX) {
    let oldestKey = null, oldestFrame = Infinity;
    for (const [k, e] of chunkCache) {
      if (e.lastUsed < oldestFrame) { oldestFrame = e.lastUsed; oldestKey = k; }
    }
    if (oldestKey) {
      const old = chunkCache.get(oldestKey);
      _terrainLayer.removeChild(old.sprite);
      old.sprite.destroy({ texture: true });
      chunkCache.delete(oldestKey);
    }
  }
  const sprite = renderChunk(cx, cy);
  _terrainLayer.addChild(sprite);
  entry = { sprite, lastUsed: _frame };
  chunkCache.set(key, entry);
  return entry;
}

export function updateVisibleChunks(cameraX, cameraY, zoom, CW, CH) {
  const viewW = CW / zoom, viewH = CH / zoom;
  const minCX = Math.floor((cameraX - CHUNK_SIZE) / CHUNK_SIZE);
  const minCY = Math.floor((cameraY - CHUNK_SIZE) / CHUNK_SIZE);
  const maxCX = Math.floor((cameraX + viewW + CHUNK_SIZE) / CHUNK_SIZE);
  const maxCY = Math.floor((cameraY + viewH + CHUNK_SIZE) / CHUNK_SIZE);

  const visibleKeys = new Set();
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) {
      const key = cx + ',' + cy;
      visibleKeys.add(key);
      const entry = getOrCreateChunk(cx, cy);
      entry.sprite.visible = true;
    }
  }

  for (const [key, entry] of chunkCache) {
    if (!visibleKeys.has(key)) entry.sprite.visible = false;
  }
}

export function invalidateChunksNearLocation(L) {
  const minCX = Math.floor((L.x - 80) / CHUNK_SIZE);
  const minCY = Math.floor((L.y - 80) / CHUNK_SIZE);
  const maxCX = Math.floor((L.x + L.w + 80) / CHUNK_SIZE);
  const maxCY = Math.floor((L.y + L.h + 80) / CHUNK_SIZE);
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) {
      const key = cx + ',' + cy;
      const entry = chunkCache.get(key);
      if (entry) {
        _terrainLayer.removeChild(entry.sprite);
        entry.sprite.destroy({ texture: true });
        chunkCache.delete(key);
      }
    }
  }
}

export function clearAllChunks() {
  for (const [, entry] of chunkCache) {
    _terrainLayer.removeChild(entry.sprite);
    entry.sprite.destroy({ texture: true });
  }
  chunkCache.clear();
}
