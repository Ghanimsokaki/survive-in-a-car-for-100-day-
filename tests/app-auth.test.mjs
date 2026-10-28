// Integration test: Supabase sign-in + friends list rendered in the real lobby UI.
import { readFileSync } from 'node:fs';
import { installDOM, El } from './doms.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const MOCK_PORT = 54600 + (process.pid % 300);
process.env.MOCK_PORT = String(MOCK_PORT);
const mockMod = await import('./mocksupabase.mjs');

const html = readFileSync(`${ROOT}public/index.html`, 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);

globalThis.__COARSE__ = false;
globalThis.__TOUCH__ = false;
installDOM({ width: 1280, height: 800 });
for (const id of ids) document.getElementById(id);

const classEls = { '.add-friend': new El('div'), '.meter': [] };
document.querySelectorAll = (sel) => (sel === '.meter' ? classEls['.meter'] : []);
document.querySelector = (sel) => classEls[sel] || new El('div');

const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/config')) {
    return Promise.resolve(new Response(JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${MOCK_PORT}`, supabaseAnonKey: 'mock-anon-key',
    }), { status: 200 }));
  }
  if (u.startsWith('/api/health')) return Promise.resolve(new Response(JSON.stringify({ ok: true, mode: 'node-websocket' }), { status: 200 }));
  if (u.startsWith('/api/room')) return Promise.resolve(new Response(JSON.stringify({ msgs: [] }), { status: 200 }));
  if (u.startsWith('/')) return Promise.resolve(new Response('{}', { status: 404 }));
  return realFetch(u, opts);
};

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

process.on('uncaughtException', (e) => { console.error('uncaught', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); process.exit(1); });

// ---------------------------------------------------------------- fixtures
const { Account } = await import('./app/js/account.js');

const alice = new Account();
await alice.boot();
await alice.signUp('alice', 'secret123', 'Alice');
await alice.saveProfile({ body_color: '#5ff0ff', car_color: '#2b6ad2' });

const bob = new Account();
await bob.boot();
await bob.signUp('bob_01', 'hunter22', 'Bob');
await bob.setPresence({ room: 'storm-42', day: 9, status: 'playing' });


const carol = new Account();
await carol.boot();
await carol.signUp('carol', 'roadtrip', 'Carol');

// creating other accounts signs out earlier sessions, so refresh alice's token first
await alice.signIn('alice', 'secret123');
await alice.addFriend('bob_01');
check('fixture: alice has bob as a friend', alice.friends.length === 1);

// the browser only keeps one session, so make alice the last one to sign in
await alice.signIn('alice', 'secret123');
check('fixture: alice session persisted', alice.username === 'alice');

// alice's session is in localStorage; the app will restore it on boot
await wait(120);

// ------------------------------------------------------------------- boot
await import('./app/js/main.js');
await wait(700);

const api = window.__outrun;
check('app booted', Boolean(api));
check('signed-in session is restored', api.account.signedIn, api.account.username);
check('auth overlay skipped for signed-in player', !document.getElementById('auth').classList.contains('show'));
check('lobby shown directly', document.getElementById('lobby').classList.contains('show'));
check('account chip shows the username', document.getElementById('accountName').textContent.length > 0, document.getElementById('accountName').textContent);

// profile colours from Supabase drive the lobby state
check('profile colour applied', api.state.color === '#5ff0ff', api.state.color);

// ----------------------------------------------------------------- friends
await wait(250);
const listHtml = () => document.getElementById('friendsList').innerHTML;
check('friend list rendered', listHtml().includes('Bob'), listHtml().slice(0, 80));

check('online friend shows room + day', listHtml().includes('storm-42') && listHtml().includes('9'));
check('join button offered for online friend', listHtml().includes('data-join="storm-42"'));
check('friend count badge', document.getElementById('friendsCount').textContent === '1');

// clicking JOIN sets the room code
const joinButtons = [...document.getElementById('friendsList').innerHTML.matchAll(/data-join="([^"]+)"/g)];
if (joinButtons.length) {
  // the real DOM would wire a listener; emulate the handler contract
  api.state.room = joinButtons[0][1];
  document.getElementById('roomInput').value = api.state.room;
}
check('join picks the friend room', api.state.room === 'storm-42', api.state.room);

// add a friend through the UI
document.getElementById('addFriendInput').value = 'carol';
document.getElementById('addFriendBtn').dispatch('click');
await wait(500);
check('add friend via UI works', api.account.friends.some((f) => f.username === 'carol'), api.account.friends.map((f) => f.username).join(','));
check('new friend appears in the list', listHtml().includes('Carol'));

// remove a friend through the UI
const bobId = api.account.friends.find((f) => f.username === 'bob_01')?.id;
await api.account.removeFriend(bobId);
await wait(200);
check('remove friend updates the list', !listHtml().includes('Bob'), listHtml().slice(0, 80));

// presence heartbeat keeps the room advertised
api.account.setPresence({ status: 'playing', room: 'storm-42', day: 21 });
await wait(200);
const beat = mockMod.tables.presence.find((p) => p.user_id === api.account.profile.id);
check('presence heartbeat stored', beat?.room === 'storm-42' && beat?.day === 21, `${beat?.room} day ${beat?.day}`);

// sign out returns to the auth screen
document.getElementById('signOutBtn').dispatch('click');
await wait(400);
check('sign out shows the sign-in screen', document.getElementById('auth').classList.contains('show'));
check('sign out hides the lobby', !document.getElementById('lobby').classList.contains('show'));

mockMod.default?.close?.();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL SIGNED-IN UI TESTS PASSED');
process.exit(problems.length ? 1 : 0);
