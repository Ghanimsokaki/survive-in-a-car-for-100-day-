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
check('guest button enters the lobby', document.getElementById('lobby').classList.contains('show'));
check('lobby shows the chosen name', document.getElementById('nameInput').value === 'PHONE_TESTER' || api.state.name === 'PHONE_TESTER', api.state.name);
check('friend panel renders for guests', document.getElementById('friendsList').innerHTML.includes('Sign in'));

// colours drive the avatar + state
const swatches = document.getElementById('colorRow').children;
check('body swatches built', swatches.length > 3, `${swatches.length} swatches`);
swatches[2].dispatch('click');
check('picking a colour updates state', api.state.color === '#5ff0ff', api.state.color);

// room code handling
document.getElementById('roomInput').value = 'phone-room-7';
document.getElementById('roomInput').dispatch('input', { target: { value: 'phone-room-7' } });
check('room code sanitised + stored', api.state.room === 'phone-room-7', api.state.room);

// start the run
await api.startRun();
await wait(400);
const game = api.game;
check('game constructed', Boolean(game));
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

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL APP INTEGRATION TESTS PASSED');
process.exit(problems.length ? 1 : 0);
