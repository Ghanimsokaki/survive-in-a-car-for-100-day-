/* STAR BATTLE — one starship, endless waves.
 *
 * The player flies the Enterprise-E (`NCC-1701-E`) against Nero's **Narada** and
 * Khan's **Vengeance**. Top-down, 2D canvas, no dependencies — the whole game is
 * this file plus `ships.js` (the balance) and the hub SDK.
 *
 * The ships are drawn as vector art (`drawEnterprise`, `drawNarada`,
 * `drawVengeance`). If you drop real models in, those three functions are the
 * only things to change: the rules, the waves and the fight do not care how a
 * ship is painted.
 *
 * Everything is in memory: the hub runs this in a sandboxed iframe with an
 * opaque origin, so localStorage throws. Best score goes through the arcade
 * SDK instead.
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

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
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

  /* ------------------------------------------------------------------ input */
  const input = {
    turn: 0, thrust: 0, fire: false, torpedo: false, evade: false,
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
  const shipSpec = () => R.SHIPS[R.PLAYER_SHIP];

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
    enemies = [];
    shots = [];
    beams = [];
    sparks = [];
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
    banner('RED ALERT', 1.2);
    beep(180, 0.2, 0.06);
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
    const score = R.scoreOf({
      kills: run.kills, wave: run.wave, seconds: run.seconds, hull: player().hull,
    });
    const isBest = score > best;
    $('result').classList.remove('hidden');
    $('resultScore').textContent = String(score);
    $('resultWave').textContent = String(run.wave);
    $('resultKills').textContent = String(run.kills);
    $('resultTime').textContent = `${Math.round(run.seconds)}s`;
    const title = $('resultTitle');
    if (title) title.textContent = isBest ? 'NEW BEST RUN' : 'SHIP LOST';
    const text = $('resultText');
    if (text) {
      text.textContent = isBest
        ? 'Starfleet Command has logged the best run in the sector.'
        : 'The Enterprise is gone. Starfleet will remember the delay you bought.';
    }
    saveBest(score);
    paintBest(isBest);
    sdk.score({ score, day: run.wave, seconds: Math.round(run.seconds), meta: `${run.kills} kills` });
    beep(90, 0.5, 0.07);
    burst(player().x, player().y, 60, 'rgba(255,180,120,.9)', 260);
    ring(player().x, player().y, 'rgba(255,200,150,.8)', 60, 0.9);
    flash(0.45);
  }

  function backToTitle() {
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
      burst(x, y, 46, 'rgba(255,170,110,.95)', 240);
      ring(x, y, 'rgba(255,220,160,.9)');
      shake = Math.min(16, shake + 6);
      beep(enemy.id === 'narada' ? 70 : 110, 0.45, 0.06);
      enemies = enemies.filter((e) => e !== enemy);
      if (!enemies.length && screen === 'battle') {
        waveTimer = 2.2;
        banner(`WAVE ${run.wave} CLEARED`, 1.6);
        sdk.state({ wave: run.wave + 1, score: R.scoreOf({ kills: run.kills, wave: run.wave, seconds: run.seconds }) });
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

    const boost = s.evadeBoost > 0 ? spec.evade.boost : 1;
    s.facing += input.turn * spec.turn * (s.evadeBoost > 0 ? 1.25 : 1) * dt;

    const targetSpeed = input.thrust >= 0
      ? input.thrust * spec.speed * boost
      : input.thrust * spec.speed * 0.32;
    const tvx = Math.cos(s.facing) * targetSpeed;
    const tvy = Math.sin(s.facing) * targetSpeed;
    const k = 1 - Math.exp(-3.4 * dt);
    s.vx += (tvx - s.vx) * k;
    s.vy += (tvy - s.vy) * k;
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

    if (input.fire) firePhasers();
    if (input.torpedo) { input.torpedo = false; launchTorpedo(); }
    if (input.evade) { input.evade = false; evasive(); }
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
    updatePlayer(dt);
    for (const enemy of [...enemies]) updateEnemy(enemy, dt);
    updateShots(dt);

    if (waveTimer > 0) {
      waveTimer -= dt;
      if (waveTimer <= 0 && screen === 'battle') spawnWave();
    }

    if (now - lastStatus > 1) {
      lastStatus = now;
      sdk.state({ wave: run.wave, score: R.scoreOf({ kills: run.kills, wave: run.wave, seconds: run.seconds }) });
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
    if (scoreNum) scoreNum.textContent = String(R.scoreOf({
      kills: run.kills, wave: run.wave, seconds: run.seconds, hull: s.hull,
    }));

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
    const fit = sdk.fit(canvas, targetDpr());
    const w = fit.w || canvas.clientWidth || 320;
    const h = fit.h || canvas.clientHeight || 240;
    perf.dpr = fit.dpr || 1;
    watchPerf(raw);

    update(dt);

    // the flash and the hit marker fade on the render clock, not the sim clock,
    // so a paused run still clears them
    if (flashLevel > 0) flashLevel = Math.max(0, flashLevel - dt * 2.6);
    if (hitMarker > 0) hitMarker = Math.max(0, hitMarker - dt);
    const flashEl = $('flash');
    if (flashEl && flashLevel <= 0.01 && flashEl.style.opacity !== '0') flashEl.style.opacity = '0';

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
    if (screen === 'battle') drawMarkers(w, h);

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
  }

  addEventListener('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
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
  on('launchBtn', () => startBattle());
  on('againBtn', () => startBattle());
  on('exitBtn', () => { backToTitle(); sdk.close?.(); });
  on('fireBtn', () => { input.touchFire = true; input.fire = true; });
  addEventListener('mouseup', () => { input.touchFire = false; syncKeyboard(); });
  on('pauseBtn', () => setPaused(!paused));
  on('resumeBtn', () => setPaused(false));
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
    paintHud();
    paintTitleStats();
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
    const set = (id, value) => { const el = $(id); if (el) el.textContent = String(value); };
    set('statHull', spec.hull);
    set('statShields', spec.shields);
    set('statPhaser', spec.phaser.dmg);
    set('statTorp', spec.torpedo.load);
    const tag = $('qualityTag');
    if (tag) tag.textContent = `RENDER ${String(quality).toUpperCase()} · ${Math.round(perf.dpr * 100)}%`;
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
