/** Copies text without the async Clipboard API (http:// origins, old webviews). */
export function copyViaSelection(text) {
  try {
    const doc = globalThis.document;
    if (!doc?.createElement || !doc.body) return false;
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    doc.body.appendChild(ta);
    ta.select?.();
    const ok = typeof doc.execCommand === 'function' ? doc.execCommand('copy') : false;
    ta.remove?.();
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * THE ARCADE — the Gemby Games hub every session starts in.
 *
 * One built-in game (100 Days Outrun, the 3D engine in this repo) plus every
 * community game found under ./games (see scripts/scan-games.mjs). Community
 * games are untrusted: they run in a sandboxed iframe with no same-origin
 * access and talk to us through a small, validated postMessage protocol.
 *
 * Pure helpers (mergeCatalogues / filterGames / cardHtml / validateBridgeMessage)
 * are exported so the test suite can pin the behaviour without a browser.
 */
import { ArcadeStats, ratingLabel, rankRuns } from './arcade-stats.js';
import {
  installAutoLandscape, isTouchDevice, isPortrait, requestLandscape, requestPortrait,
} from './orientation.js';
import { applyPostClass } from './graphics.js';
import { paintAvatar, initialsOf } from './account-image.js';
import { MODES } from './modes.js';

export const CATALOGUE_URL = './games/index.json';
export const BRIDGE = 'outrun-arcade';

/**
 * The game that ships with the repo. It is ONE game: everything else (siege,
 * sprint, storm chaser…) is a mode inside it, chosen in the lobby — so the shelf
 * stays honest instead of pretending each rule-set is a separate download.
 */
export const NATIVE_GAMES = [{
  id: 'outrun',
  title: '100 DAYS OUTRUN',
  author: 'ghanimz',
  blurb: 'One rig, one highway, a hundred days of storms. Crafting, anchors, tornadoes, friends — and a mode for every mood.',
  tags: ['survival', 'multiplayer', '3d'],
  accent: '#ffb347',
  icon: './icon.svg',
  players: '1-8',
  featured: true,
  native: true,
  version: '2.1.0',
  modes: MODES.map((m) => ({ id: m.id, name: m.name, icon: m.icon || '◆', accent: m.accent || '#ffb347', blurb: m.blurb })),
}];

/** How many modes the built-in game ships with (shown on its card). */
export const NATIVE_MODE_COUNT = MODES.length;

const ALLOWED_TYPES = new Set(['arcade:ready', 'arcade:state', 'arcade:score', 'arcade:close']);

/** Drops anything that is not a well-formed, in-range bridge message. */
export function validateBridgeMessage(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.channel !== BRIDGE) return null;
  const type = String(data.type || '');
  if (!ALLOWED_TYPES.has(type)) return null;
  const p = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const int = (v, max) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
  switch (type) {
    case 'arcade:ready':
      return { type, payload: {} };
    case 'arcade:state':
      return {
        type,
        payload: {
          day: int(p.day, 9999),
          score: int(p.score, 9999999),
          status: String(p.status || '').slice(0, 32).toUpperCase(),
        },
      };
    case 'arcade:score':
      return {
        type,
        payload: {
          score: int(p.score, 9999999),
          day: int(p.day, 9999),
          seconds: int(p.seconds, 86400),
          won: Boolean(p.won),
          meta: String(p.meta || '').slice(0, 80),
        },
      };
    case 'arcade:close':
    default:
      return { type: 'arcade:close', payload: {} };
  }
}

/** Built-ins first (featured), then the community catalogue as scanned. */
export function mergeCatalogues(nativeGames, remote) {
  const list = Array.isArray(remote?.games) ? remote.games : [];
  const community = list
    .filter((g) => g && typeof g.id === 'string' && g.id.trim().length > 0 && g.title)
    .map((g) => ({
      id: g.id,
      title: String(g.title),
      // the hub page is not inside the game folder: every asset path is absolute
      // from the site root so the card art actually loads
      author: String(g.author || 'anonymous'),
      blurb: String(g.blurb || ''),
      tags: Array.isArray(g.tags) ? g.tags.slice(0, 5) : [],
      accent: /^#[0-9a-fA-F]{6}$/.test(g.accent || '') ? g.accent : '#6be0ff',
      icon: `./${String(g.path || `games/${g.id}`).replace(/^\.?\//, '')}/${String(g.icon || 'icon.svg').replace(/^\.?\//, '')}`,
      path: String(g.path || `games/${g.id}`).replace(/^\.?\//, ''),
      entry: String(g.entry || 'index.html'),
      players: String(g.players || '1'),
      featured: Boolean(g.featured),
      native: false,
      version: String(g.version || '1.0.0'),
    }));
  return [...nativeGames, ...community];
}

/** Search + tab filtering. Tabs mirror the left rail. */
export function filterGames(games, { query = '', tab = 'home' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  let list = [...games];
  if (tab === 'mine') list = list.filter((g) => g.native || g.owned);
  if (tab === 'new') list = list.filter((g) => !g.native);
  if (q) {
    list = list.filter((g) => `${g.title} ${g.author} ${g.blurb} ${(g.tags || []).join(' ')}`
      .toLowerCase().includes(q));
  }
  return list;
}

export const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** One game card as HTML. `stats` is an ArcadeStats instance (optional). */
export function cardHtml(game, stats = null) {
  const rating = stats?.ratingOf(game.id);
  const plays = stats?.plays(game.id) || 0;
  const stars = rating && rating.count ? Math.round(rating.avg) : 0;
  const starRow = '★'.repeat(stars) + '☆'.repeat(5 - stars);
  return `<button type="button" class="game-card${game.featured ? ' featured' : ''}"
      data-game="${escapeHtml(game.id)}" style="--card-accent:${escapeHtml(game.accent)}">
      <span class="gc-art">
        <img src="${escapeHtml(game.icon)}" alt="" loading="lazy" onerror="this.style.display='none'" />
        <i class="gc-tag">${game.native ? 'BUILT-IN' : escapeHtml(game.author)}</i>
        ${game.featured ? '<i class="gc-featured">FEATURED</i>' : ''}
      </span>
      <span class="gc-body">
        <b class="gc-title">${escapeHtml(game.title)}</b>
        ${game.modes?.length ? `<span class="gc-modes">${game.modes.slice(0, 4).map((m) =>
    `<i style="--m:${escapeHtml(m.accent || '#ffb347')}">${escapeHtml(m.icon)} ${escapeHtml(m.name)}</i>`).join('')}${game.modes.length > 4 ? `<i class="more">+${game.modes.length - 4}</i>` : ''}</span>` : ''}
        <em class="gc-blurb">${escapeHtml(game.blurb)}</em>
        <span class="gc-meta">
          <span class="gc-stars" title="${escapeHtml(ratingLabel(rating))}">${starRow}</span>
          <span class="gc-plays">${plays ? `${plays} PLAY${plays === 1 ? '' : 'S'}` : 'NEW'}</span>
          <span class="gc-tags">${(game.tags || []).slice(0, 3).map((t) => `#${escapeHtml(t)}`).join(' ')}</span>
        </span>
      </span>
    </button>`;
}

/** Reads the generated catalogue; a missing file is not an error (fresh checkout). */
const CATALOGUE_CACHE_KEY = 'outrun-catalogue-v1';
const CATALOGUE_TTL = 6 * 60 * 60 * 1000;

/** The last catalogue a browser saw, so the hub paints before any network I/O. */
export function readCachedCatalogue() {
  try {
    const raw = globalThis.localStorage?.getItem(CATALOGUE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.games)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCachedCatalogue(catalogue) {
  try {
    if (!Array.isArray(catalogue?.games)) return;
    globalThis.localStorage?.setItem(CATALOGUE_CACHE_KEY, JSON.stringify({
      ...catalogue,
      cachedAt: Date.now(),
    }));
  } catch { /* private mode, quota, sandboxed iframe — all fine */ }
}

export function catalogueIsStale(catalogue, now = Date.now()) {
  if (!catalogue?.cachedAt) return true;
  return now - Number(catalogue.cachedAt) > CATALOGUE_TTL;
}

export async function loadCatalogue(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl(`${CATALOGUE_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.games) ? json : { version: 1, games: [] };
  } catch {
    return { version: 1, games: [], offline: true };
  }
}

/**
 * The hub itself: renders the rail, the friends strip and the cards, and owns
 * the sandboxed game frame.
 */
export class Arcade {
  constructor({
    account = null,
    onPlayNative = () => {},
    onSettings = null,
    getPlayer = () => ({ name: 'WANDERER', color: '#5ff0ff', room: 'highway-01', quality: 'auto' }),
    fetchImpl = globalThis.fetch,
    stats = null,
  } = {}) {
    this.account = account;
    this.onPlayNative = onPlayNative;
    this.onSettings = onSettings;
    this.getPlayer = getPlayer;
    this.fetchImpl = fetchImpl;
    this.stats = stats || new ArcadeStats({ account });
    this.games = [...NATIVE_GAMES];
    this.tab = 'home';
    this.query = '';
    this.playing = null;
    this.frame = null;
    this.lastScore = null;
    /** game_id → cached top runs, handed to the game with `arcade:init`. */
    this.boards = new Map();
    this.readyAt = 0;
    this.heardAt = 0;
    this.stallTimer = null;
    this.onMessage = this.onMessage.bind(this);
    this.build();
  }

  // ------------------------------------------------------------------ markup
  build() {
    const root = document.createElement('div');
    root.id = 'arcade';
    root.className = 'arcade hidden';
    root.innerHTML = `
      <header class="arc-top">
        <div class="arc-logo"><span>GG</span> GEMBY GAMES</div>
        <label class="arc-search">
          <input id="arcSearch" placeholder="Search games, creators, tags…" autocomplete="off" spellcheck="false" />
        </label>
        <div class="arc-top-right">
          <button class="arc-fs" data-fullscreen="label" type="button" title="Fullscreen (Alt+Enter)">⤢ FULLSCREEN</button>
          <span id="arcOnline" class="arc-online">SOLO</span>
          <button id="arcSettingsBtn" class="arc-gear" type="button" title="Settings" aria-label="Settings">⚙</button>
          <button id="arcProfileBtn" class="arc-avatar" type="button" title="Account">?</button>
        </div>
      </header>

      <div class="arc-body">
        <nav class="arc-rail">
          <button class="arc-nav on" data-tab="home" type="button"><b>⌂</b><span>Home</span></button>
          <button class="arc-nav" data-tab="mine" type="button"><b>▣</b><span>My Games</span></button>
          <button class="arc-nav" data-tab="new" type="button"><b>✦</b><span>Community</span></button>
          <button id="arcCreateBtn" class="arc-nav" type="button"><b>+</b><span>Create a Game</span></button>
          <button id="arcRecordsBtn" class="arc-nav" type="button"><b>◆</b><span>Records</span></button>
        </nav>

        <main class="arc-main">
          <section class="arc-friends">
            <div class="arc-sec-head"><h2>Friends <small id="arcFriendCount"></small></h2></div>
            <div id="arcFriends" class="arc-friend-row"></div>
          </section>

          <section>
            <div class="arc-sec-head"><h2 id="arcSecTitle">Recommended for you</h2>
              <span id="arcCount" class="arc-count"></span></div>
            <div id="arcGrid" class="arc-grid"></div>
          </section>

          <section id="arcRecordsSec" class="hidden">
            <div class="arc-sec-head"><h2>Records</h2></div>
            <div id="arcRecords" class="arc-records"></div>
          </section>
        </main>
      </div>

      <div id="arcPlayer" class="arc-player hidden">
        <div class="ap-bar">
          <span id="apTitle">GAME</span>
          <span id="apStatus"></span>
          <button id="apReload" type="button" title="Restart">⟳</button>
          <button id="apClose" type="button" title="Back to arcade">✕</button>
        </div>
        <div class="ap-stage"><iframe id="apFrame" title="Community game"
          sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></div>
        <div id="apResult" class="ap-result hidden"></div>
      </div>

      <div id="arcFriendsModal" class="arc-modal hidden">
        <div class="arc-modal-card af-card">
          <header><h2>FRIENDS</h2><button id="afClose" type="button">✕</button></header>
          <div class="af-add">
            <input id="afInput" placeholder="Add by @username" autocomplete="off" autocapitalize="none"
              spellcheck="false" />
            <button id="afAdd" type="button">ADD</button>
          </div>
          <p id="afNote" class="af-note"></p>
          <div id="afList" class="af-list"></div>
          <p class="arc-note">Friends are matched by username. Add somebody once and you show up in each
            other's lists, with the room you are playing in.</p>
        </div>
      </div>

      <div id="arcCreate" class="arc-modal hidden">
        <div class="arc-modal-card">
          <header><h2>ADD YOUR GAME</h2><button id="arcCreateClose" type="button">✕</button></header>
          <p>Games live in the repo, one folder each. Open a pull request with your folder and it shows up
            here for everyone once it is merged.</p>
          <pre id="arcCreateSnippet"></pre>
          <div class="arc-modal-actions">
            <a id="arcCreateLink" class="arc-link" href="#" target="_blank" rel="noopener">OPEN GITHUB →</a>
            <button id="arcCreateCopy" type="button">COPY MANIFEST</button>
          </div>
          <p class="arc-note">Full rules and the SDK: <code>games/README.md</code>. Your game runs sandboxed —
            it cannot read accounts, storage or other games.</p>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    this.el = root;

    const $ = (id) => root.querySelector(`#${id}`);
    this.nodes = {
      search: $('arcSearch'), grid: $('arcGrid'), title: $('arcSecTitle'), count: $('arcCount'),
      friends: $('arcFriends'), friendCount: $('arcFriendCount'), online: $('arcOnline'),
      player: $('arcPlayer'), frame: $('apFrame'), playerTitle: $('apTitle'), playerStatus: $('apStatus'),
      result: $('apResult'), records: $('arcRecords'), recordsSec: $('arcRecordsSec'),
      create: $('arcCreate'), createSnippet: $('arcCreateSnippet'), createLink: $('arcCreateLink'),
      profileBtn: $('arcProfileBtn'), settingsBtn: $('arcSettingsBtn'),
      friendsModal: $('arcFriendsModal'), afList: $('afList'), afInput: $('afInput'), afNote: $('afNote'),
      afAdd: $('afAdd'),
    };

    root.querySelectorAll('.arc-nav[data-tab]').forEach((b) => {
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab;
        root.querySelectorAll('.arc-nav[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      });
    });
    this.nodes.search?.addEventListener('input', (e) => {
      this.query = e.target.value || '';
      this.render();
    });
    this.nodes.grid?.addEventListener?.('click', (e) => {
      const card = e.target?.closest?.('[data-game]');
      if (card) this.launch(card.dataset.game);
    });
    $('arcCreateBtn')?.addEventListener('click', () => this.showCreate());
    $('arcCreateClose')?.addEventListener('click', () => this.nodes.create.classList.add('hidden'));
    $('arcCreateCopy')?.addEventListener('click', () => this.copyManifest());
    $('arcRecordsBtn')?.addEventListener('click', () => {
      this.tab = 'records';
      root.querySelectorAll('.arc-nav[data-tab]').forEach((x) => x.classList.remove('on'));
      this.nodes.recordsSec.classList.remove('hidden');
      this.renderRecords();
    });
    this.nodes.settingsBtn?.addEventListener('click', () => this.onSettings?.('settings'));
    $('afClose')?.addEventListener('click', () => this.closeFriends());
    this.nodes.afAdd?.addEventListener('click', () => this.addFriendFromModal());
    this.nodes.afInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault?.(); this.addFriendFromModal(); }
    });
    // the friends strip is rebuilt on every render, so its clicks are delegated
    this.nodes.friends?.addEventListener?.('click', (e) => {
      const add = e.target?.closest?.('[data-add-friend]');
      if (add) { this.openFriends(); return; }
      const tile = e.target?.closest?.('[data-friend]');
      if (tile) this.openFriends();
    });
    this.nodes.profileBtn?.addEventListener('click', () => this.onSettings?.('account'));
    $('apClose')?.addEventListener('click', () => this.closeGame());
    $('apReload')?.addEventListener('click', () => this.launch(this.playing?.id));

    window.addEventListener('message', this.onMessage);
    this.nodes.createSnippet.textContent = this.manifestTemplate();

    // AUTO LANDSCAPE: lock the device sideways for the hub and for every game
    // played inside it. iOS refuses the lock, so the player frame is also
    // rotated in CSS — the game always gets a wide stage either way.
    installAutoLandscape({ when: 'any', onChange: (st) => this.syncStage(st) });
    window.addEventListener('resize', () => this.syncStage());
    window.addEventListener('orientationchange', () => setTimeout(() => this.syncStage(), 200));
  }

  manifestTemplate() {
    return `games/my-game/game.json
{
  "id": "my-game",
  "title": "My Game",
  "author": "your-username",
  "blurb": "One line about the loop.",
  "tags": ["solo"],
  "version": "1.0.0",
  "entry": "index.html",
  "icon": "icon.svg"
}`;
  }

  /**
   * Rotates the sandboxed game frame when the device refuses a real landscape
   * lock. The iframe keeps its true pixel size (games measure themselves with
   * Arcade.fit), so the rotate transform only changes what the player sees.
   */
  syncStage(info = null) {
    if (!this.nodes?.player) return;
    const portrait = info ? info.portrait : isPortrait();
    const touch = isTouchDevice();
    const rotate = touch && portrait;
    this.nodes.player.classList.toggle('force-landscape', rotate);
    this.nodes.player.classList.toggle('locked-landscape', Boolean(info?.locked));
    if (rotate) {
      document.documentElement.style.setProperty('--stage-w', `${window.innerHeight}px`);
      document.documentElement.style.setProperty('--stage-h', `${window.innerWidth}px`);
    }
  }

  showCreate() {
    this.nodes.create.classList.remove('hidden');
    const repo = 'https://github.com/Ghanimsokaki/survive-in-a-car-for-100-day-/new/main/games/my-game';
    this.nodes.createLink.setAttribute('href', repo);
  }

  async copyManifest() {
    const text = this.manifestTemplate();
    // navigator.clipboard only exists on secure origins, and the phone preview
    // is plain http — fall back to the old selection trick instead of failing.
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        this.toast('MANIFEST COPIED');
        return;
      }
      throw new Error('no clipboard');
    } catch {
      const ok = copyViaSelection(text);
      this.toast(ok ? 'MANIFEST COPIED' : 'COPY FAILED — SELECT IT MANUALLY');
    }
  }

  // ----------------------------------------------------------------- loading
  async refresh() {
    // 1. paint immediately from the cached catalogue (no round trip)
    const cached = readCachedCatalogue();
    if (cached) {
      this.games = mergeCatalogues(NATIVE_GAMES, cached);
      this.render();
    }
    // 2. then pull the ratings and the live catalogue in parallel and repaint
    const [, catalogue] = await Promise.all([
      this.stats.load().catch(() => null),
      loadCatalogue(this.fetchImpl),
    ]);
    if (!catalogue.offline) writeCachedCatalogue(catalogue);
    this.games = mergeCatalogues(NATIVE_GAMES, catalogue);
    this.render();
    this.warmBoards();
    return this.games;
  }

  show() {
    this.el.classList.remove('hidden');
    document.body.classList.add('arcade-open');
    // the hub rotates its own player stage, so the page itself stays upright
    document.documentElement.classList.remove('rot-stage');
    this.render();
  }

  hide() {
    this.el.classList.add('hidden');
    document.body.classList.remove('arcade-open');
    this.closeGame();
  }

  // ------------------------------------------------------------------- render
  render() {
    // Records is a section, not a tab: leaving it for Home/My Games has to put
    // the grid and the section titles back, otherwise the page is stuck.
    if (this.nodes.recordsSec) {
      this.nodes.recordsSec.classList.toggle('hidden', this.tab !== 'records');
    }
    if (this.nodes.grid) this.nodes.grid.classList.toggle('hidden', this.tab === 'records');
    const list = filterGames(this.games, { query: this.query, tab: this.tab === 'records' ? 'home' : this.tab });
    const titles = { home: 'Recommended for you', mine: 'My games', new: 'New from the community' };
    if (this.nodes.title) this.nodes.title.textContent = titles[this.tab] || 'Games';
    if (this.nodes.count) this.nodes.count.textContent = `${list.length} GAME${list.length === 1 ? '' : 'S'}`;
    if (this.nodes.grid) {
      this.nodes.grid.innerHTML = list.length
        ? list.map((g) => cardHtml(g, this.stats)).join('')
        : '<p class="arc-empty">No games match that search.</p>';
    }
    this.renderFriends();
    if (this.tab === 'records') this.renderRecords();
  }

  renderFriends() {
    const host = this.nodes.friends;
    if (!host) return;
    const friends = Array.isArray(this.account?.friends) ? this.account.friends : [];
    const online = friends.filter((f) => f.online);
    if (this.nodes.friendCount) {
      this.nodes.friendCount.textContent = friends.length ? `${friends.length} · ${online.length} ONLINE` : '';
    }
    if (this.nodes.online) {
      this.nodes.online.textContent = this.account?.signedIn ? `${online.length} FRIENDS ONLINE` : 'GUEST MODE';
    }
    // the account picture (or initials) lives on the hub's own avatar button
    const p = this.account?.profile;
    if (this.nodes.profileBtn && p) {
      paintAvatar(this.nodes.profileBtn, {
        image: p.avatar_image || '',
        name: p.display_name || p.username || 'GUEST',
        color: p.body_color || '#ffb347',
      });
    }

    const tiles = friends.slice(0, 8).map((f) => {
      const name = f.displayName || f.username || '?';
      return `
      <button type="button" class="arc-friend${f.online ? ' on' : ''}" data-friend="${escapeHtml(f.username || name)}"
        title="${escapeHtml(name)}${f.online ? ' — playing' : ' — offline'}">
        <span class="af-dot"></span>
        <span class="af-av">${f.avatar ? `<img src="${f.avatar}" alt="" />` : escapeHtml(initialsOf(name))}</span>
        <b>${escapeHtml(String(name).slice(0, 8))}</b>
        <em>${f.online ? 'PLAYING' : 'OFFLINE'}</em>
      </button>`;
    });
    host.innerHTML = `<button type="button" class="arc-friend add" data-add-friend="1">
        <span class="af-plus">+</span><b>Add Friends</b><em>${friends.length ? 'FIND MORE' : 'NOBODY YET'}</em>
      </button>${tiles.join('')}`;
  }

  // -------------------------------------------------------------- friends UI
  openFriends() {
    const modal = this.nodes.friendsModal;
    if (!modal) return;
    modal.classList.remove('hidden');
    this.renderFriendsModal();
    setTimeout(() => this.nodes.afInput?.focus?.(), 40);
  }

  closeFriends() {
    this.nodes.friendsModal?.classList.add('hidden');
    if (this.nodes.afNote) this.nodes.afNote.textContent = '';
  }

  friendNote(text, kind = '') {
    const el = this.nodes.afNote;
    if (!el) return;
    el.textContent = text || '';
    el.className = `af-note ${kind}`;
  }

  renderFriendsModal() {
    const host = this.nodes.afList;
    if (!host) return;
    if (!this.account?.signedIn) {
      host.innerHTML = `<p class="af-empty">Sign in with a username to keep a friends list —
        guests can only play by sharing a room code.</p>`;
      if (this.nodes.afAdd) this.nodes.afAdd.disabled = true;
      if (this.nodes.afInput) this.nodes.afInput.disabled = true;
      return;
    }
    if (this.nodes.afAdd) this.nodes.afAdd.disabled = false;
    if (this.nodes.afInput) this.nodes.afInput.disabled = false;

    const friends = this.account.friends || [];
    if (!friends.length) {
      host.innerHTML = `<p class="af-empty">${this.account.friendsLoading ? 'Loading…'
        : 'No friends yet — type a username above and press ADD.'}</p>`;
      return;
    }
    host.innerHTML = friends.map((f) => {
      const name = f.displayName || f.username || '?';
      const where = f.online
        ? `PLAYING${f.room ? ` · ${escapeHtml(String(f.room).toUpperCase())}` : ''}${f.day ? ` · DAY ${f.day}` : ''}`
        : 'OFFLINE';
      return `<div class="af-row${f.online ? ' on' : ''}">
        <span class="af-av">${f.avatar ? `<img src="${f.avatar}" alt="" />` : escapeHtml(initialsOf(name))}</span>
        <span class="af-meta"><b>${escapeHtml(name)}</b><em>@${escapeHtml(f.username || '')}</em>
          <i>${where}</i></span>
        <button type="button" class="af-del" data-remove="${escapeHtml(f.id)}" title="Remove friend">✕</button>
      </div>`;
    }).join('');

    host.querySelectorAll('[data-remove]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await this.account.removeFriend(b.dataset.remove);
          this.friendNote('Friend removed.', 'ok');
        } catch (e) {
          this.friendNote(e?.message || 'Could not remove that friend.', 'err');
          b.disabled = false;
        }
        this.renderFriendsModal();
        this.renderFriends();
      });
    });
  }

  async addFriendFromModal() {
    const input = this.nodes.afInput;
    const name = String(input?.value || '').trim();
    if (!name) { this.friendNote('Type a username first.', 'err'); return; }
    if (!this.account?.signedIn) { this.friendNote('Sign in to add friends.', 'err'); return; }
    this.friendNote('Looking them up…', '');
    if (this.nodes.afAdd) this.nodes.afAdd.disabled = true;
    try {
      const target = await this.account.addFriend(name);
      if (input) input.value = '';
      this.friendNote(`${target.display_name || target.username} added.`, 'ok');
      this.renderFriends();
      this.renderFriendsModal();
    } catch (e) {
      this.friendNote(e?.message || 'Could not add that friend.', 'err');
    } finally {
      if (this.nodes.afAdd) this.nodes.afAdd.disabled = false;
    }
  }

  renderRecords() {
    const host = this.nodes.records;
    if (!host) return;
    const rows = this.games.map((g) => {
      const board = rankRuns(this.stats.data.best[g.id] || []).slice(0, 3);
      const best = board[0];
      return `<div class="arc-rec">
        <span class="ar-art" style="background:${escapeHtml(g.accent)}"></span>
        <b>${escapeHtml(g.title)}</b>
        <em>${best ? `BEST ${best.score} · ${escapeHtml(best.name)}` : 'NO RUNS YET'}</em>
        <span class="ar-stars">${escapeHtml(ratingLabel(this.stats.ratingOf(g.id)))}</span>
        <span class="ar-rate" data-rate="${escapeHtml(g.id)}">${[1, 2, 3, 4, 5]
    .map((n) => `<button type="button" data-stars="${n}" data-game-rate="${escapeHtml(g.id)}"
        class="${this.stats.myRating(g.id) >= n ? 'on' : ''}">★</button>`).join('')}</span>
      </div>`;
    }).join('');
    host.innerHTML = rows;
    host.querySelectorAll('[data-game-rate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await this.stats.rate(btn.dataset.gameRate, Number(btn.dataset.stars));
        this.renderRecords();
        this.toast('RATING SAVED');
      });
    });
  }

  // ------------------------------------------------------------------- launch
  launch(id) {
    const game = this.games.find((g) => g.id === id);
    if (!game) return false;
    if (game.native) {
      this.hide();
      this.onPlayNative(game);
      return true;
    }
    this.openGame(game);
    return true;
  }

  openGame(game) {
    this.playing = game;
    // Ask for this game's board now. `topRuns` caches for a minute, so this is
    // free on a second open — and if it is still in flight when the frame says
    // hello, the next `postInit` (there are two) picks it up.
    this.loadBoard(game.id).catch(() => {});
    // A game is the one part of the hub that wants landscape. The tap that
    // opened it is a gesture, so this is where the lock is allowed to happen;
    // the menu behind it stays portrait.
    document.body.classList.add('run-live');
    // community games get the same warm screen glow the 3D run has (HIGH is the
    // sensible default: they are 2D canvases, so the cost is a CSS gradient)
    applyPostClass(document.documentElement, 'high');
    // the hub never rotates the page itself — it rotates the player stage — so
    // clear any leftover CSS rotation from an earlier 3D run
    document.body.classList.remove('auto-land');
    document.documentElement.classList.remove('rot-stage');
    if (isPortrait()) requestLandscape();
    this.nodes.player.classList.remove('hidden');
    this.nodes.result.classList.add('hidden');
    this.syncStage();
    this.nodes.playerTitle.textContent = game.title;
    // no loading copy anywhere: the frame simply fades in when the game says it
    // is ready (arcade:ready), and until then the bar shows the game's name
    this.nodes.playerStatus.textContent = '';
    // Relative URL: the iframe is same-path but sandboxed without same-origin, so
    // it can render our files yet cannot read our DOM, storage or session.
    // A directory URL (`…/iron-tide/`) is the stable form: hosts that clean URLs
    // turn `…/index.html` into `…/iron-tide` — with no trailing slash — and the
    // game's own relative `<script src="fleet.js">` then resolves one level too
    // high and 404s. Games can pin their base (Iron Tide does), but asking the
    // directory costs nothing and avoids the redirect on every other host.
    const folder = String(game.path || `games/${game.id}`).replace(/^\.?\//, '').replace(/\/+$/, '');
    const entry = String(game.entry || 'index.html').replace(/^\.?\//, '');
    const file = !entry || entry === 'index.html' ? '' : entry;
    const url = `./${folder}/${file}?g=${encodeURIComponent(game.id)}`;
    // one navigation, not two: setting the same URL through both the property
    // and the attribute makes some browsers fetch the game twice, which is a
    // needless delay before the first frame
    this.nodes.frame.src = url;
    this.readyAt = 0;
    this.heardAt = 0;
    setTimeout(() => {
      if (this.playing?.id === game.id) this.postInit();
    }, 900);
    // and if the frame never says hello, say why instead of waiting forever: a
    // game that 404s (not bundled) or throws looks exactly like a stuck loading
    // screen. This is an error message, not a spinner.
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      // a game that has said *anything* is running — keep its own message
      if (this.playing?.id !== game.id || this.readyAt || this.heardAt) return;
      this.nodes.playerStatus.textContent = 'GAME DID NOT START';
    }, 8000);
  }

  /**
   * Warms every community game's leaderboard *after* the shelf has painted, a
   * few at a time. One query per game per minute, done while the player is
   * still choosing — so tapping a card never waits on Supabase.
   */
  warmBoards() {
    const ids = this.games.filter((g) => !g.native).map((g) => g.id);
    if (!ids.length || !this.stats.prefetch) return Promise.resolve([]);
    return this.stats.prefetch(ids, { limit: 5, concurrency: 2 })
      .then(async () => {
        for (const id of ids) {
          const cached = this.stats.cachedBoard ? this.stats.cachedBoard(id, 5) : null;
          if (cached) this.boards.set(id, cached.rows);
        }
      })
      .catch(() => {});
  }

  /**
   * Fetches (or reuses) a game's leaderboard so the game itself does not have
   * to: inside the sandboxed frame there is no Supabase key, and a request per
   * game open would be a request per game open. One cached query, shared.
   */
  async loadBoard(gameId) {
    if (!gameId) return null;
    const cached = this.stats.cachedBoard ? this.stats.cachedBoard(gameId, 5) : null;
    if (cached) {
      this.boards.set(gameId, cached.rows);
      return cached.rows;
    }
    const rows = await this.stats.topRuns(gameId, 5);
    this.boards.set(gameId, rows);
    return rows;
  }

  postInit() {
    const player = this.getPlayer();
    try {
      this.nodes.frame?.contentWindow?.postMessage({
        channel: BRIDGE,
        type: 'arcade:init',
        payload: {
          player: {
            name: player.name || 'WANDERER',
            color: player.color || '#5ff0ff',
            room: player.room || 'highway-01',
            custom: player.custom || null,
          },
          quality: player.quality || 'auto',
          // Cached by `ArcadeStats.topRuns` (one Supabase query per game per
          // minute). Handing it over here is what lets a sandboxed game show a
          // real leaderboard without a key, a second request or CORS.
          leaderboard: this.playing ? (this.boards.get(this.playing.id) || null) : null,
        },
      }, '*');
    } catch { /* frame not ready yet — the game's local fallback covers it */ }
  }

  closeGame() {
    this.playing = null;
    clearTimeout(this.stallTimer);
    document.body.classList.remove('run-live');
    document.body.classList.remove('auto-land');
    this.syncStage({ portrait: false, locked: false });
    // back on the home: upright again, and out of fullscreen
    requestPortrait();
    this.nodes?.player?.classList.add('hidden');
    if (this.nodes?.frame) this.nodes.frame.src = 'about:blank';
  }

  async onMessage(ev) {
    const msg = validateBridgeMessage(ev.data);
    if (!msg) return;
    const game = this.playing;
    if (!game) return;
    if (msg.type === 'arcade:ready') {
      this.readyAt = Date.now();
      clearTimeout(this.stallTimer);
      this.postInit();
      this.nodes.playerStatus.textContent = 'LIVE';
      return;
    }
    if (msg.type === 'arcade:close') { this.closeGame(); return; }
    if (msg.type === 'arcade:state') {
      this.heardAt = Date.now();
      this.nodes.playerStatus.textContent = msg.payload.status
        || (msg.payload.day ? `DAY ${msg.payload.day}` : `SCORE ${msg.payload.score}`);
      return;
    }
    if (msg.type === 'arcade:score') {
      const run = msg.payload;
      this.lastScore = run;
      await this.stats.submitRun(game.id, run, this.getPlayer().name);
      // that run just changed the board: drop the cached copy so the next
      // player (or the next round) sees it, without refetching right now
      this.stats.boards?.delete?.(game.id);
      this.boards.delete(game.id);
      this.loadBoard(game.id).catch(() => {});
      this.nodes.playerStatus.textContent = 'RUN LOGGED';
      this.nodes.result.classList.remove('hidden');
      this.nodes.result.innerHTML = `
        <b>RUN LOGGED</b>
        <span>SCORE ${run.score}${run.day ? ` · DAY ${run.day}` : ''}${run.seconds ? ` · ${run.seconds}s` : ''}</span>
        <span class="ap-best">${this.stats.myRating(game.id) ? 'RATED' : 'RATE THIS GAME'}</span>
        <span class="ap-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-stars="${n}"
          class="${this.stats.myRating(game.id) >= n ? 'on' : ''}">★</button>`).join('')}</span>
        <button type="button" class="ap-again" data-ap="again">PLAY AGAIN</button>
        <button type="button" class="ap-exit" data-ap="exit">BACK TO ARCADE</button>`;
      this.nodes.result.querySelectorAll('[data-stars]').forEach((b) => {
        b.addEventListener('click', async () => {
          await this.stats.rate(game.id, Number(b.dataset.stars));
          this.nodes.result.querySelectorAll('[data-stars]').forEach((x) => {
            x.classList.toggle('on', Number(x.dataset.stars) <= Number(b.dataset.stars));
          });
          this.toast('THANKS FOR RATING');
        });
      });
      this.nodes.result.querySelector('[data-ap="again"]')?.addEventListener('click', () => this.launch(game.id));
      this.nodes.result.querySelector('[data-ap="exit"]')?.addEventListener('click', () => this.closeGame());
      return;
    }
  }

  toast(text) {
    const el = document.createElement('div');
    el.className = 'arc-toast';
    el.textContent = text;
    this.el.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.el?.remove();
  }
}
