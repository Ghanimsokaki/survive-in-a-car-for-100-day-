// The room/matchmaking rules, with no server and no dependencies to install.
import {
  Lobby, LobbyError, MAX_PLAYERS, MIN_PLAYERS, CODE_ALPHABET, CODE_LENGTH,
  normaliseCode, makeCode, sanitiseName, sanitiseState, sanitiseChat,
  STATE_HZ, CHAT_PER_WINDOW, STALE_MS,
} from '../lib/lobby.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

/** A deterministic clock so rate limits and pruning are testable. */
function fixedClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

// ------------------------------------------------------------------- codes
console.log('\nmatchmaking codes');
{
  check('a room is 1–8 players', MIN_PLAYERS === 1 && MAX_PLAYERS === 8);
  check('generated codes are five characters', makeCode(() => 0.42).length === CODE_LENGTH);
  check('codes avoid O/0/I/1', ![...CODE_ALPHABET].some((c) => 'O0I1'.includes(c)), CODE_ALPHABET);
  const seen = new Set();
  for (let i = 0; i < 400; i += 1) seen.add(makeCode());
  check('codes are not predictable in practice', seen.size > 300, `${seen.size} distinct of 400`);

  check('lowercase is accepted', normaliseCode('hn7k2') === 'HN7K2');
  check('separators are ignored', normaliseCode('hn 7-k2') === 'HN7K2');
  check('a misread O becomes Q', normaliseCode('QO7K2') === 'QQ7K2', normaliseCode('QO7K2'));
  check('a misread 1 becomes L', normaliseCode('q17k2') === 'QL7K2', normaliseCode('q17k2'));
  check('a misread 0 becomes Q', normaliseCode('q0zk2') === 'QQZK2', normaliseCode('q0zk2'));
  check('the game’s own room names survive', normaliseCode('highway-01') === 'HIGHWAY01',
    normaliseCode('highway-01'));
  check('too short is refused', normaliseCode('ab') === '');
  check('too long is refused', normaliseCode('X'.repeat(20)) === '');
  check('nothing is refused', normaliseCode('') === '');
  check('emoji are refused', normaliseCode('🚗🚗') === '');
}

// ------------------------------------------------------------------- rooms
console.log('\nrooms');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  const created = lobby.create({ id: 'sock-1', name: 'Alice' });
  check('creating seats the player', created.room.players.size === 1 && created.room.code.length === 5);
  check('the creator hosts', created.room.host === 'sock-1');
  check('names are normalised', created.player.name === 'ALICE', created.player.name);
  check('stats count it', lobby.stats().rooms === 1 && lobby.stats().players === 1);

  const joined = lobby.join({ id: 'sock-2', name: 'bob', code: created.room.code.toLowerCase() });
  check('a second player joins by code', joined.room.code === created.room.code && joined.room.players.size === 2);
  check('the joiner is not a reconnect', joined.reconnected === false);

  const again = lobby.join({ id: 'sock-2', name: 'bob', code: created.room.code });
  check('re-joining the same room is harmless', again.reconnected === true && again.room.players.size === 2);

  let err = null;
  try { lobby.join({ id: 'sock-3', name: 'c', code: 'ZZZZZ' }); } catch (e) { err = e; }
  check('an unknown code says so', err instanceof LobbyError && err.code === 'no_room', err?.code);

  err = null;
  try { lobby.join({ id: 'sock-3', name: 'c', code: 'x' }); } catch (e) { err = e; }
  check('a malformed code says so', err?.code === 'bad_code');

  // explicit codes: the first player claims the name
  const named = lobby.create({ id: 'sock-9', name: 'Nia', code: 'highway-01' });
  check('a custom code is honoured', named.room.code === 'HIGHWAY01', named.room.code);
  check('the same code is taken afterwards', (() => {
    try { lobby.create({ id: 'sock-10', name: 'x', code: 'HIGHWAY01' }); return false; } catch (e) { return e.code === 'code_taken'; }
  })());
  const same = lobby.join({ id: 'sock-10', name: 'Theo', code: 'highway-01' });
  check('and anybody with that code lands in it', same.room.code === 'HIGHWAY01' && same.room.players.size === 2);
}

// ---------------------------------------------------------------- the cap
console.log('\nthe party cap');
{
  const lobby = new Lobby();
  const { room } = lobby.create({ id: 'p0', name: 'host' });
  for (let i = 1; i < MAX_PLAYERS; i += 1) lobby.join({ id: `p${i}`, name: `P${i}`, code: room.code });
  check('eight players fit', room.players.size === MAX_PLAYERS, `${room.players.size}`);

  let err = null;
  try { lobby.join({ id: 'p9', name: 'nine', code: room.code }); } catch (e) { err = e; }
  check('the ninth is refused', err?.code === 'room_full', err?.code);
  check('…and the room is untouched', room.players.size === MAX_PLAYERS);

  const quick = lobby.quickMatch({ id: 'p9', name: 'nine' });
  check('quick play never lands in a full room', quick.room.code !== room.code, quick.room.code);
}

// ------------------------------------------------------------ matchmaking
console.log('\nquick match');
{
  const lobby = new Lobby();
  const first = lobby.quickMatch({ id: 'a', name: 'A' });
  check('the first player gets a fresh room', first.room.players.size === 1);
  const second = lobby.quickMatch({ id: 'b', name: 'B' });
  check('the second joins them', second.room.code === first.room.code && second.room.players.size === 2);

  // a fuller room wins over a sparser one
  const lonely = lobby.create({ id: 'c', name: 'C' });
  check('a third still prefers the fuller room',
    lobby.quickMatch({ id: 'd', name: 'D' }).room.code === first.room.code);
  check('…and leaves the lonely room alone', lonely.room.players.size === 1);

  const elsewhere = lobby.quickMatch({ id: 'e', name: 'E', mode: 'siege' });
  check('a different mode gets its own room', elsewhere.room.code !== first.room.code);

  const repeat = lobby.quickMatch({ id: 'a', name: 'A' });
  check('quick play is idempotent for one player', repeat.room.code === first.room.code && repeat.reconnected === true);
}

// --------------------------------------------------------------- leaving
console.log('\nleaving and hosts');
{
  const lobby = new Lobby();
  const { room } = lobby.create({ id: 'host', name: 'Host' });
  lobby.join({ id: 'two', name: 'Two', code: room.code });
  const gone = lobby.leave('host');
  check('leaving removes the player', room.players.size === 1);
  check('the room picks a new host', room.host === 'two', room.host);
  check('the room is not closed while somebody is in it', gone.closed === false);

  const last = lobby.leave('two');
  check('the last player closes the room', last.closed === true && lobby.rooms.size === 0);
  check('forgetting an unknown player is harmless', lobby.leave('nobody').closed === false);
  check('stats follow', lobby.stats().rooms === 0 && lobby.stats().players === 0);
}

// -------------------------------------------------------------- telemetry
console.log('\ntelemetry');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  const { room } = lobby.create({ id: 'a', name: 'A' });

  let err = null;
  try { lobby.state('ghost', { x: 1 }); } catch (e) { err = e; }
  check('telemetry from outside a room is refused', err?.code === 'not_in_room');

  const out = lobby.state('a', { x: 10, y: 2, z: -3, yaw: 1.5, speed: 20, kmh: 72, hp: 80, inCar: true, day: 4 });
  check('a normal update is accepted', out.ok === true);
  check('the state is kept on the player', out.player.state.x === 10 && out.player.state.kmh === 72);
  const keys = Object.keys(out.state).sort().join(',');
  check('only whitelisted fields survive', keys === [
    'car', 'day', 'hp', 'hpMax', 'inCar', 'kmh', 'speed', 'weapon', 'x', 'y', 'yaw', 'z',
  ].join(','), keys);
  check('so an unknown field never reaches a peer', !keys.includes('evil'));

  clock.tick(80);
  const polluted = lobby.state('a', JSON.parse('{"x":1,"__proto__":{"polluted":true},"constructor":{"x":1}}'));
  check('prototype keys cannot be smuggled', ({}).polluted === undefined && polluted.state.x === 1);

  clock.tick(80);
  const wild = lobby.state('a', { x: 1e12, hp: -500, kmh: 99999, weapon: 'w'.repeat(400), day: 0, hpMax: 0 });
  check('numbers are clamped into range', wild.state.x === 100_000 && wild.state.hp === 0 && wild.state.kmh === 400,
    `${wild.state.x}/${wild.state.hp}/${wild.state.kmh}`);
  check('zero is never a legal health cap', wild.state.day === 1 && wild.state.hpMax === 1,
    `${wild.state.day}/${wild.state.hpMax}`);
  check('strings are capped', wild.state.weapon.length === 16);
  clock.tick(80);
  check('a non-object payload does not throw', lobby.state('a', 'nonsense').state.x === 0);

  // rate limit: a burst is throttled, not fatal
  clock.tick(1000 / STATE_HZ);
  const ok1 = lobby.state('a', { x: 1 });
  clock.tick(1);
  const burst = lobby.state('a', { x: 2 });
  check('a burst inside the budget is dropped', burst.ok === false && burst.throttled === true);
  clock.tick(200);
  check('and the next honest update gets through', lobby.state('a', { x: 3 }).ok === true);
  check('the room is reported with the update', ok1.room.code === room.code);
}

// ------------------------------------------------------------------- chat
console.log('\nchat');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  lobby.create({ id: 'a', name: 'A' });
  const first = lobby.chat('a', '  hello   there  ');
  check('chat is trimmed and collapsed', first.ok && first.text === 'hello there', first.text);
  check('empty chat is refused', lobby.chat('a', '   ').ok === false);
  const long = lobby.chat('a', 'x'.repeat(400));
  check('chat is capped at 120', long.text.length === 120, String(long.text.length));
  const ctrl = lobby.chat('a', 'a\u0000b\u001fc');
  check('control characters are stripped', ctrl.text === 'a b c', JSON.stringify(ctrl.text));

  // the rate window
  let blocked = false;
  for (let i = 0; i < CHAT_PER_WINDOW * 3; i += 1) {
    const r = lobby.chat('a', `spam ${i}`);
    if (!r.ok) blocked = true;
  }
  check('flooding the chat is rate limited', blocked);
  clock.tick(11_000);
  check('and the window reopens', lobby.chat('a', 'ok now').ok === true);
  check('strangers cannot chat', (() => {
    try { lobby.chat('stranger', 'hi'); return false; } catch (e) { return e.code === 'not_in_room'; }
  })());
}

// ----------------------------------------------------------------- pruning
console.log('\npruning');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  const { room } = lobby.create({ id: 'quiet', name: 'Quiet' });
  lobby.join({ id: 'chatty', name: 'Chatty', code: room.code });

  clock.tick(STALE_MS - 500);
  lobby.touch('chatty');
  clock.tick(1000);
  const first = lobby.prune();
  check('the silent player is evicted', first.evicted.some((e) => e.id === 'quiet'), JSON.stringify(first.evicted));
  check('the talkative one survives', room.players.has('chatty'));
  check('the room survives with one player left', lobby.rooms.has(room.code));

  clock.tick(STALE_MS + 1000);
  const second = lobby.prune();
  check('when the last player goes quiet the room closes', second.evicted.some((e) => e.id === 'chatty'));
  check('…and it is forgotten', lobby.rooms.size === 0);
  check('a second prune is a no-op', lobby.prune().evicted.length === 0);
}

// ------------------------------------------------------------- snapshots
console.log('\nsnapshots');
{
  const lobby = new Lobby();
  const { room } = lobby.create({ id: 'a', name: 'A' });
  lobby.join({ id: 'b', name: 'B', code: room.code });
  lobby.state('b', { x: 5, z: 6 });
  const snap = lobby.snapshot(room.code);
  check('the snapshot lists everybody', snap.players.length === 2 && snap.count === 2);
  check('it carries the cap', snap.max === MAX_PLAYERS);
  check('it carries positions', snap.players.find((p) => p.id === 'b').state.x === 5);
  check('it names the host', snap.host === 'a');
  check('codes are normalised on the way in', lobby.snapshot(room.code.toLowerCase())?.code === room.code);
  check('an unknown room yields null', lobby.snapshot('ZZZZZ') === null);
}

// ------------------------------------------------------- dropped sockets
console.log('\na dropped phone keeps its seat');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  const { room } = lobby.create({ id: 'phone', name: 'Phone', clientId: 'browser-1' });
  check('a client id is remembered', room.players.get('phone').clientId === 'browser-1');
  check('client ids are sanitised', lobby.join({ id: 'x', name: 'X', code: room.code, clientId: 'a<script>b' }).player.clientId === 'ascriptb');

  const dropped = lobby.gone('phone');
  check('gone() keeps the player in the room', Boolean(dropped) && room.players.has('phone'));
  check('…and stamps the clock', dropped.goneAt === clock.now());

  clock.tick(STALE_MS - 500);
  check('a seat is held inside the grace window', lobby.prune().evicted.length === 0, 'still seated');

  // the socket came back (session recovery): touch() clears the stamp
  lobby.touch('phone');
  check('touch() clears the stamp', room.players.get('phone').goneAt === 0);
  clock.tick(STALE_MS * 2);
  check('a recovered player is not evicted afterwards',
    lobby.prune({ alive: () => true }).evicted.length === 0);

  lobby.gone('phone');
  clock.tick(STALE_MS + 100);
  const out = lobby.prune();
  check('an absent player is evicted after the window', out.evicted.some((e) => e.id === 'phone'));
  check('gone() on a stranger is harmless', lobby.gone('nobody') === null);
}

console.log('\nlive players are never pruned for being quiet');
{
  const clock = fixedClock();
  const lobby = new Lobby({ now: clock.now });
  lobby.create({ id: 'idle', name: 'Idle' });
  clock.tick(STALE_MS * 10);
  const kept = lobby.prune({ alive: () => true });
  check('a silent but connected player stays', kept.evicted.length === 0 && lobby.rooms.size === 1);

  const dropped = lobby.prune({ alive: () => false });
  check('a silent disconnected player goes', dropped.evicted.length === 1);
}

console.log('\nreclaiming a ghost seat');
{
  const lobby = new Lobby();
  const { room } = lobby.create({ id: 'new-socket', name: 'Dana', clientId: 'browser-9' });
  lobby.join({ id: 'other', name: 'Other', code: room.code, clientId: 'browser-2' });
  lobby.join({ id: 'no-id', name: 'Anon', code: room.code });

  const ghosts = lobby.ghosts(room.code, 'browser-9', 'a-third-socket');
  check('the same browser is found under its old socket', ghosts.length === 1 && ghosts[0].id === 'new-socket');
  check('each browser only matches its own seats',
    lobby.ghosts(room.code, 'browser-2', 'x').map((g) => g.id).join() === 'other');
  check('…so browser-9 does not sweep up browser-2',
    !lobby.ghosts(room.code, 'browser-9', 'x').some((g) => g.id === 'other'));
  check('a browser with no id matches nobody', lobby.ghosts(room.code, '', 'x').length === 0);
  check('the caller never matches itself', lobby.ghosts(room.code, 'browser-9', 'new-socket').length === 0);
  check('an unknown room has no ghosts', lobby.ghosts('ZZZZZ', 'browser-9').length === 0);
}

// ---------------------------------------------------------------- helpers
console.log('\nsanitising');
{
  check('an empty name becomes SURVIVOR', sanitiseName('') === 'SURVIVOR');
  check('names are capped at 16', sanitiseName('a'.repeat(40)).length === 16);
  check('names lose control characters', sanitiseName('A\u0000B') === 'AB');
  check('state defaults are sane', (() => {
    const s = sanitiseState(null);
    return s.x === 0 && s.hpMax === 100 && s.day === 1;
  })());
  check('chat survives being given a number', sanitiseChat(42) === '42');
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL LOBBY TESTS PASSED');
process.exit(problems.length ? 1 : 0);
