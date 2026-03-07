/**
 * Observer characters — sprite sheet loading, procedural character drawing, pose animations.
 */

import { hexToRgb } from './observer-utils.js';

const SPRITE_SIZE = 32;
const ANIM_POSES = ['idle', 'walk', 'talk', 'think', 'sit', 'wave'];
const BCOLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#1abc9c','#e67e22','#e91e63','#00bcd4','#8bc34a','#ff5722','#607d8b'];
const charTextureCache = {};
let charSheet = null;

export { SPRITE_SIZE, BCOLORS };

export async function loadCharacterSheet() {
  try {
    charSheet = await PIXI.Assets.load('./assets/characters.png');
    console.log('[observer] Character sprite sheet loaded');
  } catch {
    console.log('[observer] No characters.png found — using fallback drawing');
  }
}

/**
 * Extract animation textures for a variant row from the sprite sheet.
 */
function getVariantAnims(variant) {
  const key = `__variant_${variant}`;
  if (charTextureCache[key]) return charTextureCache[key];
  const anims = {};
  for (let p = 0; p < ANIM_POSES.length; p++) {
    const pose = ANIM_POSES[p];
    anims[pose] = [];
    for (let f = 0; f < 2; f++) {
      const col = p * 2 + f;
      const c = document.createElement('canvas');
      c.width = SPRITE_SIZE; c.height = SPRITE_SIZE;
      c.getContext('2d').drawImage(
        charSheet.source.resource,
        col * 32, variant * 32, 32, 32, 0, 0, 32, 32
      );
      anims[pose].push(PIXI.Texture.from(c));
    }
  }
  charTextureCache[key] = anims;
  return anims;
}

/**
 * Get or create cached animation textures for an appearance.
 */
export function getCharAnims(appearance) {
  if (charSheet && appearance && appearance.variant !== undefined) {
    return getVariantAnims(appearance.variant);
  }

  const color = (appearance && BCOLORS[appearance.variant % BCOLORS.length]) || BCOLORS[0];
  if (charTextureCache[color]) return charTextureCache[color];
  const anims = {};
  for (const pose of ANIM_POSES) {
    anims[pose] = [];
    for (let f = 0; f < 2; f++) {
      const c = document.createElement('canvas');
      c.width = SPRITE_SIZE; c.height = SPRITE_SIZE;
      const ctx = c.getContext('2d');
      drawSocialChar(ctx, color, f, pose);
      anims[pose].push(PIXI.Texture.from(c));
    }
  }
  charTextureCache[color] = anims;
  return anims;
}

// --- Procedural character drawing ---

function drawSocialChar(ctx, hexColor, frame, pose) {
  const { r, g, b } = hexToRgb(hexColor);
  const hair = `rgb(${Math.max(0, r - 80)},${Math.max(0, g - 80)},${Math.max(0, b - 80)})`;
  const bodyLight = `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)})`;
  const armShade = `rgb(${Math.max(0, r - 25)},${Math.max(0, g - 25)},${Math.max(0, b - 25)})`;
  const skin = '#f0c8a0';
  const skinShade = '#d8b090';
  const eye = '#1a1a2e';
  const pants = '#3a3a5c';
  const boot = '#4a3728';

  ctx.clearRect(0, 0, 32, 32);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(16, 30, 7, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();

  switch (pose) {
    case 'idle': default: {
      const y = frame === 1 ? -1 : 0;
      drawHead32(ctx, 10, 2 + y, hair, skin, skinShade, eye, false);
      drawBody32(ctx, 9, 14 + y, hexColor, bodyLight);
      drawArm32(ctx, 6, 15 + y, armShade, skin);
      drawArm32(ctx, 22, 15 + y, armShade, skin);
      drawLegs32(ctx, 10, 22 + y, 17, 22 + y, pants, boot);
      break;
    }
    case 'walk': {
      const y = frame === 1 ? -1 : 0;
      const f = frame === 0 ? 2 : -2;
      drawHead32(ctx, 10, 2 + y, hair, skin, skinShade, eye, false);
      drawBody32(ctx, 9, 14 + y, hexColor, bodyLight);
      drawArm32(ctx, 6, 15 + y - f, armShade, skin);
      drawArm32(ctx, 22, 15 + y + f, armShade, skin);
      drawLegs32(ctx, 10 - f, 22 + y, 17 + f, 22 + y, pants, boot);
      break;
    }
    case 'talk': {
      const y = frame === 1 ? -1 : 0;
      drawHead32(ctx, 10, 2 + y, hair, skin, skinShade, eye, true);
      drawBody32(ctx, 9, 14 + y, hexColor, bodyLight);
      drawArm32(ctx, 6, 15 + y, armShade, skin);
      ctx.fillStyle = armShade;
      ctx.fillRect(22, 12 + y, 3, 4);
      ctx.fillRect(24, 9 + y + (frame === 1 ? -1 : 0), 3, 4);
      ctx.fillStyle = skin;
      ctx.fillRect(25, 8 + y + (frame === 1 ? -1 : 0), 2, 2);
      drawLegs32(ctx, 10, 22 + y, 17, 22 + y, pants, boot);
      break;
    }
    case 'think': {
      const y = frame === 1 ? -1 : 0;
      drawHead32(ctx, 10, 2 + y, hair, skin, skinShade, eye, false);
      drawBody32(ctx, 9, 14 + y, hexColor, bodyLight);
      drawArm32(ctx, 6, 15 + y, armShade, skin);
      ctx.fillStyle = armShade;
      ctx.fillRect(22, 14 + y, 3, 3);
      ctx.fillRect(21, 11 + y, 3, 4);
      ctx.fillStyle = skin;
      ctx.fillRect(20, 9 + y, 2, 3);
      if (frame === 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillRect(26, 4, 2, 2);
        ctx.fillRect(28, 1, 3, 3);
      }
      drawLegs32(ctx, 10, 22 + y, 17, 22 + y, pants, boot);
      break;
    }
    case 'sit': {
      drawHead32(ctx, 10, 6, hair, skin, skinShade, eye, false);
      drawBody32(ctx, 9, 18, hexColor, bodyLight);
      drawArm32(ctx, 6, 19, armShade, skin);
      drawArm32(ctx, 22, 19, armShade, skin);
      ctx.fillStyle = pants;
      ctx.fillRect(8, 26, 5, 3);
      ctx.fillRect(16, 26, 5, 3);
      ctx.fillRect(6, 27, 3, 3);
      ctx.fillRect(20, 27, 3, 3);
      ctx.fillStyle = boot;
      ctx.fillRect(4, 28, 3, 2);
      ctx.fillRect(22, 28, 3, 2);
      break;
    }
    case 'wave': {
      const y = frame === 1 ? -1 : 0;
      drawHead32(ctx, 10, 2 + y, hair, skin, skinShade, eye, true);
      drawBody32(ctx, 9, 14 + y, hexColor, bodyLight);
      drawArm32(ctx, 6, 15 + y, armShade, skin);
      ctx.fillStyle = armShade;
      ctx.fillRect(22, 12 + y, 3, 3);
      ctx.fillRect(24, 7 + y, 3, 6);
      ctx.fillStyle = skin;
      ctx.fillRect(25, 4 + y + (frame === 1 ? -2 : 0), 3, 3);
      drawLegs32(ctx, 10, 22 + y, 17, 22 + y, pants, boot);
      break;
    }
  }
}

function drawHead32(ctx, x, y, hair, skin, skinShade, eye, mouthOpen) {
  ctx.fillStyle = hair;
  ctx.fillRect(x - 1, y, 14, 4);
  ctx.fillRect(x - 2, y + 2, 2, 6);
  ctx.fillStyle = skin;
  ctx.fillRect(x, y + 3, 12, 9);
  ctx.fillStyle = skinShade;
  ctx.fillRect(x, y + 10, 12, 2);
  ctx.fillStyle = eye;
  ctx.fillRect(x + 2, y + 5, 2, 2);
  ctx.fillRect(x + 8, y + 5, 2, 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(x + 2, y + 5, 1, 1);
  ctx.fillRect(x + 8, y + 5, 1, 1);
  if (mouthOpen) {
    ctx.fillStyle = '#c06060';
    ctx.fillRect(x + 4, y + 8, 4, 2);
  } else {
    ctx.fillStyle = '#c08080';
    ctx.fillRect(x + 5, y + 9, 2, 1);
  }
  ctx.fillStyle = skin;
  ctx.fillRect(x + 4, y + 12, 4, 2);
}

function drawBody32(ctx, x, y, color, bodyLight) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 14, 8);
  ctx.fillStyle = bodyLight;
  ctx.fillRect(x + 1, y, 6, 4);
}

function drawArm32(ctx, x, y, armShade, skin) {
  ctx.fillStyle = armShade;
  ctx.fillRect(x, y, 3, 7);
  ctx.fillStyle = skin;
  ctx.fillRect(x, y + 7, 3, 2);
}

function drawLegs32(ctx, lx, ly, rx, ry, pants, boot) {
  ctx.fillStyle = pants;
  ctx.fillRect(lx, ly, 4, 5);
  ctx.fillRect(rx, ry, 4, 5);
  ctx.fillStyle = boot;
  ctx.fillRect(lx - 1, ly + 5, 5, 3);
  ctx.fillRect(rx - 1, ry + 5, 5, 3);
}
