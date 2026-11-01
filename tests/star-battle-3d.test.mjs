/**
 * STAR BATTLE — the 3D renderer, and the game that drives it.
 *
 * There is no browser in this suite, so the WebGL context is mocked and the
 * assertions are about the things that actually go wrong in a real one:
 *
 *   1. `gl.js` on a context that is not WebGL — it must return null, never
 *      throw, so the 2D renderer keeps the screen;
 *   2. the plumbing — one hull upload at a 16-byte stride, one indexed draw per
 *      ship, one additive draw for every spark and beam, a capped sprite queue;
 *   3. the projection — the look-at point in the middle of the glass, +Y up,
 *      anything behind the camera culled;
 *   4. the game — it asks for the renderer, uses it, and if a single GL frame
 *      throws it drops to the 2D renderer *for good* instead of dying:
 *      a render error has to cost the 3D, never the game.
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

/* --------------------------------------------------------------- the hull */
const MESH = (() => {
  const sandbox = { window: { atob: (s) => Buffer.from(s, 'base64').toString('binary') } };
  vm.createContext(sandbox);
  vm.runInContext(read('games/star-battle/art/ship-mesh.js'), sandbox);
  return sandbox.window.STAR_MESH;
})();

/* --------------------------------------------------------- a fake WebGL 1 */
const K = {};
['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'FLOAT', 'SHORT', 'BYTE',
  'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'TRIANGLES', 'LINES', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
  'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_UNIFORMS', 'DEPTH_TEST', 'BLEND', 'ONE', 'SRC_ALPHA',
  'LEQUAL', 'CULL_FACE', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT'].forEach((key, i) => { K[key] = i + 1; });

function makeGL() {
  const log = { draws: [], attribs: [], uploads: [], programs: 0 };
  const gl = {
    ...K,
    createShader: () => ({ kind: 'shader' }),
    shaderSource() {}, compileShader() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', deleteShader() {},
    createProgram: () => { log.programs += 1; return { kind: 'program' }; },
    attachShader() {}, linkProgram() {},
    getProgramParameter: (p, what) => (what === K.ACTIVE_UNIFORMS ? 1 : true),
    getProgramInfoLog: () => '',
    getActiveUniform: () => ({ name: 'uProj' }),
    getUniformLocation: (p, n) => ({ name: n }),
    getAttribLocation: (p, n) => ['aPos', 'aNrm', 'aAlb', 'aCorner', 'aOffset', 'aCenter', 'aColor']
      .indexOf(n),
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData(target, data) {
      log.uploads.push(typeof data === 'number' ? data : (data?.byteLength ?? data?.length ?? 0));
    },
    enable() {}, disable() {}, depthFunc() {}, depthMask() {}, clearColor() {}, clear() {},
    viewport() {}, blendFunc() {}, useProgram() {},
    uniformMatrix4fv() {}, uniformMatrix3fv() {}, uniform3f() {}, uniform1f() {},
    enableVertexAttribArray() {},
    vertexAttribPointer(loc, size, type, norm, stride, offset) { log.attribs.push([stride, offset]); },
    drawElements(mode, count) { log.draws.push(['elements', count]); },
    drawArrays(mode, first, count) { log.draws.push(['arrays', count]); },
  };
  return { gl, log };
}

function loadGL() {
  const sandbox = {
    window: { atob: (s) => Buffer.from(s, 'base64').toString('binary') },
    console: { warn() {}, log() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(read('games/star-battle/gl.js'), sandbox);
  return sandbox.window.StarGL;
}

/* ------------------------------------------------ 1. it must never take the screen down */
console.log('\nthe renderer says no without breaking anything');
const StarGL = loadGL();
{
  check('a canvas with no WebGL gives null, not a throw',
    StarGL.create({ getContext: () => null }) === null);
  check('a canvas handing back a 2D context gives null too',
    StarGL.create({ getContext: () => ({ fillRect() {} }) }) === null);
  check('no canvas at all gives null', StarGL.create(null) === null);
  check('the primitives can be built on their own',
    ['sphere', 'box', 'cylinder'].every((k) => StarGL[k]()?.pos?.length > 0));
}

/* ------------------------------------------------ 2. the plumbing, on a mock context */
console.log('\nthe renderer, on a mocked WebGL context');
const { gl: fakeGL, log } = makeGL();
const canvas = { width: 0, height: 0, getContext: () => fakeGL };
const r = StarGL.create(canvas, { mesh: MESH });
{
  check('a renderer exists and says so', Boolean(r && r.ok && r.mode === 'webgl'));
  check('it compiled three programs and a line program', log.programs === 4, `${log.programs}`);
  check('it uploaded the baked hull', r.mesh?.verts > 2000 && r.mesh?.tris > 5000,
    `${r.mesh?.verts} verts · ${r.mesh?.tris} tris`);

  r.begin(412, 915, 2);
  check('the backing store is sized in device pixels',
    canvas.width === 824 && canvas.height === 1830, `${canvas.width}×${canvas.height}`);

  r.camera(0, 100, -200, 0, 0, 0, 58);
  const centre = r.project(0, 0, 0, 412, 915);
  check('the look-at point is in the middle of the glass',
    Math.abs(centre.x - 206) < 2 && Math.abs(centre.y - 457.5) < 2,
    `${centre.x.toFixed(0)}, ${centre.y.toFixed(0)}`);
  check('+Y is up the screen', r.project(0, 100, 0, 412, 915).y < centre.y);
  check('a point behind the camera is culled, not mirrored',
    r.project(0, 0, -400, 412, 915) === null);

  log.draws.length = 0;
  r.sky();
  check('the star shell is one draw call', log.draws.length === 1 && log.draws[0][1] > 3000,
    `${log.draws[0]?.[1]} vertices`);
  log.draws.length = 0;
  r.grid();
  check('the grid and the boundary are lines', log.draws[0]?.[0] === 'arrays', String(log.draws[0]?.[1]));

  log.draws.length = 0;
  log.attribs.length = 0;
  r.ship(0, 26, 0, 0.4, 34, [1, 1, 1], [0.4, 0.7, 1], { roll: 0.2, damage: 0.3 });
  check('a ship is one indexed draw of the whole hull',
    log.draws.length === 1 && log.draws[0][0] === 'elements' && log.draws[0][1] === r.mesh.tris * 3,
    JSON.stringify(log.draws[0]));
  check('every attribute agrees on the 16-byte stride',
    log.attribs.length === 3 && log.attribs.every(([s]) => s === 16), JSON.stringify(log.attribs));
  check('…with the offsets 0 / 6 / 10 — position, normal, albedo',
    log.attribs.map(([, o]) => o).join(',') === '0,6,10', JSON.stringify(log.attribs));

  log.draws.length = 0;
  r.body('sphere', 0, -400, 0, 200, 0, [0.3, 0.4, 0.5], [0.2, 0.3, 0.4], 0.5);
  r.body('drum', 0, 26, 0, 40, 0.5, [0.4, 0.6, 1]);
  r.body('box', 0, 26, 0, 40, 0.5, [0.4, 0.6, 1]);
  check('a planet, a drum and a box each draw', log.draws.length === 3);

  log.draws.length = 0;
  r.sprite(0, 26, 0, 6, 1, 1, 1);
  r.beam([0, 26, 0], [200, 26, 0], 3, [1, 0.8, 0.3]);
  r.sprites();
  check('a spark and a beam share one additive draw call',
    log.draws.length === 1 && log.draws[0][0] === 'arrays', JSON.stringify(log.draws[0]));
  check('…as two triangles each', log.draws[0][1] === 12, `${log.draws[0][1]} vertices`);
  r.sprites();
  check('the queue is emptied by the flush, so nothing is drawn twice',
    log.draws.length === 1, `${log.draws.length} draws`);

  log.draws.length = 0;
  for (let i = 0; i < 5000; i++) r.sprite(0, 26, 0, 4, 1, 1, 1);
  r.sprites();
  check('the sprite queue is capped instead of unbounded',
    log.draws[0][1] <= 2600 * 6, `${log.draws[0][1]} vertices`);

  check('a renderer can be handed the hull after it is built', (() => {
    const late = StarGL.create({ width: 0, height: 0, getContext: () => makeGL().gl });
    if (!late) return false;
    const before = late.tris;
    late.setMesh(MESH);
    return before === 0 && late.tris > 5000;
  })());
}

/* ------------------------------------------------ 3. the game drives it, and survives */
console.log('\nthe game renders in 3D, and a broken frame only costs the 3D');
{
  installDOM({ width: 412, height: 915 });
  const posted = [];
  const rafQueue = [];
  console.warn = () => {};                 // the game's own (handled) warnings
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
  globalThis.document.title = 'Star Battle';

  // the real hull, and a stand-in for `gl.js` that records what it is asked to draw
  globalThis.window.STAR_MESH = MESH;
  const drawn = { ships: 0, bodies: 0, sprites: 0, beams: 0, frames: 0, cameras: 0 };
  let explode = null;                       // set to 'ship' to break one frame
  const mock = {
    ok: true, mode: 'webgl', tris: 0,
    get mesh() { return this.tris ? { verts: 1, tris: this.tris } : null; },
    setMesh() { this.tris = MESH.tris; return true; },
    begin() { drawn.frames += 1; },
    camera() { drawn.cameras += 1; },
    sky() {}, grid() {},
    body() { drawn.bodies += 1; },
    ship() {
      if (explode === 'ship') { explode = null; throw new Error('GL_INVALID_OPERATION'); }
      drawn.ships += 1;
    },
    sprite() { drawn.sprites += 1; },
    beam() { drawn.beams += 1; },
    sprites() {},
    project: () => ({ x: 10, y: 10, depth: 5, onScreen: true }),
    setMeshLate() {},
  };
  globalThis.window.StarGL = {
    create: () => mock,
    sphere: () => ({ pos: [0, 0, 0], nrm: [0, 0, 1], idx: [0, 0, 0] }),
    box: () => ({ pos: [0, 0, 0], nrm: [0, 0, 1], idx: [0, 0, 0] }),
    cylinder: () => ({ pos: [0, 0, 0], nrm: [0, 0, 1], idx: [0, 0, 0] }),
  };

  let bootError = null;
  for (const file of ['games/_shared/sdk.js', 'games/star-battle/ships.js',
    'games/star-battle/art.js', 'games/star-battle/game.js']) {
    try { vm.runInThisContext(read(file), { filename: file }); } catch (error) {
      bootError = `${path.basename(file)}: ${error?.message}`;
      break;
    }
  }
  const it = globalThis.window.__starBattle;
  check('the game booted with a 3D renderer available', bootError === null && Boolean(it), bootError || 'ok');
  check('…and it took the 3D path', it?.gl === true, String(it?.gl));

  const frameAt = rafQueue.shift();
  const step = (t) => {
    const fn = rafQueue.shift() || frameAt;
    try { fn(t); return null; } catch (error) { return error; }
  };
  check('a hangar frame draws the ship in 3D', step(100) === null && drawn.ships >= 1,
    `${drawn.ships} ship draws`);

  it.start();
  it.spawnWave();
  let thrown = null;
  for (let i = 0; i < 240 && !thrown; i++) {
    it.tick(1 / 60);
    thrown = step(200 + i * 16);
  }
  check('240 ticks of real 3D frames without a throw', thrown === null, thrown?.message || 'clean');
  check('the camera is placed every frame', drawn.cameras >= 100, `${drawn.cameras} frames`);
  check('the sector landmarks are drawn as bodies', drawn.bodies > 0, `${drawn.bodies} bodies`);
  check('the wing and the contacts are drawn as ships', drawn.ships > 3, `${drawn.ships} ships`);
  check('sparks and beams go through the sprite queue', drawn.sprites > 0, `${drawn.sprites}`);

  // and now the important one: a GL frame that throws must not end the game
  explode = 'ship';
  const boom = step(9000);
  check('a throwing GL frame is swallowed', boom === null, boom?.message || 'swallowed');
  check('…the 3D path is dropped for good', it.gl === false, String(it.gl));
  thrown = null;
  for (let i = 0; i < 60 && !thrown; i++) {
    it.tick(1 / 60);
    thrown = step(9100 + i * 16);
  }
  check('…and the 2D renderer carries the rest of the run', thrown === null,
    thrown?.message || 'clean');
  check('the run is still live', it.screen === 'battle', it.screen);
  check('the hub heard from the game', posted.some((m) => m?.type === 'arcade:ready'));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nTHE 3D PATH HOLDS');
process.exit(problems.length ? 1 : 0);
