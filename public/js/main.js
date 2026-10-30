import { Account } from './account.js';
import { AuthUI } from './authui.js';
import { Arcade } from './arcade.js';
import { mountPreview } from './preview.js';
import {
  installFullscreen, toggleFullscreen, isFullscreen, readPreference,
} from './fullscreen.js';
import { TIERS, describeTier, isKnownQuality } from './graphics.js';
import {
  installAutoLandscape, forceLandscape, requestPortrait, isPortrait, landscapeState,
} from './orientation.js';
import { MODES, DEFAULT_MODE, modeById } from './modes.js';
import { loadBook, bestLine, careerLine, resetBook } from './records.js';
import {
  SKIN_TONES, OUTFIT_COLORS, HAIR_STYLES, HAIR_COLORS, ACCESSORIES,
  DEFAULT_CUSTOM, normalizeCustom, resolveCustom, describeCustom,
} from './customize.js';
import { BODY_COLORS, CAR_COLORS, hexToInt } from './palette.js';

const $ = (id) => document.getElementById(id);

const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
const isCoarse = window.matchMedia?.('(pointer: coarse)')?.matches;
const isPhone = isTouch && Math.min(window.screen?.width || 9999, window.screen?.height || 9999) < 820;

const state = {
  name: '',
  color: BODY_COLORS[0],
  carColor: CAR_COLORS[0],
  room: 'highway-01',
  guest: true,
  quality: 'auto',
  mode: DEFAULT_MODE,
  custom: { ...DEFAULT_CUSTOM },
};

const saveLocal = () => {
  try {
    localStorage.setItem('outrun-profile', JSON.stringify({
      room: state.room, quality: state.quality, mode: state.mode, custom: state.custom,
    }));
  } catch {}
};
try {
  const saved = JSON.parse(localStorage.getItem('outrun-profile') || '{}');
  if (saved.room) state.room = saved.room;
  if (['auto', 'low', 'medium', 'high', 'ultra'].includes(saved.quality)) state.quality = saved.quality;
  if (MODES.some((m) => m.id === saved.mode)) state.mode = saved.mode;
  if (saved.custom) state.custom = normalizeCustom(saved.custom);
} catch {}

// ------------------------------------------------------------------ account
const account = new Account();
let game = null;
let admin = null;
let arcade = null;
let authUI = null;
let starting = false;

// ---------------------------------------------------------------- avatars
/**
 * THE 3D KIT IS LAZY ON PURPOSE.
 *
 * `game.js` pulls in three.js plus the world, vehicle, avatar, tornado, HUD and
 * crafting modules — about a megabyte. The home screens need none of it, so it
 * is fetched on demand. Two rules keep that from ever looking "stuck":
 *
 *   1. It is warmed the moment the menu is interactive — not on
 *      requestIdleCallback, which on this page may never fire because the
 *      avatar preview keeps drawing frames.
 *   2. A press of PLAY shows real progress (bytes on the wire, not a spinner),
 *      keeps the menu usable, and recovers with a retry if anything fails.
 */
const KIT_FILES = [
  // [path relative to this module, weight in KB] — weights only drive the bar
  ['../vendor/three.module.js', 671],
  ['./game.js', 89],
  ['./world.js', 38],
  ['./buildings.js', 34],
  ['./admin.js', 25],
  ['./hud.js', 20],
  ['./avatar.js', 17],
  ['./vehicle.js', 15],
  ['./recipes.js', 9],
  ['./inventory.js', 9],
  ['./materials.js', 9],
  ['./enemies.js', 8],
  ['./tornado.js', 7],
  ['./net.js', 7],
  ['./items.js', 7],
  ['./records.js', 7],
  ['./loot.js', 5],
  ['./audio.js', 5],
  ['./customize.js', 4],
  ['./effects.js', 3],
  ['./modes.js', 3],
  ['./utils.js', 2],
  ['./palette.js', 1],
];

let kitPromise = null;
const kitProgress = { loaded: 0, total: KIT_FILES.reduce((n, [, kb]) => n + kb, 0), ratio: 0 };
const progressHandlers = new Set();

/** Subscribe to loader progress. Returns an unsubscribe function. */
export function onKitProgress(fn) {
  progressHandlers.add(fn);
  try { fn(kitProgress); } catch { /* a broken listener must not break loading */ }
  return () => progressHandlers.delete(fn);
}

export const kitProgressState = () => ({ ...kitProgress });

function reportKit(bytes) {
  kitProgress.loaded = Math.min(kitProgress.total, kitProgress.loaded + bytes);
  kitProgress.ratio = kitProgress.total ? kitProgress.loaded / kitProgress.total : 1;
  for (const fn of progressHandlers) {
    try { fn(kitProgress); } catch { /* ignore */ }
  }
}

/**
 * Pulls the module graph into the HTTP cache ahead of the import, counting the
 * bytes as they arrive so the button can show a real percentage. If streaming
 * is unavailable the file weight is credited when the response lands — either
 * way the bar only ever moves forward.
 */
async function prefetchKit() {
  await Promise.all(KIT_FILES.map(async ([url, weight]) => {
    let credited = 0;
    const credit = (kb) => {
      const add = Math.max(0, Math.min(kb, weight - credited));
      if (add <= 0) return;
      credited += add;
      reportKit(add);
    };
    try {
      // no cache override: the server's ETag turns a repeat visit into a 304,
      // and a deploy is never masked by a stale force-cache hit
      const res = await fetch(new URL(url, import.meta.url).href);
      if (!res.ok) throw new Error(`http ${res.status}`);
      if (res.body?.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          credit((value?.byteLength || 0) / 1024);
        }
      } else {
        await res.arrayBuffer();
      }
    } catch { /* a missing file must not stall the bar */ }
    credit(weight);            // whatever did not stream is counted at the end
  }));
}

export function loadGameKit() {
  if (!kitPromise) {
    const started = prefetchKit().catch(() => {});
    kitPromise = Promise.all([started, import('./game.js'), import('./admin.js')])
      .then(([, gameMod, adminMod]) => ({ Game: gameMod.Game, mountAdmin: adminMod.mountAdmin }))
      .catch((err) => { kitPromise = null; throw err; });
  }
  return kitPromise;
}

/**
 * Warm the kit as soon as the menu is interactive. `requestIdleCallback` alone
 * is not enough: this page draws the avatar preview every frame, so a browser
 * can stay "busy" for minutes and never fire it — which is exactly how PLAY
 * ended up doing a cold megabyte download on a phone.
 */
let warmTimer = null;
export function warmGameKit({ delay = 600 } = {}) {
  if (kitPromise) return kitPromise;
  if (warmTimer) return kitPromise;
  const run = () => { loadGameKit().catch(() => {}); };
  warmTimer = setTimeout(run, delay);
  // and again on the first real interaction, in case the timer was throttled
  const kick = () => {
    clearTimeout(warmTimer);
    warmTimer = null;
    run();
  };
  try {
    window.addEventListener('pointerdown', kick, { once: true, passive: true });
    window.addEventListener('keydown', kick, { once: true });
  } catch { /* detached window */ }
  return kitPromise;
}

let fullscreenCtl = null;

let authPreview = null;
let lobbyPreview = null;
let lastFrame = performance.now();

function previewLoop(now) {
  requestAnimationFrame(previewLoop);
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  const authOpen = $('auth')?.classList.contains('show');
  if (authOpen) {
    if (authPreview) { authPreview.resize(); authPreview.render(dt); }
  } else if ($('lobby')?.classList.contains('show') && !game) {
    if (lobbyPreview) { lobbyPreview.resize(); lobbyPreview.render(dt); }
  }
}

function refreshPreviews() {
  const hex = hexToInt(state.color);
  const name = (state.name || 'SURVIVOR').toUpperCase().slice(0, 14);
  authPreview?.setAvatar(hex, name, state.custom);
  lobbyPreview?.setAvatar(hex, name, state.custom);
  const summary = $('customSummary');
  if (summary) summary.textContent = describeCustom(state.custom);
}

// ------------------------------------------------------------------ arcade
/**
 * The hub. Everything starts here: the built-in 100 Days Outrun plus every
 * community game merged from ./games/index.json.
 */
function showArcade() {
  $('auth').classList.remove('show');
  $('lobby').classList.remove('show');
  if (!arcade) {
    arcade = new Arcade({
      account,
      onPlayNative: () => showLobby(),
      getPlayer: () => ({
        name: state.name || 'WANDERER',
        color: state.color,
        room: state.room,
        custom: state.custom,
        quality: state.quality,
      }),
    });
  }
  arcade.show();
  arcade.refresh();
  // the hub's fullscreen button is created after the installer ran, so give it
  // the real state instead of the label it was born with
  fullscreenCtl?.sync();
}

// ------------------------------------------------------------------- lobby
function showLobby() {
  $('auth').classList.remove('show');
  document.body.classList.remove('run-live');
  document.documentElement.classList.remove('rot-stage');
  // the home is portrait again: unlock landscape and leave fullscreen
  requestPortrait();
  arcade?.hide();
  // coming back from a run must not leave the button stuck on its loading copy
  setLoading({ active: false });
  const play = $('playBtn');
  if (play) play.innerHTML = 'START THE RUN <span>▸</span>';
  $('lobby').classList.add('show');
  $('nameInput').value = state.name;
  $('roomInput').value = state.room;
  refreshPreviews();
  renderAccountChip();
  renderFriends();
  setTimeout(() => lobbyPreview?.resize(), 30);
}

function buildSwatches(container, colors, key) {
  if (!container) return;
  container.innerHTML = '';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${state[key] === c ? 'on' : ''}`;
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => {
      state[key] = c;
      [...container.children].forEach((x) => x.classList.toggle('on', x === b));
      refreshPreviews();
      persistProfileColors();
    });
    container.appendChild(b);
  });
}

let colorTimer = null;
function persistProfileColors() {
  clearTimeout(colorTimer);
  colorTimer = setTimeout(() => {
    account.saveProfile({
      body_color: state.color,
      car_color: state.carColor,
      customization: state.custom,
    });
  }, 600);
}

// ------------------------------------------------------- customization UI
const hexCss = (hex) => `#${(hex >>> 0).toString(16).padStart(6, '0')}`;

function paintSwatches(container, options, key, { tiny = false } = {}) {
  if (!container) return;
  container.innerHTML = '';
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `swatch ${tiny ? 'tiny ' : ''}${state.custom[key] === opt.id ? 'on' : ''}`;
    b.style.background = hexCss(opt.hex);
    b.title = opt.label;
    b.dataset.value = opt.id;
    b.addEventListener('click', () => {
      state.custom = normalizeCustom({ ...state.custom, [key]: opt.id });
      if (key === 'skin') state.color = hexCss(opt.hex);
      paintCustom();
      saveLocal();
      refreshPreviews();
      persistProfileColors();
    });
    container.appendChild(b);
  });
}

function paintChips(container, options, key) {
  if (!container) return;
  container.innerHTML = '';
  options.forEach((opt) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip ${state.custom[key] === opt.id ? 'on' : ''}`;
    b.dataset.value = opt.id;
    b.innerHTML = `<i>${opt.icon || ''}</i>${opt.label}`;
    b.addEventListener('click', () => {
      state.custom = normalizeCustom({ ...state.custom, [key]: opt.id });
      if (key === 'skin') state.color = hexCss(opt.hex);
      paintCustom();
      saveLocal();
      refreshPreviews();
      persistProfileColors();
    });
    container.appendChild(b);
  });
}

function paintCustom() {
  paintSwatches($('skinRow'), SKIN_TONES, 'skin');
  paintSwatches($('colorRow'), OUTFIT_COLORS, 'outfit');
  paintChips($('hairRow'), HAIR_STYLES, 'hair');
  paintSwatches($('hairColorRow'), HAIR_COLORS, 'hairColor', { tiny: true });
  paintChips($('gearRow'), ACCESSORIES, 'accessory');

  const h = $('heightRange');
  const b = $('buildRange');
  if (h) h.value = String(Math.round(state.custom.height * 100));
  if (b) b.value = String(Math.round(state.custom.build * 100));
  if ($('heightVal')) $('heightVal').textContent = `${Math.round(state.custom.height * 100)}%`;
  if ($('buildVal')) $('buildVal').textContent = `${Math.round(state.custom.build * 100)}%`;
  if ($('customSummary')) $('customSummary').textContent = describeCustom(state.custom);
}

function bindCustomControls() {
  const bindSlider = (id, valId, key) => {
    $(id)?.addEventListener('input', (e) => {
      state.custom = normalizeCustom({ ...state.custom, [key]: Number(e.target.value) / 100 });
      if ($(valId)) $(valId).textContent = `${e.target.value}%`;
      if ($('customSummary')) $('customSummary').textContent = describeCustom(state.custom);
      refreshPreviews();
      saveLocal();
    });
    $(id)?.addEventListener('change', () => persistProfileColors());
  };
  bindSlider('heightRange', 'heightVal', 'height');
  bindSlider('buildRange', 'buildVal', 'build');

  $('randomLook')?.addEventListener('click', () => {
    const pickOf = (list) => list[Math.floor(Math.random() * list.length)].id;
    state.custom = normalizeCustom({
      skin: pickOf(SKIN_TONES),
      outfit: pickOf(OUTFIT_COLORS),
      hair: pickOf(HAIR_STYLES),
      hairColor: pickOf(HAIR_COLORS),
      accessory: pickOf(ACCESSORIES),
      height: 0.9 + Math.random() * 0.2,
      build: 0.88 + Math.random() * 0.24,
    });
    paintCustom();
    saveLocal();
    refreshPreviews();
    persistProfileColors();
  });
}

// --------------------------------------------------------------- account UI
function renderAccountChip() {
  const nameEl = $('accountName');
  const metaEl = $('accountMeta');
  const dot = $('accountDot');
  if (!nameEl) return;
  nameEl.textContent = account.displayName || state.name || 'GUEST';
  if (account.signedIn) {
    metaEl.textContent = `@${account.username}`;
    dot.style.background = state.color;
    dot.style.boxShadow = `0 0 10px ${state.color}`;
  } else {
    metaEl.textContent = account.canUseAccounts ? 'GUEST · LOCAL ONLY' : 'GUEST · ACCOUNTS OFFLINE';
    dot.style.background = '#6b7385';
    dot.style.boxShadow = 'none';
  }
  const out = $('signOutBtn');
  if (out) out.style.display = account.signedIn ? 'grid' : 'none';
}

function applyProfileToState(profile) {
  if (!profile) return;
  state.name = (profile.display_name || profile.username || 'SURVIVOR').toUpperCase().slice(0, 14);
  state.color = profile.body_color || state.color;
  state.carColor = profile.car_color || state.carColor;
  if (profile.customization) {
    state.custom = normalizeCustom(profile.customization);
  } else if (profile.body_color) {
    const target = hexToInt(profile.body_color);
    const near = SKIN_TONES.reduce((best, t) => {
      const d = Math.abs(((t.hex >> 16) & 255) - ((target >> 16) & 255))
        + Math.abs(((t.hex >> 8) & 255) - ((target >> 8) & 255))
        + Math.abs((t.hex & 255) - (target & 255));
      return d < best.d ? { d, id: t.id } : best;
    }, { d: Infinity, id: state.custom.skin });
    state.custom = normalizeCustom({ ...state.custom, skin: near.id });
  }
  if ($('nameInput')) $('nameInput').value = state.name;
}

// ---------------------------------------------------------------- friends UI
function renderFriends() {
  const list = $('friendsList');
  const count = $('friendsCount');
  const note = $('friendsNote');
  if (!list) return;

  if (!account.signedIn) {
    list.innerHTML = '<div class="friends-empty">Sign in with a username to keep a friends list and see who is on the highway right now.</div>';
    if (count) count.textContent = '0';
    if (note) { note.className = 'friends-note'; note.textContent = account.canUseAccounts ? 'Log in to add friends.' : 'Connect Supabase to enable accounts & friends.'; }
    const addRow = document.querySelector('.add-friend');
    if (addRow) addRow.style.display = 'none';
    return;
  }

  const addRow = document.querySelector('.add-friend');
  if (addRow) addRow.style.display = 'flex';
  if (count) count.textContent = String(account.friends.length);

  if (!account.friends.length) {
    list.innerHTML = `<div class="friends-empty">${account.friendsLoading ? 'Loading friends…' : 'No friends yet — add someone by username below.'}</div>`;
  } else {
    list.innerHTML = account.friends.map((f) => `
      <div class="friend-row ${f.online ? 'online' : ''}" data-id="${f.id}">
        <i class="friend-av" style="background:${f.color}"></i>
        <div class="friend-meta">
          <b>${escapeHtml(f.displayName)}</b>
          <span>${f.online ? `IN GAME · DAY ${f.day ?? '?'} · ${escapeHtml(f.room || 'lobby')}` : 'OFFLINE'}</span>
        </div>
        ${f.online && f.room ? `<button class="friend-join" data-join="${escapeHtml(f.room)}">JOIN</button>` : ''}
        <button class="friend-del" data-del="${f.id}" title="Remove friend">✕</button>
      </div>`).join('');

    list.querySelectorAll('[data-join]').forEach((b) => {
      b.addEventListener('click', () => {
        state.room = b.dataset.join;
        $('roomInput').value = state.room;
        saveLocal();
        setFriendNote(`Room set to ${state.room} — press START THE RUN`, 'ok');
      });
    });
    list.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await account.removeFriend(b.dataset.del);
          setFriendNote('Friend removed.', '');
        } catch (e) {
          setFriendNote(e.message || 'Could not remove friend.', 'err');
        }
      });
    });
  }

  if (note && !note.textContent) {
    note.textContent = account.friendsLoading ? 'Syncing…' : '';
  }
}

/**
 * The loading indicator is a slim chip, not a screen. It sits above the PLAY
 * button, keeps the menu usable underneath, and disappears the moment the world
 * is on screen. There is deliberately no way for it to cover the game.
 */
function setLoading({ active = false, pct = null, note = '' } = {}) {
  const chip = $('loading');
  if (chip) {
    chip.classList.toggle('show', Boolean(active));
    chip.classList.toggle('gone', !active);
    const text = chip.querySelector?.('.ld-text') || null;
    if (text) text.textContent = note || (active ? 'LOADING' : '');
    if (pct !== null) {
      const bar = chip.querySelector?.('.ld-bar i');
      if (bar?.style) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      chip.setAttribute?.('data-pct', String(Math.round(pct)));
    }
  }
  const btn = $('playBtn');
  if (btn) btn.classList.toggle('loading', Boolean(active));
}

/** Toast that works before the 3D HUD exists. */
function hudToast(text, kind = '') {
  try {
    setFriendNote(text, kind === 'warn' ? 'err' : kind);
  } catch { /* menu already gone */ }
  const status = $('netStatus');
  if (status) status.textContent = text;
}

function setFriendNote(text, kind = '') {
  const note = $('friendsNote');
  if (!note) return;
  note.className = `friends-note ${kind}`.trim();
  note.textContent = text;
  if (text) setTimeout(() => { if (note.textContent === text) { note.textContent = ''; note.className = 'friends-note'; } }, 5000);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function addFriend() {
  const input = $('addFriendInput');
  const name = (input?.value || '').trim();
  if (!name) return;
  if (!account.signedIn) { setFriendNote('Sign in to add friends.', 'err'); return; }
  setFriendNote('Looking up…', '');
  try {
    const target = await account.addFriend(name);
    input.value = '';
    setFriendNote(`${target.display_name || target.username} added.`, 'ok');
  } catch (e) {
    setFriendNote(e.message || 'Could not add friend.', 'err');
  }
}

// ----------------------------------------------------------------- net probe
async function probeRelay() {
  const el = $('netStatus');
  if (!el) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      el.textContent = `● RELAY READY (${data.mode || 'node'}) — SHARE THE ROOM CODE TO PLAY TOGETHER`;
      el.className = 'net-status ok';
      return;
    }
  } catch {}
  el.textContent = '● STATIC MODE — OPEN TWO TABS FOR LOCAL CO-OP';
  el.className = 'net-status warn';
}

// --------------------------------------------------------------------- game
async function startRun() {
  if (starting) return;
  starting = true;
  state.name = (($('nameInput')?.value || '').trim() || 'WANDERER').toUpperCase().slice(0, 14);
  state.room = (($('roomInput')?.value || '').trim() || 'highway-01').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 12) || 'highway-01';
  saveLocal();
  account.saveProfile({ display_name: state.name, body_color: state.color, car_color: state.carColor });

  // Turning the phone has to happen inside this click, but it must never delay
  // the game: fire it and carry on. `run-live` is added once the kit is ready.
  if (isPhone && !landscapeTried && isPortrait()) goLandscape();

  const btn = $('playBtn');
  const btnLabel = btn ? btn.innerHTML : '';
  const fails = [];
  setLoading({ active: true, pct: 0, note: 'LOADING THE 3D ENGINE' });
  const stopCounter = onKitProgress((p) => {
    const pct = Math.round((p.ratio || 0) * 100);
    setLoading({ active: true, pct, note: pct >= 100 ? 'STARTING ENGINE' : `LOADING THE 3D ENGINE · ${pct}%` });
    if (btn) btn.innerHTML = `LOADING ${pct}%`;
  });

  // Play is a gesture: the one reliable moment to honour a saved fullscreen
  // preference. Fire and forget — it must not gate the run.
  if (!isFullscreen() && readPreference()) {
    toggleFullscreen({ on: true }).then(() => fullscreenCtl?.sync()).catch(() => {});
  }

  // NO BLOCKING LOADING SCREEN: the menu stays on screen and usable while the
  // engine streams in. If anything fails we simply stay here with a retry.
  let kit = null;
  try {
    kit = await loadGameKit();
  } catch (err) {
    console.error('[load] game kit failed', err);
    fails.push(String(err?.message || err));
  }
  stopCounter();
  if (!kit) {
    setLoading({ active: false });
    document.body.classList.remove('run-live', 'auto-land');
    document.documentElement.classList.remove('rot-stage');
    requestPortrait();                  // the menu is portrait: hand it back
    if (btn) btn.innerHTML = btnLabel;
    setFriendNote('Could not load the 3D engine — check your connection and press PLAY again.', 'err');
    hudToast('LOAD FAILED — TAP PLAY TO RETRY', 'warn');
    starting = false;
    return;
  }

  document.body.classList.add('run-live');
  // The arcade hands the iframe a landscape stage, so re-check after the lock.
  // If the device still refuses to turn, the run itself is rotated in CSS:
  // `auto-land` marks "portrait + no lock", `run-live` says the stage is up.
  if (isPhone && isPortrait() && !landscapeState().locked) {
    document.body.classList.add('auto-land');
    document.documentElement.classList.add('rot-stage');
  }

  if (btn) btn.innerHTML = 'DROPPING IN…';
  setLoading({ active: true, pct: 100, note: 'DROPPING IN' });

  await new Promise((r) => setTimeout(r, 60));

  // the menu stays up until this exact moment, so nothing ever looks stuck
  $('lobby').classList.remove('show');
  $('loading').classList.add('gone');

  try {
    game = new kit.Game({
      mount: $('app'),
      profile: {
        name: state.name,
        color: hexToInt(state.color),
        carColor: hexToInt(state.carColor),
        custom: state.custom,
      },
      room: state.room,
      quality: state.quality,
      mode: state.mode,
      onQuit: () => location.reload(),
      onRunEnd: (stats) => {
        account.recordRun(stats);
        account.setPresence({ status: 'lobby', room: null });
      },
    });
    game.audio.init();
    game.audio.blip(560, 0.18, 'square', 0.1);
    game.started = true;
    game.hud.show();
    game.hud.chat('', `ROOM ${state.room.toUpperCase()} — SHARE THE CODE TO SURVIVE TOGETHER`, '#ffd9a0', true);
    game.hud.toast('DAY 1 · OAKHAVEN OUTSKIRTS', 'warn');
    setTimeout(() => game?.hud.toast(isPhone ? 'LEFT STICK DRIVES · TAP ⚓ TO ANCHOR' : 'COLLECT FUEL · REACH THE HIGHWAY', ''), 1800);
    if (account.signedIn) account.setPresence({ status: 'playing', room: state.room, day: 1 });
    admin = kit.mountAdmin({
      game,
      account,
      survivorName: state.name,
      onBan: (u) => game?.hud.toast(`@${u} BANNED FROM THE ROOM`, 'warn'),
    });
    if (admin) {
      game.hud.toast(
        admin.mode === 'guest' ? 'OWNER CONSOLE READY — PRESS ⌘ OWNER OR THE BACKQUOTE KEY' : 'OWNER CONSOLE UNLOCKED',
        'good'
      );
    }
  } catch (err) {
    console.error(err);
    setLoading({ active: false });
    document.body.classList.remove('run-live', 'auto-land');
    document.documentElement.classList.remove('rot-stage');
    requestPortrait();
    if (btn) btn.innerHTML = btnLabel;
    setFriendNote(`Could not start: ${err.message}`, 'err');
    hudToast('COULD NOT START — TAP PLAY TO RETRY', 'warn');
    starting = false;
    return;
  }

  setLoading({ active: false });
  starting = false;
}

// presence: keep the friend list honest while playing
setInterval(() => {
  if (!account.signedIn) return;
  if (game && game.started && !game.dead && !game.won) {
    account.setPresence({ status: 'playing', room: state.room, day: game.day });
  }
}, 21_000);

// ------------------------------------------------------------ phone handling
/**
 * Best-effort landscape lock. Android Chrome / Samsung Internet only allow
 * `screen.orientation.lock()` while the page is fullscreen, so we ask for both;
 * iOS refuses both and falls back to the rotate hint. Never throws, never blocks.
 */
let landscapeTried = false;
/** Kept as a thin alias: the real work lives in orientation.js now. */
async function goLandscape() {
  if (!isPhone) return false;
  landscapeTried = true;
  return forceLandscape();
}

function phoneSetup() {
  if (isTouch || isCoarse) document.body.classList.add('touch');
  const rotate = $('rotateHint');
  // Show the "rotate for a wider road" hint ONCE per session. Dismissing it
  // used to be undone by the polling loop, which made the game unplayable in
  // portrait; the portrait HUD is now usable on its own.
  let rotateSeen = false;
  let rotateDismissed = false;
  const sync = () => {
    if (!isPhone || !rotate) return;
    if (rotateDismissed || rotateSeen) { rotate.classList.remove('show'); return; }
    const portrait = window.innerHeight > window.innerWidth;
    const playing = game && game.started && !game.dead && !game.won && !game.paused;
    // if the run is already rotated into landscape for us, asking the player to
    // turn the phone would be noise — the picture is sideways on purpose
    const alreadyWide = document.body.classList.contains('auto-land')
      && document.body.classList.contains('run-live');
    if (portrait && playing && !alreadyWide) { rotateSeen = true; rotate.classList.add('show'); }
    else rotate.classList.remove('show');
  };
  window.addEventListener('orientationchange', () => setTimeout(sync, 220));
  window.addEventListener('resize', sync);
  setInterval(sync, 1200);
  $('rotateDismiss')?.addEventListener('click', () => {
    rotateDismissed = true;
    rotate?.classList.remove('show');
  });
  $('rotateLock')?.addEventListener('click', async () => {
    const locked = await goLandscape();
    if (locked || window.innerWidth > window.innerHeight) {
      rotateDismissed = true;
      rotate?.classList.remove('show');
    }
  });
  if (isPhone) {
    document.querySelector('meta[name="viewport"]')
      ?.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
  }
  // keep full height correct when mobile browser chrome slides away
  const vv = window.visualViewport;
  if (vv) {
    const fit = () => document.documentElement.style.setProperty('--vh', `${vv.height * 0.01}px`);
    vv.addEventListener('resize', fit);
    fit();
  }
}

// ------------------------------------------------------------------- locking
window.addEventListener('resize', () => {
  authPreview?.resize();
  lobbyPreview?.resize();
});

// ---------------------------------------------------------------------- boot
async function boot() {
  authPreview = mountPreview($('previewCanvas'));
  lobbyPreview = mountPreview($('previewCanvasLobby'));
  authPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  lobbyPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  requestAnimationFrame(previewLoop);

  await account.boot();
  applyProfileToState(account.profile);
  state.name = state.name || 'WANDERER';
  if (!account.profile?.username || account.profile.username === 'GUEST') state.name = 'WANDERER';

  const carRow = $('carRow');
  buildSwatches(carRow, CAR_COLORS, 'carColor');
  paintCustom();
  bindCustomControls();

  $('nameInput')?.addEventListener('input', (e) => {
    state.name = e.target.value.trim().toUpperCase().slice(0, 14);
    authPreview?.setAvatar(hexToInt(state.color), state.name || 'SURVIVOR');
    lobbyPreview?.setAvatar(hexToInt(state.color), state.name || 'SURVIVOR');
  });
  $('nameInput')?.addEventListener('change', () => {
    account.saveProfile({ display_name: state.name || 'SURVIVOR' });
  });
  $('roomInput')?.addEventListener('input', (e) => {
    state.room = e.target.value.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 12) || 'highway-01';
    e.target.value = state.room;
    saveLocal();
  });
  $('randomRoom')?.addEventListener('click', () => {
    const words = ['highway', 'ash', 'storm', 'rust', 'convoy', 'dust', 'chrome', 'deadwind'];
    state.room = `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 89 + 10)}`;
    $('roomInput').value = state.room;
    saveLocal();
  });
  // game modes: several runs inside the run
  const modeRow = $('modeRow');
  const recordBook = loadBook();
  const paintMode = () => {
    const mode = modeById(state.mode);
    if ($('modeName')) $('modeName').textContent = mode.name;
    if ($('modeBlurb')) $('modeBlurb').textContent = mode.blurb;
    modeRow?.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode.id));
  };
  const paintCareer = () => {
    if ($('careerLine')) $('careerLine').textContent = careerLine(recordBook);
  };
  paintCareer();
  $('clearRecords')?.addEventListener('click', () => {
    resetBook();
    Object.keys(recordBook.modes).forEach((k) => delete recordBook.modes[k]);
    Object.assign(recordBook.career, { runs: 0, wins: 0, km: 0, kills: 0, looted: 0, crafted: 0, seconds: 0, bestDay: 0 });
    paintCareer();
    modeRow?.querySelectorAll('[data-mode]').forEach((b) => {
      const line = b.querySelector('.mode-best');
      if (line) line.textContent = bestLine(recordBook, b.dataset.mode);
    });
    $('careerLine')?.classList.add('flash');
    setTimeout(() => $('careerLine')?.classList.remove('flash'), 700);
  });
  if (modeRow) {
    modeRow.innerHTML = MODES.map((m) => `
      <button type="button" class="mode-card" data-mode="${m.id}" style="--m:${m.accent}">
        <span class="mode-ico">${m.icon}</span>
        <b>${m.name}</b>
        <em>${m.sub}</em>
        <i>${m.tags.join(' · ')}</i>
        <span class="mode-best">${bestLine(recordBook, m.id)}</span>
      </button>`).join('');
    modeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      state.mode = btn.dataset.mode;
      paintMode();
      saveLocal();
    });
  }
  paintMode();

  // graphics quality: persisted, applied on the next launch
  const qualityRow = $('qualityRow');
  const paintQuality = () => {
    qualityRow?.querySelectorAll('[data-quality]').forEach((b) => {
      b.classList.toggle('on', b.dataset.quality === state.quality);
    });
    const hint = $('qualityHint');
    if (hint) {
      if (isKnownQuality(state.quality)) {
        const t = TIERS[state.quality];
        hint.innerHTML = `<b>${t.label}</b> — ${describeTier(state.quality)}. ${t.blurb}`;
      } else {
        hint.textContent = 'AUTO — picked for this device when the run starts';
      }
    }
  };
  qualityRow?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-quality]');
    if (!btn) return;
    state.quality = btn.dataset.quality;
    paintQuality();
    saveLocal();
  });
  paintQuality();

  $('playBtn')?.addEventListener('click', startRun);
  [$('nameInput'), $('roomInput')].forEach((el) => el?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startRun();
  }));
  $('addFriendBtn')?.addEventListener('click', addFriend);
  $('addFriendInput')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFriend(); } });
  $('friendsRefresh')?.addEventListener('click', async () => {
    setFriendNote('Refreshing…', '');
    await account.refreshFriends();
    setFriendNote('Friend list updated.', 'ok');
  });
  $('arcadeBtn')?.addEventListener('click', () => {
    $('lobby').classList.remove('show');
    showArcade();
  });
  $('signOutBtn')?.addEventListener('click', async () => {
    await account.signOut();
    applyProfileToState(account.profile);
    $('auth').classList.add('show');
    $('lobby').classList.remove('show');
    authUI.show();
    renderFriends();
  });

  account.on((kind) => {
    if (kind === 'friends') { renderFriends(); arcade?.renderFriends(); }
    if (kind === 'profile') renderAccountChip();
  });

  authUI = new AuthUI({
    account,
    onAuthenticated: (profile) => {
      applyProfileToState(profile);
      paintCustom();
      buildSwatches($('carRow'), CAR_COLORS, 'carColor');
      refreshPreviews();
      showArcade();
    },
    onGuest: (profile) => {
      applyProfileToState(profile);
      showArcade();
    },
    onColorsChanged: (colors) => {
      state.color = colors.body;
      state.carColor = colors.car;
      // the sign-in screen's body swatch is the skin tone: map it to the nearest one
      const target = hexToInt(colors.body);
      const near = SKIN_TONES.reduce((best, t) => {
        const d = Math.abs(((t.hex >> 16) & 255) - ((target >> 16) & 255))
          + Math.abs(((t.hex >> 8) & 255) - ((target >> 8) & 255))
          + Math.abs((t.hex & 255) - (target & 255));
        return d < best.d ? { d, id: t.id } : best;
      }, { d: Infinity, id: state.custom.skin });
      state.custom = normalizeCustom({ ...state.custom, skin: near.id });
      paintCustom();
      saveLocal();
      authPreview?.setAvatar(hexToInt(state.color), state.name || 'SURVIVOR', state.custom);
    },
  });

  // FULLSCREEN: one installer wires every [data-fullscreen] button on the page
  // (arcade bar, lobby header, in-game exit) plus Alt+Enter / Shift+F.
  // (delegated: every [data-fullscreen] button — lobby, arcade bar, in-run toggle
  // — is handled by the installer itself, so there is no double toggle)
  fullscreenCtl = installFullscreen();

  phoneSetup();
  // AUTO LANDSCAPE: installs on load, then retries on the first gesture, on
  // rotation back to portrait, and on leaving fullscreen.
  installAutoLandscape({ when: 'phone' });
  probeRelay();

  if (account.signedIn) {
    applyProfileToState(account.profile);
    paintCustom();
    buildSwatches($('carRow'), CAR_COLORS, 'carColor');
    refreshPreviews();
    showArcade();
    account.refreshFriends();
  } else {
    authUI.show();
    authPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  }

  setTimeout(() => $('loading').classList.add('gone'), 500);
  // the menu is interactive now; pull the 3D kit in the background so the first
  // PLAY press does not start a cold megabyte
  warmGameKit();
  document.documentElement.classList.add('booted');
}

boot();

window.__outrun = {
  state, account, startRun,
  get game() { return game; },
  get admin() { return admin; },
  get arcade() { return arcade; },
  get lobbyVisible() { return $('lobby')?.classList.contains('show'); },
};
