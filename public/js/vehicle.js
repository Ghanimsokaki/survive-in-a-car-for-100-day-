import * as THREE from '../vendor/three.module.js';
import { clamp, damp, lerp } from './utils.js';

const roundBox = (w, h, d, mat) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
};

/** Builds a chunky, detailed post-apocalyptic highway rig. Faces +Z. */
export function buildCar({ color = 0xd24a2b, armored = 0, anchorTier = 1, lights = true } = {}) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0.55 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d2028, roughness: 0.7, metalness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x14202b, roughness: 0.12, metalness: 0.85, transparent: true, opacity: 0.82 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x6d757f, roughness: 0.35, metalness: 0.9 });
  const rust = new THREE.MeshStandardMaterial({ color: 0x703d26, roughness: 0.9, metalness: 0.2 });

  // main tub
  const tub = roundBox(1.92, 0.56, 4.28, paint); tub.position.y = 0.74; body.add(tub);
  const skirt = roundBox(1.74, 0.34, 3.97, dark); skirt.position.y = 0.48; body.add(skirt);
  // hood + trunk shaping
  const hood = roundBox(1.78, 0.16, 1.32, paint); hood.position.set(0, 1.01, 1.42); body.add(hood);
  const trunk = roundBox(1.82, 0.18, 0.86, paint); trunk.position.set(0, 1.02, -1.66); body.add(trunk);
  // cabin
  const cabin = roundBox(1.66, 0.62, 2.16, paint); cabin.position.set(0, 1.28, -0.24); body.add(cabin);
  const windscreen = roundBox(1.6, 0.5, 0.06, glass); windscreen.position.set(0, 1.36, 0.85); windscreen.rotation.x = -0.26; body.add(windscreen);
  const rearGlass = roundBox(1.6, 0.46, 0.06, glass); rearGlass.position.set(0, 1.36, -1.32); rearGlass.rotation.x = 0.22; body.add(rearGlass);
  const sideGlassR = roundBox(0.05, 0.38, 1.72, glass); sideGlassR.position.set(0.85, 1.38, -0.22); body.add(sideGlassR);
  const sideGlassL = sideGlassR.clone(); sideGlassL.position.x = -0.85; body.add(sideGlassL);

  // bumpers, bull bar, spoiler
  const frontBar = roundBox(2.0, 0.24, 0.28, steel); frontBar.position.set(0, 0.62, 2.2); body.add(frontBar);
  const bull = new THREE.Group();
  const bullPost1 = roundBox(0.1, 0.86, 0.1, steel); bullPost1.position.set(0.42, 0.9, 2.26); bull.add(bullPost1);
  const bullPost2 = bullPost1.clone(); bullPost2.position.x = -0.42; bull.add(bullPost2);
  const bullTop = roundBox(0.96, 0.1, 0.1, steel); bullTop.position.set(0, 1.28, 2.26); bull.add(bullTop);
  body.add(bull);
  const rearBar = roundBox(1.98, 0.22, 0.24, steel); rearBar.position.set(0, 0.6, -2.16); body.add(rearBar);
  const spoiler = roundBox(1.7, 0.08, 0.42, dark); spoiler.position.set(0, 1.42, -1.94); body.add(spoiler);
  const spoilerL = roundBox(0.09, 0.3, 0.1, dark); spoilerL.position.set(0.6, 1.28, -1.94); body.add(spoilerL);
  const spoilerR = spoilerL.clone(); spoilerR.position.x = -0.6; body.add(spoilerR);

  // roof rack with cargo
  const rack = new THREE.Group();
  const rbar1 = roundBox(1.5, 0.07, 0.08, steel); rbar1.position.set(0, 1.62, 0.42); rack.add(rbar1);
  const rbar2 = rbar1.clone(); rbar2.position.z = -0.86; rack.add(rbar2);
  const rbar3 = roundBox(0.07, 0.07, 1.36, steel); rbar3.position.set(0.66, 1.62, -0.22); rack.add(rbar3);
  const rbar4 = rbar3.clone(); rbar4.position.x = -0.66; rack.add(rbar4);
  const crate = roundBox(0.62, 0.34, 0.72, rust); crate.position.set(-0.34, 1.8, -0.2); rack.add(crate);
  const jerry = roundBox(0.3, 0.42, 0.2, new THREE.MeshStandardMaterial({ color: 0xb5432a, roughness: 0.8 }));
  jerry.position.set(0.42, 1.85, -0.3); rack.add(jerry);
  body.add(rack);

  // lights
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff2c4, emissive: 0xffd98a, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xff4455, emissive: 0xff2233, emissiveIntensity: 1.6 });
  const hlL = roundBox(0.38, 0.18, 0.08, lampMat); hlL.position.set(0.66, 0.92, 2.15); body.add(hlL);
  const hlR = hlL.clone(); hlR.position.x = -0.66; body.add(hlR);
  const tlL = roundBox(0.34, 0.16, 0.06, tailMat); tlL.position.set(0.68, 0.92, -2.14); body.add(tlL);
  const tlR = tlL.clone(); tlR.position.x = -0.68; body.add(tlR);

  // headlight beams
  const beams = [];
  if (lights) [-0.66, 0.66].forEach((x) => {
    const spot = new THREE.SpotLight(0xffe6b8, 26, 62, 0.44, 0.55, 1.4);
    spot.position.set(x, 0.95, 2.16);
    spot.target.position.set(x * 1.4, 0.1, 20);
    body.add(spot, spot.target);
    beams.push(spot);
  });

  // wheels
  const wheelGeo = new THREE.CylinderGeometry(0.44, 0.44, 0.34, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.36, 10);
  rimGeo.rotateZ(Math.PI / 2);
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.96 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x9198a2, roughness: 0.4, metalness: 0.85 });
  const wheels = [];
  const wheelHi = [];
  [[0.97, 1.36, true], [-0.97, 1.36, true], [0.97, -1.36, false], [-0.97, -1.36, false]].forEach(([x, z, front]) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.44, z);
    const tyre = new THREE.Mesh(wheelGeo, tyreMat); tyre.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    pivot.add(tyre, rim);
    body.add(pivot);
    wheels.push({ pivot, tyre, front, x });
    wheelHi.push(pivot);
    // suspension arm
    const arm = roundBox(0.1, 0.1, 0.3, steel);
    arm.position.set(x * 0.86, 0.52, z);
    body.add(arm);
  });

  // anchor spikes (deployable)
  const spikes = [];
  const spikeGeo = new THREE.ConeGeometry(0.15, 0.72, 6);
  const spikeMat = new THREE.MeshStandardMaterial({ color: 0xb9c2cf, metalness: 0.95, roughness: 0.25 });
  [[0.84, 1.22], [-0.84, 1.22], [0.84, -1.22], [-0.84, -1.22]].forEach(([x, z]) => {
    const s = new THREE.Mesh(spikeGeo, spikeMat);
    s.position.set(x, 0.16, z);
    s.rotation.x = Math.PI;
    s.castShadow = true;
    s.visible = false;
    body.add(s);
    spikes.push(s);
  });

  // armor package (revealed by upgrades)
  const armor = new THREE.Group();
  const plateMat = new THREE.MeshStandardMaterial({ color: 0x4a5058, roughness: 0.5, metalness: 0.85 });
  const pR = roundBox(0.12, 0.5, 3.4, plateMat); pR.position.set(0.98, 0.78, -0.1); armor.add(pR);
  const pL = pR.clone(); pL.position.x = -0.98; armor.add(pL);
  const pF = roundBox(1.9, 0.52, 0.12, plateMat); pF.position.set(0, 0.8, 2.18); armor.add(pF);
  const pB = pF.clone(); pB.position.z = -2.18; armor.add(pB);
  const spikesFront = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.4, 4), spikeMat);
    sp.rotation.x = Math.PI / 2;
    sp.position.set(-0.7 + i * 0.35, 0.55, 2.34);
    spikesFront.add(sp);
  }
  armor.add(spikesFront);
  armor.visible = false;
  body.add(armor);

  // low-engine smoke emitters handled by game particles; marker positions:
  const exhaust = new THREE.Object3D();
  exhaust.position.set(-0.55, 0.42, -2.2);
  body.add(exhaust);

  function setAnchored(on, tier = 1) {
    spikes.forEach((s, i) => {
      s.visible = on;
      s.scale.setScalar(tier >= 3 ? 1.35 : 1);
      s.position.y = on ? 0.02 : 0.16;
    });
  }
  function setArmor(level) {
    armor.visible = level > 0;
    armor.scale.set(1, 1, 1);
  }
  function setColor(hex) { paint.color.setHex(hex); }

  setArmor(armored);
  setAnchored(false, anchorTier);

  return { group, body, wheels, spikes, setAnchored, setArmor, setColor, exhaust, beams, materials: { paint, dark, steel, glass } };
}

/** Arcade driving model + damage state for one vehicle. */
export class Vehicle {
  constructor({ color = 0xd24a2b, lights = true } = {}) {
    this.mesh = buildCar({ color, lights });
    this.group = this.mesh.group;
    this.group.position.set(0, 0, 0);
    this.yaw = Math.PI;         // facing -Z, the open highway
    this.speed = 0;             // m/s forward
    this.lateral = 0;
    this.pos = this.group.position;
    this.engine = 100;
    this.chassis = 100;
    this.tires = 100;
    this.fuel = 20;
    this.maxFuel = 60;
    this.anchored = false;
    this.armorLevel = 0;
    this.anchorTier = 1;
    this.occupied = true;
    this.wheelSpin = 0;
    this.steer = 0;
    this.hitTimer = 0;
    this.boost = 0;
    this.dead = false;
    this.grounded = true;
    this.airY = 0;
    this.vertical = 0;
    this.distance = 0;
    this.smokeTimer = 0;
  }

  get forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  get kmh() { return Math.abs(this.speed) * 3.6; }

  damage(amount, part = 'chassis') {
    this.hitTimer = 0.35;
    if (part === 'engine') this.engine = clamp(this.engine - amount, 0, 100);
    else if (part === 'tires') this.tires = clamp(this.tires - amount, 0, 100);
    else this.chassis = clamp(this.chassis - amount * (this.armorLevel ? 0.72 : 1), 0, 100);
    if (this.chassis <= 0) this.dead = true;
  }

  toggleAnchor(force) {
    if (Math.abs(this.speed) > 13 && !this.anchored) return false;
    this.anchored = force === undefined ? !this.anchored : !!force;
    this.mesh.setAnchored(this.anchored, this.anchorTier);
    if (this.anchored) this.speed *= 0.2;
    return true;
  }

  upgradeAnchor() {
    this.anchorTier = Math.min(4, this.anchorTier + 1);
    this.mesh.setAnchored(this.anchored, this.anchorTier);
  }
  upgradeArmor() {
    this.armorLevel = Math.min(3, this.armorLevel + 1);
    this.mesh.setArmor(this.armorLevel);
    this.chassis = clamp(this.chassis + 12, 0, 100);
  }

  update(dt, ctrl, world, onScrape) {
    const throttle = ctrl.forward;
    const braking = ctrl.back;
    this.hitTimer = Math.max(0, this.hitTimer - dt);

    if (this.dead) {
      this.speed = damp(this.speed, 0, 3, dt);
      this.group.position.addScaledVector(this.forward, this.speed * dt);
      return;
    }

    const hasFuel = this.fuel > 0;
    const engineFactor = this.engine <= 0 ? 0.06 : clamp(this.engine / 100, 0.24, 1);
    const offroad = world.isOffroad(this.pos.x);
    const tireFactor = clamp(0.45 + this.tires / 180, 0.45, 1);

    if (this.anchored) {
      this.speed = damp(this.speed, 0, 6, dt);
    } else {
      const boosting = ctrl.boost && this.fuel > 0.4 && throttle > 0.1 && this.engine > 8;
      this.boost = damp(this.boost, boosting ? 1 : 0, 6, dt);
      const maxSpeed = hasFuel
        ? (offroad ? 17 : 46) * engineFactor * (0.85 + this.tires / 660) + this.boost * 13
        : 6;

      if (throttle > 0.05 && hasFuel) {
        const accel = (offroad ? 8 : 12.5) * engineFactor * (1 + this.boost * 0.9);
        this.speed += accel * throttle * dt;
      }
      if (braking > 0.05) {
        if (this.speed > 0.4) this.speed -= 20 * braking * dt;
        else this.speed -= 6.5 * braking * dt * engineFactor;
      }
      // drag + rolling resistance
      const drag = 0.42 + (offroad ? 1.5 : 0) + (1 - tireFactor) * 0.5;
      this.speed -= this.speed * drag * dt;
      if (throttle < 0.05 && braking < 0.05) this.speed -= Math.sign(this.speed) * 2.1 * dt;

      this.speed = clamp(this.speed, -11, maxSpeed);
      if (Math.abs(this.speed) < 0.08) this.speed = 0;
    }

    // steering
    const steerIn = ctrl.left - ctrl.right;
    const speedAbs = Math.abs(this.speed);
    const steerAuthority = clamp(1.35 - speedAbs / 42, 0.42, 1.3) * clamp(speedAbs / 4, 0, 1) * Math.sign(this.speed || 1);
    const targetSteer = steerIn * steerAuthority;
    this.steer = damp(this.steer, targetSteer, 8, dt);
    this.yaw += this.steer * 1.55 * dt;
    this.lateral = damp(this.lateral, -this.steer * speedAbs * 0.06, 4, dt);

    // apply motion
    const fwd = this.forward;
    this.pos.x += (fwd.x * this.speed + Math.cos(this.yaw) * this.lateral) * dt;
    this.pos.z += (fwd.z * this.speed - Math.sin(this.yaw) * this.lateral) * dt;
    this.distance += Math.abs(this.speed) * dt;

    // keep on the map
    if (Math.abs(this.pos.x) > 232) {
      this.pos.x = Math.sign(this.pos.x) * 232;
      this.speed *= 0.4;
      this.damage(6, 'chassis');
    }

    // prop collisions
    const hit = world.collide(this.pos.x, this.pos.z, 1.6);
    if (hit && speedAbs > 3.5) {
      const dmg = clamp(speedAbs * 0.55, 2, 22);
      this.damage(dmg, 'chassis');
      this.damage(dmg * 0.4, 'tires');
      this.speed *= -0.16;
      if (onScrape) onScrape(dmg, hit);
    }

    // fuel burn
    if (this.engine > 0 && this.fuel > 0) {
      const burn = (0.012 + Math.abs(throttle) * 0.15 + speedAbs / 1500) * (this.boost > 0.4 ? 2.6 : 1);
      this.fuel = clamp(this.fuel - burn * dt, 0, this.maxFuel);
    }

    // visual: wheels & body
    this.wheelSpin += this.speed * dt / 0.44;
    this.mesh.wheels.forEach((w) => {
      w.tyre.rotation.x = this.wheelSpin;
      if (w.front) w.pivot.rotation.y = this.steer * 0.42;
    });
    this.group.rotation.y = this.yaw;
    const bump = Math.abs(this.speed) > 1 ? Math.sin(this.wheelSpin * 0.6) * 0.006 : 0;
    this.mesh.body.position.y = bump;
    this.mesh.body.rotation.z = -this.steer * 0.045 * clamp(speedAbs / 20, 0, 1);
    this.mesh.body.rotation.x = clamp(-throttle * 0.012, -0.02, 0.02);
    this.mesh.group.position.y = this.airY;
  }
}
