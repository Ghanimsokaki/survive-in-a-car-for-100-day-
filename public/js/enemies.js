import * as THREE from '../vendor/three.module.js';
import { rand, clamp, damp, angleLerp } from './utils.js';

const shadowed = (m) => { m.castShadow = true; return m; };
const B = (w, h, d, mat) => shadowed(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));

/** Shambling scavenger "hollow" that hunts survivors on foot. */
export class Hollow {
  constructor(scene, x, z, level = 1) {
    this.scene = scene;
    this.level = level;
    this.maxHp = 42 + level * 9;
    this.hp = this.maxHp;
    this.speed = 2.7 + Math.min(level * 0.1, 2.2);
    this.damage = 6 + level * 0.6;
    this.dead = false;
    this.attackCd = rand(0, 0.8);
    this.phase = rand(0, 10);
    this.knock = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    scene.add(this.group);

    const skin = new THREE.MeshStandardMaterial({ color: 0x6f7c63, roughness: 0.95 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x3a3f3a, roughness: 1 });
    const eye = new THREE.MeshBasicMaterial({ color: 0xffcf4a });

    const torso = B(0.6, 0.66, 0.34, cloth); torso.position.y = 1.22; this.group.add(torso);
    const head = B(0.42, 0.42, 0.42, skin); head.position.set(0, 1.75, 0.06); this.group.add(head);
    const e1 = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 6), eye); e1.position.set(0.1, 1.8, 0.26);
    const e2 = e1.clone(); e2.position.x = -0.1;
    this.group.add(e1, e2);

    this.armL = new THREE.Group(); this.armL.position.set(-0.38, 1.46, 0);
    this.armR = new THREE.Group(); this.armR.position.set(0.38, 1.46, 0);
    const a1 = B(0.16, 0.6, 0.2, skin); a1.position.y = -0.3; this.armL.add(a1);
    const a2 = a1.clone(); this.armR.add(a2);
    this.armL.rotation.x = this.armR.rotation.x = -1.25;
    this.group.add(this.armL, this.armR);

    this.legL = new THREE.Group(); this.legL.position.set(-0.16, 0.86, 0);
    this.legR = new THREE.Group(); this.legR.position.set(0.16, 0.86, 0);
    const l1 = B(0.2, 0.74, 0.24, cloth); l1.position.y = -0.37; this.legL.add(l1);
    const l2 = l1.clone(); this.legR.add(l2);
    this.group.add(this.legL, this.legR);

    this.group.rotation.y = rand(0, Math.PI * 2);
  }

  get pos() { return this.group.position; }

  hit(dmg, from) {
    this.hp -= dmg;
    if (from) {
      const dx = this.group.position.x - from.x;
      const dz = this.group.position.z - from.z;
      const d = Math.hypot(dx, dz) || 1;
      this.knock.set((dx / d) * 4.5, 0, (dz / d) * 4.5);
    }
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }

  update(dt, target, hooks) {
    if (this.dead) return;
    this.attackCd -= dt;
    const dx = target.x - this.group.position.x;
    const dz = target.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);
    const canSee = dist < 140;

    if (canSee && dist > (target.inCar ? 3.4 : 2.1)) {
      const wob = Math.sin(this.phase * 1.3 + this.group.position.x) * 0.35;
      const nx = dx / (dist || 1), nz = dz / (dist || 1);
      const sp = this.speed * (target.inCar ? 1.12 : 1);
      this.group.position.x += (nx + nz * wob * 0.4) * sp * dt;
      this.group.position.z += (nz - nx * wob * 0.4) * sp * dt;
      const want = Math.atan2(dx, dz);
      this.group.rotation.y = angleLerp(this.group.rotation.y, want, clamp(dt * 5, 0, 1));
    } else if (canSee && this.attackCd <= 0) {
      this.attackCd = 1.15;
      hooks.onAttack?.(this);
    }

    // knockback decay
    this.group.position.x += this.knock.x * dt;
    this.group.position.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.exp(-6 * dt));

    // animation
    this.phase += dt * 6.4;
    const s = Math.sin(this.phase);
    this.legL.rotation.x = s * 0.7;
    this.legR.rotation.x = -s * 0.7;
    this.armL.rotation.x = -1.25 + Math.sin(this.phase * 1.1) * 0.16;
    this.armR.rotation.x = -1.25 - Math.sin(this.phase * 1.1) * 0.16;
    this.group.position.y = Math.abs(Math.sin(this.phase)) * 0.05;
  }
}

/** Ragged raider muscle-car that hunts the player's rig. */
export class RaiderCar {
  constructor(scene, x, z, level = 1, boss = false) {
    this.scene = scene;
    this.boss = boss;
    this.level = level;
    this.maxHp = (boss ? 520 : 130) + level * 14;
    this.hp = this.maxHp;
    this.speed = boss ? 25 : 19 + Math.min(level * 0.35, 8);
    this.damage = boss ? 22 : 9 + level * 0.3;
    this.dead = false;
    this.ramCd = rand(0, 1);
    this.yaw = rand(0, Math.PI * 2);
    this.vel = new THREE.Vector3();
    this.wheelSpin = 0;
    this.hitFlash = 0;
    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    scene.add(this.group);

    const g = this.group;
    const paint = new THREE.MeshStandardMaterial({ color: boss ? 0x77252b : 0x4a4034, roughness: 0.6, metalness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.7 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x7c4326, roughness: 0.9 });
    const spike = new THREE.MeshStandardMaterial({ color: 0x9aa2ad, metalness: 0.9, roughness: 0.3 });

    const hull = B(2.0, 0.66, 4.2, paint); hull.position.y = 0.8; g.add(hull);
    const cab = B(1.7, 0.66, 1.9, paint); cab.position.set(0, 1.32, -0.3); g.add(cab);
    const skirt = B(1.84, 0.28, 4.0, dark); skirt.position.y = 0.5; g.add(skirt);
    const bar = B(2.2, 0.28, 0.3, rust); bar.position.set(0, 0.72, 2.2); g.add(bar);
    for (let i = 0; i < 6; i++) {
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.6, 4), spike);
      sp.rotation.x = Math.PI / 2;
      sp.position.set(-0.85 + i * 0.34, 0.75, 2.5);
      g.add(sp);
    }
    const lightMat = new THREE.MeshBasicMaterial({ color: 0xff3b3b });
    [-0.7, 0.7].forEach((x2) => {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 0.08), lightMat);
      l.position.set(x2, 0.96, 2.12); g.add(l);
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.14, 0.06), lightMat);
      r.position.set(x2, 0.96, -2.14); g.add(r);
    });
    // roof turret silhouette
    if (boss) {
      const turret = B(0.5, 0.5, 0.5, dark); turret.position.set(0, 1.9, -0.2); g.add(turret);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.6, 6), spike);
      barrel.rotation.x = Math.PI / 2; barrel.position.set(0, 1.95, 0.7); g.add(barrel);
      g.scale.setScalar(1.18);
    }

    const wheelGeo = new THREE.CylinderGeometry(0.46, 0.46, 0.36, 12);
    wheelGeo.rotateZ(Math.PI / 2);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121418, roughness: 1 });
    this.wheels = [];
    [[0.98, 1.34], [-0.98, 1.34], [0.98, -1.34], [-0.98, -1.34]].forEach(([x2, z2]) => {
      const w = new THREE.Mesh(wheelGeo, tyreMat);
      w.position.set(x2, 0.46, z2); w.castShadow = true;
      g.add(w); this.wheels.push(w);
    });
  }

  get pos() { return this.group.position; }

  hit(dmg) {
    this.hp -= dmg;
    this.hitFlash = 0.18;
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }

  update(dt, target, hooks) {
    if (this.dead) return;
    this.ramCd -= dt;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const dx = target.x - this.group.position.x;
    const dz = target.z - this.group.position.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 330) {
      const want = Math.atan2(dx, dz);
      // steer toward the target with a slight weave for menace
      let diff = ((want - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      const weave = Math.sin(performance.now() * 0.0012 + this.group.position.x) * 0.22;
      this.yaw += clamp(diff + weave, -1.6, 1.6) * dt * 1.35;
      const drive = dist > 6 ? this.speed : this.speed * 0.4;
      this.group.position.x += Math.sin(this.yaw) * drive * dt;
      this.group.position.z += Math.cos(this.yaw) * drive * dt;
      this.wheelSpin += drive * dt / 0.46;
      this.wheels.forEach((w) => (w.rotation.x = this.wheelSpin));
      hooks.onDust?.(this.group.position, drive);
    }

    this.group.rotation.y = this.yaw;
    this.group.position.y = Math.sin(this.wheelSpin * 0.5) * 0.02;
    const flash = this.hitFlash > 0 ? 0xff5533 : 0x000000;
    this.group.traverse((o) => {
      if (o.isMesh && o.material && o.material.emissive) o.material.emissive.setHex(flash);
    });

    if (dist < 4.6 && this.ramCd <= 0) {
      this.ramCd = 1.25;
      hooks.onRam?.(this);
    }
  }
}
