/**
 * Observer particles — particle pool, ambient effects.
 */

const PARTICLE_POOL_SIZE = 200;
const particles = [];
for (let i = 0; i < PARTICLE_POOL_SIZE; i++) {
  particles.push({ active: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, color: 0xffffff, size: 2, gravity: 0 });
}

let _particleGfx = null;
let _LOCS = null;
let _frame = 0;
let _phase = '';

export function initParticles(effectsLayer, LOCS) {
  _particleGfx = new PIXI.Graphics();
  effectsLayer.addChild(_particleGfx);
  _LOCS = LOCS;
}

export function setParticleState(frame, phase) {
  _frame = frame;
  _phase = phase;
}

export function emitParticles(worldX, worldY, count, config) {
  const { colors, speedMin = 0.3, speedMax = 1.5, sizeMin = 1, sizeMax = 3,
    lifeMin = 20, lifeMax = 40, gravity = 0.03, spread = Math.PI * 2,
    baseAngle = -Math.PI / 2 } = config;
  let spawned = 0;
  for (const p of particles) {
    if (spawned >= count) break;
    if (p.active) continue;
    const angle = Math.random() * spread - spread / 2 + baseAngle;
    const speed = speedMin + Math.random() * (speedMax - speedMin);
    p.x = worldX + (Math.random() - 0.5) * 8;
    p.y = worldY + (Math.random() - 0.5) * 8;
    p.vx = Math.cos(angle) * speed;
    p.vy = Math.sin(angle) * speed;
    p.gravity = gravity;
    p.life = lifeMin + Math.random() * (lifeMax - lifeMin);
    p.maxLife = p.life;
    p.color = colors[Math.floor(Math.random() * colors.length)];
    p.size = sizeMin + Math.random() * (sizeMax - sizeMin);
    p.active = true;
    spawned++;
  }
}

export function updateParticles() {
  _particleGfx.clear();
  for (const p of particles) {
    if (!p.active) continue;
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.gravity;
    p.life--;
    if (p.life <= 0) { p.active = false; continue; }
    const alpha = Math.min(1, p.life / p.maxLife * 2);
    const s = p.size * (0.5 + 0.5 * p.life / p.maxLife);
    _particleGfx.rect(p.x - s / 2, p.y - s / 2, s, s);
    _particleGfx.fill({ color: p.color, alpha });
  }
}

export function emitAmbientParticles() {
  // Coffee hub smoke
  const ch = _LOCS['coffee-hub'];
  if (ch && _frame % 15 === 0) {
    emitParticles(ch.x + ch.w + 10, ch.y - 10, 1, {
      colors: [0xcccccc, 0xaaaaaa, 0x999999],
      speedMin: 0.1, speedMax: 0.4, sizeMin: 2, sizeMax: 4,
      lifeMin: 30, lifeMax: 60, gravity: -0.02,
      spread: 0.5, baseAngle: -Math.PI / 2,
    });
  }

  // Central square fountain
  const cs = _LOCS['central-square'];
  if (cs && _frame % 8 === 0) {
    emitParticles(cs.x + cs.w / 2, cs.y + cs.h / 2 - 10, 1, {
      colors: [0x88ccff, 0xaaddff, 0x66bbee],
      speedMin: 0.2, speedMax: 0.8, sizeMin: 1, sizeMax: 3,
      lifeMin: 15, lifeMax: 30, gravity: 0.05,
      spread: Math.PI, baseAngle: -Math.PI / 2,
    });
  }

  // Workshop sawdust
  const ws = _LOCS['workshop'];
  if (ws && _frame % 20 === 0) {
    emitParticles(ws.x + ws.w + 30, ws.y + ws.h, 1, {
      colors: [0xddcc88, 0xccbb77, 0xbbaa66],
      speedMin: 0.1, speedMax: 0.3, sizeMin: 1, sizeMax: 2,
      lifeMin: 20, lifeMax: 40, gravity: 0.01,
      spread: Math.PI, baseAngle: -Math.PI / 4,
    });
  }

  const p = (_phase || '').toLowerCase();
  if (p.includes('night')) {
    // Fireflies at chill-zone
    const cz = _LOCS['chill-zone'];
    if (cz && _frame % 25 === 0) {
      emitParticles(
        cz.x + cz.w / 2 + (Math.random() - 0.5) * cz.w,
        cz.y + cz.h / 2 + (Math.random() - 0.5) * cz.h,
        1, {
          colors: [0xffff44, 0xeeff44, 0xddff22],
          speedMin: 0.05, speedMax: 0.2, sizeMin: 1, sizeMax: 2,
          lifeMin: 40, lifeMax: 80, gravity: -0.005,
          spread: Math.PI * 2, baseAngle: 0,
        }
      );
    }
    // Candle flicker at sunset-lounge
    const sl = _LOCS['sunset-lounge'];
    if (sl && _frame % 12 === 0) {
      emitParticles(sl.x + 6, sl.y + sl.h - 4, 1, {
        colors: [0xff8844, 0xffaa66, 0xffcc88],
        speedMin: 0.05, speedMax: 0.15, sizeMin: 1, sizeMax: 2,
        lifeMin: 10, lifeMax: 20, gravity: -0.02,
        spread: 0.3, baseAngle: -Math.PI / 2,
      });
      emitParticles(sl.x + sl.w - 6, sl.y + sl.h - 4, 1, {
        colors: [0xff8844, 0xffaa66, 0xffcc88],
        speedMin: 0.05, speedMax: 0.15, sizeMin: 1, sizeMax: 2,
        lifeMin: 10, lifeMax: 20, gravity: -0.02,
        spread: 0.3, baseAngle: -Math.PI / 2,
      });
    }
  } else if (p.includes('evening') || p.includes('sunset')) {
    const sl = _LOCS['sunset-lounge'];
    if (sl && _frame % 18 === 0) {
      emitParticles(sl.x + 6, sl.y + sl.h - 4, 1, {
        colors: [0xff8844, 0xffaa66],
        speedMin: 0.05, speedMax: 0.1, sizeMin: 1, sizeMax: 2,
        lifeMin: 10, lifeMax: 15, gravity: -0.02,
        spread: 0.3, baseAngle: -Math.PI / 2,
      });
    }
  }
}
