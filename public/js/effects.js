import * as THREE from '../vendor/three.module.js';
import { rand } from './utils.js';

const MAX = 900;

/** One pooled point cloud for sparks, smoke, blood and explosions. */
export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.parts = [];
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = -9999;
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({
      size: 0.62, vertexColors: true, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.geo = geo;
  }

  emit(pos, count, { color = 0xffaa33, spread = 3.4, up = 3.2, life = 0.8, gravity = 9, size = 0.6, drag = 2.2 } = {}) {
    const c = new THREE.Color(color);
    for (let i = 0; i < count; i++) {
      if (this.parts.length >= MAX) this.parts.shift();
      this.parts.push({
        x: pos.x + rand(-0.4, 0.4), y: pos.y + rand(-0.2, 0.4), z: pos.z + rand(-0.4, 0.4),
        vx: rand(-spread, spread), vy: rand(0.4, up), vz: rand(-spread, spread),
        life: rand(life * 0.6, life * 1.2), max: life,
        r: c.r, g: c.g, b: c.b, gravity, size, drag,
      });
    }
  }

  smoke(pos, count = 6, dark = false) {
    this.emit(pos, count, {
      color: dark ? 0x3a3d44 : 0x8d8f95, spread: 0.9, up: 1.8, life: 1.6, gravity: -1.2, drag: 1.1,
    });
  }

  explosion(pos, power = 1) {
    this.emit(pos, 42, { color: 0xffb347, spread: 9 * power, up: 12 * power, life: 0.9, gravity: 11, drag: 1.6 });
    this.emit(pos, 22, { color: 0xff5b33, spread: 5 * power, up: 7 * power, life: 1.3, gravity: 6, drag: 1.4 });
    this.emit(pos, 18, { color: 0x33353b, spread: 3.4, up: 5, life: 2.2, gravity: -2, drag: 1 });
  }

  blood(pos, dir) {
    this.emit(pos, 12, { color: 0xb3202f, spread: 2.2, up: 3.4, life: 0.7, gravity: 12, drag: 2 });
  }

  update(dt) {
    const live = [];
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.gravity * dt;
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vz *= d;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.32; p.vx *= 0.6; p.vz *= 0.6; }
      live.push(p);
    }
    this.parts = live;
    for (let i = 0; i < MAX; i++) {
      if (i < this.parts.length) {
        const p = this.parts[i];
        this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
        const f = Math.max(0, p.life / p.max);
        this.col[i * 3] = p.r * f; this.col[i * 3 + 1] = p.g * f; this.col[i * 3 + 2] = p.b * f;
      } else {
        this.pos[i * 3 + 1] = -9999;
        this.col[i * 3] = this.col[i * 3 + 1] = this.col[i * 3 + 2] = 0;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
