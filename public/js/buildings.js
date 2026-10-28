import * as THREE from '../vendor/three.module.js';
import { rand, pick, clamp } from './utils.js';

/* ------------------------------------------------------------------ materials
 * Shared per-key materials so every building of a kind reuses the same shader
 * programs. Colours are picked to read as "abandoned but once lived in".
 */
const MATERIALS = new Map();

const MAT_DEFS = {
  // structure
  siding: { color: 0x9d9483, roughness: 0.92, metalness: 0.02 },
  sidingWarm: { color: 0xa8846a, roughness: 0.9 },
  sidingPale: { color: 0xb9b6ac, roughness: 0.88 },
  brick: { color: 0x7c5647, roughness: 0.95 },
  concrete: { color: 0x8b8880, roughness: 0.95 },
  concreteDark: { color: 0x5f5d58, roughness: 0.96 },
  plaster: { color: 0xb3a894, roughness: 0.93 },
  metal: { color: 0x8e949c, roughness: 0.42, metalness: 0.85 },
  metalDark: { color: 0x3d434b, roughness: 0.55, metalness: 0.7 },
  rust: { color: 0x8a4a26, roughness: 0.94, metalness: 0.15 },
  wood: { color: 0x7a5636, roughness: 0.9 },
  woodDark: { color: 0x4d3624, roughness: 0.94 },
  woodPale: { color: 0xa3835c, roughness: 0.9 },
  trim: { color: 0xe2ddd2, roughness: 0.75 },
  roof: { color: 0x4a4038, roughness: 0.88, metalness: 0.25 },
  roofRust: { color: 0x6d4a33, roughness: 0.92 },
  roofTile: { color: 0x6b4437, roughness: 0.9 },
  // interior
  floorWood: { color: 0x7b5a3c, roughness: 0.82 },
  floorTile: { color: 0x8d8b84, roughness: 0.55, metalness: 0.1 },
  floorConcrete: { color: 0x6a6862, roughness: 0.95 },
  carpet: { color: 0x6d4148, roughness: 1 },
  fabric: { color: 0x4a5a52, roughness: 1 },
  fabricPale: { color: 0xa8a294, roughness: 1 },
  bedding: { color: 0xb9b2a2, roughness: 1 },
  glass: { color: 0x2b3a44, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.55 },
  glassLit: { color: 0x4a3f2c, roughness: 0.1, metalness: 0.2, emissive: 0xffb765, emissiveIntensity: 0.55 },
  lamp: { color: 0xffe9c0, emissive: 0xffcf7a, emissiveIntensity: 2.4 },
  neon: { color: 0xffc46b, emissive: 0xff9a2e, emissiveIntensity: 1.6 },
  neonCyan: { color: 0x8ff4ff, emissive: 0x37d7ff, emissiveIntensity: 1.5 },
  goodsA: { color: 0xb04a3a, roughness: 0.85 },
  goodsB: { color: 0x3f6f8a, roughness: 0.85 },
  goodsC: { color: 0xa8913f, roughness: 0.85 },
  crate: { color: 0x8a6a3f, roughness: 0.9 },
  hay: { color: 0xb99a52, roughness: 1 },
  tyre: { color: 0x1a1c20, roughness: 0.95 },
  oil: { color: 0x2e3b2f, roughness: 0.6, metalness: 0.5 },
  blood: { color: 0x4a1d1d, roughness: 1 },
  ash: { color: 0x4a4744, roughness: 1 },
};

function mat(key) {
  if (MATERIALS.has(key)) return MATERIALS.get(key);
  const def = MAT_DEFS[key] || MAT_DEFS.concrete;
  const m = new THREE.MeshStandardMaterial({ ...def });
  if (!('transparent' in def)) m.transparent = false;
  MATERIALS.set(key, m);
  return m;
}

/* -------------------------------------------------------------- merge helper
 * Buildings are authored as dozens of small primitives but drawn as a handful
 * of meshes: every primitive is baked into a per-material buffer geometry.
 */
function mergeAll(geometries) {
  let total = 0;
  const prepared = geometries.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    total += ng.attributes.position.count;
    return ng;
  });
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let vertex = 0;
  for (const g of prepared) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const t = g.attributes.uv ? g.attributes.uv.array : null;
    for (let i = 0; i < g.attributes.position.count; i++) {
      position[(vertex + i) * 3] = p[i * 3];
      position[(vertex + i) * 3 + 1] = p[i * 3 + 1];
      position[(vertex + i) * 3 + 2] = p[i * 3 + 2];
      normal[(vertex + i) * 3] = n[i * 3];
      normal[(vertex + i) * 3 + 1] = n[i * 3 + 1];
      normal[(vertex + i) * 3 + 2] = n[i * 3 + 2];
      if (t) {
        uv[(vertex + i) * 2] = t[i * 2];
        uv[(vertex + i) * 2 + 1] = t[i * 2 + 1];
      }
    }
    vertex += g.attributes.position.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();
  return merged;
}

class Builder {
  constructor() {
    this.solid = new Map();   // material key → geometries
    this.roof = new Map();    // roof pieces, hidden when the player is inside
    this.colliders = [];      // local AABB wall rects
    this.loot = [];           // local loot crate positions
    this.leaves = [];         // hinged door panels: { key, w, h, d, x, y, z }
  }

  _bucket(key, roof) {
    const map = roof ? this.roof : this.solid;
    if (!map.has(key)) map.set(key, []);
    return map.get(key);
  }

  _push(key, geometry, x, y, z, ry = 0, roof = false) {
    const m = new THREE.Matrix4();
    if (ry) m.makeRotationY(ry);
    m.setPosition(x, y, z);
    geometry.applyMatrix4(m);
    this._bucket(key, roof).push(geometry);
    return this;
  }

  box(key, w, h, d, x, y, z, ry = 0) {
    return this._push(key, new THREE.BoxGeometry(w, h, d), x, y, z, ry);
  }

  cyl(key, rt, rb, h, seg, x, y, z) {
    return this._push(key, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z);
  }

  sphere(key, r, x, y, z, seg = 8) {
    return this._push(key, new THREE.SphereGeometry(r, seg, Math.max(4, seg / 2)), x, y, z);
  }

  roofBox(key, w, h, d, x, y, z, ry = 0) {
    return this._push(key, new THREE.BoxGeometry(w, h, d), x, y, z, ry, true);
  }

  roofCyl(key, rt, rb, h, seg, x, y, z) {
    return this._push(key, new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, 0, true);
  }

  roofSphere(key, r, x, y, z, seg = 8) {
    return this._push(key, new THREE.SphereGeometry(r, seg, Math.max(4, seg / 2)), x, y, z, 0, true);
  }

  /** Wall slab + matching collider (local space). */
  wall(key, w, h, d, x, y, z) {
    this.box(key, w, h, d, x, y, z);
    this.colliders.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  }

  lootAt(x, z) { this.loot.push({ x, z }); }

  /**
   * A hinged panel. x/z is the hinge line; the panel extends along +Z when
   * dir is 1 and along -Z when dir is -1, so a wide opening gets two leaves.
   */
  doorLeaf(key, w, h, d, x, y, z, dir = 1) {
    this.leaves.push({ key, w, h, d, x, y, z, dir });
    return this;
  }

  build() {
    const group = new THREE.Group();
    for (const [key, geos] of this.solid) {
      const mesh = new THREE.Mesh(mergeAll(geos), mat(key));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      geos.forEach((g) => g.dispose?.());
    }
    const roofGroup = new THREE.Group();
    for (const [key, geos] of this.roof) {
      const mesh = new THREE.Mesh(mergeAll(geos), mat(key));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      roofGroup.add(mesh);
      geos.forEach((g) => g.dispose?.());
    }
    group.add(roofGroup);

    // Each panel gets its own pivot group so it can swing without a second draw call.
    const leaves = this.leaves.map(({ key, w, h, d, x, y, z, dir }) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      pivot.userData.dir = dir;
      pivot.rotation.y = dir === 1 ? 0 : Math.PI;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(key));
      panel.position.set(0, 0, d / 2);
      panel.castShadow = true;
      panel.receiveShadow = true;
      pivot.add(panel);
      group.add(pivot);
      return pivot;
    });

    return { group, roofGroup, leaves };
  }
}

/* ------------------------------------------------------------------- layouts
 * Every building is generated in local space: door centred on the -X wall so
 * it faces the road, floor at y = 0, ceiling at y = height.
 */
function shell(b, { w, d, h, wallKey, floorKey, doorWidth = 2.6, doorHeight = 2.9, windows = true, wallThickness = 0.34 }) {
  const t = wallThickness;
  b.box(floorKey, w, 0.16, d, 0, 0.06, 0);

  // back wall (+X), front wall (-X) with a doorway, side walls
  b.wall(wallKey, t, h, d, w / 2 - t / 2, h / 2, 0);
  const frontX = -w / 2 + t / 2;
  const gapSide = (d - doorWidth) / 2;
  const gapZ = doorWidth / 2 + gapSide / 2;
  b.wall(wallKey, t, h, gapSide, frontX, h / 2, -gapZ);
  b.wall(wallKey, t, h, gapSide, frontX, h / 2, gapZ);
  // lintel above the doorway
  b.box(wallKey, t, h - doorHeight, doorWidth, frontX, doorHeight + (h - doorHeight) / 2, 0);
  b.wall(wallKey, w, h, t, 0, h / 2, -d / 2 + t / 2);
  b.wall(wallKey, w, h, t, 0, h / 2, d / 2 - t / 2);

  // hinged door panels — double doors on the wide garage openings
  const leafKey = h > 3.2 ? 'metalDark' : 'woodDark';
  const panelH = doorHeight - 0.18;
  const leafY = panelH / 2 + 0.08;
  if (doorWidth > 3.6) {
    const half = doorWidth / 2 - 0.06;
    b.doorLeaf(leafKey, 0.11, panelH, half, frontX + 0.07, leafY, -doorWidth / 2, 1);
    b.doorLeaf(leafKey, 0.11, panelH, half, frontX + 0.07, leafY, doorWidth / 2, -1);
  } else {
    b.doorLeaf(leafKey, 0.11, panelH, doorWidth - 0.12, frontX + 0.07, leafY, -doorWidth / 2 + 0.06, 1);
  }
  // handle on the free edge of the single leaf
  if (doorWidth <= 3.6) b.box('metalDark', 0.1, 0.1, 0.3, frontX + 0.16, 1.06, doorWidth / 2 - 0.5);

  // door frame + threshold
  b.box('trim', t + 0.08, doorHeight + 0.12, 0.16, frontX, (doorHeight + 0.12) / 2, -doorWidth / 2 - 0.06);
  b.box('trim', t + 0.08, doorHeight + 0.12, 0.16, frontX, (doorHeight + 0.12) / 2, doorWidth / 2 + 0.06);
  b.box('trim', 0.1, doorHeight, doorWidth, frontX - t / 2 - 0.02, doorHeight / 2, 0);
  b.box('concrete', 1.6, 0.14, doorWidth + 0.9, frontX - 0.9, 0.07, 0);

  // driveway slab + a door light so buildings read from the road at night
  b.box('concrete', 5.2, 0.08, doorWidth + 1.4, frontX - 2.9, 0.04, 0);
  b.box('metalDark', 0.12, 2.15, 0.12, frontX - 1.15, 1.08, -(doorWidth / 2 + 1.25));
  b.sphere('lamp', 0.17, frontX - 1.15, 2.16, -(doorWidth / 2 + 1.25), 8);
  b.box('metalDark', 0.3, 0.08, 0.3, frontX - 1.15, 2.24, -(doorWidth / 2 + 1.25));

  // corner posts
  [[-w / 2 + t / 2, -d / 2 + t / 2], [w / 2 - t / 2, -d / 2 + t / 2], [-w / 2 + t / 2, d / 2 - t / 2], [w / 2 - t / 2, d / 2 - t / 2]]
    .forEach(([x, z]) => b.box('trim', t + 0.1, h, t + 0.1, x, h / 2, z));

  // windows on the long walls
  if (windows) {
    const count = Math.max(2, Math.round(w / 4.5));
    for (let i = 0; i < count; i++) {
      const x = -w / 2 + (w / (count + 1)) * (i + 1);
      const lit = Math.random() < 0.35;
      [-1, 1].forEach((side) => {
        b.box('trim', 1.9, 1.5, t + 0.06, x, h * 0.62, side * (d / 2 - t / 2));
        b.box(lit ? 'glassLit' : 'glass', 1.5, 1.15, 0.06, x, h * 0.62, side * (d / 2 - t / 2) - side * 0.03);
        b.box('woodDark', 1.6, 0.08, 0.14, x, h * 0.62, side * (d / 2 - t / 2) - side * 0.1);
      });
    }
  }

  // roof slab + beams (hidden while the player is inside)
  b.roofBox('roof', w + 0.7, 0.22, d + 0.7, 0, h + 0.11, 0);
  b.roofBox('woodDark', w - 0.4, 0.12, 0.16, 0, h + 0.02, 0);
  for (let i = -2; i <= 2; i++) b.roofBox('woodDark', w - 0.5, 0.1, 0.12, 0, h - 0.02, i * (d / 6));

  return { w, d, h, frontX };
}

function crateStack(b, x, z, n = 2) {
  for (let i = 0; i < n; i++) {
    const s = rand(0.7, 1.05);
    b.box('crate', s, s, s, x + rand(-0.2, 0.2), 0.18 + s / 2 + i * s * 0.92, z + rand(-0.2, 0.2), rand(0, 1));
  }
  b.lootAt(x, z);
}

/**
 * Hanging work lamp. Built into the roof group so it disappears together with
 * the ceiling when the player steps inside — no floating lamps from above.
 */
function lamp(b, x, z, h) {
  b.roofCyl('metalDark', 0.03, 0.03, 0.9, 5, x, h - 0.45, z);
  b.roofSphere('lamp', 0.14, x, h - 0.92, z, 8);
  b.roofBox('metalDark', 0.42, 0.06, 0.42, x, h - 0.03, z);
}

/* ---------------------------------------------------------------- archetypes */
const KINDS = {
  house(b) {
    const w = rand(11, 13), d = rand(8, 9.6), h = 3.2;
    shell(b, { w, d, h, wallKey: pick(['siding', 'sidingWarm', 'sidingPale', 'plaster']), floorKey: 'floorWood' });

    // living room: rug, sofa, table, shelf
    b.box('carpet', 4.6, 0.04, 3.2, 1.2, 0.1, 1.1);
    b.box('fabric', 2.4, 0.55, 0.9, 1.4, 0.38, 2.5);
    b.box('fabric', 2.4, 0.7, 0.22, 1.4, 0.72, 2.9);
    b.box('woodDark', 1.5, 0.1, 0.9, 1.3, 0.55, 0.9);
    [[1.0, 0.9], [1.6, 0.9], [1.0, 0.55], [1.6, 0.6]].forEach(([x, z]) => b.box('wood', 0.12, 0.5, 0.12, x, 0.25, z));
    b.box('woodDark', 0.5, 2.0, 2.6, w / 2 - 0.9, 1.05, -1.6);
    for (let i = 0; i < 3; i++) b.box('wood', 0.42, 0.06, 2.3, w / 2 - 0.9, 0.55 + i * 0.55, -1.6);
    // bedroom corner
    b.box('woodDark', 2.0, 0.4, 1.5, -1.4, 0.28, -d / 2 + 1.6);
    b.box('bedding', 1.9, 0.22, 1.4, -1.4, 0.56, -d / 2 + 1.6);
    b.box('fabricPale', 0.5, 0.16, 1.2, -2.2, 0.68, -d / 2 + 1.6);
    // kitchen counter
    b.box('woodPale', 3.2, 0.9, 0.7, -w / 2 + 2.6, 0.5, d / 2 - 1.1);
    b.box('metal', 1.4, 0.9, 0.66, -w / 2 + 1.1, 0.48, -d / 2 + 1.5);
    b.box('trim', 0.7, 0.05, 0.5, -w / 2 + 2.2, 0.97, d / 2 - 1.1);
    lamp(b, 1.2, 1.1, h);
    crateStack(b, w / 2 - 1.6, d / 2 - 1.4, 2);
    b.lootAt(-w / 2 + 2.0, d / 2 - 2.2);
    // porch + mailbox
    b.box('woodPale', 0.28, 2.6, 0.28, -w / 2 - 1.6, 1.35, -1.9);
    b.box('woodPale', 0.28, 2.6, 0.28, -w / 2 - 1.6, 1.35, 1.9);
    b.box('roofRust', 3.6, 0.16, 4.4, -w / 2 - 1.5, 2.72, 0);
    b.box('woodPale', 2.8, 0.12, 4.2, -w / 2 - 1.4, 0.34, 0);
    b.box('metal', 0.14, 1.1, 0.14, -w / 2 - 3.0, 0.55, 2.9);
    return { w, d, h, label: 'ABANDONED HOUSE', lootMult: 1.35 };
  },

  shack(b) {
    const w = rand(7, 8.4), d = rand(6, 7.2), h = 2.7;
    shell(b, { w, d, h, wallKey: pick(['woodDark', 'rust', 'siding']), floorKey: 'floorConcrete', windows: false, doorWidth: 2.0, doorHeight: 2.4 });
    b.box('wood', 1.5, 0.12, 1.0, 0.6, 0.6, 1.2);
    b.box('wood', 0.14, 0.55, 0.14, 0.1, 0.3, 0.85);
    b.box('wood', 0.14, 0.55, 0.14, 1.1, 0.3, 0.85);
    b.cyl('rust', 0.42, 0.44, 1.1, 8, -1.9, 0.72, -d / 2 + 1.2);
    b.box('crate', 1.0, 0.9, 0.8, 1.9, 0.6, -d / 2 + 1.3, 0.3);
    lamp(b, 0.4, 1.0, h);
    crateStack(b, -1.4, d / 2 - 1.5, 1);
    b.lootAt(1.6, 0.6);
    return { w, d, h, label: 'ROADSIDE SHACK', lootMult: 1.0 };
  },

  barn(b) {
    const w = 16, d = 13, h = 4.6;
    shell(b, { w, d, h, wallKey: 'woodDark', floorKey: 'floorConcrete', doorWidth: 4.4, doorHeight: 3.6, windows: false });
    // hay bales & stalls
    for (let i = 0; i < 5; i++) {
      b.cyl('hay', 0.75, 0.75, 1.5, 10, rand(-w / 2 + 2, w / 2 - 2), 0.5 + (i % 2) * 0.9, rand(-d / 2 + 2, d / 2 - 2));
    }
    for (let i = 0; i < 3; i++) {
      const z = -d / 2 + 3 + i * 3.4;
      b.box('woodPale', 0.16, 1.3, 3.0, w / 2 - 2.4, 0.75, z);
      b.box('wood', 1.2, 0.1, 0.12, w / 2 - 2.4, 0.2, z);
    }
    b.cyl('rust', 0.5, 0.5, 1.2, 8, -w / 2 + 2.2, 0.7, d / 2 - 2.2);
    b.box('wood', 3.4, 0.16, 1.4, 0, 1.2, -d / 2 + 2.4);
    b.box('wood', 0.16, 1.3, 0.16, -1.4, 0.65, -d / 2 + 2.4);
    b.box('wood', 0.16, 1.3, 0.16, 1.4, 0.65, -d / 2 + 2.4);
    crateStack(b, -w / 2 + 3, -d / 2 + 3, 3);
    b.lootAt(w / 2 - 3, d / 2 - 3);
    // silo silhouette outside
    b.cyl('metal', 2.2, 2.4, 9, 12, w / 2 + 3.6, 4.5, -2);
    b.cyl('metalDark', 2.3, 2.3, 0.5, 12, w / 2 + 3.6, 9.2, -2);
    return { w, d, h, label: 'BARN', lootMult: 1.25 };
  },

  warehouse(b) {
    const w = 20, d = 15, h = 6.4;
    shell(b, { w, d, h, wallKey: 'concrete', floorKey: 'floorConcrete', doorWidth: 6, doorHeight: 4.4, windows: false });
    // shelving rows
    for (let r = 0; r < 2; r++) {
      const z = -d / 4 + r * (d / 2);
      for (let i = 0; i < 5; i++) {
        const x = -w / 2 + 3 + i * 3.6;
        b.box('metal', 0.14, 3.2, 0.14, x, 1.7, z - 1.2);
        b.box('metal', 0.14, 3.2, 0.14, x, 1.7, z + 1.2);
        for (let s = 0; s < 3; s++) {
          b.box('metalDark', 1.6, 0.1, 2.6, x, 0.7 + s * 1.1, z);
          if (Math.random() < 0.75) {
            b.box(pick(['goodsA', 'goodsB', 'goodsC', 'crate']), rand(0.6, 1.1), rand(0.5, 0.8), rand(0.6, 1.2), x + rand(-0.3, 0.3), 1.05 + s * 1.1, z + rand(-0.5, 0.5));
          }
        }
      }
    }
    // pallets by the door
    for (let i = 0; i < 3; i++) {
      b.box('woodPale', 1.6, 0.16, 1.6, -w / 2 + 3 + i * 1.8, 0.2 + i * 0.18, d / 2 - 2.4);
    }
    b.box('rust', 1.4, 2.2, 2.6, w / 2 - 3, 1.1, d / 2 - 3);
    crateStack(b, w / 2 - 2.6, -d / 2 + 2.6, 3);
    b.lootAt(-w / 2 + 3, -d / 2 + 3);
    b.lootAt(w / 2 - 4, 0);
    return { w, d, h, label: 'WAREHOUSE', lootMult: 1.7 };
  },

  store(b) {
    const w = 15, d = 11, h = 3.8;
    shell(b, { w, d, h, wallKey: 'plaster', floorKey: 'floorTile', doorWidth: 3.2, doorHeight: 3.0 });
    // checkout counter
    b.box('woodPale', 4.2, 1.0, 1.2, -w / 2 + 3.4, 0.55, 0);
    b.box('metal', 0.8, 0.5, 0.7, -w / 2 + 2.2, 1.25, 0);
    // aisles
    for (let i = 0; i < 3; i++) {
      const x = -2.5 + i * 3.2;
      b.box('metal', 3.0, 0.1, 1.1, x, 0.45, -1.6);
      b.box('metal', 3.0, 0.1, 1.1, x, 1.15, -1.6);
      for (let s = 0; s < 4; s++) {
        if (Math.random() < 0.8) {
          b.box(pick(['goodsA', 'goodsB', 'goodsC', 'crate']), 0.28, rand(0.25, 0.45), 0.3, x - 1.2 + s * 0.8, 0.6, -1.6 + rand(-0.2, 0.2));
          b.box(pick(['goodsA', 'goodsB', 'goodsC']), 0.28, rand(0.25, 0.45), 0.3, x - 1.2 + s * 0.8, 1.3, -1.6 + rand(-0.2, 0.2));
        }
      }
    }
    // freezer + shelves at the back
    b.box('metal', 4.0, 2.4, 1.0, w / 2 - 3.2, 1.2, -d / 2 + 1.4);
    b.box('glassLit', 3.8, 2.0, 0.1, w / 2 - 3.2, 1.3, -d / 2 + 2.0);
    // hanging sign
    b.box('neon', 4.4, 0.5, 0.12, 0.5, 2.9, -d / 2 + 2.2);
    lamp(b, -1.0, 1.6, h);
    lamp(b, 3.0, 1.6, h);
    crateStack(b, w / 2 - 2.4, d / 2 - 2.2, 2);
    b.lootAt(-w / 2 + 3.0, -d / 2 + 2.4);
    return { w, d, h, label: 'GENERAL STORE', lootMult: 1.45 };
  },

  garage(b) {
    const w = 14, d = 11, h = 4.2;
    shell(b, { w, d, h, wallKey: 'concreteDark', floorKey: 'floorConcrete', doorWidth: 5, doorHeight: 3.6, windows: false });
    // lift + tool bench
    b.box('metalDark', 5.0, 0.16, 2.6, 1.6, 0.24, 1.2);
    b.box('metal', 0.3, 1.6, 0.3, -0.6, 0.85, 0.1);
    b.box('metal', 0.3, 1.6, 0.3, 3.8, 0.85, 0.1);
    b.box('metal', 0.3, 1.6, 0.3, -0.6, 0.85, 2.3);
    b.box('metal', 0.3, 1.6, 0.3, 3.8, 0.85, 2.3);
    b.box('woodPale', 0.9, 0.1, 3.4, w / 2 - 1.4, 1.1, -1.0);
    for (let i = 0; i < 5; i++) {
      b.box('metalDark', 0.12, 0.4, 0.12, w / 2 - 1.7 + i * 0.14, 1.35, -2.2 + rand(-0.4, 0.4));
    }
    // tyre stacks + drums
    for (let i = 0; i < 3; i++) {
      const r = 0.42;
      b.cyl('tyre', r, r, 0.26, 12, -w / 2 + 2.2, 0.2 + i * 0.27, -d / 2 + 2.2);
    }
    b.cyl('oil', 0.42, 0.42, 1.1, 10, -w / 2 + 3.4, 0.56, d / 2 - 2.0);
    b.cyl('rust', 0.42, 0.42, 1.1, 10, -w / 2 + 4.3, 0.56, d / 2 - 2.0);
    lamp(b, 0, 0, h);
    crateStack(b, w / 2 - 2.6, -d / 2 + 2.4, 2);
    b.lootAt(-w / 2 + 2.4, 1.4);
    return { w, d, h, label: 'AUTO GARAGE', lootMult: 1.5 };
  },

  church(b) {
    const w = 12, d = 18, h = 5.4;
    shell(b, { w, d, h, wallKey: 'plaster', floorKey: 'floorWood', doorWidth: 2.8, doorHeight: 3.4 });
    // pews
    for (let i = 0; i < 6; i++) {
      const z = -d / 2 + 4 + i * 2.1;
      b.box('woodDark', 7.0, 0.12, 0.8, 0, 0.7, z);
      b.box('woodDark', 7.0, 0.9, 0.16, 0, 1.05, z + 0.3);
      b.box('woodDark', 0.2, 0.7, 0.4, -3.2, 0.35, z);
      b.box('woodDark', 0.2, 0.7, 0.4, 3.2, 0.35, z);
    }
    // altar
    b.box('woodPale', 4.0, 1.1, 1.4, 0, 0.6, -d / 2 + 2.6);
    b.box('trim', 3.2, 0.1, 1.0, 0, 1.18, -d / 2 + 2.6);
    b.box('woodDark', 0.2, 2.2, 0.2, 0, 1.6, -d / 2 + 1.6);
    b.box('woodDark', 0.9, 0.2, 0.2, 0, 2.1, -d / 2 + 1.6);
    for (let i = 0; i < 4; i++) b.sphere('lamp', 0.08, -1.2 + i * 0.8, 1.42, -d / 2 + 2.6, 6);
    // stained glass
    for (let i = 0; i < 3; i++) {
      b.box('glassLit', 0.9, 2.4, 0.1, -w / 2 + 3 + i * 2.6, h * 0.62, -d / 2 + 0.22);
    }
    crateStack(b, w / 2 - 2.4, d / 2 - 2.4, 1);
    b.lootAt(w / 2 - 2.4, 0);
    return { w, d, h, label: 'CHAPEL', lootMult: 1.3 };
  },

  clinic(b) {
    const w = 13.5, d = 10, h = 3.4;
    shell(b, { w, d, h, wallKey: 'sidingPale', floorKey: 'floorTile', doorWidth: 3.0, doorHeight: 3.0 });
    // reception + waiting chairs
    b.box('trim', 4.4, 1.05, 0.9, -1.0, 0.58, -1.2);
    b.box('woodPale', 0.45, 0.9, 0.45, 2.1, 0.5, -1.2);
    for (let i = 0; i < 3; i++) {
      b.box('fabric', 0.6, 0.1, 1.4, -3.0 + i * 0.8, 0.55, 1.6);
      b.box('fabric', 0.6, 0.55, 0.12, -3.0 + i * 0.8, 0.85, 2.25);
    }
    // examination tables with IV stands
    for (let i = 0; i < 2; i++) {
      const z = 2.4 - i * 3.4;
      b.box('metal', 2.4, 0.16, 0.9, w / 2 - 2.4, 0.72, z);
      b.box('bedding', 2.2, 0.14, 0.8, w / 2 - 2.4, 0.86, z);
      [-1.0, 1.0].forEach((dx) => b.box('metalDark', 0.1, 0.68, 0.1, w / 2 - 2.4 + dx, 0.36, z));
      b.cyl('metal', 0.04, 0.04, 1.9, 6, w / 2 - 3.9, 0.98, z);
      b.sphere('glassLit', 0.16, w / 2 - 3.9, 1.96, z, 6);
    }
    // supply cabinet + medical cross
    b.box('metal', 0.9, 2.2, 2.6, -w / 2 + 1.1, 1.1, -d / 2 + 2.4);
    b.box('glassLit', 0.1, 1.5, 2.0, -w / 2 + 1.6, 1.25, -d / 2 + 2.4);
    b.box('neonCyan', 0.9, 0.26, 0.1, 0, 2.55, -d / 2 + 0.55);
    b.box('neonCyan', 0.26, 0.9, 0.1, 0, 2.55, -d / 2 + 0.55);
    lamp(b, 1.2, 0.6, h);
    lamp(b, -2.0, 2.6, h);
    crateStack(b, w / 2 - 1.8, d / 2 - 2.0, 1);
    b.lootAt(-w / 2 + 2.4, 0.2);
    return { w, d, h, label: 'FIELD CLINIC', lootMult: 2.0 };
  },

  depot(b) {
    const w = 18, d = 13, h = 5.0;
    shell(b, { w, d, h, wallKey: 'concrete', floorKey: 'floorConcrete', doorWidth: 7, doorHeight: 4.4, windows: false });
    // parked maintenance van (hollow shell, you can walk around it)
    b.box('metalDark', 4.6, 1.9, 2.4, 2.4, 1.35, -d / 2 + 3.2);
    b.box('rust', 2.6, 1.4, 2.36, 4.4, 1.2, -d / 2 + 3.2);
    b.box('glass', 1.5, 0.8, 2.42, 0.6, 1.9, -d / 2 + 3.2);
    [-1.2, 1.2].forEach((dz) => {
      [-1.4, 1.6, 4.2].forEach((dx) => {
        b.cyl('tyre', 0.52, 0.52, 0.36, 10, 2.4 + dx, 0.52, -d / 2 + 3.2 + dz);
      });
    });
    // luggage racks + pallet stacks
    for (let i = 0; i < 3; i++) {
      b.box('metal', 3.6, 0.12, 1.2, -w / 2 + 3.2, 0.6 + i * 0.8, -d / 2 + 2.0);
      b.box('metalDark', 0.1, 0.8, 0.1, -w / 2 + 1.6, 0.4 + i * 0.8, -d / 2 + 2.0);
      b.box('metalDark', 0.1, 0.8, 0.1, -w / 2 + 4.8, 0.4 + i * 0.8, -d / 2 + 2.0);
    }
    for (let i = 0; i < 3; i++) b.box('woodPale', 1.6, 0.16, 1.4, -w / 2 + 3.4 + i * 0.2, 0.1 + i * 0.17, d / 2 - 3.0);
    // inspection pit + tool wall
    b.box('oil', 4.0, 0.05, 2.0, 1.0, 0.1, 2.6);
    b.box('woodPale', 4.4, 0.9, 0.2, -6.0, 1.4, -d / 2 + 0.6);
    for (let i = 0; i < 6; i++) b.box('metal', 0.1, 0.5, 0.12, -7.9 + i * 0.62, 1.45, -d / 2 + 0.72);
    // overhead strip lights
    for (let i = 0; i < 3; i++) b.roofBox('lamp', 3.0, 0.1, 0.3, -5.0 + i * 5.0, h - 0.35, 0);
    lamp(b, 0, 0, h);
    crateStack(b, w / 2 - 2.2, d / 2 - 2.2, 3);
    b.lootAt(w / 2 - 2.2, -d / 2 + 3.0);
    b.lootAt(-w / 2 + 3.4, d / 2 - 3.4);
    return { w, d, h, label: 'BUS DEPOT', lootMult: 1.6 };
  },

  farmhouse(b) {
    const w = 14, d = 10.5, h = 3.6;
    shell(b, { w, d, h, wallKey: 'woodDark', floorKey: 'floorWood', doorWidth: 3.0, doorHeight: 3.0 });
    // long kitchen table + benches
    b.box('woodPale', 3.6, 0.12, 1.4, 0.6, 0.76, 1.2);
    [-0.6, 1.6].forEach((dx) => [-0.15, 0.5].forEach((dz) =>
      b.box('wood', 0.12, 0.72, 0.12, 0.6 + dx, 0.36, 1.2 + dz * 2)));
    b.box('woodPale', 3.2, 0.1, 0.5, 0.6, 0.44, 0.1);
    b.box('woodPale', 3.2, 0.1, 0.5, 0.6, 0.44, 2.3);
    // wood stove with flue
    b.box('rust', 1.5, 1.3, 1.3, -w / 2 + 1.6, 0.66, -d / 2 + 1.6);
    b.box('metalDark', 1.1, 0.5, 1.34, -w / 2 + 1.6, 0.72, -d / 2 + 1.6);
    b.cyl('metalDark', 0.14, 0.14, 2.2, 8, -w / 2 + 1.6, 2.1, -d / 2 + 1.6);
    // pantry shelves + hanging pots
    b.box('wood', 3.0, 0.08, 0.6, w / 2 - 2.4, 0.9, -d / 2 + 0.9);
    b.box('wood', 3.0, 0.08, 0.6, w / 2 - 2.4, 1.6, -d / 2 + 0.9);
    for (let i = 0; i < 4; i++) b.box(pick(['goodsC', 'crate', 'goodsA']), 0.34, 0.3, 0.3, w / 2 - 3.6 + i * 0.7, 1.05, -d / 2 + 0.9);
    for (let i = 0; i < 3; i++) b.roofSphere('metalDark', 0.13, -1.0 + i * 1.1, h - 0.85, -1.0, 8);
    // bed + wardrobe
    b.box('woodDark', 2.0, 0.42, 1.6, w / 2 - 2.2, 0.3, d / 2 - 2.0);
    b.box('bedding', 1.9, 0.22, 1.5, w / 2 - 2.2, 0.6, d / 2 - 2.0);
    b.box('woodDark', 1.4, 2.0, 0.6, w / 2 - 0.9, 1.05, d / 2 - 3.6);
    lamp(b, 0.8, 1.0, h);
    lamp(b, -2.6, -2.0, h);
    crateStack(b, -w / 2 + 2.2, d / 2 - 2.0, 2);
    b.lootAt(-w / 2 + 3.4, -d / 2 + 3.2);
    b.lootAt(w / 2 - 2.2, 1.2);
    return { w, d, h, label: 'FARMHOUSE', lootMult: 1.4 };
  },

  bunker(b) {
    const w = 13, d = 11, h = 2.9;
    shell(b, { w, d, h, wallKey: 'concreteDark', floorKey: 'floorConcrete', doorWidth: 2.2, doorHeight: 2.5, windows: false });
    b.box('metalDark', 3.2, 0.5, 1.6, -w / 2 + 3.4, 0.9, -d / 2 + 2.2); // bunk
    b.box('bedding', 3.0, 0.18, 1.4, -w / 2 + 3.4, 1.2, -d / 2 + 2.2);
    b.box('metalDark', 3.2, 0.5, 1.6, w / 2 - 3.4, 0.9, -d / 2 + 2.2);
    b.box('bedding', 3.0, 0.18, 1.4, w / 2 - 3.4, 1.2, -d / 2 + 2.2);
    // lockers
    for (let i = 0; i < 4; i++) {
      b.box('metal', 0.7, 2.0, 0.6, -1.2 + i * 0.8, 1.0, -d / 2 + 0.9);
      b.box('metalDark', 0.06, 0.24, 0.06, -1.2 + i * 0.8 + 0.24, 1.2, -d / 2 + 1.22);
    }
    b.box('rust', 1.2, 1.5, 1.2, w / 2 - 2.2, 0.8, d / 2 - 2.2);
    b.box('neonCyan', 1.6, 0.3, 0.1, 0, h - 0.5, -d / 2 + 0.5);
    lamp(b, 0, 1.4, h);
    crateStack(b, 0.4, d / 2 - 2.2, 2);
    b.lootAt(w / 2 - 2.0, 0.4);
    return { w, d, h, label: 'SHELTER', lootMult: 1.8 };
  },
};

export const BUILDING_KINDS = Object.keys(KINDS);

/**
 * Creates one enterable building.
 * Local space: door on the -X wall, origin at the floor centre.
 */
export function createBuilding(kind, { x = 0, z = 0, facing = 1, scale = 1 } = {}) {
  const builder = new Builder();
  const build = KINDS[kind] || KINDS.house;
  const meta = build(builder);
  const { group, roofGroup, leaves } = builder.build();

  const s = scale;
  group.scale.setScalar(s);

  const b = {
    kind,
    group,
    roof: roofGroup,
    label: meta.label,
    lootMult: meta.lootMult || 1,
    scale: s,
    halfW: (meta.w / 2 + 0.2) * s,
    halfD: (meta.d / 2 + 0.2) * s,
    height: meta.h * s,
    // local-space snapshot: everything below is derived from this on every move
    local: { w: meta.w, d: meta.d, colliders: builder.colliders, loot: builder.loot },
    leaves,
    doorAngle: 0,
    scavengeReady: true,
    cooldown: 0,
    roofHidden: false,
    inside: false,
  };
  placeBuilding(b, { x, z, facing });
  return b;
}

/** Moves/mirrors a building and rebuilds all world-space derived data. */
export function placeBuilding(b, { x = b.x, z = b.z, facing = b.facing } = {}) {
  const s = b.scale;
  const flip = facing === 1 ? 1 : -1;
  b.x = x;
  b.z = z;
  b.facing = facing;
  b.group.position.set(x, 0, z);
  b.group.rotation.y = facing === 1 ? 0 : Math.PI;

  const toWorld = (lx, lz) => ({ x: x + lx * s * flip, z: z + lz * s * flip });

  b.colliders = b.local.colliders.map((c) => {
    const a = toWorld(c.x0 * s, c.z0 * s);
    const d = toWorld(c.x1 * s, c.z1 * s);
    return {
      x0: Math.min(a.x, d.x), x1: Math.max(a.x, d.x),
      z0: Math.min(a.z, d.z), z1: Math.max(a.z, d.z),
    };
  });
  b.lootSpots = b.local.loot.map((p) => toWorld(p.x * s, p.z * s));
  b.bounds = { x0: x - b.halfW, x1: x + b.halfW, z0: z - b.halfD, z1: z + b.halfD };
  b.interior = {
    x0: x - (b.local.w / 2 - 0.5) * s, x1: x + (b.local.w / 2 - 0.5) * s,
    z0: z - (b.local.d / 2 - 0.5) * s, z1: z + (b.local.d / 2 - 0.5) * s,
  };
  b.door = toWorld(-b.local.w / 2 - 0.9, 0);
  if (b.roof) b.roof.visible = !b.roofHidden;
  return b;
}

/**
 * Swings the door panels. `near` is whether the player is at the threshold, so
 * every building can be animated from a single distance check per frame.
 */
export function updateDoor(b, near, dt, { openAngle = 1.32 } = {}) {
  if (!b.leaves?.length) return;
  const target = near ? openAngle : 0;
  const k = near ? 7.5 : 4.5;
  b.doorAngle += (target - b.doorAngle) * Math.min(1, dt * k);
  if (Math.abs(b.doorAngle) < 0.001) b.doorAngle = 0;
  for (const pivot of b.leaves) {
    const dir = pivot.userData.dir === -1 ? -1 : 1;
    // rotate toward +X (into the building) so you never walk into a slab
    pivot.rotation.y = dir === 1 ? b.doorAngle : Math.PI - b.doorAngle;
  }
}

/** Hides the roof while the player is indoors (roof is its own group). */
export function setRoofVisible(b, visible) {
  b.roofHidden = !visible;
  if (b.roof) b.roof.visible = visible;
}

/** True when a world point is inside the building's walkable interior. */
export function pointInside(b, px, pz, margin = 0) {
  return px > b.interior.x0 - margin && px < b.interior.x1 + margin
    && pz > b.interior.z0 - margin && pz < b.interior.z1 + margin;
}

/** Circle-vs-wall test against every wall slab of a building. */
export function hitsWalls(b, px, pz, radius = 0.45) {
  for (const c of b.colliders) {
    const cx = clamp(px, c.x0, c.x1);
    const cz = clamp(pz, c.z0, c.z1);
    const dx = px - cx, dz = pz - cz;
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

/** Circle-vs-footprint test used by the car (buildings are solid to vehicles). */
export function hitsFootprint(b, px, pz, radius = 1.6) {
  const cx = clamp(px, b.bounds.x0, b.bounds.x1);
  const cz = clamp(pz, b.bounds.z0, b.bounds.z1);
  const dx = px - cx, dz = pz - cz;
  return dx * dx + dz * dz < radius * radius;
}
