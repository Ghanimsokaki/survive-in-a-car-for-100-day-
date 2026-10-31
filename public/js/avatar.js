import * as THREE from '../vendor/three.module.js';
import { canvasTex, clamp, damp } from './utils.js';
import { resolveCustom } from './customize.js';
import { createMaterialKit, segmentsFor } from './materials.js';

const mat = (hex, extra = {}) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.72, metalness: 0.04, ...extra });

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
    // brow — a little more character than before
    ctx.strokeStyle = 'rgba(20,22,29,.75)';
    ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(34, 38); ctx.lineTo(54, 34); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(94, 38); ctx.lineTo(74, 34); ctx.stroke();
    // determined mouth
    ctx.strokeStyle = '#14161d';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(48, 90); ctx.lineTo(80, 90); ctx.stroke();
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The floating nameplate. When the player has an account picture it is drawn as
 * a round portrait inside the same plate, so the face you chose follows you into
 * the world instead of only living on a menu.
 */
function nameTexture(name, color, portrait = null) {
  const c = canvasTex(512, 128, (ctx) => {
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = 'bold 52px ui-monospace, monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const textW = ctx.measureText(name).width;
    const pic = portrait && ctx.drawImage ? 62 : 0;
    const w = textW + 56 + (pic ? pic + 16 : 0);
    const left = 256 - w / 2;
    ctx.fillStyle = 'rgba(4,6,10,.62)';
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(left, 18, w, 70, 16);
    else ctx.rect(left, 18, w, 70);
    ctx.fill();
    if (pic) {
      // circular clip: the plate stays a rounded pill, the face stays a face
      ctx.save?.();
      ctx.beginPath?.();
      ctx.arc?.(left + 40, 53, 25, 0, Math.PI * 2);
      ctx.clip?.();
      try { ctx.drawImage(portrait, left + 15, 28, 50, 50); } catch { /* a picture that will not draw */ }
      ctx.restore?.();
      ctx.beginPath?.();
      ctx.arc?.(left + 40, 53, 25, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,179,71,.85)';
      ctx.lineWidth = 3;
      ctx.stroke?.();
      ctx.fillStyle = color;
      ctx.fillText(name, 256 + pic / 2, 52);
      ctx.textAlign = 'center';
    } else {
      ctx.fillStyle = color;
      ctx.fillText(name, 256, 52);
    }
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Rounded limb: capsule body + a joint ball, so elbows/knees never read as gaps. */
function limb({ radius = 0.12, length = 0.5, material, joint = 0.15, seg = null }) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, seg?.capsule ?? 6, seg?.ball ?? 12), material);
  body.position.y = -length / 2 - radius * 0.4;
  body.castShadow = true; body.receiveShadow = true;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(joint, seg?.sphereW ?? 12, seg?.sphereH ?? 10), material);
  ball.castShadow = true;
  g.add(ball, body);
  return g;
}

/**
 * Builds the survivor. Faces +Z, feet at y = 0.
 *
 * The silhouette is deliberately Roblox-ish (big head, blocky vest) but the
 * limbs are capsules with real joints, and hair / accessories are separate
 * meshes that can be swapped at runtime by `setCustom` without a rebuild.
 */
export function buildAvatar({
  color = 0xffb347, name = 'WANDERER', custom = null, detail = 'medium', env = null,
} = {}) {
  const cfg = resolveCustom(custom);
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);

  // PBR kit: skin gets sheen + clearcoat, cloth gets a woven normal map, metal
  // gets real reflections. Detail tier decides how much of that survives.
  const kit = createMaterialKit({ detail, env });
  const seg = segmentsFor(detail);

  const skin = kit.skin();
  skin.color.setHex(cfg.skinHex || color);
  const shirt = kit.cloth(cfg.outfitHex);
  const pants = kit.cloth(new THREE.Color(cfg.outfitHex).multiplyScalar(0.55).getHex());
  const boot = kit.leather(0x1b1e25);
  const hairMat = kit.hair(cfg.hairHex);
  const metal = kit.metal(0x9aa3ae, { rough: 0.34 });

  const cast = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };
  const box = (w, h, d, material) => cast(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material));
  const ball = (r, material, seg = 12) => cast(new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg / 2)), material));

  // ------------------------------------------------------------------ body
  const torso = new THREE.Group();
  const chest = box(0.62, 0.62, 0.34, skin);
  chest.position.y = 1.2;
  const hips = box(0.56, 0.22, 0.32, pants);
  hips.position.y = 0.9;
  const vest = box(0.68, 0.46, 0.38, shirt);
  vest.position.y = 1.14;
  const collar = box(0.4, 0.1, 0.34, shirt);
  collar.position.y = 1.5;
  const belt = box(0.62, 0.1, 0.35, boot);
  belt.position.y = 0.94;
  const buckle = box(0.12, 0.09, 0.04, metal);
  buckle.position.set(0, 0.94, 0.19);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.14, 12), skin);
  neck.position.y = 1.58;
  neck.castShadow = true;
  torso.add(chest, hips, vest, collar, belt, buckle, neck);
  rig.add(torso);

  // ------------------------------------------------------------------ head
  const head = new THREE.Group();
  head.position.y = 1.86;
  const skull = cast(new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.52, 0.5), [
    skin, skin, skin, skin,
    new THREE.MeshStandardMaterial({ map: faceTexture(), roughness: 0.8 }),
    skin,
  ]));
  // slightly rounded crown so it is not a raw cube from every angle
  const crown = ball(0.26, skin, 16);
  crown.scale.set(1, 0.62, 0.94);
  crown.position.y = 0.2;
  const jaw = box(0.44, 0.1, 0.42, skin);
  jaw.position.y = -0.28;
  head.add(skull, crown, jaw);
  rig.add(head);

  // hair / headwear variants (all built once, one visible at a time)
  const hairStyles = {};
  const dome = (r, h, material, y = 0.2) => {
    const m = cast(new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), material));
    m.scale.y = h;
    m.position.y = y;
    return m;
  };
  {
    const cap = new THREE.Group();
    cap.add(dome(0.3, 0.9, hairMat));
    const brim = box(0.5, 0.06, 0.2, hairMat);
    brim.position.set(0, 0.19, 0.26);
    cap.add(brim);
    hairStyles.cap = cap;

    const beanie = new THREE.Group();
    beanie.add(dome(0.31, 1.05, hairMat));
    const fold = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.05, 8, 18), hairMat);
    fold.rotation.x = Math.PI / 2;
    fold.position.y = 0.21;
    beanie.add(fold);
    hairStyles.beanie = beanie;

    const hood = new THREE.Group();
    const shell = dome(0.36, 1.15, shirt, 0.16);
    const back = box(0.62, 0.4, 0.16, shirt);
    back.position.set(0, 0.06, -0.24);
    hood.add(shell, back);
    hairStyles.hood = hood;

    const helmet = new THREE.Group();
    helmet.add(dome(0.33, 1.0, metal, 0.17));
    const visor = box(0.44, 0.14, 0.06, mat(0x2a3a44, { roughness: 0.2, metalness: 0.5 }));
    visor.position.set(0, 0.14, 0.26);
    const ridge = box(0.1, 0.08, 0.5, metal);
    ridge.position.y = 0.42;
    helmet.add(visor, ridge);
    hairStyles.helmet = helmet;

    const mohawk = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const fin = box(0.07, 0.2 - i * 0.015, 0.13, hairMat);
      fin.position.set(0, 0.34 + Math.sin((i / 4) * Math.PI) * 0.06, 0.2 - i * 0.11);
      mohawk.add(fin);
    }
    hairStyles.mohawk = mohawk;

    const ponytail = new THREE.Group();
    ponytail.add(dome(0.29, 0.85, hairMat, 0.21));
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), hairMat);
    tail.position.set(0, 0.08, -0.28);
    tail.rotation.x = 0.5;
    tail.castShadow = true;
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.025, 6, 10), mat(0xff5ba8));
    tie.position.set(0, 0.24, -0.26);
    ponytail.add(tail, tie);
    hairStyles.ponytail = ponytail;

    const buzz = new THREE.Group();
    buzz.add(dome(0.275, 0.72, hairMat, 0.23));
    hairStyles.buzz = buzz;

    hairStyles.none = new THREE.Group();
  }
  Object.entries(hairStyles).forEach(([id, group]) => {
    group.visible = false;
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    head.add(group);
    group.userData.styleId = id;
  });

  // ------------------------------------------------------------------ arms
  const mkArm = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.4, 1.44, 0);
    const pad = ball(0.13, shirt, 10);
    pivot.add(pad);
    const arm = limb({ radius: 0.1, length: 0.44, material: skin, joint: 0.11, seg });
    arm.position.y = -0.06;
    pivot.add(arm);
    const glove = box(0.17, 0.17, 0.19, boot);
    glove.position.y = -0.7;
    pivot.add(glove);
    rig.add(pivot);
    return pivot;
  };
  const armR = mkArm(1);
  const armL = mkArm(-1);

  // ------------------------------------------------------------------ legs
  const mkLeg = (side) => {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.17, 0.86, 0);
    const leg = limb({ radius: 0.115, length: 0.42, material: pants, joint: 0.13, seg });
    leg.position.y = -0.02;
    pivot.add(leg);
    const knee = ball(0.09, pants, 8);
    knee.position.y = -0.5;
    const shoe = box(0.24, 0.13, 0.36, boot);
    shoe.position.set(0, -0.72, 0.05);
    const sole = box(0.26, 0.05, 0.38, mat(0x0d0f13, { roughness: 1 }));
    sole.position.set(0, -0.8, 0.05);
    pivot.add(knee, shoe, sole);
    rig.add(pivot);
    return pivot;
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  // ---------------------------------------------------------- accessories
  const accessories = {};
  const lampGroup = new THREE.Group();
  {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xffc46b }));
    lamp.position.set(-0.26, 1.36, 0.22);
    const housing = box(0.1, 0.1, 0.1, metal);
    housing.position.set(-0.26, 1.36, 0.17);
    lampGroup.add(lamp, housing);
  }
  accessories.lamp = lampGroup;

  const backpack = new THREE.Group();
  {
    const bag = box(0.5, 0.56, 0.26, mat(0x6b5a3f, { roughness: 0.95 }));
    bag.position.set(0, 1.16, -0.28);
    const flap = box(0.5, 0.16, 0.28, mat(0x8a6a3f, { roughness: 0.95 }));
    flap.position.set(0, 1.42, -0.29);
    const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.46, 10), mat(0x9c6b3f));
    roll.rotation.z = Math.PI / 2;
    roll.position.set(0, 1.48, -0.3);
    const strap = box(0.06, 0.4, 0.4, boot);
    strap.position.set(0.22, 1.24, -0.06);
    const strap2 = strap.clone();
    strap2.position.x = -0.22;
    backpack.add(bag, flap, roll, strap, strap2);
  }
  accessories.backpack = backpack;

  const bandana = new THREE.Group();
  {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.05, 8, 16), mat(0xd24a2b, { roughness: 0.95 }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 1.8;
    const tail = box(0.1, 0.22, 0.05, mat(0xd24a2b, { roughness: 0.95 }));
    tail.position.set(0, 1.68, -0.16);
    tail.rotation.x = -0.3;
    bandana.add(ring, tail);
  }
  accessories.bandana = bandana;

  const spikes = new THREE.Group();
  {
    [-1, 1].forEach((side) => {
      for (let i = 0; i < 3; i++) {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.16, 6), metal);
        spike.position.set(side * (0.36 + i * 0.02), 1.52 - i * 0.02, -0.08 + i * 0.1);
        spike.rotation.z = side * -0.5;
        spikes.add(spike);
      }
    });
  }
  accessories.spikes = spikes;

  const pouch = new THREE.Group();
  {
    const bag = box(0.22, 0.2, 0.14, mat(0xd8d2c4, { roughness: 0.9 }));
    bag.position.set(0.3, 0.92, 0.14);
    const crossA = box(0.12, 0.045, 0.02, mat(0xff4d5e, { emissive: 0x551018 }));
    const crossB = box(0.045, 0.12, 0.02, mat(0xff4d5e, { emissive: 0x551018 }));
    crossA.position.set(0.3, 0.92, 0.215);
    crossB.position.set(0.3, 0.92, 0.215);
    pouch.add(bag, crossA, crossB);
  }
  accessories.pouch = pouch;
  accessories.medkit = pouch;
  accessories.none = new THREE.Group();

  Object.entries(accessories).forEach(([id, group]) => {
    group.visible = false;
    group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    rig.add(group);
    group.userData.accessoryId = id;
  });

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
      const m = box(0.09, 0.9, 0.09, mat(WEAPON_COLORS.pipe, { metalness: 0.8, roughness: 0.4 }));
      m.position.y = -0.2; return m;
    },
    bat: () => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 1.05, 8), mat(WEAPON_COLORS.bat, { roughness: 0.85 }));
      m.position.y = -0.25; m.castShadow = true; return m;
    },
    machete: () => {
      const m = box(0.06, 1.0, 0.2, mat(WEAPON_COLORS.machete, { metalness: 0.85, roughness: 0.3 }));
      m.position.y = -0.3; return m;
    },
    katana: () => {
      const g = new THREE.Group();
      const blade = box(0.045, 1.45, 0.11, mat(WEAPON_COLORS.katana, { metalness: 0.95, roughness: 0.18 }));
      blade.position.y = -0.55;
      const guard = box(0.2, 0.05, 0.2, mat(0x3a2f22, { metalness: 0.7 }));
      guard.position.y = 0.15;
      g.add(blade, guard);
      return g;
    },
    broadsword: () => {
      const g = new THREE.Group();
      const blade = box(0.12, 1.7, 0.28, mat(WEAPON_COLORS.broadsword, { metalness: 0.9, roughness: 0.25 }));
      blade.position.y = -0.6;
      const guard = box(0.44, 0.09, 0.36, mat(0x2a2a33, { metalness: 0.8 }));
      guard.position.y = 0.2;
      g.add(blade, guard);
      return g;
    },
    revolver: () => {
      const g = new THREE.Group();
      const barrel = box(0.09, 0.42, 0.1, mat(0x8b929c, { metalness: 0.9, roughness: 0.3 }));
      barrel.position.set(0, -0.12, 0.2); barrel.rotation.x = Math.PI / 2;
      const grip = box(0.1, 0.24, 0.12, mat(0x5b3b28));
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

  // ------------------------------------------------------------- customiser
  let api = null;
  function setCustom(next) {
    const c = resolveCustom(next);
    if (api) api.custom = c;
    skin.color.setHex(c.skinHex);
    shirt.color.setHex(c.outfitHex);
    pants.color.setHex(new THREE.Color(c.outfitHex).multiplyScalar(0.55).getHex());
    hairMat.color.setHex(c.hairHex);

    Object.values(hairStyles).forEach((g) => { g.visible = false; });
    (hairStyles[c.hair] || hairStyles.none).visible = true;

    Object.values(accessories).forEach((g) => { g.visible = false; });
    (accessories[c.accessory] || accessories.none).visible = true;

    // height stretches everything vertically; build widens the silhouette
    rig.scale.set(c.build, c.height, c.build);
    tag.position.y = 2.55 * c.height;
    return c;
  }

  function setBodyColor(hex) {
    skin.color.setHex(hex);
    if (Array.isArray(head.material)) head.material.forEach((m, i) => { if (i !== 4) m.color.setHex(hex); });
  }

  let portraitEl = null;
  let playerName = name;

  const repaintTag = () => {
    tagMat.map?.dispose?.();
    tagMat.map = nameTexture(playerName, '#ffd9a0', portraitEl);
    tagMat.needsUpdate = true;
  };

  function setName(nextName) {
    playerName = nextName;
    repaintTag();
  }

  /**
   * Points the nameplate at the account picture ('' clears it). Decoding is
   * asynchronous and best-effort: a broken or blocked picture simply leaves the
   * plain nameplate alone.
   */
  function setPicture(url) {
    const src = typeof url === 'string' ? url.trim() : '';
    if (!src) { portraitEl = null; repaintTag(); return; }
    const Img = globalThis.Image;
    if (!Img) { portraitEl = null; repaintTag(); return; }
    const img = new Img();
    img.onload = () => { portraitEl = img; repaintTag(); };
    img.onerror = () => { portraitEl = null; repaintTag(); };
    img.src = src;
  }

  let phase = Math.random() * 10;
  let swing = 0;
  const torsoBaseY = 1.2;

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
    torso.position.y = Math.sin(phase * 2) * 0.012 * clamp(moving, 0.05, 1);
    head.rotation.y = Math.sin(phase * 0.4) * 0.08 * (1 - clamp(moving, 0, 1));
    rig.rotation.z = Math.sin(phase) * 0.02 * clamp(moving, 0, 1);
    rig.position.y = torsoBaseY * 0 + Math.abs(Math.sin(phase)) * 0.02 * clamp(moving, 0, 1);
  }

  function attack() { swing = 1.5; }

  setWeapon('fists');
  api = {
    root, rig, tag, head, setPicture,
    parts: { torso, head, armL, armR, legL, legR, hairStyles, accessories },
    animate, attack, setWeapon, setBodyColor, setCustom, setName,
    custom: cfg,
    detail,
    kit,
    get weapon() { return weaponId; },
  };
  setCustom(cfg);
  return api;
}
