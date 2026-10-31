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
  let bannerTimer = 0;
  let shake = 0;
  let cam = { x: 0, y: 0 };
  let best = 0;
  let now = 0;                 // seconds since boot, for animation
  let lastStatus = 0;

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
  function paintBest() {
    const el = $('bestLine');
    if (el) el.textContent = `BEST SCORE — ${best}`;
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

  /** Dispatches by ship id; `glow` 0…1 is the engine/weapon brightness. */
  function drawShip(id, g, x, y, facing, scale, glow, damageFrac = 0) {
    if (id === 'narada') return drawNarada(g, x, y, facing, scale, glow, damageFrac);
    if (id === 'vengeance') return drawVengeance(g, x, y, facing, scale, glow, damageFrac);
    return drawEnterprise(g, x, y, facing, scale, glow);
  }

  /* ------------------------------------------------------------------- waves */
  function banner(text, seconds = 1.6) {
    const el = $('banner');
    if (el) {
      el.textContent = String(text).toUpperCase();
      el.classList.add('show');
    }
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
    banner(`WAVE ${run.wave}`, 1.5);
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
  function burst(x, y, count, colour, speed = 180) {
    for (let i = 0; i < count && sparks.length < 260; i++) {
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

  function ring(x, y, colour) {
    sparks.push({ x, y, vx: 0, vy: 0, life: 0.45, max: 0.45, colour, size: 0, ring: 30 });
  }

  /* ------------------------------------------------------------- the player */
  const player = () => run.ship;
  const shipSpec = () => R.SHIPS[R.PLAYER_SHIP];

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
    if (result.shieldsDown) banner('SHIELDS DOWN', 1.2);
    paintHud();
    if (result.down) endBattle();
  }

  function endBattle() {
    if (screen !== 'battle') return;
    screen = 'over';
    run.screen = 'over';
    $('hud').classList.add('hidden');
    const score = R.scoreOf({
      kills: run.kills, wave: run.wave, seconds: run.seconds, hull: player().hull,
    });
    $('result').classList.remove('hidden');
    $('resultScore').textContent = String(score);
    $('resultWave').textContent = String(run.wave);
    $('resultKills').textContent = String(run.kills);
    $('resultTime').textContent = `${Math.round(run.seconds)}s`;
    saveBest(score);
    sdk.score({ score, day: run.wave, seconds: Math.round(run.seconds), meta: `${run.kills} kills` });
    beep(90, 0.5, 0.07);
    burst(player().x, player().y, 60, 'rgba(255,180,120,.9)', 260);
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
      life: 0.12, colour: found ? 'rgba(255,225,140,.95)' : 'rgba(160,225,255,.55)',
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
    if (result.absorbed > 0) ring(x, y, 'rgba(255,140,120,.7)');
    if (result.bleed > 0) burst(x, y, 5, 'rgba(255,210,150,.9)', 120);
    if (result.shieldsDown) ring(x, y, 'rgba(255,120,120,.9)');
    if (result.down) {
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

    if (screen !== 'battle') return;
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
    const speed = Math.hypot(s.vx, s.vy) / spec.speed;
    const glow = clamp(0.35 + speed * 0.8 + (s.evadeBoost > 0 ? 0.6 : 0), 0, 1);
    drawShip(R.PLAYER_SHIP, ctx, s.x, s.y, s.facing, 1.15, glow);
    // shield bubble, brighter the more of it is left
    const frac = s.shieldsMax ? s.shields / s.shieldsMax : 0;
    if (frac > 0.02) {
      ctx.strokeStyle = `rgba(110,205,255,${(0.12 + frac * 0.16).toFixed(2)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, spec.radius + 9, 0, TAU);
      ctx.stroke();
    }
  }

  function drawEnemies() {
    for (const enemy of enemies) {
      const spec = R.SHIPS[enemy.id];
      const glow = clamp(0.4 + Math.sin(now * 3 + enemy.wobble) * 0.25, 0, 1);
      const dmgFrac = 1 - enemy.hull / Math.max(1, enemy.hullMax);
      drawShip(enemy.id, ctx, enemy.x, enemy.y, enemy.facing,
        enemy.id === 'narada' ? 1.4 : 1.1, glow, dmgFrac);
      // shield shimmer for the Vengeance
      if (enemy.shields > 0) {
        const frac = enemy.shieldsMax ? enemy.shields / enemy.shieldsMax : 0;
        ctx.strokeStyle = `rgba(255,140,120,${(0.1 + frac * 0.18).toFixed(2)})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(enemy.x, enemy.y, spec.radius + 8, 0, TAU);
        ctx.stroke();
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

  function drawShots() {
    for (const shot of shots) {
      if (shot.side === 'player') {
        const grad = ctx.createRadialGradient(shot.x, shot.y, 0, shot.x, shot.y, 9);
        grad.addColorStop(0, 'rgba(255,245,200,.95)');
        grad.addColorStop(1, 'rgba(255,190,90,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(shot.x, shot.y, 9, 0, TAU);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,250,225,.95)';
        ctx.beginPath();
        ctx.arc(shot.x, shot.y, 2.6, 0, TAU);
        ctx.fill();
      } else {
        const grad = ctx.createRadialGradient(shot.x, shot.y, 0, shot.x, shot.y, 13);
        grad.addColorStop(0, 'rgba(255,180,120,.95)');
        grad.addColorStop(1, 'rgba(255,60,40,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(shot.x, shot.y, 13, 0, TAU);
        ctx.fill();
      }
    }

    for (const beam of beams) {
      const alpha = clamp(beam.life / 0.12, 0, 1);
      ctx.strokeStyle = beam.colour;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(beam.x1, beam.y1);
      ctx.lineTo(beam.x2, beam.y2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    for (const spark of sparks) {
      const alpha = clamp(spark.life / spark.max, 0, 1);
      if (spark.ring) {
        ctx.strokeStyle = spark.colour;
        ctx.globalAlpha = alpha * 0.8;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, spark.ring, 0, TAU);
        ctx.stroke();
      } else {
        ctx.fillStyle = spark.colour;
        ctx.globalAlpha = alpha;
        ctx.fillRect(spark.x, spark.y, spark.size, spark.size);
      }
      ctx.globalAlpha = 1;
    }
  }

  /**
   * The title screen: the ship drifts in whatever free glass the card leaves.
   * It used to be drawn at a fixed (0, 40), which parked it half off the
   * top-left corner on every screen — a screenshot showed it at once.
   */
  function drawTitleScene(w, h) {
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
    drawShip(R.PLAYER_SHIP, ctx, w / 2 + Math.sin(t * 0.7) * Math.min(40, w * 0.08),
      baseY + Math.cos(t) * 8, -Math.PI / 2 + Math.sin(t * 0.5) * 0.12, scale, 0.75);
  }

  function paintHud(force = false) {
    const s = player();
    const spec = shipSpec();
    const shieldPct = Math.round((s.shields / Math.max(1, s.shieldsMax)) * 100);
    const hullPct = Math.round((s.hull / Math.max(1, s.hullMax)) * 100);
    const shieldBar = $('shieldBar');
    const hullBar = $('hullBar');
    if (shieldBar) shieldBar.style.width = `${shieldPct}%`;
    if (hullBar) {
      hullBar.style.width = `${hullPct}%`;
      hullBar.classList.toggle('low', hullPct <= 30);
    }
    const waveNum = $('waveNum');
    if (waveNum) waveNum.textContent = String(Math.max(1, run.wave));
    const scoreNum = $('scoreNum');
    if (scoreNum) scoreNum.textContent = String(R.scoreOf({
      kills: run.kills, wave: run.wave, seconds: run.seconds, hull: s.hull,
    }));
    const torpChip = $('torpedoChip');
    if (torpChip) torpChip.innerHTML = `TORPEDOES <b>${s.torpedoes}</b>`;
    const evadeBtn = $('evadeBtn');
    if (evadeBtn) {
      evadeBtn.disabled = s.evade > 0;
      evadeBtn.classList.toggle('ready', s.evade <= 0);
      evadeBtn.textContent = s.evade > 0 ? `${s.evade.toFixed(1)}s` : 'EVADE';
    }
    const torpBtn = $('torpBtn');
    if (torpBtn) torpBtn.disabled = s.torpedoes <= 0;
    void force;
    void spec;
  }

  /* ------------------------------------------------------------------ loop */
  let last = performance.now();
  let hudTimer = 0;
  function frame(timestamp) {
    const dt = Math.min(0.05, Math.max(0, (timestamp - last) / 1000));
    last = timestamp;
    const fit = sdk.fit(canvas, Math.min(2, window.devicePixelRatio || 1));
    const w = fit.w || canvas.clientWidth || 320;
    const h = fit.h || canvas.clientHeight || 240;

    update(dt);

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
  } catch (error) {
    try { console.warn('star battle: boot failed', error); } catch { /* no console */ }
  }

  // test/debug handle: drive the sim without a browser
  window.__starBattle = {
    get screen() { return screen; },
    get run() { return run; },
    get enemies() { return enemies; },
    get shots() { return shots; },
    get sparks() { return sparks; },
    get best() { return best; },
    start: startBattle,
    title: backToTitle,
    over: endBattle,
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
