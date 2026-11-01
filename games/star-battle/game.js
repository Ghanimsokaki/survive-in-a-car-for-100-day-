/* STAR BATTLE — an open sector, a wing of Enterprises, and the dark.
 *
 * You fly the Enterprise-E (`NCC-1701-E`) with two more Enterprises on your
 * wing against Nero's **Narada** and Khan's **Vengeance**, in a sector you can
 * actually fly around: a starbase, two worlds, a debris field and a derelict,
 * with objectives that send you between them.
 *
 * There are two renderers, and the game picks one at boot:
 *
 *   1. `gl.js` — WebGL, the real hull from `art/ship-mesh.js` (baked from
 *      `model.fbx` by `npm run bake`), a chase camera, a star shell, the sector
 *      grid and additive beam/spark billboards. This is what a phone sees.
 *   2. canvas-2D — the baked turntables from `art.js`, top-down. Used when a
 *      device has no WebGL, when the mesh has not landed yet, and by the test
 *      suite, which runs this file in a DOM with no GL at all.
 *
 * Both read the same simulation, so the fight is identical either way. The
 * vector art (`drawEnterprise`, `drawNarada`, `drawVengeance`) is the last-resort
 * fallback when the atlases have not decoded either.
 *
 * Everything else is in memory: the hub runs this in a sandboxed iframe with an
 * opaque origin, so localStorage throws. Best score and the run history go
 * through the arcade SDK; the local copies are a guarded nicety.
 */
(() => {
  'use strict';

  const R = window.StarShips;
  /** The baked turntables (`art.js`); null when the page has no ship atlas. */
  const ART = window.StarArt || null;
  /** The hub SDK; a stand-in if the page is opened directly (file://, devtools). */
  const sdk = (typeof window !== 'undefined' && window.Arcade) || {
    ready() {}, state() {}, score() {}, close() {}, fit(canvas, dpr = 1) {
      const w = canvas.clientWidth || 960;
      const h = canvas.clientHeight || 540;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      return { w, h, dpr };
    },
  };

  const canvas = document.getElementById('c');          // canvas-2D (fallback)
  const ctx = canvas.getContext('2d');
  /* A second canvas for the 3D view. It has to be its own element: a canvas
   * that has handed out one kind of context can never hand out another, so the
   * 2D fallback would be impossible on the same bitmap. */
  const glCanvas = document.getElementById('c3');
  const $ = (id) => document.getElementById(id);

  const TAU = Math.PI * 2;
  const clamp = R.clamp;
  /* The edge of the fight. Without it a fast ship can simply fly away from a
   * slow Narada forever and the run never ends — a stalemate is not a game. */
  const SECTOR = 2400;

  /* ------------------------------------------------------------------ state */
  let screen = 'title';        // title | battle | over
  let run = R.newRun();        // ships.js: ship pools, wave, kills, seconds
  let enemies = [];
  let shots = [];              // torpedoes, both sides
  let beams = [];              // phaser beams: draw for a moment, damage at once
  let sparks = [];
  let stars = [];
  let nebula = [];
  let waveTimer = 0;           // counts down to the next wave
  let sectorWarn = 0;          // so the boundary message is not spammed
  let paused = false;          // the player, the hub, or a hidden tab
  let bannerTimer = 0;
  let shake = 0;
  let cam = { x: 0, y: 0 };
  let best = 0;
  let now = 0;                 // seconds since boot, for animation
  let lastStatus = 0;
  let flashLevel = 0;          // white flash on a big kill / hit
  let hitMarker = 0;           // seconds left on the "you hit it" cross
  let damageLevel = 0;         // red vignette, follows the hull bar
  let quality = 'auto';        // the hub's hint: low | medium | high | auto
  let dprCap = 2;              // lowered by the watchdog when frames get slow
  let frames = 0, fps = 60, fpsTimer = 0, slowStreak = 0;
  const perf = { frames: 0, dropped: 0, dpr: 2, ui: 'high' };
  let board = null;            // Supabase leaderboard from the hub, when sent
  let squadron = [];           // the other players in your room, from the hub
  let interior = false;        // main engineering, on screen instead of the sector
  let crewShip = null;         // the ship the crew is flying, if they are
  let crashCount = 0;          // a broken frame must not be a broken game

  /* --------------------------------------------------------------- the 3D
   * `glReady` is the switch between the two renderers. It only ever turns on
   * once the hull has been uploaded, so a device that cannot do WebGL simply
   * never gets here and keeps the 2D path.
   */
  const GL = window.StarGL || null;
  let gl = null;               // the WebGL renderer (gl.js)
  let glReady = false;
  let meshAsked = false;
  let overlay = null;          // 2D canvas stacked over the 3D one
  let overlayCtx = null;
  const ALT = 26;              // the flight plane, a little above the grid

  /* ------------------------------------------------------------ the sector */
  let sites = [];              // landmarks: starbase, worlds, derelict, field
  let allies = [];             // the wing: two more Enterprises
  let quests = [];             // objectives, in order
  let history = [];            // this device's last runs
  const HISTORY_KEY = 'star-battle-history';
  const WARP_COOLDOWN = 13;    // the default; the warp core upgrade shortens it
  const warp = { cooldown: 0, active: 0, dx: 1, dy: 0, jumps: 0 };

  /* -------------------------------------------------------------- the hangar
   * Which hull you fly, what is bolted to it, and who is sitting at the
   * stations. It persists where storage is allowed, and for the session where
   * it is not (a sandboxed iframe has an opaque origin and storage throws).
   */
  const HANGAR_KEY = 'star-battle-hangar';
  let hangar = R.newHangar ? R.newHangar({ seed: 5 }) : { ship: 'enterprise', credits: 0, upgrades: {}, crew: [], auto: {} };
  const statsNow = () => (R.shipStats ? R.shipStats(hangar) : R.SHIPS[R.PLAYER_SHIP]);

  function loadHangar() {
    try {
      const raw = localStorage.getItem(HANGAR_KEY);
      if (raw) {
        const saved = JSON.parse(raw) || {};
        const fresh = R.newHangar ? R.newHangar({ seed: 5 }) : hangar;
        hangar = {
          ...fresh,
          ...saved,
          upgrades: { ...(saved.upgrades || {}) },
          crew: Array.isArray(saved.crew) ? saved.crew.slice(0, 8) : fresh.crew,
          auto: { ...fresh.auto, ...(saved.auto || {}) },
        };
      }
    } catch { /* opaque origin: the locker lives for the session */ }
    paintHangar();
  }

  function saveHangar() {
    try { localStorage.setItem(HANGAR_KEY, JSON.stringify(hangar)); } catch { /* session only */ }
    // rebuilding three lists on every kill would stutter the fight: only a
    // panel that is actually on screen needs repainting
    if (hangarOpen || interiorOpen) paintHangar();
    applyStatsToRun();
  }

  /**
   * Fold a purchase into the run that is already flying: pools grow by the
   * difference, so buying hull plating mid-fight gives you the plating.
   */
  function applyStatsToRun() {
    if (!run || !run.ship) return;
    const prev = run.stats || statsNow();
    const next = statsNow();
    run.stats = next;
    const ship = run.ship;
    const dHull = Math.max(0, next.hull - (prev.hull || 0));
    const dShield = Math.max(0, next.shields - (prev.shields || 0));
    const dTorp = Math.max(0, (next.torpedoes || 0) - (prev.torpedoes || 0));
    ship.hullMax = next.hull;
    ship.hull = clamp((ship.hull || 0) + dHull, 0, ship.hullMax);
    ship.shieldsMax = next.shields;
    ship.shields = clamp((ship.shields || 0) + dShield, 0, ship.shieldsMax);
    ship.torpedoes = Math.min(next.torpedoes, (ship.torpedoes || 0) + dTorp);
    paintHud(true);
  }

  /** Requisition, from a kill or a finished objective. */
  function pay(amount) {
    const gain = Math.max(0, Math.round(Number(amount) || 0));
    if (!gain) return 0;
    hangar.credits = (Number(hangar.credits) || 0) + gain;
    saveHangar();
    return gain;
  }

  /* ------------------------------------------------------------------ input */
  const input = {
    turn: 0, thrust: 0, fire: false, torpedo: false, evade: false, warp: false,
    keys: Object.create(null),
    stick: { active: false, id: -1, ox: 0, oy: 0, x: 0, y: 0 },
  };

  /* ------------------------------------------------------------- persistence
   * Sandboxed iframes have an opaque origin: touching localStorage is a
   * SecurityError, not a silent no-op. Best score is a nicety, so it is guarded
   * and simply forgotten where storage is not allowed.
   */
  function loadBest() {
    try { best = Math.max(0, Number(localStorage.getItem('star-battle-best')) || 0); } catch { best = 0; }
    paintBest();
  }
  function saveBest(score) {
    best = Math.max(best, Math.round(score || 0));
    try { localStorage.setItem('star-battle-best', String(best)); } catch { /* in-memory only */ }
    paintBest();
  }
  function paintBest(isNew = false) {
    const el = $('bestLine');
    if (el) {
      // keep the child span (the "NEW BEST" chip) when there is one
      const chip = el.querySelector ? el.querySelector('.new') : null;
      el.textContent = `BEST SCORE — ${best}`;
      if (chip && el.appendChild) el.appendChild(chip);
      el.classList.toggle('new-best', Boolean(isNew));
      if (!isNew) setTimeout(() => el.classList.remove('new-best'), 4000);
    }
  }

  /* ------------------------------------------------------------- the board
   * The hub asks Supabase for the top runs when a game is opened (cached, one
   * request per game per minute) and hands them over with `arcade:init`. The
   * game only paints them: no key, no second request, no CORS dance inside the
   * sandboxed frame.
   */
  function paintBoard(rows) {
    if (Array.isArray(rows)) board = rows;
    const list = $('boardList');
    if (!list) return;
    const rows2 = Array.isArray(board) ? board.slice(0, 5) : [];
    if (!rows2.length) {
      if (list.innerHTML !== undefined) list.innerHTML = '<li class="empty">NO RUNS LOGGED YET — BE THE FIRST</li>';
      return;
    }
    const name = String((sdk.player && sdk.player.name) || '').toUpperCase();
    const items = rows2.map((row, i) => {
      const who = String(row.name || row.meta || 'PILOT').toUpperCase().slice(0, 10);
      const mine = name && (row.name || '').toUpperCase() === name;
      const score = Math.round(Number(row.score) || 0);
      return `<li class="${mine ? 'you' : ''}"><span class="rank">${i + 1}</span>`
        + `<span>${who}</span><b>${score.toLocaleString ? score.toLocaleString('en-US') : score}</b></li>`;
    });
    if (list.innerHTML !== undefined) list.innerHTML = items.join('');
    const tag = $('boardTag');
    if (tag) tag.textContent = `TOP ${rows2.length}`;
  }

  /* ------------------------------------------------------------------ stars */
  function seedSpace() {
    const rand = R.rng(20261031);
    stars = [];
    for (let layer = 0; layer < 3; layer++) {
      const count = layer === 0 ? 90 : layer === 1 ? 46 : 22;
      for (let i = 0; i < count; i++) {
        stars.push({
          layer,
          x: rand() * 2400 - 1200,
          y: rand() * 2400 - 1200,
          size: layer === 0 ? 0.7 : layer === 1 ? 1.2 : 1.9,
          twinkle: rand() * TAU,
        });
      }
    }
    nebula = [];
    for (let i = 0; i < 7; i++) {
      nebula.push({
        x: rand() * 2600 - 1300,
        y: rand() * 2600 - 1300,
        r: 220 + rand() * 340,
        hue: rand() > 0.55 ? 200 : rand() > 0.5 ? 265 : 190,
        alpha: 0.05 + rand() * 0.06,
      });
    }
  }
  seedSpace();

  /* -------------------------------------------------------------- ship art */

  /**
   * Enterprise-E, seen from above: the saucer, the engineering hull and two
   * nacelles on swept pylons. Drawn facing +x, so a ship pointing up is -π/2.
   */
  function drawEnterprise(g, x, y, facing, scale, glow) {
    g.save();
    g.translate(x, y);
    g.rotate(facing);
    g.scale(scale, scale);

    // engine glow behind the nacelles
    if (glow > 0) {
      const grad = g.createRadialGradient(-18, 0, 2, -18, 0, 26 * glow);
      grad.addColorStop(0, 'rgba(120,220,255,.55)');
      grad.addColorStop(1, 'rgba(120,220,255,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(-18, 0, 26 * glow, 0, TAU);
      g.fill();
    }

    // nacelles
    g.fillStyle = '#b9cfe0';
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(-2, side * 13);
      g.lineTo(-20, side * 14);
      g.lineTo(-20, side * 9.5);
      g.lineTo(-2, side * 9);
      g.closePath();
      g.fill();
      // warp grille
      g.fillStyle = '#63d8ff';
      g.fillRect(-19, side * 12.4 - (side > 0 ? 0.4 : 3.2), 13, 2.4);
      g.fillStyle = '#b9cfe0';
      // pylon
      g.beginPath();
      g.moveTo(-1, side * 7);
      g.lineTo(-7, side * 12);
      g.lineTo(-3, side * 12);
      g.lineTo(2, side * 7);
      g.closePath();
      g.fill();
    }

    // engineering hull
    g.fillStyle = '#cfe2f2';
    g.beginPath();
    g.moveTo(7, -6.5);
    g.lineTo(-17, -5);
    g.lineTo(-17, 5);
    g.lineTo(7, 6.5);
    g.closePath();
    g.fill();

    // saucer
    const saucer = g.createLinearGradient(6, 0, 20, 0);
    saucer.addColorStop(0, '#e8f4ff');
    saucer.addColorStop(1, '#a9c6dc');
    g.fillStyle = saucer;
    g.beginPath();
    g.ellipse(10, 0, 11, 9.5, 0, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(20,60,90,.55)';
    g.lineWidth = 0.8;
    g.stroke();

    // bridge dome + phaser strip
    g.fillStyle = '#8fb8d4';
    g.beginPath();
    g.arc(12, 0, 3.4, 0, TAU);
    g.fill();
    g.fillStyle = glow > 0.35 ? '#ffe9a6' : '#d9ecf8';
    g.beginPath();
    g.arc(12, 0, 1.5, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255,215,120,.85)';
    g.lineWidth = 1.1;
    g.beginPath();
    g.arc(10, 0, 8, -1.15, 1.15);
    g.stroke();

    g.restore();
  }

  /** Narada: a long drilling rig with spines, ring and a hungry red core. */
  function drawNarada(g, x, y, facing, scale, glow, damageFrac) {
    g.save();
    g.translate(x, y);
    g.rotate(facing);
    g.scale(scale, scale);

    g.strokeStyle = '#5b4b52';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(26, 0);
    g.lineTo(-30, 0);
    g.stroke();

    // spines
    g.strokeStyle = '#6d5a60';
    g.lineWidth = 2.4;
    for (const side of [-1, 1]) {
      for (const [sx, len] of [[14, 20], [-2, 26], [-18, 18]]) {
        g.beginPath();
        g.moveTo(sx, side * 4);
        g.lineTo(sx - 7, side * len);
        g.stroke();
      }
    }

    // ring
    g.strokeStyle = '#8a6d6a';
    g.lineWidth = 3.4;
    g.beginPath();
    g.ellipse(-4, 0, 18, 13, 0, 0, TAU);
    g.stroke();

    // hull
    g.fillStyle = '#4d3f45';
    g.beginPath();
    g.moveTo(30, 0);
    g.lineTo(18, -8);
    g.lineTo(-20, -10);
    g.lineTo(-34, -4);
    g.lineTo(-34, 4);
    g.lineTo(-20, 10);
    g.lineTo(18, 8);
    g.closePath();
    g.fill();

    // core
    const core = g.createRadialGradient(2, 0, 1, 2, 0, 13 * (1 + glow));
    core.addColorStop(0, 'rgba(255,150,90,.95)');
    core.addColorStop(0.5, 'rgba(255,80,60,.45)');
    core.addColorStop(1, 'rgba(255,60,40,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(2, 0, 13 * (1 + glow), 0, TAU);
    g.fill();

    // drill tip
    g.fillStyle = '#b08a70';
    g.beginPath();
    g.moveTo(34, -4);
    g.lineTo(46, 0);
    g.lineTo(34, 4);
    g.closePath();
    g.fill();

    if (damageFrac > 0.25) {
      g.fillStyle = `rgba(255,120,80,${(damageFrac * 0.35).toFixed(2)})`;
      g.beginPath();
      g.arc(-6, 6, 9, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  /** Vengeance: a wide, flat dreadnought with a pair of forward prongs. */
  function drawVengeance(g, x, y, facing, scale, glow, damageFrac) {
    g.save();
    g.translate(x, y);
    g.rotate(facing);
    g.scale(scale, scale);

    // twin prongs
    g.fillStyle = '#6a7684';
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(24, side * 3);
      g.lineTo(38, side * 9);
      g.lineTo(24, side * 12);
      g.closePath();
      g.fill();
    }

    // hull
    const hull = g.createLinearGradient(-20, 0, 22, 0);
    hull.addColorStop(0, '#4a5563');
    hull.addColorStop(1, '#9fb0c2');
    g.fillStyle = hull;
    g.beginPath();
    g.moveTo(28, 0);
    g.lineTo(12, -14);
    g.lineTo(-16, -17);
    g.lineTo(-26, -9);
    g.lineTo(-26, 9);
    g.lineTo(-16, 17);
    g.lineTo(12, 14);
    g.closePath();
    g.fill();

    // spine and running lights
    g.strokeStyle = 'rgba(180,210,235,.5)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(20, 0);
    g.lineTo(-20, 0);
    g.stroke();
    g.fillStyle = glow > 0.4 ? '#ffd0a0' : '#9fb6c9';
    for (const [px, py] of [[6, -8], [6, 8], [-10, -10], [-10, 10]]) {
      g.beginPath();
      g.arc(px, py, 1.7, 0, TAU);
      g.fill();
    }

    // engine bank
    const engine = g.createLinearGradient(-30, 0, -20, 0);
    engine.addColorStop(0, 'rgba(255,150,90,.9)');
    engine.addColorStop(1, 'rgba(255,90,60,0)');
    g.fillStyle = engine;
    g.fillRect(-34, -9, 10, 18);

    if (damageFrac > 0.3) {
      g.fillStyle = `rgba(255,110,80,${(damageFrac * 0.3).toFixed(2)})`;
      g.beginPath();
      g.arc(-2, -4, 8, 0, TAU);
      g.fill();
    }
    g.restore();
  }

  /**
   * Dispatches by ship id; `glow` 0…1 is the engine/weapon brightness.
   *
   * The baked turntable from `model.fbx` is used when it is in memory, and the
   * vector art below is the fallback — so a slow network, a blocked image or a
   * headless test still draws a ship instead of a hole in space.
   */
  /**
   * The atlas keys are liveries ('player'), the game's ids are ships
   * ('enterprise'). One map, in one place — getting this wrong is exactly how
   * the player's ship kept drawing its fallback art.
   */
  const ART_KEY = { enterprise: 'player', narada: 'narada', vengeance: 'vengeance' };
  const artKey = (id) => ART_KEY[id] || id;

  function drawShip(id, g, x, y, facing, scale, glow, damageFrac = 0) {
    const spec = R.SHIPS[id] || R.SHIPS.enterprise;
    if (ART) {
      // the atlas cell already includes the whole hull, so the diameter is the
      // model's own footprint times the caller's zoom
      const diameter = spec.radius * 2.5 * scale;
      if (ART.drawShip(g, artKey(id), x, y, facing, diameter, {
        glow: clamp(glow, 0, 1),
        glowColour: engineColour(id, glow),
        scale: 1,
      })) return true;
    }
    if (id === 'narada') return drawNarada(g, x, y, facing, scale, glow, damageFrac);
    if (id === 'vengeance') return drawVengeance(g, x, y, facing, scale, glow, damageFrac);
    return drawEnterprise(g, x, y, facing, scale, glow);
  }

  /** The additive plume behind each ship, matched to its livery. */
  function engineColour(id, glow) {
    const a = clamp(0.25 + glow * 0.6, 0, 1).toFixed(2);
    if (id === 'narada') return `rgba(255,120,60,${a})`;
    if (id === 'vengeance') return `rgba(255,170,90,${a})`;
    return `rgba(120,220,255,${a})`;
  }

  /** Ask for a ship's atlas the first time it is needed (never at boot). */
  function ensureArt(id) {
    if (!ART) return;
    const key = artKey(id);
    if (ART.isHigh && ART.isHigh(key)) return;
    // 2× the on-screen footprint is sharp enough on a phone at DPR 2
    const need = (R.SHIPS[id] || R.SHIPS.enterprise).radius * 2.5 * 2;
    ART.load(key, { highNeeded: need });
  }

  /* ------------------------------------------------------------------- waves */
  /**
   * A banner carries a headline and, optionally, a quieter sub-line — the
   * difference between "WAVE 4" and "WAVE 4 / 2 NARADA · 2 VENGEANCE".
   */
  function banner(text, seconds = 1.6, sub = '') {
    const el = $('banner');
    const head = $('bannerText');
    const under = $('bannerSub');
    if (head) head.textContent = String(text).toUpperCase();
    else if (el) el.textContent = String(text).toUpperCase();
    if (under) under.textContent = String(sub || '').toUpperCase();
    if (el) el.classList.add('show');
    bannerTimer = seconds;
  }

  function spawnWave() {
    run.wave += 1;
    const spec = R.waveFor(run.wave);
    const rand = R.rng(run.seed + run.wave * 97);
    enemies = [];
    const ring = 820;
    let slot = 0;
    const add = (id, extra = {}) => {
      const ship = R.SHIPS[id];
      ensureArt(id);
      const angle = rand() * TAU;
      const point = R.spawnPoint(angle, ring * (0.85 + rand() * 0.3));
      const hpScale = spec.hpScale;
      enemies.push({
        id,
        name: ship.name,
        x: point.x, y: point.y,
        facing: angle + Math.PI,
        vx: 0, vy: 0,
        hull: ship.hull * hpScale, hullMax: ship.hull * hpScale,
        shields: ship.shields * hpScale, shieldsMax: ship.shields * hpScale,
        sinceHit: 99,
        fireAt: 1.2 + slot * 0.45 + rand(),
        radius: ship.radius,
        speed: ship.speed * spec.speedScale,
        turn: ship.turn,
        dmgScale: spec.dmgScale,
        strafe: rand() > 0.5 ? 1 : -1,
        wobble: rand() * TAU,
      });
      slot += 1;
    };
    for (let i = 0; i < spec.narada; i++) add('narada');
    for (let i = 0; i < spec.vengeance; i++) add('vengeance');
    waveTimer = 0;
    const sub = [spec.narada ? `${spec.narada} NARADA` : '', spec.vengeance ? `${spec.vengeance} VENGEANCE` : '']
      .filter(Boolean).join(' · ');
    banner(`WAVE ${run.wave}`, 1.5, sub);
    beep(320, 0.12, 0.05);
  }

  /* ------------------------------------------------------------------ sounds */
  let audio = null;
  function beep(freq, dur, gain) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      g.gain.value = gain || 0.04;
      o.connect(g).connect(audio.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
      o.stop(audio.currentTime + dur + 0.02);
    } catch { /* audio is optional */ }
  }

  /* ------------------------------------------------------------- particles */
  /** The frame budget decides how generous the fireworks are. */
  const sparkCap = () => (perf.ui === 'low' ? 90 : perf.ui === 'medium' ? 170 : 260);

  function burst(x, y, count, colour, speed = 180) {
    const budget = sparkCap() - sparks.length;
    const n = Math.min(count, Math.max(2, Math.round(count * (perf.ui === 'low' ? 0.5 : perf.ui === 'medium' ? 0.75 : 1))));
    for (let i = 0; i < n && i < budget; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.35 + Math.random());
      sparks.push({
        x, y,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v,
        life: 0.5 + Math.random() * 0.6,
        max: 1.1,
        colour,
        size: 1 + Math.random() * 2.4,
      });
    }
  }

  function ring(x, y, colour, size = 30, life = 0.45) {
    sparks.push({ x, y, vx: 0, vy: 0, life, max: life, colour, size: 0, ring: size, grow: size * 2.4 });
  }

  /** A brief white-out: the impact frame of a torpedo or a lost ship. */
  function flash(amount = 0.35) {
    flashLevel = Math.max(flashLevel, amount);
    const el = $('flash');
    if (el) el.style.opacity = String(Math.min(0.5, amount));
  }

  /** A cross where the shot landed, so hits are legible at phone size. */
  function mark() {
    hitMarker = 0.22;
  }

  /* ------------------------------------------------------------- the player */
  const player = () => run.ship;

  /**
   * The live spec: the hull you are flying, with the upgrades and the crew
   * folded in. Everything in the sim asks this, so a purchase changes the fight
   * the moment the next run starts.
   */
  function shipSpec() {
    const base = R.SHIPS[R.PLAYER_SHIP];
    const st = run.stats || statsNow();
    return {
      ...base,
      hull: st.hull,
      shields: st.shields,
      speed: st.speed,
      turn: st.turn,
      radius: st.radius || base.radius,
      shieldRegen: st.shieldRegen || base.shieldRegen,
      torpedo: { ...base.torpedo, load: st.torpedoes || base.torpedo.load },
      // everything the hangar can change has to survive the spread, or the
      // panel would be telling the truth and the fight a different story
      warpJump: st.warpJump || 1200,
      warpCooldown: st.warpCooldown || WARP_COOLDOWN,
      laser: st.laser || 0,
      laserDps: st.laserDps || 0,
      repair: st.repair || 0,
      berths: st.berths || base.berths,
      crew: st.crew || [],
    };
  }

  /** The nearest live contact, or null. The crew's eyes. */
  function nearestEnemy() {
    const s = player();
    let best = null;
    let bestDist = Infinity;
    for (const enemy of enemies) {
      const d = Math.hypot(enemy.x - s.x, enemy.y - s.y);
      if (d < bestDist) { bestDist = d; best = enemy; }
    }
    return best;
  }

  /**
   * Pause is a first-class state: the sim stops, the clock stops, and the
   * overlay is what the player resumes from. A phone that is locked or a tab
   * that is hidden pauses itself — losing a run because the screen went dark is
   * not a difficulty setting.
   */
  function setPaused(want, { silent = false } = {}) {
    const next = screen === 'battle' ? Boolean(want) : false;
    if (next === paused) return paused;
    paused = next;
    const el = $('pause');
    if (el) el.classList.toggle('hidden', !paused);
    if (paused && !silent) {
      banner('PAUSED', 0.001);
      if (el) quietBanner();
    }
    input.fire = false;
    input.torpedo = false;
    input.evade = false;
    input.turn = 0;
    input.thrust = 0;
    return paused;
  }

  /** Hide the in-game banner without ending a pause. */
  function quietBanner() {
    const el = $('banner');
    if (el) el.classList.remove('show');
    bannerTimer = 0;
  }

  function startBattle() {
    run = R.newRun({ seed: (Math.random() * 0xffff) | 0 });
    run.screen = 'battle';
    screen = 'battle';
    hangarOpen = false;
    interiorOpen = false;
    $('hangar')?.classList.add('hidden');
    $('interior')?.classList.add('hidden');
    // the hull, the upgrades and the crew all land on the ship here, which is
    // the one place a run is allowed to start from
    const st = statsNow();
    run.stats = st;
    run.ship.hull = run.ship.hullMax = st.hull;
    run.ship.shields = run.ship.shieldsMax = st.shields;
    run.ship.torpedoes = st.torpedoes;
    run.ship.laserHeat = 0;
    run.ship.crewFire = 0;
    run.creditsEarned = 0;
    warp.cooldown = 0;
    warp.jump = st.warpJump / 0.62;
    input.manualAt = -99;
    input.crewTurn = 0;
    input.crewThrust = 0;
    enemies = [];
    shots = [];
    beams = [];
    sparks = [];
    run.questScore = 0;
    buildSector(run.seed);
    waveTimer = 0.6;
    shake = 0;
    cam = { x: 0, y: 0 };
    $('title').classList.add('hidden');
    $('result').classList.add('hidden');
    $('hud').classList.remove('hidden');
    paused = false;
    const pauseEl = $('pause');
    if (pauseEl) pauseEl.classList.add('hidden');
    flashLevel = 0;
    hitMarker = 0;
    damageLevel = 0;
    const dmg = $('damageFx');
    if (dmg) dmg.style.opacity = '0';
    paintHud(true);
    // point the bow at the closest landmark: an open sector that opens onto
    // something is a sector, not a void with a HUD on it
    if (sites.length) {
      let near = sites[0];
      let nearDist = Infinity;
      for (const site of sites) {
        const d = Math.hypot(site.x, site.y);
        if (d < nearDist) { nearDist = d; near = site; }
      }
      run.ship.facing = R.bearing(0, 0, near.x, near.y);
      cam = { x: 0, y: 0 };
    }
    banner('RED ALERT', 1.2, `${allies.length} ENTERPRISES ON YOUR WING`);
    beep(180, 0.2, 0.06);
    initGL();
  }

  function playerHit(amount, x, y) {
    const s = player();
    const result = R.damage({ shields: s.shields, hull: s.hull }, amount);
    s.shields = result.shields;
    s.hull = result.hull;
    s.sinceHit = 0;
    if (result.absorbed > 0) ring(x, y, 'rgba(120,210,255,.9)');
    if (result.bleed > 0) burst(x, y, 8, 'rgba(255,190,120,.9)', 150);
    shake = Math.min(14, shake + (4 + result.bleed * 0.05));
    if (result.shieldsDown) { banner('SHIELDS DOWN', 1.2, 'ROUTE POWER TO THE HULL'); flash(0.18); }
    paintHud();
    if (result.down) endBattle();
  }

  function endBattle() {
    if (screen !== 'battle') return;
    paused = false;
    const pauseEl = $('pause');
    if (pauseEl) pauseEl.classList.add('hidden');
    screen = 'over';
    run.screen = 'over';
    $('hud').classList.add('hidden');
    const score = scoreNow();
    const isBest = score > best;
    $('result').classList.remove('hidden');
    $('resultScore').textContent = String(score);
    $('resultWave').textContent = String(run.wave);
    $('resultKills').textContent = String(run.kills);
    $('resultTime').textContent = `${Math.round(run.seconds)}s`;
    const setStat = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    const flown = quests.filter((q) => q.done).length;
    setStat('resultQuests', `${flown}/${quests.length || 4}`);
    setStat('resultWarps', warp.jumps);
    setStat('resultWing', allies.filter((a) => a.hull > 0).length);
    setStat('resultBest', Math.max(best, score));
    const title = $('resultTitle');
    if (title) title.textContent = isBest ? 'NEW BEST RUN' : 'SHIP LOST';
    const text = $('resultText');
    if (text) {
      const bank = `${hangar.credits} CR IN REQUISITION — THE SHIPYARD IS OPEN.`;
      text.textContent = isBest
        ? `Starfleet Command has logged the best run in the sector. ${bank}`
        : `The Enterprise is gone. ${bank}`;
    }
    saveBest(score);
    paintBest(isBest);
    pushHistory({
      score, wave: run.wave, kills: run.kills, jumps: warp.jumps,
      objectives: quests.filter((q) => q.done).length, at: Date.now(),
    });
    sdk.score({ score, day: run.wave, seconds: Math.round(run.seconds), meta: `${run.kills} kills` });
    beep(90, 0.5, 0.07);
    burst(player().x, player().y, 60, 'rgba(255,180,120,.9)', 260);
    ring(player().x, player().y, 'rgba(255,200,150,.8)', 60, 0.9);
    flash(0.45);
  }

  function backToTitle() {
    hangarOpen = false;
    interiorOpen = false;
    $('hangar')?.classList.add('hidden');
    $('interior')?.classList.add('hidden');
    screen = 'title';
    $('result').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('title').classList.remove('hidden');
    paintBest();
  }

  /* ------------------------------------------------------------- weapons */

  /** Nearest enemy inside the phaser arc and range, or null. */
  function targetInArc(arc, range) {
    const s = player();
    let bestTarget = null;
    let bestDist = Infinity;
    for (const e of enemies) {
      const dist = Math.hypot(e.x - s.x, e.y - s.y);
      if (dist > range) continue;
      const to = R.bearing(s.x, s.y, e.x, e.y);
      if (!R.inArc(s.facing, to, arc)) continue;
      if (dist < bestDist) { bestDist = dist; bestTarget = e; }
    }
    return bestTarget ? { enemy: bestTarget, dist: bestDist } : null;
  }

  function firePhasers() {
    const s = player();
    const spec = shipSpec();
    if (s.phaserHeat > 0) return;
    s.phaserHeat = spec.phaser.every;
    const s2 = player();
    const found = targetInArc(spec.phaser.arc, spec.phaser.range);
    // the beam is drawn either way: a miss is information, not silence
    const range = spec.phaser.range;
    const endX = s2.x + Math.cos(s2.facing) * range * 0.55;
    const endY = s2.y + Math.sin(s2.facing) * range * 0.55;
    beams.push({
      x1: s2.x + Math.cos(s2.facing) * 22, y1: s2.y + Math.sin(s2.facing) * 22,
      x2: found ? found.enemy.x : endX,
      y2: found ? found.enemy.y : endY,
      life: 0.12, hit: Boolean(found),
      colour: found ? 'rgba(255,228,150,.98)' : 'rgba(150,215,255,.5)',
    });
    if (!found) { beep(700, 0.03, 0.012); return; }
    const power = R.beamPower(found.dist, range);
    hitEnemy(found.enemy, spec.phaser.dmg * power, found.enemy.x, found.enemy.y);
    beep(found ? 900 : 600, 0.04, 0.02);
  }

  function launchTorpedo() {
    const s = player();
    const spec = shipSpec();
    if (s.torpedoes <= 0) { beep(160, 0.06, 0.02); return; }
    s.torpedoes -= 1;
    const side = (s.torpedoes % 2 === 0 ? 1 : -1);
    const heading = s.facing;
    const ox = Math.cos(heading) * 18 - Math.sin(heading) * side * 7;
    const oy = Math.sin(heading) * 18 + Math.cos(heading) * side * 7;
    shots.push({
      side: 'player', kind: 'torpedo',
      x: s.x + ox, y: s.y + oy,
      vx: Math.cos(heading) * spec.torpedo.speed + s.vx * 0.4,
      vy: Math.sin(heading) * spec.torpedo.speed + s.vy * 0.4,
      facing: heading,
      life: 3.2,
      dmg: spec.torpedo.dmg,
      splash: spec.torpedo.splash,
      radius: 5,
    });
    paintHud();
    beep(240, 0.12, 0.035);
  }

  function evasive() {
    const s = player();
    const spec = shipSpec();
    if (s.evade > 0) return;
    s.evade = spec.evade.cooldown;
    s.evadeBoost = spec.evade.time;
    ring(s.x, s.y, 'rgba(150,230,255,.8)');
    banner('EVASIVE', 0.7);
    paintHud();
    beep(520, 0.14, 0.03);
  }

  function hitEnemy(enemy, amount, x, y) {
    const ship = R.SHIPS[enemy.id];
    const result = R.damage({ shields: enemy.shields, hull: enemy.hull }, amount);
    enemy.shields = result.shields;
    enemy.hull = result.hull;
    enemy.sinceHit = 0;
    mark();
    if (result.absorbed > 0) ring(x, y, 'rgba(255,140,120,.7)', 22, 0.34);
    if (result.bleed > 0) burst(x, y, 5, 'rgba(255,210,150,.9)', 120);
    if (result.shieldsDown) ring(x, y, 'rgba(255,120,120,.9)', 40, 0.5);
    if (result.down) {
      flash(0.22);
      ring(x, y, 'rgba(255,180,120,.85)', 70, 0.6);
      run.kills += 1;
      pay(enemy.id === 'narada' ? 120 : 80);
      for (const quest of quests) R.questEvent(quest, { type: 'kill' });
      paintQuest();
      burst(x, y, 46, 'rgba(255,170,110,.95)', 240);
      ring(x, y, 'rgba(255,220,160,.9)');
      shake = Math.min(16, shake + 6);
      beep(enemy.id === 'narada' ? 70 : 110, 0.45, 0.06);
      enemies = enemies.filter((e) => e !== enemy);
      if (!enemies.length && screen === 'battle') {
        waveTimer = 2.2;
        pay(60);
        banner(`WAVE ${run.wave} CLEARED`, 1.6, '+60 CR REQUISITION');
        sdk.state({ wave: run.wave + 1, score: scoreNow() });
      }
    }
    void ship;
  }

  /* --------------------------------------------------------------- update */
  function updatePlayer(dt) {
    const s = player();
    const spec = shipSpec();

    // evade boosts thrust and turn for a moment, then cools down
    s.evadeBoost = Math.max(0, (s.evadeBoost || 0) - dt);
    s.evade = Math.max(0, s.evade - dt);
    s.phaserHeat = Math.max(0, s.phaserHeat - dt);
    s.sinceHit += dt;
    const science = hangar.crew.some((c) => c.role === 'science') ? 2 : 1;
    warp.cooldown = Math.max(0, warp.cooldown - dt * science);

    const boost = s.evadeBoost > 0 ? spec.evade.boost : 1;
    // The helm is a station like any other: if the crew is flying and nobody has
    // touched the stick recently, their hands are on it. Touching it takes it back.
    const crewHelm = Boolean(hangar.auto?.engine) && hangar.crew.some((c) => c.role === 'helm')
      && now - (input.manualAt || -99) > 1.5;
    const turnAxis = crewHelm ? input.crewTurn || 0 : input.turn;
    const thrustAxis = crewHelm ? (input.crewThrust || 0) : input.thrust;
    s.facing += turnAxis * spec.turn * (s.evadeBoost > 0 ? 1.25 : 1) * dt;

    const targetSpeed = thrustAxis >= 0
      ? thrustAxis * spec.speed * boost
      : thrustAxis * spec.speed * 0.32;
    const tvx = Math.cos(s.facing) * targetSpeed;
    const tvy = Math.sin(s.facing) * targetSpeed;
    const k = 1 - Math.exp(-3.4 * dt);
    s.vx += (tvx - s.vx) * k;
    s.vy += (tvy - s.vy) * k;

    // a warp overrides the helm: 1,200 units along the bearing, then the helm
    // gets the ship back and has to live with the momentum
    if (warp.active > 0) {
      warp.active = Math.max(0, warp.active - dt);
      const punch = warp.jump || spec.speed * 9.5;
      s.vx = warp.dx * punch;
      s.vy = warp.dy * punch;
      if (Math.random() < 0.55) burst(s.x, s.y, 2, 'rgba(150,220,255,.8)', 90);
    }

    s.x += s.vx * dt;
    s.y += s.vy * dt;

    // the sector holds you: fly out and you are turned back, hull intact
    const fromHome = Math.hypot(s.x, s.y);
    if (fromHome > SECTOR) {
      const nx = s.x / fromHome;
      const ny = s.y / fromHome;
      s.x = nx * SECTOR;
      s.y = ny * SECTOR;
      const outward = s.vx * nx + s.vy * ny;
      if (outward > 0) { s.vx -= nx * outward; s.vy -= ny * outward; }
      if (sectorWarn <= 0) { banner('SECTOR BOUNDARY', 1.2); sectorWarn = 5; }
    }

    // shields come back when nobody is shooting at you
    const before = s.shields;
    s.shields = R.regen({ shields: s.shields, max: s.shieldsMax, since: s.sinceHit }, dt, spec);
    if (s.shields !== before) paintHud();

    // torpedo magazine refills one at a time
    if (s.torpedoes < spec.torpedo.load) {
      s.reload += dt;
      if (s.reload >= spec.torpedo.reload) {
        s.reload = 0;
        s.torpedoes += 1;
        paintHud();
      }
    } else {
      s.reload = 0;
    }

    // the photon laser: a rapid pulse cannon, once the tactical bay has it
    if (spec.laserDps > 0) {
      s.laserHeat = Math.max(0, (s.laserHeat || 0) - dt);
      if (s.laserHeat <= 0) {
        const found = targetInArc(spec.phaser.arc * 0.9, spec.phaser.range * 0.8);
        if (found) {
          s.laserHeat = 0.42;
          beams.push({
            x1: s.x + Math.cos(s.facing) * 20, y1: s.y + Math.sin(s.facing) * 20,
            x2: found.enemy.x, y2: found.enemy.y,
            life: 0.1, hit: true, colour: 'rgba(190,255,220,.95)',
          });
          hitEnemy(found.enemy, spec.laserDps * 0.42, found.enemy.x, found.enemy.y);
          beep(1180, 0.025, 0.012);
        } else {
          s.laserHeat = 0.16;
        }
      }
    }

    // tactical crew: they shoot at what is in the arc, a little slower than you
    if (!input.fire && hangar.auto?.tactical && hangar.crew.some((c) => c.role === 'tactical')) {
      s.crewFire = Math.max(0, (s.crewFire || 0) - dt);
      if (s.crewFire <= 0 && targetInArc(spec.phaser.arc * 0.75, spec.phaser.range * 0.9)) {
        s.crewFire = spec.phaser.every * 1.45;
        firePhasers();
      }
    }

    // medical: a slow patch while nothing is hitting you
    if (spec.repair > 0 && s.sinceHit > 5 && s.hull < s.hullMax) {
      s.hull = Math.min(s.hullMax, s.hull + spec.repair * dt);
    }

    if (input.fire) firePhasers();
    if (input.torpedo) { input.torpedo = false; launchTorpedo(); }
    if (input.evade) { input.evade = false; evasive(); }
    if (input.warp) { input.warp = false; beginWarp(); }
  }

  function updateEnemy(enemy, dt) {
    const s = player();
    const spec = R.SHIPS[enemy.id];
    const dist = Math.hypot(s.x - enemy.x, s.y - enemy.y);
    const to = R.bearing(enemy.x, enemy.y, s.x, s.y);

    // face the player, and steer toward (Narada) or around (Vengeance) them
    const delta = R.angleDelta(enemy.facing, to);
    enemy.facing += clamp(delta, -enemy.turn * dt, enemy.turn * dt);

    let wantSpeed = enemy.speed;
    let heading = to;
    // A chase bonus: past 720 units they pour on speed until they are back in
    // the fight. That is what stops a stalemate when the player runs.
    wantSpeed *= clamp(dist / 720, 1, 2.35);
    if (enemy.id === 'vengeance') {
      // hold a firing lane at ~330 units and slide sideways
      if (dist < 300) heading = to + Math.PI;
      else if (dist < 380) {
        heading = to + (Math.PI / 2) * enemy.strafe;
        wantSpeed *= 0.8;
      }
    } else if (dist < 260) {
      heading = to + Math.PI * 0.5;          // a rig that big pivots, it does not ram
      wantSpeed *= 0.55;
    }
    const tvx = Math.cos(heading) * wantSpeed;
    const tvy = Math.sin(heading) * wantSpeed;
    const k = 1 - Math.exp(-1.6 * dt);
    enemy.vx += (tvx - enemy.vx) * k;
    enemy.vy += (tvy - enemy.vy) * k;
    enemy.x += enemy.vx * dt;
    enemy.y += enemy.vy * dt;
    // …and they never leave the sector either
    const fromHome = Math.hypot(enemy.x, enemy.y);
    if (fromHome > SECTOR * 1.08) {
      enemy.x = (enemy.x / fromHome) * SECTOR * 1.08;
      enemy.y = (enemy.y / fromHome) * SECTOR * 1.08;
    }

    // shields of the Vengeance regenerate too, slowly
    enemy.sinceHit += dt;
    const before = enemy.shields;
    enemy.shields = R.regen({ shields: enemy.shields, max: enemy.shieldsMax, since: enemy.sinceHit }, dt, spec);
    void before;

    // fire
    enemy.fireAt -= dt;
    if (enemy.fireAt > 0) return;
    if (enemy.id === 'narada') {
      const t = spec.torpedo;
      if (dist > t.range) return;
      enemy.fireAt = t.every;
      shots.push({
        side: 'enemy', kind: 'torpedo',
        x: enemy.x + Math.cos(enemy.facing) * 34,
        y: enemy.y + Math.sin(enemy.facing) * 34,
        vx: Math.cos(to) * t.speed,
        vy: Math.sin(to) * t.speed,
        facing: to, life: 4.2,
        dmg: t.dmg * enemy.dmgScale, splash: t.splash, radius: 7,
      });
      beep(150, 0.16, 0.03);
      return;
    }
    // Vengeance: phaser bank, hitscan inside its arc
    const ph = spec.phaser;
    if (dist > ph.range || !R.inArc(enemy.facing, to, ph.arc)) return;
    enemy.fireAt = ph.every;
    beams.push({
      x1: enemy.x + Math.cos(enemy.facing) * 26, y1: enemy.y + Math.sin(enemy.facing) * 26,
      x2: s.x, y2: s.y, life: 0.1, colour: 'rgba(255,120,90,.9)',
    });
    playerHit(ph.dmg * enemy.dmgScale * R.beamPower(dist, ph.range), s.x, s.y);
    beep(420, 0.06, 0.02);
  }

  function updateShots(dt) {
    const s = player();
    for (const shot of shots) {
      shot.life -= dt;
      shot.x += shot.vx * dt;
      shot.y += shot.vy * dt;
      shot.facing = Math.atan2(shot.vy, shot.vx);

      if (shot.side === 'player') {
        for (const enemy of enemies) {
          if (Math.hypot(enemy.x - shot.x, enemy.y - shot.y) <= enemy.radius + shot.radius) {
            hitEnemy(enemy, shot.dmg, shot.x, shot.y);
            burst(shot.x, shot.y, 10, 'rgba(255,235,180,.95)', 150);
            shot.life = 0;
            break;
          }
        }
      } else if (Math.hypot(s.x - shot.x, s.y - shot.y) <= shipSpec().radius + shot.radius) {
        playerHit(shot.dmg, shot.x, shot.y);
        burst(shot.x, shot.y, 10, 'rgba(255,190,140,.9)', 150);
        shot.life = 0;
      }
    }
    shots = shots.filter((x) => x.life > 0);

    for (const beam of beams) beam.life -= dt;
    beams = beams.filter((b) => b.life > 0);

    for (const spark of sparks) {
      spark.life -= dt;
      spark.x += spark.vx * dt;
      spark.y += spark.vy * dt;
      spark.vx *= 0.97;
      spark.vy *= 0.97;
      if (spark.ring) spark.ring += 180 * dt;
    }
    sparks = sparks.filter((p) => p.life > 0);
  }

  /** One simulation step. Pure enough for a test to drive it by hand. */
  /**
   * The helmsman's hands. They point the bow at the nearest contact and close
   * to a range where the phasers bite, then hold station — which is what a
   * competent officer does and also what makes watching them work fun.
   */
  function crewTick() {
    const auto = hangar.auto || {};
    const s = player();
    const helm = auto.engine && hangar.crew.some((c) => c && c.role === 'helm');
    const target = helm ? nearestEnemy() : null;
    if (!target) { input.crewTurn = 0; input.crewThrust = 0; return; }
    const dist = Math.hypot(target.x - s.x, target.y - s.y);
    const to = R.bearing(s.x, s.y, target.x, target.y);
    const rel = R.angleDelta(s.facing, to);
    input.crewTurn = clamp(rel * 2.1, -1, 1);
    input.crewThrust = dist > 360 ? 1 : dist < 200 ? -0.55 : 0.15;
  }

  function update(dt) {
    now += dt;
    const s = player();

    // the camera follows with a little lag, so hits read as impact
    const k = 1 - Math.exp(-6 * dt);
    cam.x += (s.x - cam.x) * k;
    cam.y += (s.y - cam.y) * k;
    shake = Math.max(0, shake - dt * 22);
    sectorWarn = Math.max(0, sectorWarn - dt);
    if (bannerTimer > 0) {
      bannerTimer -= dt;
      if (bannerTimer <= 0) $('banner')?.classList.remove('show');
    }

    if (screen !== 'battle' || paused) return;
    run.seconds += dt;
    crewTick();
    updatePlayer(dt);
    for (const enemy of [...enemies]) updateEnemy(enemy, dt);
    for (const ally of allies) updateAlly(ally, dt);
    updateShots(dt);
    questTick();

    if (waveTimer > 0) {
      waveTimer -= dt;
      if (waveTimer <= 0 && screen === 'battle') spawnWave();
    }

    if (now - lastStatus > 1) {
      lastStatus = now;
      sdk.state({ wave: run.wave, score: scoreNow() });
    }
  }

  /* =========================================================== THE SECTOR
   * An open world is only open if it has somewhere to go. `ships.js` seeds the
   * landmarks and the objectives; this file flies them.
   */
  function buildSector(seed) {
    sites = (R.sectorSites ? R.sectorSites(seed) : []) || [];
    quests = (R.makeQuests ? R.makeQuests(seed, sites) : []) || [];
    const rand = R.rng((seed | 0) ^ 0x7a11);
    for (const site of sites) {
      site.spin = rand() * TAU;
      site.rocks = [];
      site.visited = false;
      if (site.kind === 'field') {
        for (let i = 0; i < 18; i++) {
          const a = rand() * TAU;
          const d = Math.sqrt(rand()) * site.r;
          site.rocks.push({
            x: site.x + Math.cos(a) * d,
            y: site.y + Math.sin(a) * d,
            size: 10 + rand() * 30,
            spin: rand() * TAU,
            alt: (rand() - 0.5) * 180,
          });
        }
      }
    }
    warp.cooldown = 0;
    warp.active = 0;
    warp.jumps = 0;
    allies = [];
    for (let i = 0; i < 2; i++) allies.push(spawnAlly(i));
    paintQuest();
    paintHistory();
  }

  /** A wing ship: another Enterprise, half a run younger than yours. */
  /**
   * The other players in the room, as the hub knows them. A sandboxed frame
   * cannot open a socket of its own, so the names arrive with `arcade:init` —
   * and when nobody else is online the wing is two Starfleet ships instead of a
   * lie about who is playing.
   */
  function roomPlayers() {
    const raw = sdk.player && sdk.player.peers;
    return Array.isArray(raw) ? raw.filter((n) => typeof n === 'string' && n).slice(0, 2) : [];
  }

  function spawnAlly(i) {
    const spec = R.SHIPS[R.PLAYER_SHIP];
    const angle = 2.1 + i * 1.5;
    const crewmate = roomPlayers()[i];
    return {
      id: R.PLAYER_SHIP,
      ally: true,
      pilot: crewmate || '',
      name: crewmate ? String(crewmate).toUpperCase().slice(0, 12) : (i ? 'ENTERPRISE-F' : 'ENTERPRISE-D'),
      registry: crewmate ? 'PLAYER · WING' : (i ? 'NCC-1701-F' : 'NCC-1701-D'),
      x: Math.cos(angle) * 300,
      y: Math.sin(angle) * 300,
      alt: i ? 30 : -24,
      facing: angle + Math.PI,
      vx: 0,
      vy: 0,
      hull: spec.hull * 0.7,
      hullMax: spec.hull * 0.7,
      shields: spec.shields * 0.7,
      shieldsMax: spec.shields * 0.7,
      sinceHit: 99,
      fireAt: 0.7 + i * 0.6,
      radius: spec.radius,
      speed: spec.speed,
      turn: spec.turn,
    };
  }

  function updateAlly(ally, dt) {
    const s = player();
    const spec = R.SHIPS[R.PLAYER_SHIP];
    ally.sinceHit += dt;
    ally.shields = R.regen({ shields: ally.shields, max: ally.shieldsMax, since: ally.sinceHit }, dt, spec);

    let target = null;
    let bestDist = Infinity;
    for (const enemy of enemies) {
      const d = Math.hypot(enemy.x - ally.x, enemy.y - ally.y);
      if (d < bestDist) { bestDist = d; target = enemy; }
    }
    const anchor = target || s;
    const toAnchor = R.bearing(ally.x, ally.y, anchor.x, anchor.y);
    // with a contact in reach, close and hold a lane across its bow — a small
    // offset, because a wing ship that cannot point at what it is shooting at
    // never fires at all; without a contact, form up on the player
    const offset = target && bestDist < 240 ? 0.3 : 0;
    const want = toAnchor + offset;
    ally.facing += clamp(R.angleDelta(ally.facing, want), -ally.turn * dt, ally.turn * dt);
    const speed = ally.speed * (target ? (bestDist > 260 ? 1 : 0.6) : 1.1);
    const k = 1 - Math.exp(-2.4 * dt);
    ally.vx += (Math.cos(ally.facing) * speed - ally.vx) * k;
    ally.vy += (Math.sin(ally.facing) * speed - ally.vy) * k;
    ally.x += ally.vx * dt;
    ally.y += ally.vy * dt;
    const home = Math.hypot(ally.x, ally.y);
    if (home > SECTOR) {
      ally.x = (ally.x / home) * SECTOR;
      ally.y = (ally.y / home) * SECTOR;
    }

    ally.fireAt -= dt;
    if (!target || ally.fireAt > 0 || bestDist > spec.phaser.range) return;
    if (!R.inArc(ally.facing, toAnchor, spec.phaser.arc)) return;
    ally.fireAt = spec.phaser.every + 0.1;
    beams.push({
      x1: ally.x, y1: ally.y, x2: target.x, y2: target.y,
      alt1: ally.alt, alt2: target.alt,
      life: 0.1, colour: 'rgba(150,225,255,.85)',
    });
    hitEnemy(target, spec.phaser.dmg * 0.75, target.x, target.y);
  }

  /* ----------------------------------------------------------------- warp
   * The sector is 4,800 units across and the helm tops out at 216 a second, so
   * a warp is what makes it open rather than enormous. It aims at whichever
   * objective is live (or the nearest contact), launches you 1,200 units that
   * way in two thirds of a second, and then spools for thirteen.
   */
  function warpTarget() {
    const s = player();
    const quest = R.activeQuest ? R.activeQuest(quests) : null;
    const site = quest && R.questTarget ? R.questTarget(quest, sites) : null;
    if (site) return site;
    let best = null;
    let bestDist = Infinity;
    for (const enemy of enemies) {
      const d = Math.hypot(enemy.x - s.x, enemy.y - s.y);
      if (d < bestDist) { bestDist = d; best = enemy; }
    }
    return best;
  }

  function beginWarp() {
    const s = player();
    if (warp.cooldown > 0) {
      banner('WARP COOLING', 0.8, `${Math.ceil(warp.cooldown)}s TO SPOOL`);
      beep(150, 0.07, 0.02);
      return false;
    }
    const target = warpTarget();
    const aim = target ? R.bearing(s.x, s.y, target.x, target.y) : s.facing;
    s.facing = aim;
    warp.active = 0.62;
    warp.dx = Math.cos(aim);
    warp.dy = Math.sin(aim);
    warp.jump = (shipSpec().warpJump || 1200) / 0.62;
    warp.cooldown = shipSpec().warpCooldown || WARP_COOLDOWN;
    warp.jumps += 1;
    ring(s.x, s.y, 'rgba(150,220,255,.85)', 44, 0.55);
    banner('WARP', 1.0, target && target.name ? target.name : 'HELM TO BEARING');
    beep(720, 0.2, 0.05);
    paintHud();
    return true;
  }

  /* --------------------------------------------------------------- quests */
  function scoreNow() {
    return R.scoreOf({ kills: run.kills, wave: run.wave, seconds: run.seconds, hull: player().hull })
      + Math.max(0, Math.round(run.questScore || 0));
  }

  function paintQuest() {
    const quest = R.activeQuest ? R.activeQuest(quests) : null;
    const el = $('questTxt');
    if (!el) return;
    if (!quest) {
      el.textContent = 'SECTOR SECURE';
      return;
    }
    const count = quest.need > 1 ? ` ${quest.progress}/${quest.need}` : '';
    el.textContent = `${quest.title}${count}`;
    const chip = $('questChip');
    if (chip) chip.classList.toggle('done', Boolean(quest.done));
  }

  function claimQuests() {
    for (const quest of quests) {
      if (!quest.done || quest.claimed) continue;
      quest.claimed = true;
      run.questScore = (run.questScore || 0) + quest.reward;
      const s = player();
      s.hull = Math.min(s.hullMax, s.hull + s.hullMax * 0.18);
      s.shields = s.shieldsMax;
      s.torpedoes = shipSpec().torpedo.load;
      pay(Math.max(40, Math.round(quest.reward * 0.3)));
      banner('OBJECTIVE COMPLETE', 1.8, `${quest.title} · +${Math.round(quest.reward * 0.3)} CR`);
      ring(s.x, s.y, 'rgba(140,255,190,.85)', 60, 0.8);
      beep(660, 0.18, 0.05);
      paintHud(true);
    }
  }

  /** Distance checks for the "fly there" objectives, once a frame. */
  function questTick() {
    if (!sites.length) return;
    const s = player();
    for (const site of sites) {
      const d = Math.hypot(site.x - s.x, site.y - s.y);
      if (d < site.r + 120 && !site.visited) {
        site.visited = true;
        for (const quest of quests) {
          if (R.questEvent(quest, { type: 'reach', siteId: site.id })) {
            banner(site.name, 1.2, 'SITE LOGGED');
          }
        }
        beep(600, 0.1, 0.03);
      } else if (d > site.r + 420) {
        site.visited = false;
      }
    }
    claimQuests();
  }

  /* ============================================================ THE HANGAR
   * Pick a hull, bolt things onto it, and hire the people who run it. Every
   * number in here comes from `ships.js` (`shipStats`), so the panel and the
   * fight can never disagree: an upgrade is bought in the DOM and felt in the
   * simulation on the very next frame.
   */
  const CREW_COST = 180;
  const ROLE_ORDER = ['helm', 'tactical', 'engineering', 'medical', 'science'];
  let hangarOpen = false;
  let interiorOpen = false;
  let interiorCtx = null;
  let interiorDrawnAt = -1;
  let interiorWasPaused = false;

  function note(text, kind = '') {
    const el = $('hangarNote');
    if (!el) return;
    el.textContent = text;
    el.className = kind;
  }

  function specText(st) {
    return `${st.klass} · ${st.hull} HULL · ${st.shields} SHIELDS · ${Math.round(st.speed)} IMPULSE`
      + ` · ${st.berths} BERTHS`;
  }

  /** The hull cards, the systems list and the roster, rebuilt from the state. */
  function paintHangar() {
    const st = statsNow();
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('hangarCredits', `${hangar.credits} CR`);
    set('hangarHull', st.name);
    set('hangarSpec', specText(st));
    set('startShipName', st.name);
    set('startShipReg', `${st.registry} · REFIT ▸`);
    const sysCount = R.UPGRADE_ORDER.reduce((n, id) => n + (R.levelOf(hangar, id) || 0), 0);
    set('hangarSysCount', `${sysCount} / 8 LINES`);
    set('hangarCrewCount', `${hangar.crew.length} / ${st.berths} BERTHS`);

    const ships = $('hangarShips');
    if (ships) {
      ships.innerHTML = Object.values(R.STARTERS).map((hull) => {
        const on = hull.id === hangar.ship ? ' on' : '';
        const berths = hull.berths + R.levelOf(hangar, 'crew');
        return `<button class="ship-opt${on}" type="button" data-ship="${hull.id}">`
          + `<b>${hull.name}</b><em>${hull.registry} · ${hull.klass}</em>`
          + `<span class="nums"><span>${hull.hull}H</span><span>${hull.shields}S</span>`
          + `<span>${hull.speed}SPD</span><span>${berths} BERTH</span></span></button>`;
      }).join('');
    }

    const systems = $('hangarSystems');
    if (systems) {
      systems.innerHTML = R.UPGRADE_ORDER.map((id) => {
        const def = R.UPGRADES[id];
        const level = R.levelOf(hangar, id);
        const cost = R.upgradeCost(hangar.upgrades, id);
        const maxed = cost == null;
        const afford = !maxed && hangar.credits >= cost;
        const pips = [];
        for (let i = 0; i < def.max; i++) pips.push(`<i class="${i < level ? 'on' : ''}"></i>`);
        return `<div class="sys"><span class="nm">${def.name}<small>${def.blurb}</small></span>`
          + `<span class="pips">${pips.join('')}</span>`
          + `<button class="buy${maxed ? ' max' : ''}" type="button" data-up="${id}"`
          + `${maxed || !afford ? ' disabled' : ''}>${maxed ? 'MAX' : `${cost} CR`}</button></div>`;
      }).join('');
    }

    const crewHost = $('hangarCrew');
    if (crewHost) {
      const rows = hangar.crew.map((member) => {
        const role = R.CREW_ROLES[member.role] || { name: member.role.toUpperCase(), blurb: '' };
        return `<div class="crew-row"><span class="dot">${String(member.name).slice(0, 2)}</span>`
          + `<span class="who"><b>${member.name}</b><em>${role.name} · SKILL ${member.skill}</em></span>`
          + `<span class="act"><button class="pill" type="button" data-dismiss="${member.id}">LEAVE</button></span></div>`;
      });
      // every role that is not filled yet is a hire the player can make
      const filled = new Set(hangar.crew.map((m) => m.role));
      const room = hangar.crew.length < st.berths;
      for (const role of ROLE_ORDER) {
        if (filled.has(role)) continue;
        const def = R.CREW_ROLES[role];
        const can = room && hangar.credits >= CREW_COST;
        rows.push(`<div class="crew-row"><span class="dot empty">＋</span>`
          + `<span class="who"><b>${def.name} OFFICER</b><em>${def.blurb}</em></span>`
          + `<span class="act"><button class="pill hire" type="button" data-hire="${role}"`
          + `${can ? '' : ' disabled'}>${CREW_COST} CR</button></span></div>`);
      }
      if (!room) {
        rows.push('<div class="crew-row"><span class="dot empty">·</span><span class="who">'
          + '<b>ALL BERTHS FULL</b><em>BUY CREW QUARTERS FOR ANOTHER SPECIALIST</em></span></div>');
      }
      crewHost.innerHTML = rows.join('');
    }
  }

  /** One delegated listener: the panel is rebuilt wholesale on every change. */
  function onHangarClick(event) {
    const target = event.target.closest ? event.target.closest('[data-ship],[data-up],[data-hire],[data-dismiss]') : null;
    if (!target) return;
    const { ship, up, hire, dismiss } = target.dataset;

    if (ship) {
      if (R.selectShip(hangar, ship)) {
        saveHangar();
        paintHangar();
        note(`${R.starterOf(ship).name} on the cradle.`, 'good');
        paintTitleStats();
      }
    } else if (up) {
      const def = R.UPGRADES[up];
      const level = R.buyUpgrade(hangar, up);
      if (level == null) note(`Not enough requisition for ${def.name}.`, 'bad');
      else {
        saveHangar();
        paintHangar();
        note(`${def.name} → LEVEL ${level}`, 'good');
        paintTitleStats();
        beep(620, 0.08, 0.03);
      }
    } else if (hire) {
      const member = R.hireCrew(hangar, hire, { cost: CREW_COST, seed: (Math.random() * 0xffff) | 0 });
      if (!member) note('No free berth, or not enough requisition.', 'bad');
      else {
        saveHangar();
        paintHangar();
        note(`${member.name} reports to ${R.CREW_ROLES[hire].name}.`, 'good');
        paintTitleStats();
        beep(540, 0.1, 0.03);
      }
    } else if (dismiss) {
      R.dismissCrew(hangar, dismiss);
      saveHangar();
      paintHangar();
      paintTitleStats();
      note('They have been reassigned.');
    }
  }

  function openHangar({ from = screen } = {}) {
    hangarReturn = from;
    hangarOpen = true;
    interiorOpen = false;
    $('interior')?.classList.add('hidden');
    const el = $('hangar');
    if (el) el.classList.remove('hidden');
    const title = $('title');
    if (title) title.classList.add('hidden');
    const result = $('result');
    if (result) result.classList.add('hidden');
    paintHangar();
    note('Requisition is earned in the sector: every kill, every objective.');
  }

  function closeHangar(launch = false) {
    hangarOpen = false;
    const el = $('hangar');
    if (el) el.classList.add('hidden');
    if (launch) { startBattle(); return; }
    if (hangarReturn === 'title' || hangarReturn === 'over') {
      // the result screen's id is `result`, the run's name for it is `over`
      const target = $(hangarReturn === 'over' ? 'result' : 'title');
      if (target) target.classList.remove('hidden');
      if (hangarReturn === 'title') paintTitleStats();
    } else {
      // came from the pause menu: put the bridge back
      const pause = $('pause');
      if (pause) pause.classList.remove('hidden');
    }
  }
  let hangarReturn = 'title';

  /* ---------------------------------------------------------- the interior
   * A cutaway of the ship you are flying: saucer forward, engineering aft,
   * the warp core where the corridors meet, and a dot for every station with
   * someone sitting at it. It is the same roster the panel edits, drawn.
   */
  function openInterior() {
    interiorOpen = true;
    interiorWasPaused = paused;
    paused = true;
    const el = $('interior');
    if (el) el.classList.remove('hidden');
    const hangarEl = $('hangar');
    if (hangarEl) hangarEl.classList.add('hidden');
    const pause = $('pause');
    if (pause) pause.classList.add('hidden');
    const c = $('interiorCanvas');
    if (c) {
      c.width = 1280;
      c.height = 720;
      try { interiorCtx = c.getContext('2d'); } catch { interiorCtx = null; }
    }
    paintInteriorPanel();
    drawInterior();
  }

  function closeInterior() {
    interiorOpen = false;
    const el = $('interior');
    if (el) el.classList.add('hidden');
    // it was opened from the shipyard: go back there, not into the fight
    if (hangarOpen) {
      const yard = $('hangar');
      if (yard) yard.classList.remove('hidden');
      paintHangar();
      return;
    }
    if (screen === 'title' || screen === 'over') {
      paused = false;
      const target = $(screen);
      if (target) target.classList.remove('hidden');
      return;
    }
    paused = interiorWasPaused ? true : false;
    if (paused) {
      const pause = $('pause');
      if (pause) pause.classList.remove('hidden');
    }
  }

  const STATIONS = [
    { id: 'helm', label: 'HELM', x: 0.30, y: 0.50, auto: 'engine' },
    { id: 'tactical', label: 'TACTICAL', x: 0.44, y: 0.30, auto: 'tactical' },
    { id: 'engineering', label: 'ENGINEERING', x: 0.66, y: 0.50, auto: null },
    { id: 'medical', label: 'MEDICAL', x: 0.30, y: 0.72, auto: 'medical' },
    { id: 'science', label: 'SCIENCE', x: 0.44, y: 0.74, auto: null },
  ];

  function paintInteriorPanel() {
    const st = statsNow();
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('intShip', st.name);
    set('intWarp', `WARP CORE ${(R.levelOf(hangar, 'warp') + 1) * 100}%`);
    set('intSub', hangar.crew.length
      ? `${hangar.crew.length} OF ${st.berths} STATIONS CREWED. TOUCH A STATION TO HAND IT TO THE CREW.`
      : `NOBODY ABOARD BUT YOU. HIRE A CREW OR FLY EVERY STATION YOURSELF.`);
    const host = $('intStations');
    if (!host) return;
    host.innerHTML = STATIONS.map((station) => {
      const role = R.CREW_ROLES[station.id];
      const member = hangar.crew.find((m) => m.role === station.id);
      const auto = station.auto ? Boolean(hangar.auto[station.auto]) : null;
      const toggle = station.auto
        ? `<button class="pill${auto ? ' on' : ''}" type="button" data-auto="${station.auto}">`
          + `${auto ? 'CREW' : 'YOU'}</button>`
        : '';
      if (!member) {
        return `<div class="station vacant"><span class="who"><b>${role.name}</b>`
          + `<em>VACANT · ${role.blurb}</em></span>`
          + `<button class="pill hire" type="button" data-hire-here="${station.id}">HIRE</button></div>`;
      }
      return `<div class="station"><span class="who"><b>${member.name}</b>`
        + `<em>${role.name} · SKILL ${member.skill}</em></span>${toggle}</div>`;
    }).join('');
  }

  /** The cutaway. Cheap 2D, drawn only while the panel is open. */
  function drawInterior() {
    const g = interiorCtx;
    if (!g) return;
    const st = statsNow();
    const s = player();
    const W = 640, H = 360;
    g.setTransform(2, 0, 0, 2, 0, 0);

    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#050e1c');
    sky.addColorStop(1, '#01040a');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);

    // the deck grid, so the empty space reads as a ship and not a void
    g.strokeStyle = 'rgba(127,228,255,.055)';
    g.lineWidth = 1;
    for (let x = 20; x < W; x += 32) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    }
    for (let y = 18; y < H; y += 32) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }

    const hullPct = clamp(s.hull / Math.max(1, s.hullMax), 0, 1);
    const plank = hullPct < 0.32 ? 'rgba(255,120,110,.75)' : 'rgba(127,228,255,.62)';
    const body = 'rgba(12,34,54,.86)';

    const round = (x, y, w, h, r) => {
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, w, h, r);
      else g.rect(x, y, w, h);
    };

    // ---- saucer (nose to the left)
    g.save();
    g.beginPath();
    g.ellipse(196, 180, 112, 86, 0, 0, TAU);
    g.fillStyle = body;
    g.fill();
    g.strokeStyle = plank;
    g.lineWidth = 2;
    g.stroke();
    // deck rings
    g.strokeStyle = 'rgba(127,228,255,.13)';
    g.lineWidth = 1;
    for (const r of [34, 56, 78]) {
      g.beginPath(); g.ellipse(196, 180, r, r * 0.77, 0, 0, TAU); g.stroke();
    }
    g.restore();

    // ---- engineering hull and the nacelles behind it
    g.fillStyle = body;
    g.strokeStyle = plank;
    g.lineWidth = 2;
    round(268, 148, 276, 64, 30);
    g.fill(); g.stroke();
    round(300, 92, 214, 26, 13);
    g.fill(); g.stroke();
    round(300, 242, 214, 26, 13);
    g.fill(); g.stroke();
    g.strokeStyle = 'rgba(127,228,255,.35)';
    g.beginPath();
    g.moveTo(272, 152); g.lineTo(310, 118);
    g.moveTo(272, 208); g.lineTo(310, 242);
    g.stroke();

    // ---- nacelle glow: they are the reason the ship moves
    const thrust = clamp(Math.hypot(s.vx, s.vy) / Math.max(1, st.speed), 0, 1);
    for (const ny of [105, 255]) {
      const glow = g.createLinearGradient(470, ny, 530, ny);
      glow.addColorStop(0, `rgba(120,220,255,${0.1 + thrust * 0.5})`);
      glow.addColorStop(1, 'rgba(120,220,255,0)');
      g.fillStyle = glow;
      g.fillRect(470, ny - 8, 62, 16);
    }

    // ---- the warp core: the heart of the cutaway, pulsing with the upgrade
    const level = R.levelOf(hangar, 'warp') + 1;
    const pulse = 0.55 + Math.sin(now * (2.2 + level * 0.3)) * 0.3;
    const coreX = 402;
    const coreY = 118;
    const coreH = 124;
    const halo = g.createRadialGradient(coreX, coreY + coreH / 2, 4, coreX, coreY + coreH / 2, 64);
    halo.addColorStop(0, `rgba(150,235,255,${0.42 * pulse})`);
    halo.addColorStop(0.55, 'rgba(80,170,255,.13)');
    halo.addColorStop(1, 'rgba(80,170,255,0)');
    g.fillStyle = halo;
    g.fillRect(coreX - 70, coreY - 26, 140, coreH + 52);

    g.fillStyle = 'rgba(6,20,36,.95)';
    round(coreX - 13, coreY - 10, 26, coreH + 20, 13);
    g.fill();
    g.strokeStyle = 'rgba(127,228,255,.5)';
    g.lineWidth = 1.5;
    g.stroke();

    const plasma = g.createLinearGradient(0, coreY, 0, coreY + coreH);
    plasma.addColorStop(0, `rgba(220,248,255,${0.55 + pulse * 0.4})`);
    plasma.addColorStop(0.5, `rgba(120,215,255,${0.35 + pulse * 0.35})`);
    plasma.addColorStop(1, `rgba(80,140,255,${0.25 + pulse * 0.3})`);
    g.fillStyle = plasma;
    round(coreX - 7, coreY, 14, coreH, 7);
    g.fill();

    // rising plasma, so the core is visibly alive
    for (let i = 0; i < 7; i++) {
      const t = ((now * (0.5 + level * 0.12) + i / 7) % 1);
      const y = coreY + coreH - t * coreH;
      g.fillStyle = `rgba(235,252,255,${(1 - t) * 0.75})`;
      g.beginPath();
      g.arc(coreX, y, 1.6 + (1 - t) * 2.4, 0, TAU);
      g.fill();
    }

    // injectors either side of the core
    g.strokeStyle = 'rgba(127,228,255,.4)';
    for (const side of [-1, 1]) {
      g.beginPath();
      g.moveTo(coreX + side * 16, coreY + 24);
      g.lineTo(coreX + side * 40, coreY + 40);
      g.lineTo(coreX + side * 40, coreY + coreH - 24);
      g.lineTo(coreX + side * 16, coreY + coreH - 12);
      g.stroke();
    }

    // ---- stations and the people at them
    for (const station of STATIONS) {
      const role = R.CREW_ROLES[station.id];
      const member = hangar.crew.find((m) => m.role === station.id);
      const x = station.x * W;
      const y = station.y * H;
      g.strokeStyle = 'rgba(127,228,255,.18)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(196, 180);
      g.lineTo(x, y);
      g.stroke();

      g.beginPath();
      g.arc(x, y, member ? 15 : 11, 0, TAU);
      g.fillStyle = member ? 'rgba(20,60,90,.95)' : 'rgba(8,20,32,.7)';
      g.fill();
      g.strokeStyle = member ? 'rgba(127,228,255,.8)' : 'rgba(127,228,255,.24)';
      g.lineWidth = 1.5;
      if (member) g.setLineDash([]);
      else g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);

      if (member) {
        const bob = Math.sin(now * 1.6 + station.x * 9) * 1.2;
        g.fillStyle = '#7fe4ff';
        g.beginPath();
        g.arc(x, y - 3 + bob, 3.2, 0, TAU);   // head
        g.fill();
        g.fillRect(x - 3.4, y + 1 + bob, 6.8, 6);   // shoulders
        g.fillStyle = 'rgba(220,245,255,.95)';
        g.font = '600 7px ui-monospace,monospace';
        g.textAlign = 'center';
        g.fillText(member.name.slice(0, 7), x, y + 24);
      } else {
        g.fillStyle = 'rgba(120,170,200,.75)';
        g.font = '600 7px ui-monospace,monospace';
        g.textAlign = 'center';
        g.fillText('VACANT', x, y + 22);
      }
      g.fillStyle = 'rgba(127,170,200,.85)';
      g.font = '600 6.5px ui-monospace,monospace';
      g.textAlign = 'center';
      g.fillText(role.name, x, y - 20);
    }

    // ---- labels around the hull
    g.textAlign = 'left';
    g.fillStyle = 'rgba(127,228,255,.55)';
    g.font = '600 7.5px ui-monospace,monospace';
    g.fillText('SAUCER · DECKS 1–12', 92, 300);
    g.fillText('ENGINEERING HULL · DECKS 13–24', 268, 130);
    g.fillStyle = 'rgba(255,213,120,.8)';
    g.fillText(`WARP CORE MK ${level}`, coreX - 34, coreY + coreH + 34);
    g.fillStyle = hullPct < 0.32 ? 'rgba(255,120,110,.9)' : 'rgba(127,228,255,.6)';
    g.textAlign = 'right';
    g.fillText(`HULL ${Math.round(hullPct * 100)}% · SHIELDS ${Math.round((s.shields / Math.max(1, s.shieldsMax)) * 100)}%`,
      W - 16, H - 14);
  }

  /* -------------------------------------------------------------- history
   * The last six runs on this device. A sandboxed frame cannot write storage,
   * so every call is guarded and the list simply lives for the session.
   */
  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      const list = raw ? JSON.parse(raw) : [];
      history = Array.isArray(list) ? list.filter((r) => r && Number.isFinite(Number(r.score))).slice(0, 6) : [];
    } catch { history = []; }
    paintHistory();
  }

  function pushHistory(entry) {
    history = [entry, ...history].slice(0, 6);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch { /* opaque origin */ }
    paintHistory();
  }

  function paintHistory() {
    const host = $('historyList');
    if (!host || host.innerHTML === undefined) return;
    if (!history.length) {
      host.innerHTML = '<li class="empty">NO RUNS LOGGED YET</li>';
      return;
    }
    host.innerHTML = history.slice(0, 6).map((row, i) => {
      const scale = i === 0 ? ' class="last"' : '';
      return `<li${scale}><span>W${Number(row.wave) || 1} · ${Number(row.kills) || 0} KILLS</span>`
        + `<b>${Number(row.score) || 0}</b></li>`;
    }).join('');
  }

  /* ================================================================= 3D
   * One WebGL canvas, one 2D canvas for the markers that are easier as pixels
   * than as DOM. `initGL` is called at boot and again on the first frame that
   * has a real canvas — a device that says no is simply never asked twice.
   */
  const LIVERY_3D = {
    enterprise: { tint: [1.06, 1.12, 1.3], glow: [0.34, 0.74, 1.0], exposure: 1.45 },
    narada: { tint: [1.2, 0.82, 0.7], glow: [1.0, 0.42, 0.18], exposure: 1.5 },
    vengeance: { tint: [0.9, 0.95, 1.04], glow: [1.0, 0.64, 0.24], exposure: 1.42 },
  };
  const wingLivery = { tint: [1.0, 1.12, 1.22], glow: [0.28, 0.9, 0.66], exposure: 1.4 };

  /** Show exactly one renderer: the GL canvas and its marker layer, or the 2D. */
  function use3D(on) {
    try {
      if (glCanvas && glCanvas.style) glCanvas.style.display = on ? 'block' : 'none';
      if (canvas && canvas.style) canvas.style.display = on ? 'none' : 'block';
      if (overlay && overlay.style) overlay.style.display = on ? 'block' : 'none';
      const tag = $('qualityTag');
      if (tag) tag.textContent = on && gl ? `3D · ${gl.tris} TRIS` : 'RENDER 2D';
    } catch { /* detached DOM */ }
  }

  function initGL() {
    if (!GL || gl || !glCanvas) return glReady;
    try { gl = GL.create(glCanvas); } catch { gl = null; }
    if (!gl) { glReady = false; use3D(false); return false; }
    try {
      overlay = document.getElementById('c2');
      if (overlay) overlayCtx = overlay.getContext ? overlay.getContext('2d') : null;
    } catch { overlay = null; overlayCtx = null; }
    try {
      if (window.STAR_MESH && gl.setMesh(window.STAR_MESH)) glReady = true;
    } catch { glReady = false; }
    use3D(Boolean(glReady));
    if (!glReady) askForMesh();
    return glReady;
  }

  /**
   * The hull is a quarter of a megabyte, so it is fetched as a plain script
   * after `arcade:ready` has already gone out: the title card is interactive
   * before the model exists, and the 2D renderer covers the gap.
   */
  function askForMesh() {
    if (meshAsked) return;
    meshAsked = true;
    try {
      const tag = document.createElement('script');
      tag.src = 'art/ship-mesh.js';
      tag.async = true;
      tag.onload = () => {
        try {
          if (gl && window.STAR_MESH && gl.setMesh(window.STAR_MESH)) {
            glReady = true;
            use3D(true);
          }
        } catch { glReady = false; }
      };
      tag.onerror = () => { glReady = false; };
      const host = document.head || document.body || document.documentElement;
      if (host && host.appendChild) host.appendChild(tag);
      else glReady = false;
    } catch { glReady = false; }
  }

  /** CSS colour → linear-ish [r,g,b] in 0…1, cached: sparks are strings. */
  const colourCache = Object.create(null);
  function rgbOf(css) {
    if (Array.isArray(css)) return css;
    const key = String(css || '');
    if (colourCache[key]) return colourCache[key];
    let out = [0.85, 0.92, 1];
    const m = /rgba?\(([^)]+)\)/.exec(key);
    if (m) {
      const parts = m[1].split(',').map((n) => Number(n.trim()));
      const a = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
      out = [(parts[0] || 0) / 255 * a, (parts[1] || 0) / 255 * a, (parts[2] || 0) / 255 * a];
    }
    colourCache[key] = out;
    return out;
  }

  /** The live camera, so the sim, the 2D markers and the GL view agree. */
  function cameraPose() {
    const s = player();
    if (screen === 'battle' || screen === 'over') {
      const rush = Math.min(70, Math.hypot(s.vx, s.vy) * 0.06);
      const back = 152 + rush + warp.active * 90;
      const lift = 74 + warp.active * 26;
      return {
        eye: [s.x - Math.cos(s.facing) * back, ALT + lift, s.y - Math.sin(s.facing) * back],
        at: [s.x + Math.cos(s.facing) * 118, ALT - 12, s.y + Math.sin(s.facing) * 118],
        fov: 58 + warp.active * 12,
      };
    }
    // the hangar: a slow turntable around the ship on her cradle
    const a = now * 0.22;
    return {
      eye: [Math.cos(a) * 132, 54, Math.sin(a) * 132],
      at: [0, 0, 0],
      fov: 52,
    };
  }

  function drawSite(site) {
    const spin = site.spin + now * 0.05;
    const tint = site.tint || [0.5, 0.6, 0.7];
    if (site.kind === 'planet') {
      gl.body('sphere', site.x, -420 - site.size * 0.6, site.y, site.size, spin,
        [tint[0] * 0.55, tint[1] * 0.55, tint[2] * 0.6], tint, 0.75, 0.97);
      gl.sprite(site.x, -420 - site.size * 0.6, site.y, site.size * 2.1,
        tint[0] * 0.12, tint[1] * 0.14, tint[2] * 0.2);
      return;
    }
    if (site.kind === 'starbase') {
      // a core drum, a docking ring and two arms — cheap, and it reads as built
      gl.body('drum', site.x, ALT + 12, site.y, site.size, spin, tint, tint, 0.8, 0.42);
      gl.body('box', site.x, ALT + 12, site.y, site.size * 0.55, spin * 1.3, tint, tint, 0.9);
      for (const side of [-1, 1]) {
        gl.body('box', site.x + Math.cos(spin) * side * site.size * 0.8, ALT + 12,
          site.y + Math.sin(spin) * side * site.size * 0.8,
          site.size * 0.22, spin, tint, tint, 0.6, 1.4);
      }
      const pulse = 0.5 + 0.5 * Math.sin(now * 2.2 + site.spin);
      gl.sprite(site.x, ALT + 12, site.y, site.size * (1.5 + pulse * 0.4),
        0.18, 0.32, 0.5);
      return;
    }
    if (site.kind === 'derelict') {
      gl.body('box', site.x, ALT + 4, site.y, site.size * 1.1, spin * 0.6,
        [0.26, 0.24, 0.22], [1.0, 0.6, 0.24], 0.5, 0.5);
      gl.body('box', site.x + site.size * 0.6, ALT + 4, site.y - site.size * 0.4,
        site.size * 0.5, spin * 1.7, [0.2, 0.19, 0.18], [1.0, 0.5, 0.2], 0.4, 0.7);
      const blink = Math.sin(now * 3.4 + site.spin) > 0.4 ? 0.9 : 0.2;
      gl.sprite(site.x, ALT + 4, site.y, site.size * 1.2, blink * 0.9, blink * 0.4, blink * 0.1);
      return;
    }
    // debris field: a scatter of rocks, each its own little world
    for (const rock of site.rocks || []) {
      gl.body('sphere', rock.x, ALT + rock.alt, rock.y, rock.size, rock.spin + now * 0.02,
        [0.3, 0.29, 0.28], [0.1, 0.11, 0.13], 0.15, 0.8);
    }
  }

  function drawShip3D(ship, shipId, size, livery, extra = {}) {
    // the wing flies the same hull in a slightly greener light, so you can tell
    // your escorts from yourself at a glance
    const live = extra.livery || LIVERY_3D[shipId] || livery;
    const deck = ALT + (ship.alt || 0);
    const roll = extra.roll || 0;
    gl.ship(ship.x, deck, ship.y, ship.facing, size, live.tint, live.glow, {
      roll, pitch: extra.pitch || 0, damage: extra.damage || 0, exposure: live.exposure,
    });
    // engines: two nacelles' worth of light, brighter under thrust
    const thrust = extra.thrust == null ? 0.5 : extra.thrust;
    const back = -0.92 * size;
    const side = 0.44 * size;
    const c = Math.cos(ship.facing);
    const sn = Math.sin(ship.facing);
    for (const dir of [-1, 1]) {
      gl.sprite(
        ship.x + c * back - sn * side * dir, deck + size * 0.12, ship.y + sn * back + c * side * dir,
        size * (0.16 + thrust * 0.22),
        live.glow[0] * (0.4 + thrust * 0.8), live.glow[1] * (0.4 + thrust * 0.8), live.glow[2] * (0.4 + thrust * 0.8),
      );
    }
  }

  /** The whole frame, in 3D. Everything it touches is already on screen. */
  function render3D(w, h, dpr) {
    const pose = cameraPose();
    let [ex, ey, ez] = pose.eye;
    if (shake > 0.2) {
      ex += (Math.random() - 0.5) * shake;
      ey += (Math.random() - 0.5) * shake * 0.6;
      ez += (Math.random() - 0.5) * shake;
    }
    gl.begin(w, h, dpr);
    gl.camera(ex, ey, ez, pose.at[0], pose.at[1], pose.at[2], pose.fov);
    gl.sky();
    if (screen !== 'title') gl.grid();

    for (const site of sites) drawSite(site);

    // the wing, then the contacts, then you: the camera is behind you
    for (const ally of allies) {
      drawShip3D(ally, R.PLAYER_SHIP, ally.radius * 1.15, wingLivery, {
        livery: wingLivery,
        roll: clamp(-ally.vx * 0.004, -0.5, 0.5),
        thrust: 0.55,
      });
    }
    for (const enemy of enemies) {
      const size = enemy.radius * (enemy.id === 'enterprise' ? 1.15 : 1.32);
      drawShip3D(enemy, enemy.id, size, LIVERY_3D[enemy.id], {
        roll: clamp(-enemy.vx * 0.003, -0.4, 0.4),
        damage: 1 - enemy.hull / Math.max(1, enemy.hullMax),
        thrust: 0.7,
      });
    }
    if (screen === 'title') {
      // the hangar: your ship, turning on the cradle, no enemies
      gl.ship(0, 0, 0, now * 0.5, 46, LIVERY_3D.enterprise.tint, LIVERY_3D.enterprise.glow,
        { roll: Math.sin(now * 0.4) * 0.08, exposure: 1.5 });
      gl.sprite(0, -6, 0, 70, 0.05, 0.12, 0.2);
    } else if (screen === 'battle') {
      const s = player();
      drawShip3D(s, R.PLAYER_SHIP, s.radius * 1.15, LIVERY_3D.enterprise, {
        roll: clamp(-input.turn * 0.5, -0.55, 0.55),
        pitch: clamp(input.thrust * 0.06, -0.09, 0.09),
        thrust: warp.active > 0 ? 1.6 : 0.45 + Math.abs(input.thrust) * 0.8,
      });
    }

    // torpedoes, sparks and beams, all as additive billboards
    for (const shot of shots) {
      const rgb = shot.side === 'player' ? [1.0, 0.86, 0.45] : [1.0, 0.46, 0.3];
      const deck = ALT + (shot.alt || 0);
      gl.sprite(shot.x, deck, shot.y, 9, rgb[0], rgb[1], rgb[2]);
      gl.sprite(shot.x - shot.vx * 0.012, deck, shot.y - shot.vy * 0.012, 5, rgb[0] * 0.5, rgb[1] * 0.4, rgb[2] * 0.3);
    }
    for (const beam of beams) {
      const rgb = rgbOf(beam.colour);
      const fade = clamp(beam.life / 0.12, 0, 1);
      gl.beam(
        [beam.x1, ALT + (beam.alt1 || 0), beam.y1],
        [beam.x2, ALT + (beam.alt2 || 0), beam.y2],
        3.2, [rgb[0] * 1.4 * fade, rgb[1] * 1.4 * fade, rgb[2] * 1.4 * fade],
      );
      gl.sprite(beam.x2, ALT + (beam.alt2 || 0), beam.y2, 22 * fade, rgb[0], rgb[1], rgb[2]);
    }
    for (const spark of sparks) {
      const rgb = rgbOf(spark.colour);
      const fade = clamp(spark.life / spark.max, 0, 1);
      if (spark.ring) {
        gl.sprite(spark.x, ALT, spark.y, Math.max(4, spark.ring), rgb[0] * fade * 0.7, rgb[1] * fade * 0.7, rgb[2] * fade * 0.7);
      } else {
        gl.sprite(spark.x, ALT, spark.y, spark.size * 2.4, rgb[0] * fade, rgb[1] * fade, rgb[2] * fade);
      }
    }
    if (warp.active > 0) {
      // star streaks: the same trick as a hyperspace jump, three lines at a time
      const s = player();
      for (let i = 0; i < 14; i++) {
        const spread = (Math.random() - 0.5) * 260;
        const along = (Math.random() - 0.5) * 520;
        const px = s.x + warp.dx * along - warp.dy * spread;
        const py = s.y + warp.dy * along + warp.dx * spread;
        gl.sprite(px, ALT + (Math.random() - 0.5) * 180, py, 4 + Math.random() * 10, 0.4, 0.7, 1.0);
      }
    }
    gl.sprites();

    drawOverlay3D(w, h);
  }

  /**
   * The 2D layer over the 3D one: lock boxes, off-screen contacts, the marker
   * on the objective. These are pixels, not DOM nodes, because there can be a
   * dozen of them and they move every frame.
   */
  function drawOverlay3D(w, h) {
    if (!gl || !overlayCtx) return;
    const g = overlayCtx;
    const dpr = perf.dpr || 1;
    try { g.setTransform(dpr, 0, 0, dpr, 0, 0); } catch { /* old context */ }
    g.clearRect(0, 0, w, h);
    if (screen !== 'battle' && screen !== 'over') return;

    const project = (x, alt, y) => {
      try { return gl.project(x, ALT + alt, y, w, h); } catch { return null; }
    };

    // the objective's landmark, so "warp to the derelict" has a picture
    const quest = R.activeQuest ? R.activeQuest(quests) : null;
    const site = quest && R.questTarget ? R.questTarget(quest, sites) : null;
    if (site) {
      const p = project(site.x, 0, site.y);
      if (p && p.onScreen) {
        g.strokeStyle = 'rgba(255,213,120,.75)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(p.x, p.y - 12); g.lineTo(p.x + 9, p.y); g.lineTo(p.x, p.y + 12); g.lineTo(p.x - 9, p.y);
        g.closePath();
        g.stroke();
      }
    }

    // contacts: a bracket on the one you are looking at, an arrow otherwise
    const s = player();
    for (const enemy of enemies) {
      const p = project(enemy.x, enemy.alt || 0, enemy.y);
      const dist = Math.hypot(enemy.x - s.x, enemy.y - s.y);
      if (!p || !p.onScreen) {
        // clamp the marker onto the edge in the direction of travel
        const bearing = R.bearing(s.x, s.y, enemy.x, enemy.y);
        const rel = R.angleDelta(s.facing, bearing);
        if (Math.abs(rel) > 2.6) continue;
        const cx = w / 2 + Math.sin(rel) * w * 0.42;
        const cy = h - 54 - clamp(dist * 0.02, 0, 80);
        g.fillStyle = enemy.id === 'narada' ? 'rgba(255,120,90,.85)' : 'rgba(255,170,110,.85)';
        g.beginPath();
        g.moveTo(cx, cy - 6); g.lineTo(cx + 6, cy + 4); g.lineTo(cx - 6, cy + 4);
        g.closePath();
        g.fill();
        continue;
      }
      const size = clamp(1600 / Math.max(60, dist), 8, 34);
      g.strokeStyle = enemy.id === 'narada' ? 'rgba(255,140,110,.55)' : 'rgba(255,180,120,.55)';
      g.lineWidth = 1.2;
      g.strokeRect(p.x - size, p.y - size, size * 2, size * 2);
    }

    try { drawWingTags(g, project, w, h); } catch { /* a tag is not worth a frame */ }

    if (warp.cooldown > 0) {
      const frac = 1 - warp.cooldown / Math.max(1, shipSpec().warpCooldown || WARP_COOLDOWN);
      g.strokeStyle = 'rgba(127,228,255,.5)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(28, h - 28, 13, -Math.PI / 2, -Math.PI / 2 + frac * TAU);
      g.stroke();
    }
  }

  /* ------------------------------------------------------------------ draw */
  function drawSpace(w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#050a16');
    g.addColorStop(0.6, '#03060f');
    g.addColorStop(1, '#02040a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // nebula clouds, very faint, parallax with the camera
    const sx = -cam.x * 0.12;
    const sy = -cam.y * 0.12;
    for (const n of nebula) {
      const px = ((n.x + sx) % 2600 + 2600) % 2600 - 300;
      const py = ((n.y + sy) % 2600 + 2600) % 2600 - 300;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, n.r);
      grad.addColorStop(0, `hsla(${n.hue},80%,60%,${n.alpha})`);
      grad.addColorStop(1, 'hsla(220,80%,50%,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, n.r, 0, TAU);
      ctx.fill();
    }

    // three star layers: the fast one sells the speed
    for (const star of stars) {
      const depth = star.layer === 0 ? 0.18 : star.layer === 1 ? 0.42 : 0.78;
      const px = ((star.x - cam.x * depth) % 2600 + 2600) % 2600 - 120;
      const py = ((star.y - cam.y * depth) % 2600 + 2600) % 2600 - 120;
      const twinkle = 0.55 + 0.45 * Math.sin(now * 2 + star.twinkle);
      ctx.fillStyle = star.layer === 2
        ? `rgba(210,240,255,${(0.85 * twinkle).toFixed(2)})`
        : `rgba(160,200,235,${(0.5 * twinkle).toFixed(2)})`;
      ctx.fillRect(px, py, star.size, star.size);
    }
  }

  /** The sector edge, drawn faintly so the wall is not a surprise. */
  function drawBoundary() {
    const bx = -cam.x;
    const by = -cam.y;
    ctx.save();
    ctx.strokeStyle = 'rgba(90,180,230,.10)';
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 16]);
    ctx.beginPath();
    ctx.arc(bx, by, SECTOR, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Contacts you cannot see get a chevron on the edge of the glass with their
   * range in hundreds of units. Without this a deep wave is a blind hunt, which
   * reads as "nothing is happening" even while you are being shot at.
   */
  /** The wing's name tags: proof that the other captains are out here. */
  function drawWingTags(g, project, w, h) {
    for (const ally of allies) {
      if (!ally.pilot) continue;
      const p = project(ally.x, ally.alt || 0, ally.y);
      if (!p || !p.onScreen) continue;
      const dist = Math.hypot(ally.x - player().x, ally.y - player().y);
      if (dist > 1400) continue;
      g.save();
      g.globalAlpha = clamp(1.35 - dist / 1100, 0.25, 1);
      g.fillStyle = 'rgba(150,255,205,.95)';
      g.font = '600 9px ui-monospace,monospace';
      g.textAlign = 'center';
      g.fillText(ally.name, p.x, p.y - 20);
      g.strokeStyle = 'rgba(109,255,168,.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(p.x - 10, p.y - 14); g.lineTo(p.x, p.y - 8); g.lineTo(p.x + 10, p.y - 14);
      g.stroke();
      g.restore();
    }
  }

  function drawMarkers(w, h) {
    const pad = 30;
    for (const enemy of enemies) {
      const sx = w / 2 + (enemy.x - cam.x);
      const sy = h / 2 + (enemy.y - cam.y);
      if (sx > pad && sx < w - pad && sy > pad && sy < h - pad) continue;
      const angle = R.bearing(w / 2, h / 2, sx, sy);
      const tx = Math.cos(angle);
      const ty = Math.sin(angle);
      const reach = Math.min(
        Math.abs(tx) > 1e-6 ? (w / 2 - pad) / Math.abs(tx) : Infinity,
        Math.abs(ty) > 1e-6 ? (h / 2 - pad) / Math.abs(ty) : Infinity,
      );
      const mx = w / 2 + tx * reach;
      const my = h / 2 + ty * reach;
      const range = Math.round(Math.hypot(enemy.x - player().x, enemy.y - player().y) / 10);
      ctx.save();
      ctx.translate(mx, my);
      ctx.rotate(angle);
      ctx.fillStyle = enemy.id === 'narada' ? 'rgba(255,140,110,.9)' : 'rgba(255,190,120,.9)';
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = 'rgba(190,225,240,.7)';
      ctx.font = '9px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(range), mx, my + (ty > 0 ? -8 : 16));
      ctx.restore();
    }
  }

  function drawPlayer() {
    const s = player();
    const spec = shipSpec();
    ensureArt(R.PLAYER_SHIP);
    const speed = Math.hypot(s.vx, s.vy) / spec.speed;
    const flicker = 0.9 + Math.sin(now * 18) * 0.06 + Math.sin(now * 7.3) * 0.04;
    const glow = clamp((0.32 + speed * 0.75 + (s.evadeBoost > 0 ? 0.55 : 0)) * flicker, 0, 1);
    // warp streak behind the ship when it is really moving
    if (speed > 0.55) {
      const len = 26 + speed * 46;
      const grad = ctx.createLinearGradient(
        s.x - Math.cos(s.facing) * len, s.y - Math.sin(s.facing) * len, s.x, s.y);
      grad.addColorStop(0, 'rgba(90,190,255,0)');
      grad.addColorStop(1, `rgba(140,225,255,${(0.1 + speed * 0.18).toFixed(2)})`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 6 + speed * 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.x - Math.cos(s.facing) * len, s.y - Math.sin(s.facing) * len);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }
    drawShip(R.PLAYER_SHIP, ctx, s.x, s.y, s.facing, 1.15, glow);
    // shield bubble, brighter the more of it is left
    const frac = s.shieldsMax ? s.shields / s.shieldsMax : 0;
    if (frac > 0.02) {
      drawShieldRing(s.x, s.y, spec.radius + 10, '110,205,255', 0.1 + frac * 0.2, -now * 0.55);
    }
  }

  function drawEnemies() {
    for (const enemy of enemies) {
      const spec = R.SHIPS[enemy.id];
      const glow = clamp(0.4 + Math.sin(now * 3 + enemy.wobble) * 0.25, 0, 1);
      const dmgFrac = 1 - enemy.hull / Math.max(1, enemy.hullMax);
      drawShip(enemy.id, ctx, enemy.x, enemy.y, enemy.facing,
        enemy.id === 'narada' ? 1.4 : 1.1, glow, dmgFrac);
      // shield shimmer for the Vengeance: rotating hex plates, not a flat ring
      if (enemy.shields > 0) {
        const frac = enemy.shieldsMax ? enemy.shields / enemy.shieldsMax : 0;
        drawShieldRing(enemy.x, enemy.y, spec.radius + 9, '255,140,120', 0.1 + frac * 0.22, now * 0.6);
      }
      // a thin health bar above each hull, so the fight is readable
      const width = spec.radius * 1.8;
      const frac = clamp(enemy.hull / Math.max(1, enemy.hullMax), 0, 1);
      ctx.fillStyle = 'rgba(4,10,18,.9)';
      ctx.fillRect(enemy.x - width / 2 - 1, enemy.y - spec.radius - 13, width + 2, 5.2);
      ctx.strokeStyle = 'rgba(150,200,225,.28)';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(enemy.x - width / 2 - 1, enemy.y - spec.radius - 13, width + 2, 5.2);
      ctx.fillStyle = enemy.id === 'narada' ? 'rgba(255,140,110,.95)' : 'rgba(255,190,120,.95)';
      ctx.fillRect(enemy.x - width / 2, enemy.y - spec.radius - 12, width * frac, 3.4);
    }
  }

  /**
   * A shield reads as six arcs that rotate and breathe — enough geometry to
   * say "this is a bubble", cheap enough for a phone.
   */
  function drawShieldRing(x, y, radius, rgb, alpha, spin) {
    if (alpha <= 0.01) return;
    ctx.save();
    ctx.strokeStyle = `rgba(${rgb},${alpha.toFixed(2)})`;
    ctx.lineWidth = 1.6;
    const plates = 6;
    const gap = 0.16;
    for (let i = 0; i < plates; i++) {
      const a0 = spin + (i / plates) * TAU + gap;
      const a1 = spin + ((i + 1) / plates) * TAU - gap;
      ctx.beginPath();
      ctx.arc(x, y, radius, a0, a1);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawShots() {
    // ---------------------------------------------------------- torpedoes
    for (const shot of shots) {
      const team = shot.side === 'player'
        ? { core: 'rgba(255,252,235,1)', halo: '255,225,150', tail: '255,180,90' }
        : { core: 'rgba(255,240,220,1)', halo: '255,140,90', tail: '255,70,40' };
      const r = shot.side === 'player' ? 8 : 12;

      // a short motion trail, so torpedoes read as moving even on a still frame
      const trail = shot.side === 'player' ? 26 : 34;
      const back = Math.atan2(shot.vy, shot.vx) + Math.PI;
      const grad = ctx.createLinearGradient(
        shot.x, shot.y, shot.x + Math.cos(back) * trail, shot.y + Math.sin(back) * trail);
      grad.addColorStop(0, `rgba(${team.halo},.55)`);
      grad.addColorStop(1, `rgba(${team.tail},0)`);
      ctx.strokeStyle = grad;
      ctx.lineWidth = shot.side === 'player' ? 5 : 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(shot.x, shot.y);
      ctx.lineTo(shot.x + Math.cos(back) * trail, shot.y + Math.sin(back) * trail);
      ctx.stroke();

      const glow = ctx.createRadialGradient(shot.x, shot.y, 0, shot.x, shot.y, r * 2.4);
      glow.addColorStop(0, `rgba(${team.halo},.95)`);
      glow.addColorStop(0.45, `rgba(${team.tail},.35)`);
      glow.addColorStop(1, `rgba(${team.tail},0)`);
      const prev = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(shot.x, shot.y, r * 2.4, 0, TAU);
      ctx.fill();
      ctx.globalCompositeOperation = prev;

      ctx.fillStyle = team.core;
      ctx.beginPath();
      ctx.arc(shot.x, shot.y, shot.side === 'player' ? 2.6 : 3.4, 0, TAU);
      ctx.fill();
    }

    // -------------------------------------------------------------- beams
    // phasers are additive light: a wide soft body with a hot white core
    const prevOp = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (const beam of beams) {
      const t = clamp(beam.life / 0.12, 0, 1);
      const alpha = t * (0.6 + Math.sin(now * 60) * 0.12);
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.strokeStyle = beam.colour;
      ctx.lineCap = 'round';
      ctx.lineWidth = 7 * t;
      ctx.globalAlpha = Math.max(0, alpha * 0.35);
      ctx.beginPath();
      ctx.moveTo(beam.x1, beam.y1);
      ctx.lineTo(beam.x2, beam.y2);
      ctx.stroke();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(beam.x1, beam.y1);
      ctx.lineTo(beam.x2, beam.y2);
      ctx.stroke();
      // impact bloom at the far end
      if (beam.hit !== false) {
        const bloom = ctx.createRadialGradient(beam.x2, beam.y2, 0, beam.x2, beam.y2, 16 * t + 4);
        bloom.addColorStop(0, 'rgba(255,245,200,.85)');
        bloom.addColorStop(1, 'rgba(255,200,120,0)');
        ctx.fillStyle = bloom;
        ctx.beginPath();
        ctx.arc(beam.x2, beam.y2, 16 * t + 4, 0, TAU);
        ctx.fill();
      }
    }
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = 1;

    // ------------------------------------------------------------ sparks
    for (const spark of sparks) {
      const alpha = clamp(spark.life / spark.max, 0, 1);
      if (spark.ring) {
        const grow = spark.grow || 0;
        const r = spark.ring + grow * (1 - alpha);
        ctx.strokeStyle = spark.colour;
        ctx.globalAlpha = alpha * 0.85;
        ctx.lineWidth = 1.4 + alpha * 1.8;
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, r, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = spark.colour;
        ctx.globalAlpha = alpha;
        ctx.fillRect(spark.x, spark.y, spark.size, spark.size);
        if (spark.size > 1.6) {
          ctx.globalAlpha = alpha * 0.25;
          ctx.fillRect(spark.x - spark.size, spark.y - spark.size, spark.size * 3, spark.size * 3);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ------------------------------------------------------ the hit marker
    if (hitMarker > 0) {
      const a = clamp(hitMarker / 0.22, 0, 1);
      const target = targetInArc(shipSpec().phaser.arc, shipSpec().phaser.range);
      if (target) {
        ctx.strokeStyle = `rgba(255,240,190,${a.toFixed(2)})`;
        ctx.lineWidth = 1.6;
        const e = target.enemy;
        const r = e.radius + 10;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(e.x + sx * r, e.y + sy * r - sy * 6);
          ctx.lineTo(e.x + sx * r, e.y + sy * r);
          ctx.lineTo(e.x + sx * r - sx * 6, e.y + sy * r);
          ctx.stroke();
        }
      }
    }
  }

  /**
   * The title screen: the ship drifts in whatever free glass the card leaves.
   * It used to be drawn at a fixed (0, 40), which parked it half off the
   * top-left corner on every screen — a screenshot showed it at once.
   */
  function drawTitleScene(w, h) {
    ensureArt(R.PLAYER_SHIP);
    const t = now * 0.35;
    let baseY = Math.max(84, h * 0.28);
    let scale = clamp(Math.min(w, h) / 300, 1.6, 2.6);
    const card = $('titleCard');
    const rect = card && card.getBoundingClientRect ? card.getBoundingClientRect() : null;
    if (rect && rect.height > 80 && rect.width > 80) {
      const room = Math.max(0, rect.top);
      if (room > 130) {
        // portrait: there is a band above the card, so the ship sits in it
        baseY = Math.max(72, room * 0.55);
        scale = clamp(Math.min(w, room) / 170, 1.5, 2.8);
      } else {
        // landscape: the card owns the glass; the ship drifts behind it, big
        baseY = rect.top + rect.height * 0.5;
        scale = clamp(w / 330, 2, 3.4);
      }
    }
    // the hangar ships turn slowly, nose-first, as if on a display cradle
    const heading = -Math.PI / 2 + Math.sin(t * 0.5) * 0.55;
    const x = w / 2 + Math.sin(t * 0.7) * Math.min(40, w * 0.08);
    const y = baseY + Math.cos(t) * 8;
    drawShip(R.PLAYER_SHIP, ctx, x, y, heading, scale, 0.45 + Math.sin(t * 1.7) * 0.12);
    // a soft cradle glow under the hull, so the ship is not floating on black
    const glow = ctx.createRadialGradient(x, y, 0, x, y, 120 * scale * 0.8);
    glow.addColorStop(0, 'rgba(60,150,220,.12)');
    glow.addColorStop(1, 'rgba(20,60,110,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, 120 * scale * 0.8, 0, TAU);
    ctx.fill();
  }

  /**
   * Paints the HUD. Every element is optional: the DOM is looked up by id and
   * skipped when a build of the page does not have it, so this can never throw
   * inside the render loop (a throw here would freeze the frame loop, which is
   * exactly the "game did not start" failure this project keeps re-learning).
   */
  function paintHud(force = false) {
    const s = player();
    const spec = shipSpec();
    const shieldPct = Math.round((s.shields / Math.max(1, s.shieldsMax)) * 100);
    const hullPct = Math.round((s.hull / Math.max(1, s.hullMax)) * 100);

    const shieldBar = $('shieldBar');
    if (shieldBar) shieldBar.style.width = `${shieldPct}%`;
    const shieldTxt = $('shieldTxt');
    if (shieldTxt) shieldTxt.textContent = String(Math.round(s.shields));
    const hullBar = $('hullBar');
    if (hullBar) {
      hullBar.style.width = `${hullPct}%`;
      hullBar.classList.toggle('low', hullPct <= 30);
    }
    const hullTxt = $('hullTxt');
    if (hullTxt) hullTxt.textContent = String(Math.round(s.hull));
    const hullWrap = $('hullBar_wrap');
    if (hullWrap) hullWrap.classList.toggle('low', hullPct <= 30);

    const waveNum = $('waveNum');
    if (waveNum) waveNum.textContent = String(Math.max(1, run.wave));
    const scoreNum = $('scoreNum');
    if (scoreNum) scoreNum.textContent = String(scoreNow());

    // the warp spool: the chip counts down, the button greys out with it
    const warpBtn = $('warpBtn');
    const warpTxt = $('warpTxt');
    const warping = warp.cooldown > 0;
    if (warpBtn) {
      warpBtn.disabled = warping;
      warpBtn.classList.toggle('ready', !warping);
      warpBtn.classList.toggle('cool', warping);
    }
    if (warpTxt) warpTxt.textContent = warping ? `${Math.ceil(warp.cooldown)}s` : 'READY';
    paintQuest();

    // torpedo pips: one dot per tube, lit while the tube is loaded
    const pips = $('torpPips');
    if (pips) {
      const html = [];
      for (let i = 0; i < spec.torpedo.load; i++) {
        html.push(`<i class="${i < s.torpedoes ? 'on' : ''}"></i>`);
      }
      pips.innerHTML = html.join('');
    }

    const evadeBtn = $('evadeBtn');
    const evadeTxt = $('evadeTxt');
    const cooling = s.evade > 0;
    if (evadeBtn) {
      evadeBtn.disabled = cooling;
      evadeBtn.classList.toggle('ready', !cooling);
      evadeBtn.classList.toggle('cool', cooling);
    }
    if (evadeTxt) evadeTxt.textContent = cooling ? `${s.evade.toFixed(1)}s` : 'READY';

    const torpBtn = $('torpBtn');
    if (torpBtn) {
      const dry = s.torpedoes <= 0;
      torpBtn.disabled = dry;
      torpBtn.classList.toggle('cool', dry);
    }

    const fireBtn = $('fireBtn');
    if (fireBtn) fireBtn.classList.toggle('hot', Boolean(input.fire));

    // the thin progress bar across the top: how deep into the wave you are
    const bar = $('waveBar');
    if (bar) {
      const alive = enemies.length;
      const frac = alive ? 1 - alive / Math.max(1, R.waveFor(Math.max(1, run.wave)).count) : 1;
      bar.style.width = `${Math.round((run.wave > 0 ? 0.08 + frac * 0.92 : 0) * 100)}%`;
    }

    // the red vignette tracks the hull, not the shields: it is a damage warning
    const want = hullPct <= 45 ? (1 - hullPct / 45) * 0.55 : 0;
    damageLevel += (want - damageLevel) * 0.25;
    const dmg = $('damageFx');
    if (dmg) dmg.style.opacity = damageLevel.toFixed(2);

    void force;
  }

  /* ------------------------------------------------------------------ loop */
  let last = performance.now();
  let hudTimer = 0;

  /** The DPR the frame asks for: the hub's quality hint and the watchdog agree. */
  function targetDpr() {
    const native = window.devicePixelRatio || 1;
    const cap = quality === 'low' ? 1 : quality === 'medium' ? 1.25 : 2;
    return Math.min(native, dprCap, cap);
  }

  /**
   * The perf watchdog. A phone that cannot hold ~45 fps loses particles and
   * resolution *in that order*, and gets them back when the frames are cheap
   * again — the game stays smooth instead of dropping into a slideshow.
   */
  function watchPerf(dt) {
    frames += 1;
    fpsTimer += dt;
    if (fpsTimer < 1) return;
    fps = frames / fpsTimer;
    frames = 0;
    fpsTimer = 0;
    perf.frames += 1;
    if (fps < 46) {
      slowStreak += 1;
      if (slowStreak >= 2) {
        slowStreak = 0;
        perf.dropped += 1;
        if (perf.ui === 'high') perf.ui = 'medium';
        else if (perf.ui === 'medium') perf.ui = 'low';
        else if (dprCap > 1) dprCap = Math.max(1, dprCap - 0.25);
      }
    } else if (fps > 57) {
      slowStreak = 0;
      if (dprCap < 2) dprCap = Math.min(2, dprCap + 0.25);
      else if (perf.ui === 'low') perf.ui = 'medium';
      else if (perf.ui === 'medium' && fps > 59) perf.ui = 'high';
    }
  }

  function frame(timestamp) {
    const raw = Math.max(0, (timestamp - last) / 1000);
    const dt = Math.min(0.05, raw);
    last = timestamp;
    // Size whichever canvas is on screen. The 2D one is `display:none` while the
    // 3D view is live, and a hidden element measures zero — hence the swap.
    const live3D = Boolean(gl && glReady && glCanvas);
    const fit = sdk.fit(live3D ? glCanvas : canvas, targetDpr());
    const w = fit.w || (live3D ? glCanvas.clientWidth : canvas.clientWidth) || 320;
    const h = fit.h || (live3D ? glCanvas.clientHeight : canvas.clientHeight) || 240;
    perf.dpr = fit.dpr || 1;
    watchPerf(raw);

    update(dt);

    // the flash and the hit marker fade on the render clock, not the sim clock,
    // so a paused run still clears them
    if (flashLevel > 0) flashLevel = Math.max(0, flashLevel - dt * 2.6);
    if (hitMarker > 0) hitMarker = Math.max(0, hitMarker - dt);
    const flashEl = $('flash');
    if (flashEl && flashLevel <= 0.01 && flashEl.style.opacity !== '0') flashEl.style.opacity = '0';

    let drew3D = false;
    if (live3D) {
      try {
        render3D(w, h, perf.dpr);
        drew3D = true;
      } catch (error) {
        // A GL frame that throws must not end the run: drop to 2D for good and
        // say so once. This is the difference between a bug and a black screen.
        glReady = false;
        use3D(false);
        try { console.warn('star battle: 3D frame failed, using 2D —', error && error.message); } catch { /* quiet */ }
      }
    }

    if (!drew3D) {
      // canvas-2D is drawn in CSS pixels; the bitmap is `dpr` times bigger, so
      // without this transform the whole game renders into a quarter of the
      // glass on any phone newer than 2019.
      try {
        if (typeof ctx.setTransform === 'function') ctx.setTransform(perf.dpr, 0, 0, perf.dpr, 0, 0);
      } catch { /* an older context */ }
      ctx.save();
      if (shake > 0.2) {
        ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      }
      drawSpace(w, h);
      if (screen === 'battle') drawBoundary();
      if (screen === 'battle' || screen === 'over') {
        ctx.save();
        ctx.translate(w / 2 - cam.x, h / 2 - cam.y);
        drawEnemies();
        if (screen === 'battle') drawPlayer();
        drawShots();
        ctx.restore();
      } else {
        drawTitleScene(w, h);
      }
      ctx.restore();
      if (screen === 'battle') {
        drawMarkers(w, h);
        try {
          drawWingTags(ctx, (x, alt, y) => ({
            x: w / 2 + (x - cam.x),
            y: h / 2 + (y - cam.y) - (alt || 0) * 0.4,
            onScreen: true,
          }), w, h);
        } catch { /* a tag is not worth a frame */ }
      }
    }

    // the cutaway is a schematic, not a 60 fps scene: 20 redraws a second is
    // plenty and leaves the rest of the frame budget to the fight behind it
    if (interiorOpen && now - interiorDrawnAt > 0.05) {
      interiorDrawnAt = now;
      try { drawInterior(); } catch { interiorOpen = false; }
    }

    hudTimer += dt;
    if (screen === 'battle' && hudTimer > 0.1) {
      hudTimer = 0;
      paintHud();
    }
    requestAnimationFrame(frame);
  }

  /* ----------------------------------------------------------------- input */
  const KEYS = {
    ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right',
    ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down',
  };

  function syncKeyboard() {
    input.turn = (input.keys.right ? 1 : 0) - (input.keys.left ? 1 : 0);
    input.thrust = (input.keys.up ? 1 : 0) - (input.keys.down ? 1 : 0);
    input.fire = Boolean(input.keys.fire) || input.touchFire;
    // a hand on the stick is a hand on the stick: the crew stands down
    if (input.turn || input.thrust) input.manualAt = now;
  }

  addEventListener('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
    if (key === 'escape') {
      if (interiorOpen) { closeInterior(); return; }
      if (hangarOpen) { closeHangar(false); return; }
    }
    if (screen !== 'battle') {
      if ((key === 'enter' || key === ' ') && screen === 'title') { event.preventDefault(); startBattle(); }
      if ((key === 'enter' || key === ' ') && screen === 'over') { event.preventDefault(); startBattle(); }
      return;
    }
    if (key in KEYS || ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
      input.keys[KEYS[event.key] || event.key.toLowerCase()] = true;
      syncKeyboard();
      event.preventDefault();
      return;
    }
    if (key === ' ' || key === 'enter') {
      input.keys.fire = true;
      syncKeyboard();
      event.preventDefault();
    }
    if (key === 'shift') input.torpedo = true;
    if (key === 'e') input.evade = true;
    if (key === 'q') input.warp = true;
  });

  addEventListener('keyup', (event) => {
    const key = String(event.key || '').toLowerCase();
    const mapped = KEYS[event.key] || key;
    if (mapped in input.keys) delete input.keys[mapped];
    if (key === ' ' || key === 'enter') delete input.keys.fire;
    if (event.key) {
      for (const [k, v] of Object.entries(KEYS)) {
        if (k.toLowerCase() === key) delete input.keys[v];
      }
    }
    syncKeyboard();
  });

  // touch: left half is a virtual stick (x = turn, y = thrust), right half fires
  function pointerDown(event) {
    if (screen !== 'battle') return;
    const rect = canvas.getBoundingClientRect();
    const px = (event.touches ? event.touches[0].clientX : event.clientX) - rect.left;
    const py = (event.touches ? event.touches[0].clientY : event.clientY) - rect.top;
    if (px < rect.width * 0.5 && !input.stick.active) {
      input.stick = { active: true, id: 1, ox: px, oy: py, x: 0, y: 0 };
    } else {
      input.touchFire = true;
      syncKeyboard();
    }
    event.preventDefault?.();
  }

  function pointerMove(event) {
    if (!input.stick.active) return;
    const rect = canvas.getBoundingClientRect();
    const point = event.touches ? event.touches[0] : event;
    const dx = (point.clientX - rect.left) - input.stick.ox;
    const dy = (point.clientY - rect.top) - input.stick.oy;
    const mag = Math.min(1, Math.hypot(dx, dy) / 52) || 0;
    const angle = Math.atan2(dy, dx);
    input.stick.x = Math.cos(angle) * mag;
    input.stick.y = Math.sin(angle) * mag;
    input.turn = clamp(input.stick.x * 1.8, -1, 1);
    input.thrust = clamp(-input.stick.y * 1.8, -1, 1);
    input.manualAt = now;
    event.preventDefault?.();
  }

  function pointerUp() {
    input.stick.active = false;
    input.stick.x = 0;
    input.stick.y = 0;
    input.touchFire = false;
    if (!Object.keys(input.keys).length) { input.turn = 0; input.thrust = 0; input.fire = false; }
    syncKeyboard();
  }

  canvas.addEventListener('mousedown', pointerDown);
  canvas.addEventListener('mousemove', (event) => { if (event.buttons) pointerMove(event); });
  addEventListener('mouseup', pointerUp);
  canvas.addEventListener('touchstart', pointerDown, { passive: false });
  canvas.addEventListener('touchmove', pointerMove, { passive: false });
  canvas.addEventListener('touchend', pointerUp);
  canvas.addEventListener('touchcancel', pointerUp);

  /* ---------------------------------------------------------------- buttons */
  const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

  /**
   * A weapon button must fire while it is held, not when it is released. A
   * `click` listener gives you the latter, which is why FIRE used to feel dead
   * on a phone: the first shot landed when you let go. Pointer events start it
   * on the way down and stop it on the way up, with touch and mouse agreeing.
   */
  function holdToFire(el, start, stop) {
    if (!el || !el.addEventListener) return;
    const down = (event) => { event.preventDefault?.(); start(); };
    const up = (event) => { event.preventDefault?.(); stop(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('pointerleave', up);
    // pointer events are not universal: mousedown/touchstart cover the rest
    el.addEventListener('mousedown', down);
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up);
    el.addEventListener('touchcancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault?.());
  }

  on('launchBtn', () => startBattle());
  on('hangarBtn', () => openHangar({ from: screen === 'battle' ? 'pause' : screen }));
  on('resultHangarBtn', () => openHangar({ from: 'over' }));
  on('hangarCloseBtn', () => closeHangar(false));
  on('hangarLaunchBtn', () => closeHangar(true));
  on('interiorBtn', () => openInterior());
  on('interiorCloseBtn', () => closeInterior());
  on('interiorHireBtn', () => { closeInterior(); });
  on('pauseIntBtn', () => openInterior());
  on('pauseHangarBtn', () => openHangar({ from: 'pause' }));

  const hangarCard = $('hangarCard');
  if (hangarCard) hangarCard.addEventListener('click', onHangarClick);

  const intStations = $('intStations');
  if (intStations) {
    intStations.addEventListener('click', (event) => {
      const autoBtn = event.target.closest ? event.target.closest('[data-auto]') : null;
      if (autoBtn) {
        const key = autoBtn.dataset.auto;
        hangar.auto = hangar.auto || {};
        hangar.auto[key] = !hangar.auto[key];
        saveHangar();
        paintInteriorPanel();
        return;
      }
      const hireBtn = event.target.closest ? event.target.closest('[data-hire-here]') : null;
      if (hireBtn) {
        closeInterior();
        note('Hire a specialist for that station.', '');
      }
    });
  }
  on('againBtn', () => startBattle());
  on('exitBtn', () => { backToTitle(); sdk.close?.(); });
  holdToFire($('fireBtn'),
    () => { input.touchFire = true; input.fire = true; },
    () => { input.touchFire = false; syncKeyboard(); });
  on('warpBtn', () => { input.warp = true; });
  // the pair the player asked for: fullscreen, with the exit right beside it
  on('fsBtn', () => { sdk.fullscreen?.(); });
  on('exitHudBtn', () => { setPaused(false); backToTitle(); sdk.close?.(); });
  addEventListener('mouseup', () => { input.touchFire = false; syncKeyboard(); });
  on('pauseBtn', () => setPaused(!paused));
  on('resumeBtn', () => setPaused(false));
  on('pauseFsBtn', () => { sdk.fullscreen?.(); });
  on('quitBtn', () => { setPaused(false); backToTitle(); sdk.close?.(); });
  document.addEventListener?.('visibilitychange', () => {
    try {
      if (document.hidden) setPaused(true, { silent: true });
    } catch { /* no document */ }
  });
  if (sdk.on) {
    try {
      sdk.on('pause', () => setPaused(true));
      sdk.on('resume', () => setPaused(false));
    } catch { /* older SDK */ }
  }
  on('torpBtn', () => { input.torpedo = true; });
  on('evadeBtn', () => { input.evade = true; });

  /* ------------------------------------------------------------------ boot */
  // Order matters (the same lesson as Iron Tide): start the loop, tell the hub
  // we are up, and only then touch the DOM. A throwing title card can no longer
  // leave a black canvas and a hub that never hears `arcade:ready`.
  requestAnimationFrame(frame);
  sdk.ready();
  try {
    loadBest();
    loadHistory();
    loadHangar();
    paintHud();
    paintTitleStats();
    // 3D first: it is the view the player asked for. If the hull has not
    // landed yet the 2D renderer covers the frame until it does.
    initGL();
    // The atlas is asked for *after* the hub has been told we are up: a slow
    // image must never delay `arcade:ready`.
    if (ART) {
      ART.boot({ highNeeded: R.SHIPS[R.PLAYER_SHIP].radius * 5, ids: ['player'] });
      ART.load('narada', { highNeeded: 120 });
      ART.load('vengeance', { highNeeded: 120 });
    }
  } catch (error) {
    try { console.warn('star battle: boot failed', error); } catch { /* no console */ }
  }

  /** The hangar's stat strip: the numbers come from `ships.js`, not the page. */
  function paintTitleStats() {
    const spec = R.SHIPS[R.PLAYER_SHIP];
    const st = statsNow();
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('statHull', st.hull);
    set('statShields', st.shields);
    set('statPhaser', spec.phaser.dmg);
    set('statTorp', st.torpedoes || spec.torpedo.load);
    set('startShipName', st.name);
    set('startShipReg', `${st.registry} · REFIT ▸`);
    const tag = $('qualityTag');
    if (tag) {
      tag.textContent = glReady && gl
        ? `3D · ${gl.tris} TRIS · ${String(quality).toUpperCase()}`
        : `2D FALLBACK · ${String(quality).toUpperCase()} · ${Math.round(perf.dpr * 100)}%`;
    }
  }

  /**
   * The hub's `arcade:init` carries the player, a render-quality hint and (when
   * Supabase is configured) the top runs for this game. All three are optional.
   */
  function applyHubInit(payload) {
    const data = payload || {};
    if (data.quality) quality = String(data.quality);
    if (Array.isArray(data.leaderboard)) paintBoard(data.leaderboard);
    paintTitleStats();
    paintHud(true);
  }
  if (sdk.on) {
    try {
      sdk.on('start', (player) => applyHubInit({ quality: sdk.quality, leaderboard: sdk.leaderboard, player }));
    } catch { /* an older SDK without events: the local values stand in */ }
  }
  applyHubInit({ quality: sdk.quality, leaderboard: sdk.leaderboard });

  // test/debug handle: drive the sim without a browser
  window.__starBattle = {
    get screen() { return screen; },
    get paused() { return paused; },
    pause: setPaused,
    get run() { return run; },
    get enemies() { return enemies; },
    get shots() { return shots; },
    get sparks() { return sparks; },
    get best() { return best; },
    start: startBattle,
    title: backToTitle,
    over: endBattle,
    paintBoard,
    get board() { return board; },
    get quality() { return quality; },
    get perf() { return perf; },
    get art() { return ART; },
    applyHubInit,
    spawnWave,
    get gl() { return glReady; },
    get sites() { return sites; },
    get quests() { return quests; },
    get allies() { return allies; },
    get history() { return history; },
    get hangar() { return hangar; },
    get stats() { return statsNow(); },
    hangarPanel: openHangar,
    interior: openInterior,
    // the debug helpers go through the same door as the buttons, or the test
    // would be exercising a different game than the player is
    buy: (id) => {
      const level = R.buyUpgrade(hangar, id);
      if (level != null) { saveHangar(); paintHangar(); }
      return level;
    },
    hit: (enemy, amount) => { if (enemy) hitEnemy(enemy, amount, enemy.x, enemy.y); },
    hire: (role) => {
      const member = R.hireCrew(hangar, role, { cost: CREW_COST });
      if (member) { saveHangar(); paintHangar(); }
      return member;
    },
    fly: (on) => { hangar.auto.engine = Boolean(on); }, 
    get credits() { return hangar.credits; },
    get warpState() { return { cooldown: warp.cooldown, active: warp.active, jumps: warp.jumps }; },
    warp: beginWarp,
    scoreNow,
    questTick,
    tick: (dt) => { update(dt); paintHud(); },
    setWave: (n) => { run.wave = Math.max(0, n | 0); },
    /** Put an enemy at a known place — a test is allowed to be a director. */
    placeEnemy: (id, x, y) => {
      const spec = R.SHIPS[id];
      if (!spec) return null;
      const enemy = {
        id, name: spec.name, x, y, facing: Math.PI, vx: 0, vy: 0,
        hull: spec.hull, hullMax: spec.hull,
        shields: spec.shields, shieldsMax: spec.shields,
        sinceHit: 99, fireAt: 999, radius: spec.radius,
        speed: 0, turn: spec.turn, dmgScale: 1, strafe: 1, wobble: 0,
      };
      enemies.push(enemy);
      return enemy;
    },
    input,
    fire: firePhasers,
    torpedo: launchTorpedo,
    evade: evasive,
    /** Point the bow at a world position, like a helmsman. */
    aimAt: (x, y) => {
      const s = player();
      s.facing = R.bearing(s.x, s.y, x, y);
      return s.facing;
    },
  };
})();
