/* RADIO TOWER — hold the relay until dawn.
 * Aim-and-click tower defence: walkers converge on the tower, you shoot them.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const G = {
    running: false, over: false, t: 0, left: 90, hp: 100, wave: 0, waveCd: 3,
    walkers: [], bullets: [], kills: 0, ammo: 8, reload: 0, flash: 0, tracer: null,
  };

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;
  const tower = () => ({ x: W() * 0.5, y: H() * 0.52 });

  function reset() {
    Object.assign(G, {
      running: true, over: false, t: 0, left: 90, hp: 100, wave: 0, waveCd: 2.5,
      walkers: [], bullets: [], kills: 0, ammo: 8, reload: 0, flash: 0, tracer: null,
    });
    $('intro').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  function shoot(px, py) {
    if (!G.running) return;
    if (G.ammo <= 0) { beep(120, 0.05, 0.04); return; }
    G.ammo -= 1;
    G.reload = Math.max(G.reload, 0.18);
    G.tracer = { x1: W() * 0.5, y1: H() * 0.86, x2: px, y2: py, life: 0.06 };
    beep(760, 0.04, 0.05);

    let hit = null;
    let best = 30;
    G.walkers.forEach((wk) => {
      const d = Math.hypot(wk.x - px, wk.y - py);
      if (d < best) { best = d; hit = wk; }
    });
    if (hit) {
      hit.hp -= 1;
      if (hit.hp <= 0) { hit.dead = true; G.kills += 1; splat(hit.x, hit.y); }
    }
  }

  function splat(x, y) {
    for (let i = 0; i < 6; i++) {
      G.bullets.push({ x, y, vx: (Math.random() - 0.5) * 150, vy: (Math.random() - 0.5) * 150, life: 0.3, gore: true });
    }
  }

  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    shoot(e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const t = e.touches[0];
    if (!t) return;
    if (!G.running) return;
    const r = canvas.getBoundingClientRect();
    shoot(t.clientX - r.left, t.clientY - r.top);
  }, { passive: false });
  addEventListener('keydown', (e) => {
    if (e.key === ' ' && !G.running) { e.preventDefault(); reset(); }
    if (e.key.toLowerCase() === 'r') { G.ammo = 8; }
  });
  $('go').addEventListener('click', reset);
  $('again').addEventListener('click', reset);

  function update(dt) {
    if (!G.running) return;
    G.t += dt;
    G.left -= dt;
    G.flash = Math.max(0, G.flash - dt * 2.5);
    if (G.tracer) { G.tracer.life -= dt; if (G.tracer.life <= 0) G.tracer = null; }

    // ammo trickle so a dry spell is not fatal
    G.reload -= dt;
    if (G.ammo < 8 && G.reload <= 0) {
      G.reload = 0.55;
      G.ammo += 1;
    }

    // waves
    G.waveCd -= dt;
    if (G.waveCd <= 0) {
      G.wave += 1;
      G.waveCd = Math.max(4.5, 11 - G.wave * 0.5);
      const n = 2 + Math.floor(G.wave * 0.9);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.max(W(), H()) * 0.62;
        G.walkers.push({
          x: W() * 0.5 + Math.cos(a) * r,
          y: H() * 0.52 + Math.sin(a) * r,
          sp: 16 + G.wave * 2.4 + Math.random() * 10,
          hp: 1 + (G.wave > 4 ? 1 : 0),
        });
      }
      beep(160, 0.18, 0.07);
    }

    const T = tower();
    G.walkers.forEach((wk) => {
      const dx = T.x - wk.x, dy = T.y - wk.y;
      const d = Math.hypot(dx, dy) || 1;
      wk.x += (dx / d) * wk.sp * dt;
      wk.y += (dy / d) * wk.sp * dt;
      if (d < 42) { wk.dead = true; G.hp -= 7; G.flash = 0.7; beep(90, 0.15, 0.08); }
    });
    G.walkers = G.walkers.filter((w) => !w.dead);

    G.bullets.forEach((b) => { b.x += (b.vx || 0) * dt; b.y += (b.vy || 0) * dt; b.life -= dt; });
    G.bullets = G.bullets.filter((b) => b.life > 0);

    if (G.hp <= 0) end(false);
    if (G.left <= 0) end(true);

    $('hp').textContent = `${Math.max(0, Math.round(G.hp))}%`;
    $('time').textContent = String(Math.max(0, Math.ceil(G.left)));
    $('wave').textContent = String(G.wave);
    $('kills').textContent = String(G.kills);
  }

  function end(won) {
    if (G.over) return;
    G.running = false;
    G.over = true;
    $('overTitle').textContent = won ? 'DAWN BROKE' : 'SIGNAL LOST';
    $('overText').innerHTML = `${G.kills} walkers down across ${G.wave} waves.`;
    $('over').classList.remove('hidden');
    Arcade.score({ score: G.kills * 40 + G.wave * 30 + (won ? 500 : 0), day: G.wave, seconds: Math.round(G.t), won, meta: `${G.kills} kills` });
  }

  function draw() {
    const w = W(), h = H();
    // dusk gradient, brightening as dawn approaches
    const dawn = 1 - G.left / 90;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `rgb(${12 + dawn * 60},${16 + dawn * 40},${28 + dawn * 30})`);
    g.addColorStop(1, `rgb(${20 + dawn * 90},${18 + dawn * 50},${26 + dawn * 30})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // ground rings
    const T = tower();
    ctx.strokeStyle = 'rgba(107,224,255,.12)';
    [120, 220, 320].forEach((r) => {
      ctx.beginPath(); ctx.arc(T.x, T.y, r, 0, Math.PI * 2); ctx.stroke();
    });

    // walkers
    G.walkers.forEach((wk) => {
      ctx.fillStyle = wk.hp > 1 ? '#c46a4a' : '#5f7a52';
      ctx.beginPath(); ctx.arc(wk.x, wk.y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a1c22';
      ctx.beginPath(); ctx.arc(wk.x - 3, wk.y - 2, 1.6, 0, Math.PI * 2);
      ctx.arc(wk.x + 3, wk.y - 2, 1.6, 0, Math.PI * 2); ctx.fill();
    });

    // tower
    ctx.fillStyle = '#6be0ff';
    ctx.fillRect(T.x - 4, T.y - 60, 8, 60);
    ctx.beginPath(); ctx.arc(T.x, T.y - 66, 7 + Math.sin(G.t * 6) * 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(107,224,255,.5)';
    ctx.lineWidth = 2;
    [16, 28, 40].forEach((r) => {
      ctx.beginPath();
      ctx.arc(T.x, T.y - 66, r * (0.6 + (G.t * 0.5) % 1), 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.fillStyle = '#243041';
    ctx.beginPath(); ctx.roundRect(T.x - 26, T.y, 52, 16, 4); ctx.fill();

    // bullets + gore
    G.bullets.forEach((b) => {
      ctx.fillStyle = b.gore ? '#a33b3b' : '#ffd578';
      ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
    });

    // tracer
    if (G.tracer) {
      ctx.strokeStyle = 'rgba(255,213,120,.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(G.tracer.x1, G.tracer.y1);
      ctx.lineTo(G.tracer.x2, G.tracer.y2);
      ctx.stroke();
    }

    // crosshair
    ctx.strokeStyle = 'rgba(255,255,255,.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 34, 0, Math.PI * 2);
    ctx.moveTo(w / 2 - 44, h / 2); ctx.lineTo(w / 2 - 20, h / 2);
    ctx.moveTo(w / 2 + 20, h / 2); ctx.lineTo(w / 2 + 44, h / 2);
    ctx.stroke();

    // ammo pips
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = i < G.ammo ? '#ffd578' : 'rgba(255,255,255,.12)';
      ctx.fillRect(w - 26 - i * 14, h - 26, 9, 14);
    }

    if (G.flash > 0) {
      ctx.fillStyle = `rgba(255,90,90,${G.flash * 0.45})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  let ac = null;
  function beep(freq, dur, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(); const g = ac.createGain();
      o.type = 'square'; o.frequency.value = freq; g.gain.value = gain || 0.05;
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
