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
import { RECIPES, ALL_RECIPES, findRecipe } from './recipes.js';
import { LootField } from './loot.js';
import { Inventory, InventoryUI } from './inventory.js';
import { rollLoot, isMaterial, ITEMS, itemName } from './items.js';

export { RECIPES };

const PERK_CAPS = { maxhp: 100, maxfuel: 60, armor: 0.35, dmg: 1.0, scav: 1.0, magnet: 4 };
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

export const WEATHERS = {
  clear: { label: 'CLEAR', danger: false },
  dust: { label: 'DUST STORM', danger: true },
  heat: { label: 'HEATWAVE 41°C', danger: true },
  rain: { label: 'DRIVING RAIN', danger: false },
  acid: { label: 'ACID RAIN', danger: true },
  storm: { label: 'EMP THUNDERSTORM', danger: true },
  gale: { label: 'GALE WINDS', danger: true },
};

export class Game {
  constructor({ mount, profile, room, onQuit, onRunEnd }) {
    this.mount = mount;
    this.profile = profile;
    this.onQuit = onQuit;
    this.onRunEnd = onRunEnd;
    this.hud = new HUD();
    this.audio = new AudioKit();
    this.paused = false;
    this.started = false;
    this.dead = false;
    this.won = false;
    this.kills = 0;
    this.itemsLooted = 0;
    this.craftedCount = 0;
    this.shakeAmt = 0;
    this.time = 0;
    this.hudTimer = 0;
    this.dragLook = 0;
    this.touchMode = ('ontouchstart' in window) || navigator.maxTouchPoints > 1;

    this.setupGraphics();
    this.world = new World(this.scene, 1337);
    if (this.quality !== 'high') {
      this.world.sun.castShadow = this.quality === 'medium';
      this.world.sun.shadow.mapSize.set(512, 512);
    }
    this.effects = new Effects(this.scene, { scale: this.quality === 'low' ? 0.45 : this.quality === 'medium' ? 0.7 : 1 });
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

    this.loot = new LootField(this.scene);
    this.inventory = new Inventory();
    this.invUI = new InventoryUI(this.inventory, {
      onUse: (id) => this.useItem(id),
      onToss: (id) => this.tossItem(id, -1),
      getMaterials: () => this.materials,
    });
    this.pickupBatch = new Map();
    this.pickupTimer = 0;

    this.resetRun();
    this.net.start();
    window.addEventListener('resize', () => this.resize());
    this.clock = new THREE.Clock();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ setup
  setupGraphics() {
    const coarse = window.matchMedia?.('(pointer: coarse)')?.matches;
    const smallest = Math.min(window.innerWidth, window.innerHeight);
    const cores = navigator.hardwareConcurrency || 4;
    const lowEnd = Boolean(coarse && (smallest < 640 || cores <= 4));
    this.quality = lowEnd ? 'low' : coarse ? 'medium' : 'high';
    this.pixelCap = lowEnd ? 1 : coarse ? 1.4 : 1.85;

    this.renderer = new THREE.WebGLRenderer({ antialias: !lowEnd, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = !lowEnd;
    this.renderer.shadowMap.type = this.quality === 'high' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
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
    this.itemsLooted = 0;
    this.craftedCount = 0;
    this.dead = false;
    this.won = false;
    this.paused = false;
    this.inCar = true;
    this.dayTimer = 0;
    this.insideBuilding = null;
    this.world?.focusInterior?.(null);
    this.perks = { maxhp: 0, maxfuel: 0, armor: 0, dmg: 0, scav: 0, magnet: 0 };
    this.hpMax = 100;
    this.inventory?.items.clear();
    if (this.inventory) {
      this.inventory.hotbar = new Array(8).fill(null);
      this.inventory.emit();
    }
    this.loot?.clear();
    this.pickupBatch?.clear();
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
      if (e.code === 'KeyI') { e.preventDefault(); this.toggleInventory(); }
      if (/^Digit[1-8]$/.test(e.code)) {
        e.preventDefault();
        const slot = Number(e.code.slice(5)) - 1;
        this.invUI?.useSlot(slot);
      }
      if (e.code === 'Escape') {
        // Escape is the universal "put that away" key: bench, pack, or both.
        const hadBench = !!this.hud.benchOpen;
        const hadPack = !!this.invUI?.open;
        if (hadBench) this.hud.closeBench();
        if (hadPack) this.invUI.hide();
        if ((hadBench || hadPack) && !this.dead && !this.won) this.paused = false;
      }
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
    this.pointers = new Map();
    let pinchStart = 0, pinchBase = 0;

    const stickZone = (e) => this.touchMode && e.clientX < window.innerWidth * 0.46;

    canvas.addEventListener('pointerdown', (e) => {
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      if (stickZone(e)) {
        this.pointers.set(e.pointerId, { mode: 'stick' });
        this.startStick(e);
        return;
      }
      this.pointers.set(e.pointerId, {
        mode: 'look', x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false,
      });
      const look = [...this.pointers.values()].filter((p) => p.mode === 'look');
      if (look.length === 2) {
        pinchBase = Math.hypot(look[0].x - look[1].x, look[0].y - look[1].y);
        pinchStart = this.camDist;
      }
      this.dragLook = 1;
    });

    canvas.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (p.mode === 'stick') { this.moveStick(e); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (Math.abs(e.clientX - p.sx) + Math.abs(e.clientY - p.sy) > 5) p.moved = true;
      this.camYaw -= dx * (this.touchMode ? 0.0055 : 0.006);
      this.camPitch = clamp(this.camPitch + dy * 0.004, -0.15, 0.85);
      this.dragLook = 1;
      if (pinchBase > 0) {
        const look = [...this.pointers.values()].filter((q) => q.mode === 'look');
        if (look.length === 2) {
          const d = Math.hypot(look[0].x - look[1].x, look[0].y - look[1].y);
          this.camDist = clamp(pinchStart * (pinchBase / Math.max(24, d)), 5.5, 26);
        }
      }
    });

    const endPointer = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (p?.mode === 'stick') this.endStick();
      if (p && p.mode === 'look' && !p.moved && e.type === 'pointerup') this.attack();
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) pinchBase = 0;
      this.dragLook = this.pointers.size ? 1 : 0;
      try { canvas.releasePointerCapture(e.pointerId); } catch {}
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
    use.type = 'button';
    use.className = 'act'; use.id = 'useBtn';
    use.innerHTML = '<span class="act-ico">🚪</span><span class="act-txt">ENTER / EXIT<em>TAP</em></span>';
    use.addEventListener('click', () => this.toggleCar());
    const atk = document.createElement('button');
    atk.type = 'button';
    atk.className = 'act'; atk.id = 'atkBtn';
    atk.innerHTML = '<span class="act-ico">🔪</span><span class="act-txt">ATTACK<em>TAP</em></span>';
    atk.addEventListener('click', () => this.attack());
    wrap.prepend(use, atk);
    this.buildStick();
  }

  buildStick() {
    if (this.stickEl) return;
    const stick = document.createElement('div');
    stick.id = 'stick';
    stick.innerHTML = '<div id="stickKnob"></div>';
    document.body.appendChild(stick);
    this.stickEl = stick;
    this.stickKnob = stick.firstChild;
    this.homeStick();
  }

  homeStick() {
    if (!this.stickEl) return;
    const s = this.stickEl;
    s.style.left = '18px';
    s.style.top = 'auto';
    s.style.bottom = 'calc(148px + env(safe-area-inset-bottom))';
    s.style.opacity = '0.34';
    this.stickKnob.style.left = '35px';
    this.stickKnob.style.top = '35px';
  }

  startStick(e) {
    this.stickActive = true;
    this.stickOrigin = { x: e.clientX, y: e.clientY };
    const s = this.stickEl;
    s.style.opacity = '0.95';
    s.style.left = `${e.clientX - 60}px`;
    s.style.top = `${e.clientY - 60}px`;
    s.style.bottom = 'auto';
    this.moveStick(e);
  }

  moveStick(e) {
    const dx = e.clientX - this.stickOrigin.x;
    const dy = e.clientY - this.stickOrigin.y;
    const mag = Math.min(1, Math.hypot(dx, dy) / 48);
    const ang = Math.atan2(dy, dx);
    this.touchAxes.x = Math.cos(ang) * mag;
    this.touchAxes.y = Math.sin(ang) * mag;
    const dead = 0.14;
    this.keys.forward = mag > dead ? clamp(-this.touchAxes.y, 0, 1) : 0;
    this.keys.back = mag > dead ? clamp(this.touchAxes.y, 0, 1) : 0;
    this.keys.left = mag > dead ? clamp(-this.touchAxes.x, 0, 1) : 0;
    this.keys.right = mag > dead ? clamp(this.touchAxes.x, 0, 1) : 0;
    this.keys.boost = mag > 0.92;
    const k = this.stickKnob;
    if (k) {
      k.style.left = `${35 + Math.cos(ang) * mag * 34}px`;
      k.style.top = `${35 + Math.sin(ang) * mag * 34}px`;
    }
  }

  endStick() {
    this.stickActive = false;
    this.keys.forward = this.keys.back = this.keys.left = this.keys.right = 0;
    this.keys.boost = false;
    this.homeStick();
  }

  bindHud() {
    document.getElementById('anchorBtn').addEventListener('click', () => this.toggleAnchor());
    document.getElementById('benchBtn').addEventListener('click', () => this.toggleBench());
    document.getElementById('scavBtn').addEventListener('click', () => this.scavenge());
    document.getElementById('benchClose').addEventListener('click', () => this.toggleBench(false));
    document.getElementById('respawnBtn').addEventListener('click', () => { this.resetRun(); this.paused = false; });
    document.getElementById('invBtn')?.addEventListener('click', () => this.toggleInventory());
    document.getElementById('lobbyBtn').addEventListener('click', () => this.onQuit?.());
    const menuBtn = document.getElementById('mobileMenuBtn');
    if (menuBtn) {
      menuBtn.addEventListener('click', () => {
        if (!this.quitArmedAt || this.time - this.quitArmedAt > 3) {
          this.quitArmedAt = this.time;
          this.hud.prompt('TAP ☰ AGAIN TO LEAVE THE RUN');
          setTimeout(() => this.hud.prompt(''), 3000);
          return;
        }
        this.hud.prompt('');
        this.net?.close?.();
        this.onQuit?.();
      });
    }
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
    this.updateLoot(dt);
    this.updateInteraction();
    this.updatePeers(dt);
    this.world.update(dt, this.pos, this.zone);
    this.updateDoors();
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
      const build = this.insideBuilding || this.world.nearestBuilding(this.pos.x, this.pos.z, 14);
      if (build) this.hud.setScavengeReady(Boolean(build.scavengeReady), build.label);
      else this.hud.setScavengeReady(!!stop && stop.scavengeReady, stop ? stop.kind.toUpperCase() : '');
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

    const nx = clamp(pos.x + move.x * speed * dt, -220, 220);
    const nz = pos.z + move.z * speed * dt;
    // slide along walls: resolve each axis separately so doorways stay enterable
    if (!this.world.collideFoot(nx, pos.z, 0.5)) pos.x = nx;
    if (!this.world.collideFoot(pos.x, nz, 0.5)) pos.z = nz;
    this.trackInterior();

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

  /** Detects entering/leaving a building interior and swaps the roof state. */
  trackInterior() {
    const pos = this.avatar.root.position;
    const b = this.inCar ? null : this.world.buildingAt(pos.x, pos.z);
    if (b === this.insideBuilding) return;
    const previous = this.insideBuilding;
    this.insideBuilding = b || null;
    this.world.focusInterior(this.insideBuilding);
    if (this.insideBuilding) {
      this.hud.toast(`INSIDE ${this.insideBuilding.label} · [G] SEARCH`, 'good');
      this.audio?.step?.();
    } else if (previous) {
      this.hud.toast(`LEFT ${previous.label}`, 'warn');
    }
  }

  /** One soft creak when a door you are standing at swings open or shut. */
  updateDoors() {
    const pos = this.inCar ? this.car.pos : this.avatar.root.position;
    for (const b of this.world?.buildings || []) {
      const near = Math.hypot(pos.x - b.door.x, pos.z - b.door.z) < 6;
      const open = b.doorAngle > 0.35;
      if (!near) { b._doorOpen = false; continue; }
      if (open !== Boolean(b._doorOpen)) {
        b._doorOpen = open;
        if (this.time - (this._creakAt || 0) > 0.45) {
          this._creakAt = this.time;
          this.audio?.creak?.();
        }
      }
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
    // tighter, higher camera indoors so walls never swallow the view
    if (!this.inCar) {
      const want = this.insideBuilding ? 7.4 : 9.6;
      this.camDist = damp(this.camDist, want, 4, dt);
      if (this.insideBuilding) this.camPitch = damp(this.camPitch, 0.52, 3, dt);
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
      this.trackInterior();
      this.audio.blip(300, 0.1, 'square', 0.1);
    } else {
      if (dist2(this.avatar.root.position, this.car.pos) > 6.5) { this.hud.toast('TOO FAR FROM THE RIG', 'warn'); return; }
      if (this.car.dead) { this.hud.toast('THE RIG IS WRECKED — REPAIR IT FIRST', 'bad'); return; }
      this.inCar = true;
      this.car.occupied = true;
      this.avatar.root.visible = false;
      this.trackInterior();
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
        best.hit(w.dmg * (1 + (this.perks?.dmg || 0)), origin);
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
      let dmg = w.dmg * (1 + (this.perks?.dmg || 0));
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
    const build = this.insideBuilding || this.world.nearestBuilding(this.pos.x, this.pos.z, 10);
    if (build) {
      // from the road you can only ransack what you can actually reach
      if (this.insideBuilding !== build) {
        const door = build.door || build;
        const reach = dist2(this.pos, door);
        if (reach > 8) {
          this.hud.toast(`${build.label} IS OUT OF REACH — WALK UP TO THE DOOR`, 'warn');
          return;
        }
      }
      this.searchBuilding(build);
      return;
    }
    const stop = this.world.nearestPitStop(this.pos.x, this.pos.z, 20);
    if (!stop) { this.hud.toast('NOTHING TO SCAVENGE — FIND A PIT-STOP', 'warn'); return; }
    if (!stop.scavengeReady || stop.cooldown > 0) { this.hud.toast('THIS STOP IS PICKED CLEAN', 'warn'); return; }

    const stacks = rollLoot(Math.random, {
      zone: this.zone,
      kind: stop.kind,
      lootMult: 1 + (this.perks?.scav || 0),
      rolls: 3,
    });
    this.scatterLoot(stop.x, stop.z, stacks, { spread: 4.2 });
    stop.scavengeReady = false;
    stop.cooldown = 12;
    stop.crates.visible = false;
    this.hud.toast(`CRATES BUSTED OPEN — GRAB THE ${stacks.length} DROPS`, 'warn');
    this.audio.pickup();
    this.effects.emit(new THREE.Vector3(stop.x, 1.2, stop.z), 16, { color: 0x9dffb8, spread: 2.4, up: 3.4, life: 0.8, gravity: 6 });
  }

  /**
   * Turns a rolled haul into physical drops around a loot spot. Nothing is
   * collected until the player walks (or drives) over it.
   */
  scatterLoot(x, z, stacks, { spread = 2.8 } = {}) {
    if (!stacks?.length) return 0;
    this.loot.spawn(x, z, stacks, { spread });
    return stacks.length;
  }

  /**
   * Puts a stack back on the ground in front of the survivor so co-op partners
   * can take it. Drops get a short grace window, otherwise you would scoop it
   * back up on the next frame.
   */
  tossItem(id, qty = -1) {
    if (this.dead || this.won || !id) return 0;
    if (isMaterial(id)) return 0;
    const have = this.inventory.count(id);
    if (!have) { this.hud.toast('YOU ARE NOT CARRYING THAT', 'warn'); return 0; }
    const n = qty < 0 ? have : Math.min(qty, have);
    this.inventory.remove(id, n);
    const pos = this.inCar ? this.car.pos : this.avatar.root.position;
    const yaw = this.inCar ? this.car.yaw : this.avatar.root.rotation.y;
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).multiplyScalar(-1.5);
    this.loot.spawn(pos.x + forward.x, pos.z + forward.z, [{ id, qty: n }], { spread: 0.5, grace: 1.6 });
    this.audio?.blip?.(300, 0.09, 'triangle', 0.07);
    this.hud.toast(`TOSSED ${n} ${itemName(id)} — WALK OVER IT TO GRAB IT BACK`, 'warn');
    return n;
  }

  /** Batches pickups so a handful of drops in one second reads as one toast. */
  notePickup(id, qty) {
    this.pickupBatch.set(id, (this.pickupBatch.get(id) || 0) + qty);
  }

  flushPickups(dt) {
    if (!this.pickupBatch.size) return;
    this.pickupTimer -= dt;
    if (this.pickupTimer > 0) return;
    this.pickupTimer = 0.55;
    const parts = [...this.pickupBatch].map(([id, qty]) => `${qty} ${itemName(id)}`);
    this.pickupBatch.clear();
    const total = parts.length;
    const text = parts.slice(0, 4).join(' · ') + (total > 4 ? ` +${total - 4} MORE` : '');
    this.hud.toast(`PICKED UP: ${text}`, 'good');
    this.audio?.pickup?.();
  }

  /** Collects drops the player is standing on. */
  updateLoot(dt) {
    const pos = this.inCar ? this.car.pos : this.avatar.root.position;
    const magnet = (this.inCar ? 3.4 : 2.4) + (this.perks?.magnet || 0);
    const radius = (this.inCar ? 2.5 : 1.15) + (this.perks?.magnet || 0) * 0.5;
    const got = this.loot.update(dt, pos, { radius, magnet });
    if (got.length) {
      for (const stack of got) {
        if (isMaterial(stack.id)) {
          this.materials[stack.id] = (this.materials[stack.id] || 0) + stack.qty;
        } else if (stack.id === 'fuel_siphon') {
          this.car.fuel = clamp(this.car.fuel + stack.qty, 0, this.car.maxFuel);
        } else {
          const stored = this.inventory.add(stack.id, stack.qty);
          if (stored < stack.qty) {
            this.hud.toast('PACK FULL — ITEM LEFT BEHIND', 'warn');
            this.loot.spawn(pos.x, pos.z, [{ id: stack.id, qty: stack.qty - stored }], { spread: 0.6 });
          }
        }
        this.itemsLooted += 1;
        this.notePickup(stack.id, stack.qty);
      }
      this.hud.inv = this.materials;
      if (this.hud.benchOpen) this.hud.refreshBench?.();
    }
    this.flushPickups(dt);
  }

  /** Interior looting: richer the deeper you go, boosted by the building type. */
  searchBuilding(b) {
    if (!b.scavengeReady || b.cooldown > 0) {
      this.hud.toast(`${b.label} IS PICKED CLEAN — TRY ANOTHER HOUSE`, 'warn');
      return;
    }
    const indoors = this.insideBuilding === b;
    const stacks = rollLoot(Math.random, {
      zone: this.zone,
      kind: b.kind,
      lootMult: b.lootMult * (indoors ? 1.2 : 0.7) * (1 + (this.perks?.scav || 0)),
      inside: indoors,
      rolls: 3,
    });
    // Rummaging from the doorstep spills everything onto the porch: loot you
    // cannot walk to is the same as no loot, so the drops stay reachable.
    const spots = indoors
      ? (b.lootSpots?.length ? b.lootSpots : [{ x: b.x, z: b.z }])
      : [{ x: b.door?.x ?? b.x, z: b.door?.z ?? b.z }];
    spots.forEach((spot, i) => {
      const chunk = stacks.filter((_, idx) => idx % spots.length === i);
      this.scatterLoot(spot.x, spot.z, chunk, { spread: indoors ? 2.4 : 1.8 });
    });
    b.scavengeReady = false;
    b.cooldown = 32;
    this.hud.toast(`${b.label} TURNED OVER — ${stacks.length} DROPS ${indoors ? 'ON THE FLOOR' : 'ON THE PORCH'}`, 'warn');
    this.audio.pickup();
    this.effects.emit(new THREE.Vector3(b.x, b.height * 0.5, b.z), 14, { color: 0xffd98a, spread: 3.2, up: 2.6, life: 0.9, gravity: 7 });
    this.net.event('loot', { x: b.x, z: b.z });
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
  /** Every recipe, with its live "can't craft this any more" state. */
  benchRecipes() {
    return ALL_RECIPES.map((r) => {
      let maxed = false;
      if (r.upgrade === 'armor' && this.car.armorLevel >= 3) maxed = true;
      if (r.upgrade === 'anchors' && this.car.anchorTier >= 4) maxed = true;
      if (r.upgrade === 'bench' && this.benchTier >= (r.tier || 2)) maxed = true;
      if (r.effect?.type === 'perk') {
        const got = this.perks?.[r.effect.perk] || 0;
        const cap = PERK_CAPS[r.effect.perk] ?? 20;
        maxed = got >= cap - 1e-9;
      }
      return { ...r, maxed };
    });
  }

  toggleBench(force) {
    const open = force === undefined ? !this.hud.benchOpen : force;
    if (open) {
      if (this.dead || this.won) return;
      this.invUI?.hide();
      this.paused = true;
      this.hud.ownedWeapons = [...this.owned];
      this.hud.openBench(this.benchTier, this.materials, this.benchRecipes());
      this.audio.blip(560, 0.1, 'triangle', 0.08);
    } else {
      this.paused = false;
      this.hud.closeBench();
    }
  }

  craft(id) {
    const r = findRecipe(id);
    if (!r) return;
    if ((r.tierReq || 1) > this.benchTier) { this.hud.toast(`NEED WORKBENCH TIER ${r.tierReq}`, 'bad'); return; }
    if (r.weapon && this.owned.has(r.weapon)) return;
    for (const [k, v] of Object.entries(r.cost)) {
      if ((this.materials[k] || 0) < v) { this.hud.toast(`NOT ENOUGH ${k.toUpperCase()}`, 'bad'); return; }
    }
    if (r.upgrade === 'armor' && this.car.armorLevel >= 3) return;
    if (r.upgrade === 'anchors' && this.car.anchorTier >= 4) return;
    if (r.upgrade === 'bench' && this.benchTier >= (r.tier || 2)) return;
    if (r.effect?.type === 'perk') {
      const p = r.effect.perk;
      const cap = PERK_CAPS[p] ?? 20;
      if ((this.perks[p] || 0) >= cap - 1e-9) { this.hud.toast('THAT UPGRADE IS MAXED OUT', 'warn'); return; }
    }

    for (const [k, v] of Object.entries(r.cost)) this.materials[k] -= v;
    this.craftedCount += 1;

    if (r.weapon) {
      this.owned.add(r.weapon);
      this.durability[r.weapon] = WEAPON_DATA[r.weapon].dur;
      this.weapon = r.weapon;
      this.syncWeapon();
      this.hud.toast(`${r.name} CRAFTED & EQUIPPED`, 'good');
    } else if (r.upgrade === 'armor') {
      this.car.upgradeArmor();
      this.hud.toast(`ARMOR PLATING LV${this.car.armorLevel}`, 'good');
    } else if (r.upgrade === 'anchors') {
      this.car.upgradeAnchor();
      this.hud.toast(`ANCHOR TIER ${this.car.anchorTier}`, 'good');
    } else if (r.upgrade === 'bench') {
      this.benchTier = Math.max(this.benchTier, r.tier);
      if (this.hud.benchTier) this.hud.benchTier.textContent = `TIER ${this.benchTier}`;
      this.hud.toast(`WORKBENCH UPGRADED TO TIER ${this.benchTier}`, 'good');
    } else if (r.effect) {
      this.applyRecipeEffect(r);
    }

    this.audio.craft();
    this.hud.ownedWeapons = [...this.owned];
    this.hud.tier = this.benchTier;
    this.hud.inv = this.materials;
    this.hud.recipes = this.benchRecipes();
    this.hud.refreshBench();
  }

  /** Resolves a generated recipe's effect. */
  applyRecipeEffect(r) {
    const e = r.effect;
    if (e.type === 'fuel') {
      this.car.fuel = clamp(this.car.fuel + e.amount, 0, this.car.maxFuel);
      this.hud.toast(`+${e.amount} L FUEL`, 'good');
    } else if (e.type === 'repair') {
      if (e.chassis) this.car.chassis = clamp(this.car.chassis + e.chassis, 0, 100);
      if (e.engine) this.car.engine = clamp(this.car.engine + e.engine, 0, 100);
      if (e.tires) this.car.tires = clamp(this.car.tires + e.tires, 0, 100);
      this.car.dead = false;
      this.hud.toast('RIG REPAIRED ON THE BENCH', 'good');
    } else if (e.type === 'tires') {
      this.car.tires = clamp(this.car.tires + e.amount, 0, 100);
      this.hud.toast(`+${e.amount} TIRE TREAD`, 'good');
    } else if (e.type === 'give') {
      const stored = this.inventory.add(e.item, e.qty);
      this.hud.toast(stored ? `CRAFTED ${e.qty}× ${itemName(e.item)}` : 'PACK FULL — CRAFT SOMETHING ELSE', stored ? 'good' : 'bad');
    } else if (e.type === 'perk') {
      const p = e.perk;
      const cap = PERK_CAPS[p] ?? 20;
      this.perks[p] = Math.min(cap, (this.perks[p] || 0) + e.amount);
      if (p === 'maxhp') this.hpMax = 100 + this.perks.maxhp;
      if (p === 'maxfuel') {
        this.car.maxFuel = Math.round(60 + this.perks.maxfuel);
        this.car.fuel = Math.min(this.car.fuel, this.car.maxFuel);
      }
      this.hud.toast(`${r.perkLabel || 'UPGRADE'} INSTALLED`, 'good');
    }
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
      const px = h.group ? h.group.position.x : h.pos.x;
      const pz = h.group ? h.group.position.z : h.pos.z;
      h.update(dt, target, hooks);
      // solid walls: shove scavengers back out instead of letting them phase through
      const hx = h.group ? h.group.position.x : h.pos.x;
      const hz = h.group ? h.group.position.z : h.pos.z;
      if (this.world.collideFoot(hx, hz, 0.45)) {
        if (h.group) h.group.position.set(px, h.group.position.y, pz);
        else { h.pos.x = px; h.pos.z = pz; }
      }
      if (Math.hypot(h.pos.x - this.pos.x, h.pos.z - this.pos.z) > 420) { h.die(); this.hollows.splice(i, 1); }
    }
    for (const r of this.raiders) r.update(dt, target, raiderHooks);
  }

  // -------------------------------------------------------------- inventory
  toggleInventory(force) {
    if (this.dead || this.won) return;
    const open = force === undefined ? !this.invUI.open : force;
    if (open) {
      this.paused = true;
      this.hud.closeBench();
      this.invUI.show();
    } else {
      this.paused = false;
      this.invUI.hide();
    }
  }

  /** Applies a consumable. Returns true when it should be removed from the pack. */
  useItem(id) {
    const def = ITEMS[id];
    if (!def?.use || this.dead) return false;
    const use = def.use;
    let applied = false;
    if (use.heal) {
      this.hp = clamp(this.hp + use.heal, 0, this.hpMax || 100);
      applied = true;
    }
    if (use.fuel) {
      if (this.car.fuel >= this.car.maxFuel - 0.1) { this.hud.toast('TANK IS ALREADY FULL', 'warn'); return false; }
      this.car.fuel = clamp(this.car.fuel + use.fuel, 0, this.car.maxFuel);
      applied = true;
    }
    if (use.chassis) { this.car.chassis = clamp(this.car.chassis + use.chassis, 0, 100); this.car.dead = false; applied = true; }
    if (use.engine) { this.car.engine = clamp(this.car.engine + use.engine, 0, 100); applied = true; }
    if (use.tires) { this.car.tires = clamp(this.car.tires + use.tires, 0, 100); applied = true; }
    if (use.light) {
      const at = (this.inCar ? this.car.pos : this.avatar.root.position).clone();
      at.y = 0.4;
      this.effects.emit(at, 22, { color: 0xff7b3c, spread: 0.7, up: 2.2, life: 1.1, gravity: 3 });
      this.flare = { at, ttl: 20 };
      applied = true;
    }
    if (use.stamina) { this.car.fuel = clamp(this.car.fuel + 2, 0, this.car.maxFuel); applied = true; }
    if (applied) {
      this.audio?.pickup?.();
      this.hud.toast(`${def.name} USED`, 'good');
    }
    return applied;
  }

  // ------------------------------------------------------------------ admin
  /** Moves the rig (or the avatar on foot) to a world position. Owner panel only. */
  teleport(x, z, { keepHeading = true } = {}) {
    const tx = clamp(Number(x) || 0, -220, 220);
    const tz = Number(z) || 0;
    this.car.pos.x = tx;
    this.car.pos.z = tz;
    this.car.speed = 0;
    this.car.lateral = 0;
    if (!keepHeading) this.car.yaw = 0;
    this.avatar.root.position.set(tx, 0, tz);
    this.pos.set(tx, 0, tz);
    this.camPos.set(tx + 8, 8, tz + 14);
    this.hud.toast(`TELEPORTED TO ${tx.toFixed(0)} / ${tz.toFixed(0)}`, 'good');
    return true;
  }

  healAll() {
    this.hp = 100;
    this.car.engine = 100;
    this.car.chassis = 100;
    this.car.tires = 100;
    this.car.dead = false;
    this.car.fuel = this.car.maxFuel;
    this.hud.toast('RIG + SURVIVOR RESTORED', 'good');
  }

  spawnHollow(count = 1, radius = 22) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = rand(0, Math.PI * 2);
      const h = new Hollow(this.scene, this.pos.x + Math.cos(a) * radius, this.pos.z + Math.sin(a) * radius, this.day);
      this.hollows.push(h);
      out.push(h);
    }
    this.hud.toast(`${count} HOLLOW${count > 1 ? 'S' : ''} SUMMONED`, 'warn');
    return out;
  }

  spawnRaider(boss = false) {
    const a = rand(0, Math.PI * 2);
    const r = new RaiderCar(this.scene, this.pos.x + Math.cos(a) * 70, this.pos.z + Math.sin(a) * 70, this.day + (boss ? 10 : 0), boss);
    this.raiders.push(r);
    this.hud.toast(boss ? 'BOSS RIG DEPLOYED' : 'RAIDER RIG DEPLOYED', 'bad');
    return r;
  }

  clearHostiles() {
    [...this.hollows].forEach((h) => { h.die?.(); });
    [...this.raiders].forEach((r) => { r.die?.(); });
    this.hollows.length = 0;
    this.raiders.length = 0;
    this.hud.toast('AREA CLEARED', 'good');
  }

  clearStorms() {
    [...this.tornadoes].forEach((t) => { t.die?.(); this.scene.remove?.(t.group); });
    this.tornadoes.length = 0;
    this.stormCat = 0;
    this.hud.storm(null);
    this.hud.toast('STORMS DISSIPATED', 'good');
  }

  updateInteraction() {
    if (this.paused || this.dead) return;
    // phones have no keyboard: drop the key hints there instead of showing [G]/[E]
    const key = (k) => (this.touchMode ? '' : `[${k}] `);
    if (this.inCar) {
      const drops = this.loot?.count || 0;
      const b = this.world.nearestBuilding(this.pos.x, this.pos.z, 26);
      if (drops) this.hud.prompt(`${drops} DROP${drops === 1 ? '' : 'S'} ON THE GROUND · DRIVE OVER THEM`);
      else this.hud.prompt(b ? `${b.label} AHEAD · STOP & SEARCH ON FOOT` : '');
      return;
    }

    const near = this.loot?.nearest(this.pos.x, this.pos.z, 2.2);
    if (near) { this.hud.prompt(`${itemName(near.item)} · ${near.qty} · WALK OVER IT`); return; }

    const d = dist2(this.avatar.root.position, this.car.pos);
    if (d < 6.5 && !this.insideBuilding) { this.hud.prompt(`${key('E')}ENTER THE RIG`); return; }

    if (this.insideBuilding) {
      const b = this.insideBuilding;
      this.hud.prompt(b.scavengeReady
        ? `${key('G')}SEARCH ${b.label}`
        : `${b.label} · PICKED CLEAN · WALK OUT`);
      return;
    }

    const build = this.world.nearestBuilding(this.pos.x, this.pos.z, 18);
    if (build) {
      this.hud.prompt(build.scavengeReady
        ? `${key('G')}SEARCH ${build.label}`
        : `${build.label} · PICKED CLEAN`);
      return;
    }
    const stop = this.world.nearestPitStop(this.pos.x, this.pos.z, 20);
    this.hud.prompt(stop ? `${key('G')}SCAVENGE ${stop.label}` : '');
  }

  radarBlips() {
    const blips = [];
    const px = this.pos.x, pz = this.pos.z;
    this.hollows.forEach((h) => blips.push({ x: h.pos.x - px, z: h.pos.z - pz, kind: 'enemy', size: 2.4 }));
    this.raiders.forEach((r) => blips.push({ x: r.pos.x - px, z: r.pos.z - pz, kind: 'enemy', size: 3.4 }));
    this.tornadoes.forEach((t) => blips.push({ x: t.pos.x - px, z: t.pos.z - pz, kind: 'tornado' }));
    this.world.pitStops.forEach((s) => blips.push({ x: s.x - px, z: s.z - pz, kind: 'pit' }));
    this.world.buildings.forEach((b) => blips.push({
      x: b.x - px, z: b.z - pz, kind: 'house', size: 3.2,
      inside: b === this.insideBuilding, ready: b.scavengeReady,
    }));
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
    if (this.godMode) return;
    if (this.perks?.armor) amount *= 1 - Math.min(0.55, this.perks.armor);
    if (this.invuln > 0 && amount < 8) return;
    this.hp -= amount;
    if (this.hp > this.hpMax) this.hp = this.hpMax;
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
    this.invUI?.hide();
    this.hud.closeBench();
    this.audio.crash();
    this.hud.storm(null);
    this.hud.showGameOver('WRECKED', 'The highway claimed another survivor.', [
      { k: 'DAYS SURVIVED', v: this.day },
      { k: 'DISTANCE', v: `${(this.distance / 1000).toFixed(1)} KM` },
      { k: 'SCAVENGERS DOWN', v: this.kills },
      { k: 'ITEMS LOOTED', v: this.itemsLooted },
      { k: 'ITEMS CRAFTED', v: this.craftedCount },
      { k: 'ZONE REACHED', v: ZONES[this.zone].short },
    ]);
    this.net.event('boom', { x: this.pos.x, z: this.pos.z });
    this.onRunEnd?.({
      day: this.day, distance: Math.round(this.distance), kills: this.kills,
      itemsLooted: this.itemsLooted, crafted: this.craftedCount, won: false,
    });
  }

  win() {
    if (this.won || this.dead) return;
    this.won = true;
    this.paused = true;
    this.invUI?.hide();
    this.hud.closeBench();
    this.hud.storm(null);
    this.hud.showGameOver('YOU LIVED', '100 days. One rig. The coast is yours.', [
      { k: 'DAYS SURVIVED', v: 100 },
      { k: 'DISTANCE', v: `${(this.distance / 1000).toFixed(1)} KM` },
      { k: 'SCAVENGERS DOWN', v: this.kills },
      { k: 'ITEMS LOOTED', v: this.itemsLooted },
      { k: 'ITEMS CRAFTED', v: this.craftedCount },
      { k: 'STATUS', v: 'ESCAPED' },
    ]);
    this.net.event('win', { x: this.pos.x, z: this.pos.z });
    this.onRunEnd?.({
      day: 100, distance: Math.round(this.distance), kills: this.kills,
      itemsLooted: this.itemsLooted, crafted: this.craftedCount, won: true,
    });
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
    } else if (e.kind === 'admin-kick' && e.target === this.net.id) {
      this.hud.toast('REMOVED BY THE OWNER', 'bad');
      this.audio.alarm();
      setTimeout(() => this.onQuit?.(), 1200);
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelCap || 1.85));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  dispose() {
    this.net?.close();
    this.renderer.dispose();
    this.mount.innerHTML = '';
  }
}
