/* IRON TIDE — build a ship, buy jets, take the fleet to sea.
 *
 * Three screens share one canvas:
 *   DOCK   — refit the flagship, upgrade the hull, buy jets into the hangar
 *   BUILD  — spend your hull's slots on guns, torpedoes, flak, armour, engines
 *   BATTLE — top-down naval fight: steer, aim, fire, launch jets
 *
 * Progress lives in memory only: the hub runs this in a sandboxed iframe with an
 * opaque origin, so localStorage throws. Score goes up through Arcade.score().
 */
(() => {
  'use strict';
  const R = window.FleetRules;
  /**
   * The hub SDK (`games/_shared/sdk.js`) is loaded by index.html before this
   * file. If it is missing — opened from a file:// copy, blocked by an
   * extension, or the frame was sandboxed harder than expected — the game must
   * still play instead of throwing a ReferenceError every frame.
   */
  const sdk = (typeof window !== 'undefined' && window.Arcade) || {
    fit(canvas, dpr = 1) {
      const w = canvas.clientWidth || 960;
      const h = canvas.clientHeight || 540;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      return { w, h, dpr };
    },
    ready() {},
    score() {},
  };
  /**
   * Water physics (`water.js`). If that script is missing the game must still
   * sail: this fallback is the old arcade motion, no waves, no bobbing.
   */
  const W = (typeof window !== 'undefined' && window.WaterPhysics) || (() => {
    const body = (o = {}) => ({
      x: o.x || 0, y: o.y || 0, heading: o.heading || 0, u: 0, v: 0, r: 0,
      heave: 0, heaveVel: 0, pitch: 0, roll: 0, wake: 0, slams: 0,
      spec: { length: o.length || 46, vMax: (o.speed || 1) * 60, turnRate: 0.36, yawInertia: 1, beam: 7 },
    });
    return {
      createSea: () => ({ t: 0, step() {}, at: () => ({ h: 0, gx: 0, gy: 0 }), height: () => 0, foam: () => 0, wind: () => ({ x: 0, y: 0 }), drift: () => ({ x: 0, y: 0 }), severity: 0, preset: { name: 'FLAT', wind: 0, slamming: 0 }, setState() {} }),
      createBody: body,
      stepBody: (b, sea, dt, c = {}) => {
        b.heading += (c.rudder || 0) * b.spec.turnRate * dt;
        b.u += (c.throttle || 0) * b.spec.vMax * dt * 0.6;
        b.u *= Math.pow(0.12, dt);
        b.x += Math.cos(b.heading) * b.u * dt;
        b.y += Math.sin(b.heading) * b.u * dt;
        b.wake = Math.abs(b.u) / b.spec.vMax;
        return b;
      },
      velocityOf: (b) => ({ x: Math.cos(b.heading) * b.u, y: Math.sin(b.heading) * b.u }),
      knots: (v) => Math.abs(v) * 1.94,
      seaForSortie: () => 'calm',
    };
  })();

  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  /**
   * The 3D view has its own canvas. A canvas that has handed out a 2D context
   * can never hand out a WebGL one, so the battle needs a second bitmap — and
   * `#c` stays on top as the overlay: the stick, the lock bracket, the range
   * ring and the hull labels are cheap as pixels and unchanged from the old
   * renderer.
   */
  const glCanvas = document.getElementById('c3');
  const SEA = window.Sea3D || null;
  let gl = null;
  let glReady = false;        // the battle is drawn in WebGL
  let glBroken = false;       // a frame threw: never ask again this session
  let sea3dNote = '';         // why there is no 3D, for the dock's hint line
  const $ = (id) => document.getElementById(id);

  const fleet = R.newFleet();
  let tab = 'dock';
  let screen = 'dock';       // dock | battle | result
  let session = null;
  let dockSea = null;      // the calm swell behind the dock screens

  /* ------------------------------------------------------------ persistence */
  // Sandboxed iframes have an opaque origin: touching localStorage is a
  // SecurityError, not a silent no-op. Keep the fleet in memory and try a save
  // only where storage actually exists (running the file directly, for dev).
  function trySave() {
    try { localStorage.setItem('iron-tide-fleet', JSON.stringify(fleet)); } catch { /* in-memory only */ }
  }
  function tryLoad() {
    try {
      const raw = localStorage.getItem('iron-tide-fleet');
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') Object.assign(fleet, saved);
    } catch { /* first run, or sandboxed */ }
  }

  /* ------------------------------------------------------------------ dock */

  function loadout() {
    return R.computeLoadout({ hull: fleet.hull, modules: fleet.modules });
  }

  function paintWallet() {
    $('credits').textContent = String(fleet.credits);
  }

  function optionRow({ icon, name, blurb, price, on, locked, onClick, free }) {
    const el = document.createElement('div');
    el.className = `opt${on ? ' on' : ''}${locked ? ' locked' : ''}`;
    el.innerHTML = `<span class="ico">${icon}</span>
      <span class="grow"><b>${name}</b><em>${blurb}</em></span>
      <span class="price${free ? ' free' : ''}">${price}</span>`;
    if (onClick) el.addEventListener('click', onClick);
    return el;
  }

  function renderDock() {
    const body = $('tabBody');
    body.innerHTML = '';
    $('tabTitle').textContent = 'YOUR FLAGSHIP';
    const here = R.byId(R.HULLS, fleet.hull);

    const hullCard = document.createElement('div');
    hullCard.className = 'card';
    hullCard.style.background = 'transparent';
    hullCard.style.border = '0';
    hullCard.style.padding = '0';
    hullCard.innerHTML = `<p class="hint">FLAGSHIP · <b style="color:#cfeaff">${here.name}</b> — ${here.blurb}</p>`;
    body.appendChild(hullCard);

    for (const hull of R.HULLS) {
      const owned = fleet.hulls.includes(hull.id);
      body.appendChild(optionRow({
        icon: hull.id === 'carrier' ? '🛳' : hull.id === 'destroyer' ? '🚢' : '⛴',
        name: hull.name,
        blurb: `${hull.hp} HULL · ${hull.slots} SLOTS · ${hull.turrets} TURRETS · SPEED ${hull.speed}`,
        price: owned ? (fleet.hull === hull.id ? 'IN SERVICE' : 'OWNED') : `${hull.cost}`,
        free: owned,
        on: fleet.hull === hull.id,
        locked: !owned && fleet.credits < hull.cost,
        onClick: () => {
          if (owned) { fleet.hull = hull.id; fleet.modules = fleet.modules.slice(0, hull.slots); }
          else {
            const res = R.buy(hull.id, 'hull', fleet.credits, fleet);
            if (!res.ok) return flash($('loadoutHint'), res.reason);
            fleet.credits = res.credits;
            fleet.hulls.push(hull.id);
            fleet.hull = hull.id;
            fleet.modules = fleet.modules.slice(0, hull.slots);
            beep(520, 0.09, 0.06);
          }
          trySave(); paintWallet(); renderAll();
        },
      }));
    }

    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = fleet.hulls.length > 1
      ? 'Switch hulls for free — the modules that no longer fit go back to storage.'
      : 'Buy a bigger hull to carry more weapons. Everything you own stays in the dock.';
    body.appendChild(note);
  }

  function renderBuild() {
    const body = $('tabBody');
    body.innerHTML = '';
    $('tabTitle').textContent = 'FIT OUT THE SHIP';
    const hull = R.byId(R.HULLS, fleet.hull);
    const used = fleet.modules.length;

    const head = document.createElement('p');
    head.className = 'hint';
    head.innerHTML = `SLOTS USED <b style="color:#cfeaff">${used}/${hull.slots}</b> · ` +
      `every module is bought once and can be refitted for free.`;
    body.appendChild(head);

    for (const mod of R.MODULES) {
      const count = fleet.modules.filter((id) => id === mod.id).length;
      const full = used >= hull.slots;
      body.appendChild(optionRow({
        icon: mod.kind === 'gun' ? '🔫' : mod.kind === 'torpedo' ? '🚀' : mod.kind === 'aa' ? '✳' : mod.kind === 'armour' ? '🛡' : '⚙',
        name: `${mod.name}${count ? ` ×${count}` : ''}`,
        blurb: mod.blurb,
        price: `${mod.cost}`,
        locked: full || fleet.credits < mod.cost,
        on: count > 0,
        onClick: () => {
          if (full) return flash($('loadoutHint'), 'NO FREE SLOTS — DROP SOMETHING FIRST');
          const res = R.buy(mod.id, 'module', fleet.credits, fleet);
          if (!res.ok) return flash($('loadoutHint'), res.reason);
          fleet.credits = res.credits;
          fleet.modules.push(mod.id);
          beep(640, 0.07, 0.05);
          trySave(); paintWallet(); renderAll();
        },
      }));
    }

    if (used) {
      const drop = document.createElement('button');
      drop.className = 'ghost';
      drop.type = 'button';
      drop.textContent = 'REMOVE LAST MODULE';
      drop.addEventListener('click', () => {
        fleet.modules.pop();
        trySave(); renderAll();
      });
      body.appendChild(drop);
    }
  }

  function renderHangar() {
    const body = $('tabBody');
    body.innerHTML = '';
    $('tabTitle').textContent = 'HANGAR';
    const hull = R.byId(R.HULLS, fleet.hull);
    const cap = hull.id === 'carrier' ? 3 : 1;

    const head = document.createElement('p');
    head.className = 'hint';
    head.innerHTML = `${hull.id === 'carrier'
      ? 'A CARRIER can sortie <b style="color:#6dffa8">3 jets</b> at once.'
      : `Only a CARRIER launches a full wing — this hull sorties <b style="color:#ffd578">1</b> jet at a time.`}
      Jets are bought here and fly in every battle.`;
    body.appendChild(head);

    for (const jet of R.JETS) {
      const owned = fleet.jets.includes(jet.id);
      const active = fleet.jets.indexOf(jet.id) < cap;
      body.appendChild(optionRow({
        icon: '✈',
        name: `${jet.name}${owned ? ` (${fleet.jets.filter((j) => j === jet.id).length})` : ''}`,
        blurb: `${jet.dmg} DMG · ${jet.cooldown}s COOLDOWN · ${jet.blurb}`,
        price: owned ? 'OWNED' : `${jet.cost}`,
        free: owned,
        on: owned && active,
        locked: !owned && fleet.credits < jet.cost,
        onClick: () => {
          if (owned) {
            // clicking an owned jet bumps it to the front of the launch order
            const i = fleet.jets.indexOf(jet.id);
            if (i > 0) { fleet.jets.splice(i, 1); fleet.jets.unshift(jet.id); }
            return renderAll();
          }
          const res = R.buy(jet.id, 'jet', fleet.credits, fleet);
          if (!res.ok) return flash($('loadoutHint'), res.reason);
          fleet.credits = res.credits;
          fleet.jets.push(jet.id);
          beep(880, 0.1, 0.06);
          trySave(); paintWallet(); renderAll();
        },
      }));
    }
    if (fleet.jets.length > cap) {
      const note = document.createElement('p');
      note.className = 'hint warn';
      note.textContent = `You own ${fleet.jets.length} jets but this hull launches ${cap}. Tap to reorder.`;
      body.appendChild(note);
    }
  }

  function renderAll() {
    if (screen !== 'dock') return;
    if (tab === 'dock') renderDock();
    else if (tab === 'build') renderBuild();
    else renderHangar();

    const lo = loadout();
    $('loadoutStats').innerHTML = `
      <div class="stat"><span>HULL</span><b>${lo.hp}</b></div>
      <div class="stat"><span>DPS</span><b>${lo.dps}</b></div>
      <div class="stat"><span>SPEED</span><b>${lo.speed}</b></div>
      <div class="stat"><span>TURRETS</span><b>${lo.turrets}</b></div>
      <div class="stat"><span>JETS</span><b>${Math.min(fleet.jets.length, R.byId(R.HULLS, fleet.hull).id === 'carrier' ? 3 : 1)}</b></div>
      <div class="stat"><span>SORTIES</span><b>${fleet.sorties}</b></div>`;
    $('loadoutHint').textContent = lo.dps
      ? `${lo.guns} gun${lo.guns === 1 ? '' : 's'} · ${lo.torpedoes} torpedo · ${lo.flak} flak · range ${lo.range}m`
      : 'No weapons fitted — fit at least one gun before sailing.';
    $('sortieBtn').disabled = lo.dps <= 0;
    $('sortieHint').textContent = fleet.sorties
      ? `Sortie ${fleet.sorties + 1} · enemy strength rising · best score ${fleet.best}`
      : 'Clear the enemy fleet to earn credits and repairs.';
  }

  function flash(el, text) {
    if (!el) return;
    const prev = el.textContent;
    el.textContent = String(text).toUpperCase();
    el.classList.add('warn');
    setTimeout(() => { el.textContent = prev; el.classList.remove('warn'); }, 1600);
  }

  /* ---------------------------------------------------------------- battle */

  function startBattle() {
    const lo = loadout();
    if (!lo.dps) return flash($('loadoutHint'), 'FIT A WEAPON FIRST');
    const hull = R.byId(R.HULLS, fleet.hull);
    const cap = hull.id === 'carrier' ? 3 : 1;
    // the sea gets heavier as the war goes on: calm, moderate, rough, then storm
    const seaState = W.seaForSortie(fleet.sorties + 1);
    const sea = W.createSea({ state: seaState, seed: 1000 + (fleet.sorties + 1) * 37 });
    const body = W.createBody({
      x: 0, y: 0, heading: -Math.PI / 2,
      length: hull.length, speed: lo.speed,
    });
    session = {
      lo,
      cap,
      length: hull.length,
      // the sea has places in it: seven islands, seeded per sortie, so the
      // fight has a shape and somewhere to run to
      islands: buildIslands(1000 + (fleet.sorties + 1) * 37),
      t: 0,
      hull: lo.hp,
      maxHull: lo.hp,
      speed: lo.speed * 60,
      turn: 0.9 + lo.speed * 0.25,
      range: lo.range || 260,
      yaw: -Math.PI / 2,
      x: 0, y: 0,
      vel: { x: 0, y: 0 },
      sea,
      body,
      wake: [],
      spray: [],
      splash: [],
      out: {},
      slamT: 0,
      fireCd: 0,
      ships: [],
      bullets: [],
      enemyBullets: [],
      jets: [],
      jetCd: {},
      kills: 0,
      shots: 0,
      keys: {},
      aim: null,
      joy: { active: false, x: 0, y: 0, ox: 0, oy: 0 },
      over: false,
      survived: false,
      hullLost: false,
      banner: 0,
      bannerText: '',
    };
    initGL();
    use3D(Boolean(glReady));
    const enemies = R.enemyFleet(fleet.sorties + 1);
    enemies.forEach((e, i) => {
      const a = (i / enemies.length) * Math.PI * 2;
      const d = 620 + i * 60;
      const x = Math.cos(a) * d;
      const y = Math.sin(a) * d;
      const yaw = a + Math.PI;
      const enemyHull = R.byId(R.HULLS, e.hull) || R.HULLS[0];
      session.ships.push({
        ...e, maxHp: e.hp, x, y,
        yaw, fireCd: 1 + Math.random(), dead: false, aggro: 0,
        // enemies float on the same water: same model, their own hull
        body: W.createBody({ x, y, heading: yaw, length: enemyHull.length, speed: e.speed }),
        wake: 0,
      });
    });
    for (const jetId of fleet.jets.slice(0, cap)) session.jetCd[jetId] = 2;

    screen = 'battle';
    $('dock').classList.add('hidden');
    $('battleHud').classList.remove('hidden');
    $('result').classList.add('hidden');
    paintJetChips();
    session.seaChip = $('seaChip');
    showBanner('SORTIE ' + (fleet.sorties + 1) + ' · ' + sea.preset.name + ' SEA', 1.9);
    beep(180, 0.3, 0.08);
  }

  function paintJetChips() {
    const host = $('jetChips');
    host.innerHTML = '';
    const jets = fleet.jets.slice(0, session.cap);
    if (!jets.length) {
      host.innerHTML = '<span class="jet-chip">NO JETS — BUY ONE AT THE DOCK</span>';
      return;
    }
    for (const id of jets) {
      const jet = R.byId(R.JETS, id);
      const el = document.createElement('button');
      el.className = 'jet-chip';
      el.type = 'button';
      el.dataset.jet = id;
      el.textContent = `${jet.name} · ${Math.max(0, Math.ceil(session.jetCd[id] || 0))}s`;
      el.addEventListener('click', () => launchJet(id));
      host.appendChild(el);
    }
  }

  function showBanner(text, seconds) {
    if (!session) return;
    session.banner = seconds;
    session.bannerText = text;
    const el = $('banner');
    el.textContent = text;
    el.classList.add('show');
  }

  function launchJet(id) {
    if (!session || screen !== 'battle' || session.over) return;
    if ((session.jetCd[id] || 0) > 0) return flash($('banner'), 'JET REARMING');
    const jet = R.byId(R.JETS, id);
    session.jetCd[id] = jet.cooldown;
    const target = session.ships.find((s) => !s.dead);
    if (!target) return;
    session.jets.push({
      id, x: session.x, y: session.y, t: 0, dmg: jet.dmg,
      tx: target.x, ty: target.y, target, dead: false,
    });
    showBanner(`${jet.name} LAUNCHED`, 1.1);
    beep(920, 0.16, 0.05);
  }

  /**
   * Soft aim assist. The guns fire along the bow, and enemies circle, so on a
   * phone stick a broadside that *almost* lines up would always miss. If the
   * nearest ship is already within ±0.55 rad of the bow, the shot is nudged onto
   * it (and the target gets a lock bracket). Pointed the wrong way, no help.
   */
  function aimYaw() {
    const s = session;
    let best = null, bestD = Infinity;
    for (const e of s.ships) {
      if (e.dead) continue;
      const d = Math.hypot(e.x - s.x, e.y - s.y);
      if (d < bestD) { bestD = d; best = e; }
    }
    if (!best) { s.lock = null; return s.yaw; }
    // lead a circling ship: two passes of "where will it be when the shell lands"
    let px = best.x, py = best.y;
    for (let i = 0; i < 2; i++) {
      const t = Math.hypot(px - s.x, py - s.y) / 620;
      px = best.x + (best.vx || 0) * t;
      py = best.y + (best.vy || 0) * t;
    }
    const want = Math.atan2(py - s.y, px - s.x);
    let diff = want - s.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    // wider help at knife range, where a circling hull is hardest to track by eye
    const cone = bestD < 140 ? 0.95 : 0.55;
    if (Math.abs(diff) > cone) { s.lock = null; return s.yaw; }
    s.lock = best;
    s.lockT = 0.35;
    return s.yaw + diff * 0.85;
  }

  function fire() {
    if (!session || session.over) return;
    const s = session;
    if (s.fireCd > 0) return;
    if (!s.lo.turrets || !s.lo.dps) return;      // no guns fitted: nothing to fire
    s.fireCd = s.lo.reload || 0.45;
    s.shots += 1;
    const turrets = s.lo.turrets;
    const spread = 0.06;
    const aim = aimYaw();
    for (let i = 0; i < turrets; i++) {
      const off = (i - (turrets - 1) / 2) * 10;
      const a = aim + (Math.random() - 0.5) * spread;
      const px = s.x + Math.cos(s.yaw) * 14 - Math.sin(s.yaw) * off;
      const py = s.y + Math.sin(s.yaw) * 14 + Math.cos(s.yaw) * off;
      s.bullets.push({
        x: px, y: py, vx: Math.cos(a) * 620, vy: Math.sin(a) * 620,
        dmg: s.lo.shot || 0, life: 1.5,
      });
    }
    beep(420, 0.05, 0.04);
  }

  function updateBattle(dt) {
    const s = session;
    if (!s || s.over) return;
    s.t += dt;
    s.fireCd = Math.max(0, s.fireCd - dt);
    s.banner = Math.max(0, s.banner - dt);
    s.lockT = Math.max(0, (s.lockT || 0) - dt);
    if (s.lockT === 0) s.lock = null;
    if (s.banner <= 0) $('banner').classList.remove('show');

    /* ---------------------------------------------------------- the sea */
    // One clock for the whole battle: the player, every enemy and the wake all
    // ride the same wave field, so a crest that lifts you lifts them too.
    s.sea.step(dt);

    /* ------------------------------------------------------ the player */
    // Rudder and throttle come straight from the keys or the virtual stick.
    // `s.autopilot` is set by the debug handle's steerTo() — the host test suite
    // uses it to put the bow on a target without faking the physics
    const rudder = Math.max(-1, Math.min(1,
      (s.keys.right ? 1 : 0) - (s.keys.left ? 1 : 0) + (s.joy.active ? s.joy.x : 0) + (s.autopilot || 0)));
    const throttle = Math.max(-1, Math.min(1,
      (s.keys.up ? 1 : 0) - (s.keys.down ? 0.6 : 0) - (s.joy.active ? s.joy.y : 0)));
    const out = s.out || (s.out = {});
    W.stepBody(s.body, s.sea, dt, { throttle, rudder }, out);

    // the rest of the game still thinks in x/y/yaw — keep that one source
    s.x = s.body.x;
    s.y = s.body.y;
    s.yaw = s.body.heading;
    s.vel = W.velocityOf(s.body);
    s.knots = W.knots(s.body.u);
    pushOffIslands(s);

    // slamming through a crest in a heavy sea damages the hull (slowly) and
    // throws spray; the toast is throttled so it never spams
    if (out.damage) {
      s.hull -= out.damage;
      if (s.slamT <= 0) {
        s.slamT = 2.6;
        showBanner('SLAMMING — EASE OFF', 0.7);
      }
    }
    s.slamT = Math.max(0, (s.slamT || 0) - dt);
    if (out.spray > 0.25) {
      emitSpray(s, s.body, out.spray);
    }
    if (out.wakeEmit > 0) emitWake(s, s.body, out.wakeEmit);

    const arena = 2400;
    const clampedX = Math.max(-arena, Math.min(arena, s.body.x));
    const clampedY = Math.max(-arena, Math.min(arena, s.body.y));
    if (clampedX !== s.body.x || clampedY !== s.body.y) {
      // the edge of the arena is a shoal: bounce off, losing way
      s.body.x = clampedX;
      s.body.y = clampedY;
      s.body.u *= 0.5;
      s.body.v *= 0.5;
    }
    s.x = s.body.x;
    s.y = s.body.y;

    // wake and spray live in the world, not on the ship: they stay where they
    // were made and fade, which is what makes a turn readable
    stepEffects(s, dt);

    if (s.keys.fire) fire();

    // enemy movement + shooting — every raider is a floating body too, so they
    // heel into the swell, trail wakes and have to steer instead of strafing
    for (const e of s.ships) {
      if (e.dead) continue;
      const dx = s.x - e.x, dy = s.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.aggro += dt;
      const px = e.x, py = e.y;
      const standoff = Math.max(120, e.range * 0.55);

      // what heading do they want? close, back off, or circle
      let want = Math.atan2(dy, dx);
      let push = 1;
      if (d > e.range * 0.9) {
        want = Math.atan2(dy, dx);                       // close the distance
      } else if (d < standoff) {
        want = Math.atan2(-dy, -dx);                     // back off, keep the range
      } else {
        want = Math.atan2(dy, dx) + Math.PI / 2;         // circle, don't ram
        push = 0.7;
      }
      let diff = want - e.body.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      // a hull cannot turn on the spot, so sometimes it has to come round
      const eRudder = Math.max(-1, Math.min(1, diff * 2.2));
      const eThrottle = Math.max(0, Math.min(1, push * (0.55 + Math.abs(Math.cos(diff)) * 0.45)));
      W.stepBody(e.body, s.sea, dt, { throttle: eThrottle, rudder: eRudder }, e.eout || (e.eout = {}));
      e.x = e.body.x;
      e.y = e.body.y;
      e.yaw = e.body.heading;
      e.vx = (e.x - px) / dt;
      e.vy = (e.y - py) / dt;
      e.wake = e.body.wake;
      if (e.eout.wakeEmit > 0) emitWake(s, e.body, e.eout.wakeEmit * 0.8, '#7fb6d6');

      e.fireCd -= dt;
      if (e.fireCd <= 0 && d < e.range + 90) {
        e.fireCd = 2.2 + Math.random() * 1.2;
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.2;
        s.enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, dmg: e.dmg, life: 2.4 });
      }
    }

    // shells — a miss that reaches the water throws a splash, which is how you
    // read your own fall of shot
    for (const b of s.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      let hit = false;
      for (const e of s.ships) {
        if (e.dead) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) < 26) {
          e.hp -= b.dmg;
          b.life = 0;
          hit = true;
          burst(e.x, e.y, '#ffb347', 18);
          beep(300, 0.04, 0.03);
          if (e.hp <= 0) {
            e.dead = true;
            s.kills += 1;
            burst(e.x, e.y, '#ffb347', 26);
            emitSplash(s, e.x, e.y, 2.2);
            showBanner(`${e.name} SUNK`, 1.0);
            beep(140, 0.22, 0.09);
          }
          break;
        }
      }
      if (!hit && b.life <= 0) emitSplash(s, b.x, b.y, 0.8);
    }
    s.bullets = s.bullets.filter((b) => b.life > 0);

    for (const b of s.enemyBullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      // flak intercepts incoming fire near the ship
      if (s.lo.flak && Math.hypot(b.x - s.x, b.y - s.y) < 78 && Math.random() < 0.5) { b.life = 0; emitSplash(s, b.x, b.y, 0.5); continue; }
      if (Math.hypot(b.x - s.x, b.y - s.y) < 22) {
        s.hull -= b.dmg;
        b.life = 0;
        burst(s.x, s.y, '#ff6d7b', 6);
        if (s.hull <= 0) endBattle(false);
      } else if (b.life <= 0) {
        emitSplash(s, b.x, b.y, 0.7);
      }
    }
    s.enemyBullets = s.enemyBullets.filter((b) => b.life > 0);

    // jets
    for (const j of s.jets) {
      j.t += dt;
      const dx = j.target.x - j.x, dy = j.target.y - j.y;
      const d = Math.hypot(dx, dy) || 1;
      j.x += (dx / d) * 520 * dt;
      j.y += (dy / d) * 520 * dt;
      j.yaw = Math.atan2(dy, dx);
      if (d < 32) {
        j.dead = true;
        if (!j.target.dead) {
          j.target.hp -= j.dmg;
          burst(j.target.x, j.target.y, '#59c9ff', 14);
          if (j.target.hp <= 0 && !j.target.dead) {
            j.target.dead = true;
            s.kills += 1;
            showBanner(`${j.target.name} SUNK BY AIR`, 1.0);
          }
        }
      }
    }
    s.jets = s.jets.filter((j) => !j.dead);

    for (const id of Object.keys(s.jetCd)) s.jetCd[id] = Math.max(0, s.jetCd[id] - dt);
    paintJetChips();

    // win / lose checks
    const alive = s.ships.filter((e) => !e.dead);
    if (s.hull <= 0) endBattle(false);
    else if (!alive.length) endBattle(true);

    $('hullBar').style.width = `${Math.max(0, (s.hull / s.maxHull) * 100)}%`;
    if (s.seaChip) {
      const kt = Math.round(W.knots(s.body.u));
      const heel = Math.round(s.body.roll * 57);
      s.seaChip.textContent = `${s.sea.preset.name} SEA · ${kt} KN · ${heel}° HEEL`;
      s.seaChip.classList.toggle('heavy', s.sea.severity >= 0.5);
    }
    const totalHp = s.ships.reduce((sum, e) => sum + Math.max(0, e.hp), 0);
    const startHp = s.ships.reduce((sum, e) => sum + e.maxHp, 0);
    $('enemyBar').style.width = `${Math.max(0, (totalHp / startHp) * 100)}%`;
    $('fireBtn').classList.toggle('ready', s.fireCd <= 0);
  }

  /* --------------------------------------------------------------- water FX */

  /**
   * A wake is emitted *behind* the hull, in the water's frame, with the ship's
   * own sideways velocity baked in. That is why a hard turn leaves a curved
   * scar instead of a straight line.
   */
  function emitWake(s, body, amount, colour) {
    const c = Math.cos(body.heading);
    const sn = Math.sin(body.heading);
    const stern = -body.spec.length * 0.5;
    const n = Math.min(4, Math.floor(amount) + (Math.random() < (amount % 1) ? 1 : 0));
    for (let i = 0; i < n; i++) {
      const side = (Math.random() - 0.5) * body.spec.beam * 1.2;
      const x = body.x + c * stern - sn * side;
      const y = body.y + sn * stern + c * side;
      const v = Math.hypot(body.u, body.v);
      const spread = 0.5 + Math.random() * 0.7;
      s.wake.push({
        x, y,
        vx: (-c * v * 0.10) + (Math.random() - 0.5) * spread,
        vy: (-sn * v * 0.10) + (Math.random() - 0.5) * spread,
        life: 1,
        decay: 0.22 + Math.random() * 0.18,
        r: 1.4 + Math.random() * 2.6 * (1 + body.wake * 0.5),
        colour: colour || '#cfeeff',
      });
    }
    if (s.wake.length > 700) s.wake.splice(0, s.wake.length - 700);
  }

  /** Bow spray: thrown forward and up when the hull slams through a crest. */
  function emitSpray(s, body, strength) {
    const c = Math.cos(body.heading);
    const sn = Math.sin(body.heading);
    const bow = body.spec.length * 0.42;
    const v = Math.hypot(body.u, body.v);
    const n = Math.min(10, 2 + Math.round(strength * 8));
    for (let i = 0; i < n; i++) {
      const side = (Math.random() - 0.5) * body.spec.beam * 1.4;
      const a = body.heading + (Math.random() - 0.5) * 1.2;
      s.spray.push({
        x: body.x + c * bow - sn * side,
        y: body.y + sn * bow + c * side,
        vx: Math.cos(a) * (20 + Math.random() * 55) + Math.cos(body.heading) * v * 0.25,
        vy: Math.sin(a) * (20 + Math.random() * 55) + Math.sin(body.heading) * v * 0.25,
        life: 1,
        decay: 0.9 + Math.random() * 0.8,
        r: 1.2 + Math.random() * 2,
      });
    }
    if (s.spray.length > 320) s.spray.splice(0, s.spray.length - 320);
  }

  /** A shell that misses and hits the sea leaves a splash ring. */
  function emitSplash(s, x, y, size = 1) {
    s.splash.push({ x, y, r: 3 * size, max: 26 * size, life: 1, decay: 1.5 });
    if (s.splash.length > 60) s.splash.splice(0, s.splash.length - 60);
  }

  /** Advance wake / spray / splash; they are pure decoration, so they simply fade. */
  function stepEffects(s, dt) {
    const drag = Math.pow(0.55, dt);
    for (const w of s.wake) {
      w.x += w.vx * dt;
      w.y += w.vy * dt;
      w.vx *= drag;
      w.vy *= drag;
      w.life -= w.decay * dt;
      w.r += dt * 1.6;
    }
    if (s.wake.length) s.wake = s.wake.filter((w) => w.life > 0);
    for (const p of s.spray) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.life -= p.decay * dt;
    }
    if (s.spray.length) s.spray = s.spray.filter((p) => p.life > 0);
    for (const sp of s.splash) {
      sp.r += (sp.max - sp.r) * Math.min(1, dt * 6);
      sp.life -= sp.decay * dt;
    }
    if (s.splash.length) s.splash = s.splash.filter((sp) => sp.life > 0);
    for (const p of s.particles || []) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.life -= dt;
    }
    if (s.particles) s.particles = s.particles.filter((p) => p.life > 0);
  }

  function burst(x, y, colour, n) {
    if (!session) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 260;
      session.particles = session.particles || [];
      session.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, colour });
    }
  }

  function endBattle(survived) {
    const s = session;
    if (!s || s.over) return;
    s.over = true;
    s.survived = survived;
    s.hullLost = !survived;
    const reward = R.battleReward({ kills: s.kills, survived, sortie: fleet.sorties + 1, hullLost: !survived });

    fleet.credits += reward.credits;
    fleet.sorties += 1;
    fleet.kills += s.kills;
    fleet.best = Math.max(fleet.best, reward.score);
    trySave();

    screen = 'result';
    $('battleHud').classList.add('hidden');
    $('result').classList.remove('hidden');
    $('resultTitle').textContent = survived ? 'SORTIE CLEARED' : 'FLEET LOST';
    $('resultText').innerHTML = `${R.verdict({ survived, kills: s.kills, hullLost: !survived })}<br />` +
      `${s.kills} SHIP${s.kills === 1 ? '' : 'S'} SUNK · ${s.shots} BROADSIDES FIRED`;
    $('resultTake').textContent = `+${reward.credits} CREDITS · SCORE ${reward.score}`;

    sdk.score({
      score: reward.score,
      day: fleet.sorties,
      seconds: Math.round(s.t),
      won: survived,
      meta: `${s.kills} kills · ${R.byId(R.HULLS, fleet.hull).name}`,
    });
    beep(survived ? 700 : 120, 0.4, 0.09);
  }

  function backToDock() {
    use3D(false);
    session = null;
    screen = 'dock';
    $('result').classList.add('hidden');
    $('battleHud').classList.add('hidden');
    $('dock').classList.remove('hidden');
    paintWallet();
    renderAll();
  }

  /* ----------------------------------------------------------------- input */

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (screen === 'battle' && session) {
      if (k === 'arrowleft' || k === 'a') session.keys.left = true;
      if (k === 'arrowright' || k === 'd') session.keys.right = true;
      if (k === 'arrowup' || k === 'w') session.keys.up = true;
      if (k === 'arrowdown' || k === 's') session.keys.down = true;
      if (k === ' ' || k === 'enter') { e.preventDefault(); session.keys.fire = true; }
      if (k === '1' || k === '2' || k === '3') {
        const id = fleet.jets.slice(0, session.cap)[Number(k) - 1];
        if (id) launchJet(id);
      }
      if (k === 'escape') endBattle(false);
    }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', ' '].includes(k)) e.preventDefault();
  });
  addEventListener('keyup', (e) => {
    if (!session) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowleft' || k === 'a') session.keys.left = false;
    if (k === 'arrowright' || k === 'd') session.keys.right = false;
    if (k === 'arrowup' || k === 'w') session.keys.up = false;
    if (k === 'arrowdown' || k === 's') session.keys.down = false;
    if (k === ' ' || k === 'enter') session.keys.fire = false;
  });

  // touch: left half = virtual stick, right half = fire
  function pointerStart(e) {
    if (screen !== 'battle' || !session) return;
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const x = p.clientX - r.left;
    if (x < r.width * 0.45) {
      session.joy.active = true;
      session.joy.ox = x; session.joy.oy = p.clientY - r.top;
      session.joy.x = 0; session.joy.y = 0;
    } else {
      fire();
    }
  }
  function pointerMove(e) {
    if (screen !== 'battle' || !session || !session.joy.active) return;
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const dx = (p.clientX - r.left) - session.joy.ox;
    const dy = (p.clientY - r.top) - session.joy.oy;
    const m = Math.min(1, Math.hypot(dx, dy) / 46) || 0;
    const a = Math.atan2(dy, dx);
    session.joy.x = Math.cos(a) * m;
    session.joy.y = Math.sin(a) * m;
  }
  function pointerEnd() {
    if (!session) return;
    session.joy.active = false;
    session.joy.x = 0; session.joy.y = 0;
  }
  canvas.addEventListener('mousedown', pointerStart);
  canvas.addEventListener('mousemove', (e) => { if (e.buttons) pointerMove(e); });
  addEventListener('mouseup', pointerEnd);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); pointerStart(e); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); pointerMove(e); }, { passive: false });
  canvas.addEventListener('touchend', pointerEnd);
  $('fireBtn').addEventListener('click', fire);
  $('leaveBtn').addEventListener('click', () => endBattle(false));
  $('sortieBtn').addEventListener('click', startBattle);
  $('resultBtn').addEventListener('click', backToDock);

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
      renderAll();
    });
  });

  /* ------------------------------------------------------------------ draw */

  function drawDockScene() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#071019');
    g.addColorStop(0.55, '#0a1a26');
    g.addColorStop(1, '#04121b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // the dock sits on the same water the battle does: a slow swell sampled
    // from the wave field, so the two screens agree about the sea
    if (!dockSea) dockSea = W.createSea({ state: 'moderate', seed: 21 });
    dockSea.step(1 / 60);
    const horizon = h * 0.52;
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const y = horizon + i * 18;
      const depth = 1 - i / 8;                       // far rows are flatter
      ctx.strokeStyle = `rgba(89,201,255,${(0.05 + depth * 0.09).toFixed(3)})`;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 18) {
        const sample = dockSea.at(x * 0.5, y * 0.9 + i * 40);
        const yy = y + sample.h * 3.4 * depth + Math.sin(x / 90 + i) * 1.6;
        x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // the flagship silhouette, bobbing on that same swell
    const hull = R.byId(R.HULLS, fleet.hull);
    const scale = 1 + hull.length / 160;
    const bob = dockSea.height(performance.now() / 240, 40) * 2.2;
    const heel = dockSea.at(performance.now() / 240, 40).gx * 0.12;
    ctx.save();
    ctx.translate(w * 0.82, h * 0.7 + bob);
    ctx.rotate(Math.sin(performance.now() / 2600) * 0.01 + heel * 0.5);
    ctx.scale(scale, scale);
    // reflection
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#0a2231';
    ctx.beginPath();
    ctx.moveTo(-60, 18); ctx.lineTo(46, 18); ctx.lineTo(62, 34); ctx.lineTo(-52, 34); ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#12303f';
    ctx.beginPath();
    ctx.moveTo(-60, 0); ctx.lineTo(46, 0); ctx.lineTo(62, 14); ctx.lineTo(-52, 14); ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#1b4a60';
    ctx.fillRect(-26, -12, 40, 12);
    ctx.fillStyle = '#59c9ff';
    ctx.fillRect(-6, -26, 6, 14);
    ctx.restore();
  }

  /* ==================================================================== 3D
   * The same simulation, looked at from behind the stern instead of from an
   * aeroplane. `sea3d.js` does the drawing; this section decides *what* is in
   * the world and how the water that `water.js` is simulating looks.
   */
  const PALETTES = {
    calm: {
      zenith: [0.05, 0.12, 0.22], horizon: [0.16, 0.28, 0.36],
      fog: [0.12, 0.20, 0.26], foam: 0.55,
    },
    moderate: {
      zenith: [0.04, 0.10, 0.19], horizon: [0.13, 0.22, 0.29],
      fog: [0.10, 0.17, 0.22], foam: 0.7,
    },
    rough: {
      zenith: [0.03, 0.07, 0.13], horizon: [0.10, 0.16, 0.20],
      fog: [0.08, 0.13, 0.17], foam: 0.85,
    },
    storm: {
      zenith: [0.03, 0.05, 0.09], horizon: [0.09, 0.12, 0.15],
      fog: [0.07, 0.10, 0.13], foam: 1,
    },
  };
  const paletteFor = (sea) => PALETTES[(sea && sea.state) || 'moderate'] || PALETTES.moderate;

  /** Ask for a renderer once. A device that says no keeps the 2D view. */
  function initGL() {
    if (gl || glBroken) return glReady;
    if (!SEA || !glCanvas) return false;
    try { gl = SEA.create(glCanvas); } catch { gl = null; }
    if (!gl) {
      glBroken = true;
      glReady = false;
      sea3dNote = 'no WebGL on this device — the chart view carries the battle';
      use3D(false);
      return false;
    }
    glReady = true;
    sea3dNote = '';
    use3D(true);
    return true;
  }

  /** Show exactly one renderer. `#c` is the overlay either way. */
  function use3D(on) {
    try {
      if (glCanvas && glCanvas.style) glCanvas.style.display = on ? 'block' : 'none';
    } catch { /* detached DOM */ }
    const tag = $('renderTag');
    if (tag) tag.textContent = on && gl ? `3D · ${(gl.tris / 1000).toFixed(0)}K TRIS` : 'CHART VIEW';
  }

  /** Is the battle being drawn in 3D this frame? */
  const live3D = () => Boolean(glReady && !glBroken && gl && screen === 'battle' && session && !session.over);

  /** The chase camera: low behind the stern, aimed down the bow. */
  function camera3D(s) {
    const b = s.body || {};
    const heading = b.heading ?? s.yaw ?? 0;
    const speed = Math.min(1, Math.abs(b.u || 0) / 60);
    const back = 74 + s.length * 0.55 + speed * 26;
    const lift = 27 + speed * 7 + (s.sea ? s.sea.severity * 5 : 0);
    const ex = s.x - Math.cos(heading) * back;
    const ez = s.y - Math.sin(heading) * back;
    const ax = s.x + Math.cos(heading) * 90;
    const az = s.y + Math.sin(heading) * 90;
    return {
      eye: [ex, (b.heave || 0) + lift, ez],
      at: [ax, (b.heave || 0) + lift * 0.22, az],
      fov: 54 + speed * 6,
    };
  }

  /** The wing of the world: islands, so the sea has places in it. */
  function buildIslands(seed) {
    const rand = (() => {
      let a = (seed | 0) || 1;
      return () => {
        a = (a * 1103515245 + 12345) & 0x7fffffff;
        return a / 0x7fffffff;
      };
    })();
    const out = [];
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2;
      const d = 900 + rand() * 1500;
      const r = 90 + rand() * 190;
      out.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r, h: r * (0.28 + rand() * 0.3) });
    }
    return out;
  }

  /**
   * An island is solid: sail into one and the hull stops, because an open world
   * you can drive through is a backdrop, not a world. Cheap, and it gives the
   * sea a shape to fight around.
   */
  function pushOffIslands(s) {
    for (const isle of s.islands || []) {
      const dx = s.x - isle.x;
      const dy = s.y - isle.y;
      const d = Math.hypot(dx, dy);
      const keep = isle.r * 0.72 + 26;
      if (d < keep && d > 0.001) {
        s.x = isle.x + (dx / d) * keep;
        s.y = isle.y + (dy / d) * keep;
        if (s.body) {
          s.body.x = s.x;
          s.body.y = s.y;
          s.body.u *= 0.35;
        }
        if (s.hull > 0 && !s.aground) {
          s.aground = 0.8;
          s.hull -= 4;
          showBanner('AGROUND — BACK OFF', 1.1);
        }
      }
    }
    s.aground = Math.max(0, (s.aground || 0) - 1 / 60);
  }

  /** Draw the battle in 3D. Returns false if the frame failed (the 2D view takes over). */
  function draw3D(w, h, dpr) {
    const s = session;
    const pal = paletteFor(s.sea);
    try {
      gl.begin(w, h, dpr);
      const cam = camera3D(s);
      gl.camera(cam.eye[0], cam.eye[1], cam.eye[2], cam.at[0], cam.at[1], cam.at[2], cam.fov);
      gl.sky(pal.zenith, pal.horizon, pal.fog);
      gl.sea(s.sea, s.x, s.y);

      // islands first: they are the far things, and the fog hides their bases
      for (const isle of s.islands || []) {
        const far = Math.hypot(isle.x - s.x, isle.y - s.y);
        if (far > 3200) continue;
        gl.body('island', isle.x, -isle.h * 0.05, isle.y, 0, 1, [1, 1, 1],
          { sx: isle.r, sy: isle.h, sz: isle.r });
      }

      // enemy hulls, heeled and trimmed by the same water field as ours
      for (const e of s.ships) {
        if (e.dead) continue;
        const body = e.body || {};
        const len = body.spec?.length || 48;
        gl.body(e.carrier ? 'carrier' : 'ship',
          e.x, (body.heave || 0) - len * 0.03, e.y, e.yaw, len,
          e.carrier ? [1.15, 0.9, 0.9] : [1.05, 0.82, 0.8],
          { heel: (body.roll || 0) * 1.4, trim: (body.pitch || 0) * 1.2 });
      }

      // jets
      for (const j of s.jets) {
        gl.body('jet', j.x, (j.y0 ?? 0.6), j.y, j.yaw, 14, [0.8, 0.95, 1]);
      }

      // our ship last, so it is never depth-fighting an enemy at the same range
      const b = s.body || {};
      const mine = s.cap > 1 ? 'carrier' : 'ship';
      gl.body(mine, s.x, (b.heave || 0) - (s.length || 46) * 0.03, s.y, s.yaw,
        s.length || 46, [0.82, 0.92, 1.06],
        { heel: (b.roll || 0) * 1.4, trim: (b.pitch || 0) * 1.2 });

      // shells, spray, splashes and hits: one additive pass
      for (const shot of s.bullets) {
        gl.sprite(shot.x, 2.2, shot.y, 1.9, 1, 0.83, 0.36);
        gl.sprite(shot.x, 2.2, shot.y, 4.6, 0.55, 0.42, 0.12);
      }
      for (const shot of s.enemyBullets) {
        gl.sprite(shot.x, 2.2, shot.y, 1.9, 1, 0.42, 0.44);
      }
      for (const p of s.spray) {
        gl.sprite(p.x, 1.4 + (1 - p.life) * 5.5, p.y, 1.1 + p.r * 0.5, 0.78, 0.9, 1);
      }
      for (const sp of s.splash) {
        const t = 1 - Math.max(0, sp.life);
        gl.sprite(sp.x, 1.2 + t * 3.4, sp.y, 1.4 + sp.r * 0.22, 0.8, 0.92, 1);
      }
      for (const p of s.particles || []) {
        gl.sprite(p.x, 2.6 + (1 - p.life) * 6, p.y, 1.8, 1, 0.62, 0.3);
      }
      for (const w2 of s.wake) {
        gl.sprite(w2.x, 0.35, w2.y, Math.max(0.8, w2.r * 0.8), 0.6, 0.78, 0.9);
      }
      gl.flushSprites();
      return true;
    } catch (err) {
      // a broken GL frame costs the 3D, never the battle
      glReady = false;
      glBroken = true;
      use3D(false);
      try { console.warn('iron tide: 3D frame failed, chart view from here —', err && err.message); } catch { /* quiet */ }
      return false;
    }
  }

  /** The overlay: everything that reads better as text than as geometry. */
  function drawBattleOverlay(w, h) {
    const s = session;
    ctx.clearRect(0, 0, w, h);
    const project = (x, y, alt = 0) => {
      try { return gl.project(x, alt, y, w, h); } catch { return null; }
    };

    // the guns' reach, drawn as a ring on the water
    ctx.strokeStyle = 'rgba(89,201,255,.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= 48; i++) {
      const p = project(s.x + Math.cos((i / 48) * Math.PI * 2) * s.range,
        1.2, s.y + Math.sin((i / 48) * Math.PI * 2) * s.range);
      if (!p) { started = false; continue; }
      if (!started) { ctx.moveTo(p.x, p.y); started = true; }
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();

    // hulls: a name and a bar over each contact, clamped to the glass
    for (const e of s.ships) {
      if (e.dead) continue;
      const p = project(e.x, e.y, 16);
      if (!p || !p.onScreen) continue;
      const frac = Math.max(0, Math.min(1, e.hp / Math.max(1, e.maxHp)));
      const wid = 54;
      ctx.fillStyle = 'rgba(255,120,110,.9)';
      ctx.font = '700 8px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`${e.name} ${Math.round(Math.max(0, e.hp))}`, p.x, p.y - 12);
      ctx.fillStyle = 'rgba(10,20,30,.75)';
      ctx.fillRect(p.x - wid / 2, p.y - 8, wid, 3);
      ctx.fillStyle = frac > 0.5 ? 'rgba(255,180,120,.95)' : 'rgba(255,90,90,.95)';
      ctx.fillRect(p.x - wid / 2, p.y - 8, wid * frac, 3);
    }

    // lock bracket
    if (s.lock && !s.lock.dead && s.lockT > 0) {
      const p = project(s.lock.x, s.lock.y, 8);
      if (p && p.onScreen) {
        ctx.strokeStyle = 'rgba(109,255,168,.9)';
        ctx.lineWidth = 1.5;
        const r = 34, c = 10;
        for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.beginPath();
          ctx.moveTo(p.x + sx * r, p.y + sy * (r - c));
          ctx.lineTo(p.x + sx * r, p.y + sy * r);
          ctx.lineTo(p.x + sx * (r - c), p.y + sy * r);
          ctx.stroke();
        }
      }
    }

    // jets are small and far: a pip over each so the wing is never invisible
    for (const j of s.jets) {
      const p = project(j.x, j.y, 6);
      if (!p || !p.onScreen) continue;
      ctx.fillStyle = 'rgba(89,201,255,.85)';
      ctx.beginPath();
      ctx.arc(p.x, p.y - 6, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // islands you can actually see, named when they are close
    for (const isle of s.islands || []) {
      const p = project(isle.x, isle.y, isle.h * 0.6);
      if (!p || p.onScreen) continue;
      const d = Math.round(Math.hypot(isle.x - s.x, isle.y - s.y) / 10);
      const clampedX = Math.max(24, Math.min(w - 24, p.x));
      ctx.fillStyle = 'rgba(180,220,190,.6)';
      ctx.font = '700 7px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`ISLE ${d}`, clampedX, 26);
    }

    drawStickAndReticle(w, h);
  }

  /** The thumb stick and the aim line — identical in both renderers. */
  function drawStickAndReticle(w, h) {
    const s = session;
    if (s.joy.active) {
      ctx.strokeStyle = 'rgba(89,201,255,.45)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.joy.ox, s.joy.oy, 46, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(89,201,255,.5)';
      ctx.beginPath();
      ctx.arc(s.joy.ox + s.joy.x * 40, s.joy.oy + s.joy.y * 40, 16, 0, Math.PI * 2);
      ctx.fill();
    }
    // where the guns are pointed, on the glass
    const aim = typeof aimYaw === 'function' ? aimYaw() : s.yaw;
    const cx = w / 2, cy = h * 0.56;
    ctx.strokeStyle = 'rgba(255,213,120,.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.moveTo(cx - 15, cy); ctx.lineTo(cx - 11, cy);
    ctx.moveTo(cx + 11, cy); ctx.lineTo(cx + 15, cy);
    ctx.stroke();
    void aim;
  }

  function drawBattle() {
    const s = session;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (s.over || screen === 'result') return;
    if (live3D()) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (draw3D(w, h, dpr)) {
        drawBattleOverlay(w, h);
        return;
      }
    }
    drawBattle2D(w, h);
  }

  function drawBattle2D() {
    const s = session;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (s.over || screen === 'result') return;

    const camX = w / 2 - s.x;
    const camY = h / 2 - s.y;

    drawSea(s, camX, camY, w, h);
    drawWakes(s, camX, camY);

    // range ring
    ctx.strokeStyle = 'rgba(89,201,255,.18)';
    ctx.beginPath(); ctx.arc(s.x + camX, s.y + camY, s.range, 0, Math.PI * 2); ctx.stroke();

    // enemy ships
    for (const e of s.ships) {
      if (e.dead) continue;
      drawShip(e.x + camX, e.y + camY, e.yaw, 22, '#8c2f3a', '#ff8a6b',
        `${e.name} ${Math.max(0, Math.round(e.hp))}`, null, e.body);
    }

    // lock bracket on the ship the guns are tracking
    if (s.lock && !s.lock.dead && s.lockT > 0) {
      const lx = s.lock.x + camX, ly = s.lock.y + camY;
      ctx.strokeStyle = 'rgba(109,255,168,.9)';
      ctx.lineWidth = 1.5;
      const r = 30, c = 9;
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        ctx.beginPath();
        ctx.moveTo(lx + sx * r, ly + sy * (r - c));
        ctx.lineTo(lx + sx * r, ly + sy * r);
        ctx.lineTo(lx + sx * (r - c), ly + sy * r);
        ctx.stroke();
      }
    }

    // jets
    for (const j of s.jets) {
      ctx.save();
      ctx.translate(j.x + camX, j.y + camY);
      ctx.rotate(j.yaw);
      ctx.fillStyle = '#59c9ff';
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-8, 5); ctx.lineTo(-8, -5); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(89,201,255,.4)';
      ctx.beginPath(); ctx.moveTo(-8, 0); ctx.lineTo(-26, 0); ctx.stroke();
      ctx.restore();
    }

    // bullets
    for (const b of s.bullets) {
      ctx.fillStyle = '#ffd578';
      ctx.fillRect(b.x + camX - 2, b.y + camY - 2, 5, 5);
    }
    for (const b of s.enemyBullets) {
      ctx.fillStyle = '#ff6d7b';
      ctx.fillRect(b.x + camX - 2, b.y + camY - 2, 5, 5);
    }

    // particles
    for (const p of s.particles || []) {
      ctx.globalAlpha = Math.max(0, p.life * 2);
      ctx.fillStyle = p.colour;
      ctx.fillRect(p.x + camX - 2, p.y + camY - 2, 4, 4);
    }
    ctx.globalAlpha = 1;

    // player ship
    drawShip(s.x + camX, s.y + camY, s.yaw, 26, '#0f4a63', '#59c9ff', null, s.lo, s.body);

    // virtual stick
    if (s.joy.active) {
      ctx.strokeStyle = 'rgba(89,201,255,.45)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(s.joy.ox, s.joy.oy, 46, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(89,201,255,.5)';
      ctx.beginPath();
      ctx.arc(s.joy.ox + s.joy.x * 40, s.joy.oy + s.joy.y * 40, 16, 0, Math.PI * 2);
      ctx.fill();
    }

    // heading marker
    ctx.strokeStyle = 'rgba(255,213,120,.35)';
    ctx.beginPath();
    ctx.moveTo(s.x + camX + Math.cos(s.yaw) * 34, s.y + camY + Math.sin(s.yaw) * 34);
    ctx.lineTo(s.x + camX + Math.cos(s.yaw) * (s.range * 0.5), s.y + camY + Math.sin(s.yaw) * (s.range * 0.5));
    ctx.stroke();
  }

  /**
   * The sea, drawn from the same field the physics uses.
   *
   * Top-down water reads through three things: a depth gradient, the swell
   * (lines that follow the real height field, so they roll), and foam where
   * the surface is steep. Sampling is deliberately coarse — a 44 px grid over
   * a 1400 px screen is ~900 samples a frame, which a phone can afford.
   */
  function drawSea(s, camX, camY, w, h) {
    const sea = s.sea;
    const sev = sea.severity || 0;

    // deep water, darker than the sky and slightly greener in shallow seas
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#071b2a');
    g.addColorStop(0.55, '#04121e');
    g.addColorStop(1, '#020a12');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // the swell: rows of polylines. Each row samples the height field across
    // the screen, so crests travel and bend with the wave directions.
    // Sample density scales with the canvas so a big desktop window costs the
    // same as a phone: at most ~45 columns and ~14 rows, whatever the size.
    const rowStep = Math.max(46, Math.round(h / 14));
    const colStep = Math.max(34, Math.round(w / 42));
    const rows = Math.ceil(h / rowStep) + 2;
    ctx.lineWidth = 1;
    for (let r = 0; r < rows; r++) {
      const wy = s.y - h / 2 + r * rowStep;
      const screenY = wy + camY;
      ctx.beginPath();
      for (let x = -colStep; x <= w + colStep; x += colStep) {
        const wx = s.x - w / 2 + x;
        const sample = sea.at(wx, wy);
        // a metre of swell is worth about a pixel of shading, up to a point
        const lift = Math.max(-6, Math.min(6, sample.h * 0.9));
        const yy = screenY + lift;
        x === -colStep ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      // crests are brighter, troughs nearly invisible
      const alpha = 0.05 + sev * 0.05 + (r % 2) * 0.012;
      ctx.strokeStyle = `rgba(89,201,255,${alpha.toFixed(3)})`;
      ctx.stroke();
    }

    // foam: only where the surface is steep enough to break
    const fStep = Math.max(52, Math.round(Math.min(w, h) / 9));
    const fx0 = Math.floor((s.x - w / 2) / fStep) * fStep;
    const fy0 = Math.floor((s.y - h / 2) / fStep) * fStep;
    for (let wy = fy0; wy < s.y + h / 2 + fStep; wy += fStep) {
      for (let wx = fx0; wx < s.x + w / 2 + fStep; wx += fStep) {
        const foam = sea.foam(wx, wy);
        if (foam <= 0.08) continue;
        const jitter = ((wx * 7919 + wy * 104729) % 100) / 100;   // stable per cell
        const px = wx + camX + (jitter - 0.5) * fStep * 0.8;
        const py = wy + camY + (((wx * 31 + wy * 17) % 100) / 100 - 0.5) * fStep * 0.8;
        const len = 5 + foam * 13;
        ctx.strokeStyle = `rgba(214,240,255,${(foam * 0.5).toFixed(3)})`;
        ctx.lineWidth = 1 + foam * 1.6;
        ctx.beginPath();
        ctx.moveTo(px - len, py);
        ctx.lineTo(px + len, py);
        ctx.stroke();
      }
    }

    // wind streaks: long, faint and aligned with the wind — the sea's grain
    const wind = sea.wind();
    const windA = Math.atan2(wind.y, wind.x);
    ctx.save();
    ctx.globalAlpha = 0.05 + sev * 0.06;
    ctx.strokeStyle = '#9fd6ee';
    ctx.lineWidth = 1;
    const sStep = 150;
    const sx0 = Math.floor((s.x - w / 2) / sStep) * sStep;
    const sy0 = Math.floor((s.y - h / 2) / sStep) * sStep;
    for (let wy = sy0; wy < s.y + h / 2 + sStep; wy += sStep) {
      for (let wx = sx0; wx < s.x + w / 2 + sStep; wx += sStep) {
        const px = wx + camX;
        const py = wy + camY;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(windA) * 26, py + Math.sin(windA) * 26);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** Wake, spray and shell splashes, drawn under the hulls. */
  function drawWakes(s, camX, camY) {
    // foam trail
    for (const w of s.wake) {
      const a = Math.max(0, Math.min(1, w.life)) * 0.5;
      if (a <= 0.01) continue;
      ctx.fillStyle = w.colour === '#7fb6d6'
        ? `rgba(127,182,214,${(a * 0.5).toFixed(3)})`
        : `rgba(207,238,255,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(w.x + camX, w.y + camY, w.r, 0, Math.PI * 2);
      ctx.fill();
    }
    // spray thrown off the bow
    for (const p of s.spray) {
      const a = Math.max(0, Math.min(1, p.life));
      ctx.fillStyle = `rgba(226,246,255,${(a * 0.75).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x + camX, p.y + camY, p.r * (0.6 + a * 0.8), 0, Math.PI * 2);
      ctx.fill();
    }
    // expanding splash rings where a shell landed
    for (const sp of s.splash) {
      const a = Math.max(0, Math.min(1, sp.life));
      ctx.strokeStyle = `rgba(210,240,255,${(a * 0.55).toFixed(3)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(sp.x + camX, sp.y + camY, sp.r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawShip(x, y, yaw, size, fill, edge, label, lo, body) {
    // The hull rides the swell: `heave` moves it in screen space, `roll` leans
    // it, and a fast ship sits higher in the water (planing lift).
    const heave = body ? Math.max(-9, Math.min(9, body.heave * 1.6)) : 0;
    const roll = body ? body.roll : 0;
    const speed = body ? Math.abs(body.u) / Math.max(1, body.spec.vMax) : 0;
    if (heave !== 0) {
      // a soft shadow under the hull sells the height without a real 3D pass
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#01060b';
      ctx.beginPath();
      ctx.ellipse(x, y + 5, size * 1.02, size * 0.5, yaw, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.save();
    ctx.translate(x, y - heave * 0.35);
    ctx.rotate(yaw);
    ctx.transform(1, 0, Math.tan(roll * 0.6), 1 + Math.abs(roll) * 0.25, 0, 0);
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(size * 0.2, size * 0.45);
    ctx.lineTo(-size * 0.75, size * 0.4);
    ctx.lineTo(-size * 0.85, 0);
    ctx.lineTo(-size * 0.75, -size * 0.4);
    ctx.lineTo(size * 0.2, -size * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    if (lo) {
      // turrets
      const n = Math.max(1, lo.turrets);
      for (let i = 0; i < n; i++) {
        const tx = -size * 0.3 + i * size * 0.35;
        ctx.fillStyle = edge;
        ctx.beginPath(); ctx.arc(tx, 0, size * 0.13, 0, Math.PI * 2); ctx.fill();
      }
      if (lo.armour) {
        ctx.strokeStyle = 'rgba(255,213,120,.6)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, size * 0.5, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // bow wave: two thin foam lines peeling off the shoulders, wider the faster
    // the hull goes — this is the cheapest honest speed cue there is
    if (speed > 0.15) {
      ctx.strokeStyle = `rgba(220,244,255,${(0.10 + speed * 0.30).toFixed(3)})`;
      ctx.lineWidth = 1 + speed * 1.4;
      const spread = 0.55 + speed * 0.5;
      ctx.beginPath();
      ctx.moveTo(size * 0.95, 0);
      ctx.lineTo(size * 0.1, size * spread);
      ctx.lineTo(-size * 0.7, size * (spread + 0.35));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(size * 0.95, 0);
      ctx.lineTo(size * 0.1, -size * spread);
      ctx.lineTo(-size * 0.7, -size * (spread + 0.35));
      ctx.stroke();
    }
    ctx.restore();

    if (label) {
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.font = '700 7px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(label, x, y - size * 0.66);
      ctx.textAlign = 'left';
    }
  }

  /* ------------------------------------------------------------------ loop */
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // The 3D canvas and the overlay canvas are sized separately: hiding one
    // and measuring it would give a zero, and a zero-width sea is a black
    // screen that looks exactly like a crash.
    const in3D = live3D();
    const fit = in3D && glCanvas
      ? sdk.fit(glCanvas, 2)
      : sdk.fit(canvas, 2);
    // The backing store is `dpr` times the CSS size, and everything below draws
    // in CSS pixels — so the context has to be scaled to match. Without this
    // the whole sea renders into the top-left quarter of a phone's screen.
    try {
      const dpr = (fit && fit.dpr) || Math.min(window.devicePixelRatio || 1, 2);
      if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch { /* an older context draws at 1× */ }
    if (screen === 'battle' && session) {
      updateBattle(dt);
      drawBattle();
    } else if (screen === 'dock') {
      drawDockScene();
    }
    // the chart view is the only thing that draws when there is no battle
    if (!in3D && glCanvas && glCanvas.style && glCanvas.style.display !== 'none') use3D(false);
    requestAnimationFrame(frame);
  }

  let ac = null;
  function beep(freq, dur, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'triangle';
      o.frequency.value = freq;
      g.gain.value = gain || 0.05;
      o.connect(g).connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur + 0.02);
    } catch { /* audio is optional */ }
  }

  /* ------------------------------------------------------------------ boot */
  // Order matters, and it is the order that fixes the stall the player sees as
  // "loading": the canvas is already on screen, so start its loop first, then
  // tell the hub we are up, and only then build the dock. A throwing dock can
  // no longer leave a black frame and a hub that never hears `arcade:ready`.
  requestAnimationFrame(frame);
  sdk.ready();
  try {
    tryLoad();
    paintWallet();
    renderAll();
  } catch (err) {
    // in-memory fleet, a half-built dock: the sea still runs, so say what broke
    // and let the DOCK tab (which re-renders) act as the retry
    try { console.warn('iron tide: dock render failed', err); } catch { /* no console */ }
    const hint = $('loadoutHint');
    if (hint) hint.textContent = 'Dock failed to render — tap DOCK to retry.';
  }

  // exposed for the host test suite (and for curious players in devtools)
  window.__ironTide = {
    get fleet() { return fleet; },
    get session() { return session; },
    loadout, startBattle, endBattle, backToDock, fire, launchJet,
    // one deterministic simulation step — the host suite drives the battle with
    // this instead of waiting on requestAnimationFrame
    tick: (dt) => { if (screen === 'battle' && session) { updateBattle(dt); drawBattle(); } },
    /**
     * Point the bow at a world position using the rudder — the same control a
     * player has, so a test steering this way is not cheating, just a helmsman.
     */
    steerTo: (x, y) => {
      if (!session) return 0;
      let diff = Math.atan2(y - session.y, x - session.x) - session.body.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      session.autopilot = Math.max(-1, Math.min(1, diff * 2.4));
      return session.autopilot;
    },
    get screen() { return screen; },
    setTab: (t) => { tab = t; renderAll(); },
    // 3D: what the renderer is, whether it is live, and why not when it is not
    get gl() { return glReady; },
    get glBroken() { return glBroken; },
    get glInfo() { return gl ? { tris: gl.tris, sea: gl.seaTris } : null; },
    get sea3dNote() { return sea3dNote; },
    get islands() { return session ? session.islands || [] : []; },
    render3D: () => (live3D()
      ? draw3D(canvas.clientWidth, canvas.clientHeight, Math.min(window.devicePixelRatio || 1, 2))
      : false),
  };
})();
