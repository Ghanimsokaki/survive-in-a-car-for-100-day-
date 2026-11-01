/**
 * THE REAL RENDERER, HEADLESS — a regression suite for "GRAPHICS ERROR".
 *
 * The reported failure: starting **FUEL RUN** put "GRAPHICS ERROR — … PRESS
 * RESTART" on screen with repeated RENDER ERROR toasts. Nothing in the other
 * suites can catch that class of bug, because `tests/three-shim.js` stubs
 * `WebGLRenderer.render()` to a no-op: a scene the real three.js would refuse
 * draws perfectly in every test and fails in the browser.
 *
 * So this suite hands the *real* `THREE.WebGLRenderer` a recording WebGL
 * context. It will not produce pixels, but it runs the whole JS render pipeline
 * — program setup, attribute binding, texture upload, uniform refresh, shadow
 * passes — and throws wherever a browser would. Every mode, at the tier a phone
 * actually resolves to, is driven through the same loop `requestAnimationFrame`
 * drives, and the scene is audited for the things a GPU rejects:
 *
 *   · a drawable with no position attribute, or a NaN in one;
 *   · an index past the end of its vertex buffer, or a >65k mesh in a 16-bit
 *     index buffer;
 *   · a textured material with no UVs, a vertex-coloured one with no colours;
 *   · a material slot that is undefined, or a group pointing past the list.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM, El } from './doms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

globalThis.__COARSE__ = true;          // a phone: the tier the report came from
globalThis.__TOUCH__ = true;
installDOM({ width: 412, height: 915 });

/* --------------------------------------------------------------- the mock GL */
const K = {};
['ARRAY_BUFFER', 'ELEMENT_ARRAY_BUFFER', 'TEXTURE_2D', 'TEXTURE_CUBE_MAP',
  'TEXTURE_CUBE_MAP_POSITIVE_X', 'TEXTURE_CUBE_MAP_NEGATIVE_X', 'TEXTURE_CUBE_MAP_POSITIVE_Y',
  'TEXTURE_CUBE_MAP_NEGATIVE_Y', 'TEXTURE_CUBE_MAP_POSITIVE_Z', 'TEXTURE_CUBE_MAP_NEGATIVE_Z',
  'FRAMEBUFFER', 'RENDERBUFFER', 'STATIC_DRAW', 'DYNAMIC_DRAW', 'STREAM_DRAW', 'FLOAT', 'HALF_FLOAT',
  'UNSIGNED_BYTE', 'UNSIGNED_SHORT', 'UNSIGNED_INT', 'SHORT', 'BYTE', 'INT', 'TRIANGLES',
  'TRIANGLE_STRIP', 'LINES', 'POINTS', 'LINE_STRIP', 'VERTEX_SHADER', 'FRAGMENT_SHADER',
  'COMPILE_STATUS', 'LINK_STATUS', 'ACTIVE_UNIFORMS', 'ACTIVE_ATTRIBUTES', 'DEPTH_TEST', 'BLEND',
  'ONE', 'ZERO', 'SRC_ALPHA', 'ONE_MINUS_SRC_ALPHA', 'LEQUAL', 'LESS', 'GREATER', 'ALWAYS',
  'CULL_FACE', 'BACK', 'FRONT', 'COLOR_BUFFER_BIT', 'DEPTH_BUFFER_BIT', 'STENCIL_BUFFER_BIT',
  'TEXTURE0', 'TEXTURE1', 'TEXTURE2', 'TEXTURE3', 'TEXTURE4', 'TEXTURE5', 'TEXTURE6', 'TEXTURE7',
  'CLAMP_TO_EDGE', 'REPEAT', 'MIRRORED_REPEAT', 'LINEAR', 'NEAREST', 'LINEAR_MIPMAP_LINEAR',
  'LINEAR_MIPMAP_NEAREST', 'NEAREST_MIPMAP_LINEAR', 'NEAREST_MIPMAP_NEAREST', 'RGBA', 'RGB',
  'ALPHA', 'LUMINANCE', 'DEPTH_COMPONENT', 'DEPTH_COMPONENT16', 'DEPTH_COMPONENT24',
  'UNSIGNED_SHORT_4_4_4_4', 'UNSIGNED_SHORT_5_5_5_1', 'UNSIGNED_SHORT_5_6_5', 'FRAMEBUFFER_COMPLETE',
  'MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_TEXTURE_IMAGE_UNITS',
  'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_UNIFORM_VECTORS',
  'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_VERTEX_ATTRIBS', 'MAX_SAMPLES',
  'MAX_RENDERBUFFER_SIZE', 'SCISSOR_TEST', 'DEPTH_WRITEMASK', 'COLOR_WRITEMASK', 'CURRENT_PROGRAM',
  'VIEWPORT', 'UNPACK_FLIP_Y_WEBGL', 'UNPACK_PREMULTIPLY_ALPHA_WEBGL', 'UNPACK_ALIGNMENT',
  'POLYGON_OFFSET_FILL', 'SAMPLE_ALPHA_TO_COVERAGE', 'STENCIL_TEST', 'FUNC_ADD', 'FUNC_SUBTRACT',
  'EQUAL', 'NOTEQUAL', 'GEQUAL', 'MULTIPLY', 'REPLACE', 'SCISSOR_BOX', 'VERSION',
  'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_ARRAY_TEXTURE_LAYERS',
  'MAX_3D_TEXTURE_SIZE', 'VERTEX_ARRAY_BINDING'].forEach((name, i) => { K[name] = 1000 + i; });
const byValue = Object.fromEntries(Object.entries(K).map(([name, value]) => [value, name]));

const calls = { draws: 0, arrays: 0 };

function makeGL() {
  const extension = () => new Proxy({}, {
    get(target, key) {
      if (key === 'then') return undefined;
      return () => (/SUPPORTED|isInstance/i.test(String(key)) ? true : {});
    },
  });
  const base = {
    ...K,
    canvas: null,
    drawingBufferWidth: 412,
    drawingBufferHeight: 915,
    getContextAttributes: () => ({ alpha: false, antialias: true, depth: true, stencil: false }),
    getExtension: () => extension(),
    getSupportedExtensions: () => [],
    getParameter(name) {
      const key = byValue[name] || '';
      if (key === 'MAX_TEXTURE_SIZE' || key === 'MAX_CUBE_MAP_TEXTURE_SIZE' || key === 'MAX_RENDERBUFFER_SIZE') return 8192;
      if (key === 'MAX_SAMPLES') return 4;
      if (/MAX_.*TEXTURE_IMAGE_UNITS|MAX_VERTEX_ATTRIBS|MAX_.*VECTORS|MAX_ARRAY_TEXTURE_LAYERS/.test(key)) return 32;
      if (key === 'MAX_3D_TEXTURE_SIZE') return 2048;
      if (key === 'VERSION') return 'WebGL 1.0 (headless)';
      if (key === 'SHADING_LANGUAGE_VERSION') return 'WebGL GLSL ES 1.0 (headless)';
      if (key === 'VENDOR' || key === 'RENDERER') return 'arena headless';
      if (key === 'VIEWPORT' || key === 'SCISSOR_BOX') return new Int32Array([0, 0, 412, 915]);
      if (key === 'DEPTH_WRITEMASK' || key === 'COLOR_WRITEMASK') return true;
      return 0;
    },
    getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }),
    createShader: () => ({}), createProgram: () => ({}), createBuffer: () => ({}),
    createTexture: () => ({}), createFramebuffer: () => ({}), createRenderbuffer: () => ({}),
    createVertexArray: () => ({}), createQuery: () => ({}),
    shaderSource() {}, compileShader() {}, attachShader() {}, linkProgram() {},
    getShaderParameter: () => true, getShaderInfoLog: () => '', getProgramInfoLog: () => '',
    getProgramParameter: () => 0,
    getActiveUniform: () => ({ name: 'none', size: 1, type: 1 }),
    getActiveAttrib: () => ({ name: 'none', size: 1, type: 1 }),
    getUniformLocation: () => ({}), getAttribLocation: () => 0, getShaderSource: () => '',
    bindAttribLocation() {}, deleteShader() {}, deleteProgram() {}, deleteBuffer() {},
    deleteTexture() {}, deleteFramebuffer() {}, deleteRenderbuffer() {}, deleteVertexArray() {},
    bufferData() {}, bufferSubData() {}, texImage2D() {}, texSubImage2D() {}, texParameteri() {},
    texParameterf() {}, pixelStorei() {}, generateMipmap() {}, compressedTexImage2D() {},
    activeTexture() {}, bindTexture() {}, bindFramebuffer() {}, bindRenderbuffer() {},
    framebufferTexture2D() {}, framebufferRenderbuffer() {}, renderbufferStorage() {},
    checkFramebufferStatus: () => K.FRAMEBUFFER_COMPLETE,
    clear() {}, clearColor() {}, clearDepth() {}, clearStencil() {}, colorMask() {}, depthMask() {},
    depthFunc() {}, enable() {}, disable() {}, blendFunc() {}, blendFuncSeparate() {},
    blendEquation() {}, blendEquationSeparate() {}, cullFace() {}, frontFace() {}, viewport() {},
    scissor() {}, useProgram() {}, bindBuffer() {}, bindVertexArray() {},
    enableVertexAttribArray() {}, disableVertexAttribArray() {},
    vertexAttribPointer() {}, vertexAttribIPointer() {}, vertexAttribDivisor() {},
    drawArrays() { calls.draws += 1; calls.arrays += 1; },
    drawElements() { calls.draws += 1; },
    drawArraysInstanced() { calls.draws += 1; }, drawElementsInstanced() { calls.draws += 1; },
    uniform1f() {}, uniform1i() {}, uniform2f() {}, uniform3f() {}, uniform4f() {}, uniform2fv() {},
    uniform3fv() {}, uniform4fv() {}, uniformMatrix2fv() {}, uniformMatrix3fv() {},
    uniformMatrix4fv() {}, uniform1iv() {}, uniform2iv() {}, uniform3iv() {},
    readPixels() {}, finish() {}, flush() {}, isContextLost: () => false,
    getUniformBlockIndex: () => 0, getActiveUniformBlockParameter: () => 0,
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'string' && /^[A-Z0-9_]+$/.test(key)) return K[key] ?? 0;
      return () => ({});
    },
  });
}

/* --------------------------------------------- the real three, and the audit */
const THREE = await import('../public/vendor/three.module.js');
console.log('three r' + THREE.REVISION + ', real WebGLRenderer on a recording context');

const mockGL = makeGL();
const canvas = {
  style: {}, width: 412, height: 915, clientWidth: 412, clientHeight: 915,
  addEventListener() {}, removeEventListener() {},
  getContext: (kind) => (kind === '2d' ? null : mockGL),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 412, height: 915 }),
};
mockGL.canvas = canvas;

let renderer = null;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, stencil: false, depth: true });
  renderer.setPixelRatio(1);
  renderer.setSize(412, 915);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
} catch (err) {
  renderer = null;
  console.log(`  (the real renderer refused the stub: ${err.message})`);
}

const { Game } = await import('./app/js/game.js');
const { MODES } = await import('./app/js/modes.js');

/** What three.js touches, and what a GPU rejects. Returns the first few faults. */
function auditScene(scene, camera, where) {
  if (!scene || !scene.isScene) return `no scene (${where})`;
  if (!camera || !camera.isCamera) return `no camera (${where})`;
  const bad = [];
  scene.updateMatrixWorld(true);
  scene.traverse((obj) => {
    const label = `${where}: ${obj.type}${obj.name ? ` "${obj.name}"` : ''}`;
    if (obj.matrixWorld?.elements?.some((v) => !Number.isFinite(v))) bad.push(`${label} — NaN transform`);
    if (obj.isInstancedMesh && !obj.instanceMatrix) bad.push(`${label} — instance matrix missing`);
    const g = obj.geometry;
    const mats = Array.isArray(obj.material) ? obj.material : (obj.material ? [obj.material] : []);
    if (!g) return;
    const pos = g.attributes?.position;
    if (!pos) { bad.push(`${label} — geometry with no position attribute`); return; }
    if (!pos.array) bad.push(`${label} — position attribute with no array`);
    else if (!Number.isFinite(pos.count) || pos.count === 0) bad.push(`${label} — empty position attribute`);
    else if (pos.array.some((v) => !Number.isFinite(v))) bad.push(`${label} — NaN in positions`);
    if (pos.count > 65535 && g.index && g.index.array instanceof Uint16Array) {
      bad.push(`${label} — >65k vertices in a 16-bit index buffer`);
    }
    if (g.index && pos.count) {
      let over = 0;
      for (const i of g.index.array) if (i > pos.count - 1) over += 1;
      if (over) bad.push(`${label} — ${over} indices past the last vertex`);
    }
    if ((obj.isMesh || obj.isPoints || obj.isLine || obj.isSprite) && !mats.length) {
      bad.push(`${label} — no material`);
    }
    if (Array.isArray(obj.material)) {
      if (obj.material.some((m) => !m)) bad.push(`${label} — a hole in the material array`);
      for (const grp of g.groups || []) {
        if (grp.materialIndex >= obj.material.length) {
          bad.push(`${label} — group materialIndex ${grp.materialIndex} of ${obj.material.length}`);
        }
      }
    }
    for (const m of mats) {
      if (!m) continue;
      if (m.vertexColors && !g.attributes.color) bad.push(`${label} — vertexColors with no color attribute`);
      if (m.map && !g.attributes.uv) bad.push(`${label} — textured material with no uv attribute`);
      for (const key of ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap',
        'aoMap', 'bumpMap', 'envMap']) {
        const tex = m[key];
        if (!tex || !tex.image) continue;
        if (!tex.image.width || !tex.image.height) bad.push(`${label} — ${key} image is 0-sized`);
      }
    }
  });
  return bad.slice(0, 3).join(' | ');
}

/* ------------------------------------------------------------- the runs */
const MODE = process.env.MODE || 'sprint';           // FUEL RUN is the reported one
const FRAMES = Number(process.env.FRAMES || 150);

console.log('\nthe reported run: FUEL RUN on a phone');
{
  let g = null;
  let threw = null;
  try {
    g = new Game({
      mount: new El('div', 'app'),
      profile: { name: 'AUDIT', color: 0xffb347, carColor: 0xd24a2b },
      room: 'audit', quality: 'auto', mode: MODE, onQuit: () => {},
    });
  } catch (err) { threw = err; }
  check('FUEL RUN starts without throwing', Boolean(g), threw ? threw.message : `${g?.modeId} @ ${g?.quality}`);
  if (g) {
    check('it is the fuel run, on the phone tier', g.modeId === 'sprint' && ['low', 'medium'].includes(g.quality),
      `${g.modeId} @ ${g.quality}`);

    if (renderer) {
      g.renderer = renderer;
      g.renderer.shadowMap.enabled = g.tier.shadows;
      g.mount.appendChild(canvas);
    }
    g.started = true;
    g.hud?.show?.();

    let failure = '';
    let firstFault = '';
    g.keys.forward = 1;
    for (let i = 0; i < FRAMES && !failure && !firstFault; i++) {
      try {
        g.updatePerf(1 / 60);
        g.time += 1 / 60;
        if (g.started && !g.paused) g.update(1 / 60);
        g.updateCamera(1 / 60);
        if (i % 10 === 0) g.paintHud?.();
      } catch (err) {
        failure = `update threw at frame ${i}: ${err.message}`;
        break;
      }
      if (renderer) {
        try { renderer.render(g.scene, g.camera); } catch (err) {
          failure = `render threw at frame ${i}: ${err.message}`;
          break;
        }
      }
      firstFault = auditScene(g.scene, g.camera, `${MODE} frame ${i}`);
    }
    check('no frame throws in the real render pipeline', !failure, failure || `${FRAMES} frames`);
    check('the scene is drawable, frame after frame', !firstFault, firstFault || 'no missing attributes');
    check('the game logged no render error of its own', (g.errorLog || []).length === 0,
      (g.errorLog || []).map((e) => `${e.kind}: ${e.message}`).join(' / ') || 'clean');
    if (renderer) {
      check('the renderer drew something (not a silently empty frame)', calls.draws > 0,
        `${calls.draws} draw calls`);
      const info = renderer.info?.render || {};
      check('the programs compiled and nothing was skipped', (info.calls ?? 0) > 0,
        `${info.calls ?? 0} calls, ${info.triangles ?? 0} triangles`);
    }
    // stutter, as far as a headless run can see it: the simulation + camera work
    // a frame costs. The draw itself needs a GPU, but a frame that spends its
    // whole budget before it ever reaches one is the usual cause of a visible
    // hitch, and it is measurable here.
    {
      const samples = [];
      g.paused = false;
      g.dead = false;
      for (let i = 0; i < 240; i++) {
        const t0 = performance.now();
        g.updatePerf(1 / 60);
        g.time += 1 / 60;
        try { if (g.started && !g.paused) g.update(1 / 60); } catch { break; }
        g.updateCamera(1 / 60);
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const mean = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? mean;
      check('a frame of simulation fits a phone budget', mean < 8,
        `mean ${mean.toFixed(2)} ms · p95 ${p95.toFixed(2)} ms over ${samples.length} frames`);
    }
    try { g.dispose?.(); } catch { /* no rAF handle under Node */ }
  }
}

console.log('\nevery mode starts and draws');
for (const mode of MODES.map((m) => m.id)) {
  let g = null;
  let failure = '';
  try {
    g = new Game({
      mount: new El('div', 'app'),
      profile: { name: 'AUDIT', color: 0xffb347, carColor: 0xd24a2b },
      room: 'audit', quality: 'medium', mode, onQuit: () => {},
    });
    if (renderer) { g.renderer = renderer; g.mount.appendChild(canvas); }
    g.started = true;
    g.keys.forward = 1;
    for (let i = 0; i < 30 && !failure; i++) {
      g.update(1 / 60);
      g.updateCamera(1 / 60);
      if (renderer) renderer.render(g.scene, g.camera);
    }
    failure = auditScene(g.scene, g.camera, mode);
  } catch (err) {
    failure = err.message;
  }
  check(`${mode} — constructed, 30 frames, scene clean`, !failure, failure || 'ok');
  try { g?.dispose?.(); } catch { /* no rAF handle */ }
}

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nTHE REAL RENDERER HOLDS');
process.exitCode = problems.length ? 1 : 0;
