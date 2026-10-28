import * as THREE from '../vendor/three.module.js';
import { rand, clamp, damp } from './utils.js';

const CAT_DATA = {
  1: { radius: 52, strength: 5.5, height: 62, wind: 'GALE' },
  2: { radius: 66, strength: 9, height: 78, wind: 'F1' },
  3: { radius: 82, strength: 14, height: 96, wind: 'F3' },
  4: { radius: 100, strength: 20, height: 118, wind: 'F4' },
  5: { radius: 122, strength: 28, height: 150, wind: 'F5 HYPERCANE' },
};

/** A drifting vortex that yanks vehicles and survivors toward its core. */
export class Tornado {
  constructor(scene, category = 2, origin = new THREE.Vector3()) {
    this.scene = scene;
    this.category = clamp(category, 1, 5);
    const d = CAT_DATA[this.category];
    this.radius = d.radius;
    this.strength = d.strength;
    this.height = d.height;
    this.wind = d.wind;
    this.life = 0;
    this.maxLife = rand(70, 120);
    this.dead = false;
    this.group = new THREE.Group();
    this.group.position.copy(origin);
    this.group.position.y = 0;
    this.spin = 0;
    this.drift = new THREE.Vector3(rand(-1, 1), 0, rand(-1.6, 1.6));
    if (this.drift.length() < 0.4) this.drift.set(0.6, 0, 0.5);

    // funnel shell built from a lathe so it tapers naturally
    const pts = [];
    const steps = 18;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const r = (2.2 + Math.pow(t, 1.7) * 26) * (this.category / 3 + 0.55);
      pts.push(new THREE.Vector2(r, t * this.height));
    }
    const shellGeo = new THREE.LatheGeometry(pts, 30);
    this.shellMat = new THREE.MeshBasicMaterial({
      color: 0x4a4f57, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this.shell = new THREE.Mesh(shellGeo, this.shellMat);
    this.shell.renderOrder = 3;
    this.group.add(this.shell);

    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0x2b2f36, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const core = new THREE.Mesh(shellGeo, this.coreMat);
    core.scale.set(0.62, 0.92, 0.62);
    this.group.add(core);
    this.core = core;

    // swirl debris
    const count = 620;
    const pos = new Float32Array(count * 3);
    this.pdata = [];
    for (let i = 0; i < count; i++) {
      const t = Math.pow(Math.random(), 0.75);
      const r = (3 + t * 30) * (this.category / 3 + 0.5);
      const a = rand(0, Math.PI * 2);
      const y = t * this.height;
      this.pdata.push({ a, r, y, speed: rand(2.2, 5.4) * (0.7 + (1 - t)), bob: rand(0, 6.28) });
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.debris = new THREE.Points(pg, new THREE.PointsMaterial({
      color: 0xb9b1a2, size: 0.9, transparent: true, opacity: 0.75, depthWrite: false,
    }));
    this.group.add(this.debris);

    // ground dust ring
    const ringGeo = new THREE.RingGeometry(4, 34 * (this.category / 3 + 0.6), 44);
    ringGeo.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0x8d7c62, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false,
    }));
    this.ring.position.y = 0.15;
    this.group.add(this.ring);

    // storm cloud cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(this.radius * 0.9, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x3c4149, transparent: true, opacity: 0.35, depthWrite: false }));
    cap.position.y = this.height * 0.94;
    cap.scale.y = 0.32;
    this.group.add(cap);

    scene.add(this.group);
  }

  get position() { return this.group.position; }
  get pos() { return this.group.position; }

  /** Force applied at a world position, falloff by distance. */
  forceAt(x, z) {
    const dx = this.group.position.x - x;
    const dz = this.group.position.z - z;
    const d = Math.hypot(dx, dz);
    if (d > this.radius) return null;
    const t = 1 - d / this.radius;
    return {
      x: (dx / (d || 1)) * this.strength * Math.pow(t, 0.8),
      z: (dz / (d || 1)) * this.strength * Math.pow(t, 0.8),
      lift: this.strength * 0.55 * Math.pow(t, 1.4),
      strength: t,
      dist: d,
    };
  }

  update(dt, focus) {
    this.life += dt;
    this.spin += dt * (2.6 + this.category * 0.5);
    // drift, biased to stay near the player
    const toPlayer = new THREE.Vector3(focus.x - this.group.position.x, 0, focus.z - this.group.position.z);
    const dist = toPlayer.length();
    if (dist > 300) toPlayer.normalize().multiplyScalar(6);
    else if (dist > 70) toPlayer.normalize().multiplyScalar(1.4);
    else toPlayer.multiplyScalar(-0.05);
    this.drift.x = damp(this.drift.x, clamp(this.drift.x + toPlayer.x * dt, -8, 8), 1.2, dt);
    this.drift.z = damp(this.drift.z, clamp(this.drift.z + toPlayer.z * dt, -8, 8), 1.2, dt);
    this.group.position.x += this.drift.x * dt;
    this.group.position.z += this.drift.z * dt;
    this.group.position.x = clamp(this.group.position.x, -210, 210);

    // visuals
    this.shell.rotation.y = this.spin * 0.32;
    this.core.rotation.y = -this.spin * 0.6;
    this.ring.rotation.y = this.spin * 0.5;
    this.ring.scale.setScalar(1 + Math.sin(this.life * 2.2) * 0.05);
    this.ring.material.opacity = 0.18 + Math.sin(this.life * 3) * 0.06;

    const arr = this.debris.geometry.attributes.position.array;
    for (let i = 0; i < this.pdata.length; i++) {
      const p = this.pdata[i];
      p.a += dt * p.speed;
      const r = p.r * (1 + Math.sin(this.life * 1.5 + p.bob) * 0.05);
      arr[i * 3] = Math.cos(p.a) * r;
      arr[i * 3 + 1] = p.y + Math.sin(this.life * 2 + p.bob) * 0.8;
      arr[i * 3 + 2] = Math.sin(p.a) * r;
    }
    this.debris.geometry.attributes.position.needsUpdate = true;
    this.shellMat.opacity = 0.36 + Math.sin(this.life * 4) * 0.05;

    if (this.life > this.maxLife) this.dissipate();
    return !this.dead;
  }

  dissipate() {
    this.dead = true;
    this.scene.remove(this.group);
    this.shell.geometry.dispose();
    this.shellMat.dispose();
    this.coreMat.dispose();
    this.debris.geometry.dispose();
    this.debris.material.dispose();
  }
}
