/* STAR 3D — the ship, the sector and the fight, in real 3D.
 *
 * No dependencies, no loaders, no modules. The game runs in a sandboxed iframe
 * with an opaque origin, where an ES module fetch is cross-origin and fails, so
 * this is a classic script that hangs everything off `window.StarGL`.
 *
 * The geometry is the model in `art/ship-mesh.js`, baked by `npm run bake` from
 * `model.fbx` into 16 bytes a vertex:
 *
 *     position  3 × int16   (the hull normalised into a unit sphere)
 *     normal    3 × int8    (computed from the decimated faces)
 *     albedo    3 × uint8   (the model's own base-colour map, sampled per vertex)
 *     roughness 1 × uint8   (from the model's roughness map)
 *
 * The lighting is deliberately the same maths the sprite atlas was baked with —
 * one key light, one fill, a roughness-driven Blinn-Phong highlight, a rim and
 * a soft roll-off — so the 3D ships and the 2D fallback sprites look like the
 * same ship from the same shipyard.
 *
 * Everything here is optional by design: if WebGL is missing, slow, or the mesh
 * has not landed yet, `create()` returns null and the game keeps its canvas-2D
 * renderer. Nothing in this file can stop a frame from being drawn.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ maths
   * Column-major 4×4 matrices, the layout WebGL already wants, so there is no
   * transpose anywhere in the hot path.
   */
  const m4 = () => new Float32Array(16);

  function perspective(out, fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    out.fill(0);
    out[0] = f / aspect;
    out[5] = f;
    out[10] = (far + near) * nf;
    out[11] = -1;
    out[14] = 2 * far * near * nf;
    return out;
  }

  function lookAt(out, eye, at, up) {
    let zx = eye[0] - at[0], zy = eye[1] - at[1], zz = eye[2] - at[2];
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;
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
   * A ship's model matrix and normal matrix from a heading, a bank and a pitch.
   * The hull is authored nose-along +X, so `yaw` is *minus* the game's `facing`
   * (which is measured in the XZ plane). R = Ry · Rx · Rz, written out by hand
   * because this runs nine times a frame.
   */
  function pose(model, norm, p, yaw, pitch, roll, scale) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const r00 = cy * cr + sy * sp * sr;
    const r01 = -cy * sr + sy * sp * cr;
    const r02 = sy * cp;
    const r10 = cp * sr;
    const r11 = cp * cr;
    const r12 = -sp;
    const r20 = -sy * cr + cy * sp * sr;
    const r21 = sy * sr + cy * sp * cr;
    const r22 = cy * cp;
    model[0] = r00 * scale; model[1] = r10 * scale; model[2] = r20 * scale; model[3] = 0;
    model[4] = r01 * scale; model[5] = r11 * scale; model[6] = r21 * scale; model[7] = 0;
    model[8] = r02 * scale; model[9] = r12 * scale; model[10] = r22 * scale; model[11] = 0;
    model[12] = p[0]; model[13] = p[1]; model[14] = p[2]; model[15] = 1;
    norm[0] = r00; norm[1] = r10; norm[2] = r20;
    norm[3] = r01; norm[4] = r11; norm[5] = r21;
    norm[6] = r02; norm[7] = r12; norm[8] = r22;
    return model;
  }

  /* --------------------------------------------------------------- shaders */
  const V_SHIP = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec4 aAlb;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNorm;
varying vec3 vN;
varying vec3 vWorld;
varying vec4 vAlb;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vN = uNorm * aNrm;
  vAlb = aAlb;
  gl_Position = uProj * uView * world;
}`;

  const F_SHIP = `
precision mediump float;
varying vec3 vN;
varying vec3 vWorld;
varying vec4 vAlb;
uniform vec3 uTint;
uniform vec3 uGlow;
uniform vec3 uCam;
uniform float uExposure;
uniform float uDamage;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCam - vWorld);
  if (!gl_FrontFacing) N = -N;
  vec3 L1 = normalize(vec3(0.45, 0.82, 0.38));
  vec3 L2 = normalize(vec3(-0.68, 0.24, -0.55));
  float d1 = max(dot(N, L1), 0.0);
  float d2 = max(dot(N, L2), 0.0);
  float rough = clamp(vAlb.a, 0.04, 1.0);
  float shin = 8.0 + (1.0 - rough) * 46.0;
  vec3 H = normalize(L1 + V);
  float spec = pow(max(dot(N, H), 0.0), shin) * (0.10 + (1.0 - rough) * 0.42);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 2.8);
  vec3 albedo = pow(vAlb.rgb, vec3(2.2)) * uTint;
  float lambert = pow(d1, 0.85) * 0.95 + d2 * 0.22 + 0.20;
  vec3 col = albedo * lambert * uExposure;
  col += vec3(1.0, 0.98, 0.94) * spec;
  col += uGlow * rim * 0.62;
  col = mix(col, vec3(1.0, 0.34, 0.16) * (0.45 + rim), uDamage * 0.45);
  col = pow(max(col, vec3(0.0)), vec3(0.4545));
  col = col / (1.0 + col * 0.28);
  gl_FragColor = vec4(col, 1.0);
}`;

  const V_SOLID = `
attribute vec3 aPos;
attribute vec3 aNrm;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uModel;
uniform mat3 uNorm;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec4 world = uModel * vec4(aPos, 1.0);
  vWorld = world.xyz;
  vN = uNorm * aNrm;
  gl_Position = uProj * uView * world;
}`;

  const F_SOLID = `
precision mediump float;
varying vec3 vN;
varying vec3 vWorld;
uniform vec3 uColor;
uniform vec3 uGlow;
uniform float uEmissive;
void main() {
  vec3 N = normalize(vN);
  vec3 L1 = normalize(vec3(0.45, 0.82, 0.38));
  float d1 = max(dot(N, L1), 0.0);
  vec3 L = normalize(vec3(0.45, 0.82, 0.38));
  vec3 col = uColor * (0.12 + d1 * 0.9);
  // a fat, cheap highlight so a planet reads as a sphere and not a disc
  float fres = pow(1.0 - max(dot(N, normalize(L)), 0.0), 2.0);
  col += uGlow * fres * 0.35 * uEmissive;
  col = pow(max(col, vec3(0.0)), vec3(0.4545));
  gl_FragColor = vec4(col, 1.0);
}`;

  const V_SPRITE = `
attribute vec2 aCorner;
attribute vec2 aOffset;
attribute vec3 aCenter;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
varying vec2 vCorner;
varying vec3 vColor;
void main() {
  vec4 c = uView * vec4(aCenter, 1.0);
  c.xy += aOffset;
  vCorner = aCorner;
  vColor = aColor;
  gl_Position = uProj * c;
}`;

  const F_SPRITE = `
precision mediump float;
varying vec2 vCorner;
varying vec3 vColor;
void main() {
  float d = length(vCorner);
  float a = smoothstep(1.0, 0.25, d);
  gl_FragColor = vec4(vColor * a, 1.0);
}`;

  const V_LINE = `
attribute vec3 aPos;
attribute vec3 aColor;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

  const F_LINE = `precision mediump float;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

  /* -------------------------------------------------------------- primitives
   * Everything that is not a ship: planets, a starbase, drums, derelicts.
   */
  function sphere(seg = 18, ring = 12) {
    const pos = [];
    const nrm = [];
    for (let y = 0; y <= ring; y++) {
      const v = y / ring;
      const phi = v * Math.PI;
      for (let x = 0; x <= seg; x++) {
        const u = x / seg;
        const theta = u * Math.PI * 2;
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        pos.push(nx, ny, nz);
        nrm.push(nx, ny, nz);
      }
    }
    const idx = [];
    for (let y = 0; y < ring; y++) {
      for (let x = 0; x < seg; x++) {
        const a = y * (seg + 1) + x;
        const b = a + seg + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
  }

  function box() {
    // six quads, flat normals, unit cube
    const faces = [
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
    ];
    const pos = [];
    const nrm = [];
    const idx = [];
    faces.forEach(([n, a, b], f) => {
      const cx = n[0] * 0.5, cy = n[1] * 0.5, cz = n[2] * 0.5;
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      corners.forEach(([u, v]) => {
        pos.push(cx + a[0] * u * 0.5 + b[0] * v * 0.5,
          cy + a[1] * u * 0.5 + b[1] * v * 0.5,
          cz + a[2] * u * 0.5 + b[2] * v * 0.5);
        nrm.push(n[0], n[1], n[2]);
      });
      const base = f * 4;
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
  }

  function cylinder(seg = 16) {
    const pos = [];
    const nrm = [];
    const idx = [];
    const top = [];
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const x = Math.cos(t), z = Math.sin(t);
      pos.push(x, -0.5, z, x, 0.5, z);
      nrm.push(x, 0, z, x, 0, z);
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    // caps: a fan each, so a drum is not a hollow tube
    for (const side of [-0.5, 0.5]) {
      const centre = pos.length / 3;
      pos.push(0, side, 0);
      nrm.push(0, side > 0 ? 1 : -1, 0);
      for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * Math.PI * 2;
        pos.push(Math.cos(t), side, Math.sin(t));
        nrm.push(0, side > 0 ? 1 : -1, 0);
      }
      for (let i = 0; i < seg; i++) {
        const a = centre + 1 + i;
        if (side > 0) idx.push(centre, a, a + 1);
        else idx.push(centre, a + 1, a);
      }
    }
    void top;
    return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
  }

  /* ----------------------------------------------------------------- decode */
  function b64(str) {
    try {
      const bin = root.atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }

  /* --------------------------------------------------------------- renderer */
  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`shader: ${log}`);
    }
    return shader;
  }

  function program(gl, vs, fs, attributes) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    }
    const info = { prog, attr: {}, uni: {} };
    for (const name of attributes) info.attr[name] = gl.getAttribLocation(prog, name);
    const uniforms = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < uniforms; i++) {
      const u = gl.getActiveUniform(prog, i);
      if (u) info.uni[u.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, u.name);
    }
    return info;
  }

  /**
   * Builds a renderer on a canvas. Returns null — never throws — when there is
   * no WebGL, the shaders do not compile, or the mesh has not landed. The
   * caller then keeps its 2D renderer, which is exactly the point.
   */
  function create(canvas, { mesh = null } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false, antialias: true, depth: true, powerPreference: 'high-performance',
      }) || canvas.getContext('experimental-webgl');
    } catch { gl = null; }
    if (!gl || typeof gl.createShader !== 'function') return null;

    let ship = null;
    let solid = null;
    let sprite = null;
    let line = null;
    try {
      ship = program(gl, V_SHIP, F_SHIP, ['aPos', 'aNrm', 'aAlb']);
      solid = program(gl, V_SOLID, F_SOLID, ['aPos', 'aNrm']);
      sprite = program(gl, V_SPRITE, F_SPRITE, ['aCorner', 'aOffset', 'aCenter', 'aColor']);
      line = program(gl, V_LINE, F_LINE, ['aPos', 'aColor']);
    } catch (err) {
      try { console.warn('star battle: WebGL shaders failed —', err && err.message); } catch { /* quiet */ }
      return null;
    }

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);            // the model's winding is not guaranteed
    gl.clearColor(0.008, 0.016, 0.031, 1);

    const proj = m4();
    const view = m4();
    const model = m4();
    const norm = new Float32Array(9);
    const eye = [0, 0, 0];
    const at = [0, 0, 0];
    const up = [0, 1, 0];
    const state = { w: 1, h: 1, dpr: 1, near: 2, far: 12000, fov: (58 * Math.PI) / 180 };

    /* ---------------------------------------------------------- buffers */
    function buffer(data, target = gl.ARRAY_BUFFER, usage = gl.STATIC_DRAW) {
      const buf = gl.createBuffer();
      gl.bindBuffer(target, buf);
      gl.bufferData(target, data, usage);
      return buf;
    }

    /** Upload a ship mesh: interleaved, quantised, 16 bytes a vertex. */
    function uploadShip(data, hdr) {
      if (!data) return null;
      const v = b64(data.v);
      const i = b64(data.i);
      if (!v || !i) return null;
      const stride = hdr.stride || 16;
      return {
        verts: hdr.verts || v.byteLength / stride,
        tris: hdr.tris || i.byteLength / 6,
        vbo: buffer(v),
        ibo: buffer(i, gl.ELEMENT_ARRAY_BUFFER),
      };
    }

    function uploadSolid(geo) {
      return {
        pos: buffer(geo.pos),
        nrm: buffer(geo.nrm),
        idx: buffer(geo.idx, gl.ELEMENT_ARRAY_BUFFER),
        count: geo.idx.length,
      };
    }

    const geo = { sphere: uploadSolid(sphere()), box: uploadSolid(box()), drum: uploadSolid(cylinder()) };

    /* --------------------------------------------------- static star shell */
    // 520 stars and a handful of nebula smudges on a 4000-unit shell around the
    // sector. They do not move with the player, so they never need re-uploading
    // — and because the camera does move, they still parallax like real sky.
    const STAR_STRIDE = 10;
    const starVerts = [];
    {
      const rand = (() => {
        let a = 20261101;
        return () => {
          a = (a * 1103515245 + 12345) & 0x7fffffff;
          return a / 0x7fffffff;
        };
      })();
      const push = (x, y, z, size, r, g, b) => {
        const corner = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
        for (const [cx, cy] of corner) {
          starVerts.push(cx, cy, cx * size, cy * size, x, y, z, r, g, b);
        }
      };
      for (let n = 0; n < 520; n++) {
        const theta = rand() * Math.PI * 2;
        const phi = Math.acos(2 * rand() - 1);
        const r = 3600 + rand() * 900;
        const x = Math.sin(phi) * Math.cos(theta) * r;
        const y = Math.cos(phi) * r * 0.75;
        const z = Math.sin(phi) * Math.sin(theta) * r;
        const bright = 0.12 + Math.pow(rand(), 2.4) * 0.85;
        const warm = rand();
        push(x, y, z, 1.4 + rand() * 2.6, bright, bright * (0.94 + warm * 0.06), bright * (0.9 + warm * 0.1));
      }
      for (let n = 0; n < 9; n++) {
        const theta = rand() * Math.PI * 2;
        const r = 2900 + rand() * 700;
        const x = Math.cos(theta) * r;
        const z = Math.sin(theta) * r;
        const y = (rand() - 0.5) * 900;
        const size = 420 + rand() * 620;
        const tint = rand();
        const col = tint > 0.6 ? [0.05, 0.03, 0.09] : tint > 0.3 ? [0.02, 0.06, 0.10] : [0.05, 0.02, 0.04];
        const corner = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
        for (const [cx, cy] of corner) {
          starVerts.push(cx, cy, cx * size, cy * size, x, y, z, col[0], col[1], col[2]);
        }
      }
    }
    const starBuf = buffer(new Float32Array(starVerts));
    const starCount = starVerts.length / STAR_STRIDE;

    /* --------------------------------------------------- dynamic effects */
    let fxData = new Float32Array(0);
    let fxVerts = 0;
    let fxBuf = buffer(new Float32Array(16), gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW);
    const FX_CAP = 1600;                  // sprites; past this the extras drop
    /** One batch vertex: `corner` is a unit quad corner, `offset` is it in world. */
    const pushVertex = (cx, cy, ox, oy, x, y, z, r, g, b) => {
      if (fxVerts + 1 > FX_CAP) return;
      if (fxVerts * STAR_STRIDE + STAR_STRIDE > fxData.length) return;
      const o = fxVerts * STAR_STRIDE;
      fxData[o] = cx; fxData[o + 1] = cy;
      fxData[o + 2] = ox; fxData[o + 3] = oy;
      fxData[o + 4] = x; fxData[o + 5] = y; fxData[o + 6] = z;
      fxData[o + 7] = r; fxData[o + 8] = g; fxData[o + 9] = b;
      fxVerts += 1;
    };
    const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];

    /** A soft round blob: two triangles whose corners carry the falloff. */
    const pushSprite = (x, y, z, size, r, g, b) => {
      if (fxVerts + 6 > FX_CAP) return;
      for (const [cx, cy] of CORNERS) {
        pushVertex(cx, cy, cx * size, cy * size, x, y, z, r, g, b);
      }
    };

    /** A built triangle pair: the corners are already world positions. */
    const pushTriangleStrip = (points, r, g, b) => {
      for (const p of points) pushVertex(0, 0, 0, 0, p[0], p[1], p[2], r, g, b);
    };
    fxData = new Float32Array(FX_CAP * STAR_STRIDE * 6);
    fxNull();

    function fxNull() { fxVerts = 0; }

    /* ----------------------------------------------------------- the grid */
    const gridVerts = [];
    {
      const pushLine = (ax, ay, az, bx, by, bz, r, g, b) => {
        gridVerts.push(ax, ay, az, r, g, b, bx, by, bz, r, g, b);
      };
      const R = 2400;
      const step = 300;
      for (let x = -R; x <= R; x += step) {
        pushLine(x, 0, -R, x, 0, R, 0.05, 0.11, 0.17);
      }
      for (let z = -R; z <= R; z += step) {
        pushLine(-R, 0, z, R, 0, z, 0.05, 0.11, 0.17);
      }
      // the boundary: a bright ring you can see coming, and a tick fence
      const seg = 120;
      for (let i = 0; i < seg; i++) {
        const a0 = (i / seg) * Math.PI * 2;
        const a1 = ((i + 1) / seg) * Math.PI * 2;
        const dim = i % 5 === 0 ? [0.30, 0.52, 0.62] : [0.12, 0.24, 0.30];
        pushLine(Math.cos(a0) * R, 0, Math.sin(a0) * R, Math.cos(a1) * R, 0, Math.sin(a1) * R, dim[0], dim[1], dim[2]);
        if (i % 5 === 0) {
          pushLine(Math.cos(a0) * R, 0, Math.sin(a0) * R,
            Math.cos(a0) * R, 150, Math.sin(a0) * R, 0.12, 0.26, 0.32);
        }
      }
    }
    const gridBuf = buffer(new Float32Array(gridVerts));
    const gridCount = gridVerts.length / 6;

    let meshBuf = null;
    if (mesh && mesh.v && mesh.i) meshBuf = uploadShip(mesh, mesh);

    const api = {
      ok: true,
      mode: 'webgl',
      /** Attach the baked hull after the fact — the mesh script is deferred. */
      setMesh(data) {
        if (!data || !data.v || !data.i) return false;
        meshBuf = uploadShip(data, data);
        return Boolean(meshBuf);
      },
      get mesh() { return meshBuf; },
      get tris() { return meshBuf ? meshBuf.tris : 0; },
      /**
       * Everything the renderer needs about the world, in one call. The game
       * builds this description; nothing here touches the simulation.
       */
      begin(w, h, dpr) {
        const cw = Math.max(1, Math.round(w * dpr));
        const ch = Math.max(1, Math.round(h * dpr));
        if (canvas.width !== cw || canvas.height !== ch) {
          canvas.width = cw;
          canvas.height = ch;
        }
        state.w = cw; state.h = ch; state.dpr = dpr;
        gl.viewport(0, 0, cw, ch);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        perspective(proj, state.fov, cw / Math.max(1, ch), state.near, state.far);
        fxNull();
      },

      /** Places the camera: eye, look-at point, optional up vector and fov. */
      camera(ex, ey, ez, ax, ay, az, fovDeg = 58) {
        eye[0] = ex; eye[1] = ey; eye[2] = ez;
        at[0] = ax; at[1] = ay; at[2] = az;
        state.fov = (fovDeg * Math.PI) / 180;
        perspective(proj, state.fov, state.w / Math.max(1, state.h), state.near, state.far);
        lookAt(view, eye, at, up);
      },

      /** The sky and the sector grid — drawn first, behind everything. */
      sky() {
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(sprite.prog);
        gl.uniformMatrix4fv(sprite.uni.uProj, false, proj);
        gl.uniformMatrix4fv(sprite.uni.uView, false, view);
        gl.bindBuffer(gl.ARRAY_BUFFER, starBuf);
        bindSpriteAttribs(sprite, STAR_STRIDE * 4);
        gl.drawArrays(gl.TRIANGLES, 0, starCount);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
      },

      grid() {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(false);
        gl.useProgram(line.prog);
        gl.uniformMatrix4fv(line.uni.uProj, false, proj);
        gl.uniformMatrix4fv(line.uni.uView, false, view);
        gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
        gl.enableVertexAttribArray(line.attr.aPos);
        gl.vertexAttribPointer(line.attr.aPos, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(line.attr.aColor);
        gl.vertexAttribPointer(line.attr.aColor, 3, gl.FLOAT, false, 24, 12);
        gl.drawArrays(gl.LINES, 0, gridCount);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      },

      /**
       * One body: a planet, a drum, a derelict, a starbase module. `shape` is
       * 'sphere' | 'box' | 'drum'.
       */
      body(shape, x, y, z, size, rotY, rgb, glow = rgb, emissive = 0.4, squash = 1) {
        const g = geo[shape] || geo.sphere;
        gl.useProgram(solid.prog);
        pose(model, norm, [x, y, z], rotY, 0, 0, 1);
        // a body can be an ellipsoid: scale each axis, then fix the normals up
        model[0] *= size; model[1] *= size; model[2] *= size;
        model[4] *= size * squash; model[5] *= size * squash; model[6] *= size * squash;
        model[8] *= size; model[9] *= size; model[10] *= size;
        gl.uniformMatrix4fv(solid.uni.uProj, false, proj);
        gl.uniformMatrix4fv(solid.uni.uView, false, view);
        gl.uniformMatrix4fv(solid.uni.uModel, false, model);
        gl.uniformMatrix3fv(solid.uni.uNorm, false, norm);
        gl.uniform3f(solid.uni.uColor, rgb[0], rgb[1], rgb[2]);
        gl.uniform3f(solid.uni.uGlow, glow[0], glow[1], glow[2]);
        gl.uniform1f(solid.uni.uEmissive, emissive);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.pos);
        gl.enableVertexAttribArray(solid.attr.aPos);
        gl.vertexAttribPointer(solid.attr.aPos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, g.nrm);
        gl.enableVertexAttribArray(solid.attr.aNrm);
        gl.vertexAttribPointer(solid.attr.aNrm, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, g.idx);
        gl.drawElements(gl.TRIANGLES, g.count, gl.UNSIGNED_SHORT, 0);
      },

      /**
       * One ship, textured from its own bake, tinted for its livery.
       * `yaw` is the game's `facing` (positive = clockwise on the map).
       */
      ship(x, y, z, facing, size, tint, glow, { roll = 0, pitch = 0, damage = 0, exposure = 3.1 } = {}) {
        if (!meshBuf) return false;
        gl.useProgram(ship.prog);
        pose(model, norm, [x, y, z], -facing, pitch, roll, size);
        gl.uniformMatrix4fv(ship.uni.uProj, false, proj);
        gl.uniformMatrix4fv(ship.uni.uView, false, view);
        gl.uniformMatrix4fv(ship.uni.uModel, false, model);
        gl.uniformMatrix3fv(ship.uni.uNorm, false, norm);
        gl.uniform3f(ship.uni.uTint, tint[0], tint[1], tint[2]);
        gl.uniform3f(ship.uni.uGlow, glow[0], glow[1], glow[2]);
        gl.uniform3f(ship.uni.uCam, eye[0], eye[1], eye[2]);
        gl.uniform1f(ship.uni.uExposure, exposure);
        gl.uniform1f(ship.uni.uDamage, damage);
        gl.bindBuffer(gl.ARRAY_BUFFER, meshBuf.vbo);
        gl.enableVertexAttribArray(ship.attr.aPos);
        gl.vertexAttribPointer(ship.attr.aPos, 3, gl.SHORT, true, 16, 0);
        gl.enableVertexAttribArray(ship.attr.aNrm);
        gl.vertexAttribPointer(ship.attr.aNrm, 3, gl.BYTE, true, 16, 6);
        gl.enableVertexAttribArray(ship.attr.aAlb);
        gl.vertexAttribPointer(ship.attr.aAlb, 4, gl.UNSIGNED_BYTE, true, 16, 10);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, meshBuf.ibo);
        gl.drawElements(gl.TRIANGLES, meshBuf.tris * 3, gl.UNSIGNED_SHORT, 0);
        return true;
      },

      /** Queues a soft additive blob: spark, star, engine glow, torpedo. */
      sprite(x, y, z, size, r, g, b) {
        pushSprite(x, y, z, size, r, g, b);
      },

      /** Queues a beam: a quad stretched between two world points. */
      beam(a, b, width, rgb, intensity = 1) {
        let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const len = Math.hypot(dx, dy, dz) || 1;
        dx /= len; dy /= len; dz /= len;
        // thickness is the axis most perpendicular to both the beam and the eye
        let px = eye[0] - a[0], py = eye[1] - a[1], pz = eye[2] - a[2];
        let cx = dy * pz - dz * py;
        let cy = dz * px - dx * pz;
        let cz = dx * py - dy * px;
        const cl = Math.hypot(cx, cy, cz) || 1;
        cx /= cl; cy /= cl; cz /= cl;
        const w = width;
        const quad = [
          [a[0] + cx * w, a[1] + cy * w, a[2] + cz * w],
          [b[0] + cx * w, b[1] + cy * w, b[2] + cz * w],
          [b[0] - cx * w, b[1] - cy * w, b[2] - cz * w],
          [a[0] + cx * w, a[1] + cy * w, a[2] + cz * w],
          [b[0] - cx * w, b[1] - cy * w, b[2] - cz * w],
          [a[0] - cx * w, a[1] - cy * w, a[2] - cz * w],
        ];
        pushTriangleStrip(quad, rgb[0] * intensity, rgb[1] * intensity, rgb[2] * intensity);
      },

      /** Flushes every queued sprite in one additive draw call. */
      sprites() {
        if (!fxVerts) return;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.depthMask(false);
        gl.useProgram(sprite.prog);
        gl.uniformMatrix4fv(sprite.uni.uProj, false, proj);
        gl.uniformMatrix4fv(sprite.uni.uView, false, view);
        gl.bindBuffer(gl.ARRAY_BUFFER, fxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, fxData.subarray(0, fxVerts * STAR_STRIDE), gl.DYNAMIC_DRAW);
        bindSpriteAttribs(sprite, STAR_STRIDE * 4);
        gl.drawArrays(gl.TRIANGLES, 0, fxVerts);
        fxNull();                      // flushed: the next frame starts empty
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      },

      /**
       * World → screen, in CSS pixels, for the 2D overlay (target markers,
       * the reticle, the off-screen arrows). `null` when it is behind you.
       */
      project(x, y, z, w, h) {
        const vx = view[0] * x + view[4] * y + view[8] * z + view[12];
        const vy = view[1] * x + view[5] * y + view[9] * z + view[13];
        const vz = view[2] * x + view[6] * y + view[10] * z + view[14];
        // clip: projection puts -z into the depth range
        const cz = -(vz);
        if (cz <= 0.001) return null;
        const cx = proj[0] * vx;
        const cy = proj[5] * vy;
        const cw = cz;
        const ndcX = cx / cw;
        const ndcY = cy / cw;
        return {
          x: (ndcX * 0.5 + 0.5) * w,
          y: (1 - (ndcY * 0.5 + 0.5)) * h,
          depth: cz,
          onScreen: ndcX > -1.05 && ndcX < 1.05 && ndcY > -1.05 && ndcY < 1.05,
        };
      },

      /** The screen-space length of a world-space offset — for HUD scaling. */
      scaleAt(x, y, z, w, h) {
        const a = api.project(x, y, z, w, h);
        const b = api.project(x, y, z + 1, w, h);
        if (!a || !b) return 0;
        return Math.hypot(a.x - b.x, a.y - b.y);
      },

      get showMesh() { return Boolean(meshBuf); },
    };

    function bindSpriteAttribs(prog, stride) {
      gl.enableVertexAttribArray(prog.attr.aCorner);
      gl.vertexAttribPointer(prog.attr.aCorner, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(prog.attr.aOffset);
      gl.vertexAttribPointer(prog.attr.aOffset, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(prog.attr.aCenter);
      gl.vertexAttribPointer(prog.attr.aCenter, 3, gl.FLOAT, false, stride, 16);
      gl.enableVertexAttribArray(prog.attr.aColor);
      gl.vertexAttribPointer(prog.attr.aColor, 3, gl.FLOAT, false, stride, 28);
    }

    return api;
  }

  root.StarGL = { create, sphere, box, cylinder };
}(typeof window !== 'undefined' ? window : globalThis));
