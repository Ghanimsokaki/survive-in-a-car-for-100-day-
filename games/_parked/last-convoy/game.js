/* LAST CONVOY — escort a fuel truck down an endless highway.
 * Pure canvas 2D, no dependencies, ~200 lines. Reference implementation for
 * community submissions: read the manifest, call Arcade.ready(), then game on.
 */
(() => {
  'use strict';
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  const $ = (id) => document.getElementById(id);

  const G = {
    running: false,
    over: false,
    t: 0,
    dist: 0,            // metres travelled
    kills: 0,
    hpTruck: 100,
    hpCar: 100,
    scroll: 0,
    cars: [],           // {x,y,vx,vy,hp}
    raiders: [],        // {x,y,hp,rate}
    shots: [],
    debris: [],
    keys: {},
    fire: 0,
    spawn: 0,
    touch: { active: false, x: 0, aim: 0, tapFire: false },
    targetDist: 2400,
  };

  const LANES = [-1, -0.55, 0, 0.55, 1];

  function reset() {
    Object.assign(G, {
      running: true, over: false, t: 0, dist: 0, kills: 0, hpTruck: 100, hpCar: 100,
      scroll: 0, cars: [], raiders: [], shots: [], debris: [], spawn: 0, fire: 0,
    });
    G.cars.push({ x: 0, y: 0, vx: 0, vy: 0 });
    $('intro').classList.add('hidden');
    $('over').classList.add('hidden');
  }

  // ---------------------------------------------------------------- input
  addEventListener('keydown', (e) => {
    G.keys[e.key.toLowerCase()] = true;
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
    if (e.key === ' ' && !G.running) reset();
  });
  addEventListener('keyup', (e) => { G.keys[e.key.toLowerCase()] = false; });

  const onTouch = (e) => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    const x = (p.clientX - r.left) / r.width;
    const y = (p.clientY - r.top) / r.height;
    if (x < 0.5) {
      G.touch.active = true;
      G.touch.x = (x - 0.25) * 2.4;   // -0.6..0.6 steering
      G.touch.aim = (y - 0.5) * 2;
    } else if (e.type === 'touchstart' || e.type === 'mousedown') {
      G.touch.tapFire = true;
    }
  };
  canvas.addEventListener('touchstart', onTouch, { passive: true });
  canvas.addEventListener('touchmove', onTouch, { passive: true });
  canvas.addEventListener('touchend', () => { G.touch.active = false; });
  canvas.addEventListener('mousedown', onTouch);
  canvas.addEventListener('mousemove', (e) => { if (e.buttons) onTouch(e); });
  canvas.addEventListener('mouseup', () => { G.touch.active = false; });

  $('go').addEventListener('click', reset);
  $('again').addEventListener('click', reset);

  // ------------------------------------------------------------ simulation
  const W = () => canvas.clientWidth;
  const H = () => canvas.clientHeight;

  function spawnWave(dt) {
    G.spawn -= dt;
    if (G.spawn > 0) return;
    G.spawn = Math.max(0.45, 1.5 - G.dist / 900);
    const lane = LANES[(Math.random() * LANES.length) | 0];
    const fromLeft = Math.random() < 0.5;
    if (Math.random() < 0.72) {
      G.raiders.push({
        x: lane * W() * 0.34,
        y: -H() * 0.15,
        hp: 1 + (G.dist > 1200 ? 1 : 0),
        rate: 1.1 + Math.random() * 0.8,
        cd: 1,
      });
    } else {
      G.debris.push({ x: lane * W() * 0.34 + (fromLeft ? -20 : 20), y: -40, vy: 220 + Math.random() * 120 });
    }
  }

  function update(dt) {
    if (!G.running) return;
    G.t += dt;
    const speed = 300 + Math.min(220, G.dist / 14);
    G.scroll += speed * dt;
    G.dist += speed * dt * 0.012;

    // player
    const car = G.cars[0];
    const kx = (G.keys.d || G.keys.arrowright ? 1 : 0) - (G.keys.a || G.keys.arrowleft ? 1 : 0);
    const steer = G.touch.active ? G.touch.x : kx;
    car.x += steer * 420 * dt;
    car.x = Math.max(-W() * 0.44, Math.min(W() * 0.44, car.x));
    car.y = H() * 0.72;

    // shooting
    G.fire -= dt;
    const wantFire = G.keys[' '] || G.keys.enter || G.touch.tapFire;
    G.touch.tapFire = false;
    if (wantFire && G.fire <= 0) {
      G.fire = 0.14;
      G.shots.push({ x: car.x, y: car.y - 22 });
      beep(660, 0.04, 0.05);
    }
    G.shots.forEach((s) => { s.y -= 760 * dt; });
    G.shots = G.shots.filter((s) => s.y > -30);

    spawnWave(dt);

    // raiders drift down and shoot at the truck
    G.raiders.forEach((r) => {
      r.y += (speed * 0.55) * dt;
      r.x += Math.sin(G.t * 1.6 + r.y * 0.01) * 26 * dt;
      r.cd -= dt;
      if (r.cd <= 0 && r.y > 0) {
        r.cd = r.rate;
        G.shots.push({ x: r.x, y: r.y + 14, hostile: true });
      }
    });

    // hostile shots
    G.shots.forEach((s) => {
      if (!s.hostile) return;
      s.y += 430 * dt;
      if (Math.abs(s.x - car.x) < 20 && Math.abs(s.y - car.y) < 22 && G.hpCar > 0) {
        s.dead = true;
        hit(6, 'car');
      }
    });

    // collisions with the rig
    G.raiders.forEach((r) => {
      G.shots.forEach((s) => {
        if (s.hostile || s.dead) return;
        if (Math.abs(s.x - r.x) < 18 && Math.abs(s.y - r.y) < 20) {
          s.dead = true;
          r.hp -= 1;
          if (r.hp <= 0) { r.dead = true; G.kills += 1; beep(320, 0.06, 0.06); }
        }
      });
      if (Math.abs(r.x - car.x) < 24 && Math.abs(r.y - car.y) < 26) { r.dead = true; hit(10, 'car'); }
    });
    G.debris.forEach((d) => {
      d.y += d.vy * dt;
      if (Math.abs(d.x - car.x) < 22 && Math.abs(d.y - car.y) < 26) { d.dead = true; hit(8, 'car'); }
    });

    G.shots = G.shots.filter((s) => !s.dead);
    G.raiders = G.raiders.filter((r) => !r.dead && r.y < H() + 60);
    G.debris = G.debris.filter((d) => !d.dead && d.y < H() + 60);

    // the truck never stops: it takes damage when it is left alone
    const truckStress = G.raiders.filter((r) => Math.abs(r.x) < W() * 0.3).length;
    if (truckStress > 0) G.hpTruck -= truckStress * 3.2 * dt;
    if (G.hpCar <= 0) end(false, 'YOUR RIG IS WRECKED');
    if (G.hpTruck <= 0) end(false, 'THE TRUCK IS LOST');
    if (G.dist >= G.targetDist) end(true, 'CONVOY DELIVERED');

    $('hp').textContent = `${Math.max(0, Math.round(G.hpTruck))}%`;
    $('hpbar').style.width = `${Math.max(0, G.hpTruck)}%`;
    $('dist').textContent = (G.dist / 100).toFixed(1);
    $('kills').textContent = String(G.kills);
  }

  function hit(amount, who) {
    if (who === 'car') G.hpCar -= amount; else G.hpTruck -= amount;
    flash = 0.12;
    beep(140, 0.08, 0.07);
  }

  function end(won, reason) {
    if (G.over) return;
    G.running = false;
    G.over = true;
    $('overTitle').textContent = won ? 'CONVOY DELIVERED' : 'CONVOY LOST';
    $('overText').innerHTML = `${reason}<br />${(G.dist / 100).toFixed(1)} KM · ${G.kills} RAIDERS DOWN`;
    $('over').classList.remove('hidden');
    const score = Math.round(G.dist * 2 + G.kills * 60 + (won ? 900 : 0));
    Arcade.score({ score, day: Math.round(G.dist / 100), seconds: Math.round(G.t), won, meta: reason });
  }

  // ----------------------------------------------------------------- render
  let flash = 0;
  function draw() {
    const w = W(), h = H();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);

    // road
    ctx.fillStyle = '#141821';
    ctx.fillRect(w * 0.06, 0, w * 0.88, h);
    ctx.strokeStyle = 'rgba(255,179,71,.25)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w * 0.06, 0); ctx.lineTo(w * 0.06, h);
    ctx.moveTo(w * 0.94, 0); ctx.lineTo(w * 0.94, h); ctx.stroke();

    // lane dashes
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 3;
    const off = (G.scroll * 0.6) % 120;
    for (const lx of [-0.5, 0.5]) {
      for (let y = -120 + off; y < h + 120; y += 120) {
        ctx.beginPath();
        ctx.moveTo(w / 2 + lx * w * 0.34, y);
        ctx.lineTo(w / 2 + lx * w * 0.34, y + 54);
        ctx.stroke();
      }
    }

    // kerb stripes
    for (let y = -60 + off; y < h; y += 60) {
      ctx.fillStyle = (Math.floor((y + G.scroll * 0.6) / 60) % 2) ? '#1b2130' : '#232b3b';
      ctx.fillRect(w * 0.045, y, w * 0.015, 30);
      ctx.fillRect(w * 0.94, y, w * 0.015, 30);
    }

    // the truck
    const tx = 0, ty = h * 0.24;
    ctx.save();
    ctx.translate(w / 2 + tx, ty);
    ctx.fillStyle = '#c8a06a';
    ctx.fillRect(-34, -44, 68, 96);
    ctx.fillStyle = '#e8d3a8';
    ctx.fillRect(-24, -34, 48, 30);
    ctx.fillStyle = '#3b4c63';
    ctx.fillRect(-30, 20, 60, 34);
    ctx.fillStyle = '#15171c';
    [-30, 30].forEach((x) => [-40, 26].forEach((y) => ctx.fillRect(x - 6, y - 6, 12, 20)));
    ctx.fillStyle = 'rgba(255,179,71,.9)';
    ctx.fillRect(-30, -50, 8, 6); ctx.fillRect(22, -50, 8, 6);
    ctx.restore();

    // debris
    ctx.fillStyle = '#4a5262';
    G.debris.forEach((d) => {
      ctx.save(); ctx.translate(w / 2 + d.x, d.y); ctx.rotate(d.y * 0.01);
      ctx.fillRect(-10, -7, 20, 14); ctx.restore();
    });

    // raiders
    G.raiders.forEach((r) => {
      ctx.save(); ctx.translate(w / 2 + r.x, r.y);
      ctx.fillStyle = '#8c2f3a';
      ctx.beginPath(); ctx.moveTo(0, -18); ctx.lineTo(15, 14); ctx.lineTo(-15, 14); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ff6d7b';
      ctx.fillRect(-3, -8, 6, 10);
      ctx.restore();
    });

    // shots
    G.shots.forEach((s) => {
      ctx.fillStyle = s.hostile ? '#ff6d7b' : '#6be0ff';
      ctx.fillRect(w / 2 + s.x - 2, s.y - (s.hostile ? 0 : 10), 4, 14);
    });

    // player rig
    const car = G.cars[0];
    if (car) {
      ctx.save();
      ctx.translate(w / 2 + car.x, car.y);
      ctx.fillStyle = G.hpCar > 0 ? '#d24a2b' : '#3a2a26';
      ctx.beginPath();
      ctx.moveTo(0, -26); ctx.lineTo(20, 6); ctx.lineTo(14, 26);
      ctx.lineTo(-14, 26); ctx.lineTo(-20, 6); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#8fd0ff';
      ctx.fillRect(-9, -12, 18, 12);
      ctx.fillStyle = 'rgba(255,236,180,.85)';
      ctx.beginPath(); ctx.moveTo(-14, -26); ctx.lineTo(-4, -46); ctx.lineTo(0, -26); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(14, -26); ctx.lineTo(4, -46); ctx.lineTo(0, -26); ctx.closePath(); ctx.fill();
      ctx.restore();
    }

    if (flash > 0) {
      ctx.fillStyle = `rgba(255,120,120,${flash * 1.4})`;
      ctx.fillRect(0, 0, w, h);
    }

    // speed streaks
    ctx.strokeStyle = 'rgba(255,255,255,.05)';
    for (let i = 0; i < 14; i++) {
      const x = (i * 97 + 31) % w;
      const y = (G.scroll * (0.9 + (i % 3) * 0.3) + i * 83) % h;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 26); ctx.stroke();
    }
  }

  // ------------------------------------------------------------------ audio
  let ac = null;
  function beep(freq, dur, gain) {
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.value = gain || 0.05;
      o.connect(g).connect(ac.destination);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.stop(ac.currentTime + dur + 0.02);
    } catch { /* audio is optional */ }
  }

  // -------------------------------------------------------------- main loop
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    flash = Math.max(0, flash - dt);
    Arcade.fit(canvas, 2);
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  Arcade.ready();
  requestAnimationFrame(frame);
})();
