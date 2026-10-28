import * as THREE from '../vendor/three.module.js';
import { canvasTex, clamp, damp } from './utils.js';

const BODY_MAT = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.72, metalness: 0.04 });

function faceTexture() {
  const c = canvasTex(128, 128, (ctx) => {
    ctx.clearRect(0, 0, 128, 128);
    // eyes
    ctx.fillStyle = '#14161d';
    ctx.beginPath(); ctx.ellipse(44, 54, 8, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(84, 54, 8, 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(47, 50, 3, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(87, 50, 3, 3.6, 0, 0, Math.PI * 2); ctx.fill();
    // determined mouth
    ctx.strokeStyle = '#14161d';
    ctx.lineWidth = 5; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(48, 90); ctx.lineTo(80, 90); ctx.stroke();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function nameTexture(name, color) {
  const c = canvasTex(512, 128, (ctx) => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = 'bold 52px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(4,6,10,.62)';
    const w = ctx.measureText(name).width + 56;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(256 - w / 2, 18, w, 70, 16);
    else ctx.rect(256 - w / 2, 18, w, 70);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.fillText(name, 256, 52);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Builds a blocky, Roblox-inspired humanoid survivor. Faces +Z, feet at y = 0. */
export function buildAvatar({ color = 0xffb347, name = 'WANDERER' } = {}) {
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);

  const skin = BODY_MAT(color);
  const shirt = BODY_MAT(0x2b3140);
  const pants = BODY_MAT(0x36302a);
  const boot = BODY_MAT(0x1c1f26);
  const hand = BODY_MAT(0xc98d6b);

  const cast = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d, mat) => cast(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat));

  // torso
  const torso = box(0.66, 0.7, 0.36, skin);
  torso.position.y = 1.24;
  rig.add(torso);
  const vest = box(0.7, 0.5, 0.4, shirt);
  vest.position.set(0, 1.16, 0.01);
  rig.add(vest);
  const belt = box(0.7, 0.11, 0.39, boot);
  belt.position.y = 0.87;
  rig.add(belt);

  // head
  const headMats = [skin, skin, skin, skin, new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.8 }), skin];
  const head = cast(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.52), headMats));
  head.position.y = 1.86;
  rig.add(head);
  // beanie / hood
  const cap = box(0.56, 0.14, 0.56, shirt);
  cap.position.y = 2.16;
  rig.add(cap);
  const brim = box(0.56, 0.06, 0.16, shirt);
  brim.position.set(0, 2.08, 0.27);
  rig.add(brim);

  // arms
  const mkArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.42, 1.5, 0);
    const upper = box(0.2, 0.62, 0.24, skin);
    upper.position.y = -0.31;
    pivot.add(upper);
    const glove = box(0.22, 0.18, 0.26, hand);
    glove.position.y = -0.66;
    pivot.add(glove);
    rig.add(pivot);
    return pivot;
  };
  const armR = mkArm(1);
  const armL = mkArm(-1);

  // legs
  const mkLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.18, 0.86, 0);
    const leg = box(0.25, 0.74, 0.28, pants);
    leg.position.y = -0.37;
    pivot.add(leg);
    const shoe = box(0.28, 0.16, 0.4, boot);
    shoe.position.set(0, -0.78, 0.05);
    pivot.add(shoe);
    rig.add(pivot);
    return pivot;
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  // shoulder lamp (reads nicely at night)
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffc46b })
  );
  lamp.position.set(-0.26, 1.45, 0.2);
  rig.add(lamp);

  // name tag
  const tagMat = new THREE.SpriteMaterial({ map: nameTexture(name, '#ffd9a0'), transparent: true, depthTest: false });
  const tag = new THREE.Sprite(tagMat);
  tag.position.y = 2.55;
  tag.scale.set(2.6, 0.65, 1);
  tag.renderOrder = 20;
  root.add(tag);

  // held weapon mount on right hand
  const weaponMount = new THREE.Group();
  weaponMount.position.set(0, -0.72, 0.06);
  armR.add(weaponMount);

  let weaponId = 'fists';
  let weaponMesh = null;
  const WEAPON_COLORS = { bat: 0x9a7b52, machete: 0xb9c2cc, katana: 0xd7e4ef, broadsword: 0xcfb47a, pipe: 0x6f7783 };
  const weaponFactory = {
    fists: null,
    pipe: () => {
      const m = box(0.09, 0.9, 0.09, new THREE.MeshStandardMaterial({ color: WEAPON_COLORS.pipe, metalness: 0.8, roughness: 0.4 }));
      m.position.y = -0.2; return m;
    },
    bat: () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.05, 8),
        new THREE.MeshStandardMaterial({ color: WEAPON_COLORS.bat, roughness: 0.85 }));
      m.position.y = -0.25; m.castShadow = true; return m;
    },
    machete: () => {
      const m = box(0.06, 1.0, 0.2, new THREE.MeshStandardMaterial({ color: WEAPON_COLORS.machete, metalness: 0.85, roughness: 0.3 }));
      m.position.y = -0.3; return m;
    },
    katana: () => {
      const g = new THREE.Group();
      const blade = box(0.045, 1.45, 0.11, new THREE.MeshStandardMaterial({ color: WEAPON_COLORS.katana, metalness: 0.95, roughness: 0.18 }));
      blade.position.y = -0.55;
      const guard = box(0.2, 0.05, 0.2, new THREE.MeshStandardMaterial({ color: 0x3a2f22, metalness: 0.7 }));
      guard.position.y = 0.15;
      g.add(blade, guard);
      return g;
    },
    broadsword: () => {
      const g = new THREE.Group();
      const blade = box(0.12, 1.7, 0.28, new THREE.MeshStandardMaterial({ color: WEAPON_COLORS.broadsword, metalness: 0.9, roughness: 0.25 }));
      blade.position.y = -0.6;
      const guard = box(0.44, 0.09, 0.36, new THREE.MeshStandardMaterial({ color: 0x2a2a33, metalness: 0.8 }));
      guard.position.y = 0.2;
      g.add(blade, guard);
      return g;
    },
    revolver: () => {
      const g = new THREE.Group();
      const barrel = box(0.09, 0.42, 0.1, new THREE.MeshStandardMaterial({ color: 0x8b929c, metalness: 0.9, roughness: 0.3 }));
      barrel.position.set(0, -0.12, 0.2); barrel.rotation.x = Math.PI / 2;
      const grip = box(0.1, 0.24, 0.12, new THREE.MeshStandardMaterial({ color: 0x5b3b28 }));
      grip.position.set(0, -0.3, 0.02);
      g.add(barrel, grip);
      return g;
    },
  };

  function setWeapon(id) {
    weaponId = id;
    if (weaponMesh) { weaponMount.remove(weaponMesh); weaponMesh = null; }
    const f = weaponFactory[id];
    if (f) {
      weaponMesh = f();
      weaponMount.add(weaponMesh);
    }
  }

  let phase = Math.random() * 10;
  let swing = 0;
  const baseArmR = armR.rotation.x;

  function animate(dt, moving = 0, airborne = false) {
    phase += dt * (4.6 + moving * 5.5);
    swing = damp(swing, 0, 8, dt);
    const amp = clamp(moving, 0, 1) * 0.85;
    const s = Math.sin(phase);
    if (airborne) {
      legR.rotation.x = -0.5; legL.rotation.x = 0.3;
      armR.rotation.x = -1.0; armL.rotation.x = -1.0;
    } else {
      legR.rotation.x = s * amp;
      legL.rotation.x = -s * amp;
      armR.rotation.x = -s * amp * 0.85 - swing;
      armL.rotation.x = s * amp * 0.85;
      armR.rotation.z = -0.08;
      armL.rotation.z = 0.08;
    }
    torso.position.y = 1.24 + Math.sin(phase * 2) * 0.012 * clamp(moving, 0.05, 1);
    head.rotation.y = Math.sin(phase * 0.4) * 0.08 * (1 - clamp(moving, 0, 1));
    rig.rotation.z = Math.sin(phase) * 0.02 * clamp(moving, 0, 1);
  }

  function attack() { swing = 1.5; }

  function setBodyColor(hex) {
    skin.color.setHex(hex);
    if (Array.isArray(head.material)) head.material.forEach((m, i) => { if (i !== 4) m.color.setHex(hex); });
  }

  setWeapon('fists');
  return { root, rig, tag, parts: { torso, head, armL, armR, legL, legR }, animate, attack, setWeapon, setBodyColor, get weapon() { return weaponId; } };
}
