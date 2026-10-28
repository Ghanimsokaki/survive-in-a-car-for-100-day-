// Headless verification of the Supabase account + friends layer.
import { installDOM } from './doms.mjs';

const MOCK_PORT = 54000 + (process.pid % 900);
process.env.MOCK_PORT = String(MOCK_PORT);
const mockMod = await import('./mocksupabase.mjs');
const { tables } = mockMod;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(150);

installDOM();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => {
  const u = String(url);
  if (u.startsWith('/api/config')) {
    return Promise.resolve(new Response(JSON.stringify({
      supabaseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      supabaseAnonKey: 'mock-anon-key',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  if (u.startsWith('/api/health')) return Promise.resolve(new Response('{}', { status: 200 }));
  if (u.startsWith('/')) return Promise.resolve(new Response('{}', { status: 404 }));
  return realFetch(u, opts);
};

const { Account } = await import('../public/js/account.js');

const fails = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); fails.push(label); }
};

try {
  const a = new Account();
  await a.boot();
  check('boots with Supabase config', a.canUseAccounts, `source=${a.configSource}`);
  check('starts as guest with no session', a.mode === 'guest');

  console.log('\nsign-up / sign-in');
  await a.signUp('alice', 'secret123', 'Alice');
  check('alice signed up', a.signedIn && a.username === 'alice', a.username);
  check('profile has colours', Boolean(a.profile.body_color && a.profile.car_color));

  const b = new Account();
  await b.boot();
  await b.signUp('bob_01', 'hunter22', 'Bob');
  check('bob signed up', b.signedIn && b.username === 'bob_01');

  let dupErr = '';
  const c = new Account();
  await c.boot();
  try { await c.signUp('alice', 'another1', 'Alice2'); } catch (e) { dupErr = e.message; }
  check('duplicate username rejected', /already registered/i.test(dupErr), dupErr);

  let shortErr = '';
  const c2 = new Account();
  await c2.boot();
  try { await c2.signUp('shorty', 'abc', 'Short'); } catch (e) { shortErr = e.message; }
  check('short password rejected', /at least 6/i.test(shortErr), shortErr);

  let badErr = '';
  const c3 = new Account();
  await c3.boot();
  try { await c3.signIn('alice', 'wrongpass'); } catch (e) { badErr = e.message; }
  check('wrong password gives invalid login', /invalid/i.test(badErr), badErr);

  const relog = new Account();
  await relog.boot();
  await relog.signIn('alice', 'secret123');
  check('existing account can log back in', relog.signedIn && relog.username === 'alice');

  console.log('\nprofile persistence');
  // creating accounts signs out whatever session was active, so refresh first
  await a.signIn('alice', 'secret123');
  await a.saveProfile({ body_color: '#5ff0ff', car_color: '#2b6ad2', display_name: 'Alice Prime', best_day: 42 });
  const a2 = new Account();
  await a2.boot();
  await a2.signIn('alice', 'secret123');
  check('profile colours round-trip', a2.profile.body_color === '#5ff0ff' && a2.profile.car_color === '#2b6ad2');
  check('display name round-trips', a2.profile.display_name === 'Alice Prime');
  check('best day round-trips', a2.profile.best_day === 42, String(a2.profile.best_day));

  console.log('\nfriends');
  await b.signIn('bob_01', 'hunter22');
  await a.signIn('alice', 'secret123');
  await b.addFriend('alice');
  check('bob added alice', b.friends.length === 1, b.friends.map((f) => f.username).join(','));
  await a.refreshFriends();
  check('friendship is two-way', a.friends.some((f) => f.username === 'bob_01'), a.friends.map((f) => f.username).join(','));

  let selfErr = '';
  try { await b.addFriend('bob_01'); } catch (e) { selfErr = e.message; }
  check('cannot add self', /that is you/i.test(selfErr), selfErr);

  let ghostErr = '';
  try { await b.addFriend('nobody_here'); } catch (e) { ghostErr = e.message; }
  check('unknown username rejected', /no survivor/i.test(ghostErr), ghostErr);

  let againErr = '';
  try { await b.addFriend('alice'); } catch (e) { againErr = e.message; }
  check('duplicate friend rejected', /already on your friends/i.test(againErr), againErr);

  console.log('\npresence');
  a.setPresence({ room: 'storm-42', day: 17, status: 'playing' });
  await sleep(250);
  await b.refreshFriends();
  const aliceSeen = b.friends.find((f) => f.username === 'alice');
  check('friend shows online', aliceSeen?.online === true);
  check('friend room + day visible', aliceSeen?.room === 'storm-42' && aliceSeen?.day === 17, `${aliceSeen?.room} day ${aliceSeen?.day}`);

  const row = tables.presence.find((p) => p.user_id === aliceSeen.id);
  if (row) row.updated_at = new Date(Date.now() - 5 * 60_000).toISOString();
  await b.refreshFriends();
  check('stale presence reads offline', b.friends.find((f) => f.username === 'alice')?.online === false);

  console.log('\nremove friend');
  const aliceId = b.friends.find((f) => f.username === 'alice').id;
  await b.removeFriend(aliceId);
  check('bob list empty after removal', b.friends.length === 0);
  await a.refreshFriends();
  check('removal is two-way', a.friends.length === 0);

  console.log('\nsign out / guest mode');
  await b.signOut();
  check('sign out returns to guest', b.mode === 'guest' && !b.signedIn);
  check('guest keeps a usable profile', Boolean(b.profile?.username));

  console.log('\nunconfigured server');
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.startsWith('/api/config')) return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    return u.startsWith('/') ? Promise.resolve(new Response('{}', { status: 404 })) : realFetch(u, opts);
  };
  const g = new Account();
  await g.boot();
  check('guest mode when Supabase is absent', !g.canUseAccounts && g.mode === 'guest');
  g.useGuest('SOLO', { body: '#ff6b6b', car: '#3aa06a' });
  check('guest play works offline', g.profile.username === 'SOLO');
  globalThis.fetch = realFetch;
} catch (e) {
  console.error('\nTEST CRASH\n', e);
  fails.push('crash');
}

mockMod.default?.close?.();
console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL ACCOUNT TESTS PASSED');
process.exit(fails.length ? 1 : 0);
