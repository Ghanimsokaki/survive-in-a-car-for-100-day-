/**
 * Physical loot.
 *
 * Scavenging no longer teleports materials into your pockets — it scatters
 * stacks on the ground. Each stack is a small glowing crate that bobs, spins
 * and drifts toward you when you get close, then lands in the inventory when
 * you actually walk over it.
 */
import * as THREE from '../vendor/three.module.js';
import { rand } from './utils.js';
import { itemColor, itemGlyph, itemName } from './items.js';

const GEO = new THREE.BoxGeometry(0.34, 0.34, 0.34);
const RING_GEO = new THREE.RingGeometry(0.26, 0.4, 14);
const MATS = new Map();

function lootMat(color) {
  if (!MATS.has(color)) {
    MATS.set(color, new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.55,
      roughness: 0.42,
      metalness: 0.25,
    }));
  }
  return MATS.get(color);
}

function ringMat(color) {
  const key = `r${color}`;
  if (!MATS.has(key)) {
    MATS.set(key, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false,
    }));
  }
  return MATS.get(key);
}

let NEXT_ID = 1;

export class LootField {
  constructor(scene, { max = 80 } = {}) {
    this.scene = scene;
    this.drops = [];
    this.max = max;
    this.lastCollect = [];
  }

  /**
   * Scatters stacks around a point.
   * @param {number} x @param {number} z
   * @param {{id:string,qty:number}[]} stacks
   * @param {{spread?:number}} opts
   */
  spawn(x, z, stacks, { spread = 2.6 } = {}) {
    for (const stack of stacks) {
      if (!stack || !stack.qty) continue;
      if (this.drops.length >= this.max) this.removeOldest();
      const group = new THREE.Group();
      const color = itemColor(stack.id);
      const box = new THREE.Mesh(GEO, lootMat(color));
      box.castShadow = true;
      box.position.y = 0.28;
      const ring = new THREE.Mesh(RING_GEO, ringMat(color));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.03;
      group.add(box, ring);
      const angle = rand(0, Math.PI * 2);
      const dist = rand(0.2, spread);
      group.position.set(x + Math.cos(angle) * dist, 0, z + Math.sin(angle) * dist);
      this.scene.add(group);
      this.drops.push({
        id: NEXT_ID++,
        item: stack.id,
        qty: stack.qty,
        group,
        box,
        ring,
        phase: rand(0, Math.PI * 2),
        age: 0,
        ttl: 95,
        taken: false,
      });
    }
    return this.drops.length;
  }

  removeOldest() {
    const d = this.drops.shift();
    if (d) this.scene.remove(d.group);
  }

  clear() {
    this.drops.forEach((d) => this.scene.remove(d.group));
    this.drops.length = 0;
  }

  /**
   * Bounce/spin everything, then collect what the player is standing on.
   * @param {number} dt
   * @param {{x:number,z:number}} target
   * @param {{radius?:number, magnet?:number}} opts
   * @returns {{id:string, qty:number}[]} collected stacks this frame
   */
  update(dt, target, { radius = 1.15, magnet = 2.8 } = {}) {
    const picked = [];
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.phase += dt * 2.2;
      d.box.rotation.y += dt * 1.5;
      d.box.position.y = 0.28 + Math.sin(d.phase) * 0.07;
      d.ring.scale.setScalar(1 + Math.sin(d.phase * 0.8) * 0.08);

      const dx = target.x - d.group.position.x;
      const dz = target.z - d.group.position.z;
      const dist = Math.hypot(dx, dz);

      if (dist < magnet && dist > 0.001) {
        const pull = (1 - dist / magnet) * 3.4 * dt;
        d.group.position.x += (dx / dist) * pull;
        d.group.position.z += (dz / dist) * pull;
      }
      if (dist < radius) {
        picked.push({ id: d.item, qty: d.qty });
        this.scene.remove(d.group);
        this.drops.splice(i, 1);
        continue;
      }
      if (d.age > d.ttl) {
        this.scene.remove(d.group);
        this.drops.splice(i, 1);
      }
    }
    if (picked.length) this.lastCollect = picked;
    return picked;
  }

  /** Nearest drop for prompts ("[E] GRAB MEDKIT"). */
  nearest(x, z, maxDist = 2.4) {
    let best = null, bd = maxDist;
    for (const d of this.drops) {
      const dist = Math.hypot(d.group.position.x - x, d.group.position.z - z);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  get count() { return this.drops.length; }
}

export { itemName, itemGlyph };
