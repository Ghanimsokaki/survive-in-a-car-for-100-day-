/**
 * MATERIAL KIT — the difference between "coloured boxes" and a survivor that
 * looks like they have been living in a car for a month.
 *
 * Everything here is generated at runtime from canvas textures, so there are no
 * downloaded assets and no licence to chase:
 *
 *   · skin     — MeshPhysicalMaterial with a soft sheen + a faint warm clearcoat
 *   · cloth    — woven normal map + roughness breakup, tinted per outfit
 *   · leather  — grain normal map, high roughness, low metalness
 *   · metal    — brushed anisotropic-ish streaks baked into roughness
 *   · hair     — anisotropic sheen, strand normal
 *
 * `detail` picks how much of it is used:
 *   'low'    → flat standard materials (phones on the frame-governor floor)
 *   'medium' → colour + roughness breakup, no normal maps
 *   'high'   → full PBR: normal + roughness maps + environment reflections
 */
import * as THREE from '../vendor/three.module.js';
import { canvasTex } from './utils.js';

const cache = new Map();

const noiseCanvas = (size, painter) => {
  const key = `${size}:${painter.name}`;
  if (cache.has(key)) return cache.get(key);
  const tex = new THREE.CanvasTexture(canvasTex(size, size, painter));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  cache.set(key, tex);
  return tex;
};

/* ---------------------------------------------------------------- textures */

/** Woven cloth: horizontal + vertical threads with a little slub. */
function paintWeave(ctx, size) {
  ctx.fillStyle = '#8080ff';
  ctx.fillRect(0, 0, size, size);
  const step = size / 16;
  for (let y = 0; y < size; y += step) {
    for (let x = 0; x < size; x += step) {
      const on = ((x / step) + (y / step)) % 2 === 0;
      ctx.fillStyle = on ? '#9a9aff' : '#6a6aff';
      ctx.fillRect(x, y, step, step);
      ctx.fillStyle = on ? 'rgba(190,190,255,.35)' : 'rgba(60,60,200,.3)';
      ctx.fillRect(x, y + step * 0.32, step, step * 0.18);
    }
  }
  // slubs
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.05 + Math.random() * 0.08})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1);
  }
}

/** Leather: pebbled grain normal. */
function paintGrain(ctx, size) {
  ctx.fillStyle = '#8080ff';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2600; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 1 + Math.random() * 3.2;
    const shade = 110 + Math.random() * 90;
    ctx.fillStyle = `rgba(${shade},${shade},255,.5)`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Roughness breakup: patches of polish and scuff, greyscale. */
function paintRough(ctx, size) {
  ctx.fillStyle = '#b4b4b4';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 160; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 4 + Math.random() * 26;
    const g = 90 + Math.random() * 130;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(${g},${g},${g},.5)`);
    grad.addColorStop(1, 'rgba(128,128,128,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  }
  // scratches
  ctx.strokeStyle = 'rgba(240,240,240,.35)';
  for (let i = 0; i < 26; i++) {
    ctx.lineWidth = 0.6 + Math.random();
    ctx.beginPath();
    const x = Math.random() * size, y = Math.random() * size;
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 12);
    ctx.stroke();
  }
}

function mapFor(name, repeat = 2) {
  const tex = noiseCanvas(128, name === 'weave' ? paintWeave : name === 'grain' ? paintGrain : paintRough);
  const copy = tex.clone();
  copy.needsUpdate = true;
  copy.wrapS = THREE.RepeatWrapping;
  copy.wrapT = THREE.RepeatWrapping;
  copy.repeat.set(repeat, repeat);
  copy.name = `${name}×${repeat}`;
  return copy;
}

/* ------------------------------------------------------------- environment */

/**
 * A procedural sky/ground panorama used for reflections. Cheap (one 256×128
 * canvas) and it makes metal and skin read as materials instead of flat fills.
 */
export function skyTexture() {
  if (cache.has('sky')) return cache.get('sky');
  const canvas = canvasTex(256, 128, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, '#243349');
    g.addColorStop(0.42, '#7f93ad');
    g.addColorStop(0.55, '#c8b79a');
    g.addColorStop(0.72, '#5a5148');
    g.addColorStop(1, '#201d1b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);
    // a sun blob so metals get a highlight
    const sun = ctx.createRadialGradient(196, 34, 0, 196, 34, 34);
    sun.addColorStop(0, 'rgba(255,246,220,1)');
    sun.addColorStop(1, 'rgba(255,246,220,0)');
    ctx.fillStyle = sun;
    ctx.beginPath(); ctx.arc(196, 34, 34, 0, Math.PI * 2); ctx.fill();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set('sky', tex);
  return tex;
}

/**
 * Turns the panorama into a prefiltered environment map for PBR reflections.
 * Returns null when the renderer cannot do it (headless tests, old drivers).
 */
export function buildEnvironment(renderer, scene) {
  if (!renderer || typeof THREE.PMREMGenerator !== 'function') return null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromEquirectangular(skyTexture());
    pmrem.dispose?.();
    if (scene) scene.environment = rt.texture;
    return rt.texture;
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- kit */

/**
 * @param {object} opts
 * @param {'low'|'medium'|'high'} [opts.detail]
 * @param {THREE.Texture|null} [opts.env]
 */
export function createMaterialKit({ detail = 'medium', env = null } = {}) {
  // ULTRA is HIGH with the dials further up: same materials, sharper maps,
  // stronger reflections. Keeping it a superset means nothing can regress.
  const ultra = detail === 'ultra';
  const high = detail === 'high' || ultra;
  const medium = detail === 'medium' || high;
  const base = {
    envMap: high ? env : null,
    envMapIntensity: ultra ? 1.15 : high ? 0.85 : 0.35,
  };

  const skin = () => {
    if (!high) return new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, ...base });
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.52,
      metalness: 0,
      // a touch of sheen + clearcoat is what separates skin from plastic
      sheen: 0.35,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color(0xffc8a8),
      clearcoat: 0.06,
      clearcoatRoughness: 0.8,
      ...base,
    });
  };

  const cloth = (hex) => {
    const m = new THREE.MeshStandardMaterial({
      color: hex,
      roughness: medium ? 0.9 : 0.82,
      metalness: 0.02,
      ...base,
    });
    if (high) {
      m.normalMap = mapFor('weave', 3);
      m.normalScale = new THREE.Vector2(0.35, 0.35);
      m.roughnessMap = mapFor('rough', 1);
      m.roughness = 1;
    } else if (medium) {
      m.roughnessMap = mapFor('rough', 1);
    }
    return m;
  };

  const leather = (hex = 0x1b1e25) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.86, metalness: 0.05, ...base });
    if (high) {
      m.normalMap = mapFor('grain', 2);
      m.normalScale = new THREE.Vector2(0.5, 0.5);
      m.roughnessMap = mapFor('rough', 2);
    }
    return m;
  };

  const metal = (hex = 0x9aa3ae, { rough = 0.32 } = {}) => {
    const m = new THREE.MeshStandardMaterial({
      color: hex,
      roughness: rough,
      metalness: 0.92,
      ...base,
      envMapIntensity: high ? 1.35 : 0.5,
    });
    if (medium) m.roughnessMap = mapFor('rough', 2);
    return m;
  };

  const hair = (hex) => {
    const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.72, metalness: 0.06, ...base });
    if (high) {
      m.normalMap = mapFor('grain', 3);
      m.normalScale = new THREE.Vector2(0.25, 0.25);
    }
    return m;
  };

  const glass = () => new THREE.MeshPhysicalMaterial({
    color: 0x9fc4e0,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.42,
    transmission: high ? 0.6 : 0,
    thickness: 0.4,
    ...base,
  });

  return { detail, high, medium, skin, cloth, leather, metal, hair, glass };
}

/** Geometry segment counts per detail tier — the cheapest FPS lever we have. */
export function segmentsFor(detail) {
  if (detail === 'ultra') return { capsule: 16, ball: 26, sphereW: 36, sphereH: 24 };
  if (detail === 'high') return { capsule: 12, ball: 20, sphereW: 28, sphereH: 18 };
  if (detail === 'medium') return { capsule: 6, ball: 14, sphereW: 20, sphereH: 12 };
  return { capsule: 4, ball: 10, sphereW: 12, sphereH: 8 };
}
