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
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const fleet = R.newFleet();
  let tab = 'dock';
  let screen = 'dock';       // dock | battle | result
  let session = null;

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
    const lo = loadout();
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
    session = {
      lo,
      cap,
      t: 0,
      hull: lo.hp,
      maxHull: lo.hp,
      speed: lo.speed * 60,
      turn: 0.9 + lo.speed * 0.25,
      range: lo.range || 260,
      yaw: -Math.PI / 2,
      x: 0, y: 0,
      vel: { x: 0, y: 0 },
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
    const enemies = R.enemyFleet(fleet.sorties + 1);
    enemies.forEach((e, i) => {
      const a = (i / enemies.length) * Math.PI * 2;
      const d = 620 + i * 60;
      session.ships.push({
        ...e, maxHp: e.hp, x: Math.cos(a) * d, y: Math.sin(a) * d,
        yaw: a + Math.PI, fireCd: 1 + Math.random(), dead: false, aggro: 0,
      });
    });
    for (const jetId of fleet.jets.slice(0, cap)) session.jetCd[jetId] = 2;

    screen = 'battle';
    $('dock').classList.add('hidden');
    $('battleHud').classList.remove('hidden');
    $('result').classList.add('hidden');
    paintJetChips();
    showBanner('SORTIE ' + (fleet.sorties + 1), 1.6);
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

    // steering
    const turn = (s.keys.right ? 1 : 0) - (s.keys.left ? 1 : 0) + (s.joy.active ? s.joy.x : 0);
    s.yaw += turn * s.turn * dt;
    const throttle = (s.keys.up ? 1 : 0) - (s.keys.down ? 0.55 : 0) + (s.joy.active ? -s.joy.y : 0);
    const forward = Math.max(-0.45, Math.min(1, throttle));
    s.vel.x += Math.cos(s.yaw) * forward * s.speed * dt * 1.6;
    s.vel.y += Math.sin(s.yaw) * forward * s.speed * dt * 1.6;
    const drag = Math.pow(0.12, dt);
    s.vel.x *= drag; s.vel.y *= drag;
    s.x += s.vel.x * dt;
    s.y += s.vel.y * dt;

    const arena = 2400;
    s.x = Math.max(-arena, Math.min(arena, s.x));
    s.y = Math.max(-arena, Math.min(arena, s.y));

    if (s.keys.fire) fire();

    // enemy movement + shooting
    for (const e of s.ships) {
      if (e.dead) continue;
      const dx = s.x - e.x, dy = s.y - e.y;
      const d = Math.hypot(dx, dy) || 1;
      e.aggro += dt;
      const px = e.x, py = e.y;
      const standoff = Math.max(120, e.range * 0.55);
      if (d > e.range * 0.9) {
        e.x += (dx / d) * e.speed * 46 * dt;          // close the distance
        e.y += (dy / d) * e.speed * 46 * dt;
      } else if (d < standoff) {
        e.x -= (dx / d) * e.speed * 34 * dt;          // back off, keep the range open
        e.y -= (dy / d) * e.speed * 34 * dt;
      } else {
        // circle the player instead of ramming
        e.x += (-dy / d) * e.speed * 30 * dt;
        e.y += (dx / d) * e.speed * 30 * dt;
      }
      // stored so the player's guns can lead a circling target
      e.vx = (e.x - px) / dt;
      e.vy = (e.y - py) / dt;
      e.yaw = Math.atan2(dy, dx);
      e.fireCd -= dt;
      if (e.fireCd <= 0 && d < e.range + 90) {
        e.fireCd = 2.2 + Math.random() * 1.2;
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.2;
        s.enemyBullets.push({ x: e.x, y: e.y, vx: Math.cos(a) * 380, vy: Math.sin(a) * 380, dmg: e.dmg, life: 2.4 });
      }
    }

    // bullets
    for (const b of s.bullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      for (const e of s.ships) {
        if (e.dead) continue;
        if (Math.hypot(e.x - b.x, e.y - b.y) < 26) {
          e.hp -= b.dmg;
          b.life = 0;
          s.kills += 0; // counted on death
          if (e.hp <= 0) {
            e.dead = true;
            s.kills += 1;
            burst(e.x, e.y, '#ffb347', 18);
            showBanner(`${e.name} SUNK`, 1.0);
            beep(140, 0.22, 0.09);
          }
          break;
        }
      }
    }
    s.bullets = s.bullets.filter((b) => b.life > 0);

    for (const b of s.enemyBullets) {
      b.x += b.vx * dt; b.y += b.vy * dt; b.life -= dt;
      // flak intercepts incoming fire near the ship
      if (s.lo.flak && Math.hypot(b.x - s.x, b.y - s.y) < 78 && Math.random() < 0.5) { b.life = 0; continue; }
      if (Math.hypot(b.x - s.x, b.y - s.y) < 22) {
        s.hull -= b.dmg;
        b.life = 0;
        burst(s.x, s.y, '#ff6d7b', 6);
        if (s.hull <= 0) endBattle(false);
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
    const totalHp = s.ships.reduce((sum, e) => sum + Math.max(0, e.hp), 0);
    const startHp = s.ships.reduce((sum, e) => sum + e.maxHp, 0);
    $('enemyBar').style.width = `${Math.max(0, (totalHp / startHp) * 100)}%`;
    $('fireBtn').classList.toggle('ready', s.fireCd <= 0);
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
    // horizon + a slow swell so the dock is not a flat colour
    const horizon = h * 0.52;
    ctx.strokeStyle = 'rgba(89,201,255,.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i < 7; i++) {
      const y = horizon + i * 18;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 24) {
        const yy = y + Math.sin((x / 90) + i + performance.now() / 1400) * 3;
        x === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // the flagship silhouette
    const hull = R.byId(R.HULLS, fleet.hull);
    const scale = 1 + hull.length / 160;
    ctx.save();
    ctx.translate(w * 0.82, h * 0.7);
    ctx.scale(scale, scale);
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

  function drawBattle() {
    const s = session;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (s.over || screen === 'result') return;

    ctx.fillStyle = '#04101a';
    ctx.fillRect(0, 0, w, h);

    const camX = w / 2 - s.x;
    const camY = h / 2 - s.y;

    // sea grid
    ctx.strokeStyle = 'rgba(89,201,255,.07)';
    ctx.lineWidth = 1;
    const step = 120;
    const startX = Math.floor((s.x - w / 2) / step) * step;
    const startY = Math.floor((s.y - h / 2) / step) * step;
    for (let x = startX; x < s.x + w / 2 + step; x += step) {
      ctx.beginPath(); ctx.moveTo(x + camX, 0); ctx.lineTo(x + camX, h); ctx.stroke();
    }
    for (let y = startY; y < s.y + h / 2 + step; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y + camY); ctx.lineTo(w, y + camY); ctx.stroke();
    }

    // range ring
    ctx.strokeStyle = 'rgba(89,201,255,.18)';
    ctx.beginPath(); ctx.arc(s.x + camX, s.y + camY, s.range, 0, Math.PI * 2); ctx.stroke();

    // enemy ships
    for (const e of s.ships) {
      if (e.dead) continue;
      drawShip(e.x + camX, e.y + camY, e.yaw, 22, '#8c2f3a', '#ff8a6b', `${e.name} ${Math.max(0, Math.round(e.hp))}`);
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
    drawShip(s.x + camX, s.y + camY, s.yaw, 26, '#0f4a63', '#59c9ff', null, s.lo);

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

  function drawShip(x, y, yaw, size, fill, edge, label, lo) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(yaw);
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
    sdk.fit(canvas, 2);
    if (screen === 'battle' && session) {
      updateBattle(dt);
      drawBattle();
    } else if (screen === 'dock') {
      drawDockScene();
    }
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
  tryLoad();
  paintWallet();
  renderAll();
  sdk.ready();
  requestAnimationFrame(frame);

  // exposed for the host test suite (and for curious players in devtools)
  window.__ironTide = {
    get fleet() { return fleet; },
    get session() { return session; },
    loadout, startBattle, endBattle, backToDock, fire, launchJet,
    // one deterministic simulation step — the host suite drives the battle with
    // this instead of waiting on requestAnimationFrame
    tick: (dt) => { if (screen === 'battle' && session) { updateBattle(dt); drawBattle(); } },
    get screen() { return screen; },
    setTab: (t) => { tab = t; renderAll(); },
  };
})();
