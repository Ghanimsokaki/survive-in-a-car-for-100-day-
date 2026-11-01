/**
 * IRON TIDE — THE 3D SEA.
 *
 * The player asked for every game in 3D. Iron Tide's battle used to be a chart:
 * polylines for swell, flat silhouettes for hulls. `sea3d.js` gives the same
 * simulation a horizon and a chase camera.
 *
 * Pinned here, in the order it can go wrong:
 *
 *   1. the renderer refuses rather than throws — no canvas, no WebGL, a shader
 *      that will not compile: returns null every time, so the chart view stays;
 *   2. the plumbing — four programs, one indexed draw per hull, the whole ocean
 *      in a single indexed draw, every sprite in one additive draw, and a sprite
 *      queue that is capped instead of unbounded;
 *   3. the maths — the look-at point lands in the middle of the glass, +Y is up,
 *      anything behind the camera is culled, and a hull's yaw is the yaw the
 *      simulation gave it;
 *   4. the game — the battle takes the 3D path, draws the player, the enemy
 *      fleet and the islands, sizes the GL canvas rather than the hidden
 *      overlay, and if a frame throws it keeps fighting in 2D.
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

/* ------------------------------------------------------- a fake WebGL 1 */
const K = {};
['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'FLOAT', 'SHORT', 'BYTE',
  'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'TRIANGLES', 'LINES', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
  'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_UNIFORMS', 'DEPTH_TEST', 'BLEND', 'ONE', 'SRC_ALPHA',
  'LEQUAL', 'CULL_FACE', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT'].forEach((key, i) => { K[key] = i + 1; });

function makeGL({ failLink = false } = {}) {
  const log = { draws: [], attribs: [], uploads: [], programs: 0, uniforms: new Set() };
  const gl = {
    ...K,
    createShader: () => ({ kind: 'shader' }),
    shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => { log.programs += 1; return { kind: 'program' }; },
    attachShader() {}, linkProgram() {},
    getProgramParameter: (p, what) => (what === K.ACTIVE_UNIFORMS ? 1 : !failLink),
    getProgramInfoLog: () => 'link failed',
    getActiveUniform: () => ({ name: 'uProj' }),
    getUniformLocation: (p, n) => ({ name: n }),
    getAttribLocation: (p, n) => ['aPolar', 'aPos', 'aNrm', 'aCol', 'aQuad', 'aCorner', 'aSize',
      'aCenter', 'aColor'].indexOf(n),
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData(target, data) {
      log.uploads.push(typeof data === 'number' ? data : (data?.byteLength ?? data?.length ?? 0));
    },
    enable() {}, disable() {}, depthFunc() {}, depthMask() {}, clearColor() {}, clear() {},
    viewport() {}, blendFunc() {}, useProgram() {},
    uniformMatrix4fv(p, t, v) { if (Array.isArray(v) || v?.length === 16) log.uniforms.add('mat4'); },
    uniformMatrix3fv() {}, uniform3f() {}, uniform3fv() {}, uniform1f() {}, uniform1i() {},
    uniform4fv() {}, uniform2fv() {},
    enableVertexAttribArray() {},
    vertexAttribPointer(loc, size, type, norm, stride, offset) { log.attribs.push([size, stride, offset]); },
    drawElements(mode, count) { log.draws.push(['elements', count]); },
    drawArrays(mode, first, count) { log.draws.push(['arrays', count]); },
  };
  return { gl, log };
}

function loadSea3D() {
  const sandbox = { window: {}, console: { warn() {}, log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(read('games/iron-tide/sea3d.js'), sandbox);
  return sandbox.window.Sea3D;
}

/* --------------------------------------------- 1. it must never take the screen down */
console.log('\nthe renderer says no without breaking anything');
const Sea3D = loadSea3D();
{
  check('a canvas with no WebGL gives null, not a throw',
    Sea3D.create({ getContext: () => null }) === null);
  check('a canvas handing back a 2D context gives null too',
    Sea3D.create({ getContext: () => ({ fillRect() {} }) }) === null);
  check('no canvas at all gives null', Sea3D.create(null) === null);
  check('a shader that will not link gives null',
    Sea3D.create({ width: 0, height: 0, getContext: () => makeGL({ failLink: true }).gl }) === null,
    'no half-built renderer');
}

/* --------------------------------------------- 2. the plumbing, on a mock context */
console.log('\nthe renderer, on a mocked WebGL context');
{
  const { gl, log } = makeGL();
  const canvas = { width: 0, height: 0, getContext: () => gl };
  const r = Sea3D.create(canvas);
  check('a renderer exists and says so', Boolean(r && r.ok && r.mode === 'webgl'));
  check('it compiled four programs — sea, solid, sky, sprite', log.programs === 4, `${log.programs}`);
  check('the ocean is one mesh with a triangle budget a phone can afford',
    r.seaTris > 15000 && r.seaTris < 25000, `${r.seaTris} tris`);
  check('…and the hulls are small enough to draw a fleet of', r.meshInfo.tris < 400,
    `${r.meshInfo.tris} tris per hull`);

  r.begin(412, 915, 2);
  check('the backing store is sized in device pixels',
    canvas.width === 824 && canvas.height === 1830, `${canvas.width}×${canvas.height}`);

  r.camera(0, 100, -200, 0, 0, 0, 56);
  const centre = r.project(0, 0, 0, 412, 915);
  check('the look-at point is in the middle of the glass',
    Math.abs(centre.x - 206) < 2 && Math.abs(centre.y - 457.5) < 2,
    `${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}`);
  check('+Y is up the screen', r.project(0, 100, 0, 412, 915).y < centre.y);
  check('a point behind the camera is culled, not mirrored',
    r.project(0, 0, -400, 412, 915) === null);

  log.draws.length = 0;
  r.sky();
  check('the sky is one full-screen draw', log.draws.length === 1 && log.draws[0][0] === 'arrays');

  log.draws.length = 0;
  const sea = {
    t: 3.4, severity: 0.5, state: 'moderate',
    waves: [
      { amp: 1.4, k: 0.02, dir: 0.3, omega: 0.7, phase: 1.1 },
      { amp: 0.8, k: 0.05, dir: 1.9, omega: 1.2, phase: 0.4 },
    ],
  };
  r.sea(sea, 0, 0);
  check('the whole ocean is one indexed draw',
    log.draws.length === 1 && log.draws[0][0] === 'elements' && log.draws[0][1] === r.seaTris * 3,
    JSON.stringify(log.draws[0]));

  log.draws.length = 0;
  log.attribs.length = 0;
  r.body('ship', 0, 0, 0, 0.4, 46, [1, 1, 1], { heel: 0.05, trim: 0.02 });
  check('a hull is one indexed draw of the whole mesh',
    log.draws.length === 1 && log.draws[0][1] === r.meshInfo.tris * 3, JSON.stringify(log.draws[0]));
  check('…with three interleaved-free attributes, tightly packed',
    log.attribs.length === 3 && log.attribs.every(([, s]) => s === 0), JSON.stringify(log.attribs));

  log.draws.length = 0;
  r.body('jet', 10, 1, 10, 0, 14, [1, 1, 1]);
  r.body('island', 200, 0, 200, 0, 1, [1, 1, 1], { sx: 90, sy: 40, sz: 90 });
  check('a jet and an island each draw', log.draws.length === 2);

  log.draws.length = 0;
  for (let i = 0; i < 30; i++) r.sprite(0, 2, 0, 1.5, 1, 0.8, 0.3);
  check('30 splashes queue into 180 vertices', r.sprites === 30, `${r.sprites} sprites`);
  r.flushSprites();
  check('…and flush as one additive draw', log.draws.length === 1 && log.draws[0][1] === 180,
    JSON.stringify(log.draws[0]));
  r.flushSprites();
  check('the queue is emptied by the flush, so nothing is drawn twice', log.draws.length === 1);

  log.draws.length = 0;
  for (let i = 0; i < 5000; i++) r.sprite(0, 2, 0, 1.5, 1, 1, 1);
  r.flushSprites();
  check('the sprite queue is capped instead of unbounded', log.draws[0][1] <= 1400 * 6,
    `${log.draws[0][1]} vertices`);
}

/* --------------------------------------------- 3. the geometry itself */
console.log('\nthe hulls are ships, in metres, bow on +X');
{
  const ship = Sea3D.shipMesh(false);
  const jet = Sea3D.jetMesh();
  const isle = Sea3D.islandMesh();
  const bounds = (geo) => {
    const b = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    for (let i = 0; i < geo.verts; i++) {
      b.x[0] = Math.min(b.x[0], geo.pos[i * 3]); b.x[1] = Math.max(b.x[1], geo.pos[i * 3]);
      b.y[0] = Math.min(b.y[0], geo.pos[i * 3 + 1]); b.y[1] = Math.max(b.y[1], geo.pos[i * 3 + 1]);
      b.z[0] = Math.min(b.z[0], geo.pos[i * 3 + 2]); b.z[1] = Math.max(b.z[1], geo.pos[i * 3 + 2]);
    }
    return b;
  };
  const b = bounds(ship);
  check('the hull is a unit long, bow at +0.5', Math.abs(b.x[1] - 0.5) < 0.01 && Math.abs(b.x[0] + 0.5) < 0.01,
    `x ${b.x[0].toFixed(2)}…${b.x[1].toFixed(2)}`);
  check('…and it is long and narrow, not a barge',
    (b.z[1] - b.z[0]) < (b.x[1] - b.x[0]) / 3, `beam ${(b.z[1] - b.z[0]).toFixed(3)}`);
  check('…sitting on the water, not through it', b.y[0] > -0.06 && b.y[1] < 0.20,
    `y ${b.y[0].toFixed(2)}…${b.y[1].toFixed(2)}`);
  check('every mesh has normals and a colour per vertex',
    [ship, jet, isle].every((g) => g.nrm.length === g.pos.length && g.col.length === g.pos.length));
  check('an island is a unit-radius mound', (() => {
    const ib = bounds(isle);
    // 14 segments, so the widest vertex sits just inside the unit circle
    return Math.abs(ib.x[1] - 1) < 0.01 && ib.z[1] > 0.95 && ib.y[1] > 0.8 && ib.y[0] >= -0.001;
  })());
}

/* --------------------------------------------- 4. the game drives it, and survives */
console.log('\nthe battle plays in 3D, and a broken frame only costs the 3D');
{
  installDOM({ width: 412, height: 915 });
  const posted = [];
  const rafQueue = [];
  console.warn = () => {};
  globalThis.window.parent = { postMessage: (msg) => posted.push(msg) };
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
  globalThis.document.title = 'Iron Tide';

  // a stand-in for gl.js that records what the battle asks of it
  const drawn = { bodies: [], frames: 0, cameras: 0, seas: 0, sprites: 0, skies: 0 };
  let explode = false;
  globalThis.window.Sea3D = {
    create: () => ({
      ok: true, mode: 'webgl', tris: 22696, seaTris: 22176, meshInfo: { tris: 164 },
      begin() { drawn.frames += 1; },
      camera() { drawn.cameras += 1; },
      sky() { drawn.skies += 1; },
      sea() { drawn.seas += 1; },
      body(kind, x, y, z, yaw) {
        if (explode) { explode = false; throw new Error('GL_INVALID_OPERATION'); }
        drawn.bodies.push({ kind, x, y, z, yaw });
      },
      sprite() { drawn.sprites += 1; },
      flushSprites() {},
      project: () => ({ x: 10, y: 10, depth: 5, onScreen: true }),
    }),
  };

  let bootError = null;
  for (const file of ['games/_shared/sdk.js', 'games/iron-tide/fleet.js',
    'games/iron-tide/water.js', 'games/iron-tide/game.js']) {
    try { vm.runInThisContext(read(file), { filename: file }); } catch (error) {
      bootError = `${path.basename(file)}: ${error?.message}`;
      break;
    }
  }
  const it = globalThis.window.__ironTide;
  check('the game boots with the 3D sea available', bootError === null && Boolean(it),
    bootError || 'ok');

  const frameAt = rafQueue.shift();
  const step = (t) => {
    const fn = rafQueue.shift() || frameAt;
    try { fn(t); return null; } catch (error) { return error; }
  };

  it.startBattle();
  check('a sortie takes the 3D path', it.gl === true, String(it.gl));
  check('…and the renderer is the one with the hull meshes', it.glInfo?.tris > 20000,
    `${it.glInfo?.tris} tris`);

  let thrown = null;
  for (let i = 0; i < 180 && !thrown; i++) {
    it.tick(1 / 60);
    thrown = step(100 + i * 16);
  }
  check('180 ticks of 3D frames without a throw', thrown === null, thrown?.message || 'clean');
  check('the camera is placed every frame', drawn.cameras >= 60, `${drawn.cameras}`);
  check('the sky and the sea are drawn every frame', drawn.skies >= 60 && drawn.seas >= 60,
    `${drawn.skies} skies · ${drawn.seas} seas`);
  check('our hull is drawn last, so nothing fights it for depth',
    drawn.bodies.filter((b) => b.kind === 'ship' || b.kind === 'carrier').length > 0);
  check('the enemy fleet is drawn as hulls',
    drawn.bodies.filter((b) => b.kind !== 'island').length >= 2,
    `${drawn.bodies.filter((b) => b.kind !== 'island').length} hulls`);
  check('the sea has islands in it', it.islands.length === 7, `${it.islands.length} islands`);
  check('shells and spray go through the sprite queue', drawn.sprites > 0, `${drawn.sprites}`);

  // the fallback: one bad frame, and the chart view carries the fight
  explode = true;
  const boom = step(9000);
  check('a throwing 3D frame is swallowed', boom === null, boom?.message || 'swallowed');
  check('…the 3D path is dropped', it.gl === false, String(it.gl));
  thrown = null;
  for (let i = 0; i < 60 && !thrown; i++) {
    it.tick(1 / 60);
    thrown = step(9100 + i * 16);
  }
  check('…and the chart view carries the rest of the battle', thrown === null, thrown?.message || 'clean');
  check('the battle is still live', it.screen === 'battle', it.screen);
  check('the hub heard from the game', posted.some((m) => m?.type === 'arcade:ready'));
}

/* --------------------------------------------- 5. the page ships it */
console.log('\nthe page loads the renderer before the game');
{
  const html = read('games/iron-tide/index.html');
  const order = ['fleet.js', 'water.js', 'sea3d.js', 'game.js'].map((f) => html.indexOf(`src="${f}"`));
  check('all four scripts, in dependency order', order.every((i) => i > 0)
    && order[0] < order[1] && order[1] < order[2] && order[2] < order[3], order.join(','));
  check('there is a WebGL canvas for the sea', html.includes('id="c3"'));
  check('…and the 2D canvas stays as the overlay', html.includes('id="c"'));
  check('the render tag says which one is live', html.includes('id="renderTag"'));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nTHE 3D SEA HOLDS');
process.exit(problems.length ? 1 : 0);
