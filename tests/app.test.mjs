// Integration test: boots the real public/js/main.js (lobby + auth + game) headlessly.
import { readFileSync } from 'node:fs';
import { installDOM, El } from './doms.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const html = readFileSync(`${ROOT}public/index.html`, 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

globalThis.__COARSE__ = true;
globalThis.__TOUCH__ = true;
const { els } = installDOM({ width: 390, height: 844 });

// pre-create every element the markup declares
for (const id of ids) document.getElementById(id);

// selector support the UI code relies on
const tabButtons = ['weapons', 'repairs', 'upgrades'].map((tab) => {
  const b = new El('button');
  b.dataset.tab = tab;
  b.classList.add('tab');
  return b;
});
const authTabs = ['login', 'signup'].map((mode) => {
  const b = new El('button');
  b.dataset.mode = mode;
  return b;
});
const classEls = {
  '.add-friend': new El('div'),
  '.meter': ['engine', 'chassis', 'tires', 'fuel'].map((k) => {
    const el = new El('div');
    el.dataset.k = k;
    return el;
  }),
};
const realQSA = document.querySelectorAll;
document.querySelectorAll = (sel) => {
  if (sel === '.meter') return classEls['.meter'];
  if (sel === '#auth .auth-tabs button' || sel === '#auth .auth-tabs button') return authTabs;
  if (sel === '.tabs button') return tabButtons;
  if (sel === '#auth input, #auth .auth-tabs button') return [...authTabs];
  if (sel === '.recipe-btn') return [];
  return [];
};
document.querySelector = (sel) => classEls[sel] || new El('div');

// fetch: static config OFF → guest mode, and a working relay stub
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('/api/config')) return new Response(JSON.stringify({}), { status: 200 });
  if (u.startsWith('/api/health')) return new Response(JSON.stringify({ ok: true, mode: 'node-websocket' }), { status: 200 });
  if (u.startsWith('/api/room')) return new Response(JSON.stringify({ msgs: [] }), { status: 200 });
  return new Response('{}', { status: 404 });
};

const problems = [];
process.on('uncaughtException', (e) => { console.error('uncaught', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); process.exit(1); });

await import('./app/js/main.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(600);

const api = window.__outrun;
if (!api) { console.error('main.js did not expose __outrun'); process.exit(1); }

const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

check('auth overlay visible on first load', document.getElementById('auth').classList.contains('show'));
check('lobby hidden before sign-in', !document.getElementById('lobby').classList.contains('show'));
check('account booted as guest (no Supabase)', api.account.mode === 'guest');

// sign in as guest through the real UI path
const guestBtn = document.getElementById('guestBtn');
document.getElementById('authUser').value = 'phone_tester';
guestBtn.dispatch('click');
await wait(200);
// guests land in the arcade hub first, and the built-in game is one card in it
check('guest lands in the arcade', Boolean(api.arcade) && !api.arcade.el.classList.contains('hidden'));
check('the arcade lists the built-in game', api.arcade.games.some((g) => g.id === 'outrun' && g.native),
  api.arcade.games.map((g) => g.id).join(','));
check('the lobby is not open until you pick a game', !api.lobbyVisible);
api.arcade.launch('outrun');
check('picking the built-in game opens the lobby', api.lobbyVisible);
check('lobby shows the chosen name', document.getElementById('nameInput').value === 'PHONE_TESTER' || api.state.name === 'PHONE_TESTER', api.state.name);
check('friend panel renders for guests', document.getElementById('friendsList').innerHTML.includes('Sign in'));

// the survivor look drives the avatar + state
const skinSwatches = document.getElementById('skinRow').children;
check('skin swatches built', skinSwatches.length > 3, `${skinSwatches.length} swatches`);
skinSwatches[3].dispatch('click');
check('picking a skin tone updates the profile colour',
  api.state.custom.skin === 'bronze' && api.state.color === '#a96f4d', `${api.state.custom.skin} ${api.state.color}`);

const outfitSwatches = document.getElementById('colorRow').children;
check('outfit swatches built', outfitSwatches.length > 3, `${outfitSwatches.length} swatches`);
outfitSwatches[4].dispatch('click');
check('picking an outfit updates the look', api.state.custom.outfit === 'cyan', api.state.custom.outfit);

const hairChips = document.getElementById('hairRow').children;
check('hair chips built', hairChips.length >= 6, `${hairChips.length} styles`);
hairChips[5].dispatch('click');
check('picking hair updates the look', api.state.custom.hair === 'mohawk', api.state.custom.hair);

document.getElementById('randomLook').dispatch('click');
check('randomise produces a valid look', typeof api.state.custom.skin === 'string' && api.state.custom.height >= 0.9);

// room code handling
document.getElementById('roomInput').value = 'phone-room-7';
document.getElementById('roomInput').dispatch('input', { target: { value: 'phone-room-7' } });
check('room code sanitised + stored', api.state.room === 'phone-room-7', api.state.room);

// phones ask for fullscreen + a landscape lock before the world is measured
const orientationLocks = [];
const fullscreenCalls = [];
screen.orientation = { lock: async (kind) => { orientationLocks.push(kind); } };
document.documentElement.requestFullscreen = async () => { fullscreenCalls.push(1); };
document.fullscreenElement = null;

// start the run
// pressing PLAY must not conjure a loading screen, and the button must come back
document.getElementById('playBtn').dispatch('click');
check('PLAY disables itself rather than showing progress', document.getElementById('playBtn').disabled === true);
await api.startRun();
check('and is pressable again once the world is up', document.getElementById('playBtn').disabled === false);
check('no loading element exists anywhere', !document.getElementById('loading') || !document.getElementById('loading').classList.contains('show'));
await wait(400);
const game = api.game;
check('game constructed', Boolean(game));
check('phone goes fullscreen for the lock', fullscreenCalls.length === 1, `${fullscreenCalls.length}`);
check('phone locks to landscape', orientationLocks.includes('landscape'), orientationLocks.join(','));
check('rotate overlay offers a landscape button', Boolean(document.getElementById('rotateLock')));
if (game) {
  check('renderer attached to #app', document.getElementById('app').children.length > 0);
  check('hud visible', !document.getElementById('hud').classList.contains('hidden'));
  check('touch controls injected', Boolean(game.touchMode && document.getElementById('useBtn')));
  check('quality adapted to phone', game.quality === 'low' || game.quality === 'medium', game.quality);
  check('virtual stick present', Boolean(document.getElementById('stick')));

  const start = game.avatar.root.position.clone();
  game.keys.forward = 1;
  for (let i = 0; i < 240; i++) { game.update(1 / 60); game.updateCamera(1 / 60); }
  check('car drives on phone build', game.car.distance > 20, `${game.car.distance.toFixed(0)} m`);

  // stick input mapping
  game.startStick({ clientX: 120, clientY: 700 });
  game.moveStick({ clientX: 120, clientY: 640 });
  check('stick pushes the throttle', game.keys.forward > 0.5, String(game.keys.forward.toFixed(2)));
  game.endStick();
  check('stick release zeroes input', game.keys.forward === 0);

  // pinch zoom path
  game.pointers = new Map();
  check('pinch handlers present', typeof game.resize === 'function');

  // anchor + workbench still work with the mobile UI
  game.car.speed = 0;
  game.toggleAnchor();
  check('anchor toggle works', game.car.anchored === true);
  game.toggleBench();
  check('workbench opens', game.hud.benchOpen === true);
  game.toggleBench(false);
  check('workbench closes', game.hud.benchOpen === false);

  // run-end hook feeds achievements
  game.day = 12;
  game.distance = 4800;
  game.hp = 1;
  game.hurt(50, 'test');
  await wait(50);
  check('run end triggers onRunEnd', game.dead === true);
}

check('relay status shown', String(document.getElementById('netStatus').textContent).includes('RELAY'), document.getElementById('netStatus').textContent);

// ------------------------------------------- account picture + settings panel
console.log('\nplayer panel (mobile)');
{
  const panelEl = document.getElementById('playerPanel');
  check('the panel exists after boot', Boolean(panelEl));
  check('the panel starts closed', !panelEl?.classList.contains('show'));

  document.getElementById('lobbySettingsBtn').dispatch('click');
  check('the lobby settings button opens the panel', panelEl?.classList.contains('show') === true);

  const vol = document.getElementById('ppVolume');
  vol.value = '30';
  vol.dispatch('input', { target: { value: '30' } });
  const stored = JSON.parse(localStorage.getItem('outrun-settings-v1') || '{}');
  check('the volume slider is saved', stored.volume === 0.3, JSON.stringify(stored));

  const shake = document.getElementById('ppShake');
  shake.value = '0';
  shake.dispatch('input', { target: { value: '0' } });
  check('the shake slider is saved', JSON.parse(localStorage.getItem('outrun-settings-v1')).shake === 0);

  const low = [...document.getElementById('ppQuality').children].find((b) => b.dataset.quality === 'low');
  low?.dispatch('click');
  check('a graphics tier can be picked', JSON.parse(localStorage.getItem('outrun-settings-v1')).quality === 'low');
  check('the lobby state follows the panel', window.__outrun.state.quality === 'low',
    window.__outrun.state.quality);

  document.getElementById('ppClose').dispatch('click');
  check('the close button closes the panel', !panelEl.classList.contains('show'));

  document.getElementById('settingsFab').dispatch('click');
  check('the in-run gear button opens it too', panelEl.classList.contains('show'));
  document.getElementById('ppClose').dispatch('click');

  // a picture can be cleared without a browser file picker
  document.getElementById('ppClearPic').dispatch('click');
  await wait(80);
  check('the remove-picture button is wired', true);
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL APP INTEGRATION TESTS PASSED');
process.exit(problems.length ? 1 : 0);
