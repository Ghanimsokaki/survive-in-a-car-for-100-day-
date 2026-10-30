/* SCRAPYARD RUN — grab what you can carry and get out before the yard folds.
 * Weight slows you down; value per kg is the real game.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const LOOT = [
    { name: 'SCRAP', kg: 1, value: 4, colour: '#9aa4b4', size: 9 },
    { name: 'STEEL', kg: 3, value: 18, colour: '#c8d4e4', size: 12 },
    { name: 'TITANIUM', kg: 5, value: 44, colour: '#8fd0ff', size: 14 },
    { name: 'ENGINE CORE', kg: 9, value: 120, colour: '#ffd578', size: 17 },
  ];

  const G = {
    running: false, over: false, t: 0, left: 75, value: 0, kg: 0, cap: 40,
    player: { x: 0, y: 0 }, items: [], exit: { x: 0, y: 0 }, dist: 0,
    keys: {}, particles: [], took: 0,
  };

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  function reset() {
    Object.assign(G, {
      running: true, over: false, t: 0, left: 75, value: 0, kg: 0,
      player: { x: 0, y: 0 }, items: [], dist: 0, keys: {}, particles: [], took: 0,
    });
    for (let i = 0; i < 46; i++) {
      const def = LOOT[Math.floor(Math.random() * Math.pow(LOOT.length, 1.25)) % LOOT.length] || LOOT[0];
      G.items.push({
        ...def,
        x: (Math.random() - 0.5) * 900,
        y: (Math.random() - 0.5) * 900,
      });
    }
    G.exit = { x: 0, y: -520 };
    $('intro').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  addEventListener('keydown', (e) => {
    G.keys[e.key.toLowerCase()] = true;
    if (e.key === ' ') { e.preventDefault(); if (!G.running) reset(); }
  });
  addEventListener('keyup', (e) => { G.keys[e.key.toLowerCase()] = false; });

  let drag = null;
  const touchInfo = { active: false, dx: 0, dy: 0 };
  canvas.addEventListener('mousedown', (e) => {
    if (!G.running) return;
    const r = canvas.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top };
  });
  addEventListener('mouseup', () => { drag = null; touchInfo.active = false; });
  canvas.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const nx = e.clientX - r.left, ny = e.clientY - r.top;
    touchInfo.active = true;
    touchInfo.dx = (nx - drag.x) / 60;
    touchInfo.dy = (ny - drag.y) / 60;
    drag = { x: nx, y: ny };
    if (Math.hypot(touchInfo.dx, touchInfo.dy) < 0.15) touchInfo.active = false;
  });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (!G.running) return;
    const t = e.touches[0];
    if (t) drag = { x: t.clientX, y: t.clientY };
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (!drag || !t) return;
    touchInfo.active = true;
    touchInfo.dx = (t.clientX - drag.x) / 32;
    touchInfo.dy = (t.clientY - drag.y) / 32;
    drag = { x: t.clientX, y: t.clientY };
  }, { passive: false });
  canvas.addEventListener('touchend', () => { drag = null; touchInfo.active = false; });

  $('go').addEventListener('click', reset);
  $('again').addEventListener('click', reset);

  function update(dt) {
    if (!G.running) return;
    G.t += dt;
    G.left -= dt;

    const load = 1 - Math.min(0.62, G.kg / G.cap * 0.62);
    const speed = 250 * load;
    let mx = (G.keys.d || G.keys.arrowright ? 1 : 0) - (G.keys.a || G.keys.arrowleft ? 1 : 0);
    let my = (G.keys.s || G.keys.arrowdown ? 1 : 0) - (G.keys.w || G.keys.arrowup ? 1 : 0);
    if (touchInfo.active) { mx = touchInfo.dx; my = touchInfo.dy; }
    const len = Math.hypot(mx, my) || 1;
    if (mx || my) {
      G.player.x += (mx / len) * speed * dt;
      G.player.y += (my / len) * speed * dt;
      G.dist += speed * dt * 0.02;
    }
    G.player.x = Math.max(-1150, Math.min(1150, G.player.x));
    G.player.y = Math.max(-1150, Math.min(1150, G.player.y));

    // pickups
    for (let i = G.items.length - 1; i >= 0; i--) {
      const it = G.items[i];
      if (Math.hypot(it.x - G.player.x, it.y - G.player.y) < it.size + 22) {
        if (G.kg + it.kg > G.cap) continue;      // too heavy — walk past it
        G.items.splice(i, 1);
        G.kg += it.kg;
        G.value += it.value;
        G.took += 1;
        for (let p = 0; p < 8; p++) {
          G.particles.push({
            x: it.x, y: it.y, vx: (Math.random() - 0.5) * 120, vy: (Math.random() - 0.5) * 120, life: 0.5, colour: it.colour,
          });
        }
        beep(420 + it.value, 0.05, 0.05);
      }
    }

    // extraction
    const distExit = Math.hypot(G.exit.x - G.player.x, G.exit.y - G.player.y);
    if (distExit < 60) end(true);

    G.particles.forEach((p) => { p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt; });
    G.particles = G.particles.filter((p) => p.life > 0);

    if (G.left <= 0) end(false);

    $('value').textContent = String(G.value);
    $('bag').textContent = `${G.kg}/${G.cap}`;
    $('time').textContent = String(Math.max(0, Math.ceil(G.left)));
  }

  function end(won) {
    if (G.over) return;
    G.running = false;
    G.over = true;
    $('overTitle').textContent = won ? 'EXTRACTED' : 'THE YARD CLOSED';
    const perKg = G.kg ? (G.value / G.kg).toFixed(1) : '0.0';
    $('overText').innerHTML = `${G.took} items · ${G.kg} kg · ${perKg} value/kg<br />HAUL: ${G.value} CREDITS`;
    $('over').classList.remove('hidden');
    Arcade.score({
      score: G.value + (won ? 50 : 0),
      day: 0,
      seconds: Math.round(G.t),
      won,
      meta: `${G.kg}kg hauled`,
    });
  }

  function draw() {
    const w = W(), h = H();
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2 - G.player.x * 0.62;
    const cy = h / 2 - G.player.y * 0.62;

    // yard grid
    ctx.strokeStyle = 'rgba(255,255,255,.045)';
    ctx.lineWidth = 1;
    for (let gx = -1200; gx <= 1200; gx += 120) {
      ctx.beginPath(); ctx.moveTo(cx + gx * 0.62, 0); ctx.lineTo(cx + gx * 0.62, h); ctx.stroke();
    }
    for (let gy = -1200; gy <= 1200; gy += 120) {
      ctx.beginPath(); ctx.moveTo(0, cy + gy * 0.62); ctx.lineTo(w, cy + gy * 0.62); ctx.stroke();
    }

    // crates
    G.items.forEach((it) => {
      const x = cx + it.x * 0.62;
      const y = cy + it.y * 0.62;
      if (x < -40 || x > w + 40 || y < -40 || y > h + 40) return;
      ctx.fillStyle = it.colour;
      ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.roundRect(x - it.size / 2, y - it.size / 2, it.size, it.size, 3); ctx.fill();
      ctx.globalAlpha = 1;
    });

    // exit gate
    const ex = cx + G.exit.x * 0.62;
    const ey = cy + G.exit.y * 0.62;
    const near = Math.hypot(G.exit.x - G.player.x, G.exit.y - G.player.y) < 200;
    ctx.strokeStyle = near ? '#6dffa8' : 'rgba(109,255,168,.35)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(ex, ey, 26 + Math.sin(G.t * 4) * 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = near ? '#6dffa8' : 'rgba(109,255,168,.5)';
    ctx.font = '700 9px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.fillText('EXIT', ex, ey - 34);

    // particles
    G.particles.forEach((p) => {
      ctx.globalAlpha = Math.max(0, p.life * 2);
      ctx.fillStyle = p.colour;
      ctx.fillRect(cx + p.x * 0.62 - 2, cy + p.y * 0.62 - 2, 4, 4);
    });
    ctx.globalAlpha = 1;

    // player
    const px = cx + G.player.x * 0.62;
    const py = cy + G.player.y * 0.62;
    ctx.fillStyle = '#ffb347';
    ctx.beginPath(); ctx.arc(px, py, 13, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#241505';
    ctx.beginPath(); ctx.arc(px, py - 2, 5, 0, Math.PI * 2); ctx.fill();

    // load ring
    ctx.strokeStyle = G.kg > G.cap * 0.8 ? '#ff6d7b' : '#6dffa8';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(px, py, 20, -Math.PI / 2, -Math.PI / 2 + (G.kg / G.cap) * Math.PI * 2);
    ctx.stroke();

    // weight warning
    if (G.kg > G.cap * 0.8) {
      ctx.fillStyle = '#ff6d7b';
      ctx.font = '700 11px ui-monospace,monospace';
      ctx.fillText('HEAVY — YOU ARE SLOWING DOWN', px, py + 44);
    }
    ctx.textAlign = 'left';
  }

  let ac = null;
  function beep(freq, dur, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(); const g = ac.createGain();
      o.type = 'sine'; o.frequency.value = freq; g.gain.value = gain || 0.05;
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
