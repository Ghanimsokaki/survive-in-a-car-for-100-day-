/* IRON TIDE — SEA3D, a small dependency-free WebGL renderer for the battle.
 *
 * Iron Tide used to draw its sea from the top down: polylines that follow the
 * wave field, ships as flat silhouettes. This file gives the same simulation a
 * real horizon.
 *
 * Everything the player sees on the water is one of four programs:
 *
 *   sea    — a grid mesh displaced in the *vertex shader* from the same wave
 *            set `water.js` uses (amp, k, direction, omega, phase), so the
 *            swell the physics feels is the swell you look at. Normals are
 *            analytic, foam is slope, fog is distance.
 *   solid  — hulls, superstructures, funnels, jets, islands: one mesh per kind,
 *            one indexed draw per object, lit by a single sun with a rim term.
 *   sky    — a full-screen gradient with a sun and a horizon haze, drawn first
 *            with the depth mask off, so the sea can run right up to it.
 *   sprite — additive billboards for muzzle flashes, splashes and spray, all
 *            queued and flushed in one draw call.
 *
 * No three.js, no loaders, no fetch: the hub runs games in a sandboxed iframe,
 * and a second megabyte of renderer is the difference between a game that
 * starts and one that stalls.
 */
(function (root) {
  'use strict';

  const WAVES = 6;                 // uniform arrays are fixed-size in GLSL ES 1.0

  /* ------------------------------------------------------------------ maths */
  const m4 = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) / (near - far);
    out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    out[15] = 0;
    return out;
  }

  function lookAt(out, eye, at, up) {
    let zx = eye[0] - at[0];
    let zy = eye[1] - at[1];
    let zz = eye[2] - at[2];
    let len = Math.hypot(zx, zy, zz) || 1;
    zx /= len; zy /= len; zz /= len;
    // x = normalize(cross(up, z))
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
    xx /= len; xy /= len; xz /= len;
    // y = cross(z, x)
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    out[15] = 1;
    return out;
  }

  /**
   * T · Ryaw · Rx(heel) · Rz(trim) · S — a ship on the water, in one matrix.
   * The bow is +X, so `heel` is the roll about her own length (Rx) and `trim`
   * is the bow lifting over a crest (Rz).
   */
  function compose(out, x, y, z, yaw, heel, trim, sx, sy, sz) {
    const cy = Math.cos(yaw), sy0 = Math.sin(yaw);
    const cp = Math.cos(heel), sp = Math.sin(heel);
    const cr = Math.cos(trim), sr = Math.sin(trim);
    // R = Ry * Rx * Rz
    const r00 = cy * cr + sy0 * sp * sr;
    const r01 = -cy * sr + sy0 * sp * cr;
    const r02 = sy0 * cp;
    const r10 = cp * sr;
    const r11 = cp * cr;
    const r12 = -sp;
    const r20 = -sy0 * cr + cy * sp * sr;
    const r21 = sy0 * sr + cy * sp * cr;
    const r22 = cy * cp;
    out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx; out[3] = 0;
    out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy; out[7] = 0;
    out[8] = r02 * sz; out[9] = r12 * sz; out[10] = r22 * sz; out[11] = 0;
    out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
    return out;
  }

  /* ---------------------------------------------------------------- shaders */
  const V_SEA = `
  attribute vec3 aPolar;      // radius, cos(angle), sin(angle)
  uniform mat4 uProj, uView;
  uniform vec3 uOrigin;
  uniform float uTime;
  uniform vec4 uWaveA[6];
  uniform vec2 uWaveB[6];
  uniform int uWaveCount;
  varying vec3 vWorld;
  varying vec3 vNrm;
  varying float vH;
  void main() {
    // A radial grid: fine a few metres from the camera, coarse at the fog line,
    // so the swell has detail where the eye is and costs nothing where it is
    // not. The mesh follows the camera, which is why the waves are evaluated
    // from world position rather than from the vertex index.
    vec2 p = uOrigin.xz + aPolar.x * aPolar.yz;
    float h = 0.0;
    vec2 grad = vec2(0.0);
    for (int i = 0; i < 6; i++) {
      if (i >= uWaveCount) break;
      vec4 a = uWaveA[i];
      vec2 b = uWaveB[i];
      float ph = a.y * dot(p, a.zw) - b.x * uTime + b.y;
      h += a.x * sin(ph);
      grad += a.x * a.y * a.zw * cos(ph);
    }
    vH = h;
    vNrm = normalize(vec3(-grad.x, 1.0, -grad.y));
    vWorld = vec3(p.x, h, p.y);
    gl_Position = uProj * uView * vec4(vWorld, 1.0);
  }`;

  const F_SEA = `
  precision mediump float;
  varying vec3 vWorld;
  varying vec3 vNrm;
  varying float vH;
  uniform vec3 uEye, uSun, uDeep, uShallow, uFog;
  uniform float uFogNear, uFogFar, uSeverity, uFoamAmount, uTime;
  void main() {
    vec3 n = normalize(vNrm);
    vec3 toEye = normalize(uEye - vWorld);
    vec3 sun = normalize(uSun);
    // a fine chop the grid is far too coarse to resolve, added analytically:
    // it breaks the facets a 22 m triangle otherwise shows at a glancing angle
    vec2 q = vWorld.xz * 0.09;
    float chopx = cos(q.x * 1.7 + uTime * 1.3) * 0.06 + cos(q.y * 0.9 - uTime * 0.7) * 0.04;
    float chopz = sin(q.y * 1.5 - uTime * 1.1) * 0.06 + sin(q.x * 1.1 + uTime * 0.9) * 0.04;
    vec3 n2 = normalize(n + vec3(chopx, 0.0, chopz) * (0.6 + uSeverity));
    float diff = max(dot(n2, sun), 0.0);
    float spec = pow(max(dot(reflect(-sun, n2), toEye), 0.0), 26.0) * 0.75;
    float fres = pow(1.0 - max(dot(n2, toEye), 0.0), 3.0);
    float slope = 1.0 - n.y;
    float foam = smoothstep(0.10, 0.34, slope * (1.15 + uSeverity)) * uFoamAmount;
    vec3 col = mix(uDeep, uShallow, clamp(vH * 0.16 + 0.48, 0.0, 1.0));
    col += diff * vec3(0.15, 0.21, 0.25);
    col += fres * vec3(0.10, 0.19, 0.30);
    col += spec * vec3(0.85, 0.92, 1.0);
    col = mix(col, vec3(0.86, 0.93, 1.0), clamp(foam, 0.0, 0.82));
    float d = distance(uEye, vWorld);
    col = mix(col, uFog, smoothstep(uFogNear, uFogFar, d));
    gl_FragColor = vec4(col, 1.0);
  }`;

  const V_SOLID = `
  attribute vec3 aPos, aNrm, aCol;
  uniform mat4 uProj, uView, uModel;
  uniform mat3 uNormal;
  varying vec3 vN, vW, vC;
  void main() {
    vec4 w = uModel * vec4(aPos, 1.0);
    vW = w.xyz;
    vN = normalize(uNormal * aNrm);
    vC = aCol;
    gl_Position = uProj * uView * w;
  }`;

  const F_SOLID = `
  precision mediump float;
  varying vec3 vN, vW, vC;
  uniform vec3 uEye, uSun, uTint, uFog;
  uniform float uEmissive, uFogNear, uFogFar;
  void main() {
    vec3 n = normalize(vN);
    vec3 sun = normalize(uSun);
    vec3 toEye = normalize(uEye - vW);
    float diff = max(dot(n, sun), 0.0);
    float rim = pow(1.0 - max(dot(n, toEye), 0.0), 2.6) * 0.35;
    vec3 base = vC * uTint;
    vec3 col = base * (0.34 + diff * 0.92) + rim * vec3(0.5, 0.72, 0.9) * 0.35;
    col = mix(col, base * 1.35, uEmissive);
    float d = distance(uEye, vW);
    col = mix(col, uFog, smoothstep(uFogNear, uFogFar, d));
    gl_FragColor = vec4(col, 1.0);
  }`;

  const V_SKY = `
  attribute vec2 aQuad;
  varying vec2 vUv;
  void main() { vUv = aQuad * 0.5 + 0.5; gl_Position = vec4(aQuad, 0.999, 1.0); }`;

  const F_SKY = `
  precision mediump float;
  varying vec2 vUv;
  uniform vec3 uZenith, uHorizon, uSun, uForward, uRight, uUp;
  uniform float uAspect, uTan;
  void main() {
    vec2 ndc = vUv * 2.0 - 1.0;
    vec3 ray = normalize(uForward + uRight * (ndc.x * uAspect * uTan) + uUp * (ndc.y * uTan));
    float t = clamp(ray.y * 1.7, 0.0, 1.0);
    vec3 col = mix(uHorizon, uZenith, pow(t, 0.7));
    vec3 s = normalize(uSun);
    float d = max(dot(ray, s), 0.0);
    col += pow(d, 240.0) * 1.7 * vec3(1.0, 0.95, 0.82);
    col += pow(d, 9.0) * 0.20 * vec3(1.0, 0.86, 0.66);
    col += pow(1.0 - t, 6.0) * 0.10 * vec3(0.5, 0.7, 0.9);
    gl_FragColor = vec4(col, 1.0);
  }`;

  const V_SPRITE = `
  attribute vec2 aCorner, aSize;
  attribute vec3 aCenter, aColor;
  uniform mat4 uProj, uView;
  varying vec3 vC;
  varying vec2 vQ;
  void main() {
    vec4 c = uView * vec4(aCenter, 1.0);
    // billboards in view space: a quad that always faces the camera
    c.xy += aCorner * aSize;
    vC = aColor;
    vQ = aCorner;
    gl_Position = uProj * c;
  }`;

  const F_SPRITE = `
  precision mediump float;
  varying vec3 vC;
  varying vec2 vQ;
  void main() {
    float d = length(vQ);
    if (d > 1.0) discard;
    float a = pow(1.0 - d, 1.7);
    gl_FragColor = vec4(vC * a, a);
  }`;

  /* --------------------------------------------------------------- geometry
   * Everything is built once, in world units (1 unit = 1 metre), with the bow
   * along +X and the deck along +Y — the same convention the simulation uses
   * for its headings, so a ship's yaw is the hull's yaw.
   */
  function builder() {
    const pos = [];
    const nrm = [];
    const col = [];
    const idx = [];
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];

    const normalOf = () => {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };

    /** A quad from four corners, wound so the normal points out. */
    function quad(p0, p1, p2, p3, colour) {
      a[0] = p0[0]; a[1] = p0[1]; a[2] = p0[2];
      b[0] = p1[0]; b[1] = p1[1]; b[2] = p1[2];
      c[0] = p2[0]; c[1] = p2[1]; c[2] = p2[2];
      d[0] = p3[0]; d[1] = p3[1]; d[2] = p3[2];
      const n = normalOf();
      const base = pos.length / 3;
      for (const p of [p0, p1, p2, p3]) {
        pos.push(p[0], p[1], p[2]);
        nrm.push(n[0], n[1], n[2]);
        col.push(colour[0], colour[1], colour[2]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }

    /** A box from a centre, a half-size and a colour. */
    function box(cx, cy, cz, hx, hy, hz, colour) {
      const x0 = cx - hx, x1 = cx + hx;
      const y0 = cy - hy, y1 = cy + hy;
      const z0 = cz - hz, z1 = cz + hz;
      quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], colour);   // top
      quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], colour);   // bottom
      quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], colour);   // +x
      quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], colour);   // -x
      quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], colour);   // +z
      quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], colour);   // -z
    }

    /** A tapered prism along X: a hull. `sections` are [x, halfBeam, keelY, deckY]. */
    function hull(sections, deckColour, sideColour) {
      for (let i = 0; i < sections.length - 1; i++) {
        const s0 = sections[i];
        const s1 = sections[i + 1];
        const [x0, b0, k0, d0] = s0;
        const [x1, b1, k1, d1] = s1;
        // port and starboard sides
        quad([x0, k0, b0], [x1, k1, b1], [x1, d1, b1], [x0, d0, b0], sideColour);
        quad([x1, k1, -b1], [x0, k0, -b0], [x0, d0, -b0], [x1, d1, -b1], sideColour);
        // deck
        quad([x0, d0, b0], [x1, d1, b1], [x1, d1, -b1], [x0, d0, -b0], deckColour);
        // keel
        quad([x0, k0, -b0], [x1, k1, -b1], [x1, k1, b1], [x0, k0, b0], sideColour);
      }
      // transom: close the stern so it is not a hole when you look from behind
      const last = sections[sections.length - 1];
      quad([last[0], last[2], -last[1]], [last[0], last[2], last[1]],
        [last[0], last[3], last[1]], [last[0], last[3], -last[1]], sideColour);
      const first = sections[0];
      quad([first[0], first[2], first[1]], [first[0], first[2], -first[1]],
        [first[0], first[3], -first[1]], [first[0], first[3], first[1]], sideColour);
    }

    return {
      quad, box, hull,
      finish() {
        return {
          pos: new Float32Array(pos),
          nrm: new Float32Array(nrm),
          col: new Float32Array(col),
          idx: pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx),
          count: idx.length,
          verts: pos.length / 3,
        };
      },
    };
  }

  /**
   * A warship, unit length along X (bow at +0.5), beam 0.16, so the renderer can
   * scale it by the hull's real length in metres. Grey hull, planked deck, a
   * bridge, a funnel and turrets — enough silhouette to read as a ship at 300 m.
   */
  function shipMesh(big) {
    const b = builder();
    const steel = [0.26, 0.30, 0.35];
    const dark = [0.17, 0.20, 0.24];
    const deck = [0.21, 0.23, 0.24];
    const glass = [0.14, 0.26, 0.36];
    const light = [0.40, 0.44, 0.49];
    const beam = 0.075;
    b.hull([
      [0.50, 0.000, 0.010, 0.028],      // stem
      [0.36, 0.030, -0.012, 0.030],
      [0.06, beam, -0.030, 0.034],
      [-0.30, beam, -0.028, 0.032],
      [-0.46, beam * 0.85, -0.010, 0.030],
      [-0.50, beam * 0.55, 0.006, 0.026], // transom
    ], deck, steel);
    // forecastle and bridge block
    b.box(-0.02, 0.052, 0, 0.13, 0.020, beam * 0.78, steel);
    b.box(-0.04, 0.080, 0, 0.055, 0.018, beam * 0.55, light);
    b.box(0.020, 0.086, 0, 0.016, 0.010, beam * 0.5, glass);
    // funnel
    b.box(-0.20, 0.092, 0, 0.030, 0.026, beam * 0.34, dark);
    // masts
    b.box(0.20, 0.075, 0, 0.006, 0.048, 0.006, dark);
    b.box(-0.34, 0.070, 0, 0.006, 0.042, 0.006, dark);
    // turrets: barbette plus barrel, fore and aft
    for (const tx of [0.30, -0.34]) {
      b.box(tx, 0.046, 0, 0.030, 0.014, 0.030, dark);
      b.box(tx + (tx > 0 ? 0.045 : -0.045), 0.050, 0, 0.030, 0.005, 0.007, steel);
    }
    if (big) {
      // a carrier gets a flight deck instead of a forecastle
      b.box(0.10, 0.038, 0, 0.26, 0.006, beam * 1.5, deck);
    }
    return b.finish();
  }

  /** A jet boat: small, fast, all engine. */
  function jetMesh() {
    const b = builder();
    b.hull([
      [0.50, 0.00, 0.004, 0.016],
      [0.20, 0.045, -0.010, 0.018],
      [-0.30, 0.040, -0.006, 0.016],
      [-0.50, 0.020, 0.006, 0.012],
    ], [0.34, 0.30, 0.26], [0.24, 0.30, 0.36]);
    b.box(-0.10, 0.030, 0, 0.055, 0.014, 0.028, [0.18, 0.22, 0.26]);
    return b.finish();
  }

  /** An island: a low cone with a rocky skirt. Unit radius 1, unit height 1. */
  function islandMesh() {
    const b = builder();
    const rock = [0.22, 0.24, 0.20];
    const sand = [0.46, 0.42, 0.30];
    const green = [0.16, 0.26, 0.16];
    const segs = 14;
    const rings = [
      [1.00, 0.00], [0.94, 0.035], [0.66, 0.10],
      [0.38, 0.24], [0.16, 0.52], [0.00, 0.86],
    ];
    for (let r = 0; r < rings.length - 1; r++) {
      const [r0, y0] = rings[r];
      const [r1, y1] = rings[r + 1];
      const colour = r < 2 ? sand : r < 4 ? green : rock;
      for (let i = 0; i < segs; i++) {
        const a0 = (i / segs) * Math.PI * 2;
        const a1 = ((i + 1) / segs) * Math.PI * 2;
        const c0 = [Math.cos(a0) * r0, y0, Math.sin(a0) * r0];
        const c1 = [Math.cos(a1) * r0, y0, Math.sin(a1) * r0];
        if (r1 > 0.001) {
          const d0 = [Math.cos(a0) * r1, y1, Math.sin(a0) * r1];
          const d1 = [Math.cos(a1) * r1, y1, Math.sin(a1) * r1];
          b.quad(c0, d0, d1, c1, colour);
        } else {
          b.quad(c0, [0, y1, 0], c1, c1, colour);
        }
      }
    }
    return b.finish();
  }

  /* --------------------------------------------------------------- programs */
  function compile(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader?.(sh);
      throw new Error(`shader: ${log}`);
    }
    return sh;
  }

  function program(gl, vs, fs, attributes) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    }
    const attr = {};
    for (const name of attributes) attr[name] = gl.getAttribLocation(prog, name);
    const uni = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) | 0;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (info?.name) uni[info.name] = gl.getUniformLocation(prog, info.name);
    }
    // a fixed list of the names this file uses, so a driver that reports fewer
    // active uniforms than we ask for still hands back a truthy location object
    for (const name of [
      'uProj', 'uView', 'uModel', 'uNormal', 'uEye', 'uSun', 'uTint', 'uEmissive',
      'uFog', 'uFogNear', 'uFogFar', 'uDeep', 'uShallow', 'uSeverity', 'uFoamAmount',
      'uZenith', 'uHorizon', 'uForward', 'uRight', 'uUp', 'uAspect', 'uTan',
      'uOrigin', 'uCell', 'uTime', 'uWaveA', 'uWaveB', 'uWaveCount',
      'uWaveA[0]', 'uWaveB[0]',
    ]) {
      if (!uni[name]) uni[name] = gl.getUniformLocation(prog, name);
    }
    // an array uniform is addressed by its first element on every driver that
    // matters, but the name it reports back is not guaranteed — take either
    uni.uWaveA = uni.uWaveA || uni['uWaveA[0]'];
    uni.uWaveB = uni.uWaveB || uni['uWaveB[0]'];
    return { prog, attr, uni };
  }

  function b64GL(gl, data, target, usage) {
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, usage || gl.STATIC_DRAW);
    return buf;
  }

  /* ------------------------------------------------------------------ create */
  function create(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false, antialias: true, depth: true, powerPreference: 'high-performance',
      }) || canvas.getContext('experimental-webgl');
    } catch { gl = null; }
    if (!gl || typeof gl.createShader !== 'function') return null;

    let seaP, solidP, skyP, spriteP;
    try {
      seaP = program(gl, V_SEA, F_SEA, ['aPolar']);
      solidP = program(gl, V_SOLID, F_SOLID, ['aPos', 'aNrm', 'aCol']);
      skyP = program(gl, V_SKY, F_SKY, ['aQuad']);
      spriteP = program(gl, V_SPRITE, F_SPRITE, ['aCorner', 'aSize', 'aCenter', 'aColor']);
    } catch (err) {
      try { console.warn('iron tide: WebGL shaders failed —', err && err.message); } catch { /* quiet */ }
      return null;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);       // the hull quads are single-sided on purpose
    gl.clearColor(0.023, 0.055, 0.086, 1);

    const proj = m4();
    const view = m4();
    const model = m4();
    const normal = new Float32Array(9);
    const eye = [0, 30, 0];
    const at = [0, 0, 100];
    const up = [0, 1, 0];
    const sun = [-0.42, 0.62, 0.66];
    const state = { w: 1, h: 1, dpr: 1, fov: (56 * Math.PI) / 180, near: 1.2, far: 9000 };
    const fog = { near: 320, far: 2100, colour: [0.055, 0.115, 0.16] };

    /* ------------------------------------------------------- static buffers */
    const GL_POSITIONS = {};

    /**
     * The sea grid, in polar coordinates: rings out from the camera at a
     * geometric spacing, so the vertices are ~2 m apart under the bow and ~80 m
     * apart at the fog line. A square grid could not do both at this budget,
     * and a coarse square grid is exactly what makes water look like tiles.
     */
    const SEA_RINGS = 84;
    const SEA_SEGS = 132;
    const SEA_INNER = 44;        // metres: the nearest ring
    const SEA_OUTER = 5200;      // metres: past the fog, where it stops mattering
    const seaMesh = (() => {
      const verts = (SEA_RINGS + 1) * SEA_SEGS;
      const pos = new Float32Array(verts * 3);
      let p = 0;
      for (let r = 0; r <= SEA_RINGS; r++) {
        const radius = SEA_INNER * Math.pow(SEA_OUTER / SEA_INNER, r / SEA_RINGS);
        for (let i = 0; i < SEA_SEGS; i++) {
          const a = (i / SEA_SEGS) * Math.PI * 2;
          pos[p++] = radius;
          pos[p++] = Math.cos(a);
          pos[p++] = Math.sin(a);
        }
      }
      const idx = new Uint16Array(SEA_RINGS * SEA_SEGS * 6);
      let q = 0;
      for (let r = 0; r < SEA_RINGS; r++) {
        for (let i = 0; i < SEA_SEGS; i++) {
          const i0 = r * SEA_SEGS + i;
          const i1 = r * SEA_SEGS + ((i + 1) % SEA_SEGS);
          const i2 = (r + 1) * SEA_SEGS + i;
          const i3 = (r + 1) * SEA_SEGS + ((i + 1) % SEA_SEGS);
          idx[q++] = i0; idx[q++] = i2; idx[q++] = i1;
          idx[q++] = i1; idx[q++] = i2; idx[q++] = i3;
        }
      }
      return {
        vbo: b64GL(gl, pos, gl.ARRAY_BUFFER),
        ibo: b64GL(gl, idx, gl.ELEMENT_ARRAY_BUFFER),
        count: idx.length,
        tris: idx.length / 3,
      };
    })();

    const quadBuf = b64GL(gl, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.ARRAY_BUFFER);

    const uploadSolid = (geo) => ({
      pos: b64GL(gl, geo.pos, gl.ARRAY_BUFFER),
      nrm: b64GL(gl, geo.nrm, gl.ARRAY_BUFFER),
      col: b64GL(gl, geo.col, gl.ARRAY_BUFFER),
      idx: b64GL(gl, geo.idx, gl.ELEMENT_ARRAY_BUFFER),
      count: geo.count,
      verts: geo.verts,
      tris: geo.count / 3,
    });

    let meshes = null;
    let tris = seaMesh.tris;
    try {
      meshes = {
        ship: uploadSolid(shipMesh(false)),
        carrier: uploadSolid(shipMesh(true)),
        jet: uploadSolid(jetMesh()),
        island: uploadSolid(islandMesh()),
      };
      tris += meshes.ship.tris + meshes.carrier.tris + meshes.jet.tris + meshes.island.tris;
      void GL_POSITIONS;
    } catch (err) {
      try { console.warn('iron tide: hull geometry failed —', err && err.message); } catch { /* quiet */ }
      return null;
    }

    /* ------------------------------------------------------------ the sprite queue */
    const SPRITE_CAP = 1400;
    const spriteData = new Float32Array(SPRITE_CAP * 10);
    let spriteVerts = 0;
    const spriteBuf = b64GL(gl, spriteData.byteLength, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);

    function quadSprite(x, y, z, size, r, g, b) {
      if (spriteVerts + 6 > SPRITE_CAP) return false;
      const corner = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      let p = spriteVerts * 10;
      for (const [cx, cy] of corner) {
        spriteData[p++] = cx; spriteData[p++] = cy;
        spriteData[p++] = size; spriteData[p++] = size;
        spriteData[p++] = x; spriteData[p++] = y; spriteData[p++] = z;
        spriteData[p++] = r; spriteData[p++] = g; spriteData[p++] = b;
      }
      spriteVerts += 6;
      return true;
    }

    const api = {
      ok: true,
      mode: 'webgl',
      get tris() { return tris; },
      get seaTris() { return seaMesh.tris; },
      get meshInfo() { return meshes && meshes.ship; },
      get sprites() { return spriteVerts / 6; },

      /** Size the backing store and set the projection for this frame. */
      begin(w, h, dpr = 1) {
        const cw = Math.max(1, Math.round(w * dpr));
        const ch = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }
        state.w = w || 1;
        state.h = h || 1;
        state.dpr = dpr || 1;
        gl.viewport(0, 0, cw, ch);
        gl.clearColor(0.023, 0.055, 0.086, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        perspective(proj, state.fov, state.w / Math.max(1, state.h), state.near, state.far);
        spriteVerts = 0;
        return api;
      },

      /** A chase camera: `eye` and `at` are world positions in metres. */
      camera(ex, ey, ez, ax, ay, az, fov = 56) {
        eye[0] = ex; eye[1] = ey; eye[2] = ez;
        at[0] = ax; at[1] = ay; at[2] = az;
        state.fov = (fov * Math.PI) / 180;
        perspective(proj, state.fov, state.w / Math.max(1, state.h), state.near, state.far);
        lookAt(view, eye, at, up);
        return api;
      },

      /** Horizon, sun and haze. Drawn first, with the depth mask off. */
      sky(zenith, horizon, fogColour) {
        if (fogColour) { fog.colour[0] = fogColour[0]; fog.colour[1] = fogColour[1]; fog.colour[2] = fogColour[2]; }
        gl.depthMask(false);
        gl.useProgram(skyP.prog);
        gl.uniform3fv(skyP.uni.uZenith, zenith || [0.05, 0.13, 0.22]);
        gl.uniform3fv(skyP.uni.uHorizon, horizon || horizonOf());
        gl.uniform3fv(skyP.uni.uSun, sun);
        gl.uniform3fv(skyP.uni.uForward, [-view[2], -view[6], -view[10]]);
        gl.uniform3fv(skyP.uni.uRight, [view[0], view[4], view[8]]);
        gl.uniform3fv(skyP.uni.uUp, [view[1], view[5], view[9]]);
        gl.uniform1f(skyP.uni.uAspect, state.w / Math.max(1, state.h));
        gl.uniform1f(skyP.uni.uTan, Math.tan(state.fov / 2));
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
        gl.enableVertexAttribArray(skyP.attr.aQuad);
        gl.vertexAttribPointer(skyP.attr.aQuad, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.depthMask(true);
        return api;
      },

      /**
       * The ocean. `sea` is a `water.js` sea: its wave set is uploaded as
       * uniforms, so the vertex shader displaces the grid with exactly the
       * field the physics samples — the swell you see is the swell that lifts
       * the hull.
       */
      sea(sea, cx, cz) {
        const waves = (sea && sea.waves) || [];
        const count = Math.min(WAVES, waves.length);
        const a = new Float32Array(WAVES * 4);
        const b = new Float32Array(WAVES * 2);
        let ampSum = 0;
        for (let i = 0; i < count; i++) {
          const w = waves[i];
          a[i * 4] = w.amp || 0;
          a[i * 4 + 1] = w.k || 0;
          a[i * 4 + 2] = Math.cos(w.dir || 0);
          a[i * 4 + 3] = Math.sin(w.dir || 0);
          b[i * 2] = w.omega || 0;
          b[i * 2 + 1] = w.phase || 0;
          ampSum += Math.abs(w.amp || 0);
        }
        void ampSum;
        gl.useProgram(seaP.prog);
        gl.uniformMatrix4fv(seaP.uni.uProj, false, proj);
        gl.uniformMatrix4fv(seaP.uni.uView, false, view);
        gl.uniform3f(seaP.uni.uOrigin, cx, 0, cz);
        gl.uniform1f(seaP.uni.uTime, (sea && sea.t) || 0);
        gl.uniform4fv(seaP.uni.uWaveA, a);
        gl.uniform2fv(seaP.uni.uWaveB, b);
        gl.uniform1i(seaP.uni.uWaveCount, count);
        gl.uniform3fv(seaP.uni.uEye, eye);
        gl.uniform3fv(seaP.uni.uSun, sun);
        gl.uniform3fv(seaP.uni.uDeep, [0.012, 0.045, 0.075]);
        gl.uniform3fv(seaP.uni.uShallow, [0.045, 0.145, 0.19]);
        gl.uniform3fv(seaP.uni.uFog, fog.colour);
        gl.uniform1f(seaP.uni.uFogNear, fog.near);
        gl.uniform1f(seaP.uni.uFogFar, fog.far);
        gl.uniform1f(seaP.uni.uSeverity, (sea && sea.severity) || 0);
        gl.uniform1f(seaP.uni.uFoamAmount, 0.55 + ((sea && sea.severity) || 0) * 0.45);
        gl.uniform1f(seaP.uni.uTime, (sea && sea.t) || 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, seaMesh.vbo);
        gl.enableVertexAttribArray(seaP.attr.aPolar);
        gl.vertexAttribPointer(seaP.attr.aPolar, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, seaMesh.ibo);
        gl.drawElements(gl.TRIANGLES, seaMesh.count, 0x1403 /* UNSIGNED_SHORT */, 0);
        return api;
      },

      /**
       * One lit object: a hull, a jet, an island. `heel` and `trim` come
       * straight from the water body, so a ship in a heavy sea heels the way
       * the physics says it heels.
       */
      body(kind, x, y, z, yaw, scale, tint, { heel = 0, trim = 0, emissive = 0, sx, sy, sz } = {}) {
        const mesh = meshes[kind] || meshes.ship;
        compose(model, x, y, z, yaw, heel, trim,
          sx ?? scale, sy ?? scale, sz ?? scale);
        // upper 3×3 of the model matrix, inverse-transposed for the normal
        const m = model;
        normal[0] = m[0]; normal[1] = m[4]; normal[2] = m[8];
        normal[3] = m[1]; normal[4] = m[5]; normal[5] = m[9];
        normal[6] = m[2]; normal[7] = m[6]; normal[8] = m[10];
        // uniform scale only, so the rotation part is already the inverse
        const inv = 1 / Math.max(0.0001, Math.hypot(m[0], m[1], m[2]));
        for (let i = 0; i < 9; i++) normal[i] *= inv;

        gl.useProgram(solidP.prog);
        gl.uniformMatrix4fv(solidP.uni.uProj, false, proj);
        gl.uniformMatrix4fv(solidP.uni.uView, false, view);
        gl.uniformMatrix4fv(solidP.uni.uModel, false, model);
        gl.uniformMatrix3fv(solidP.uni.uNormal, false, normal);
        gl.uniform3fv(solidP.uni.uEye, eye);
        gl.uniform3fv(solidP.uni.uSun, sun);
        gl.uniform3fv(solidP.uni.uTint, tint || [1, 1, 1]);
        gl.uniform3fv(solidP.uni.uFog, fog.colour);
        gl.uniform1f(solidP.uni.uFogNear, fog.near);
        gl.uniform1f(solidP.uni.uFogFar, fog.far);
        gl.uniform1f(solidP.uni.uEmissive, emissive);

        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
        gl.enableVertexAttribArray(solidP.attr.aPos);
        gl.vertexAttribPointer(solidP.attr.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrm);
        gl.enableVertexAttribArray(solidP.attr.aNrm);
        gl.vertexAttribPointer(solidP.attr.aNrm, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.col);
        gl.enableVertexAttribArray(solidP.attr.aCol);
        gl.vertexAttribPointer(solidP.attr.aCol, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.idx);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
        return api;
      },

      /** Queue a glow: a muzzle flash, a splash, spray off the bow. */
      sprite(x, y, z, size, r, g, b) {
        quadSprite(x, y, z, size, r, g, b);
        return api;
      },

      /** Flush the sprite queue in one additive draw call. */
      flushSprites() {
        if (!spriteVerts) return api;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.useProgram(spriteP.prog);
        gl.uniformMatrix4fv(spriteP.uni.uProj, false, proj);
        gl.uniformMatrix4fv(spriteP.uni.uView, false, view);
        gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
        gl.bufferData(gl.ARRAY_BUFFER, spriteData.subarray(0, spriteVerts * 10), gl.DYNAMIC_DRAW);
        const stride = 40;
        gl.enableVertexAttribArray(spriteP.attr.aCorner);
        gl.vertexAttribPointer(spriteP.attr.aCorner, 2, gl.FLOAT, false, stride, 0);
        gl.enableVertexAttribArray(spriteP.attr.aSize);
        gl.vertexAttribPointer(spriteP.attr.aSize, 2, gl.FLOAT, false, stride, 8);
        gl.enableVertexAttribArray(spriteP.attr.aCenter);
        gl.vertexAttribPointer(spriteP.attr.aCenter, 3, gl.FLOAT, false, stride, 16);
        gl.enableVertexAttribArray(spriteP.attr.aColor);
        gl.vertexAttribPointer(spriteP.attr.aColor, 3, gl.FLOAT, false, stride, 28);
        gl.drawArrays(gl.TRIANGLES, 0, spriteVerts);
        spriteVerts = 0;
        gl.depthMask(true);
        gl.disable(gl.BLEND);
        return api;
      },

      /** World → screen in CSS pixels, for the 2D overlay. `null` behind you. */
      project(x, y, z, w, h) {
        const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
        const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
        const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
        const cz = -vz;
        if (cz <= 0.05) return null;
        const ndcX = (proj[0] * vx) / cz;
        const ndcY = (proj[5] * vy) / cz;
        return {
          x: (ndcX * 0.5 + 0.5) * w,
          y: (1 - (ndcY * 0.5 + 0.5)) * h,
          depth: cz,
          onScreen: ndcX > -1.06 && ndcX < 1.06 && ndcY > -1.06 && ndcY < 1.06,
        };
      },

      get eye() { return eye.slice(); },
      get viewMatrix() { return view; },
    };

    function horizonOf() {
      const sea = fog.colour;
      return [sea[0] + 0.10, sea[1] + 0.13, sea[2] + 0.14];
    }

    return api;
  }

  // The geometry builders are exported too: a test can measure a hull without a
  // GPU, and the offline rasteriser in the repo's notes uses the same meshes the
  // renderer uploads, so a picture of the game is a picture of the game.
  root.Sea3D = { create, builder, shipMesh, jetMesh, islandMesh, compose };
}(typeof window !== 'undefined' ? window : globalThis));
