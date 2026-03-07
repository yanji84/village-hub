/**
 * Observer camera — pan, zoom, follow, touch/mouse/keyboard input.
 */

let cameraX = 0, cameraY = 0;
let cameraTargetX = 0, cameraTargetY = 0;
let zoom = 1.0, targetZoom = 1.0;
let dragging = false, dragStartX = 0, dragStartY = 0, dragCamStartX = 0, dragCamStartY = 0;
let autoFollow = false, lastSpeaker = null, followTarget = '';

// Touch state
let touchDragging = false, touchStartX = 0, touchStartY = 0, touchCamStartX = 0, touchCamStartY = 0;
let pinching = false, pinchStartDist = 0, pinchStartZoom = 1;

let _CW, _CH, _cv, _worldContainer, _LOCS, _sprites;

export function initCamera(cv, worldContainer, LOCS, sprites, CW, CH) {
  _cv = cv;
  _worldContainer = worldContainer;
  _LOCS = LOCS;
  _sprites = sprites;
  _CW = CW;
  _CH = CH;

  // Center on central-square initially
  centerCameraOn(
    LOCS['central-square'].x + LOCS['central-square'].w / 2,
    LOCS['central-square'].y + LOCS['central-square'].h / 2
  );

  // Mouse drag
  cv.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      dragCamStartX = cameraX;
      dragCamStartY = cameraY;
    }
  });

  cv.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = cv.getBoundingClientRect();
    const scaleX = _CW / rect.width / zoom;
    const scaleY = _CH / rect.height / zoom;
    const dx = (e.clientX - dragStartX) * scaleX;
    const dy = (e.clientY - dragStartY) * scaleY;
    cameraX = dragCamStartX - dx;
    cameraY = dragCamStartY - dy;
    cameraTargetX = cameraX;
    cameraTargetY = cameraY;
    if (Math.abs(e.clientX - dragStartX) > 4 || Math.abs(e.clientY - dragStartY) > 4) {
      autoFollow = false;
      setFollowTarget('');
    }
  });

  cv.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    const dx = Math.abs(e.clientX - dragStartX);
    const dy = Math.abs(e.clientY - dragStartY);
    if (dx < 4 && dy < 4) {
      const rect = cv.getBoundingClientRect();
      const sx = _CW / rect.width, sy = _CH / rect.height;
      const wx = (e.clientX - rect.left) * sx / zoom + cameraX;
      const wy = (e.clientY - rect.top) * sy / zoom + cameraY;
      for (const L of Object.values(_LOCS)) {
        if (wx >= L.x && wx <= L.x + L.w && wy >= L.y && wy <= L.y + L.h) {
          cameraTargetX = L.x + L.w / 2 - _CW / (2 * zoom);
          cameraTargetY = L.y + L.h / 2 - _CH / (2 * zoom);
          break;
        }
      }
    }
    dragging = false;
  });

  cv.addEventListener('mouseleave', () => { dragging = false; });

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -Math.sign(e.deltaY) * 0.15;
    targetZoom = Math.max(0.4, Math.min(3.0, targetZoom + delta));
  }, { passive: false });

  // Touch
  function touchDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  cv.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      pinching = true;
      touchDragging = false;
      pinchStartDist = touchDist(e.touches);
      pinchStartZoom = targetZoom;
    } else if (e.touches.length === 1) {
      touchDragging = true;
      pinching = false;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchCamStartX = cameraX;
      touchCamStartY = cameraY;
    }
  }, { passive: false });

  cv.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pinching && e.touches.length >= 2) {
      const dist = touchDist(e.touches);
      const scale = dist / pinchStartDist;
      targetZoom = Math.max(0.4, Math.min(3.0, pinchStartZoom * scale));
    } else if (touchDragging && e.touches.length === 1) {
      const rect = cv.getBoundingClientRect();
      const scaleX = _CW / rect.width / zoom;
      const scaleY = _CH / rect.height / zoom;
      const dx = (e.touches[0].clientX - touchStartX) * scaleX;
      const dy = (e.touches[0].clientY - touchStartY) * scaleY;
      cameraX = touchCamStartX - dx;
      cameraY = touchCamStartY - dy;
      cameraTargetX = cameraX;
      cameraTargetY = cameraY;
      autoFollow = false;
      setFollowTarget('');
    }
  }, { passive: false });

  cv.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinching = false;
    if (e.touches.length === 0) touchDragging = false;
  });

  // Keyboard shortcuts
  addEventListener('keydown', (e) => {
    const speed = 40 / zoom;
    switch (e.key) {
      case 'ArrowLeft': cameraTargetX -= speed; break;
      case 'ArrowRight': cameraTargetX += speed; break;
      case 'ArrowUp': cameraTargetY -= speed; break;
      case 'ArrowDown': cameraTargetY += speed; break;
      case '+': case '=': targetZoom = Math.min(3.0, targetZoom + 0.15); break;
      case '-': case '_': targetZoom = Math.max(0.4, targetZoom - 0.15); break;
      default: return;
    }
    e.preventDefault();
    autoFollow = false;
    setFollowTarget('');
  });

  // Follow selector
  document.getElementById('follow-sel').addEventListener('change', (e) => {
    const v = e.target.value;
    followTarget = v;
    e.target.className = v ? 'active' : '';
    if (v && _sprites[v]) {
      autoFollow = false;
      cameraTargetX = _sprites[v].x - _CW / (2 * zoom);
      cameraTargetY = _sprites[v].y - _CH / (2 * zoom);
    }
  });
}

function centerCameraOn(wx, wy) {
  cameraTargetX = wx - _CW / (2 * zoom);
  cameraTargetY = wy - _CH / (2 * zoom);
  cameraX = cameraTargetX;
  cameraY = cameraTargetY;
}

export function setFollowTarget(name) {
  followTarget = name;
  const sel = document.getElementById('follow-sel');
  sel.value = name;
  sel.className = name ? 'active' : '';
}

export function updateFollowSelect() {
  const sel = document.getElementById('follow-sel');
  const prev = sel.value;
  const names = Object.keys(_sprites).sort();
  sel.innerHTML = '<option value="">Follow...</option>' +
    names.map(n => `<option value="${n}">${_sprites[n].dn}</option>`).join('');
  if (prev && _sprites[prev]) sel.value = prev;
  else if (followTarget && !_sprites[followTarget]) setFollowTarget('');
}

export function setLastSpeaker(name) { lastSpeaker = name; }

export function updateCamera() {
  zoom += (targetZoom - zoom) * 0.12;
  const ft = followTarget || (autoFollow ? lastSpeaker : null);
  if (ft && _sprites[ft]) {
    const s = _sprites[ft];
    cameraTargetX = s.x - _CW / (2 * zoom);
    cameraTargetY = s.y - _CH / (2 * zoom);
  }
  cameraX += (cameraTargetX - cameraX) * 0.08;
  cameraY += (cameraTargetY - cameraY) * 0.08;
  _worldContainer.scale.set(zoom);
  _worldContainer.position.set(-cameraX * zoom, -cameraY * zoom);
}

export function getCameraState() {
  return { cameraX, cameraY, zoom, CW: _CW, CH: _CH };
}

export function getCameraRect() {
  const viewW = _CW / zoom, viewH = _CH / zoom;
  return { minX: cameraX, minY: cameraY, maxX: cameraX + viewW, maxY: cameraY + viewH };
}
