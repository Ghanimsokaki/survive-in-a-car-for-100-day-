/**
 * HOME PREVIEW — a dependency-free avatar portrait.
 *
 * The sign-in and lobby screens used to render their avatars with three.js,
 * which meant every visitor downloaded and parsed the whole 3D engine
 * (~690 KB) before they could even see the username box. The home screens are
 * a menu, not a game, so the portrait is drawn with the plain 2D canvas API:
 * zero imports, zero WebGL context, a few hundred bytes of work per frame.
 *
 * The 3D avatar (`avatar.js`) is only loaded when a run starts, where it is
 * worth the bytes.
 *
 * Public API matches the old three.js stage so call sites barely change:
 *   const p = new AvatarPreview(canvas);
 *   p.setAvatar(hex, name, custom);  p.resize();  p.render(dt);  p.destroy();
 */

const DEFAULT_LOOK = { skin: 'tan', outfit: 'rust', hair: 'short', height: 1, hat: 'none' };

// the same palette ids the 3D rig understands, resolved to flat colours
const SKIN = {
  pale: '#f2cdb4', fair: '#eac0a4', tan: '#d39b74', bronze: '#a96f4d',
  brown: '#82503a', deep: '#5d3726', ash: '#9aa1a8', green: '#8ea86b',
};
const OUTFIT = {
  rust: '#b6543a', amber: '#d89b3c', cyan: '#3fb6c4', moss: '#6f8f4a',
  violet: '#7b5bb0', slate: '#4a5b70', bone: '#c9c2ad', blood: '#8e2f36',
  chrome: '#a9b7c6', black: '#2a2f38',
};
const HAIR_COLOUR = {
  short: '#241a14', mohawk: '#b64a2f', long: '#3a2a1c', bun: '#5a4630', cap: '#2f3f4f', none: '#241a14',
};

const hexToRgb = (hex) => {
  const h = String(hex || '').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(n || '000000', 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
};
const shade = (hex, amount) => {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.max(0, Math.min(255, Math.round(c + amount * 255)));
  return `rgb(${f(r)},${f(g)},${f(b)})`;
};

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export class AvatarPreview {
  constructor(canvas) {
    this.canvas = canvas || null;
    this.ctx = this.canvas?.getContext ? this.canvas.getContext('2d') : null;
    this.avatar = { colour: '#3fb6c4', name: 'SURVIVOR', custom: { ...DEFAULT_LOOK } };
    this.t = 0;
    this.yaw = 0;
    this.targetYaw = 0;
    this.dragging = false;
    this.lastX = 0;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.bind();
  }

  bind() {
    const c = this.canvas;
    if (!c?.addEventListener) return;
    try { c.style.touchAction = 'pan-y'; } catch { /* stub canvas */ }
    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.targetYaw += (e.clientX - this.lastX) * 0.02;
      this.lastX = e.clientX;
    });
    const stop = (e) => { this.dragging = false; c.releasePointerCapture?.(e.pointerId); };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointercancel', stop);
  }

  setAvatar(hex, name, custom) {
    this.avatar.colour = typeof hex === 'number'
      ? `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`
      : String(hex || '#3fb6c4');
    if (name) this.avatar.name = String(name);
    this.avatar.custom = { ...DEFAULT_LOOK, ...(custom || {}) };
    return this;
  }

  resize() {
    const c = this.canvas;
    if (!c) return;
    const w = Math.max(1, Math.round(c.clientWidth || 320));
    const h = Math.max(1, Math.round(c.clientHeight || 200));
    const dpr = Math.min(Math.max(1, globalThis.devicePixelRatio || 1), 2.5);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    try {
      // draw at device resolution so the portrait is sharp on a phone
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      if (this.ctx?.setTransform) this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch { /* stub canvas */ }
    this.render(0);
  }

  render(dt = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    this.t += dt;
    if (!this.dragging) this.targetYaw += dt * 0.5;
    this.yaw += (this.targetYaw - this.yaw) * 0.12;

    const { custom } = this.avatar;
    const w = this.w || this.canvas?.clientWidth || 320;
    const h = this.h || this.canvas?.clientHeight || 200;
    ctx.clearRect(0, 0, w, h);

    // ---- backdrop: a soft stage glow with a warm rim, same mood as the 3D one
    const cx = w / 2;
    const floor = h * 0.9;
    const scale = Math.min(w / 190, h / 250) * (custom.height || 1);
    const skin = SKIN[custom.skin] || SKIN.tan;
    const outfit = OUTFIT[custom.outfit] || this.avatar.colour || OUTFIT.cyan;

    const glow = ctx.createRadialGradient
      ? ctx.createRadialGradient(cx, floor - 30, 6, cx, floor - 30, w * 0.55)
      : null;
    if (glow) {
      glow.addColorStop(0, 'rgba(255,179,71,.16)');
      glow.addColorStop(1, 'rgba(255,179,71,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.save();
    ctx.translate(cx, floor);
    ctx.scale(scale, scale);

    // ground shadow
    ctx.beginPath();
    ctx.ellipse(0, 2, 46, 9, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.45)';
    ctx.fill();

    const bob = Math.sin(this.t * 1.6) * 1.6;
    const sway = Math.sin(this.t * 0.9) * 2.2;
    const turn = Math.sin(this.yaw) * 0.22;   // a slow idle turn, no 3D needed
    ctx.translate(sway * 0.4, bob - 4);

    const unit = 10;              // one Roblox-ish block
    const bodyW = 4.4 * unit;
    const bodyH = 5.2 * unit;

    // legs
    ctx.fillStyle = shade(outfit, -0.16);
    const legY = -bodyH * 0.5;
    ctx.fillRect(-bodyW * 0.36, legY, bodyW * 0.32, bodyH * 0.55);
    ctx.fillRect(bodyW * 0.04, legY, bodyW * 0.32, bodyH * 0.55);
    // boots
    ctx.fillStyle = shade(outfit, -0.3);
    ctx.fillRect(-bodyW * 0.38, legY + bodyH * 0.55 - 6, bodyW * 0.36, 8);
    ctx.fillRect(bodyW * 0.02, legY + bodyH * 0.55 - 6, bodyW * 0.36, 8);

    // torso
    const torsoY = -bodyH * 0.5 - bodyH * 0.62;
    const torsoGrad = ctx.createLinearGradient
      ? ctx.createLinearGradient(-bodyW / 2, torsoY, bodyW / 2, torsoY + bodyH * 0.6)
      : null;
    if (torsoGrad) {
      torsoGrad.addColorStop(0, shade(outfit, 0.08));
      torsoGrad.addColorStop(1, shade(outfit, -0.12));
      ctx.fillStyle = torsoGrad;
    } else {
      ctx.fillStyle = outfit;
    }
    roundRect(ctx, -bodyW / 2, torsoY, bodyW, bodyH * 0.62, 6);
    ctx.fill();
    // chest strap
    ctx.strokeStyle = 'rgba(0,0,0,.28)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-bodyW * 0.34, torsoY + 4);
    ctx.lineTo(bodyW * 0.3, torsoY + bodyH * 0.55);
    ctx.stroke();

    // arms (subtle idle swing)
    const swing = Math.sin(this.t * 1.6) * 4;
    ctx.fillStyle = skin;
    roundRect(ctx, -bodyW * 0.5 - unit * 0.9, torsoY + 2 + swing * 0.3, unit * 0.9, bodyH * 0.5, 4);
    ctx.fill();
    roundRect(ctx, bodyW * 0.5, torsoY + 2 - swing * 0.3, unit * 0.9, bodyH * 0.5, 4);
    ctx.fill();

    // head
    const headSize = 4.6 * unit;
    const headY = torsoY - headSize - 4;
    const fx = turn * 6;
    ctx.fillStyle = skin;
    roundRect(ctx, -headSize / 2 + fx, headY, headSize, headSize, 7);
    ctx.fill();
    // shading down one side of the face
    ctx.fillStyle = 'rgba(0,0,0,.12)';
    roundRect(ctx, -headSize / 2 + fx, headY, headSize * 0.3, headSize, 7);
    ctx.fill();

    // face
    ctx.fillStyle = '#161013';
    ctx.fillRect(-headSize * 0.24 + fx, headY + headSize * 0.42, 4, 5);
    ctx.fillRect(headSize * 0.1 + fx, headY + headSize * 0.42, 4, 5);
    ctx.strokeStyle = '#161013';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(fx - 1, headY + headSize * 0.58, 6, 0.2, Math.PI - 0.2);
    ctx.stroke();

    // hair / hat
    const hair = custom.hair || 'short';
    if (hair === 'mohawk') {
      ctx.fillStyle = HAIR_COLOUR.mohawk;
      for (let i = 0; i < 5; i++) ctx.fillRect(-3 + fx, headY - 12 - i * 2, 6, 14);
    } else if (hair === 'long') {
      ctx.fillStyle = HAIR_COLOUR.long;
      roundRect(ctx, -headSize / 2 - 3 + fx, headY - 5, headSize + 6, headSize * 0.55, 8);
      ctx.fill();
      roundRect(ctx, -headSize / 2 - 3 + fx, headY + 6, 8, headSize * 0.7, 6);
      ctx.fill();
      roundRect(ctx, headSize / 2 - 5 + fx, headY + 6, 8, headSize * 0.7, 6);
      ctx.fill();
    } else if (hair === 'bun') {
      ctx.fillStyle = HAIR_COLOUR.bun;
      roundRect(ctx, -headSize / 2 + fx, headY - 4, headSize, headSize * 0.3, 8);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(fx, headY - 8, 8, 0, Math.PI * 2);
      ctx.fill();
    } else if (hair === 'cap') {
      ctx.fillStyle = HAIR_COLOUR.cap;
      roundRect(ctx, -headSize / 2 - 2 + fx, headY - 6, headSize + 4, headSize * 0.36, 7);
      ctx.fill();
      ctx.fillRect(-headSize / 2 - 2 + fx, headY + headSize * 0.24, headSize * 1.25, 5);
    } else if (hair !== 'none') {
      ctx.fillStyle = HAIR_COLOUR.short;
      roundRect(ctx, -headSize / 2 + 1 + fx, headY - 3, headSize - 2, headSize * 0.26, 6);
      ctx.fill();
    }
    ctx.restore();

    // name plate
    if (this.avatar.name) {
      ctx.font = '700 9px ui-monospace,Menlo,monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(232,238,248,.92)';
      ctx.fillText(String(this.avatar.name).slice(0, 14).toUpperCase(), cx, h - 8);
    }
  }

  destroy() {
    this.canvas = null;
    this.ctx = null;
  }
}

/** Convenience for call sites that just want "a preview, or nothing". */
export function mountPreview(canvas) {
  try {
    return canvas ? new AvatarPreview(canvas) : null;
  } catch {
    return null;
  }
}
