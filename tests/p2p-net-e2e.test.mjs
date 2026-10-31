/**
 * P2P THROUGH `net.js` — the lane the player actually uses.
 *
 * `tests/p2p-e2e.test.mjs` proves the room. This file proves the **glue**: two
 * real `Net` instances, imported as shipped (no bundling, no stubs of our own
 * code), with a fake `RTCPeerConnection` injected — because Node has no WebRTC —
 * and the real Supabase realtime client talking to a real socket (the stand-in
 * edge in `tests/ws-edge.mjs`).
 *
 * It exists because the P2P lane was written blind: nothing had ever executed
 * `connectP2P`, and the guesses it was built on (`this.profile`, `this.lastState`,
 * `drop()`, `flushPending()`, `hello()`) are exactly the kind of thing that is
 * one typo away from a lane that silently never connects.
 *
 * What must hold:
 *   · both players end up on `lane === 'webrtc'`, one host and one guest;
 *   · signalling is the ONLY thing that crosses Supabase;
 *   · telemetry, chat and events go browser → browser over the data channel;
 *   · a guest cannot impersonate the host;
 *   · closing says goodbye, and the other side drops the peer;
 *   · when the signalling topic is unreachable the lane steps aside instead of
 *     throwing, and the HUD gets a lane to name.
 */
import { startEdge } from './ws-edge.mjs';
import { createNetwork } from './fake-rtc.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await sleep(15);
  }
  return false;
};

// ---------------------------------------------------------------- environment
// A browser-ish global surface, installed BEFORE the modules load: `canPeer()`
// reads `globalThis.RTCPeerConnection`, and the default peer factory does too.
const rtc = createNetwork({ connectDelay: 5 });
globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {} };
globalThis.RTCPeerConnection = rtc.RTCPeerConnection;
// Two Nets in one process would otherwise also meet over BroadcastChannel, which
// would hide a broken data channel behind a working one.
globalThis.BroadcastChannel = undefined;

const { Net } = await import('../public/js/net.js');

const edge = await startEdge();
console.log(`\nsignalling edge on ${edge.url}`);
const supabase = { url: edge.url, key: 'anon-key' };

// ------------------------------------------------------------------ two players
console.log('\ntwo players meet on the peer lane');
const aPeer = []; const bPeer = []; const aChat = []; const bChat = []; const aEvents = [];
const aStatus = []; const bStatus = [];

aPeer.length; // (kept explicit for readability below)

const a = new Net({
  room: 'peer-room',
  profile: { name: 'ALICE', color: 0xffb347, carColor: 0xd24a2b },
  supabase,
  onPeer: (p) => aPeer.push(p),
  onChat: (c) => aChat.push(c),
  onEvent: (e) => aEvents.push(e),
  onStatus: (m, t) => aStatus.push([m, t]),
});
a.start();
await sleep(120);

const b = new Net({
  room: 'peer-room',
  profile: { name: 'BOB', color: 0x5ff0ff, carColor: 0x2b6ad2 },
  supabase,
  onPeer: (p) => bPeer.push(p),
  onChat: (c) => bChat.push(c),
  onStatus: (m, t) => bStatus.push([m, t]),
});
b.start();

{
  const connected = await waitFor(() => a.p2pRole === 'host' && b.p2pRole === 'guest' && b.p2p?.snapshot().peers.some((p) => p.opened));
  check('both clients take the peer lane', connected && a.lane === 'webrtc' && b.lane === 'webrtc',
    `${a.lane}/${a.p2pRole} · ${b.lane}/${b.p2pRole}`);
  check('the first player is the host', a.p2pRole === 'host', a.p2pRole);
  check('the joiner is a guest', b.p2pRole === 'guest', b.p2pRole);
  check('the guest knows the host id', b.p2p.hostId === a.id);

  const helloSeen = await waitFor(() => aPeer.length > 0 && bPeer.length > 0);
  check('each side is told who the other is', helloSeen,
    `a: ${aPeer.map((p) => p.name).join(',')} · b: ${bPeer.map((p) => p.name).join(',')}`);
  check('the host sees BOB', aPeer.some((p) => p.name === 'BOB'));
  check('the guest sees ALICE', bPeer.some((p) => p.name === 'ALICE'));
  check('the peer count is one each way', a.peers.size === 1 && b.peers.size === 1,
    `${a.peers.size}/${b.peers.size}`);
  check('nobody is told about themselves', !aPeer.some((p) => p.name === 'ALICE'));

  // The one thing the signalling topic must have carried.
  const signalKinds = new Set(edge.seen
    .filter((f) => f.event === 'broadcast' && String(f.topic).includes('p2p-peer-room'))
    .map((f) => f.payload?.payload?.kind));
  check('signalling used its own topic', String([...edge.rooms.keys()].join()).includes('p2p-peer-room'),
    [...edge.rooms.keys()].join(' '));
  check('…and carried the handshake', signalKinds.has('join') && signalKinds.has('offer') && signalKinds.has('answer'),
    [...signalKinds].join(','));
  check('…including ICE candidates', signalKinds.has('ice'));
  check('…and nothing else', [...signalKinds].every((k) => ['hello', 'join', 'offer', 'answer', 'ice', 'leave'].includes(k)),
    [...signalKinds].join(','));
}

// -------------------------------------------------------------------- gameplay
console.log('\ngameplay is browser to browser');
{
  const dataTopic = edge.seen.filter((f) => f.event === 'broadcast' && String(f.topic).includes('peer-room')
    && !String(f.topic).includes('p2p-'));
  const before = dataTopic.length;

  b.pushState({ x: 12, y: 0, z: -4, yaw: 1.2, kmh: 104, hp: 88, day: 6 }, Date.now());
  const arrived = await waitFor(() => aPeer.some((p) => p.kmh === 104));
  check('driving telemetry crosses to the host', arrived,
    aPeer.filter((p) => p.kmh).map((p) => p.kmh).join(',') || 'none');
  check('…with the real author stamped on it', aPeer.some((p) => p.kmh === 104 && p.id === b.id));

  const fromHost = await waitFor(() => {
    a.pushState({ x: 40, y: 0, z: 9, yaw: 0, kmh: 71, hp: 100, day: 6 }, Date.now());
    return bPeer.some((p) => p.kmh === 71);
  }, 2000);
  check('host telemetry crosses to the guest', fromHost);
  check('the hop is the data channel, not Supabase', edge.seen.filter((f) => f.event === 'broadcast'
    && String(f.topic).includes('peer-room') && !String(f.topic).includes('p2p-')).length === before,
  `${edge.seen.length} edge frames total`);

  b.events = [];
  b.chat('hello from bob');
  const chatArrived = await waitFor(() => aChat.some((c) => c.text === 'hello from bob' && !c.sys));
  check('chat crosses', chatArrived, aChat.map((c) => c.text).join(' | '));
  check('…attributed to the sender', aChat.some((c) => c.text === 'hello from bob' && c.name === 'BOB'));

  b.event('hit', { dmg: 12, from: 'ALICE' });
  const hitArrived = await waitFor(() => aEvents.some((e) => e.kind === 'hit'));
  check('hits and world events cross', hitArrived);

  // a guest that lies about who it is
  const liar = b.p2p.peers.get(a.id);
  liar.control.send(JSON.stringify({ t: 'chat', id: a.id, name: 'ALICE', text: 'I am the host' }));
  const stamped = await waitFor(() => aChat.some((c) => c.text === 'I am the host'));
  const forged = aChat.find((c) => c.text === 'I am the host');
  check('a forged author is rewritten by the host', stamped && forged.id === b.id && forged.name === 'BOB',
    forged ? `${forged.id}/${forged.name}` : 'none');

  const junk = liar.control;
  junk.send('not json at all');
  junk.send(JSON.stringify({ t: 'nuke', id: b.id }));
  await sleep(80);
  check('junk is counted, not thrown', a.p2p.stats.dropped >= 2, `${a.p2p.stats.dropped} dropped`);
  check('the room is still up afterwards', a.peers.size === 1 && b.peers.size === 1);
}

// ---------------------------------------------------------------------- leaving
console.log('\nleaving');
{
  const left = waitFor(() => a.peers.size === 0, 3000);
  b.close();
  check('a closing guest says goodbye', await left, `${a.peers.size} peers left`);
  check('…and the host is told in chat', aChat.some((c) => c.sys && /left the highway/.test(c.text)),
    aChat.filter((c) => c.sys).map((c) => c.text).join(' | '));
  a.close();
}

// -------------------------------------------------------------- the host quits
console.log('\nwhen the host quits, the guest keeps playing');
{
  const hostStatus = []; const guestStatus = [];
  const h = new Net({
    room: 'host-quits',
    profile: { name: 'HOSTY', color: 0xffb347, carColor: 0xd24a2b },
    supabase,
    onStatus: (m, t) => hostStatus.push([m, t]),
  });
  h.start();
  await sleep(120);
  const g = new Net({
    room: 'host-quits',
    profile: { name: 'GUESTY', color: 0x5ff0ff, carColor: 0x2b6ad2 },
    supabase,
    onStatus: (m, t) => guestStatus.push([m, t]),
  });
  g.start();

  const met = await waitFor(() => h.p2pRole === 'host' && g.p2pRole === 'guest'
    && g.p2p?.snapshot().peers.some((p) => p.opened));
  check('they meet first', met, `${h.p2pRole}/${g.p2pRole}`);

  h.close();
  const moved = await waitFor(() => g.p2p === null && g.lane !== 'webrtc', 6000);
  check('the guest is moved off the dead peer lane', moved, `lane ${g.lane}`);
  check('…and is told why', guestStatus.some(([m]) => m === 'poll' || m === 'reconnecting'),
    guestStatus.map(([m, t]) => `${m}:${t}`).join(' | ').slice(0, 120));
  check('…with the ghost removed from its map', g.peers.size === 0, `${g.peers.size} peers`);
  g.close();
}

// --------------------------------------------------------- when it cannot work
console.log('\na dead signalling topic steps aside');
{
  const statuses = [];
  const dead = new Net({
    room: 'dead-peer-room',
    profile: { name: 'CAROL', color: 0xff5f5f, carColor: 0x8b1e1e },
    supabase: { url: 'http://127.0.0.1:9', key: 'anon-key' },   // nothing listens on 9
    onStatus: (m, t) => statuses.push([m, t]),
  });
  dead.start();
  const fell = await waitFor(() => dead.p2p === null && dead.degraded === true, 6000);
  check('the peer lane is abandoned', fell && dead.lane !== 'webrtc', `lane ${dead.lane} · degraded ${dead.degraded}`);
  check('…without throwing', true);
  check('…and another lane is dialled', ['poll', 'ws', 'supabase', 'socketio'].includes(dead.lane) || dead.pollSend === true,
    `lane ${dead.lane}`);
  check('the HUD is told something', statuses.length > 0, statuses.map(([m]) => m).join(','));
  dead.close();
}

console.log('\na runtime without WebRTC never tries');
{
  delete globalThis.RTCPeerConnection;
  const plain = new Net({
    room: 'no-rtc',
    profile: { name: 'DAVE', color: 0x8bf5b4, carColor: 0x2b8b4d },
    supabase,
  });
  plain.start();
  await sleep(120);
  check('the lane is declined up front', plain.p2p === null && plain.lane !== 'webrtc', plain.lane);
  check('…and the room still opens on a fallback', plain.lane === 'supabase' || plain.lane === 'ws' || plain.lane === 'poll',
    plain.lane);
  plain.close();
  globalThis.RTCPeerConnection = rtc.RTCPeerConnection;    // the next block needs it back
}

console.log('\nan explicit relay is obeyed');
{
  globalThis.location = { search: '?relay=wss://relay.example/ws', protocol: 'https:', host: 'example.test' };
  const forced = new Net({
    room: 'forced-relay',
    profile: { name: 'ERIN', color: 0xffb347, carColor: 0xd24a2b },
    supabase,
  });
  forced.start();
  await sleep(80);
  check('?relay= outranks the peer lane', forced.lane !== 'webrtc' && forced.p2pTried === true, forced.lane);
  forced.close();
  delete globalThis.location;
}

await edge.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nP2P LANE WORKS END TO END THROUGH net.js');
process.exit(problems.length ? 1 : 0);
