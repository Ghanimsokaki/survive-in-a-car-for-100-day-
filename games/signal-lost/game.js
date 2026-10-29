/* SIGNAL LOST — fog-of-war survival.
 * You only see what your radio reveals. Ping to light up the dark; find all
 * eight beacons before the battery dies.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const BEACONS = 8;
  const WORLD = 1500;

  const G = {
    running: false, over: false, t: 0, battery: 100, found: 0, dist: 0,
    player: { x: 0, y: 0 }, beacons: [], pings: [], keys: {}, reveal: [],
    compass: 0,
  };

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  function reset() {
    Object.assign(G, {
      running: true, over: false, t: 0, battery: 100, found: 0, dist: 0,
      player: { x: 0, y: 0 }, beacons: [], pings: [], keys: {}, reveal: [], compass: 0,
    });
    for (let i = 0; i < BEACONS; i++) {
      G.beacons.push({
        x: (Math.random() - 0.5) * WORLD * 1.6,
        y: (Math.random() - 0.5) * WORLD * 1.6,
        found: false,
        id: i,
      });
    }
    $('intro').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  function ping() {
    if (!G.running || G.battery < 6) return;
    G.battery -= 6;
    G.pings.push({ x: G.player.x, y: G.player.y, r: 0, max: 420, life: 1.5 });
    beep(880, 0.9, 0.05, 'sine');
  }

  addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    G.keys[k] = true;
    if (k === ' ') { e.preventDefault(); if (!G.running) reset(); else ping(); }
  });
  addEventListener('keyup', (e) => { G.keys[e.key.toLowerCase()] = false; });

  let drag = null;
  const touchMove = { active: false, dx: 0, dy: 0 };
  canvas.addEventListener('mousedown', (e) => {
    if (!G.running) return;
    const r = canvas.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    ping();
  });
  addEventListener('mouseup', () => { drag = null; touchMove.active = false; });
  canvas.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const nx = e.clientX - r.left, ny = e.clientY - r.top;
    touchMove.active = true;
    touchMove.dx = (nx - drag.x) / 55;
    touchMove.dy = (ny - drag.y) / 55;
    drag = { x: nx, y: ny };
    if (Math.hypot(touchMove.dx, touchMove.dy) < 0.12) touchMove.active = false;
  });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!G.running) return;
    const t = e.touches[0];
    if (t) drag = { x: t.clientX, y: t.clientY };
    ping();
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (!drag || !t) return;
    touchMove.active = true;
    touchMove.dx = (t.clientX - drag.x) / 28;
    touchMove.dy = (t.clientY - drag.y) / 28;
    drag = { x: t.clientX, y: t.clientY };
  }, { passive: false });
  canvas.addEventListener('touchend', () => { drag = null; touchMove.active = false; });

  $('go').addEventListener('click', reset);
  $('again').addEventListener('click', reset);

  function update(dt) {
    if (!G.running) return;
    G.t += dt;
    G.battery = Math.max(0, G.battery - dt * 3.4);

    let mx = (G.keys.d || G.keys.arrowright ? 1 : 0) - (G.keys.a || G.keys.arrowleft ? 1 : 0);
    let my = (G.keys.s || G.keys.arrowdown ? 1 : 0) - (G.keys.w || G.keys.arrowup ? 1 : 0);
    if (touchMove.active) { mx = touchMove.dx; my = touchMove.dy; }
    const len = Math.hypot(mx, my) || 1;
    const speed = 300;
    if (mx || my) {
      G.player.x += (mx / len) * speed * dt;
      G.player.y += (my / len) * speed * dt;
      G.dist += speed * dt;
    }
    G.player.x = Math.max(-WORLD, Math.min(WORLD, G.player.x));
    G.player.y = Math.max(-WORLD, Math.min(WORLD, G.player.y));

    G.pings.forEach((p) => {
      p.life -= dt;
      p.r += (p.max / 1.5) * dt;
    });
    G.pings = G.pings.filter((p) => p.life > 0);

    // what the last pings revealed becomes permanent map knowledge
    G.pings.forEach((p) => {
      G.beacons.forEach((b) => {
        if (b.found) return;
        if (Math.hypot(b.x - p.x, b.y - p.y) < p.r && Math.hypot(b.x - G.player.x, b.y - G.player.y) < 460) {
          b.seen = true;
        }
      });
    });

    G.beacons.forEach((b) => {
      if (b.found) return;
      if (Math.hypot(b.x - G.player.x, b.y - G.player.y) < 46) {
        b.found = true;
        G.found += 1;
        G.battery = Math.min(100, G.battery + 9);
        beep(1200, 0.12, 0.06, 'triangle');
      }
    });

    // compass points at the nearest beacon still out there
    const target = G.beacons
      .filter((b) => !b.found)
      .sort((a, c) => Math.hypot(a.x - G.player.x, a.y - G.player.y) - Math.hypot(c.x - G.player.x, c.y - G.player.y))[0];
    if (target) G.compass = Math.atan2(target.y - G.player.y, target.x - G.player.x);

    if (G.found >= BEACONS) end(true);
    if (G.battery <= 0) end(false);

    $('found').textContent = `${G.found}/${BEACONS}`;
    $('battery').textContent = `${Math.round(G.battery)}%`;
    $('dist').textContent = String(Math.round(G.dist / 10));
  }

  function end(won) {
    if (G.over) return;
    G.running = false;
    G.over = true;
    $('overTitle').textContent = won ? 'ALL BEACONS ONLINE' : 'BATTERY DEAD';
    $('overText').innerHTML = `${G.found} of ${BEACONS} beacons found · ${Math.round(G.dist / 10)} m walked.`;
    $('over').classList.remove('hidden');
    Arcade.score({ score: G.found * 140 + (won ? 600 : 0), day: G.found, seconds: Math.round(G.t), won, meta: `${G.found}/${BEACONS}` });
  }

  function draw() {
    const w = W(), h = H();
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2 - G.player.x * 0.5;
    const cy = h / 2 - G.player.y * 0.5;

    // very dim ground so movement reads
    ctx.strokeStyle = 'rgba(197,140,255,.06)';
    for (let gx = -WORLD; gx <= WORLD; gx += 150) {
      ctx.beginPath(); ctx.moveTo(cx + gx * 0.5, 0); ctx.lineTo(cx + gx * 0.5, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, cy + gx * 0.5); ctx.lineTo(w, cy + gx * 0.5); ctx.stroke();
    }

    // reveal only inside live rings
    G.pings.forEach((p) => {
      const px = cx + p.x * 0.5;
      const py = cy + p.y * 0.5;
      const r = p.r * 0.5;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      const a = Math.max(0, p.life / 1.5);
      grad.addColorStop(0, `rgba(197,140,255,${0.16 * a})`);
      grad.addColorStop(0.7, `rgba(197,140,255,${0.07 * a})`);
      grad.addColorStop(1, 'rgba(197,140,255,0)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(197,140,255,${0.35 * a})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.stroke();
    });

    // beacons — only drawn once the radio has swept over them
    G.beacons.forEach((b) => {
      if (!b.seen && !b.found) return;
      const bx = cx + b.x * 0.5;
      const by = cy + b.y * 0.5;
      ctx.fillStyle = b.found ? '#6dffa8' : '#c58cff';
      ctx.beginPath(); ctx.arc(bx, by, 7 + Math.sin(G.t * 5 + b.id) * 2, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = b.found ? 'rgba(109,255,168,.5)' : 'rgba(197,140,255,.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(bx, by, 16, 0, Math.PI * 2); ctx.stroke();
    });

    // player
    const px = cx + G.player.x * 0.5;
    const py = cy + G.player.y * 0.5;
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.arc(px, py, 9, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,179,71,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 26 + Math.sin(G.t * 3) * 3, 0, Math.PI * 2); ctx.stroke();

    // compass to the nearest signal
    const r2 = 58;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(G.compass);
    ctx.fillStyle = 'rgba(197,140,255,.85)';
    ctx.beginPath(); ctx.moveTo(r2, 0); ctx.lineTo(r2 - 10, -6); ctx.lineTo(r2 - 10, 6); ctx.closePath(); ctx.fill();
    ctx.restore();

    // battery bar
    ctx.fillStyle = 'rgba(255,255,255,.1)';
    ctx.fillRect(w - 132, h - 26, 108, 8);
    ctx.fillStyle = G.battery < 25 ? '#ff6d7b' : '#c58cff';
    ctx.fillRect(w - 132, h - 26, (G.battery / 100) * 108, 8);

    if (G.battery < 20) {
      ctx.fillStyle = `rgba(255,109,123,${0.1 + Math.sin(G.t * 6) * 0.06})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  let ac = null;
  function beep(freq, dur, gain, type) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(); const g = ac.createGain();
      o.type = type || 'sine'; o.frequency.value = freq; g.gain.value = gain || 0.05;
      o.connect(g).connect(ac.destination); o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur + 0.02);
    } catch { /* optional */ }
  }

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    Arcade.fit(canvas, 2);
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  Arcade.ready();
  requestAnimationFrame(frame);
})();
