/**
 * Owner console for the account `ghanimz`.
 *
 * Two layers of gating, on purpose:
 *   1. the panel only mounts for that username (server-verified when Supabase
 *      is configured — see api/admin.js), so other players never see it;
 *   2. every privileged world action below runs in the local simulation, and
 *      anything that touches shared state (ban list) goes through /api/admin,
 *      which re-checks the caller's Supabase token server-side.
 *
 * Open with the `⌘ ADMIN` button or the backquote key.
 */
import { ZONES } from './world.js';
import { BUILDING_KINDS } from './buildings.js';
import { WEATHERS } from './game.js';

export const ADMIN_USERNAME = 'ghanimz';

/** Case/typo-tolerant owner check used by the launcher. */
export function isOwnerUsername(username) {
  return String(username || '').trim().toLowerCase() === ADMIN_USERNAME;
}

/**
 * Decides how (if at all) this player may open the console.
 *   'account' → signed in as the owner; the server re-verifies the token
 *   'guest'   → no account system configured at all, and the local survivor
 *               name is the owner's — single-player/offline builds only
 * Never both: as soon as Supabase is configured, only the real account counts.
 */
export function ownerAccess(account, survivorName) {
  if (isOwnerUsername(account?.username)) return 'account';
  const accountsOff = account ? account.canUseAccounts === false : true;
  if (accountsOff && isOwnerUsername(survivorName)) return 'guest';
  return null;
}

const MATERIALS = ['scrap', 'steel', 'titanium', 'carbon', 'leather', 'chem', 'cores'];

const html = (strings, ...values) => strings.reduce((out, s, i) => out + s + (values[i] ?? ''), '');

export class AdminPanel {
  constructor({ game, account, onBan, survivorName }) {
    this.game = game;
    this.account = account;
    this.onBan = onBan || (() => {});
    this.survivorName = survivorName || '';
    this.mode = ownerAccess(account, this.survivorName);
    this.open = false;
    this.verified = false;
    this.verifyReason = 'checking';
    this.bans = [];
    this.el = null;
    this.tick = 0;
    this.fps = 0;
    this._lastFrame = performance.now();
    this.build();
    this.verify();
  }

  // ------------------------------------------------------------------ markup
  build() {
    const root = document.createElement('div');
    root.id = 'adminPanel';
    root.className = 'admin-panel hidden';
    root.innerHTML = html`
      <div class="admin-card" role="dialog" aria-label="Owner console">
        <header class="admin-head">
          <div>
            <h2>OWNER CONSOLE <small>@${ADMIN_USERNAME}</small></h2>
            <p class="admin-sub">Live control over the run · changes apply immediately</p>
          </div>
          <div class="admin-head-right">
            <span id="adminVerify" class="admin-badge">CHECKING…</span>
            <button class="x" data-admin-close type="button" aria-label="Close">✕</button>
          </div>
        </header>

        <div class="admin-grid">
          <section class="admin-sec">
            <h3>WORLD</h3>
            <div class="admin-row">
              <label>DAY <input id="admDay" type="number" min="1" max="100" step="1" value="1" /></label>
              <button data-act="setDay" type="button">SET</button>
              <button data-act="skipDay" type="button">+1 DAY</button>
            </div>
            <div class="admin-row">
              <label class="wide">TIME OF DAY <input id="admTime" type="range" min="0" max="1" step="0.01" value="0" /></label>
            </div>
            <div class="admin-row">
              <label class="wide">WEATHER
                <select id="admWeather">
                  ${Object.keys(WEATHERS).map((k) => `<option value="${k}">${k.toUpperCase()}</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="admin-row">
              <label class="wide">ZONE
                <select id="admZone">
                  ${ZONES.map((z, i) => `<option value="${i}">${z.name}</option>`).join('')}
                </select>
              </label>
            </div>
            <div class="admin-row wrap">
              <button data-act="skipToNextStop" type="button">TELEPORT → NEXT PIT STOP</button>
              <button data-act="skipToBuilding" type="button">TELEPORT → NEXT HOUSE</button>
            </div>
          </section>

          <section class="admin-sec">
            <h3>SURVIVOR &amp; RIG</h3>
            <div class="admin-row wrap">
              <button data-act="heal" type="button">FULL HEAL + REFUEL</button>
              <button data-act="god" type="button" id="admGod">GOD MODE: OFF</button>
            </div>
            <div class="admin-row">
              <label>X <input id="admX" type="number" step="1" value="0" /></label>
              <label>Z <input id="admZ" type="number" step="1" value="0" /></label>
              <button data-act="tp" type="button">GO</button>
            </div>
            <div class="admin-row wrap">
              <button data-act="give" type="button">+50 EVERY MATERIAL</button>
              <button data-act="fuel" type="button">+60 L FUEL</button>
              <button data-act="tier" type="button">UNLOCK WORKBENCH T4</button>
            </div>
          </section>

          <section class="admin-sec">
            <h3>SPAWN</h3>
            <div class="admin-row wrap">
              <button data-act="hollow" type="button">HOLLOW ×3</button>
              <button data-act="raider" type="button">RAIDER RIG</button>
              <button data-act="boss" type="button">BOSS RIG</button>
            </div>
            <div class="admin-row wrap">
              <button data-act="cat1" type="button">STORM CAT 1</button>
              <button data-act="cat3" type="button">STORM CAT 3</button>
              <button data-act="cat5" type="button">STORM CAT 5</button>
            </div>
            <div class="admin-row wrap">
              <button data-act="clearHostiles" type="button">CLEAR HOSTILES</button>
              <button data-act="clearStorms" type="button">CLEAR STORMS</button>
              <button data-act="nextBuilding" type="button">RESHUFFLE BUILDINGS</button>
            </div>
            <div class="admin-row">
              <label class="wide">DROP A BUILDING
                <select id="admBuildingKind">
                  ${BUILDING_KINDS.map((k) => `<option value="${k}">${k.toUpperCase()}</option>`).join('')}
                </select>
              </label>
              <button data-act="placeBuilding" type="button">PLACE AHEAD</button>
            </div>
          </section>

          <section class="admin-sec">
            <h3>LIVE STATS</h3>
            <div class="admin-stats" id="admStats"></div>
          </section>

          <section class="admin-sec wide">
            <h3>PLAYERS IN ROOM</h3>
            <div class="admin-players" id="admPlayers"><p class="admin-note">Nobody else in this room.</p></div>
          </section>

          <section class="admin-sec wide">
            <h3>BAN LIST</h3>
            <div class="admin-row">
              <input id="admBanName" placeholder="username" autocapitalize="none" spellcheck="false" />
              <input id="admBanReason" placeholder="reason (optional)" />
              <button data-act="ban" type="button">BAN</button>
            </div>
            <div class="admin-bans" id="admBans"><p class="admin-note">No bans recorded.</p></div>
          </section>
        </div>

        <footer class="admin-foot">
          <span id="admHint">Press ⌘ or the backquote key to toggle · owner-only, server-verified</span>
        </footer>
      </div>
    `;
    document.body.appendChild(root);
    this.el = root;

    root.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-act]');
      if (btn) { this.act(btn.dataset.act); return; }
      if (ev.target.closest('[data-admin-close]')) this.hide();
      const rowBtn = ev.target.closest('[data-peer]');
      if (rowBtn) this.peerAction(rowBtn.dataset.peerAction, rowBtn.dataset.peer);
    });

    root.querySelector('#admTime')?.addEventListener('input', (ev) => {
      this.game.world.setNight(Number(ev.target.value));
    });
    root.querySelector('#admWeather')?.addEventListener('change', (ev) => {
      this.game.setWeather(ev.target.value);
    });
    root.querySelector('#admZone')?.addEventListener('change', (ev) => {
      this.game.zone = Number(ev.target.value);
      this.game.world.setZone(this.game.zone);
      this.game.hud.toast(`ZONE → ${ZONES[this.game.zone].name}`, 'good');
    });

    this.keyHandler = (ev) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
      if (typing) return;
      if (ev.code === 'Backquote' || (ev.key === '`' && !ev.metaKey && !ev.ctrlKey)) {
        ev.preventDefault();
        this.toggle();
      }
    };
    window.addEventListener('keydown', this.keyHandler);

    this.interval = setInterval(() => this.refresh(), 700);
  }

  /** Confirms with the server that the signed-in account really is the owner. */
  async verify() {
    if (this.mode === 'guest') {
      this.verified = true;
      this.verifyReason = 'guest_owner';
      this.setBadge('LOCAL OWNER · NO ACCOUNTS', 'warn');
      return true;
    }
    if (!this.mode) {
      this.verifyReason = 'not_owner';
      this.verified = false;
      this.setBadge('WRONG ACCOUNT', 'bad');
      return false;
    }
    const token = this.account?.sb?.session?.access_token || '';
    if (!token) {
      // no Supabase session (guest/offline build): local owner mode
      this.verified = true;
      this.verifyReason = 'local_owner';
      this.setBadge('LOCAL OWNER', 'warn');
      return true;
    }
    try {
      const res = await fetch('/api/admin?action=verify', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      this.verified = Boolean(body.admin);
      this.verifyReason = body.reason || (res.ok ? 'ok' : `http_${res.status}`);
      this.setBadge(this.verified ? 'VERIFIED OWNER' : 'NOT VERIFIED', this.verified ? 'ok' : 'bad');
      if (this.verified) this.loadBans();
      return this.verified;
    } catch {
      this.verified = false;
      this.verifyReason = 'network';
      this.setBadge('SERVER UNREACHABLE', 'bad');
      return false;
    }
  }

  setBadge(text, kind) {
    const el = this.el?.querySelector('#adminVerify');
    if (!el) return;
    el.textContent = text;
    el.className = `admin-badge ${kind || ''}`;
  }

  // ---------------------------------------------------------------- visibility
  async toggle() { return this.open ? this.hide() : this.show(); }

  async show() {
    if (!this.mode) {
      // silent for everyone else — no console hint that a panel exists
      return false;
    }
    if (!this.verified) await this.verify();
    this.open = true;
    this.el.classList.remove('hidden');
    this.el.classList.add('show');
    this.refresh();
    this.game.paused = true;
    this.game.hud?.prompt?.('');
    return true;
  }

  hide() {
    this.open = false;
    this.el.classList.add('hidden');
    this.el.classList.remove('show');
    this.game.paused = false;
  }

  destroy() {
    clearInterval(this.interval);
    window.removeEventListener('keydown', this.keyHandler);
    this.el?.remove();
    this.el = null;
  }

  // ------------------------------------------------------------------ actions
  act(id) {
    const g = this.game;
    if (!g) return;
    switch (id) {
      case 'setDay': {
        const v = Math.max(1, Math.min(100, Number(this.el.querySelector('#admDay').value) || 1));
        g.day = v;
        g.dayTimer = 0;
        if (g.onDayRoll) g.onDayRoll(v);
        g.hud.toast(`DAY SET TO ${v}`, 'good');
        break;
      }
      case 'skipDay': {
        g.day = Math.min(100, g.day + 1);
        g.dayTimer = 0;
        g.hud.toast(`DAY → ${g.day}`, 'good');
        break;
      }
      case 'tp': {
        g.teleport(this.el.querySelector('#admX').value, this.el.querySelector('#admZ').value);
        break;
      }
      case 'skipToNextStop': {
        const s = g.world.pitStops.reduce((a, b) => (Math.abs(b.z - g.pos.z) < Math.abs(a.z - g.pos.z) ? b : a));
        g.teleport(s.x + 12, s.z + 10);
        break;
      }
      case 'skipToBuilding': {
        const b = g.world.buildings.reduce((a, c) => (Math.abs(c.z - g.pos.z) < Math.abs(a.z - g.pos.z) ? c : a));
        if (b) g.teleport(b.door.x - 6, b.door.z);
        break;
      }
      case 'placeBuilding': {
        const kind = this.el.querySelector('#admBuildingKind')?.value || 'house';
        const side = g.pos.x >= 0 ? 1 : -1;
        const b = g.world.spawnBuilding(kind, g.pos.x + side * 26, g.pos.z + 18, side);
        g.hud.toast(`${b.label} PLACED — WALK IN AND SEARCH`, 'good');
        break;
      }
      case 'nextBuilding': {
        g.world.buildings.forEach((b, i) => g.world.placeBuilding(b, g.pos.z + 90 * (i + 1), i % 2 ? 1 : -1));
        g.hud.toast('BUILDINGS RESHUFFLED ALONG THE ROAD', 'good');
        break;
      }
      case 'heal': g.healAll(); break;
      case 'god': {
        g.godMode = !g.godMode;
        this.el.querySelector('#admGod').textContent = `GOD MODE: ${g.godMode ? 'ON' : 'OFF'}`;
        g.hud.toast(`GOD MODE ${g.godMode ? 'ENABLED' : 'DISABLED'}`, g.godMode ? 'good' : 'warn');
        break;
      }
      case 'give': {
        MATERIALS.forEach((m) => { g.materials[m] = (g.materials[m] || 0) + 50; });
        g.hud.toast('+50 OF EVERY MATERIAL', 'good');
        break;
      }
      case 'fuel': {
        g.car.fuel = Math.min(g.car.maxFuel, g.car.fuel + 60);
        g.hud.toast('+60 L FUEL', 'good');
        break;
      }
      case 'tier': {
        g.benchTier = 4;
        if (g.hud.benchTier) g.hud.benchTier.textContent = 'TIER 4';
        g.hud.toast('WORKBENCH TIER 4 UNLOCKED', 'good');
        break;
      }
      case 'hollow': g.spawnHollow(3); break;
      case 'raider': g.spawnRaider(false); break;
      case 'boss': g.spawnRaider(true); break;
      case 'cat1': g.spawnTornado(1); break;
      case 'cat3': g.spawnTornado(3); break;
      case 'cat5': g.spawnTornado(5); break;
      case 'clearHostiles': g.clearHostiles(); break;
      case 'clearStorms': g.clearStorms(); break;
      case 'ban': this.banFromForm(); break;
      default: break;
    }
    this.refresh();
  }

  async peerAction(action, id) {
    const peer = this.game.net?.peers?.get(id);
    if (!peer) return;
    if (action === 'tp') {
      this.game.teleport(peer.x ?? this.game.pos.x, (peer.z ?? this.game.pos.z) + 8);
      this.game.hud.toast(`TELEPORTED TO ${peer.name}`, 'good');
    } else if (action === 'kick') {
      this.game.net.event('admin-kick', { target: id, by: ADMIN_USERNAME, reason: 'kicked by owner' });
      this.game.hud.toast(`KICK SENT TO ${peer.name}`, 'warn');
    } else if (action === 'ban') {
      this.el.querySelector('#admBanName').value = peer.name;
      await this.banFromForm(peer.name);
    }
    this.refresh();
  }

  // ---------------------------------------------------------------------- bans
  async loadBans() {
    const token = this.account?.sb?.session?.access_token || '';
    if (!token) { this.renderBans(); return; }
    try {
      const res = await fetch('/api/admin?action=bans', { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      this.bans = Array.isArray(body.bans) ? body.bans : [];
      if (!res.ok) this.setBadge(body.reason === 'bans_table_404' ? 'RUN schema.sql' : 'BAN LIST OFFLINE', 'warn');
    } catch {
      this.bans = [];
    }
    this.renderBans();
  }

  async banFromForm(explicitName) {
    const nameEl = this.el.querySelector('#admBanName');
    const reasonEl = this.el.querySelector('#admBanReason');
    const username = String(explicitName || nameEl.value || '').trim().toLowerCase();
    if (!username) { this.game.hud.toast('ENTER A USERNAME TO BAN', 'warn'); return; }
    if (username === ADMIN_USERNAME) { this.game.hud.toast('THE OWNER CANNOT BE BANNED', 'bad'); return; }

    const token = this.account?.sb?.session?.access_token || '';
    if (!token) {
      this.game.hud.toast('BAN LIST NEEDS SUPABASE ACCOUNTS', 'warn');
      return;
    }
    try {
      const res = await fetch('/api/admin?action=ban', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username, reason: reasonEl.value || 'banned by owner' }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        this.game.hud.toast(`@${username} BANNED`, 'good');
        nameEl.value = '';
        reasonEl.value = '';
        this.onBan(username);
        this.loadBans();
      } else {
        this.game.hud.toast(`BAN FAILED — ${body.reason || res.status}`, 'bad');
      }
    } catch {
      this.game.hud.toast('BAN FAILED — NETWORK', 'bad');
    }
  }

  async unban(username) {
    const token = this.account?.sb?.session?.access_token || '';
    if (!token) return;
    try {
      const res = await fetch('/api/admin?action=unban', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ username }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        this.game.hud.toast(`@${username} UNBANNED`, 'good');
        this.loadBans();
      } else {
        this.game.hud.toast(`UNBAN FAILED — ${body.reason || res.status}`, 'bad');
      }
    } catch { /* ignore */ }
  }

  // -------------------------------------------------------------------- render
  refresh() {
    if (!this.el) return;
    const now = performance.now();
    const dt = (now - this._lastFrame) / 1000;
    this._lastFrame = now;
    if (dt > 0) this.fps = this.fps ? this.fps * 0.85 + (1 / dt) * 0.15 : 1 / dt;

    const g = this.game;
    if (!g) return;

    const s = this.el.querySelector('#admStats');
    if (s) {
      const rows = [
        ['FPS', this.fps.toFixed(0)],
        ['DAY', `${g.day}/100`],
        ['ZONE', ZONES[g.zone]?.short || '—'],
        ['DISTANCE', `${(g.distance || 0).toFixed(1)} km`],
        ['POSITION', `${g.pos.x.toFixed(0)} / ${g.pos.z.toFixed(0)}`],
        ['HP', `${Math.round(g.hp)}%`],
        ['RIG', `${Math.round(g.car.chassis)}% · ${g.car.fuel.toFixed(1)} L`],
        ['HOSTILES', `${g.hollows.length} + ${g.raiders.length} rigs`],
        ['STORMS', String(g.tornadoes.length)],
        ['BLDG', g.insideBuilding ? `INSIDE ${g.insideBuilding.label}` : `${g.world.buildings.length} placed`],
        ['PEERS', String(g.net.peers.size)],
        ['ROOM', g.net.room || '—'],
        ['RELAY', g.netStatus?.mode || '—'],
        ['OWNER GATE', this.verifyReason],
        ['BUILDING POOL', `${g.world.buildings.length} live`],
      ];
      s.innerHTML = rows.map(([k, v]) => `<div class="adm-stat"><span>${k}</span><b>${v}</b></div>`).join('');
    }

    const p = this.el.querySelector('#admPlayers');
    if (p) {
      if (!g.net.peers.size) p.innerHTML = '<p class="admin-note">Nobody else in this room.</p>';
      else {
        p.innerHTML = [...g.net.peers.values()].map((peer) => `
          <div class="admin-player">
            <i style="background:#${(peer.color || 0x8fd0ff).toString(16).padStart(6, '0')}"></i>
            <b>${peer.name}</b>
            <span>${peer.inCar ? 'DRIVING' : 'ON FOOT'} · DAY ${peer.day ?? '?'}</span>
            <button data-peer-role="tp" data-peer-action="tp" data-peer="${peer.id}" type="button">TP</button>
            <button data-peer-role="kick" data-peer-action="kick" data-peer="${peer.id}" type="button">KICK</button>
            <button data-peer-role="ban" data-peer-action="ban" data-peer="${peer.id}" type="button">BAN</button>
          </div>`).join('');
      }
    }

    this.renderBans();
  }

  renderBans() {
    const el = this.el?.querySelector('#admBans');
    if (!el) return;
    if (!this.bans.length) {
      el.innerHTML = '<p class="admin-note">No bans recorded.</p>';
      return;
    }
    el.innerHTML = this.bans.map((b) => `
      <div class="admin-ban">
        <b>@${b.username}</b>
        <span>${b.reason || 'no reason'}</span>
        <button data-unban="${b.username}" type="button">LIFT</button>
      </div>`).join('');
    el.querySelectorAll('[data-unban]').forEach((btn) => {
      btn.addEventListener('click', () => this.unban(btn.dataset.unban));
    });
  }
}

/** Mounts the console only for the owner account; returns null for everyone else. */
export function mountAdmin({ game, account, onBan, survivorName }) {
  const mode = ownerAccess(account, survivorName);
  if (!mode) return null;
  const panel = new AdminPanel({ game, account, onBan, survivorName });
  document.body.classList.add('owner');
  const fab = document.getElementById('adminBtn');
  if (fab) {
    fab.classList.remove('hidden');
    fab.addEventListener('click', () => panel.toggle());
  }
  return panel;
}
