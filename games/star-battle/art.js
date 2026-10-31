/**
 * STAR BATTLE — the ship renderer.
 *
 * `scripts/bake-ship.mjs` turns `model.fbx` + the textures in
 * `starship+3d+model.zip` into turntables: 32 headings × 3 liveries × 2 sizes,
 * lit and shaded at build time. This file is what the game uses at runtime: it
 * picks a heading from `facing`, draws the sprite, and adds the live parts the
 * bake cannot know about — engine glow, shield bubble, damage flash.
 *
 * Why sprites instead of a WebGL mesh:
 *   · the game runs in the hub's `<iframe sandbox="allow-scripts">`, so no
 *     WebGL context is guaranteed and no 6.7 MB FBX should ever be downloaded
 *     on a phone;
 *   · 32 pre-lit heading cells cost one `drawImage` per ship — the frame budget
 *     stays flat no matter how many ships the wave brings;
 *   · it degrades in the open: if the atlas cannot load, `game.js` keeps its
 *     vector art, so the game is never blank.
 *
 * Plain script on `window.StarArt`, like `ships.js`. Node-safe: with no real
 * `Image`, everything reports "not ready" and the caller falls back.
 */
(function (root) {
  'use strict';

  const DIR = 'art/';
  const MANIFEST = 'ships.json';
  const ANGLES = 32;

  /** Baked turntables, when they are on disk. Overwritten by the manifest. */
  const DEFAULT_SHEETS = {
    player: { files: { low: 'ships-player-low.png', high: 'ships-player-high.png' }, glow: '#5fd0ff', size: 1 },
    narada: { files: { low: 'ships-narada-low.png', high: 'ships-narada-high.png' }, glow: '#ff7a3c', size: 1.55 },
    vengeance: { files: { low: 'ships-vengeance-low.png', high: 'ships-vengeance-high.png' }, glow: '#ffb14a', size: 1.2 },
  };

  const state = {
    manifest: { angles: ANGLES, cols: 8, rows: 4, sizes: { low: 96, high: 160 }, liveries: DEFAULT_SHEETS },
    sheets: {},          // id → { tier, img, cell, cols, angles }
    pending: {},         // url → Image
    started: {},         // id → true once a load was kicked off
    failed: {},
  };

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function cellFor(id) {
    const sheet = state.sheets[id];
    return sheet ? sheet.cell : 0;
  }

  /** Is there a decoded sheet for this ship? */
  function ready(id) {
    const sheet = state.sheets[id];
    return Boolean(sheet && sheet.img && sheet.img.width);
  }

  /** True when the *high* atlas is in memory (used by tests and the HUD). */
  function isHigh(id) {
    return ready(id) && state.sheets[id].tier === 'high';
  }

  function decode(url, done) {
    if (state.pending[url]) return;
    let img = null;
    try {
      if (typeof root.Image !== 'function') return;      // headless: no atlas
      img = new root.Image();
    } catch {
      return;
    }
    const finish = (ok) => {
      delete state.pending[url];
      done(ok ? img : null);
    };
    state.pending[url] = img;
    try {
      img.decoding = 'async';
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = DIR + url;
    } catch {
      finish(false);
    }
  }

  /**
   * Loads one ship's turntable. `tier` is a wish: the high atlas is only used
   * when the screen can actually show it, and the low atlas is always loaded
   * first so a ship is never invisible while a big PNG is in flight.
   */
  function load(id, { tier = 'auto', highNeeded = 160 } = {}) {
    const livery = state.manifest.liveries[id] || DEFAULT_SHEETS[id];
    if (!livery) return false;
    const files = livery.files || {};
    const wantHigh = tier === 'high' || (tier === 'auto' && highNeeded > state.manifest.sizes.low * 1.2);
    const order = wantHigh ? ['low', 'high'] : ['low'];
    let kicked = false;
    for (const key of order) {
      const file = files[key];
      if (!file || state.sheets[id]?.tier === 'high') continue;
      if (state.failed[file]) continue;
      kicked = true;
      decode(file, (img) => {
        if (!img) { state.failed[file] = true; return; }
        const sizes = state.manifest.sizes || {};
        const cell = sizes[key] || (key === 'high' ? 160 : 96);
        // never downgrade a high sheet that already landed
        if (state.sheets[id] && state.sheets[id].tier === 'high' && key === 'low') return;
        state.sheets[id] = {
          tier: key, img, cell,
          cols: state.manifest.cols || 8,
          angles: state.manifest.angles || ANGLES,
        };
      });
    }
    return kicked;
  }

  /** Reads `art/ships.json` (optional: the defaults above are enough to run). */
  function readManifest(done) {
    let xhr = null;
    try {
      xhr = new root.XMLHttpRequest();
    } catch {
      if (done) done(state.manifest);
      return;
    }
    try {
      xhr.open('GET', DIR + MANIFEST, true);
      xhr.onload = () => {
        try {
          if (xhr.status >= 200 && xhr.status < 300) {
            const parsed = JSON.parse(xhr.responseText);
            if (parsed && parsed.liveries) state.manifest = parsed;
          }
        } catch { /* keep the defaults */ }
        if (done) done(state.manifest);
      };
      xhr.onerror = () => { if (done) done(state.manifest); };
      xhr.send();
    } catch {
      if (done) done(state.manifest);
    }
  }

  /** Heading index for a facing angle, snapped to the baked turntable. */
  function headingIndex(facing, angles = ANGLES) {
    const step = (Math.PI * 2) / angles;
    const n = Math.round((facing || 0) / step) % angles;
    return (n + angles) % angles;
  }

  /**
   * Draws a ship at (x, y), nose along `facing`, `diameter` pixels across, with
   * the engine glow painted *behind* it in additive light.
   *
   * Returns false when the atlas for this ship is not in memory yet — the
   * caller then draws its vector fallback, so a slow network never means an
   * empty screen.
   */
  function drawShip(ctx, id, x, y, facing, diameter, opts = {}) {
    if (!ready(id)) return false;
    const sheet = state.sheets[id];
    const cell = sheet.cell;
    const step = (Math.PI * 2) / sheet.angles;
    const index = headingIndex(facing, sheet.angles);
    const sx = (index % sheet.cols) * cell;
    const sy = Math.floor(index / sheet.cols) * cell;

    const glow = opts.glow === undefined ? 0.5 : Math.max(0, Math.min(1, opts.glow));
    const scale = Math.max(0.05, (diameter / cell) * (opts.scale || 1));

    ctx.save();
    ctx.translate(x, y);

    // engine light: a tight additive bloom at the stern. It used to be nearly
    // as wide as the ship, which read as a coloured disc, not as thrust.
    if (glow > 0.02) {
      const tail = -diameter * 0.22;
      const radius = diameter * (0.16 + glow * 0.16);
      const grad = ctx.createRadialGradient(tail, 0, diameter * 0.02, tail, 0, radius);
      grad.addColorStop(0, opts.glowColour || 'rgba(120,220,255,0.5)');
      grad.addColorStop(0.4, 'rgba(90,180,255,0.10)');
      grad.addColorStop(1, 'rgba(60,140,255,0)');
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = glow;
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(tail, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prev;
    }

    ctx.rotate(facing);
    ctx.scale(scale, scale);
    try {
      ctx.drawImage(sheet.img, sx, sy, cell, cell, -cell / 2, -cell / 2, cell, cell);
    } catch {
      ctx.restore();
      return false;
    }
    ctx.restore();
    return true;
  }

  /** A ship rendered at a fixed heading — the hangar/title card uses this. */
  function drawHangar(ctx, id, x, y, facing, diameter, opts) {
    return drawShip(ctx, id, x, y, facing, diameter, opts);
  }

  /** Kicks off: manifest first, then the player's ship at the best size. */
  function boot({ highNeeded = 160, ids = ['player'] } = {}) {
    readManifest(() => {
      const list = ids.length ? ids : ['player'];
      for (const id of list) load(id, { highNeeded });
    });
  }

  const api = {
    state, ready, isHigh, load, boot, drawShip, drawHangar, headingIndex,
    get manifest() { return state.manifest; },
    get cell() { return cellFor; },
    /** Test/debug: pretend an atlas landed, without a real Image. */
    _install(id, img, { tier = 'high', cell = 160 } = {}) {
      state.sheets[id] = {
        tier, img, cell,
        cols: state.manifest.cols || 8,
        angles: state.manifest.angles || ANGLES,
      };
    },
  };

  root.StarArt = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
