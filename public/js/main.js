import * as THREE from '../vendor/three.module.js';
import { buildAvatar } from './avatar.js';
import { Game } from './game.js';
import { Account } from './account.js';
import { AuthUI } from './authui.js';
import { mountAdmin } from './admin.js';
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
};

const saveLocal = () => {
  try {
    localStorage.setItem('outrun-profile', JSON.stringify({ room: state.room, quality: state.quality }));
  } catch {}
};
try {
  const saved = JSON.parse(localStorage.getItem('outrun-profile') || '{}');
  if (saved.room) state.room = saved.room;
  if (['auto', 'low', 'medium', 'high'].includes(saved.quality)) state.quality = saved.quality;
} catch {}

// ------------------------------------------------------------------ account
const account = new Account();
let game = null;
let admin = null;
let authUI = null;
let starting = false;

// ---------------------------------------------------------------- avatars
function makePreview(canvas) {
  if (!canvas) return null;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isPhone ? 1.5 : 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  camera.position.set(0, 1.55, 5.1);
  camera.lookAt(0, 1.2, 0);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x3b2c1b, 1.5));
  const key = new THREE.DirectionalLight(0xffd9a0, 3.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5ff0ff, 1.4);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const disc = new THREE.Mesh(new THREE.CircleGeometry(2.4, 40),
    new THREE.MeshStandardMaterial({ color: 0x1a2029, roughness: 0.9, metalness: 0.2 }));
  disc.rotation.x = -Math.PI / 2;
  scene.add(disc);
  const ring = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.5, 44),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.55, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  const stage = {
    canvas, renderer, scene, camera, avatar: null,
    yaw: -0.35, targetYaw: -0.35, dragging: false, lastX: 0,
    setAvatar(hex, name) {
      if (stage.avatar) scene.remove(stage.avatar.root);
      stage.avatar = buildAvatar({ color: hex, name });
      stage.avatar.root.rotation.y = stage.yaw;
      scene.add(stage.avatar.root);
    },
    resize() {
      const w = canvas.clientWidth || 380, h = canvas.clientHeight || 220;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    render(dt) {
      if (!stage.avatar) return;
      stage.yaw += (stage.targetYaw - stage.yaw) * 0.14;
      if (!stage.dragging) stage.targetYaw += dt * 0.22;
      stage.avatar.root.rotation.y = stage.yaw;
      stage.avatar.animate(dt, 0.16, false);
      renderer.render(scene, camera);
    },
  };

  canvas.addEventListener('pointerdown', (e) => {
    stage.dragging = true; stage.lastX = e.clientX;
    canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!stage.dragging) return;
    stage.targetYaw += (e.clientX - stage.lastX) * 0.012;
    stage.lastX = e.clientX;
  });
  const stop = (e) => { stage.dragging = false; canvas.releasePointerCapture?.(e.pointerId); };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return stage;
}

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
  authPreview?.setAvatar(hex, name);
  lobbyPreview?.setAvatar(hex, name);
}

// ------------------------------------------------------------------- lobby
function showLobby() {
  $('auth').classList.remove('show');
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
    account.saveProfile({ body_color: state.color, car_color: state.carColor });
  }, 600);
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

  // phones: go fullscreen + lock to landscape before the world is measured,
  // so the HUD lays itself out for the orientation the player will actually use
  if (isPhone && !landscapeTried) {
    await Promise.race([
      goLandscape(),
      new Promise((resolve) => setTimeout(() => resolve(false), 700)),
    ]);
  }

  const btn = $('playBtn');
  if (btn) btn.innerHTML = 'WARMING THE ENGINE…';
  $('lobby').classList.remove('show');
  $('loading').classList.remove('gone');

  await new Promise((r) => setTimeout(r, 140));

  try {
    game = new Game({
      mount: $('app'),
      profile: { name: state.name, color: hexToInt(state.color), carColor: hexToInt(state.carColor) },
      room: state.room,
      quality: state.quality,
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
    admin = mountAdmin({
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
    $('loading').classList.add('gone');
    $('lobby').classList.add('show');
    if (btn) btn.innerHTML = 'START THE RUN <span>▸</span>';
    setFriendNote(`Could not start: ${err.message}`, 'err');
    starting = false;
    return;
  }

  setTimeout(() => $('loading').classList.add('gone'), 250);
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
async function goLandscape() {
  if (!isPhone) return false;
  landscapeTried = true;
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el?.requestFullscreen) {
      await el.requestFullscreen({ navigationUI: 'hide' });
    }
  } catch {}
  try {
    const orientation = typeof screen !== 'undefined' ? screen.orientation : null;
    if (orientation?.lock) {
      await orientation.lock('landscape');
      return true;
    }
  } catch {}
  return false;
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
    if (portrait && playing) { rotateSeen = true; rotate.classList.add('show'); }
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
  authPreview = makePreview($('previewCanvas'));
  lobbyPreview = makePreview($('previewCanvasLobby'));
  authPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  lobbyPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  requestAnimationFrame(previewLoop);

  await account.boot();
  applyProfileToState(account.profile);
  state.name = state.name || 'WANDERER';
  if (!account.profile?.username || account.profile.username === 'GUEST') state.name = 'WANDERER';

  const bodyRow = $('colorRow');
  const carRow = $('carRow');
  buildSwatches(bodyRow, BODY_COLORS, 'color');
  buildSwatches(carRow, CAR_COLORS, 'carColor');

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
  // graphics quality: persisted, applied on the next launch
  const qualityRow = $('qualityRow');
  const paintQuality = () => {
    qualityRow?.querySelectorAll('[data-quality]').forEach((b) => {
      b.classList.toggle('on', b.dataset.quality === state.quality);
    });
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
  $('signOutBtn')?.addEventListener('click', async () => {
    await account.signOut();
    applyProfileToState(account.profile);
    $('auth').classList.add('show');
    $('lobby').classList.remove('show');
    authUI.show();
    renderFriends();
  });

  account.on((kind) => {
    if (kind === 'friends') renderFriends();
    if (kind === 'profile') renderAccountChip();
  });

  authUI = new AuthUI({
    account,
    onAuthenticated: (profile) => {
      applyProfileToState(profile);
      buildSwatches($('colorRow'), BODY_COLORS, 'color');
      buildSwatches($('carRow'), CAR_COLORS, 'carColor');
      refreshPreviews();
      showLobby();
    },
    onGuest: (profile) => {
      applyProfileToState(profile);
      showLobby();
    },
    onColorsChanged: (colors) => {
      state.color = colors.body;
      state.carColor = colors.car;
      authPreview?.setAvatar(hexToInt(state.color), state.name || 'SURVIVOR');
    },
  });

  phoneSetup();
  probeRelay();

  if (account.signedIn) {
    applyProfileToState(account.profile);
    buildSwatches($('colorRow'), BODY_COLORS, 'color');
    buildSwatches($('carRow'), CAR_COLORS, 'carColor');
    refreshPreviews();
    showLobby();
    account.refreshFriends();
  } else {
    authUI.show();
    authPreview?.setAvatar(hexToInt(state.color), 'SURVIVOR');
  }

  setTimeout(() => $('loading').classList.add('gone'), 500);
}

boot();

window.__outrun = { state, account, get game() { return game; }, get admin() { return admin; }, startRun };
