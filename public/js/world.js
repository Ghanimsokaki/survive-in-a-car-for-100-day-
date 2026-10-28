import * as THREE from '../vendor/three.module.js';
import { rand, randInt, pick, clamp, lerp, canvasTex, mulberry32 } from './utils.js';
import { createBuilding, placeBuilding, setRoofVisible, updateDoor, pointInside, hitsWalls, hitsFootprint, BUILDING_KINDS } from './buildings.js';

export const ZONES = [
  { name: 'OAKHAVEN OUTSKIRTS', short: 'OUTSKIRTS', ground: 0x6b6153, road: 0x2b2d33, fog: 0xb9a68a, sky: 0xc0a984, sun: 0xffd9a0, amb: 0x8f96a8, night: 0.0, desc: 'DAY 1–15 · CAR MAINTENANCE & FUEL' },
  { name: 'THE SUNKEN HIGHWAY', short: 'SUNKEN HWY', ground: 0x4b5350, road: 0x262b30, fog: 0x74858b, sky: 0x7d9199, sun: 0xd7e6f2, amb: 0x6f8296, night: 0.12, desc: 'DAY 16–40 · ROADBLOCKS & STORMS' },
  { name: 'THE INDUSTRIAL WASTES', short: 'INDUSTRIAL', ground: 0x4e4740, road: 0x24262b, fog: 0x6b6157, sky: 0x8a7d6c, sun: 0xffc48a, amb: 0x8a7a68, night: 0.18, desc: 'DAY 41–65 · ARMOR & EXTREME WEATHER' },
  { name: 'THE DESERT CANYONS', short: 'CANYONS', ground: 0x9a7350, road: 0x33302d, fog: 0xd9a76d, sky: 0xe0ad74, sun: 0xfff0c2, amb: 0xa89078, night: 0.05, desc: 'DAY 66–85 · HEAT & LEGENDARY FORGES' },
  { name: 'THE FINAL MILE', short: 'FINAL MILE', ground: 0x39464b, road: 0x1e2328, fog: 0x41525c, sky: 0x33444e, sun: 0xc8dbe8, amb: 0x5d7382, night: 0.42, desc: 'DAY 86–100 · APEX STORMS & COASTAL ESCAPE' },
];

const SHADOW = { castShadow: true, receiveShadow: true };

function asphaltTexture() {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#23262b'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 1600; i++) {
      const g = 26 + Math.random() * 34;
      ctx.fillStyle = `rgba(${g},${g + 2},${g + 5},${Math.random() * 0.55})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // lane dashes (two lanes per direction)
    ctx.fillStyle = 'rgba(230,225,205,.62)';
    [w * 0.31, w * 0.69].forEach((x) => {
      for (let y = 6; y < h; y += 64) ctx.fillRect(x - 3, y, 6, 34);
    });
    // solid shoulder lines
    ctx.fillStyle = 'rgba(232,214,170,.72)';
    ctx.fillRect(6, 0, 5, h); ctx.fillRect(w - 11, 0, 5, h);
    // cracks
    ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
      ctx.beginPath();
      let x = Math.random() * w, y = Math.random() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 4; s++) { x += rand(-22, 22); y += rand(12, 34); ctx.lineTo(x, y); }
      ctx.stroke();
    }
  });
}

/* ------------------------------------------------------------ ground textures
 * One procedural detail texture per biome (soil, cracked asphalt, sand, slag).
 */
function groundTexture(zone) {
  const palette = [
    { base: '#6b6153', a: '#7a705f', b: '#585043', grit: '#8a8069' }, // outskirts soil
    { base: '#4b5350', a: '#556060', b: '#3e4746', grit: '#6b7a78' }, // sunken mud
    { base: '#4e4740', a: '#5b534a', b: '#3c3630', grit: '#75695c' }, // industrial slag
    { base: '#9a7350', a: '#a97f59', b: '#8a6544', grit: '#c09a6c' }, // canyon sand
    { base: '#39464b', a: '#445256', b: '#2c3639', grit: '#5b6c72' }, // coastal rock
  ][zone] || { base: '#6b6153', a: '#7a705f', b: '#585043', grit: '#8a8069' };

  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = palette.base;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = Math.random() < 0.5 ? palette.a : palette.b;
      const r = rand(1, 4);
      ctx.globalAlpha = rand(0.15, 0.5);
      ctx.fillRect(rand(0, w), rand(0, h), r, r);
    }
    // pebbles / gravel
    for (let i = 0; i < 220; i++) {
      ctx.globalAlpha = rand(0.25, 0.7);
      ctx.fillStyle = palette.grit;
      ctx.beginPath();
      ctx.ellipse(rand(0, w), rand(0, h), rand(0.7, 1.9), rand(0.5, 1.4), rand(0, 3), 0, Math.PI * 2);
      ctx.fill();
    }
    // dry cracks
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#2b271f';
    ctx.lineWidth = 1;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      let x = rand(0, w), y = rand(0, h);
      ctx.moveTo(x, y);
      for (let s2 = 0; s2 < 4; s2++) { x += rand(-20, 20); y += rand(-20, 20); ctx.lineTo(x, y); }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  });
}

const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAG = `
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 groundColor;
  uniform vec3 sunDir;
  uniform vec3 sunColor;
  uniform float sunIntensity;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, -1.0, 1.0);
    float up = smoothstep(-0.05, 0.65, h);
    vec3 col = mix(horizonColor, topColor, up);
    col = mix(groundColor, col, smoothstep(-0.35, 0.02, h));
    float sun = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 220.0);
    float glow = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 6.0) * 0.35;
    col += sunColor * (sun * 2.2 + glow) * sunIntensity;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class World {
  constructor(scene, seed = 1) {
    this.scene = scene;
    this.rng = mulberry32(seed);
    this.zoneIndex = 0;
    this.props = [];
    this.pitStops = [];
    this.colliders = [];
    this.timeOfDay = 11;
    this.nightFactor = 0;
    this.rain = null; this.dust = null;

    this.hemi = new THREE.HemisphereLight(0xbcd0e8, 0x4a4034, 1.15);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffd9a0, 2.1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 140;
    this.sun.shadow.camera.left = -42;
    this.sun.shadow.camera.right = 42;
    this.sun.shadow.camera.top = 42;
    this.sun.shadow.camera.bottom = -42;
    this.sun.shadow.bias = -0.0012;
    scene.add(this.sun, this.sun.target);

    this.fill = new THREE.DirectionalLight(0x8fb4ff, 0.45);
    scene.add(this.fill);

    // ground
    const groundGeo = new THREE.PlaneGeometry(1400, 2800);
    groundGeo.rotateX(-Math.PI / 2);
    this.groundMat = new THREE.MeshStandardMaterial({ color: ZONES[0].ground, roughness: 1, metalness: 0 });
    this.ground = new THREE.Mesh(groundGeo, this.groundMat);
    this.ground.receiveShadow = true;
    scene.add(this.ground);

    // road
    const tex = new THREE.CanvasTexture(asphaltTexture());
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 210);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    this.roadTex = tex;
    const roadGeo = new THREE.PlaneGeometry(26, 2800);
    roadGeo.rotateX(-Math.PI / 2);
    this.roadMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.05, color: 0xdedede });
    this.road = new THREE.Mesh(roadGeo, this.roadMat);
    this.road.position.y = 0.02;
    this.road.receiveShadow = true;
    scene.add(this.road);

    // shoulder dirt strips
    const shoulderMat = new THREE.MeshStandardMaterial({ color: 0x5a5245, roughness: 1 });
    [-1, 1].forEach((sign) => {
      const g = new THREE.PlaneGeometry(9, 2800); g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, shoulderMat);
      m.position.set(sign * 17.5, 0.012, 0);
      m.receiveShadow = true;
      scene.add(m);
    });

    // horizon mountains
    this.mountains = new THREE.Group();
    scene.add(this.mountains);
    for (let i = 0; i < 16; i++) {
      const h = rand(28, 78);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(rand(40, 90), h, 5, 1),
        new THREE.MeshStandardMaterial({ color: 0x5c5749, roughness: 1, flatShading: true }));
      cone.position.set(i % 2 ? rand(160, 320) : rand(-320, -160), h / 2 - 4, rand(-900, 900));
      cone.rotation.y = rand(0, 6.28);
      this.mountains.add(cone);
    }

    // stars
    const starPos = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const r = 700, th = rand(0, Math.PI * 2), ph = rand(0.05, Math.PI / 2.2);
      starPos[i * 3] = Math.cos(th) * Math.cos(ph) * r;
      starPos[i * 3 + 1] = Math.sin(ph) * r * 0.75;
      starPos[i * 3 + 2] = Math.sin(th) * Math.cos(ph) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xdfe9ff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0 });
    this.stars = new THREE.Points(starGeo, this.starMat);
    scene.add(this.stars);

    // rain / dust
    this.rain = this.makeWeather(1400, 0x9fb6c9, 0.16, 70);
    this.rain.visible = false;
    this.dust = this.makeWeather(800, 0xd8b483, 0.13, 26);
    this.dust.visible = false;

    this.textures = { asphalt: tex };

    // ---------------------------------------------------------- ground detail
    this.groundTextures = [0, 1, 2, 3, 4].map((i) => {
      const t = new THREE.CanvasTexture(groundTexture(i));
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(46, 140);
      t.anisotropy = 4;
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
    this.groundTex = this.groundTextures[0];
    this.groundMat.color.setHex(0xffffff);
    this.groundMat.map = this.groundTex;
    this.groundMat.needsUpdate = true;

    // ------------------------------------------------------------- sky dome
    this.skyUniforms = {
      topColor: { value: new THREE.Color(0x5b8fc4) },
      horizonColor: { value: new THREE.Color(0xc0a984) },
      groundColor: { value: new THREE.Color(0x5a5245) },
      sunDir: { value: new THREE.Vector3(0.35, 0.42, -0.84).normalize() },
      sunColor: { value: new THREE.Color(0xffe0ad) },
      sunIntensity: { value: 1.0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(880, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.skyUniforms,
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      })
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1;
    this.scene.add(this.sky);
    this.scene.background = null;

    this.textures = { asphalt: tex };
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    const lowEnd = Boolean(coarse && (Math.min(window.innerWidth, window.innerHeight) < 640 || (navigator.hardwareConcurrency || 8) <= 4));
    this.propBudget = lowEnd ? 56 : 88;
    this.lowEnd = lowEnd;
    this.buildProps();
    this.buildPitStops();
    this.buildBuildings();
  }

  makeWeather(count, color, size, spread) {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      arr[i * 3] = rand(-spread, spread);
      arr[i * 3 + 1] = rand(0, 40);
      arr[i * 3 + 2] = rand(-spread, spread);
    }
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.55, depthWrite: false });
    const pts = new THREE.Points(g, mat);
    pts.userData.count = count;
    pts.frustumCulled = false;
    this.scene.add(pts);
    return pts;
  }

  // ---------------------------------------------------------------- props
  makeProp(type) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x6b4f36, roughness: 0.95 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x5c626b, roughness: 0.55, metalness: 0.75 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x7a4529, roughness: 0.92 });
    const foliage = new THREE.MeshStandardMaterial({ color: 0x4b5138, roughness: 1, flatShading: true });
    let radius = 1.4;
    const add = (mesh, x, y, z, rx = 0, rz = 0) => {
      mesh.position.set(x, y, z); mesh.rotation.x = rx; mesh.rotation.z = rz;
      mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh;
    };
    if (type === 'tree') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, rand(6, 9), 6), wood);
      add(trunk, 0, 3.6, 0);
      for (let i = 0; i < 4; i++) {
        const br = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.14, rand(2, 3.6), 5), wood);
        br.rotation.z = rand(-0.9, 0.9);
        add(br, rand(-0.6, 0.6), rand(4.5, 7), rand(-0.6, 0.6), rand(-0.6, 0.6), br.rotation.z);
      }
      radius = 0.9;
    } else if (type === 'pine') {
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.34, 2.4, 6), wood);
      add(trunk, 0, 1.2, 0);
      for (let i = 0; i < 3; i++) {
        const c = new THREE.Mesh(new THREE.ConeGeometry(1.7 - i * 0.42, 2.6 - i * 0.3, 6), foliage);
        add(c, 0, 2.7 + i * 1.4, 0);
      }
      radius = 1.2;
    } else if (type === 'sign') {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 4.4, 0.16), metal);
      add(post, 0, 2.2, 0);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.5, 0.1), new THREE.MeshStandardMaterial({ color: 0x394a3f, roughness: 0.8 }));
      add(panel, 0, 4.2, 0);
      const bar = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.16, 0.02), new THREE.MeshStandardMaterial({ color: 0xd9c48a, emissive: 0x4a3a12 }));
      add(bar, 0, 4.2, 0.08);
      radius = 1;
    } else if (type === 'wreck') {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.9, 4.1), rust);
      add(body, 0, 0.72, 0);
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 1.9), rust);
      add(cab, 0, 1.4, -0.3);
      radius = 1.9;
    } else if (type === 'rock') {
      const r = new THREE.Mesh(new THREE.DodecahedronGeometry(rand(1.2, 2.6), 0),
        new THREE.MeshStandardMaterial({ color: 0x6e6759, roughness: 1, flatShading: true }));
      add(r, 0, rand(0.5, 1.1), 0);
      radius = 1.8;
    } else if (type === 'pole') {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 9, 6), wood);
      add(post, 0, 4.5, 0);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 0.14), wood);
      add(arm, 0, 8.4, 0);
      radius = 0.7;
    } else if (type === 'rail') {
      for (let i = 0; i < 5; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 0.12), metal);
        add(post, 0, 0.45, i * 1.4 - 2.8);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, 7.4), metal);
      add(beam, 0, 0.8, 0);
      radius = 2.6;
    } else if (type === 'junk') {
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(rand(0.6, 1.6), rand(0.3, 0.8), rand(0.6, 1.4)), i % 2 ? rust : metal);
        b.rotation.set(rand(0, 1), rand(0, 3), rand(0, 1));
        add(b, rand(-0.8, 0.8), 0.3 + i * 0.35, rand(-0.8, 0.8));
      }
      radius = 1.6;
    } else if (type === 'barrier') {
      const top = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.3, 0.3), new THREE.MeshStandardMaterial({ color: 0xb8b0a2, roughness: 0.9 }));
      add(top, 0, 1.15, 0);
      const top2 = top.clone(); top2.position.y = 0.6; g.add(top2);
      [-1.9, 1.9].forEach((x) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.4, 0.2), metal);
        add(leg, x, 0.7, 0);
      });
      radius = 2.4;
    } else if (type === 'bush') {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(rand(0.7, 1.3), 0), foliage);
      add(b, 0, 0.7, 0);
      radius = 1;
    } else if (type === 'billboard') {
      const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 7, 0.24), metal); add(p1, -2, 3.5, 0);
      const p2 = p1.clone(); p2.position.x = 2; g.add(p2);
      const panel = new THREE.Mesh(new THREE.BoxGeometry(6.4, 3, 0.16),
        new THREE.MeshStandardMaterial({ color: 0x2c3a44, roughness: 0.85 }));
      add(panel, 0, 6, 0);
      radius = 3.2;
    }
    g.userData.radius = radius;
    return g;
  }

  buildProps() {
    const types = ['tree', 'tree', 'pine', 'sign', 'wreck', 'rock', 'pole', 'rail', 'junk', 'barrier', 'bush', 'billboard'];
    for (let i = 0; i < this.propBudget; i++) {
      const type = pick(types);
      const obj = this.makeProp(type);
      this.scene.add(obj);
      const p = { obj, type, radius: obj.userData.radius || 1.2, x: 0, z: 0 };
      this.placeProp(p, rand(-120, 120));
      this.props.push(p);
    }
  }

  placeProp(p, z) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const lane = Math.abs(rand(0, 1));
    p.x = side * (15 + Math.pow(lane, 0.7) * 150);
    p.z = z;
    p.obj.position.set(p.x, 0, p.z);
    p.obj.rotation.y = rand(0, Math.PI * 2);
    const s = rand(0.8, 1.25);
    p.obj.scale.setScalar(s);
    p.radius = (p.obj.userData.radius || 1.2) * s;
    p.obj.visible = true;
  }

  // ------------------------------------------------------------- pit stops
  buildPitStops() {
    const kinds = ['gas', 'diner', 'motel', 'checkpoint', 'yard'];
    for (let i = 0; i < 10; i++) {
      const kind = kinds[i % kinds.length];
      const stop = this.makePitStop(kind);
      this.scene.add(stop.obj);
      stop.z = -260 + i * 240;
      stop.x = (i % 2 ? 1 : -1) * rand(26, 40);
      stop.obj.position.set(stop.x, 0, stop.z);
      stop.obj.rotation.y = (i % 2 ? -1 : 1) * Math.PI / 2;
      this.pitStops.push(stop);
    }
  }

  makePitStop(kind) {
    const g = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0x77736a, roughness: 0.95 });
    const wall = new THREE.MeshStandardMaterial({ color: 0x8d8375, roughness: 0.9 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x32363d, roughness: 0.8, metalness: 0.3 });
    const rust = new THREE.MeshStandardMaterial({ color: 0x7b4526, roughness: 0.95 });
    const neon = new THREE.MeshStandardMaterial({ color: 0xffc46b, emissive: 0xff9a2e, emissiveIntensity: 1.4 });
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; g.add(mesh); return mesh; };

    // pad
    const pad = new THREE.Mesh(new THREE.BoxGeometry(22, 0.3, 26), concrete);
    add(pad, 0, 0.15, 0);

    if (kind === 'gas') {
      const shop = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 8), wall); add(shop, -4, 2.6, -7);
      const canopy = new THREE.Mesh(new THREE.BoxGeometry(15, 0.6, 9), dark); add(canopy, 1, 5.6, 2);
      [[-5, 2], [7, 2]].forEach(([x, z]) => add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 5.4, 0.5), dark), x, 2.8, z));
      const glow = new THREE.Mesh(new THREE.BoxGeometry(13, 0.16, 7), neon); add(glow, 1, 5.25, 2);
      const pump = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.2, 0.9), rust); add(pump, 2, 1.4, 1);
      const pump2 = pump.clone(); pump2.position.x = -1.5; g.add(pump2);
      const signPost = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 0.4), dark); add(signPost, -10, 4, 8);
      const signBox = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.4, 0.5), neon); add(signBox, -10, 8.4, 8);
    } else if (kind === 'diner') {
      const shell = new THREE.Mesh(new THREE.BoxGeometry(16, 5.4, 10), wall); add(shell, 0, 2.8, -4);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(17, 0.8, 11), rust); add(roof, 0, 5.7, -4);
      const win = new THREE.Mesh(new THREE.BoxGeometry(11, 2.2, 0.2), neon); add(win, 0, 3, 1.1);
      const door = new THREE.Mesh(new THREE.BoxGeometry(2, 3.2, 0.3), dark); add(door, 6.5, 1.7, 1.1);
      add(new THREE.Mesh(new THREE.BoxGeometry(3, 1.4, 0.24), neon), 0, 5.1, 1.2);
    } else if (kind === 'motel') {
      const block = new THREE.Mesh(new THREE.BoxGeometry(20, 6.5, 7), wall); add(block, 0, 3.4, -8);
      const balc = new THREE.Mesh(new THREE.BoxGeometry(21, 0.4, 3), dark); add(balc, 0, 4.2, -3.4);
      for (let i = 0; i < 5; i++) {
        add(new THREE.Mesh(new THREE.BoxGeometry(2, 2.2, 0.16), i % 2 ? neon : dark), -7.6 + i * 3.8, 3, -4.4);
      }
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 9, 6), dark); add(pole, 9, 4.5, 4);
      const board = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 0.2), neon); add(board, 9, 8.4, 4);
    } else if (kind === 'checkpoint') {
      const booth = new THREE.Mesh(new THREE.BoxGeometry(4, 3.4, 4), wall); add(booth, -5, 1.9, -4);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(5, 0.4, 5), dark); add(roof, -5, 3.7, -4);
      const gate = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 0.3), rust); add(gate, 3, 1.4, -4);
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 5, 10), dark); add(tank, 8, 2.6, -9);
      const sand = new THREE.Mesh(new THREE.BoxGeometry(3, 1, 1), rust); add(sand, 6, 0.6, 3);
    } else {
      const shed = new THREE.Mesh(new THREE.BoxGeometry(8, 4.4, 7), rust); add(shed, -6, 2.3, -6);
      const crane = new THREE.Mesh(new THREE.BoxGeometry(0.6, 9, 0.6), dark); add(crane, 6, 4.5, -8);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 0.5), dark); add(arm, 3, 8.6, -8);
      for (let i = 0; i < 3; i++) {
        const stack = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.2, 2.2), i % 2 ? rust : dark);
        add(stack, rand(-3, 7), 0.8 + i * 1.1, rand(1, 6));
      }
    }
    // crates (visual loot markers)
    const crates = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), new THREE.MeshStandardMaterial({ color: 0x8a6a3f, roughness: 0.9 }));
      c.position.set(rand(-8, 8), 0.85, rand(-8, 8));
      c.rotation.y = rand(0, 1);
      c.castShadow = true;
      crates.add(c);
    }
    g.add(crates);

    return {
      obj: g, kind, x: 0, z: 0, cooldown: 0, scavengeReady: true,
      radius: 15, crates, label: { gas: 'ABANDONED FUEL STOP', diner: 'ROADSIDE DINER', motel: 'HIGHWAY MOTEL', checkpoint: 'MILITARY CHECKPOINT', yard: 'WRECK YARD' }[kind],
    };
  }

  // ------------------------------------------------------------- buildings
  buildBuildings() {
    // A fixed pool of enterable interiors, cycled as the player drives.
    // Every kind gets at least one slot so the road keeps changing.
    const pool = [
      'house', 'store', 'garage', 'warehouse', 'house', 'clinic',
      'barn', 'church', 'shack', 'bunker', 'farmhouse', 'house',
      'depot', 'warehouse', 'store', 'farmhouse',
    ];
    const count = this.lowEnd ? 10 : pool.length;
    this.buildings = [];
    for (let i = 0; i < count; i++) {
      const kind = pool[i % pool.length];
      const b = createBuilding(kind, { x: 0, z: 0, facing: 1 });
      this.scene.add(b.group);
      b.slot = i;
      this.placeBuilding(b, -320 + i * 300, i % 2 === 0 ? -1 : 1);
      this.buildings.push(b);
    }
  }

  placeBuilding(b, z, side) {
    const facing = side > 0 ? 1 : -1;           // door always looks at the road
    const big = b.kind === 'warehouse' || b.kind === 'barn' || b.kind === 'depot' || b.kind === 'church';
    const dist = rand(34, 62) + (big ? 14 : 0);
    // don't stack a house on a pit-stop or another house on the same shoulder
    for (let guard = 0; guard < 8; guard++) {
      const hitsStop = this.pitStops.some((s) => Math.sign(s.x) === side && Math.abs(s.z - z) < 46);
      const hitsHouse = this.buildings.some((o) => o !== b && Math.sign(o.x) === side && Math.abs(o.z - z) < 78);
      if (!hitsStop && !hitsHouse) break;
      z += 104;
    }
    placeBuilding(b, { x: side * dist, z, facing });
    b.scavengeReady = true;
    b.cooldown = 0;
    b.inside = false;
    setRoofVisible(b, true);
  }

  /** Owner-console helper: drops a fresh building beside the player. */
  spawnBuilding(kind, x, z, facing = 1) {
    const b = createBuilding(kind, { x, z, facing });
    this.scene.add(b.group);
    this.buildings.push(b);
    return b;
  }

  // --------------------------------------------------------------- queries
  isOffroad(x) { return Math.abs(x) > 13.4; }

  collide(x, z, r) {
    // vehicle path: buildings are solid blocks (no driving through doorways)
    for (const b of this.buildings) {
      if (Math.abs(b.z - z) > b.halfD + 8) continue;
      if (hitsFootprint(b, x, z, r + 0.6)) return b;
    }
    for (const p of this.props) {
      if (Math.abs(p.z - z) < 6 && Math.abs(p.x - x) < 6) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < (p.radius + r) * (p.radius + r)) return p;
      }
    }
    // pit stop structures are solid-ish
    for (const s of this.pitStops) {
      const dx = s.x - x, dz = s.z - z;
      if (dx * dx + dz * dz < (r + 8) * (r + 8)) return s;
    }
    return null;
  }

  /** On-foot collision: walls only, so the doorway stays walkable. */
  collideFoot(x, z, r = 0.5) {
    for (const p of this.props) {
      if (Math.abs(p.z - z) < 6 && Math.abs(p.x - x) < 6) {
        const dx = p.x - x, dz = p.z - z;
        if (dx * dx + dz * dz < (p.radius + r) * (p.radius + r)) return p;
      }
    }
    for (const b of this.buildings) {
      if (Math.abs(b.z - z) > b.halfD + 2 || Math.abs(b.x - x) > b.halfW + 2) continue;
      if (hitsWalls(b, x, z, r)) return b;
    }
    return null;
  }

  /** Building whose interior currently contains the point, if any. */
  buildingAt(x, z, margin = 0) {
    for (const b of this.buildings) {
      if (pointInside(b, x, z, margin)) return b;
    }
    return null;
  }

  /** Closest building the player can interact with (door or interior). */
  nearestBuilding(x, z, maxDist = 14) {
    let best = null, bd = maxDist;
    for (const b of this.buildings) {
      const d = Math.min(
        Math.hypot(b.door.x - x, b.door.z - z) - 2,
        Math.hypot(b.x - x, b.z - z) - Math.max(b.halfW, b.halfD)
      );
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  nearestPitStop(x, z, maxDist = 16) {
    let best = null, bd = maxDist;
    for (const s of this.pitStops) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  // ----------------------------------------------------------------- update
  update(dt, focus, zoneIndex) {
    this.zoneIndex = zoneIndex;
    this.road.position.z = focus.z;
    this.ground.position.set(0, -0.01, focus.z);
    this.mountains.position.z = focus.z;
    this.roadTex.offset.y = (focus.z / 2800) * 210;
    this.groundTex.offset.y = focus.z / 20;
    this.sky.position.set(focus.x, 0, focus.z);
    this.stars.position.set(focus.x, 0, focus.z);
    this.sun.position.set(focus.x + 32, 48, focus.z + 26);
    this.sun.target.position.set(focus.x, 0, focus.z);
    this.sun.target.updateMatrixWorld();

    // recycle props
    for (const p of this.props) {
      if (p.z - focus.z > 520) this.placeProp(p, focus.z - 560 - rand(0, 180));
      else if (focus.z - p.z > 560) this.placeProp(p, focus.z + 540 + rand(0, 160));
      else if (Math.abs(p.x - focus.x) > 300) this.placeProp(p, focus.z + rand(-400, 400));
    }
    // recycle pit stops
    for (const s of this.pitStops) {
      if (s.z - focus.z > 420) {
        s.z = focus.z - 520 - rand(0, 200);
        s.x = (Math.random() < 0.5 ? -1 : 1) * rand(26, 40);
        s.obj.position.set(s.x, 0, s.z);
        s.scavengeReady = true; s.cooldown = 0;
        s.crates.visible = true;
      } else if (focus.z - s.z > 520) {
        s.z = focus.z + 480 + rand(0, 200);
        s.x = (Math.random() < 0.5 ? -1 : 1) * rand(26, 40);
        s.obj.position.set(s.x, 0, s.z);
        s.scavengeReady = true; s.cooldown = 0;
        s.crates.visible = true;
      }
      if (s.cooldown > 0) {
        s.cooldown -= dt;
        if (s.cooldown <= 0) { s.scavengeReady = true; s.crates.visible = true; }
      }
    }

    // recycle buildings + their scavenge cooldowns
    for (const b of this.buildings) {
      if (b.inside) continue;                      // never teleport a building around the player
      if (b.z - focus.z > 460) this.placeBuilding(b, focus.z - 540 - rand(0, 220), b.facing);
      else if (focus.z - b.z > 560) this.placeBuilding(b, focus.z + 520 + rand(0, 220), b.facing);
      if (b.cooldown > 0) {
        b.cooldown -= dt;
        if (b.cooldown <= 0) b.scavengeReady = true;
      }
      // doors swing open as you step onto the porch
      const door = b.door;
      updateDoor(b, Math.hypot(focus.x - door.x, focus.z - door.z) < 4.6, dt);
    }
  }

  /** Roof peeling / reveal for the interior the player is standing in. */
  focusInterior(build) {
    for (const b of this.buildings) {
      const active = b === build;
      if (b.inside !== active) {
        b.inside = active;
        setRoofVisible(b, !active);
      }
    }
  }

  setZone(index, immediate = false) {
    const zi = clamp(index, 0, ZONES.length - 1);
    const z = ZONES[zi];
    if (this.groundMat.map !== this.groundTextures[zi]) {
      this.groundMat.map = this.groundTextures[zi];
      this.groundTex = this.groundTextures[zi];
      this.groundMat.needsUpdate = true;
    }
    this.groundMat.color.setHex(0xffffff);
    this.hemi.color.setHex(z.sky);
    this.hemi.groundColor.setHex(z.ground);
    this.sun.color.setHex(z.sun);
    this.sun.intensity = 2.1 - z.night * 0.7;
    this.scene.fog = new THREE.Fog(z.fog, 90, 430);
    this.scene.background = new THREE.Color(z.sky);
    this.scene.fog.color.setHex(z.fog);
    if (immediate) this.scene.fog.near = 90;
    this.applySky(z, this.nightFactor || 0);
  }

  /** Pushes zone + night colours into the sky dome uniforms. */
  applySky(z, night = 0) {
    if (!this.skyUniforms) return;
    const top = new THREE.Color(z.sky).lerp(new THREE.Color(0x0b1526), night * 0.9);
    const horizon = new THREE.Color(z.fog).lerp(new THREE.Color(0x121d2c), night * 0.82);
    const ground = new THREE.Color(z.ground).lerp(new THREE.Color(0x0a1016), night * 0.88);
    this.skyUniforms.topColor.value.copy(top);
    this.skyUniforms.horizonColor.value.copy(horizon);
    this.skyUniforms.groundColor.value.copy(ground);
    this.skyUniforms.sunColor.value.setHex(z.sun).lerp(new THREE.Color(0x7fa6d8), night * 0.7);
    this.skyUniforms.sunIntensity.value = lerp(1, 0.22, night);
  }

  setNight(t) {
    // t: 0 day .. 1 night
    this.nightFactor = t;
    this.starMat.opacity = clamp(t * 1.3 - 0.15, 0, 0.95);
    this.stars.visible = this.starMat.opacity > 0.02;
    this.sun.intensity = lerp(2.3, 0.18, t);
    this.hemi.intensity = lerp(1.15, 0.42, t);
    this.fill.intensity = lerp(0.45, 0.22, t);
    const zone = ZONES[this.zoneIndex];
    this.applySky(zone, t);
    const sky = new THREE.Color(zone.sky).lerp(new THREE.Color(0x0a1220), t * 0.86);
    this.scene.background = sky;
    if (this.scene.fog) {
      const fog = new THREE.Color(zone.fog).lerp(new THREE.Color(0x0a1018), t * 0.8);
      this.scene.fog.color.copy(fog);
    }
  }

  setWeather(kind) {
    this.rain.visible = kind === 'rain' || kind === 'storm' || kind === 'acid';
    this.rain.material.color.setHex(kind === 'acid' ? 0xa6d14a : 0x9fb6c9);
    this.rain.material.opacity = kind === 'acid' ? 0.38 : 0.5;
    this.dust.visible = kind === 'dust' || kind === 'heat';
    this.dust.material.color.setHex(kind === 'heat' ? 0xffc27a : 0xd8b483);
    this.dust.material.opacity = kind === 'heat' ? 0.09 : 0.22;
    if (this.scene.fog) {
      if (kind === 'dust') this.scene.fog.far = 150;
      else if (kind === 'heat') this.scene.fog.far = 300;
      else if (kind === 'rain' || kind === 'storm') this.scene.fog.far = 300;
      else this.scene.fog.far = 430;
    }
  }

  updateWeather(dt, focus, windX = 0) {
    const move = (pts, speed, drift) => {
      if (!pts.visible) return;
      const arr = pts.geometry.attributes.position.array;
      const n = pts.userData.count;
      for (let i = 0; i < n; i++) {
        arr[i * 3 + 1] -= speed * dt;
        arr[i * 3] += drift * dt;
        if (arr[i * 3 + 1] < 0) {
          arr[i * 3 + 1] = 42;
          arr[i * 3] = rand(-70, 70);
          arr[i * 3 + 2] = rand(-70, 70);
        }
        if (arr[i * 3] > 70) arr[i * 3] = -70;
        if (arr[i * 3] < -70) arr[i * 3] = 70;
      }
      pts.geometry.attributes.position.needsUpdate = true;
      pts.position.set(focus.x, 0, focus.z);
    };
    move(this.rain, 46, 6 + windX);
    move(this.dust, 7, 12 + windX);
  }
}
