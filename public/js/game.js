import * as THREE from '../vendor/three.module.js';
import { World, ZONES } from './world.js';
import { Vehicle } from './vehicle.js';
import { buildAvatar } from './avatar.js';
import { Tornado } from './tornado.js';
import { Hollow, RaiderCar } from './enemies.js';
import { Effects } from './effects.js';
import { HUD } from './hud.js';
import { AudioKit } from './audio.js';
import { Net } from './net.js';
import { clamp, damp, lerp, angleLerp, rand, randInt, pick, hashStr, dist2 } from './utils.js';

const DAY_LENGTH = 95;               // seconds of real survival per in-game day
const INVULN = 0.55;

export const WEAPON_DATA = {
  fists: { name: 'BARE FISTS', dmg: 8, dur: Infinity, range: 2.5, cd: 0.5 },
  pipe: { name: 'SCRAP PIPE BAT', dmg: 20, dur: 80, range: 3.1, cd: 0.55 },
  machete: { name: 'SCRAP METAL MACHETE', dmg: 35, dur: 100, range: 3.3, cd: 0.48 },
  katana: { name: 'LEAF SPRING KATANA', dmg: 55, dur: 180, range: 3.7, cd: 0.4, crit: 0.28 },
  broadsword: { name: 'DAMASCUS SCRAP BROADSWORD', dmg: 120, dur: 350, range: 4.1, cd: 0.62, pierce: true },
  revolver: { name: 'SCAVENGED REVOLVER', dmg: 34, dur: 90, range: 48, cd: 0.62, ranged: true },
};

const MILESTONES = {
  1: ['AWAKENING IN THE DRIVER\'S SEAT', 'Oakhaven is quiet. Find fuel, then reach the highway.'],
  7: ['THE FIRST GAS STATION LOCKOUT', 'The generator is dead and the pumps are dry. Scavenge every stop you pass.'],
  15: ['HIGHWAY BOUNDARY BREACH', 'You smashed the suburban roadblock. Tier 2 workbench unlocked.'],
  20: ['THE HIGHWAY COLLAPSE', 'Mud tracks ahead — mind your traction and suspension.'],
  30: ['THE ABANDONED CONVOY RAID', 'Military steel in the wreckage. Katana schematics recovered.'],
  40: ['MIDWAY CHECKPOINT BOSS', 'An armoured raider rig owns the toll gate. Take it apart.'],
  45: ['REFINERY SIEGE', 'Chemicals for super fuel — and everything wants them.'],
  55: ['THE STEEL MILL HEIST', 'Titanium for the taking. Tier 3 workbench unlocked.'],
  65: ['THE SUPERSTORM BARRIER', 'The mountain pass is a wind tunnel. Anchor before you stop.'],
  70: ['THE OASIS OUTPOST', 'A trading post in the canyons. Rest, repair, reload.'],
  78: ['THE SWORD FORGE SHRINE', 'The Forge Master guards the Damascus recipe. Tier 4 unlocked.'],
  85: ['THE CANYON RIDGE BREAKOUT', 'Flash floods below, windstorms above. Keep the rig moving.'],
  90: ['THE GRID LOCK', 'Ten miles of dead traffic and elite raiders.'],
  95: ['THE APEX CONVOY ESCORT', 'Allied rigs on your flank. Stay in formation.'],
  100: ['THE CATEGORY 5 HYPERCANE', 'The coast. A 250 mph vortex. Lock down and survive.'],
};

export const RECIPES = [
  { id: 'pipe', name: 'SCRAP PIPE BAT', tab: 'weapons', tier: 1, tierReq: 1, cost: { scrap: 4 }, desc: '20 DMG · 80 DUR · heavy pipe swung by hand.', weapon: 'pipe', unique: true },
  { id: 'revolver', name: 'SCAVENGED REVOLVER', tab: 'weapons', tier: 2, tierReq: 2, cost: { steel: 3, scrap: 2, chem: 1 }, desc: '34 DMG · 90 DUR · hitscan sidearm, 48m reach.', weapon: 'revolver', unique: true },
  { id: 'machete', name: 'SCRAP METAL MACHETE', tab: 'weapons', tier: 2, tierReq: 2, cost: { scrap: 5, steel: 2, leather: 1 }, desc: '35 DMG · 100 DUR · fast cuts.', weapon: 'machete', unique: true },
  { id: 'katana', name: 'LEAF SPRING KATANA', tab: 'weapons', tier: 3, tierReq: 3, cost: { carbon: 5, steel: 3, leather: 1 }, desc: '55 DMG · 180 DUR · forged from truck suspension steel. 28% crit.', weapon: 'katana', unique: true },
  { id: 'broadsword', name: 'DAMASCUS SCRAP BROADSWORD', tab: 'weapons', tier: 4, tierReq: 4, cost: { titanium: 6, carbon: 3, cores: 2 }, desc: '120 DMG · 350 DUR · armour-piercing legend.', weapon: 'broadsword', unique: true },

  { id: 'fuelcan', name: 'SIPHON FUEL CAN', tab: 'repairs', tier: 1, cost: { chem: 1, scrap: 1 }, desc: 'Refine chemicals into +12L of usable fuel.' },
  { id: 'superfuel', name: 'SUPER FUEL BATCH', tab: 'repairs', tier: 2, tierReq: 2, cost: { chem: 3, scrap: 2 }, desc: '+26L of high-grade fuel for the long haul.' },
  { id: 'repairkit', name: 'FIELD REPAIR KIT', tab: 'repairs', tier: 1, cost: { steel: 2, leather: 1 }, desc: 'Patch the chassis and engine (+30 each).' },
  { id: 'tirepatch', name: 'TIRE PATCH KIT', tab: 'repairs', tier: 1, cost: { leather: 2, scrap: 1 }, desc: 'Re-tread the rubber (+35 tire tread).' },
  { id: 'fullfix', name: 'FULL RIG OVERHAUL', tab: 'repairs', tier: 3, tierReq: 3, cost: { steel: 4, titanium: 2, leather: 2 }, desc: 'Engine, chassis and tires back to 100%.' },

  { id: 'armor', name: 'REINFORCED ARMOR PLATING', tab: 'upgrades', tier: 2, tierReq: 1, cost: { steel: 4, titanium: 1 }, desc: 'Welded hull plates. Absorbs 28% of impact damage. Stacks ×3.', upgrade: 'armor' },
  { id: 'anchors', name: 'HYDRAULIC ANCHOR SPIKE SET', tab: 'upgrades', tier: 2, tierReq: 1, cost: { steel: 3, titanium: 2 }, desc: 'Deeper spikes, stronger hold. Negates tornado lift. Max tier 4.', upgrade: 'anchors' },
  { id: 'bench2', name: 'MOBILE WELDING RIG', tab: 'upgrades', tier: 2, cost: { steel: 5, carbon: 2 }, desc: 'Upgrade the car workbench to Tier 2.', upgrade: 'bench' },
  { id: 'bench3', name: 'HYDRAULIC PRESS BAY', tab: 'upgrades', tier: 3, tierReq: 2, cost: { steel: 6, titanium: 3 }, desc: 'Upgrade the car workbench to Tier 3.', upgrade: 'bench' },
  { id: 'bench4', name: 'TITANIUM FORGE', tab: 'upgrades', tier: 4, tierReq: 3, cost: { titanium: 5, cores: 1 }, desc: 'Upgrade the car workbench to Tier 4.', upgrade: 'bench' },
];

const WEATHERS = {
  clear: { label: 'CLEAR', danger: false },
  dust: { label: 'DUST STORM', danger: true },
  heat: { label: 'HEATWAVE 41°C', danger: true },
  rain: { label: 'DRIVING RAIN', danger: false },
  acid: { label: 'ACID RAIN', danger: true },
  storm: { label: 'EMP THUNDERSTORM', danger: true },
  gale: { label: 'GALE WINDS', danger: true },
};

export class Game {
  constructor({ mount, profile, room, onQuit }) {
    this.mount = mount;
    this.profile = profile;
    this.onQuit = onQuit;
    this.hud = new HUD();
    this.audio = new AudioKit();
    this.paused = false;
    this.started = false;
    this.dead = false;
    this.won = false;
    this.kills = 0;
    this.shakeAmt = 0;
    this.time = 0;
    this.hudTimer = 0;
    this.dragLook = 0;
    this.touchMode = ('ontouchstart' in window) || navigator.maxTouchPoints > 1;

    this.setupGraphics();
    this.world = new World(this.scene, 1337);
    this.effects = new Effects(this.scene);
    this.setupPlayer();
    this.setupCamera();
    this.setupInput();
    this.bindHud();

    this.hollows = [];
    this.raiders = [];
    this.tornadoes = [];
    this.spawnTimer = 5;
    this.weather = 'clear';
    this.stormCat = 0;
    this.flash = document.getElementById('flash');
    this.vignette = document.getElementById('vignette');

    this.net = new Net({
      room,
      profile,
      onPeer: (p) => this.onPeer(p),
      onLeave: (p) => this.onPeerLeave(p),
      onChat: (c, own) => this.onChat(c, own),
      onEvent: (e) => this.onNetEvent(e),
      onStatus: (mode, text) => this.onNetStatus(mode, text),
      onCount: (n) => this.onPeerCount(n),
    });

    this.resetRun();
    this.net.start();
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ setup
  setupGraphics() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.85));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.mount.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 1200);
    this.scene.fog = new THREE.Fog(0xb9a68a, 90, 430);
    this.scene.background = new THREE.Color(0xb9a68a);
  }

  setupPlayer() {
    this.car = new Vehicle({ color: this.profile.carColor });
    this.car.group.position.set(7, 0, 30);
    this.car.yaw = Math.PI;
    this.scene.add(this.car.group);

    this.avatar = buildAvatar({ color: this.profile.color, name: this.profile.name });
    this.avatar.root.visible = false;
    this.avatar.root.position.set(7, 0, 30);
    this.scene.add(this.avatar.root);

    this.inCar = true;
    this.pos = new THREE.Vector3(7, 0, 30);
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.hp = 100;
    this.invuln = 0;
    this.walkPhase = 0;
  }

  setupCamera() {
    this.camYaw = Math.PI;
    this.camPitch = 0.24;
    this.camDist = 13;
    this.camPos = new THREE.Vector3(7, 7, 44);
    this.camLook = new THREE.Vector3(7, 1, 30);
  }

  resetRun() {
    this.day = 1;
    this.dayTimer = 0;
    this.zone = 0;
    this.distance = 0;
    this.materials = { scrap: 2, steel: 0, titanium: 0, carbon: 0, leather: 1, chem: 0, cores: 0, fuel: 0 };
    this.benchTier = 1;
    this.owned = new Set(['fists']);
    this.weapon = 'fists';
    this.durability = {};
    this.hp = 100;
    this.kills = 0;
    this.dead = false;
    this.won = false;
    this.paused = false;
    this.inCar = true;
    this.dayTimer = 0;
    this.weather = 'clear';
    this.stormCat = 0;
    this.finalTimer = 0;

    this.scene.remove(this.car.group);
    this.car = new Vehicle({ color: this.profile.carColor });
    this.car.group.position.set(7, 0, 30);
    this.car.yaw = Math.PI;
    this.car.mesh.setAnchored(false, 1);
    this.scene.add(this.car.group);
    this.car.group.visible = true;

    this.pos.set(7, 0, 30);
    this.vel.set(0, 0, 0);
    this.vy = 0;
    this.avatar.root.position.set(7, 0, 30);
    this.avatar.root.visible = false;
    this.camYaw = Math.PI;
    this.camPitch = 0.24;

    this.hollows.forEach((h) => h.die());
    this.hollows = [];
    this.raiders.forEach((r) => r.die());
    this.raiders = [];
    this.tornadoes.forEach((t) => t.dissipate());
    this.tornadoes = [];

    this.world.setZone(0, true);
    this.world.setNight(0);
    this.world.setWeather('clear');
    this.hud.hideGameOver();
    this.spawnTimer = 6;
    this.bossDay = 0;
    this.emptyFuelTimer = 0;
    this.fuelWarned = false;
    this.syncWeapon();
    this.hud.setScavengeReady(false);
    this.hud.setDay(1, 0, ZONES[0].name);
    this.hud.storm(null);
    this.hud.show();
  }

  // ------------------------------------------------------------------ input
  setupInput() {
    this.keys = { forward: 0, back: 0, left: 0, right: 0, boost: false, jump: false };
    this.touchAxes = { x: 0, y: 0 };
    this.chatOpen = false;

    const keyMap = {
      KeyW: 'forward', ArrowUp: 'forward',
      KeyS: 'back', ArrowDown: 'back',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right',
    };

    window.addEventListener('keydown', (e) => {
      if (this.chatOpen) return;
      const k = keyMap[e.code];
      if (k) { this.keys[k] = 1; e.preventDefault(); }
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.boost = true;
      if (e.code === 'Space') { e.preventDefault(); this.toggleAnchor(); }
      if (e.code === 'KeyE') this.toggleCar();
      if (e.code === 'KeyF') this.attack();
      if (e.code === 'KeyG') this.scavenge();
      if (e.code === 'Tab') { e.preventDefault(); this.toggleBench(); }
      if (e.code === 'Escape') { this.hud.closeBench(); this.paused = false; }
      if (e.code === 'Enter') { e.preventDefault(); this.focusChat(); }
    });
    window.addEventListener('keyup', (e) => {
      const k = keyMap[e.code];
      if (k) this.keys[k] = 0;
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') this.keys.boost = false;
    });
    window.addEventListener('blur', () => {
      this.keys.forward = this.keys.back = this.keys.left = this.keys.right = 0;
      this.keys.boost = false;
    });

    const canvas = this.renderer.domElement;
    let down = false, sx = 0, sy = 0, moved = false;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && e.clientX < window.innerWidth * 0.42) {
        this.startStick(e); return;
      }
      down = true; sx = e.clientX; sy = e.clientY; moved = false;
      this.dragLook = 1;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (this.stickActive) { this.moveStick(e); return; }
      if (!down) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      sx = e.clientX; sy = e.clientY;
      this.camYaw -= dx * 0.006;
      this.camPitch = clamp(this.camPitch + dy * 0.004, -0.15, 0.85);
      this.dragLook = 1;
    });
    const endPointer = (e) => {
      if (this.stickActive) { this.endStick(); }
      if (down && !moved && e.type === 'pointerup') this.attack();
      down = false;
      canvas.releasePointerCapture?.(e.pointerId);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      this.camDist = clamp(this.camDist + Math.sign(e.deltaY) * 1.2, 6, 26);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // chat
    const chatInput = document.getElementById('chatInput');
    chatInput.addEventListener('focus', () => { this.chatOpen = true; this.keys.forward = this.keys.back = this.keys.left = this.keys.right = 0; });
    chatInput.addEventListener('blur', () => { this.chatOpen = false; });
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const v = chatInput.value.trim();
        if (v) this.net.chat(v);
        chatInput.value = '';
        chatInput.blur();
      } else if (e.key === 'Escape') {
        chatInput.blur();
      }
    });

    // browsers can leave the audio graph suspended until a gesture — re-arm it
    const arm = () => { try { this.audio.init(); } catch {} };
    window.addEventListener('pointerdown', arm, { once: false });
    window.addEventListener('keydown', arm, { once: false });

    if (this.touchMode) this.buildTouchButtons();
  }

  buildTouchButtons() {
    const wrap = document.getElementById('actions');
    const use = document.createElement('button');
    use.className = 'act'; use.id = 'useBtn';
    use.innerHTML = '<span class="act-ico">🚪</span><span class="act-txt">ENTER / EXIT<em>TAP</em></span>';
    use.addEventListener('click', () => this.toggleCar());
    const atk = document.createElement('button');
    atk.className = 'act'; atk.id = 'atkBtn';
    atk.innerHTML = '<span class="act-ico">🔪</span><span class="act-txt">ATTACK<em>TAP</em></span>';
    atk.addEventListener('click', () => this.attack());
    wrap.prepend(use, atk);

    const stick = document.createElement('div');
    stick.id = 'stick';
    stick.style.cssText = 'position:fixed;left:26px;bottom:150px;width:120px;height:120px;border-radius:50%;border:1px solid rgba(255,179,71,.35);background:rgba(8,10,15,.35);z-index:30;display:none;pointer-events:none';
    stick.innerHTML = '<div id="stickKnob" style="position:absolute;left:35px;top:35px;width:50px;height:50px;border-radius:50%;background:rgba(255,179,71,.55);border:1px solid #ffd9a0"></div>';
    document.body.appendChild(stick);
    this.stickEl = stick;
  }

  startStick(e) {
    this.stickActive = true;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    this.stickEl.style.display = 'block';
    this.stickEl.style.left = `${e.clientX - 60}px`;
    this.stickEl.style.top = `${e.clientY - 60}px`;
    this.stickEl.style.bottom = 'auto';
    this.moveStick(e);
  }
  moveStick(e) {
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const mag = Math.min(1, Math.hypot(dx, dy) / 48);
    const ang = Math.atan2(dy, dx);
    this.touchAxes.x = Math.cos(ang) * mag;
    this.touchAxes.y = Math.sin(ang) * mag;
    this.keys.forward = clamp(-this.touchAxes.y, 0, 1);
    this.keys.back = clamp(this.touchAxes.y, 0, 1);
    this.keys.left = clamp(-this.touchAxes.x, 0, 1);
    this.keys.right = clamp(this.touchAxes.x, 0, 1);
    const k = document.getElementById('stickKnob');
    if (k) { k.style.left = `${35 + Math.cos(ang) * mag * 34}px`; k.style.top = `${35 + Math.sin(ang) * mag * 34}px`; }
  }
  endStick() {
    this.stickActive = false;
    this.stickEl.style.display = 'none';
    this.keys.forward = this.keys.back = this.keys.left = this.keys.right = 0;
  }

  bindHud() {
    document.getElementById('anchorBtn').addEventListener('click', () => this.toggleAnchor());
    document.getElementById('benchBtn').addEventListener('click', () => this.toggleBench());
    document.getElementById('scavBtn').addEventListener('click', () => this.scavenge());
    document.getElementById('benchClose').addEventListener('click', () => this.toggleBench(false));
    document.getElementById('respawnBtn').addEventListener('click', () => { this.resetRun(); this.paused = false; });
    document.getElementById('lobbyBtn').addEventListener('click', () => this.onQuit?.());
    this.hud.onCraft = (id) => this.craft(id);
  }

  focusChat() {
    const el = document.getElementById('chatInput');
    if (this.paused) return;
    el.focus();
  }

  // ------------------------------------------------------------------ loops
  loop() {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    if (this.started && !this.paused) this.update(dt);
    else this.updateIdle(dt);
    this.updateCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }

  updateIdle(dt) {
    this.effects.update(dt);
    this.world.updateWeather(dt, this.camera.position);
  }

  update(dt) {
    if (!this.dead && !this.won) this.dayTimer += dt;

    // day / zone progression
    const targetZone = this.day <= 15 ? 0 : this.day <= 40 ? 1 : this.day <= 65 ? 2 : this.day <= 85 ? 3 : 4;
    if (targetZone !== this.zone) {
      this.zone = targetZone;
      this.world.setZone(this.zone);
      this.hud.toast(`ENTERING ${ZONES[this.zone].name}`, 'warn');
      this.hud.chat('', `— ${ZONES[this.zone].name} — ${ZONES[this.zone].desc}`, '#ffb347', true);
    }

    if (this.dayTimer >= DAY_LENGTH && !this.dead && !this.won) {
      this.dayTimer = 0;
      this.newDay();
    }

    // passive time-of-day lighting
    const cycle = (this.time * 0.008 + 0.22) % 1;
    const nightT = this.zone === 4 ? 0.5 + Math.sin(cycle * Math.PI * 2) * 0.28 : clamp((Math.sin(cycle * Math.PI * 2) - 0.35) * 1.7, 0, 0.72);
    this.world.setNight(nightT);
    if (this.car.mesh.beams) this.car.mesh.beams.forEach((b) => (b.intensity = lerp(6, 30, nightT)));

    // controls
    const throttle = clamp(this.keys.forward - this.keys.back, -1, 1);
    if (this.inCar) {
      this.car.update(dt, {
        forward: this.keys.forward, back: this.keys.back,
        left: this.keys.left, right: this.keys.right, boost: this.keys.boost,
      }, this.world, (dmg) => this.onCarScrape(dmg));
      this.pos.copy(this.car.pos);
      this.pos.y = 0;
      this.distance = this.car.distance;
      this.speedKmh = this.car.kmh;
      this.pos.y = this.car.mesh.group.position.y;
      this.runOver();
      if (this.car.fuel <= 0.01) {
        this.emptyFuelTimer = (this.emptyFuelTimer || 0) + dt;
        if (this.emptyFuelTimer > 2.5 && !this.fuelWarned) {
          this.fuelWarned = true;
          this.hud.toast('TANK DRY — FIND A PIT-STOP OR CRAFT FUEL', 'bad');
          this.audio.alarm();
        }
      } else {
        this.emptyFuelTimer = 0;
        this.fuelWarned = false;
      }
    } else {
      this.updateFoot(dt);
      this.speedKmh = Math.hypot(this.vel.x, this.vel.z) * 3.6;
    }

    // systems
    this.updateWeather(dt);
    this.updateTornadoes(dt);
    this.updateEnemies(dt);
    this.updateSpawning(dt);
    this.updateInteraction();
    this.updatePeers(dt);
    this.world.update(dt, this.pos, this.zone);
    this.world.updateWeather(dt, this.camera.position, this.stormCat > 0 ? 30 : 0);
    this.effects.update(dt);

    // engine smoke
    if (this.car.engine < 45 && this.car.engine > 0) {
      this.car.smokeTimer -= dt;
      if (this.car.smokeTimer <= 0) {
        this.car.smokeTimer = 0.18;
        const p = new THREE.Vector3(0, 0.4, -2.2).applyMatrix4(this.car.group.matrixWorld);
        this.effects.smoke(p, 2, this.car.engine < 20);
      }
    }

    // audio
    this.audio.setEngine(this.inCar ? this.car.kmh : 0, this.car.boost > 0.5);
    const nearestStorm = this.tornadoes.reduce((m, t) => Math.min(m, Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z)), 9999);
    this.audio.setAmbience(nearestStorm < 320 ? clamp(1 - nearestStorm / 320, 0, 1) : 0.12, nearestStorm < 220 ? clamp(1 - nearestStorm / 220, 0, 1) : 0);

    // hit flash decay & invuln
    if (this.invuln > 0) this.invuln -= dt;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 2.6);

    // hud
    this.hudTimer += dt;
    if (this.hudTimer > 0.09) {
      this.hudTimer = 0;
      this.hud.setDay(this.day, this.dayTimer / DAY_LENGTH, ZONES[this.zone].name);
      this.hud.setSpeed(this.speedKmh || 0);
      this.hud.setDistance(this.distance / 1000);
      this.hud.setDiagnostics({
        engine: this.car.engine, chassis: this.car.chassis, tires: this.car.tires,
        fuel: this.car.fuel, maxFuel: this.car.maxFuel, hp: this.hp,
        weapon: this.weaponLabel(), anchored: this.car.anchored,
        anchorTier: this.car.anchorTier, inCar: this.inCar,
      });
      this.hud.drawRadar(this.radarBlips(), this.inCar ? this.car.yaw : this.avatar.root.rotation.y, 350);
      this.hud.setParty(this.partyRows());
      const stop = this.world.nearestPitStop(this.pos.x, this.pos.z, 20);
      this.hud.setScavengeReady(!!stop && stop.scavengeReady, stop ? stop.kind.toUpperCase() : '');
    }

    // multiplayer broadcast
    this.net.pushState({
      x: this.inCar ? this.car.pos.x : this.avatar.root.position.x,
      y: this.pos.y || 0,
      z: this.inCar ? this.car.pos.z : this.avatar.root.position.z,
      yaw: this.inCar ? this.car.yaw : this.avatar.root.rotation.y,
      inCar: this.inCar, speed: this.speedKmh || 0, hp: this.hp,
      day: this.day, weapon: this.weapon, anchored: this.car.anchored,
    }, performance.now());

    // endgame timer
    if (this.day === 100 && !this.won && !this.dead) {
      this.finalTimer += dt;
      if (this.finalTimer > 120) this.win();
    }
  }

  // ------------------------------------------------------------------ days
  newDay() {
    this.day = Math.min(100, this.day + 1);
    const m = MILESTONES[this.day];
    if (m) {
      this.hud.toast(`DAY ${this.day} · ${m[0]}`, 'warn');
      this.hud.chat('', `${m[0]} — ${m[1]}`, '#ffd9a0', true);
      this.audio.alarm();
    } else {
      this.hud.toast(`DAY ${this.day} / 100`, '');
    }
    if (this.day === 15) { this.benchTier = Math.max(this.benchTier, 2); this.hud.toast('WORKBENCH UPGRADED TO TIER 2', 'good'); }
    if (this.day === 40) { this.benchTier = Math.max(this.benchTier, 3); this.hud.toast('WORKBENCH UPGRADED TO TIER 3', 'good'); }
    if (this.day === 78) { this.benchTier = Math.max(this.benchTier, 4); this.hud.toast('WORKBENCH UPGRADED TO TIER 4', 'good'); }
    if (this.day === 100) {
      this.hud.chat('', 'The Category 5 Hypercane is on the horizon. Anchor down and survive 2 minutes.', '#ff6d7b', true);
    }
    this.rollWeather();
    this.spawnTimer = Math.min(this.spawnTimer, 3);
  }

  rollWeather() {
    const r = Math.random();
    const d = this.day;
    let w = 'clear';
    if (d >= 86) w = r < 0.5 ? 'rain' : r < 0.72 ? 'storm' : r < 0.88 ? 'gale' : 'clear';
    else if (this.zone === 0) w = r < 0.28 ? 'dust' : r < 0.36 ? 'rain' : 'clear';
    else if (this.zone === 1) w = r < 0.24 ? 'storm' : r < 0.42 ? 'rain' : r < 0.55 ? 'dust' : 'clear';
    else if (this.zone === 2) w = r < 0.25 ? 'acid' : r < 0.42 ? 'storm' : r < 0.58 ? 'dust' : 'clear';
    else if (this.zone === 3) w = r < 0.34 ? 'heat' : r < 0.5 ? 'dust' : 'clear';

    if (d === 10) w = 'gale';
    if (d === 18 || d === 25) w = 'storm';
    if (d === 42 || d === 52) w = 'acid';
    if (d === 68 || d === 75 || d === 82) w = 'heat';
    this.setWeather(w);

    // storm events
    const stormDays = { 14: 2, 35: 3, 60: 4, 80: 4, 100: 5 };
    if (stormDays[d]) this.spawnTornado(stormDays[d]);
    else if (d > 8 && Math.random() < 0.16 + d * 0.002) {
      this.spawnTornado(clamp(1 + Math.floor(d / 24), 1, 5));
    }
  }

  setWeather(kind) {
    this.weather = kind;
    const info = WEATHERS[kind] || WEATHERS.clear;
    this.world.setWeather(kind);
    this.hud.setWeather(info.label, info.danger);
    if (kind === 'acid') this.hud.toast('ACID RAIN — HULL AND BLADES DEGRADING', 'bad');
  }

  spawnTornado(category) {
    if (this.tornadoes.length >= 2) return;
    const cat = clamp(category, 1, 5);
    const angle = rand(0, Math.PI * 2);
    const dist = rand(160, 260);
    const pos = new THREE.Vector3(this.pos.x + Math.cos(angle) * dist, 0, this.pos.z + Math.sin(angle) * dist);
    const t = new Tornado(this.scene, cat, pos);
    this.tornadoes.push(t);
    this.stormCat = Math.max(this.stormCat, cat);
    const names = { 1: 'CATEGORY 1 GALE VORTEX', 2: 'CATEGORY 2 MINI-TORNADO', 3: 'CATEGORY 3 TORNADO', 4: 'CATEGORY 4 TWIN-CELL', 5: 'CATEGORY 5 HYPERCANE' };
    this.hud.storm(names[cat], 'DEPLOY ANCHORS · STAY CLEAR OF THE CORE');
    this.hud.toast(`⚠ ${names[cat]} INBOUND`, 'bad');
    this.audio.alarm();
    setTimeout(() => {
      if (this.tornadoes.length === 0) this.hud.storm(null);
    }, 6000);
  }

  // -------------------------------------------------------------- movement
  updateFoot(dt) {
    const camF = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const camR = new THREE.Vector3(-Math.cos(this.camYaw), 0, Math.sin(this.camYaw));
    const f = this.keys.forward - this.keys.back;
    const s = this.keys.right - this.keys.left;
    const move = new THREE.Vector3().addScaledVector(camF, f).addScaledVector(camR, s);
    if (move.lengthSq() > 0.001) move.normalize();
    const sprint = this.keys.boost;
    const speed = sprint ? 8.4 : 4.9;
    const pos = this.avatar.root.position;

    const nx = pos.x + move.x * speed * dt;
    const nz = pos.z + move.z * speed * dt;
    const cx = clamp(nx, -220, 220);
    if (!this.world.collide(cx, nz, 0.55)) { pos.x = cx; pos.z = nz; }

    // jump
    if (this.keys.jump && pos.y <= 0.001) { this.vy = 5.4; this.keys.jump = false; }
    if (pos.y > 0 || this.vy !== 0) {
      this.vy -= 15 * dt;
      pos.y += this.vy * dt;
      if (pos.y < 0) { pos.y = 0; this.vy = 0; }
    }

    if (move.lengthSq() > 0.001) {
      const target = Math.atan2(move.x, move.z);
      this.avatar.root.rotation.y = angleLerp(this.avatar.root.rotation.y, target, 1 - Math.exp(-12 * dt));
    }
    const moving = move.lengthSq() > 0.001 ? (sprint ? 1.3 : 0.85) : 0;
    this.avatar.animate(dt, moving, pos.y > 0.05);
    this.pos.set(pos.x, pos.y, pos.z);

    if (this.world.isOffroad(pos.x) && Math.random() < 0.2) {
      this.effects.emit(new THREE.Vector3(pos.x, 0.1, pos.z), 1, { color: 0x8b7a5f, spread: 0.4, up: 0.5, life: 0.4, gravity: 2 });
    }
  }

  updateCamera(dt) {
    const focus = this.inCar ? this.car.pos : this.avatar.root.position;
    const wantFocus = new THREE.Vector3(focus.x, focus.y + (this.inCar ? 1.5 : 1.55), focus.z);
    this.dragLook = Math.max(0, this.dragLook - dt * 0.35);
    if (this.inCar && this.dragLook <= 0) {
      this.camYaw = angleLerp(this.camYaw, this.car.yaw, 1 - Math.exp(-2.4 * dt));
      this.camPitch = damp(this.camPitch, 0.24, 2, dt);
      this.camDist = damp(this.camDist, 13 + clamp(this.car.kmh / 22, 0, 3), 1.6, dt);
    }
    const dist = this.camDist;
    const cy = Math.cos(this.camPitch);
    const desired = new THREE.Vector3(
      wantFocus.x - Math.sin(this.camYaw) * dist * cy,
      wantFocus.y + Math.sin(this.camPitch) * dist + 0.9,
      wantFocus.z - Math.cos(this.camYaw) * dist * cy,
    );
    desired.y = Math.max(desired.y, 1.0);
    const k = 1 - Math.exp(-8 * dt);
    this.camPos.lerp(desired, k);
    this.camLook.lerp(wantFocus, 1 - Math.exp(-12 * dt));

    const shake = this.shakeAmt;
    this.camera.position.copy(this.camPos);
    if (shake > 0) {
      this.camera.position.x += rand(-shake, shake) * 0.5;
      this.camera.position.y += rand(-shake, shake) * 0.35;
      this.camera.position.z += rand(-shake, shake) * 0.5;
    }
    this.camera.lookAt(this.camLook);
  }

  // ------------------------------------------------------------------ actions
  toggleAnchor() {
    if (!this.inCar) { this.keys.jump = true; return; }
    if (this.car.dead) return;
    if (!this.car.anchored && Math.abs(this.car.speed) > 13) {
      this.hud.toast('SLOW BELOW 45 KM/H TO DEPLOY ANCHORS', 'warn');
      return;
    }
    this.car.toggleAnchor();
    this.audio.blip(this.car.anchored ? 420 : 620, 0.14, 'square', 0.11);
    this.hud.toast(this.car.anchored ? 'ANCHOR SPIKES DEPLOYED' : 'ANCHORS RELEASED', this.car.anchored ? 'good' : '');
    this.net.event('anchor', { on: this.car.anchored, x: this.car.pos.x, z: this.car.pos.z });
  }

  toggleCar() {
    if (this.inCar) {
      if (Math.abs(this.car.speed) > 4) { this.hud.toast('STOP THE RIG BEFORE BAILING OUT', 'warn'); return; }
      this.inCar = false;
      this.car.occupied = false;
      const side = new THREE.Vector3(Math.cos(this.car.yaw), 0, -Math.sin(this.car.yaw)).multiplyScalar(2.4);
      this.avatar.root.position.set(this.car.pos.x + side.x, 0, this.car.pos.z + side.z);
      this.avatar.root.rotation.y = this.car.yaw;
      this.avatar.root.visible = true;
      this.car.toggleAnchor(false);
      this.audio.blip(300, 0.1, 'square', 0.1);
    } else {
      if (dist2(this.avatar.root.position, this.car.pos) > 6.5) { this.hud.toast('TOO FAR FROM THE RIG', 'warn'); return; }
      if (this.car.dead) { this.hud.toast('THE RIG IS WRECKED — REPAIR IT FIRST', 'bad'); return; }
      this.inCar = true;
      this.car.occupied = true;
      this.avatar.root.visible = false;
      this.audio.blip(520, 0.1, 'square', 0.1);
    }
  }

  weaponLabel() {
    const w = WEAPON_DATA[this.weapon];
    if (!w) return 'FISTS';
    if (!isFinite(w.dur)) return w.name;
    return `${w.name} ${Math.max(0, Math.round(this.durability[this.weapon] ?? w.dur))}/${w.dur}`;
  }

  syncWeapon() {
    this.avatar.setWeapon(this.weapon);
    if (this.weapon !== 'fists' && this.durability[this.weapon] === undefined) {
      this.durability[this.weapon] = WEAPON_DATA[this.weapon].dur;
    }
  }

  attack() {
    if (this.paused || this.dead || this.won) return;
    if (this.inCar) {
      this.audio.blip(220, 0.4, 'square', 0.09);
      return;
    }
    if (this.time - (this.lastAttack || 0) < (WEAPON_DATA[this.weapon]?.cd || 0.5)) return;
    this.lastAttack = this.time;
    const w = WEAPON_DATA[this.weapon];
    this.avatar.attack();
    this.audio.swing();

    if (w.ranged) {
      this.audio.shot();
      this.effects.emit(this.avatar.root.position.clone().add(new THREE.Vector3(0, 1.4, 0)), 6, { color: 0xffd06a, spread: 0.6, up: 1.4, life: 0.18, gravity: 1 });
      const aim = new THREE.Vector3(Math.sin(this.avatar.root.rotation.y), 0, Math.cos(this.avatar.root.rotation.y));
      const origin = this.avatar.root.position;
      let best = null, bestD = w.range;
      [...this.hollows, ...this.raiders].forEach((e) => {
        const dx = e.pos.x - origin.x, dz = e.pos.z - origin.z;
        const d = Math.hypot(dx, dz);
        if (d > w.range) return;
        const dot = (dx / d) * aim.x + (dz / d) * aim.z;
        if (dot < 0.82) return;
        if (d < bestD) { bestD = d; best = e; }
      });
      if (best) {
        best.hit(w.dmg, origin);
        this.effects.blood(best.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), aim);
        this.audio.hit();
        if (best.dead) this.onKill(best);
      }
      this.useDurability(1);
      return;
    }

    // melee arc
    const aim = new THREE.Vector3(Math.sin(this.avatar.root.rotation.y), 0, Math.cos(this.avatar.root.rotation.y));
    const origin = this.avatar.root.position;
    let hits = 0;
    [...this.hollows, ...this.raiders].forEach((e) => {
      const dx = e.pos.x - origin.x, dz = e.pos.z - origin.z;
      const d = Math.hypot(dx, dz);
      if (d > w.range + 1) return;
      const dot = (dx / (d || 1)) * aim.x + (dz / (d || 1)) * aim.z;
      if (dot < 0.25) return;
      let dmg = w.dmg;
      if (w.crit && Math.random() < w.crit) dmg *= 1.9;
      if (e.boss) dmg *= 0.8;
      e.hit(dmg, origin);
      hits++;
      this.effects.blood(e.pos.clone().add(new THREE.Vector3(0, 1.2, 0)), aim);
      if (e.dead) this.onKill(e);
    });
    if (hits) { this.audio.hit(); this.shakeAmt = Math.max(this.shakeAmt, 0.16); }
    this.useDurability(1);
  }

  useDurability(n = 1) {
    if (this.weapon === 'fists') return;
    this.durability[this.weapon] = (this.durability[this.weapon] ?? WEAPON_DATA[this.weapon].dur) - n;
    if (this.durability[this.weapon] <= 0) {
      this.hud.toast(`${WEAPON_DATA[this.weapon].name} BROKE`, 'bad');
      this.owned.delete(this.weapon);
      this.weapon = 'fists';
      this.syncWeapon();
    }
  }

  runOver() {
    if (Math.abs(this.car.speed) < 6) return;
    const fwd = this.car.forward;
    [...this.hollows, ...this.raiders].forEach((e) => {
      const d = Math.hypot(e.pos.x - this.car.pos.x, e.pos.z - this.car.pos.z);
      if (d < 3.2) {
        const dot = ((e.pos.x - this.car.pos.x) / d) * fwd.x + ((e.pos.z - this.car.pos.z) / d) * fwd.z;
        if (dot < 0.2) return;
        e.hit(Math.abs(this.car.speed) * 5.5, this.car.pos);
        this.effects.blood(e.pos.clone().add(new THREE.Vector3(0, 1, 0)), fwd);
        this.audio.hit();
        this.shakeAmt = Math.max(this.shakeAmt, 0.22);
        if (e.dead) this.onKill(e);
      }
    });
  }

  scavenge() {
    if (this.paused || this.dead) return;
    const stop = this.world.nearestPitStop(this.pos.x, this.pos.z, 20);
    if (!stop) { this.hud.toast('NOTHING TO SCAVENGE — FIND A PIT-STOP', 'warn'); return; }
    if (!stop.scavengeReady || stop.cooldown > 0) { this.hud.toast('THIS STOP IS PICKED CLEAN', 'warn'); return; }

    const z = this.zone;
    const loot = {
      scrap: randInt(3, 6 + z),
      steel: randInt(0, 1 + z),
      leather: randInt(0, 2),
      chem: randInt(0, 1 + Math.floor(z / 2)),
      titanium: z >= 1 ? randInt(0, 1 + Math.floor(z / 2)) : 0,
      carbon: z >= 1 ? randInt(0, 2) : 0,
      cores: Math.random() < 0.05 + z * 0.03 ? 1 : 0,
      fuel: stop.kind === 'gas' ? randInt(8, 16) : randInt(2, 7),
    };
    Object.entries(loot).forEach(([k, v]) => {
      if (k === 'fuel') { this.car.fuel = clamp(this.car.fuel + v, 0, this.car.maxFuel); return; }
      if (v > 0) this.materials[k] = (this.materials[k] || 0) + v;
    });

    stop.scavengeReady = false;
    stop.cooldown = 12;
    stop.crates.visible = false;
    const txt = Object.entries(loot).filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${k === 'fuel' ? 'L FUEL' : k.toUpperCase()}`).join(' · ');
    this.hud.toast(`SCAVENGED: ${txt}`, 'good');
    this.audio.pickup();
    this.effects.emit(new THREE.Vector3(stop.x, 1.2, stop.z), 16, { color: 0x9dffb8, spread: 2.4, up: 3.4, life: 0.8, gravity: 6 });
  }

  onKill(e) {
    this.kills++;
    const at = e.pos.clone().add(new THREE.Vector3(0, 1.2, 0));
    if (e instanceof RaiderCar || e.boss) {
      this.effects.explosion(at, e.boss ? 1.8 : 1);
      this.audio.explosion ? this.audio.explosion() : this.audio.crash();
      this.materials.steel = (this.materials.steel || 0) + randInt(2, 4);
      this.materials.scrap = (this.materials.scrap || 0) + randInt(2, 5);
      if (Math.random() < 0.3) this.materials.titanium = (this.materials.titanium || 0) + 1;
      if (Math.random() < 0.16) this.materials.carbon = (this.materials.carbon || 0) + 1;
      if (Math.random() < 0.12) this.materials.cores = (this.materials.cores || 0) + 1;
      this.hud.toast('RAIDER RIG DESTROYED · SALVAGE COLLECTED', 'good');
      this.net.event('boom', { x: e.pos.x, z: e.pos.z });
      const idx = this.raiders.indexOf(e);
      if (idx >= 0) this.raiders.splice(idx, 1);
    } else {
      this.effects.blood(at, new THREE.Vector3(0, 1, 0));
      if (Math.random() < 0.55) this.materials.scrap = (this.materials.scrap || 0) + randInt(1, 2);
      if (Math.random() < 0.2) this.materials.leather = (this.materials.leather || 0) + 1;
      this.net.event('kill', { x: e.pos.x, z: e.pos.z });
      const idx = this.hollows.indexOf(e);
      if (idx >= 0) this.hollows.splice(idx, 1);
    }
  }

  // ------------------------------------------------------------------ craft
  toggleBench(force) {
    const open = force === undefined ? !this.hud.benchOpen : force;
    if (open) {
      if (this.dead || this.won) return;
      this.paused = true;
      this.hud.ownedWeapons = [...this.owned];
      const recipes = RECIPES.map((r) => {
        let maxed = false;
        if (r.upgrade === 'armor' && this.car.armorLevel >= 3) maxed = true;
        if (r.upgrade === 'anchors' && this.car.anchorTier >= 4) maxed = true;
        if (r.upgrade === 'bench' && this.benchTier >= (r.tier || 2)) maxed = true;
        return { ...r, maxed };
      });
      this.hud.openBench(this.benchTier, this.materials, recipes);
      this.audio.blip(560, 0.1, 'triangle', 0.08);
    } else {
      this.paused = false;
      this.hud.closeBench();
    }
  }

  craft(id) {
    const r = RECIPES.find((x) => x.id === id);
    if (!r) return;
    if ((r.tierReq || 1) > this.benchTier) { this.hud.toast(`NEED WORKBENCH TIER ${r.tierReq}`, 'bad'); return; }
    if (r.weapon && this.owned.has(r.weapon)) return;
    for (const [k, v] of Object.entries(r.cost)) {
      if ((this.materials[k] || 0) < v) { this.hud.toast(`NOT ENOUGH ${k.toUpperCase()}`, 'bad'); return; }
    }
    if (r.upgrade === 'armor' && this.car.armorLevel >= 3) return;
    if (r.upgrade === 'anchors' && this.car.anchorTier >= 4) return;
    if (r.upgrade === 'bench' && this.benchTier >= (r.tier || 2)) return;

    for (const [k, v] of Object.entries(r.cost)) this.materials[k] -= v;

    if (r.weapon) {
      this.owned.add(r.weapon);
      this.durability[r.weapon] = WEAPON_DATA[r.weapon].dur;
      this.weapon = r.weapon;
      this.syncWeapon();
      this.hud.toast(`${r.name} CRAFTED & EQUIPPED`, 'good');
    } else if (r.id === 'fuelcan') {
      this.car.fuel = clamp(this.car.fuel + 12, 0, this.car.maxFuel);
      this.hud.toast('+12L FUEL', 'good');
    } else if (r.id === 'superfuel') {
      this.car.fuel = clamp(this.car.fuel + 26, 0, this.car.maxFuel);
      this.hud.toast('+26L SUPER FUEL', 'good');
    } else if (r.id === 'repairkit') {
      this.car.chassis = clamp(this.car.chassis + 30, 0, 100);
      this.car.engine = clamp(this.car.engine + 30, 0, 100);
      this.car.dead = false;
      this.hud.toast('CHASSIS & ENGINE REPAIRED', 'good');
    } else if (r.id === 'tirepatch') {
      this.car.tires = clamp(this.car.tires + 35, 0, 100);
      this.hud.toast('TIRES PATCHED', 'good');
    } else if (r.id === 'fullfix') {
      this.car.engine = 100; this.car.tires = 100; this.car.chassis = 100; this.car.dead = false;
      this.hud.toast('FULL OVERHAUL COMPLETE', 'good');
    } else if (r.upgrade === 'armor') {
      this.car.upgradeArmor();
      this.hud.toast(`ARMOR PLATING LV${this.car.armorLevel}`, 'good');
    } else if (r.upgrade === 'anchors') {
      this.car.upgradeAnchor();
      this.hud.toast(`ANCHOR TIER ${this.car.anchorTier}`, 'good');
    } else if (r.upgrade === 'bench') {
      this.benchTier = Math.max(this.benchTier, r.tier);
      this.hud.benchTier.textContent = `TIER ${this.benchTier}`;
      this.hud.toast(`WORKBENCH UPGRADED TO TIER ${this.benchTier}`, 'good');
    }
    this.audio.craft();
    this.hud.ownedWeapons = [...this.owned];
    this.hud.tier = this.benchTier;
    this.hud.inv = this.materials;
    const recipes = RECIPES.map((rr) => {
      let maxed = false;
      if (rr.upgrade === 'armor' && this.car.armorLevel >= 3) maxed = true;
      if (rr.upgrade === 'anchors' && this.car.anchorTier >= 4) maxed = true;
      if (rr.upgrade === 'bench' && this.benchTier >= (rr.tier || 2)) maxed = true;
      return { ...rr, maxed };
    });
    this.hud.recipes = recipes;
    this.hud.refreshBench();
  }

  // ------------------------------------------------------------------ world
  updateWeather(dt) {
    if (this.weather === 'acid' && !this.inCar) {
      this.acidTick = (this.acidTick || 0) + dt;
      if (this.acidTick > 4) {
        this.acidTick = 0;
        this.useDurability(1);
        this.hp = clamp(this.hp - 2, 0, 100);
        this.hud.toast('ACID RAIN BURNS EXPOSED SKIN', 'warn');
      }
    }
    if (this.weather === 'heat') this.car.engine = clamp(this.car.engine - dt * 0.55, 0, 100);
    if (this.weather === 'storm' && Math.random() < dt * 0.14) {
      this.flash.style.background = '#dfeaff';
      this.flash.style.opacity = '0.22';
      setTimeout(() => (this.flash.style.opacity = '0'), 90);
      this.audio.noiseBurst(0.5, 160, 0.2, 'lowpass');
    }
  }

  updateTornadoes(dt) {
    if (!this.tornadoes.length) { this.stormCat = 0; return; }
    let closest = 9999;
    for (let i = this.tornadoes.length - 1; i >= 0; i--) {
      const t = this.tornadoes[i];
      t.update(dt, this.pos);
      const d = Math.hypot(t.pos.x - this.pos.x, t.pos.z - this.pos.z);
      closest = Math.min(closest, d);
      const force = t.forceAt(this.pos.x, this.pos.z);
      if (force) {
        if (this.inCar) {
          if (this.car.anchored) {
            if (d < 40) this.hud.storm('ANCHORS HOLDING', `CATEGORY ${t.category} VORTEX · ${Math.round(d)}m`);
          } else {
            this.car.pos.x += force.x * dt * 0.75;
            this.car.pos.z += force.z * dt * 0.75;
            this.car.speed *= 1 - 0.4 * dt;
            this.car.airY = clamp(this.car.airY + force.lift * dt * 0.05, 0, 2.6);
            this.car.yaw += force.x * dt * 0.006;
            this.tornadoDamage = (this.tornadoDamage || 0) + dt;
            if (this.tornadoDamage > 1.4) {
              this.tornadoDamage = 0;
              this.car.damage(3 + t.category, 'chassis');
              this.car.damage(2, 'tires');
              this.hurt(2, 'TOSSED BY THE VORTEX');
            }
          }
        } else {
          const p = this.avatar.root.position;
          p.x += force.x * dt * 0.55;
          p.z += force.z * dt * 0.55;
          if (force.strength > 0.55) this.hurt(dt * 12 * force.strength, 'CAUGHT IN THE VORTEX');
          this.hud.storm('GET BEHIND COVER', `CATEGORY ${t.category} VORTEX · ${Math.round(d)}m`);
        }
        this.shakeAmt = Math.max(this.shakeAmt, clamp(force.strength * 0.6, 0, 0.55));
      }
      if (t.dead) {
        this.tornadoes.splice(i, 1);
        this.hud.storm(null);
      }
    }
    this.car.airY = damp(this.car.airY, 0, 1.6, dt);
    if (closest > 240) this.hud.storm(null);
  }

  updateSpawning(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0 || this.dead) return;
    this.spawnTimer = clamp(16 - this.day * 0.08, 6.5, 16);
    const maxH = Math.min(16, 4 + Math.floor(this.day / 7));
    if (this.hollows.length < maxH) {
      const n = clamp(1 + Math.floor(this.day / 15), 1, 4);
      for (let i = 0; i < n && this.hollows.length < maxH; i++) {
        const ang = rand(0, Math.PI * 2);
        const d = rand(42, 82);
        const h = new Hollow(this.scene, this.pos.x + Math.cos(ang) * d, this.pos.z + Math.sin(ang) * d, this.day);
        this.hollows.push(h);
      }
    }
    if (this.day >= 5 && this.raiders.length < Math.min(4, 1 + Math.floor(this.day / 25)) && Math.random() < 0.5) {
      const ang = rand(0, Math.PI * 2);
      const d = rand(90, 140);
      this.raiders.push(new RaiderCar(this.scene, this.pos.x + Math.cos(ang) * d, this.pos.z + Math.sin(ang) * d, this.day));
    }
    if ((this.day === 40 || this.day === 95) && this.bossDay !== this.day) {
      this.bossDay = this.day;
      const ang = rand(0, Math.PI * 2);
      this.raiders.push(new RaiderCar(this.scene, this.pos.x + Math.cos(ang) * 120, this.pos.z + Math.sin(ang) * 120, this.day + 10, true));
      this.hud.toast('BOSS RIG DETECTED — ARMORED RAIDER APPROACHING', 'bad');
      this.audio.alarm();
    }
  }

  updateEnemies(dt) {
    const target = { x: this.pos.x, z: this.pos.z, inCar: this.inCar };
    const hooks = {
      onAttack: (h) => {
        if (this.inCar) {
          this.car.damage(h.damage * 0.8, 'chassis');
          this.hurt(h.damage * 0.35, 'SCAVENGER HITS THE HULL');
        } else {
          this.hurt(h.damage, 'SCAVENGER STRIKE');
        }
        this.effects.emit(h.pos.clone().add(new THREE.Vector3(0, 1.3, 0)), 6, { color: 0xff5b33, spread: 1.6, up: 2, life: 0.35, gravity: 8 });
        this.audio.hit();
      },
    };
    const raiderHooks = {
      onDust: (p, drive) => {
        if (Math.random() < 0.12) this.effects.emit(new THREE.Vector3(p.x, 0.2, p.z), 1, { color: 0x9c8a6c, spread: 0.8, up: 1.2, life: 0.5, gravity: 1.5 });
      },
      onRam: (r) => {
        if (this.inCar) {
          this.car.damage(r.damage, 'chassis');
          this.car.speed *= 0.55;
          this.hurt(r.damage * 0.3, 'RAMMED BY A RAIDER');
        } else {
          this.hurt(r.damage, 'RAIDER RUNS YOU DOWN');
          this.avatar.root.position.x += rand(-2, 2);
        }
        this.effects.explosion(r.pos.clone().add(new THREE.Vector3(0, 1, 0)), 0.5);
        this.shakeAmt = Math.max(this.shakeAmt, 0.5);
        this.audio.crash();
      },
    };
    for (let i = this.hollows.length - 1; i >= 0; i--) {
      const h = this.hollows[i];
      h.update(dt, target, hooks);
      if (Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) > 420) { h.die(); this.hollows.splice(i, 1); }
    }
    for (const r of this.raiders) r.update(dt, target, raiderHooks);
  }

  updateInteraction() {
    if (this.paused || this.dead) return;
    if (this.inCar) this.hud.prompt('');
    else {
      const d = dist2(this.avatar.root.position, this.car.pos);
      if (d < 6.5) this.hud.prompt('[E] ENTER THE RIG');
      else {
        const stop = this.world.nearestPitStop(this.pos.x, this.pos.z, 20);
        this.hud.prompt(stop ? `[G] SCAVENGE ${stop.label}` : '');
      }
    }
  }

  radarBlips() {
    const blips = [];
    const px = this.pos.x, pz = this.pos.z;
    this.hollows.forEach((h) => blips.push({ x: h.pos.x - px, z: h.pos.z - pz, kind: 'enemy', size: 2.4 }));
    this.raiders.forEach((r) => blips.push({ x: r.pos.x - px, z: r.pos.z - pz, kind: 'enemy', size: 3.4 }));
    this.tornadoes.forEach((t) => blips.push({ x: t.pos.x - px, z: t.pos.z - pz, kind: 'tornado' }));
    this.world.pitStops.forEach((s) => blips.push({ x: s.x - px, z: s.z - pz, kind: 'pit' }));
    this.net.peers.forEach((p) => {
      if (typeof p.x !== 'number' || typeof p.z !== 'number') return;
      blips.push({ x: p.x - px, z: p.z - pz, kind: 'peer', color: '#' + (p.color || 0x5ff0ff).toString(16).padStart(6, '0') });
    });
    return blips;
  }

  partyRows() {
    const rows = [{ name: `${this.profile.name} (YOU)`, color: `#${this.profile.color.toString(16).padStart(6, '0')}`, status: this.inCar ? 'DRIVING' : 'ON FOOT' }];
    this.net.peers.forEach((p) => rows.push({
      name: p.name,
      color: `#${(p.color || 0x8fd0ff).toString(16).padStart(6, '0')}`,
      status: p.inCar ? 'DRIVING' : 'ON FOOT',
    }));
    return rows.slice(0, 6);
  }

  // ------------------------------------------------------------------ damage
  hurt(amount, reason = '') {
    if (this.dead || this.won) return;
    if (this.invuln > 0 && amount < 8) return;
    this.hp -= amount;
    if (amount >= 3) {
      this.invuln = INVULN;
      this.flash.style.background = '#ff2f45';
      this.flash.style.opacity = '0.3';
      setTimeout(() => (this.flash.style.opacity = '0'), 70);
      this.shakeAmt = Math.max(this.shakeAmt, Math.min(0.6, amount * 0.035));
      if (reason) this.hud.toast(reason, 'bad');
    }
    if (this.hp <= 0) this.die();
  }

  onCarScrape(dmg) {
    this.hurt(dmg * 0.12);
    this.audio.crash();
    this.shakeAmt = Math.max(this.shakeAmt, 0.35);
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.hp = 0;
    this.paused = true;
    this.audio.crash();
    this.hud.storm(null);
    this.hud.showGameOver('WRECKED', 'The highway claimed another survivor.', [
      { k: 'DAYS SURVIVED', v: this.day },
      { k: 'DISTANCE', v: `${(this.distance / 1000).toFixed(1)} KM` },
      { k: 'SCAVENGERS DOWN', v: this.kills },
      { k: 'ZONE REACHED', v: ZONES[this.zone].short },
    ]);
    this.net.event('boom', { x: this.pos.x, z: this.pos.z });
  }

  win() {
    if (this.won || this.dead) return;
    this.won = true;
    this.paused = true;
    this.hud.storm(null);
    this.hud.showGameOver('YOU LIVED', '100 days. One rig. The coast is yours.', [
      { k: 'DAYS SURVIVED', v: 100 },
      { k: 'DISTANCE', v: `${(this.distance / 1000).toFixed(1)} KM` },
      { k: 'SCAVENGERS DOWN', v: this.kills },
      { k: 'STATUS', v: 'ESCAPED' },
    ]);
    this.net.event('win', { x: this.pos.x, z: this.pos.z });
  }

  // ------------------------------------------------------------ multiplayer
  onPeer(p) {
    let v = this.peerVisuals?.get(p.id);
    if (!v) {
      if (!this.peerVisuals) this.peerVisuals = new Map();
      const avatar = buildAvatar({ color: p.color || 0xffb347, name: p.name || 'SURVIVOR' });
      const car = new Vehicle({ color: p.carColor || 0xd24a2b, lights: false });
      car.group.visible = false;
      avatar.root.visible = true;
      this.scene.add(avatar.root, car.group);
      v = { avatar, car, group: new THREE.Group(), target: new THREE.Vector3(), yaw: 0, inCar: false, hp: 100, name: p.name };
      this.peerVisuals.set(p.id, v);
    }
    v.name = p.name;
    if (typeof p.x !== 'number' || typeof p.z !== 'number') return;
    v.hp = p.hp ?? 100;
    v.inCar = !!p.inCar;
    v.target.set(p.x, p.y || 0, p.z);
    v.yaw = p.yaw || 0;
    if (v.hidden) { v.avatar.root.visible = true; v.hidden = false; }
  }

  onPeerLeave(p) {
    const v = this.peerVisuals?.get(p.id);
    if (!v) return;
    this.scene.remove(v.avatar.root, v.car.group);
    this.peerVisuals.delete(p.id);
  }

  updatePeers(dt) {
    if (!this.peerVisuals) return;
    for (const v of this.peerVisuals.values()) {
      const root = v.inCar ? v.car.group : v.avatar.root;
      if (v.inCar) {
        v.car.group.visible = true;
        v.avatar.root.visible = false;
        v.car.pos.lerp(v.target, 1 - Math.exp(-9 * dt));
        v.car.yaw = angleLerp(v.car.yaw, v.yaw, 1 - Math.exp(-9 * dt));
        v.car.group.rotation.y = v.car.yaw;
        v.car.mesh.wheels.forEach((w) => (w.tyre.rotation.x += dt * 6));
      } else {
        v.car.group.visible = false;
        v.avatar.root.visible = true;
        v.avatar.root.position.lerp(v.target, 1 - Math.exp(-9 * dt));
        v.avatar.root.rotation.y = angleLerp(v.avatar.root.rotation.y, v.yaw, 1 - Math.exp(-9 * dt));
        const moving = v.avatar.root.position.distanceTo(v.target) > 0.06 ? 1 : 0;
        v.avatar.animate(dt, moving, false);
      }
      if (v.avatar.tag) v.avatar.tag.visible = !v.inCar;
      void root;
    }
  }

  onChat(c, own) {
    if (own) this.hud.chat('YOU', c.text, '#ffd9a0');
    else if (c.sys) this.hud.chat('', c.text, '#93a0b3', true);
    else this.hud.chat(c.name, c.text, '#' + (c.color || 0xffb347).toString(16).padStart(6, '0'));
  }

  onNetEvent(e) {
    if (e.kind === 'boom') {
      this.effects.explosion(new THREE.Vector3(e.x, 1.2, e.z), 1.1);
      const d = Math.hypot(e.x - this.pos.x, e.z - this.pos.z);
      if (d < 60) this.audio.crash();
    } else if (e.kind === 'kill') {
      this.effects.blood(new THREE.Vector3(e.x, 1.2, e.z), new THREE.Vector3(0, 1, 0));
    }
  }

  onNetStatus(mode, text) {
    const el = document.getElementById('netStatus');
    if (!el) return;
    el.textContent = `${mode === 'online' ? '● RELAY ONLINE' : mode === 'poll' ? '● HTTP RELAY' : '● CONNECTING'} — ${text}`;
    el.className = `net-status ${mode === 'online' ? 'ok' : 'warn'}`;
    this.netStatus = { mode, text };
  }

  onPeerCount(n) {
    const el = document.getElementById('onlineCount');
    if (el) el.textContent = `${n + 1} SURVIVOR${n ? 'S' : ''} ONLINE`;
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  dispose() {
    this.net?.close();
    this.renderer.dispose();
    this.mount.innerHTML = '';
  }
}
