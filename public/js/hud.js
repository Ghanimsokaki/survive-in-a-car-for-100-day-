import { clamp, fmt } from './utils.js';
import { freshLabels, TRACKED, fmtValue } from './records.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.el = {
      hud: $('hud'), day: $('dayNum'), dayFill: $('dayFill'), zone: $('zoneName'),
      speed: $('speedVal'), dist: $('distVal'), weather: $('weatherVal'),
      radar: $('radar'), meters: {}, vitals: $('vitals'), weapon: $('weaponRow'),
      anchorRow: $('anchorRow'), dayGoal: $('dayGoal'), modeTag: $('modeTag'), fpsRow: $('fpsRow'),
      bestRow: $('bestRow'), anchorBtn: $('anchorBtn'), benchBtn: $('benchBtn'), scavBtn: $('scavBtn'),
      prompt: $('prompt'), toasts: $('toasts'), storm: $('stormBanner'), stormMeter: $('stormMeter'),
      chatLog: $('chatLog'), chatInput: $('chatInput'), party: $('party'),
      bench: $('bench'), benchTier: $('benchTier'), inv: $('invList'), recipes: $('recipeGrid'),
      systems: $('rigSystems'),
      tabs: [...document.querySelectorAll('.tabs button')], benchClose: $('benchClose'),
      search: $('recipeSearch'), count: $('recipeCount'), page: $('recipePage'),
      affordable: $('recipeAffordable'),
      prev: $('recipePrev'), next: $('recipeNext'),
      gameover: $('gameover'), goTitle: $('goTitle'), goSub: $('goSub'), goStats: $('goStats'),
      goRecord: $('goRecord'),
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
    this.page = 0;
    this.pageSize = 24;
    this.search = '';
    this.affordableOnly = (() => {
      try { return localStorage.getItem('outrun-bench-filter') === '1'; } catch { return false; }
    })();
    if (this.el.affordable) this.el.affordable.classList.toggle('on', this.affordableOnly);
    this.el.tabs.forEach((t) => t.addEventListener('click', () => {
      this.tab = t.dataset.tab;
      this.page = 0;
      this.el.tabs.forEach((x) => x.classList.toggle('on', x === t));
      this.renderRecipes();
    }));
    this.el.search?.addEventListener('input', () => {
      this.search = this.el.search.value.trim().toLowerCase();
      this.page = 0;
      this.renderRecipes();
    });
    this.el.prev?.addEventListener('click', () => { this.page = Math.max(0, this.page - 1); this.renderRecipes(); });
    this.el.next?.addEventListener('click', () => { this.page += 1; this.renderRecipes(); });
    this.el.affordable?.addEventListener('click', () => {
      this.affordableOnly = !this.affordableOnly;
      this.el.affordable.classList.toggle('on', this.affordableOnly);
      try { localStorage.setItem('outrun-bench-filter', this.affordableOnly ? '1' : '0'); } catch { /* ignore */ }
      this.page = 0;
      this.renderRecipes();
    });
  }

  show() { this.el.hud.classList.remove('hidden'); }
  hide() { this.el.hud.classList.add('hidden'); }

  setDay(day, progress, zoneName, mode) {
    this.el.day.textContent = day;
    if (mode && this.el.dayGoal) this.el.dayGoal.textContent = Number.isFinite(mode.targetDay) ? `/${mode.targetDay}` : '';
    if (mode && this.el.modeTag) this.el.modeTag.textContent = mode.name;
    this.el.dayFill.style.width = `${clamp(progress * 100, 0, 100)}%`;
    if (zoneName) this.el.zone.textContent = zoneName;
  }
  /** Personal best for the mode you are playing, shown under the day counter. */
  setBest(day, worldRecord = false) {
    const el = this.el.bestRow;
    if (!el) return;
    const best = Math.round(Number(day) || 0);
    if (!best) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = `BEST DAY ${best}`;
    el.classList.toggle('new', Boolean(worldRecord));
  }

  /** Mode chip in the top bar (called with the live mode object). */
  setMode(mode) {
    if (!mode) return;
    if (this.el.modeTag) this.el.modeTag.textContent = mode.name;
    if (this.el.dayGoal) this.el.dayGoal.textContent = Number.isFinite(mode.targetDay) ? `/${mode.targetDay}` : '';
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
    const anchorPips = '●'.repeat(v.anchorTier || 1) + '○'.repeat(Math.max(0, 4 - (v.anchorTier || 1)));
    this.el.anchorRow.textContent = v.anchored
      ? `ANCHORED T${v.anchorTier} ${anchorPips} · TAP TO RELEASE`
      : `ANCHORS T${v.anchorTier} ${anchorPips}`;
    if (this.el.fpsRow && typeof v.fps === 'number') this.el.fpsRow.textContent = `${v.fps} FPS`;
    this.el.anchorRow.style.color = v.anchored ? '#6dffa8' : '#8b93a5';
    this.el.anchorBtn.classList.toggle('on', !!v.anchored);
    this.el.anchorBtn.disabled = !v.inCar;
    this.el.anchorBtn.querySelector('.act-txt').firstChild.textContent = v.anchored ? 'RELEASE ANCHORS' : 'DEPLOY ANCHORS';
  }

  setScavengeReady(ready, label) {
    this.el.scavBtn.classList.toggle('ready', ready);
    this.el.scavBtn.disabled = !ready;
    // keep the label inside the button: building names can be long
    const clean = String(label || '').replace(/\s+/g, ' ').trim();
    let text = ready ? `SCAVENGE ${clean}`.trim() : 'NO LOOT NEARBY';
    if (text.length > 26) text = `${text.slice(0, 25).trimEnd()}…`;
    const node = this.el.scavBtn.querySelector('.act-txt');
    if (node && node.firstChild) node.firstChild.textContent = text;
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

  /**
   * Live vortex readout while a storm is on you: category, range, how hard it
   * is pulling, and what your spikes are doing about it. This is the piece the
   * anchor upgrades are actually visible in.
   */
  stormMeter(info) {
    const el = this.el.stormMeter;
    if (!el) return;
    if (!info) { el.classList.add('hidden'); this._meterKey = ''; return; }
    const cat = Math.max(1, Math.min(5, Math.round(info.category || 1)));
    const dist = Math.max(0, Math.round(info.dist || 0));
    const pull = Math.round((info.pull || 0) * 100);
    const slip = info.slip ?? 1;
    let state;
    let kind;
    if (!info.inCar) { state = 'ON FOOT · RUN'; kind = 'bad'; }
    else if (!info.anchored) { state = 'SPIKES UP — ANCHOR NOW'; kind = 'bad'; }
    else if (slip === 0) { state = `GROUND LOCK · HOLDS CAT ${cat}`; kind = 'good'; }
    else if (slip < 0.15) { state = `HOLDING ${Math.round((1 - slip) * 100)}% · T${info.tier}`; kind = 'ok'; }
    else { state = `SLIPPING ${Math.round(slip * 100)}% · UPGRADE ANCHORS`; kind = 'bad'; }
    const key = `${cat}|${dist}|${pull}|${kind}|${state}`;
    if (this._meterKey === key) return;
    this._meterKey = key;
    el.className = `storm-meter ${kind}`;
    el.innerHTML = `<b>CAT ${cat}</b>
      <span class="sm-bar"><i style="width:${Math.max(6, pull)}%"></i></span>
      <em>${dist} M · ${state}</em>`;
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
        // blip grows + brightens with the category, so a Cat 5 reads as a
        // threat from across the map instead of the same dot as a Cat 1
        const cat = Math.max(1, Math.min(5, b.cat || 2));
        const r = 4 + cat * 1.7 + Math.sin(performance.now() / 220) * 1.4;
        ctx.fillStyle = cat >= 4 ? 'rgba(255,90,60,.95)' : 'rgba(255,77,94,.85)';
        ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = cat >= 4 ? 'rgba(255,140,90,.55)' : 'rgba(255,77,94,.45)';
        ctx.beginPath(); ctx.arc(px, py, r + 5, 0, Math.PI * 2); ctx.stroke();
        if (b.chase) {
          ctx.strokeStyle = 'rgba(255,255,255,.6)';
          ctx.beginPath(); ctx.arc(px, py, r + 8, 0, Math.PI * 2); ctx.stroke();
        }
      } else if (b.kind === 'pit') {
        ctx.fillStyle = '#6dffa8';
        ctx.fillRect(px - size, py - size, size * 2, size * 2);
      } else if (b.kind === 'house') {
        // roofed buildings: little square with a lid
        ctx.fillStyle = b.inside ? '#ffd98a' : b.ready === false ? '#6f6455' : '#c9b48e';
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
  openBench(tier, inv, recipes, systems) {
    this.tier = tier; this.inv = inv; this.recipes = recipes;
    if (systems) this.systems = systems;
    this.el.bench.classList.add('show');
    this.el.benchTier.textContent = `TIER ${tier}`;
    this.renderInv();
    this.renderSystems();
    this.renderRecipes();
  }

  /**
   * Pinned rig-upgrade strip. The anchor set lives here on *every* tab so it
   * can't disappear into page 4 of a thousand generated recipes.
   */
  renderSystems() {
    const host = this.el.systems;
    if (!host || !this.systems) return;
    host.innerHTML = this.systems.map((s) => {
      const pips = Array.from({ length: s.maxLevel }, (_, i) =>
        `<i class="${i < s.level ? 'on' : ''}"></i>`).join('');
      const cost = Object.entries(s.cost || {}).map(([k, v]) => {
        const ok = (this.inv[k] || 0) >= v;
        return `<em class="${ok ? '' : 'no'}">${v}× ${k.toUpperCase()}</em>`;
      }).join('') || '<em>READY</em>';
      const can = !s.maxed && s.affordable && s.tierOk;
      return `<div class="sys" data-sys="${s.key}">
        <span class="sys-ico">${s.icon}</span>
        <div class="sys-main">
          <b>${s.label}<u>T${s.level}/${s.maxLevel}</u></b>
          <span class="sys-blurb">${s.current} — ${s.blurb}</span>
          <span class="sys-next">${s.nextLabel}</span>
        </div>
        <div class="sys-right">
          <span class="sys-pips">${pips}</span>
          <span class="sys-cost">${cost}</span>
          <button class="sys-btn" data-craft="${s.recipe}" ${can ? '' : 'disabled'}>
            ${s.maxed ? 'MAXED' : s.affordable ? (s.key === 'anchors' ? 'UPGRADE ⚓' : 'CRAFT') : 'NEED MATS'}
          </button>
        </div>
      </div>`;
    }).join('');
    host.querySelectorAll('.sys-btn').forEach((b) => {
      b.addEventListener('click', () => this.onCraft?.(b.dataset.craft));
    });
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
    let list = this.recipes.filter((r) => r.tab === this.tab);
    if (this.affordableOnly) {
      // rig-track cards carry their next-tier price, so this filter also answers
      // "can I afford the anchor upgrade I just looked at?"
      list = list.filter((r) => !r.maxed && Object.entries(r.cost || {})
        .every(([k, v]) => (this.inv[k] || 0) >= v));
    }
    if (this.search) {
      const q = this.search;
      list = list.filter((r) => r.name.toLowerCase().includes(q) || String(r.desc || '').toLowerCase().includes(q));
    }
    const pages = Math.max(1, Math.ceil(list.length / this.pageSize));
    if (this.page > pages - 1) this.page = pages - 1;
    if (this.page < 0) this.page = 0;
    const start = this.page * this.pageSize;
    const slice = list.slice(start, start + this.pageSize);

    if (this.el.count) this.el.count.textContent = `${list.length} RECIPES`;
    if (this.el.page) this.el.page.textContent = `PAGE ${this.page + 1} / ${pages}`;
    if (this.el.prev) this.el.prev.disabled = this.page <= 0;
    if (this.el.next) this.el.next.disabled = this.page >= pages - 1;

    if (!slice.length) {
      this.el.recipes.innerHTML = `<p class="recipe-empty">No recipes match “${this.search || this.tab}”.</p>`;
      return;
    }

    this.el.recipes.innerHTML = slice.map((r) => {
      const affordable = Object.entries(r.cost).every(([k, v]) => (this.inv[k] || 0) >= v);
      const tierOk = (r.tierReq || 1) <= this.tier;
      const owned = r.unique && this.ownedWeapons?.includes(r.givesWeapon || r.weapon);
      const can = affordable && tierOk && !owned && !r.maxed;
      const cost = Object.entries(r.cost).map(([k, v]) => {
        const ok = (this.inv[k] || 0) >= v;
        return `<i class="${ok ? '' : 'no'}">${v}× ${k.toUpperCase()}</i>`;
      }).join('');
      // staples that belong to a pinned rig track are labelled so they read as
      // part of the strip above, not as another generated recipe
      const sysTag = r.system ? '<span class="recipe-sys">RIG</span>' : '';
      const badge = `${sysTag}${r.tier ? `<span class="recipe-tier t${r.tier}">T${r.tier}</span>` : ''}`;
      const req = tierOk ? '' : ` · NEEDS TIER ${r.tierReq}`;
      return `<div class="recipe" data-id="${r.id}">
        <div class="recipe-top">
          <span class="recipe-name">${r.name}</span>${badge}
        </div>
        <div class="recipe-desc">${r.desc}${req}</div>
        <div class="recipe-cost">${cost}</div>
        <button class="recipe-btn" data-craft="${r.id}" ${can ? '' : 'disabled'}>
          ${owned ? 'OWNED' : r.maxed ? 'MAXED' : 'CRAFT'}
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
    this.renderSystems();
    this.renderRecipes();
  }

  showGameOver(title, sub, stats, record) {
    this.el.goTitle.textContent = title;
    this.el.goSub.textContent = sub;
    this.el.goStats.innerHTML = stats.map((s) => `<div><span>${s.k}</span><b>${s.v}</b></div>`).join('');
    this.renderRecord(record);
    this.el.gameover.classList.add('show');
  }

  /**
   * "NEW RECORD · DAY · DIST" banner plus the personal-best line, so the run
   * card answers the one question players actually ask: was that any good?
   */
  renderRecord(record) {
    const host = this.el.goRecord;
    if (!host) return;
    if (!record) { host.innerHTML = ''; host.className = 'go-record'; return; }
    const badges = freshLabels(record.fresh);
    const bestDay = Math.round(record.best?.day || 0);
    const bestDist = fmtValue(TRACKED.find((f) => f.key === 'distance'), record.best?.distance || 0);
    const head = record.first
      ? '<span class="rec-chip first">FIRST RUN LOGGED</span>'
      : badges.length
        ? `<span class="rec-chip">NEW RECORD · ${badges.join(' · ')}</span>`
        : '<span class="rec-chip none">NO NEW RECORD</span>';
    host.className = `go-record ${badges.length ? 'fresh' : ''}`;
    host.innerHTML = `${head}
      <span class="rec-best">PERSONAL BEST · DAY ${bestDay} · ${bestDist}</span>`;
  }
  hideGameOver() { this.el.gameover.classList.remove('show'); }
}
