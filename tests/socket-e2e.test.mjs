/**
 * END-TO-END: the real `server.js`, a real HTTP port, real socket.io clients.
 *
 * This is the only suite that proves the multiplayer server actually works:
 * every other test either checks the lobby brain in isolation or the browser's
 * fallback lanes. Here we boot the process the way a host would (`node
 * server.js`), connect `socket.io-client` sockets over a WebSocket, and drive a
 * full session — create, join, relay telemetry, chat, rate limits, leave.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { SocketIoLane, joinPayload, createPayload, clientId } from '../public/js/sio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Resolves with the first payload of `event`, or rejects after `ms`.
 * socket.io appends its connection-recovery offset as a trailing argument, so
 * only the first one is the payload.
 */
function once(socket, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    function onEvent(...args) { clearTimeout(timer); socket.off(event, onEvent); resolve(args[0]); }
    socket.on(event, onEvent);
  });
}

/** Emits with the server's ack contract; rejects only on timeout. */
function ask(socket, event, payload = {}, ms = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), ms);
    socket.emit(event, payload, (res) => { clearTimeout(timer); resolve(res); });
  });
}

/** As `once`, but only resolves for a payload matching `where` (others pass by). */
function onceWhere(socket, event, where, ms = 12_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timeout waiting for ${event}`)); }, ms);
    function onEvent(payload) {
      if (!where(payload)) return;
      clearTimeout(timer); socket.off(event, onEvent); resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

/** Collects every `msg` the socket sees for the next `ms`. */
function inbox(socket, ms = 600) {
  const seen = [];
  const onMsg = (m) => seen.push(m);
  socket.on('msg', onMsg);
  return sleep(ms).then(() => { socket.off('msg', onMsg); return seen; });
}

// ------------------------------------------------------------------ boot ---
const PORT = 3200 + Math.floor(Math.random() * 400);
const URL = `http://127.0.0.1:${PORT}`;
const logs = [];

console.log(`\nbooting server.js on ${PORT}`);
const child = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '0.0.0.0',
    NODE_ENV: 'test',
    // the Render keep-alive, pointed at this very process and sped up
    RENDER_EXTERNAL_URL: `http://127.0.0.1:${PORT}`,
    KEEPALIVE_MS: '600',
    KEEPALIVE_PATH: '/health',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (d) => logs.push(String(d)));
child.stderr.on('data', (d) => logs.push(String(d)));
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

const startedAt = Date.now();
for (;;) {
  if (exited) break;
  try {
    const res = await fetch(`${URL}/health`);
    if (res.ok) break;
  } catch { /* not listening yet */ }
  if (Date.now() - startedAt > 15_000) break;
  await sleep(120);
}
check('the server starts', !exited, exited ? `exit ${exited.code}` : `${Date.now() - startedAt} ms`);
check('the boot banner names the bind address', logs.join('').includes('0.0.0.0'));

// -------------------------------------------------------------- the HTTP ---
console.log('\nhttp surface');
{
  const health = await (await fetch(`${URL}/health`)).json();
  check('health says it is the socket.io engine', health.engine === 'socket.io');
  check('…and the service is Gemby Games', health.service === 'gemby-games-realtime', health.service);
  check('health advertises the realtime path', health.realtime?.path === '/socket.io');
  check('health caps rooms at eight', health.maxPlayersPerRoom === 8);
  check('health reports CORS as open', health.cors.open === true && health.cors.mode === 'open',
    JSON.stringify(health.cors));
  check('health counts rooms', typeof health.rooms === 'number' && typeof health.players === 'number');

  const rooms = await fetch(`${URL}/api/rooms`);
  check('/api/rooms answers', rooms.ok && Array.isArray((await rooms.json()).rooms));

  const client = await fetch(`${URL}/socket.io/socket.io.js`);
  check('the browser client is served by the server itself', client.ok && (await client.text()).length > 1000);

  const page = await fetch(`${URL}/`);
  check('the game shell is served', page.ok && (await page.text()).includes('<html'));

  const allowed = await fetch(`${URL}/health`, { headers: { Origin: 'https://gemby-game.vercel.app' } });
  check('CORS echoes the front-end origin',
    allowed.headers.get('access-control-allow-origin') === 'https://gemby-game.vercel.app');
  check('CORS varies on origin', /origin/i.test(allowed.headers.get('vary') || ''));

  const anyone = await fetch(`${URL}/health`, { headers: { Origin: 'https://someone-else.example.com' } });
  check('…and any other front-end as well',
    anyone.headers.get('access-control-allow-origin') === 'https://someone-else.example.com');
  check('credentials are allowed through', anyone.headers.get('access-control-allow-credentials') === 'true');

  const preflight = await fetch(`${URL}/api/rooms`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://gemby-game.vercel.app', 'Access-Control-Request-Method': 'GET' },
  });
  check('a preflight is answered without a body', preflight.status === 204);

  const cfg = await (await fetch(`${URL}/api/config`)).json();
  check('/api/config answers the way Vercel does', cfg.mode === 'node-socket.io' && typeof cfg.configured === 'boolean');
  check('…and never ships a secret', !('serviceRole' in cfg) && !String(cfg.supabaseAnonKey || '').startsWith('sb_secret'));
  const cfgFile = await fetch(`${URL}/config.json`);
  check('/config.json is the same payload', cfgFile.ok && (await cfgFile.json()).mode === 'node-socket.io');

  const missing = await fetch(`${URL}/api/nope`);
  check('an unknown api route is a JSON 404', missing.status === 404);
}

// --------------------------------------------------------------- keep-alive ---
console.log('\nthe container keeps itself awake');
{
  const first = (await (await fetch(`${URL}/health`)).json()).keepalive;
  check('the keep-alive is on', first.enabled === true, JSON.stringify(first));
  check('…aimed at its own public URL', first.url === `${URL}/health`, first.url);
  check('…and reported in /health', typeof first.pings === 'number' && first.intervalMs === 600);

  await sleep(1500);
  const second = (await (await fetch(`${URL}/health`)).json()).keepalive;
  check('…pinging on a timer', second.pings > first.pings, `${first.pings} → ${second.pings}`);
  check('…successfully', second.lastStatus === 200 && second.failures === 0,
    `${second.lastStatus}/${second.failures}`);
  check('…without a single warning in the log', !logs.join('').includes('[keepalive] ping') ||
    !logs.join('').includes('failed'));
}

// ------------------------------------------------------- handshake origins ---
console.log('\nthe handshake lets any front-end in');
{
  // polling is a plain HTTP request, so CORS really applies on this path
  const origins = ['https://gemby-game.vercel.app', 'https://8000-abc123.e2b.app', 'https://some-other-game.example.com'];
  for (const origin of origins) {
    const socket = io(URL, {
      transports: ['polling'],
      reconnection: false,
      timeout: 6000,
      extraHeaders: { Origin: origin },
    });
    let connected = true;
    try { await once(socket, 'connect', 6000); } catch { connected = false; }
    check(`the socket accepts ${origin}`, connected);
    socket.close();
  }
}

// --------------------------------------------------------------- sockets ---
const sockets = [];
function connect(origin) {
  const socket = io(URL, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 6000,
    extraHeaders: origin ? { Origin: origin } : undefined,
  });
  sockets.push(socket);
  return socket;
}

const alice = connect();
let code = '';
{
  const joined = await once(alice, 'connect');
  check('a websocket client connects', Boolean(alice.id) || joined !== undefined, alice.id?.slice(0, 6));
}

console.log('\na room of one');
{
  const joinedEvent = once(alice, 'room:joined');
  const ack = await ask(alice, 'room:create', { name: 'Alice', mode: '100-days' });
  check('creating a room succeeds', ack.ok === true, JSON.stringify(ack).slice(0, 80));
  code = ack.code;
  check('the code is five characters', /^[A-Z2-9]{5}$/.test(code), code);
  check('the creator is seated', ack.room?.count === 1 && ack.you.id === alice.id);
  check('the room reports the eight-player cap', ack.room?.max === 8);
  check('names are normalised', ack.you.name === 'ALICE', ack.you.name);
  check('the room:joined event mirrors the ack', (await joinedEvent).code === code);
  check('an extra argument (recovery offset) never breaks the payload',
    typeof ack.room === 'object' && ack.room !== null);

  const sync = await ask(alice, 'room:sync', {});
  check('a sync returns the room', sync.ok === true && sync.room.code === code);
}

console.log('\njoining');
const bob = connect();
await once(bob, 'connect');
{
  let refused = await ask(bob, 'room:join', { code: 'ZZZZZ', name: 'Bob' });
  check('an unknown code is refused', refused.ok === false && refused.error.code === 'no_room', refused.error?.code);

  refused = await ask(bob, 'room:join', { code: '!!', name: 'Bob' });
  check('a malformed code is refused', refused.ok === false && refused.error.code === 'bad_code', refused.error?.code);

  const joinedEvent = once(alice, 'player:joined');
  const stateEvent = once(alice, 'room:state');
  const ack = await ask(bob, 'room:join', { code: code.toLowerCase(), name: 'Bob' });
  check('lower-case codes still work', ack.ok === true && ack.code === code);
  check('the joiner is not a reconnect', ack.reconnected === false);
  check('both players are in the snapshot', ack.room.count === 2, String(ack.room.count));

  const ev = await joinedEvent;
  check('the room is told who arrived', ev.id === bob.id && ev.name === 'BOB');
  const snap = await stateEvent;
  check('…and gets a fresh snapshot', snap.count === 2);
}

console.log('\nvehicle telemetry');
{
  const heard = inbox(alice, 700);
  for (let i = 0; i < 12; i += 1) {
    // a legal 15 Hz-ish stream
    await ask(bob, 'msg', { t: 'state', x: 10 + i, y: 1.5, z: -4, yaw: 0.5, kmh: 88, hp: 74, inCar: true, day: 3 });
    await sleep(70);
  }
  const msgs = (await heard).filter((m) => m.t === 'state');
  check('telemetry reaches the other player', msgs.length >= 8, `${msgs.length} of 12`);
  const last = msgs[msgs.length - 1];
  check('positions survive the hop', last && typeof last.x === 'number' && typeof last.kmh === 'number');
  check('the sender is stamped by the server', last.id === bob.id && last.name === 'BOB');
  check('nobody relays to themselves', msgs.every((m) => m.id !== alice.id));

  // 40 updates as fast as possible: the burst is throttled, never fatal
  let throttled = 0;
  for (let i = 0; i < 40; i += 1) {
    const ack = await ask(bob, 'msg', { t: 'state', x: i });
    if (ack.throttled) throttled += 1;
  }
  check('a telemetry flood is throttled, not fatal', throttled > 5 && bob.connected, `${throttled} dropped`);
}

console.log('\nchat');
{
  const heard = once(alice, 'msg');
  const ack = await ask(bob, 'msg', { t: 'chat', text: '  meet you at the   ridge ' });
  check('a chat message is accepted', ack.ok === true);
  const m = await heard;
  check('it arrives trimmed and collapsed', m.t === 'chat' && m.text === 'meet you at the ridge', m.text);
  check('it is attributed to the sender', m.id === bob.id && m.name === 'BOB');

  const empty = await ask(bob, 'msg', { t: 'chat', text: '   ' });
  check('empty chat is refused', empty.ok === false && empty.error.code === 'empty_message');

  const bogus = await ask(bob, 'msg', { t: 'not-a-thing' });
  check('an unknown message type is refused', bogus.ok === false && bogus.error.code === 'bad_msg');

  const junk = await ask(bob, 'msg', 'nonsense');
  check('a non-object message is refused', junk.ok === false && junk.error.code === 'bad_msg');

  await sleep(150);                       // let the 15 Hz budget refill
  const spoof = once(alice, 'msg');
  await ask(bob, 'msg', { t: 'state', id: 'somebody-else', name: 'GHANIMZ', x: 1 });
  const forged = await spoof;
  check('a client cannot impersonate another player', forged.id === bob.id && forged.name === 'BOB',
    `${forged.id}/${forged.name}`);
}

console.log('\noutsiders');
{
  const carol = connect();
  await once(carol, 'connect');
  const ack = await ask(carol, 'msg', { t: 'state', x: 1 });
  check('telemetry before joining is refused', ack.ok === false && ack.error.code === 'not_in_room', ack.error?.code);
  const sync = await ask(carol, 'room:sync', {});
  check('syncing before joining is refused', sync.ok === false && sync.error.code === 'not_in_room');

  const quick = await ask(carol, 'room:quick', { name: 'Carol' });
  check('quick play seats an outsider', quick.ok === true);
  check('matchmaking drops them into the room with space', quick.room.code === code, quick.room.code);
  check('…as the third player', quick.room.count === 3, String(quick.room.count));
  await ask(carol, 'room:leave', {});
  carol.close();
}

console.log('\nthe browser lane (public/js/sio.js)');
{
  check('join payloads are upper-case and short', (() => {
    const p = joinPayload('highway-01', 'Ann', 'cid-123');
    return p.code === 'HIGHWAY-01' && p.name === 'Ann' && p.clientId === 'cid-123';
  })(), JSON.stringify(joinPayload('highway-01', 'Ann', 'cid-123')));
  check('create payloads carry a mode', createPayload('ab12', 'Ann', 'siege', 'x').mode === 'siege');
  check('a browser id exists even without storage', /^[A-Za-z0-9_-]{8,}$/.test(clientId()));

  const messages = [];
  const statuses = [];
  const peers = [];
  const lane = new SocketIoLane({
    base: URL,
    code,
    name: 'Lane',
    mode: '100-days',
    ioImpl: io,                                   // the real client, no browser needed
    onMessage: (m) => messages.push(m),
    onStatus: (state) => statuses.push(state),
    onPeer: (p) => peers.push(p),
  });
  const connected = await lane.connect();
  check('the lane connects and joins', connected === true && lane.joined, statuses.join('→'));
  check('it reports the room it landed in', lane.roomCode === code, lane.roomCode);
  check('it names the lane in its own status', statuses.includes('online'));

  const seen = once(alice, 'msg');
  check('the lane can send an envelope', lane.send({ t: 'chat', text: 'from the lane' }) === true);
  const relayed = await seen;
  check('…which arrives with the right author', relayed.t === 'chat' && relayed.name === 'LANE', relayed.name);

  const back = once(lane.socket, 'msg');
  await ask(alice, 'msg', { t: 'chat', text: 'reply' });
  const received = await back;
  check('…and messages come back the other way', received.text === 'reply');
  check('the lane hands them to the game unchanged', messages.some((m) => m.text === 'reply'));

  const count = (await ask(alice, 'room:sync', {})).room.count;
  check('the lane holds a seat like any player', count >= 3, String(count));
  await ask(lane.socket, 'room:leave', {});
  lane.close();
  await sleep(250);
  check('leaving frees the seat immediately',
    (await ask(alice, 'room:sync', {})).room.count === count - 1);
}

console.log('\na dropped player comes back');
{
  const phoneId = 'test-phone-dave';
  const dave = io(URL, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 150,
    reconnectionAttempts: 5,
    timeout: 6000,
  });
  sockets.push(dave);
  await once(dave, 'connect');
  const firstJoin = once(dave, 'room:joined');
  const seated = await ask(dave, 'room:join', { code, name: 'Dave', clientId: phoneId });
  check('a third player joins', seated.ok === true && seated.room.count === 3, String(seated.room?.count));
  await firstJoin;                        // let the phone process a packet first
  const sid = dave.id;

  // a phone that locks its screen: the transport dies, the session must not
  const back = once(dave, 'connect', 8000);
  dave.io.engine.close();
  await back;
  const rejoined = await ask(dave, 'room:join', { code, name: 'Dave', clientId: phoneId });
  check('the session is recovered, not recreated', dave.id === sid, `${sid?.slice(0, 5)} → ${dave.id?.slice(0, 5)}`);
  check('the seat was never given away', rejoined.reconnected === true && rejoined.room.count === 3,
    `${rejoined.reconnected}/${rejoined.room?.count}`);
  const stillThere = await ask(alice, 'room:sync', {});
  check('and the room never noticed', stillThere.room.players.some((p) => p.id === sid));

  // …and when recovery is impossible (a full reload), the new socket takes the
  // old seat over instead of leaving a ghost car standing in the road
  const ghostLeft = once(alice, 'player:left', 5000);
  dave.close();
  await sleep(200);
  const back2 = connect();
  await once(back2, 'connect');
  const reclaimed = await ask(back2, 'room:join', { code, name: 'Dave', clientId: phoneId });
  const evicted = await ghostLeft;
  check('a dead seat is reclaimed by the same browser',
    reclaimed.ok === true && reclaimed.room.count === 3, String(reclaimed.room?.count));
  check('…and the room is told the ghost left', evicted.id === sid && evicted.reason === 'reconnected', evicted.reason);
  const noDuplicates = (await ask(alice, 'room:sync', {})).room.players.filter((p) => p.name === 'DAVE');
  check('…so only one Dave is ever in the room', noDuplicates.length === 1, String(noDuplicates.length));

  await ask(back2, 'room:leave', {});
  back2.close();
  await sleep(200);
}

console.log('\nthe eight-player cap');
{
  const crowd = [];
  for (let i = 0; i < 6; i += 1) {
    const s = connect();
    await once(s, 'connect');
    crowd.push(s);
  }
  for (const [i, s] of crowd.entries()) {
    const ack = await ask(s, 'room:join', { code, name: `Crowd ${i}` });
    check(`player ${i + 3} of 8 fits`, ack.ok === true, ack.error?.code);
  }

  const ninth = connect();
  await once(ninth, 'connect');
  const ack = await ask(ninth, 'room:join', { code, name: 'Nine' });
  check('the ninth player is refused', ack.ok === false && ack.error.code === 'room_full', ack.error?.code);
  ninth.close();
  for (const s of crowd) {
    await ask(s, 'room:leave', {});
    s.close();
  }
  await sleep(250);
}

console.log('\nlobby hygiene');
{
  const rooms = await (await fetch(`${URL}/api/rooms`)).json();
  const mine = rooms.rooms.find((r) => r.code === code);
  check('/api/rooms lists the public room', Boolean(mine), JSON.stringify(rooms.rooms).slice(0, 120));
  check('…without leaking player ids', mine && !('players' in mine && typeof mine.players !== 'number'));

  // A dropped socket keeps its seat for the grace window…
  const before = (await ask(alice, 'room:sync', {})).room.count;
  const bobId = bob.id;            // socket.io clears `id` when the socket closes
  const heard = onceWhere(alice, 'player:left', (p) => p.id === bobId);
  bob.close();
  await sleep(400);
  const held = await ask(alice, 'room:sync', {});
  check('a dropped player still holds their seat', held.room.count === before, `${held.room?.count} of ${before}`);
  const left = await heard;
  check('a dropped player is released once the grace window ends', left.id === bobId);
  check('…as a timeout, not an exit', left.reason === 'timed_out', left.reason);
  const after = await ask(alice, 'room:sync', {});
  check('…and the room shrinks by one', after.room.count === before - 1, `${after.room?.count} of ${before - 1}`);

  const bye = await ask(alice, 'room:leave', {});
  check('leaving the room works', bye.ok === true && bye.left === true);
  const rooms2 = await (await fetch(`${URL}/api/rooms`)).json();
  check('the empty room is gone', !rooms2.rooms.some((r) => r.code === code));
}

// ------------------------------------------------------------- shut down ---
console.log('\nshutdown');
{
  for (const s of sockets) s.close();
  await sleep(150);
  const before = Date.now();
  child.kill('SIGTERM');
  while (!exited && Date.now() - before < 6000) await sleep(80);
  check('SIGTERM stops the process', Boolean(exited), exited ? `code ${exited.code}` : 'still running');
  check('…cleanly', !exited || exited.code === 0, String(exited?.code));
  check('…and says goodbye', logs.join('').includes('shutdown'));
}

if (exited === null) { child.kill('SIGKILL'); }

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL SOCKET.IO TESTS PASSED');
process.exit(problems.length ? 1 : 0);
