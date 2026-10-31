// Supabase as the main server: the client joins the realtime edge directly and
// only ever falls back to our own relay. Covers the protocol frames, the lane
// choice, the fallbacks, the reconnect policy and the config plumbing.
import { readFileSync } from 'node:fs';
import { installDOM } from './doms.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
globalThis.__COARSE__ = false;
globalThis.__TOUCH__ = false;
installDOM({ width: 1280, height: 800 });
globalThis.location = { search: '', protocol: 'https:', host: 'example.test', reload() {} };

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const rt = await import('./app/js/realtime.js');
const { Net } = await import('./app/js/net.js');

/** A websocket stand-in that records what the client said. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.readyState = 0;
    FakeSocket.last = this;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.onclose?.({}); }
  open() { this.readyState = 1; this.onopen?.({}); }
  deliver(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  frames(event) { return this.sent.filter((f) => f.event === event); }
}

// ------------------------------------------------------------- the protocol
console.log('realtime protocol');
{
  const url = rt.realtimeSocketUrl('https://abcd.supabase.co/', 'anon-key');
  check('the socket url points at the realtime edge',
    url === 'wss://abcd.supabase.co/realtime/v1/websocket?apikey=anon-key&vsn=1.0.0', url);
  check('http projects upgrade to ws', rt.realtimeSocketUrl('http://127.0.0.1:54321', 'k')
    .startsWith('ws://127.0.0.1:54321/realtime/v1/websocket'));
  check('no url means no transport', rt.realtimeSocketUrl('', 'k') === '');

  check('the room becomes a channel topic', rt.roomTopic('Storm 42') === 'realtime:room:storm42',
    rt.roomTopic('Storm 42'));
  check('rooms are lowercased like the relay does it',
    rt.roomTopic('HIGHWAY-01') === 'realtime:room:highway-01', rt.roomTopic('HIGHWAY-01'));
  check('an empty room falls back to the default', rt.roomTopic('') === 'realtime:room:highway-01');

  const join = rt.joinFrame('realtime:room:abc', '7');
  check('the join frame is a phx_join', join.event === 'phx_join' && join.topic === 'realtime:room:abc' && join.ref === '7');
  check('broadcast echoes are turned off (half the traffic)',
    join.payload.config.broadcast.self === false, JSON.stringify(join.payload.config.broadcast));
  check('the join carries no postgres subscriptions', Array.isArray(join.payload.config.postgres_changes)
    && join.payload.config.postgres_changes.length === 0);

  const frame = rt.broadcastFrame('realtime:room:abc', 'room', { t: 'hello', id: 'x' }, '8');
  check('a broadcast frame is shaped the way the server expects',
    frame.event === 'broadcast' && frame.payload.type === 'broadcast'
    && frame.payload.event === 'room' && frame.payload.payload.t === 'hello');
  check('the heartbeat is a phoenix heartbeat', rt.heartbeatFrame('9').topic === 'phoenix'
    && rt.heartbeatFrame('9').event === 'heartbeat');

  check('a broadcast is unwrapped to its message',
    rt.messageFromFrame({ event: 'broadcast', payload: { payload: { t: 'state' } } })?.t === 'state');
  check('heartbeat replies are ignored', rt.messageFromFrame({ event: 'phx_reply', payload: {} }) === null);
  check('a malformed broadcast is ignored',
    rt.messageFromFrame({ event: 'broadcast', payload: { payload: 'nope' } }) === null);
  check('nothing at all is ignored', rt.messageFromFrame(null) === null);
}

// ------------------------------------------------------------- the transport
console.log('\nsupabase transport');
{
  const seen = [];
  const states = [];
  const client = new rt.SupabaseRealtime({
    url: 'https://abcd.supabase.co', key: 'anon-key', room: 'test-room',
    onMessage: (m) => seen.push(m), onStatus: (s, d) => states.push([s, d]),
    WebSocketImpl: FakeSocket,
  });
  check('the transport is available with a url + key + socket', client.available === true);
  check('it dials the project, not our server', client.socketUrl.includes('abcd.supabase.co')
    && !client.socketUrl.includes('example.test'));

  client.connect();
  const sock = FakeSocket.last;
  check('the socket is opened once', Boolean(sock));
  sock.open();
  const join = sock.frames('phx_join')[0];
  check('joining the room happens on open', join?.topic === 'realtime:room:test-room', join?.topic);
  check('the heartbeat starts immediately', Boolean(client.heartbeat));

  check('sending before the join is acked is refused', client.send({ t: 'hello' }) === false);
  sock.deliver({ event: 'phx_reply', payload: { status: 'ok' }, ref: join.ref });
  check('an ok reply marks the room joined', client.joined === true);
  check('the status names Supabase when it lands',
    states.some(([s, d]) => s === 'online' && /Supabase/i.test(d)), JSON.stringify(states.at(-1)));

  check('a message now goes out as a broadcast', client.send({ t: 'hello', id: 'me' }) === true);
  const sent = sock.frames('broadcast').at(-1);
  check('the broadcast names the room event', sent.payload.event === 'room');
  check('the payload survives intact', sent.payload.payload.t === 'hello', JSON.stringify(sent.payload.payload));

  sock.deliver({ event: 'broadcast', payload: { type: 'broadcast', event: 'room', payload: { t: 'state', id: 'peer' } } });
  check('an inbound broadcast reaches the game', seen.at(-1)?.id === 'peer');
  sock.deliver({ event: 'phx_reply', payload: { status: 'ok' } });
  check('replies do not leak into the game', seen.length === 1);

  // a refused join is loud and stops the client trusting the lane
  const bad = new rt.SupabaseRealtime({
    url: 'https://abcd.supabase.co', key: 'wrong', room: 'x',
    onMessage: () => {}, onStatus: (s, d) => states.push([s, d]), WebSocketImpl: FakeSocket,
  });
  bad.connect();
  FakeSocket.last.open();
  FakeSocket.last.deliver({ event: 'phx_reply', payload: { status: 'error', response: { reason: 'bad key' } } });
  check('a refused join is reported with its reason',
    states.some(([s, d]) => s === 'error' && /bad key/.test(d)), JSON.stringify(states.at(-1)));
  check('a refused night does not claim to be online', bad.joined === false);

  client.close();
  check('closing leaves the channel', sock.frames('phx_leave').length === 1
    || sock.sent.some((f) => f.event === 'phx_leave'), JSON.stringify(sock.sent.map((f) => f.event)));
  check('closing stops the heartbeat', client.heartbeat === null);
  check('a closed client does not send', client.send({ t: 'hello' }) === false);
}

// ---------------------------------------------------------------- the lanes
console.log('\nlane choice');
{
  const profile = { name: 'ME', color: 0xffb347, carColor: 0xd24a2b };
  const calls = [];
  const net = new Net({
    room: 'lane-test', profile,
    supabase: { url: 'https://abcd.supabase.co', key: 'anon-key' },
    onStatus: (m, t) => calls.push([m, t]),
    onPeer: () => {}, WebSocketImpl: FakeSocket,
  });
  // Net builds its own SupabaseRealtime with the global WebSocket; give it one
  globalThis.WebSocket = FakeSocket;
  net.start();
  check('with credentials the Supabase lane is used', Boolean(net.rt), net.lane);
  check('the relay socket is never dialled', net.ws === null);
  const sock = FakeSocket.last;
  sock.open();
  sock.deliver({ event: 'phx_reply', payload: { status: 'ok' } });
  check('the lane is reported as supabase', net.lane === 'supabase', net.lane);
  check('the room was advertised on join', sock.frames('broadcast').some((f) => f.payload.payload.t === 'hello'));

  // messages from other players arrive through the same pipeline
  const peers = [];
  net.onPeer = (p) => peers.push(p);
  sock.deliver({
    event: 'broadcast',
    payload: { type: 'broadcast', event: 'room', payload: { t: 'hello', id: 'other', name: 'PAL', color: 0x123456 } },
  });
  check('a peer from Supabase is merged like any other lane', peers.length === 1 && peers[0].name === 'PAL');
  net.close();

  // no credentials: the node relay is still there
  const plain = new Net({ room: 'lane-test', profile, onStatus: () => {} });
  check('without credentials there is no realtime lane', plain.connectSupabase() === false);
  plain.close();

  // a refused project must bring the relay up beside it
  const fallback = new Net({ room: 'lane-test', profile, supabase: { url: 'https://abcd.supabase.co', key: 'k' }, onStatus: () => {} });
  globalThis.WebSocket = FakeSocket;
  fallback.start();
  const s2 = FakeSocket.last;
  s2.open();
  s2.deliver({ event: 'phx_reply', payload: { status: 'error', response: { reason: 'paused' } } });
  check('a refused project starts the relay', fallback.relayTried === true && fallback.degraded === true);
  fallback.close();
}

// ------------------------------------------------------- the wiring in the app
console.log('\nwiring');
{
  const main = readFileSync(`${ROOT}public/js/main.js`, 'utf8');
  const game = readFileSync(`${ROOT}public/js/game.js`, 'utf8');
  const netSrc = readFileSync(`${ROOT}public/js/net.js`, 'utf8');
  const hud = readFileSync(`${ROOT}public/js/hud.js`, 'utf8');

  check('the game is handed the Supabase project', /supabase: account\.sb\?\.url/.test(main));
  check('the game passes it to the transport', /supabase,\n/.test(game) || /supabase: supabase/.test(game) || /^\s+supabase,$/m.test(game));
  check('the transport prefers realtime', netSrc.indexOf('connectSupabase()') < netSrc.indexOf('connectWS();'));
  check('the relay is only a fallback', /fallBackToRelay/.test(netSrc));
  check('the run HUD shows the lane', /hud\?\.net\?\.\(label/.test(game) && /net\(label/.test(hud));
  check('the status line names the lane', /SUPABASE/.test(game) && /HTTP RELAY/.test(game));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL SUPABASE-FIRST TRANSPORT TESTS PASSED');
process.exit(problems.length ? 1 : 0);
