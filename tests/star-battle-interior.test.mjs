/**
 * STAR BATTLE — the ship interior, in 3D.
 *
 * The captain asked to see the crews, the warp core and the decks. The panel
 * used to draw a 2D cutaway; `interior3d.js` builds the same compartment out of
 * `gl.js` primitives instead. This suite is about what goes wrong in a real
 * renderer, since there is no browser here:
 *
 *   1. no WebGL — `create` returns null and never throws, so the schematic keeps
 *      the panel;
 *   2. every part is one *sized* draw. `gl.js` bodies take a single size, and
 *      the first draft of this file assumed a `rescale()` that does not exist,
 *      which quietly turned every slab into a cube — the room rendered as a box
 *      around the camera;
 *   3. the room tells the truth: a crewed station has a figure, a vacant one has
 *      none, and the core is brighter at a higher level;
 *   4. the camera stands *inside* the hull, looking down the compartment. Parked
 *      outside it, the near bulkhead is the whole picture;
 *   5. `gl.solid` scales the model per axis and divides the normal basis by the
 *      same numbers, so a slab is lit like a slab.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './doms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

/* ---------------------------------------------- a renderer that just records */
function recorder() {
  const log = { solids: [], sprites: [], cameras: [], begins: 0, flushes: 0 };
  const api = {
    ok: true,
    mode: 'webgl',
    tris: 0,
    begin(w, h, dpr) { log.begins += 1; log.size = [w, h, dpr]; },
    camera(...args) { log.cameras.push(args); },
    sky() {}, grid() {}, body() {}, ship() {},
    solid(shape, x, y, z, sx, sy, sz, rotY, rgb, glow, emissive) {
      log.solids.push({ shape, x, y, z, sx, sy, sz, rotY, rgb, glow, emissive });
    },
    sprite(x, y, z, size, r, g, b) { log.sprites.push({ x, y, z, size, r, g, b }); },
    sprites() { log.flushes += 1; },
    beam() {},
    project: () => ({ x: 0, y: 0, onScreen: true }),
  };
  return { api, log };
}

function loadInterior({ withGL = true } = {}) {
  const { api, log } = recorder();
  const sandbox = { console: { warn() {}, log() {} } };
  sandbox.window = {
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    ...(withGL ? { StarGL: { create: () => api } } : {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(read('games/star-battle/interior3d.js'), sandbox);
  return { SI: sandbox.window.StarInterior, log, api };
}

const HULL = { helm: 'Uhura', tactical: 'Chekov', engineering: 'Scotty', medical: 'Crusher', science: 'Data' };

/* ------------------------------------------------ 1. it can always say no */
console.log('\nthe room refuses instead of throwing');
{
  const bare = loadInterior({ withGL: false });
  check('no `StarGL` gives null, not a crash', bare.SI.create({ getContext: () => null }) === null);
  check('no canvas at all gives null', bare.SI.create(null) === null);
  check('a renderer that throws gives null too', (() => {
    const sandbox = {
      console: { warn() {} },
      window: { StarGL: { create() { throw new Error('no context'); } } },
    };
    vm.createContext(sandbox);
    vm.runInContext(read('games/star-battle/interior3d.js'), sandbox);
    try { return sandbox.window.StarInterior.create({}) === null; } catch { return false; }
  })());
  const { SI } = loadInterior();
  check('the five stations and their colours are exported', (() => {
    const roles = Object.keys(SI.STATIONS);
    return roles.length === 5 && roles.every((r) => Array.isArray(SI.ROLE_COLOUR[r]));
  })(), Object.keys(SI.STATIONS).join(' '));
}

/* ------------------------------------------------ 2. every part is one sized draw */
console.log('\nevery part of the room is one draw with its own size');
{
  const { SI, log } = loadInterior();
  const room = SI.create({});
  const out = room.frame(640, 360, 2, { crew: [], stats: {}, hull: 1, time: 0, core: 1 });

  check('a frame returns the renderer, so the caller can chain', out === room);
  check('the frame sizes the glass in device pixels',
    log.begins === 1 && log.size[0] === 640 && log.size[2] === 2, JSON.stringify(log.size));
  check('the camera stands inside the compartment, looking at the core', (() => {
    const [ex, ey, ez, ax, ay, az, fov] = log.cameras[0];
    const reach = Math.hypot(ex - ax, ey - ay, ez - az);
    const inside = Math.abs(ex) < 13 && Math.abs(ez) < 7.2;
    return inside && ey > 4 && ay > 2 && ax > 4 && az === 0 && fov > 55 && reach > 8 && reach < 22;
  })(), log.cameras[0].map((n) => Number(n).toFixed(1)).join(' '));
  check('the room is built from dozens of solids', log.solids.length > 60, `${log.solids.length} solids`);
  check('…and the sprite queue is flushed once, not once per sprite',
    log.flushes === 1, `${log.flushes} flushes`);

  // the bug this suite exists for: a shim that could not scale left every box a cube
  const slabs = log.solids.filter((s) => s.shape === 'box' && (s.sx !== s.sy || s.sy !== s.sz));
  check('the boxes are slabs, not default cubes', slabs.length > 60, `${slabs.length} sized boxes`);
  check('no part is drawn with a size it never got', log.solids.every((s) =>
    [s.sx, s.sy, s.sz].every((n) => typeof n === 'number' && Number.isFinite(n) && n !== 0)));
  const longest = Math.max(...log.solids.map((s) => Math.max(s.sx, s.sy, s.sz)));
  check('the compartment is long, not a box around the camera', longest > 20, `${longest.toFixed(1)} units`);
}

/* ------------------------------------------------ 3. the room tells the truth */
console.log('\nwhat the room shows is what the hangar says');
{
  const { SI, log } = loadInterior();
  const room = SI.create({});

  const empty = (() => {
    log.solids.length = 0; room.frame(640, 360, 1, { crew: [], time: 1, core: 1 });
    return log.solids.length;
  })();
  const crew = Object.entries(HULL).map(([role, name]) => ({ role, name }));
  const staffed = (() => {
    log.solids.length = 0; room.frame(640, 360, 1, { crew, time: 1, core: 1 });
    return log.solids.length;
  })();
  check('a crewed station adds its figure — four parts each', staffed - empty === 5 * 4,
    `${empty} → ${staffed}`);

  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 1, core: 1 });
  check('…and the core is always 14 rising blobs plus two halos',
    log.sprites.length === 16, `${log.sprites.length} sprites on an empty, undamaged room`);

  const brightest = (list) => Math.max(0, ...list.filter((s) => s.b > 0.6).map((s) => s.g));
  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 2.2, core: 1 });
  const low = brightest(log.sprites);
  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 2.2, core: 8 });
  const high = brightest(log.sprites);
  check('the plasma is brighter on an upgraded core', high > low, `${low.toFixed(2)} → ${high.toFixed(2)}`);

  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 3, hull: 1, core: 1 });
  const clean = log.sprites.length;
  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 3, hull: 0.1, core: 1 });
  check('a holed hull adds embers to the room', log.sprites.length > clean,
    `${clean} → ${log.sprites.length} sprites`);

  log.sprites.length = 0;
  room.frame(640, 360, 1, { crew: [], time: 1.5, hull: 0.2, core: 4 });
  check('the core runs red when the hull is holed',
    log.sprites.some((s) => s.r > s.b && s.r > 0.25));

  check('an empty state never throws', (() => {
    try { room.frame(320, 180, 1); return true; } catch { return false; }
  })());
  check('a nonsense core level is clamped, not multiplied into the dark', (() => {
    log.sprites.length = 0;
    room.frame(640, 360, 1, { crew, time: 0, core: 999 });
    return log.sprites.every((s) => [s.r, s.g, s.b].every((n) => Number.isFinite(n) && Math.abs(n) <= 1.001));
  })());
}

/* ------------------------------------------------ 4. `gl.solid` is the shim now */
console.log('\n`gl.solid` scales and shades one primitive per call');
{
  const { gl, log } = fakeGLModule();
  const r = gl.create({ width: 0, height: 0, getContext: () => log.ctx });
  check('the renderer built with no model at all', Boolean(r && r.ok));

  log.draws.length = 0;
  r.solid('box', 0, 0, 0, 2, 1, 4, 0, [0.5, 0.5, 0.5]);
  check('one solid is one indexed draw', log.draws.length === 1 && log.draws[0][0] === 'elements',
    JSON.stringify(log.draws[0]));
  const model = log.matrices.model.at(-1);
  check('the model matrix carries the size on each axis',
    Math.abs(model[0] - 2) < 1e-6 && Math.abs(model[5] - 1) < 1e-6 && Math.abs(model[10] - 4) < 1e-6,
    `${model[0]} / ${model[5]} / ${model[10]}`);
  const norm = log.matrices.norm.at(-1);
  check('…and the normal basis is divided by the same sizes, so lighting stays right',
    Math.abs(norm[0] - 0.5) < 1e-6 && Math.abs(norm[4] - 1) < 1e-6 && Math.abs(norm[8] - 0.25) < 1e-6,
    `${norm[0]} / ${norm[4]} / ${norm[8]}`);

  log.matrices.model.length = 0;
  r.body('box', 0, 0, 0, 3, 0, [0.5, 0.5, 0.5], undefined, undefined, 2);
  const squashed = log.matrices.model.at(-1);
  check('`body` is now `solid` with a cube and a squash',
    Math.abs(squashed[0] - 3) < 1e-6 && Math.abs(squashed[5] - 6) < 1e-6 && Math.abs(squashed[10] - 3) < 1e-6,
    `${squashed[0]} / ${squashed[5]} / ${squashed[10]}`);

  log.matrices.norm.length = 0;
  r.solid('box', 0, 0, 0, 0, 1, 1, 0, [1, 1, 1]);
  check('a zero axis falls back to 1 instead of dividing into NaN',
    log.matrices.norm.at(-1).every((n) => Number.isFinite(n)));
}

/* ------------------------------------------------ 5. the panel drives it, and survives */
console.log('\nthe hangar panel opens the room, and a broken frame only costs the 3D');
{
  const boot = (GLstub) => {
    installDOM({ width: 412, height: 915 });
    const rafQueue = [];
    console.warn = () => {};
    globalThis.window.parent = { postMessage() {} };
    globalThis.parent = globalThis.window.parent;
    globalThis.localStorage = {
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('SecurityError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    globalThis.window.localStorage = globalThis.localStorage;
    globalThis.addEventListener = () => {};
    globalThis.removeEventListener = () => {};
    globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
    globalThis.window.devicePixelRatio = 2;
    globalThis.document.title = 'Star Battle';

    for (const file of ['games/_shared/sdk.js', 'games/star-battle/ships.js', 'games/star-battle/art.js',
      'games/star-battle/gl.js', 'games/star-battle/interior3d.js', 'games/star-battle/game.js']) {
      vm.runInThisContext(read(file), { filename: file });
    }
    // the real `gl.js` owns `StarGL`; the interior borrows it, so the stand-in
    // has to go in after the page has loaded
    Object.defineProperty(globalThis.window, 'StarGL', { value: GLstub, configurable: true, writable: true });
    return { game: globalThis.window.__starBattle, rafQueue };
  };

  {
    const { api, log } = recorder();
    const { game, rafQueue } = boot({ create: () => api });
    check('opening the panel does not throw', (() => {
      try { game.interior(); return true; } catch { return false; }
    })());
    check('…and the game knows the room is up', game.interior3D === true);

    // the panel redraws on the game clock, so the fake clock has to advance
    let clock = 0;
    for (let i = 0; i < 20; i++) {
      const fn = rafQueue.shift();
      clock += 60;
      if (fn) fn(clock);
    }
    check('the room is drawn by the game loop, not only on open', log.solids.length > 500,
      `${log.solids.length} solids over 20 frames`);
    check('every frame the room gets the hull and the core it is flying',
      log.solids.every((s) => s.rgb && s.rgb.length === 3));
    game.closeInterior();
  }

  {
    // a context that dies mid-frame: the panel must fall back, not the game
    let calls = 0;
    const { api } = recorder();
    const flaky = {
      ...api,
      solid(...args) { calls += 1; if (calls > 40) throw new Error('context lost'); return api.solid(...args); },
    };
    const { game, rafQueue } = boot({ create: () => flaky });
    game.interior();
    check('the room came up before the failure', game.interior3D === true);
    for (let i = 0; i < 12 && game.interior3D; i++) {
      const fn = rafQueue.shift();
      if (fn) fn(100 + i * 16);
    }
    check('a frame that throws drops the room instead of the panel', game.interior3D === false);
    check('the game is still running after it', (() => {
      const fn = rafQueue.shift();
      try { if (fn) fn(900); return true; } catch { return false; }
    })());
  }

  {
    // no WebGL at all: the schematic keeps the panel, exactly as before
    const { game } = boot(undefined);
    game.interior();
    check('with no renderer the panel still opens, on the schematic', game.interior3D === false);
    game.closeInterior();
  }
}

/* ------------------------------------------------------------------- the GL */
function fakeGLModule() {
  const K = {};
  ['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'FLOAT', 'SHORT', 'BYTE',
    'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'TRIANGLES', 'LINES', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
    'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_UNIFORMS', 'DEPTH_TEST', 'BLEND', 'ONE', 'SRC_ALPHA',
    'LEQUAL', 'CULL_FACE', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT'].forEach((key, i) => { K[key] = i + 1; });

  const UNIFORMS = ['uProj', 'uView', 'uModel', 'uNorm', 'uColor', 'uGlow', 'uEmissive',
    'uTint', 'uCam', 'uExposure', 'uDamage'];
  const log = { draws: [], matrices: { model: [], norm: [] } };
  log.ctx = {
    ...K,
    canvas: null,
    createShader: () => ({}), shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => ({}), attachShader() {}, linkProgram() {},
    getProgramParameter: (p, what) => (what === K.ACTIVE_UNIFORMS ? UNIFORMS.length : true),
    getActiveUniform: (p, i) => ({ name: UNIFORMS[i] }),
    getProgramInfoLog: () => '',
    getUniformLocation: (p, n) => ({ name: n }),
    getAttribLocation: (p, n) => ['aPos', 'aNrm', 'aAlb', 'aCorner', 'aOffset', 'aCenter', 'aColor'].indexOf(n),
    createBuffer: () => ({}), bindBuffer() {}, bufferData() {},
    enable() {}, disable() {}, depthFunc() {}, depthMask() {}, clearColor() {}, clear() {},
    viewport() {}, blendFunc() {}, useProgram() {},
    uniformMatrix4fv(loc, transpose, value) {
      if (loc?.name === 'uModel') log.matrices.model.push(Array.from(value));
    },
    uniformMatrix3fv(loc, transpose, value) {
      if (loc?.name === 'uNorm') log.matrices.norm.push(Array.from(value));
    },
    uniform3f() {}, uniform1f() {}, enableVertexAttribArray() {}, vertexAttribPointer() {},
    drawElements(mode, count) { log.draws.push(['elements', count]); },
    drawArrays(mode, first, count) { log.draws.push(['arrays', count]); },
  };

  const sandbox = { window: { atob: (s) => Buffer.from(s, 'base64').toString('binary') }, console: { warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('games/star-battle/gl.js'), sandbox);
  return { gl: sandbox.window.StarGL, log };
}

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nTHE INTERIOR HOLDS');
process.exitCode = problems.length ? 1 : 0;
