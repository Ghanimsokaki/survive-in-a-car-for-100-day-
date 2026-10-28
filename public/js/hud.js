import { clamp, fmt } from './utils.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), day: $('dayNum'), dayFill: $('dayFill'), zone: $('zoneName'),
      speed: $('speedVal'), dist: $('distVal'), weather: $('weatherVal'),
      radar: $('radar'), meters: {}, vitals: $('vitals'), weapon: $('weaponRow'),
      anchorRow: $('anchorRow'), anchorBtn: $('anchorBtn'), benchBtn: $('benchBtn'), scavBtn: $('scavBtn'),
      prompt: $('prompt'), toasts: $('toasts'), storm: $('stormBanner'),
      chatLog: $('chatLog'), chatInput: $('chatInput'), party: $('party'),
      bench: $('bench'), benchTier: $('benchTier'), inv: $('invList'), recipes: $('recipeGrid'),
      tabs: [...document.querySelectorAll('.tabs button')], benchClose: $('benchClose'),
      gameover: $('gameover'), goTitle: $('goTitle'), goSub: $('goSub'), goStats: $('goStats'),
      crosshair: $('crosshair'),
    };
    document.querySelectorAll('.meter').forEach((m) => {
      this.el.meters[m.dataset.k] = { bar: m.querySelector('i'), val: m.querySelector('b') };
    });
    this.rctx = this.el.radar.getContext('2d');
    this.sweep = 0;
    this.tab = 'weapons';
    this.chatOpen = false;
    this.toastTimer = [];
    this.el.tabs.forEach((t) => t.addEventListener('click', () => {
      this.tab = t.dataset.tab;
      this.el.tabs.forEach((x) => x.classList.toggle('on', x === t));
      this.renderRecipes();
    }));
  }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() { this.el.hud.classList.add('hidden'); }

  setDay(day, progress, zoneName) {
    this.el.day.textContent = day;
    this.el.dayFill.style.width = `${clamp(progress * 100, 0, 100)}%`;
    if (zoneName) this.el.zone.textContent = zoneName;
  }
  setSpeed(kmh) { this.el.speed.textContent = Math.round(Math.abs(kmh)); }
  setDistance(km) { this.el.dist.textContent = fmt(km, 2); }
  setWeather(label, danger) {
    this.el.weather.textContent = label;
    this.el.weather.style.color = danger ? '#ff7d88' : '#6dffa8';
  }

  setDiagnostics(v) {
    const set = (k, pct, label) => {
      const m = this.el.meters[k];
      if (!m) return;
      m.bar.style.width = `${clamp(pct, 0, 100)}%`;
      m.bar.style.background = pct < 25 ? '#ff4d5e' : pct < 55 ? '#ffb347' : k === 'chassis' ? '#5ff0ff' : k === 'tires' ? '#c9a0ff' : '#6dffa8';
      m.val.textContent = label;
    };
    set('engine', v.engine, `${Math.round(v.engine)}%`);
    set('chassis', v.chassis, `${Math.round(v.chassis)}%`);
    set('tires', v.tires, `${Math.round(v.tires)}%`);
    set('fuel', (v.fuel / v.maxFuel) * 100, `${v.fuel.toFixed(1)}L`);
    this.el.vitals.textContent = `HP ${Math.max(0, Math.round(v.hp))}`;
    this.el.vitals.style.color = v.hp < 35 ? '#ff6d7b' : '#ff9aa4';
    this.el.weapon.textContent = v.weapon;
    this.el.anchorRow.textContent = v.anchored ? 'ANCHORS DEPLOYED' : `SPIKES T${v.anchorTier} READY`;
    this.el.anchorRow.style.color = v.anchored ? '#6dffa8' : '#8b93a5';
    this.el.anchorBtn.classList.toggle('on', !!v.anchored);
    this.el.anchorBtn.disabled = !v.inCar;
    this.el.anchorBtn.querySelector('.act-txt').firstChild.textContent = v.anchored ? 'RELEASE ANCHORS' : 'DEPLOY ANCHORS';
  }

  setScavengeReady(ready, label) {
    this.el.scavBtn.classList.toggle('ready', ready);
    this.el.scavBtn.disabled = !ready;
    this.el.scavBtn.querySelector('.act-txt').firstChild.textContent = ready ? `SCAVENGE ${label || ''}`.trim() : 'NO LOOT NEARBY';
  }

  prompt(text) {
    if (text) { this.el.prompt.textContent = text; this.el.prompt.classList.add('show'); }
    else this.el.prompt.classList.remove('show');
  }

  toast(msg, type = '') {
    const d = document.createElement('div');
    d.className = `toast ${type}`;
    d.textContent = msg;
    this.el.toasts.appendChild(d);
    while (this.el.toasts.children.length > 5) this.el.toasts.firstChild.remove();
    setTimeout(() => { d.style.opacity = '0'; d.style.transition = 'opacity .4s'; }, 3000);
    setTimeout(() => d.remove(), 3500);
  }

  storm(text, sub) {
    if (!text) { this.el.storm.classList.add('hidden'); return; }
    this.el.storm.innerHTML = `${text}<small>${sub || ''}</small>`;
    this.el.storm.classList.remove('hidden');
  }

  chat(name, text, color = '#ffb347', sys = false) {
    const p = document.createElement('p');
    if (sys) { p.className = 'sys'; p.textContent = text; }
    else {
      const b = document.createElement('b'); b.textContent = name; b.style.color = color;
      p.append(b, document.createTextNode(` ${text}`));
    }
    this.el.chatLog.appendChild(p);
    while (this.el.chatLog.children.length > 7) this.el.chatLog.firstChild.remove();
  }

  setParty(rows) {
    this.el.party.innerHTML = rows.map((r) => `
      <div class="party-row">
        <i class="party-dot" style="background:${r.color}"></i>
        <b style="font-weight:600">${r.name}</b>
        <span class="hp">${r.status}</span>
      </div>`).join('');
  }

  // ---------------------------------------------------------------- radar
  drawRadar(blips, heading, range = 350) {
    const ctx = this.rctx;
    const w = this.el.radar.width, h = this.el.radar.height;
    const cx = w / 2, cy = h / 2, R = w / 2 - 6;
    ctx.clearRect(0, 0, w, h);

    // scope rings
    ctx.strokeStyle = 'rgba(95,240,255,.18)';
    ctx.lineWidth = 1;
    [0.33, 0.66, 1].forEach((f) => { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); });
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    ctx.strokeStyle = 'rgba(95,240,255,.4)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

    // sweep
    this.sweep += 0.035;
    const grad = ctx.createConicGradient ? null : null;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, this.sweep, this.sweep + 0.55);
    ctx.closePath();
    ctx.fillStyle = 'rgba(95,240,255,.14)';
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(95,240,255,.75)';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(this.sweep) * R, cy + Math.sin(this.sweep) * R);
    ctx.stroke();

    // blips — north up, player at centre
    blips.forEach((b) => {
      const dx = b.x, dz = b.z;
      const d = Math.hypot(dx, dz);
      if (d > range) return;
      const px = cx + (dx / range) * R;
      const py = cy + (dz / range) * R;
      const size = b.size || 3;
      if (b.kind === 'tornado') {
        ctx.fillStyle = 'rgba(255,77,94,.85)';
        ctx.beginPath(); ctx.arc(px, py, 6 + Math.sin(performance.now() / 220) * 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,77,94,.45)';
        ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.stroke();
      } else if (b.kind === 'pit') {
        ctx.fillStyle = '#6dffa8';
        ctx.fillRect(px - size, py - size, size * 2, size * 2);
      } else if (b.kind === 'house') {
        // roofed buildings: little square with a lid
        ctx.fillStyle = b.inside ? '#ffd98a' : '#c9b48e';
        ctx.fillRect(px - size, py - size, size * 2, size * 2);
        ctx.strokeStyle = 'rgba(28,22,16,.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px - size - 1, py - size);
        ctx.lineTo(px, py - size - 3);
        ctx.lineTo(px + size + 1, py - size);
        ctx.stroke();
      } else if (b.kind === 'enemy') {
        ctx.fillStyle = '#ff9a3c';
        ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
      } else if (b.kind === 'peer') {
        ctx.fillStyle = b.color || '#5ff0ff';
        ctx.beginPath(); ctx.arc(px, py, size + 0.6, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.6)';
        ctx.lineWidth = 1; ctx.stroke();
      }
    });

    // player marker
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-heading);
    ctx.fillStyle = '#ffe6b8';
    ctx.beginPath();
    ctx.moveTo(0, -7); ctx.lineTo(5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5, 6);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = 'rgba(95,240,255,.65)';
    ctx.font = 'bold 9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', cx, 12);
  }

  // ------------------------------------------------------------ workbench
  openBench(tier, inv, recipes) {
    this.tier = tier; this.inv = inv; this.recipes = recipes;
    this.el.bench.classList.add('show');
    this.el.benchTier.textContent = `TIER ${tier}`;
    this.renderInv();
    this.renderRecipes();
  }
  closeBench() { this.el.bench.classList.remove('show'); }
  get benchOpen() { return this.el.bench.classList.contains('show'); }

  renderInv() {
    if (!this.inv) return;
    const names = {
      scrap: 'SCRAP METAL', steel: 'STEEL PLATES', titanium: 'TITANIUM ALLOY',
      carbon: 'HIGH-CARBON STEEL', leather: 'LEATHER STRAPS', chem: 'CHEM COMPOUNDS',
      cores: 'SWORD CORES',
    };
    this.el.inv.innerHTML = Object.entries(names).map(([k, label]) =>
      `<li><span>${label}</span><b>${this.inv[k] || 0}</b></li>`).join('');
  }

  renderRecipes() {
    if (!this.recipes) return;
    const list = this.recipes.filter((r) => r.tab === this.tab);
    this.el.recipes.innerHTML = list.map((r) => {
      const affordable = Object.entries(r.cost).every(([k, v]) => (this.inv[k] || 0) >= v);
      const tierOk = (r.tierReq || 1) <= this.tier;
      const owned = r.unique && this.ownedWeapons?.includes(r.givesWeapon);
      const can = affordable && tierOk && !owned && !r.maxed;
      const cost = Object.entries(r.cost).map(([k, v]) => {
        const ok = (this.inv[k] || 0) >= v;
        return `<i class="${ok ? '' : 'no'}">${v}× ${k.toUpperCase()}</i>`;
      }).join('');
      const badge = r.tier ? `<span class="recipe-tier t${r.tier}">T${r.tier}</span>` : '';
      const req = tierOk ? '' : ` · REQUIRES TIER ${r.tierReq}`;
      return `<div class="recipe" data-id="${r.id}">
        <div class="recipe-top">
          <span class="recipe-name">${r.name}</span>${badge}
        </div>
        <div class="recipe-desc">${r.desc}${req}</div>
        <div class="recipe-cost">${cost}</div>
        <button class="recipe-btn" data-craft="${r.id}" ${can ? '' : 'disabled'}>
          ${owned ? 'EQUIPPED / OWNED' : r.maxed ? 'MAXED' : 'CRAFT'}
        </button>
      </div>`;
    }).join('');
    this.el.recipes.querySelectorAll('.recipe-btn').forEach((b) => {
      b.addEventListener('click', () => this.onCraft?.(b.dataset.craft));
    });
  }

  refreshBench() {
    if (!this.inv) return;
    this.renderInv();
    this.renderRecipes();
  }

  showGameOver(title, sub, stats) {
    this.el.goTitle.textContent = title;
    this.el.goSub.textContent = sub;
    this.el.goStats.innerHTML = stats.map((s) => `<div><span>${s.k}</span><b>${s.v}</b></div>`).join('');
    this.el.gameover.classList.add('show');
  }
  hideGameOver() { this.el.gameover.classList.remove('show'); }
}
