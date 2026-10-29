/* PIT STOP PANIC — patch the rig before the infected reach the bay.
 * Tap the glowing bolts; each stage (hood → tank → tyres) must be finished
 * before the wave timer expires. Miss a wave and the bay takes damage.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const STAGES = [
    { name: 'HOOD', bolts: 5, colour: '#ffd578' },
    { name: 'FUEL TANK', bolts: 6, colour: '#6dffa8' },
    { name: 'TYRES', bolts: 7, colour: '#6be0ff' },
  ];

  const G = {
    running: false, over: false, t: 0, stage: 0, hp: 100, fuel: 0,
    bolts: [], nextBolt: 0, wave: 0, waveTimer: 0, walkers: [], kills: 0, score: 0,
    flash: 0, combo: 0,
  };

  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  function reset() {
    Object.assign(G, {
      running: true, over: false, t: 0, stage: 0, hp: 100, fuel: 0, bolts: [],
      nextBolt: 0, wave: 0, waveTimer: 3, walkers: [], kills: 0, score: 0, flash: 0, combo: 0,
    });
    spawnBolt();
    $('intro').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  function spawnBolt() {
    const stage = STAGES[G.stage];
    if (!stage || G.bolts.length >= 3) return;
    if (G.stage === 1 && G.fuel >= 100) return;
    if (G.stage === 2 && G.hp >= 100) return;
    const r = Math.min(W(), H()) * 0.3;
    const a = Math.random() * Math.PI * 2;
    G.bolts.push({
      x: W() * 0.5 + Math.cos(a) * r,
      y: H() * 0.52 + Math.sin(a) * r * 0.62,
      r: 0,
      life: 3.4,
      max: 3.4,
      stage: G.stage,
      colour: stage.colour,
    });
    G.nextBolt = 0.35 + Math.random() * 0.5;
  }

  function applyBolt(b) {
    G.combo += 1;
    beep(520 + G.combo * 40, 0.05, 0.06);
    if (b.stage === 0) {
      G.hp = Math.min(100, G.hp + 4);
    } else if (b.stage === 1) {
      G.fuel = Math.min(100, G.fuel + 7);
    } else {
      G.hp = Math.min(100, G.hp + 3);
      G.fuel = Math.min(100, G.fuel + 2);
    }
    G.score += 25 + G.combo * 5;
    if (G.stage === 0 && G.combo >= STAGES[0].bolts) { G.stage = 1; G.combo = 0; toast('TANK ONLINE'); }
    else if (G.stage === 1 && G.fuel >= 100) { G.stage = 2; G.combo = 0; toast('TANK FULL — TYRES'); }
    else if (G.stage === 2 && G.hp >= 100 && G.fuel >= 100) { nextWave(); }
  }

  let toastText = '';
  let toastAt = 0;
  function toast(t) { toastText = t; toastAt = 1.6; }

  function nextWave() {
    G.wave += 1;
    G.stage = 0;
    G.combo = 0;
    G.hp = Math.max(20, G.hp - 12);
    G.waveTimer = 2.5;
    toast(`WAVE ${G.wave} — PATCH THE HOOD`);
    beep(220, 0.12, 0.08);
  }

  // ---------------------------------------------------------------- input
  function pointer(e) {
    if (!G.running) return;
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const x = p.clientX - r.left;
    const y = p.clientY - r.top;
    for (let i = G.bolts.length - 1; i >= 0; i--) {
      const b = G.bolts[i];
      if (Math.hypot(b.x - x, b.y - y) < Math.max(26, b.r + 16)) {
        applyBolt(b);
        G.bolts.splice(i, 1);
        spawnBolt();
        return;
      }
    }
    G.combo = 0; // a miss breaks the streak
  }
  canvas.addEventListener('mousedown', pointer);
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); pointer(e); }, { passive: false });
  $('go').addEventListener('click', reset);
  $('again').addEventListener('click', reset);

  // ------------------------------------------------------------ simulation
  function update(dt) {
    if (!G.running) return;
    G.t += dt;
    G.flash = Math.max(0, G.flash - dt * 3);
    toastAt = Math.max(0, toastAt - dt);

    G.nextBolt -= dt;
    if (G.nextBolt <= 0 && G.bolts.length < 3) spawnBolt();

    // bolts decay: leave one too long and the bay loses ground
    for (let i = G.bolts.length - 1; i >= 0; i--) {
      const b = G.bolts[i];
      b.life -= dt;
      b.r = Math.min(26, b.r + dt * 90);
      if (b.life <= 0) {
        G.bolts.splice(i, 1);
        G.hp -= 3;
        G.combo = 0;
        G.flash = 0.5;
        beep(120, 0.1, 0.07);
        spawnBolt();
      }
    }

    // the horde
    G.waveTimer -= dt;
    if (G.waveTimer <= 0) {
      G.waveTimer = Math.max(7, 16 - G.wave * 0.9);
      const n = 1 + Math.floor(G.wave / 2);
      for (let i = 0; i < n; i++) {
        G.walkers.push({
          x: Math.random() < 0.5 ? -20 : W() + 20,
          y: H() * (0.55 + Math.random() * 0.35),
          sp: 22 + G.wave * 3 + Math.random() * 8,
        });
      }
      toast('THEY ARE COMING');
    }
    G.walkers.forEach((w) => {
      const tx = W() * 0.5, ty = H() * 0.6;
      const dx = tx - w.x, dy = ty - w.y;
      const d = Math.hypot(dx, dy) || 1;
      w.x += (dx / d) * w.sp * dt;
      w.y += (dy / d) * w.sp * dt;
      if (d < 46) {
        w.reached = true;
        G.hp -= 9;
        G.flash = 0.6;
        beep(90, 0.16, 0.09);
      }
    });
    G.walkers = G.walkers.filter((w) => !w.reached);

    if (G.hp <= 0) end();
    if (G.hp > 100) G.hp = 100;

    $('hp').textContent = `${Math.round(G.hp)}%`;
    $('fuel').textContent = `${Math.round(G.fuel)}%`;
    $('time').textContent = String(Math.max(0, Math.ceil(G.waveTimer)));
    $('wave').textContent = String(G.wave);
  }

  function end() {
    G.running = false;
    G.over = true;
    $('overTitle').textContent = 'BAY OVERRUN';
    $('overText').innerHTML = `You held ${G.wave} wave${G.wave === 1 ? '' : 's'} and patched ${Math.round(G.score / 25)} bolts.`;
    $('over').classList.remove('hidden');
    Arcade.score({ score: Math.round(G.score + G.wave * 120), day: G.wave, seconds: Math.round(G.t), won: G.wave >= 5, meta: `${G.wave} waves` });
  }

  // ----------------------------------------------------------------- render
  function draw() {
    const w = W(), h = H();
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    // bay floor
    ctx.fillStyle = '#12161f';
    ctx.fillRect(w * 0.18, h * 0.28, w * 0.64, h * 0.5);
    ctx.strokeStyle = 'rgba(109,255,168,.14)';
    ctx.lineWidth = 2;
    ctx.strokeRect(w * 0.18, h * 0.28, w * 0.64, h * 0.5);

    // the rig
    const cx = w * 0.5, cy = h * 0.54;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#7a2f22';
    ctx.beginPath(); ctx.roundRect(-92, -52, 184, 104, 12); ctx.fill();
    ctx.fillStyle = '#9c3a2a';
    ctx.beginPath(); ctx.roundRect(-78, -38, 156, 76, 9); ctx.fill();
    ctx.fillStyle = '#243041';
    ctx.beginPath(); ctx.roundRect(-40, -26, 80, 34, 5); ctx.fill();
    // damage tint
    ctx.fillStyle = `rgba(255,80,90,${(100 - G.hp) / 260})`;
    ctx.beginPath(); ctx.roundRect(-92, -52, 184, 104, 12); ctx.fill();
    ctx.restore();

    // stage banner
    const stage = STAGES[Math.min(G.stage, STAGES.length - 1)];
    ctx.fillStyle = stage.colour;
    ctx.font = '700 12px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`PATCHING: ${stage.name}`, cx, h * 0.82);

    // bolts
    G.bolts.forEach((b) => {
      const pulse = 1 + Math.sin(G.t * 8) * 0.12;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.strokeStyle = b.colour;
      ctx.globalAlpha = Math.max(0.25, b.life / b.max);
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, b.r * pulse, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, b.r * pulse * 0.55, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = b.colour;
      ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.globalAlpha = 1;

    // walkers
    G.walkers.forEach((wk) => {
      ctx.fillStyle = '#5f7a52';
      ctx.beginPath(); ctx.arc(wk.x, wk.y, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#9fbf88';
      ctx.beginPath(); ctx.arc(wk.x, wk.y - 4, 5, 0, Math.PI * 2); ctx.fill();
    });

    // combo + toast
    if (G.combo > 1) {
      ctx.fillStyle = '#6dffa8';
      ctx.font = '700 22px ui-monospace,monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`×${G.combo}`, cx, h * 0.2);
    }
    if (toastAt > 0) {
      ctx.globalAlpha = Math.min(1, toastAt);
      ctx.fillStyle = '#ffd578';
      ctx.font = '700 13px ui-monospace,monospace';
      ctx.fillText(toastText, cx, h * 0.16);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'left';

    if (G.flash > 0) {
      ctx.fillStyle = `rgba(255,90,90,${G.flash * 0.5})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  // ------------------------------------------------------------------ audio
  let ac = null;
  function beep(freq, dur, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(); const g = ac.createGain();
      o.type = 'triangle'; o.frequency.value = freq; g.gain.value = gain || 0.05;
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
