/**
 * BAKE THE SHIP — model.fbx → turntable sprite atlases.
 *
 * Star Battle runs in a sandboxed iframe on a phone, so it cannot afford a
 * 6.7 MB FBX, an FBX parser, or a WebGL pipeline it has no way to verify. What
 * it can afford is a handful of pre-lit PNGs: this script turns the model into
 * 32 headings × 3 liveries × 2 resolutions, once, at build time.
 *
 *   node scripts/bake-ship.mjs            # writes games/star-battle/art/*.png
 *
 * How it works:
 *   1. `three`'s FBXLoader reads the model (a devDependency only — nothing in
 *      the browser ever sees it), and the world matrix is baked into the mesh.
 *   2. Vertex clustering decimates 149k triangles to a budget, then normals are
 *      recomputed from the faces (so clustering does not leave them flat).
 *   3. A small software rasteriser draws each heading with a z-buffer, 2× super
 *      sampling, a procedural panel texture sampled through the model's own UVs,
 *      two lights, a specular highlight and a fresnel rim — the "rendering".
 *   4. PNGs are encoded here (zlib + CRC), no image library.
 *
 * The output is what the game draws: crisp at any heading, additive engine
 * glows added live at runtime. Re-run this only when the model changes.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

/* ------------------------------------------------------------- the textures
 * The .fbx points at a `model.fbm/` folder that is not in the repository; the
 * textures ship inside `starship+3d+model.zip` instead. So this reads the zip
 * directly (ZIP is just headers + deflate — no library needed) and hands the
 * JPEGs to jpeg-js, which is a devDependency: the bake uses it, the game never
 * sees it.
 */
function readZip(pathToZip) {
  const buf = readFileSync(pathToZip);
  // End of Central Directory: scan back for its signature
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip: no end-of-central-directory');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let e = 0; e < count; e++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return {
    names: [...entries.keys()],
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      const at = entry.localOffset;
      const nameLen = buf.readUInt16LE(at + 26);
      const extraLen = buf.readUInt16LE(at + 28);
      const start = at + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + entry.compSize);
      if (entry.method === 0) return Buffer.from(raw);
      if (entry.method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`unsupported zip method ${entry.method} for ${name}`);
    },
  };
}

/** Decodes a JPEG into { w, h, data } RGBA. Missing dependency → null. */
async function decodeJpeg(buffer) {
  try {
    const jpeg = (await import('jpeg-js')).default;
    const img = jpeg.decode(buffer, { useTArray: true });
    return { w: img.width, h: img.height, data: img.data };
  } catch {
    return null;
  }
}

/** Bilinear sample, clamped, returning 0…1 RGBA. */
function sample(img, u, v) {
  const x = Math.min(img.w - 1, Math.max(0, (u - Math.floor(u)) * img.w));
  const y = Math.min(img.h - 1, Math.max(0, (1 - (v - Math.floor(v))) * img.h));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const at = (xx, yy) => (yy * img.w + xx) * 4;
  const out = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const a = img.data[at(x0, y0) + k], b = img.data[at(x1, y0) + k];
    const c = img.data[at(x0, y1) + k], d = img.data[at(x1, y1) + k];
    out[k] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  return out.map((n) => n / 255);
}

/** Box-downsample an image by an integer factor — a poor man's mip level. */
function prefilter(img, factor) {
  if (!img || factor <= 1) return img;
  const w = Math.floor(img.w / factor);
  const h = Math.floor(img.h / factor);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < factor; sy++) {
        for (let sx = 0; sx < factor; sx++) {
          const o = (((y * factor + sy) * img.w) + (x * factor + sx)) * 4;
          for (let k = 0; k < 4; k++) acc[k] += img.data[o + k];
        }
      }
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) data[o + k] = acc[k] / (factor * factor);
    }
  }
  return { w, h, data };
}

/** sRGB → linear, so the lighting maths is not done in gamma space. */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

async function loadTextures() {
  const zipPath = path.join(root, 'starship+3d+model.zip');
  const empty = { albedo: null, roughness: null, source: 'procedural' };
  let zip;
  try { zip = readZip(zipPath); } catch { return empty; }
  const pick = (suffix) => zip.names.find((n) => new RegExp(`${suffix}\\.jpe?g$`, 'i').test(n));
  const albedoName = pick('basecolor');
  const roughName = pick('roughness');
  // 1024² of UV atlas squeezed into a 160 px sprite is aliasing, not detail:
  // prefilter to a quarter size and let bilinear do the rest.
  const albedo = prefilter(albedoName ? await decodeJpeg(zip.read(albedoName)) : null, 8);
  const roughness = prefilter(roughName ? await decodeJpeg(zip.read(roughName)) : null, 8);
  return { albedo, roughness, source: albedo ? 'model textures (basecolor + roughness)' : 'procedural' };
}

/* ------------------------------------------------------------------ model */
async function loadMesh(fbxPath) {
  // FBXLoader touches `document` for the texture images the model references.
  // We only want geometry, so a silent stub is enough.
  if (!globalThis.document) {
    const stub = () => ({
      addEventListener() {}, removeEventListener() {},
      width: 1, height: 1, style: {},
      set src(v) { this._src = v; }, get src() { return this._src || ''; },
      getContext: () => null,
    });
    globalThis.document = { createElementNS: stub, createElement: stub };
  }
  const THREE = await import('three');
  const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
  const buf = readFileSync(fbxPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const scene = new FBXLoader().parse(ab, '');
  scene.updateMatrixWorld(true);

  let source = null;
  scene.traverse((o) => { if (o.isMesh && !source) source = o; });
  if (!source) throw new Error('model.fbx has no mesh');

  const g = source.geometry;
  const pos = g.attributes.position;
  const uvAttr = g.attributes.uv;
  const index = g.index;
  const triCount = (index ? index.count : pos.count) / 3;

  const P = new Float32Array(pos.count * 3);
  const UV = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(source.matrixWorld);
    P[i * 3] = v.x; P[i * 3 + 1] = v.y; P[i * 3 + 2] = v.z;
    UV[i * 2] = uvAttr ? uvAttr.getX(i) : 0;
    UV[i * 2 + 1] = uvAttr ? uvAttr.getY(i) : 0;
  }
  const I = new Uint32Array(triCount * 3);
  for (let i = 0; i < triCount * 3; i++) I[i] = index ? index.getX(i) : i;

  return { P, UV, I, verts: pos.count, tris: triCount };
}

/** Vertex clustering: one vertex per grid cell, averaged. Keeps UVs and shape. */
function decimate({ P, UV, I }, targetTris) {
  let lo = 8;
  let hi = 220;
  let best = null;
  for (let attempt = 0; attempt < 14; attempt++) {
    const grid = Math.round((lo + hi) / 2);
    const out = clusterAt({ P, UV, I }, grid);
    best = out;
    if (out.tris > targetTris * 1.12) hi = grid;
    else if (out.tris < targetTris * 0.72) lo = grid;
    else return out;
  }
  return best;
}

function clusterAt({ P, UV, I }, grid) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      bounds.min[k] = Math.min(bounds.min[k], P[i + k]);
      bounds.max[k] = Math.max(bounds.max[k], P[i + k]);
    }
  }
  const size = [0, 1, 2].map((k) => Math.max(1e-6, bounds.max[k] - bounds.min[k]));
  const cell = Math.max(...size) / grid;
  const keyOf = (i) => {
    const gx = Math.floor((P[i * 3] - bounds.min[0]) / cell);
    const gy = Math.floor((P[i * 3 + 1] - bounds.min[1]) / cell);
    const gz = Math.floor((P[i * 3 + 2] - bounds.min[2]) / cell);
    return gx + gy * 4096 + gz * 4096 * 4096;
  };
  const map = new Map();
  const remap = new Uint32Array(P.length / 3);
  const acc = [];
  for (let i = 0; i < P.length / 3; i++) {
    const key = keyOf(i);
    let slot = map.get(key);
    if (slot === undefined) {
      slot = acc.length;
      map.set(key, slot);
      acc.push({ x: 0, y: 0, z: 0, u: 0, v: 0, n: 0 });
    }
    const a = acc[slot];
    a.x += P[i * 3]; a.y += P[i * 3 + 1]; a.z += P[i * 3 + 2];
    a.u += UV[i * 2]; a.v += UV[i * 2 + 1];
    a.n += 1;
    remap[i] = slot;
  }

  const pos = new Float32Array(acc.length * 3);
  const uv = new Float32Array(acc.length * 2);
  for (let s = 0; s < acc.length; s++) {
    const a = acc[s];
    pos[s * 3] = a.x / a.n; pos[s * 3 + 1] = a.y / a.n; pos[s * 3 + 2] = a.z / a.n;
    uv[s * 2] = a.u / a.n; uv[s * 2 + 1] = a.v / a.n;
  }

  const idx = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = remap[I[t]], b = remap[I[t + 1]], c = remap[I[t + 2]];
    if (a === b || b === c || a === c) continue;      // collapsed
    idx.push(a, b, c);
  }
  const index = new Uint32Array(idx);
  return { P: pos, UV: uv, I: index, tris: index.length / 3, verts: acc.length, bounds, cell };
}

/** Area-weighted vertex normals from the (decimated) faces. */
function computeNormals({ P, I }) {
  const N = new Float32Array(P.length);
  const v0 = [0, 0, 0], v1 = [0, 0, 0], v2 = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    for (let k = 0; k < 3; k++) { v0[k] = P[a + k]; v1[k] = P[b + k]; v2[k] = P[c + k]; }
    const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
    const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const i of [a, b, c]) { N[i] += nx; N[i + 1] += ny; N[i + 2] += nz; }
  }
  for (let i = 0; i < N.length; i += 3) {
    const len = Math.hypot(N[i], N[i + 1], N[i + 2]) || 1;
    N[i] /= len; N[i + 1] /= len; N[i + 2] /= len;
  }
  return N;
}

/* ------------------------------------------------------------------ paint
 * A procedural hull texture, sampled with the model's own UVs: panels, seams,
 * rivets, warning stripes and lit windows. No image files, no downloads.
 */
const fract = (x) => x - Math.floor(x);
const hash = (x, y) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);

function hullTexture(u, v, livery) {
  const x = fract(u) * 24;
  const y = fract(v) * 24;
  const cx = Math.floor(x), cy = Math.floor(y);
  const fx = fract(x), fy = fract(y);
  const jitter = hash(cx, cy);

  // base plate colour, slightly varied per panel
  let shade = 0.86 + jitter * 0.16;
  // a few panels are darker (replaced armour / recesses)
  if (hash(cx * 3.1, cy * 7.7) > 0.82) shade *= 0.82;

  // panel seams
  const seam = 0.055;
  const lineX = Math.min(fx, 1 - fx) < seam;
  const lineY = Math.min(fy, 1 - fy) < seam;
  if (lineX || lineY) shade *= 0.72;
  // bigger seam every 6 panels
  if (cx % 6 === 0 && fx < 0.02) shade *= 0.6;
  if (cy % 6 === 0 && fy < 0.02) shade *= 0.6;

  // rivets
  const rx = fract(x * 2), ry = fract(y * 2);
  if (hash(Math.floor(x * 2), Math.floor(y * 2)) > 0.72 && Math.hypot(rx - 0.5, ry - 0.5) < 0.045) shade *= 1.12;

  // warning stripes on one band of the hull
  if (u > 0.78 && u < 0.86) shade *= (Math.floor((y + x) * 1.2) % 2) ? 0.55 : 1.25;

  const [br, bg, bb] = livery.hull;
  let r = br * shade;
  let g = bg * shade;
  let b = bb * shade;

  // accent panels
  if (hash(cx * 5.3, cy * 1.9) > 0.93) {
    r = r * 0.35 + livery.accent[0] * 0.55;
    g = g * 0.35 + livery.accent[1] * 0.55;
    b = b * 0.35 + livery.accent[2] * 0.55;
  }

  // lit windows: small bright slots inside a few panels
  let emissive = 0;
  if (jitter > 0.62 && fx > 0.28 && fx < 0.72 && fy > 0.4 && fy < 0.6 && hash(cy, cx) > 0.55) {
    emissive = 0.55 + 0.45 * hash(cx, cy);
  }
  return { r, g, b, emissive };
}

/**
 * How much lens is needed so the widest heading still fits the cell. Projected
 * extent is linear in `focal`, so one cheap pass over the vertices (no raster)
 * gives the answer for all 32 headings at once.
 */
function fitFocal(mesh, { elevation, dist, angles, margin = 0.9 }) {
  const e = elevation;
  const eye = [0, Math.sin(e) * dist, -Math.cos(e) * dist];
  const fwd = [0, -Math.sin(e), Math.cos(e)];
  const right = [1, 0, 0];
  const up = [0, Math.cos(e), Math.sin(e)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const { P, center, scale } = mesh;
  let worst = 1e-6;
  for (let a = 0; a < angles; a++) {
    const angle = (a * Math.PI * 2) / angles;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    for (let i = 0; i < P.length; i += 3) {
      const lx = (P[i] - center[0]) / scale;
      const ly = (P[i + 1] - center[1]) / scale;
      const lz = (P[i + 2] - center[2]) / scale;
      const p = [lx * cos + lz * sin, ly, -lx * sin + lz * cos];
      const rel = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
      const z = Math.max(0.05, dot(rel, fwd));
      // screen offset is (dot(p, axis) / z) * focal * (dim / 2) pixels
      worst = Math.max(worst, Math.abs(dot(p, right) / z), Math.abs(dot(p, up) / z));
    }
  }
  return margin / worst;
}

/* --------------------------------------------------------- the rasteriser */
function bakeHeading(mesh, { livery, angle, size, ssaa, elevation, focal, dist, textures }) {
  const dim = size * ssaa;
  const color = new Float32Array(dim * dim * 3);
  const weight = new Float32Array(dim * dim);        // alpha coverage
  const depth = new Float32Array(dim * dim).fill(Infinity);
  const { P, UV, N, I, center, scale } = mesh;

  // rotate the model about +Y, normalize into a unit sphere
  const cos = Math.cos(angle), sin = Math.sin(angle);
  // The export is already Y-up with the hull running along X, so heading 0 is
  // the model as authored: nose to the right, which is the game's convention
  // (`facing` 0 points along +X).
  const rot = (x, y, z) => [x * cos + z * sin, y, -x * sin + z * cos];

  const e = elevation;
  const eye = [0, Math.sin(e) * dist, -Math.cos(e) * dist];
  const fwd = [0, -Math.sin(e), Math.cos(e)];
  const right = [1, 0, 0];
  const up = [0, Math.cos(e), Math.sin(e)];      // +Y is up on the glass
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const toScreen = (p) => {
    const rel = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
    const z = Math.max(0.05, dot(rel, fwd));
    return [dim / 2 + (dot(p, right) * focal) / z * dim * 0.5,
      dim / 2 - (dot(p, up) * focal) / z * dim * 0.5, z];
  };

  const sx = new Float32Array(P.length / 3);
  const sy = new Float32Array(P.length / 3);
  const sz = new Float32Array(P.length / 3);
  const wp = new Float32Array(P.length);
  const wn = new Float32Array(P.length);
  for (let i = 0; i < P.length / 3; i++) {
    const p = rot((P[i * 3] - center[0]) / scale, (P[i * 3 + 1] - center[1]) / scale, (P[i * 3 + 2] - center[2]) / scale);
    const s = toScreen(p);
    sx[i] = s[0]; sy[i] = s[1]; sz[i] = s[2];
    wp[i * 3] = p[0]; wp[i * 3 + 1] = p[1]; wp[i * 3 + 2] = p[2];
    const n = rot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    wn[i * 3] = n[0]; wn[i * 3 + 1] = n[1]; wn[i * 3 + 2] = n[2];
  }

  if (process.env.BAKE_DEBUG) {
    const r = (arr) => [Math.min(...arr), Math.max(...arr)].map((n) => +n.toFixed(2)).join(' … ');
    console.log('screen x', r([...sx]), 'y', r([...sy]), 'z', r([...sz]), 'dim', dim);
    let inside = 0;
    for (let t = 0; t < I.length; t += 3) {
      const cx = (sx[I[t]] + sx[I[t+1]] + sx[I[t+2]]) / 3;
      const cy = (sy[I[t]] + sy[I[t+1]] + sy[I[t+2]]) / 3;
      if (cx >= 0 && cx < dim && cy >= 0 && cy < dim) inside++;
    }
    console.log('triangles with centroid on screen:', inside, '/', I.length / 3);
  }

  const L1 = [0.42, 0.78, 0.46];
  const L2 = [-0.62, 0.3, -0.42];
  const n1 = Math.hypot(...L1), n2 = Math.hypot(...L2);
  L1[0] /= n1; L1[1] /= n1; L1[2] /= n1;
  L2[0] /= n2; L2[1] /= n2; L2[2] /= n2;

  for (let t = 0; t < I.length; t += 3) {
    const ia = I[t], ib = I[t + 1], ic = I[t + 2];
    const x0 = sx[ia], y0 = sy[ia], x1 = sx[ib], y1 = sy[ib], x2 = sx[ic], y2 = sy[ic];
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(dim - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(dim - 1, Math.ceil(Math.max(y0, y1, y2)));
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const inv = 1 / area;
    const z0 = sz[ia], z1 = sz[ib], z2 = sz[ic];
    const u0 = UV[ia * 2], v0 = UV[ia * 2 + 1], u1 = UV[ib * 2], v1 = UV[ib * 2 + 1], u2 = UV[ic * 2], v2 = UV[ic * 2 + 1];
    const nx0 = wn[ia * 3], ny0 = wn[ia * 3 + 1], nz0 = wn[ia * 3 + 2];
    const nx1 = wn[ib * 3], ny1 = wn[ib * 3 + 1], nz1 = wn[ib * 3 + 2];
    const nx2 = wn[ic * 3], ny2 = wn[ic * 3 + 1], nz2 = wn[ic * 3 + 2];
    const px0 = wp[ia * 3], py0 = wp[ia * 3 + 1], pz0 = wp[ia * 3 + 2];
    const px1 = wp[ib * 3], py1 = wp[ib * 3 + 1], pz1 = wp[ib * 3 + 2];
    const px2 = wp[ic * 3], py2 = wp[ic * 3 + 1], pz2 = wp[ic * 3 + 2];

    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        let w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) * inv;
        let w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) * inv;
        let w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;

        // perspective-correct depth
        const iz = w0 / z0 + w1 / z1 + w2 / z2;
        const z = 1 / iz;
        const o = y * dim + x;
        if (z >= depth[o]) continue;
        depth[o] = z;

        // perspective-correct attributes
        const a = (w0 / z0) * z, b = (w1 / z1) * z, c = (w2 / z2) * z;
        let nx = nx0 * a + nx1 * b + nx2 * c;
        let ny = ny0 * a + ny1 * b + ny2 * c;
        let nz = nz0 * a + nz1 * b + nz2 * c;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const u = u0 * a + u1 * b + u2 * c;
        const v = v0 * a + v1 * b + v2 * c;
        const wx = px0 * a + px1 * b + px2 * c;
        const wy = py0 * a + py1 * b + py2 * c;
        const wz = pz0 * a + pz1 * b + pz2 * c;

        // view vector (towards the camera)
        let vx = eye[0] - wx, vy = eye[1] - wy, vz = eye[2] - wz;
        const vl = Math.hypot(vx, vy, vz) || 1;
        vx /= vl; vy /= vl; vz /= vl;

        const dl1 = Math.max(0, nx * L1[0] + ny * L1[1] + nz * L1[2]);
        const dl2 = Math.max(0, nx * L2[0] + ny * L2[1] + nz * L2[2]);
        const ndv = Math.max(0, nx * vx + ny * vy + nz * vz);
        const lambert = Math.pow(dl1, 0.85) * 0.95 + dl2 * 0.22 + 0.2;

        // Blinn-Phong
        let hx = L1[0] + vx, hy = L1[1] + vy, hz = L1[2] + vz;
        const hl = Math.hypot(hx, hy, hz) || 1;
        const rim = Math.pow(1 - ndv, 2.8) * 0.5;

        // albedo: the model's own base colour map when available, tinted per
        // livery; the procedural panels otherwise
        let ar, ag, ab, emissive, rough;
        if (textures.albedo) {
          const s0 = sample(textures.albedo, u, v);
          ar = toLinear(s0[0]) * livery.tint[0];
          ag = toLinear(s0[1]) * livery.tint[1];
          ab = toLinear(s0[2]) * livery.tint[2];
          rough = textures.roughness ? sample(textures.roughness, u, v)[0] : 0.45;
          emissive = 0;
          // keep a hint of the panel stress-lines the procedural map drew
          const seams = Math.min(1, Math.min(fract(u * 24), 1 - fract(u * 24)) * 18);
          ar *= 0.55 + seams * 0.45; ag *= 0.55 + seams * 0.45; ab *= 0.55 + seams * 0.45;
        } else {
          const tex = hullTexture(u, v, livery);
          ar = Math.pow(tex.r, 2.2); ag = Math.pow(tex.g, 2.2); ab = Math.pow(tex.b, 2.2);
          emissive = tex.emissive;
          rough = 0.4;
        }
        // a broad, soft highlight: the model's roughness map drives it, and the
        // exponent is deliberately low so 160 px sprites do not sparkle
        const shininess = 6 + (1 - Math.min(1, rough)) * 34;
        const specular = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), shininess) * (0.1 + (1 - rough) * 0.42);
        const exposure = livery.exposure || 2.6;
        let r = ar * lambert * exposure + specular * 0.9 + rim * livery.rim[0] + emissive * livery.accent[0];
        let g = ag * lambert * exposure + specular * 0.95 + rim * livery.rim[1] + emissive * livery.accent[1];
        let bl = ab * lambert * exposure + specular * 1.0 + rim * livery.rim[2] + emissive * livery.accent[2];
        // gamma back out of linear space for the PNG
        r = Math.pow(Math.max(0, r), 1 / 2.2);
        g = Math.pow(Math.max(0, g), 1 / 2.2);
        bl = Math.pow(Math.max(0, bl), 1 / 2.2);
        // soft roll-off so nothing clips to flat white
        r = r / (1 + r * 0.28); g = g / (1 + g * 0.28); bl = bl / (1 + bl * 0.28);
        color[o * 3] = r; color[o * 3 + 1] = g; color[o * 3 + 2] = bl;
        weight[o] = 1;
      }
    }
  }

  return downsample({ color, weight, dim, cell: size, ssaa });
}

/** Box filter with premultiplied alpha, so edges do not get dark fringes. */
function downsample({ color, weight, dim, cell, ssaa }) {
  const out = new Uint8ClampedArray(cell * cell * 4);
  const n = ssaa * ssaa;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ssaa; sy++) {
        for (let sx = 0; sx < ssaa; sx++) {
          const o = (y * ssaa + sy) * dim + (x * ssaa + sx);
          const w = weight[o];
          r += color[o * 3] * w; g += color[o * 3 + 1] * w; b += color[o * 3 + 2] * w; a += w;
        }
      }
      const o = (y * cell + x) * 4;
      if (a > 0) {
        out[o] = Math.min(255, (r / a) * 255);
        out[o + 1] = Math.min(255, (g / a) * 255);
        out[o + 2] = Math.min(255, (b / a) * 255);
      }
      out[o + 3] = Math.min(255, (a / n) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------ runtime mesh
 * The game also renders the ship in real 3D (WebGL, no loader, no modules —
 * the frame is sandboxed). That needs the geometry itself, so the same model is
 * baked a second time into a quantised, interleaved buffer and shipped as base64
 * inside a classic script. No fetch, no CORS, no binary MIME types:
 *
 *   16 bytes a vertex — position 3×int16 (unit sphere), normal 3×int8 + pad,
 *   albedo 3×uint8 (sRGB, straight off the model's own base-colour map) and one
 *   byte of roughness from the roughness map.
 *
 * Every livery shares it: the game tints at draw time, exactly like the atlases.
 */
function emitMesh(mesh, textures) {
  const { P, UV, N, I, center, scale } = mesh;
  const verts = P.length / 3;
  const tris = I.length / 3;
  const bytes = new Uint8Array(verts * 16 + tris * 6);
  const view = new DataView(bytes.buffer);
  const neutral = { hull: [0.6, 0.64, 0.7], accent: [0.55, 0.72, 0.9] };
  // Sample the maps once per vertex, then smooth along the edges. A 1024²
  // photoreal hull map collapsed onto 6k vertices aliases into speckle; one
  // pass of neighbour averaging keeps the large shapes (dark nacelle bands, the
  // registry pennant) and drops the noise that would otherwise crawl when the
  // ship turns.
  const albedo = new Float32Array(verts * 3);
  const roughs = new Float32Array(verts);
  for (let i = 0; i < verts; i++) {
    const u = UV[i * 2], v = UV[i * 2 + 1];
    if (textures.albedo) {
      const s0 = sample(textures.albedo, u, v);
      albedo[i * 3] = s0[0]; albedo[i * 3 + 1] = s0[1]; albedo[i * 3 + 2] = s0[2];
      roughs[i] = textures.roughness ? sample(textures.roughness, u, v)[0] : 0.45;
    } else {
      const tex = hullTexture(u, v, neutral);
      albedo[i * 3] = tex.r; albedo[i * 3 + 1] = tex.g; albedo[i * 3 + 2] = tex.b;
      roughs[i] = 0.42;
    }
  }
  const sum = new Float32Array(verts * 3);
  const count = new Float32Array(verts);
  const addEdge = (a, b) => {
    for (let k = 0; k < 3; k++) {
      sum[a * 3 + k] += albedo[b * 3 + k];
      sum[b * 3 + k] += albedo[a * 3 + k];
    }
    count[a] += 1; count[b] += 1;
  };
  for (let t = 0; t < I.length; t += 3) {
    addEdge(I[t], I[t + 1]);
    addEdge(I[t + 1], I[t + 2]);
    addEdge(I[t + 2], I[t]);
  }
  for (let i = 0; i < verts; i++) {
    if (!count[i]) continue;
    for (let k = 0; k < 3; k++) {
      albedo[i * 3 + k] = albedo[i * 3 + k] * 0.45 + (sum[i * 3 + k] / count[i]) * 0.55;
    }
  }

  for (let i = 0; i < verts; i++) {
    const o = i * 16;
    for (let k = 0; k < 3; k++) {
      const v = (P[i * 3 + k] - center[k]) / scale;
      view.setInt16(o + k * 2, Math.max(-32767, Math.min(32767, Math.round(v * 32767))), true);
    }
    for (let k = 0; k < 3; k++) {
      view.setInt8(o + 6 + k, Math.max(-127, Math.min(127, Math.round(N[i * 3 + k] * 127))));
    }
    view.setUint8(o + 10, Math.round(Math.max(0, Math.min(1, albedo[i * 3])) * 255));
    view.setUint8(o + 11, Math.round(Math.max(0, Math.min(1, albedo[i * 3 + 1])) * 255));
    view.setUint8(o + 12, Math.round(Math.max(0, Math.min(1, albedo[i * 3 + 2])) * 255));
    view.setUint8(o + 13, Math.round(Math.max(0, Math.min(1, roughs[i])) * 255));
    // bytes 14–15 stay zero: the stride is 16 so every attribute is aligned
  }
  for (let t = 0; t < tris * 3; t++) {
    view.setUint16(verts * 16 + t * 2, I[t], true);
  }
  return {
    verts,
    tris,
    v: Buffer.from(bytes.buffer, 0, verts * 16).toString('base64'),
    i: Buffer.from(bytes.buffer, verts * 16).toString('base64'),
  };
}

/** Signed volume of a mesh: a negative result means the faces wind inwards. */
function windingSign({ P, I }) {
  let volume = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    volume += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
      + P[a + 1] * (P[b + 2] * P[c] - P[b] * P[c + 2])
      + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return volume >= 0 ? 1 : -1;
}

/* -------------------------------------------------------------------- PNG */
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------- liveries
 * One model, three ships. The hull colour, the accent glow and the rim light
 * are what make the player's ship read differently from the two enemies.
 */
export const LIVERIES = {
  player: {
    hull: [0.74, 0.8, 0.86], tint: [1.25, 1.32, 1.5], accent: [0.35, 0.78, 1.0],
    rim: [0.26, 0.5, 0.8], glow: '#5fd0ff', size: 1.0, exposure: 3.1,
  },
  narada: {
    hull: [0.42, 0.3, 0.29], tint: [1.05, 0.62, 0.5], accent: [1.0, 0.42, 0.2],
    rim: [0.62, 0.2, 0.12], glow: '#ff7a3c', size: 1.55,
  },
  vengeance: {
    hull: [0.3, 0.33, 0.38], tint: [0.6, 0.66, 0.76], accent: [1.0, 0.72, 0.32],
    rim: [0.5, 0.36, 0.18], glow: '#ffb14a', size: 1.2,
  },
};

export const SHEET = { angles: 32, cols: 8, rows: 4, sizes: { high: 160, low: 96 } };

/* ------------------------------------------------------------------- main */
async function main() {
  const args = process.argv.slice(2);
  const preview = args.includes('--preview');
  const t0 = Date.now();

  console.log('reading model.fbx …');
  const raw = await loadMesh(path.join(root, 'model.fbx'));
  console.log(`  ${raw.tris.toLocaleString()} triangles · ${raw.verts.toLocaleString()} vertices`);

  const textures = await loadTextures();
  console.log(`  textures: ${textures.source}`);

  const decimated = decimate(raw, preview ? 16000 : 26000);
  const normals = computeNormals(decimated);
  const mesh = {
    ...decimated,
    N: normals,
    center: [0, 1, 2].map((k) => (decimated.bounds.min[k] + decimated.bounds.max[k]) / 2),
    scale: Math.max(...[0, 1, 2].map((k) => decimated.bounds.max[k] - decimated.bounds.min[k])) / 2,
  };
  console.log(`  decimated to ${decimated.tris.toLocaleString()} triangles · ${decimated.verts.toLocaleString()} vertices (${Date.now() - t0} ms)`);

  // A top-down game wants to look *down* on the ship, with just enough tilt to
  // read its height. 64° and a longish lens keep the proportions honest.
  const elevation = (Number(process.env.BAKE_ELEV) || 64) * Math.PI / 180;
  const dist = Number(process.env.BAKE_DIST) || 4.8;   // camera distance, in ship radii
  const angles = preview ? 8 : SHEET.angles;
  const focal = Number(process.env.BAKE_FOCAL) || fitFocal(mesh, { elevation, dist, angles });
  console.log(`  camera: ${(elevation * 180 / Math.PI).toFixed(0)}° down, focal ${focal.toFixed(2)}`);

  if (preview) {
    // eight headings of the player's ship, one image, for eyeballing
    const cell = Number(process.env.BAKE_CELL) || 180;
    const ctx = { w: cell * 8, h: cell };
    const sheet = new Uint8ClampedArray(ctx.w * ctx.h * 4);
    for (let i = 0; i < 8; i++) {
      const sprite = bakeHeading(mesh, {
        livery: LIVERIES.player, angle: (i * Math.PI * 2) / 8, size: cell, ssaa: 2, elevation, focal, dist, textures,
      });
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const s = (y * cell + x) * 4;
          const d = (y * ctx.w + i * cell + x) * 4;
          sheet[d] = sprite[s]; sheet[d + 1] = sprite[s + 1]; sheet[d + 2] = sprite[s + 2]; sheet[d + 3] = sprite[s + 3];
        }
      }
    }
    writeFileSync('/tmp/ship-preview.png', png(sheet, ctx.w, ctx.h));
    console.log('preview → /tmp/ship-preview.png');
    return;
  }

  const artDir = path.join(root, 'games', 'star-battle', 'art');
  mkdirSync(artDir, { recursive: true });

  const manifest = { version: 1, source: 'model.fbx', ...SHEET, liveries: {} };
  for (const [name, livery] of Object.entries(LIVERIES)) {
    manifest.liveries[name] = { files: {}, glow: livery.glow, size: livery.size };
    for (const [tier, cell] of Object.entries(SHEET.sizes)) {
      const sheetW = cell * SHEET.cols;
      const sheetH = cell * SHEET.rows;
      const pixels = new Uint8ClampedArray(sheetW * sheetH * 4);
      for (let i = 0; i < SHEET.angles; i++) {
        const sprite = bakeHeading(mesh, {
          livery,
          angle: (i * Math.PI * 2) / SHEET.angles,
          size: cell, ssaa: 2, elevation, focal, dist, textures,
        });
        const ox = (i % SHEET.cols) * cell;
        const oy = Math.floor(i / SHEET.cols) * cell;
        for (let y = 0; y < cell; y++) {
          const src = y * cell * 4;
          const dst = ((oy + y) * sheetW + ox) * 4;
          pixels.set(sprite.subarray(src, src + cell * 4), dst);
        }
      }
      const file = `ships-${name}-${tier}.png`;
      const buf = png(pixels, sheetW, sheetH);
      writeFileSync(path.join(artDir, file), buf);
      manifest.liveries[name].files[tier] = file;
      console.log(`  ${file} · ${sheetW}×${sheetH} · ${(buf.length / 1024).toFixed(0)} KB`);
    }
  }
  // ---------------------------------------------------------- the 3D mesh
  // A second, lighter decimation: the frame draws this every frame on a phone,
  // often seven ships at once, so it is ~15k triangles rather than 20k. The
  // atlases keep the denser mesh — a sprite is baked once, a frame is not.
  const live = decimate(raw, 17000);
  live.N = computeNormals(live);
  const sign = windingSign(live);
  if (sign < 0) for (let i = 0; i < live.N.length; i++) live.N[i] = -live.N[i];
  const liveMesh = {
    ...live,
    center: [0, 1, 2].map((k) => (live.bounds.min[k] + live.bounds.max[k]) / 2),
    scale: Math.max(...[0, 1, 2].map((k) => live.bounds.max[k] - live.bounds.min[k])) / 2,
  };
  const baked = emitMesh(liveMesh, textures);
  const meshJs = `/* generated by scripts/bake-ship.mjs from model.fbx — do not edit by hand.\n`
    + ` * ${baked.verts.toLocaleString('en-US')} vertices · ${baked.tris.toLocaleString('en-US')} triangles · stride 16\n`
    + ` * position int16×3 · normal int8×3 · albedo uint8×3 (sRGB) · roughness uint8 */\n`
    + `window.STAR_MESH = { version: 1, verts: ${baked.verts}, tris: ${baked.tris}, stride: 16,\n`
    + `  v: '${baked.v}',\n  i: '${baked.i}' };\n`;
  writeFileSync(path.join(artDir, 'ship-mesh.js'), meshJs);
  console.log(`  ship-mesh.js · ${baked.verts.toLocaleString()} verts · ${baked.tris.toLocaleString()} tris · `
    + `${(meshJs.length / 1024).toFixed(0)} KB (winding ${sign > 0 ? 'outward' : 'flipped'})`);
  manifest.mesh = { file: 'ship-mesh.js', verts: baked.verts, tris: baked.tris, stride: 16 };

  manifest.generatedAt = new Date().toISOString();
  manifest.triangles = mesh.tris;
  manifest.vertices = mesh.verts;
  writeFileSync(path.join(artDir, 'ships.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
