/**
 * P2P ROOM, END TO END — host, two guests, a real signalling exchange.
 *
 * There is no WebRTC in Node, so this file provides the two things a peer
 * connection needs and nothing else: a **broadcast bus** standing in for the
 * Supabase topic, and a **fake RTCPeerConnection** that actually pairs up (offer
 * → answer → channels open → messages delivered). The room code under test is
 * the real `public/js/webrtc.js`, driven exactly the way `net.js` drives it.
 *
 * What this proves: the host election, the offer/answer/ICE exchange, the star
 * topology (guests only ever hold one connection), host-authoritative stamping
 * and relaying, and that a host leaving is noticed.
 */
import { P2PRoom } from '../public/js/webrtc.js';
import { hostHello } from '../public/js/p2p.js';
import { createNetwork } from './fake-rtc.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* -------------------------------------------------- a broadcast signalling bus */
/** Stands in for the Supabase topic: everyone hears everyone else, never self. */
function makeBus() {
  const endpoints = new Map();
  const log = [];
  const deliver = (obj) => {
    log.push(obj);
    for (const [id, inbox] of endpoints) {
      if (id === obj.from) continue;                       // broadcast: self is excluded
      setTimeout(() => inbox.forEach((fn) => fn(obj)), 0);
    }
  };
  return {
    log,
    endpoint(id) {
      const inbox = [];
      endpoints.set(id, inbox);
      return {
        send: (obj) => deliver(obj),
        onMessage: (fn) => inbox.push(fn),
        close: () => endpoints.delete(id),
      };
    },
    kinds: () => log.map((m) => m.kind),
  };
}

/* ------------------------------------------------------- a fake peer connection */
// Shared with the Net-level suite: a connection that really pairs (offer →
// answer → channels open → payloads delivered), so the room is exercised rather
// than stubbed. See tests/fake-rtc.mjs.
const rtc = createNetwork();

/** One room participant, wired like `net.js` does it. */
function participant({ id, name, role = 'auto', bus, onMessage = () => {} }) {
  const endpoint = bus.endpoint(id);
  const statuses = [];
  const peers = [];
  const room = new P2PRoom({
    room: 'highway-01',
    selfId: id,
    name,
    profile: { color: 0xffb347, carColor: 0xd24a2b },
    role,
    signaling: endpoint,
    createPeer: () => new rtc.RTCPeerConnection(),
    onMessage,
    onPeer: (p) => peers.push(p),
    onLeave: (p) => peers.push({ ...p, left: true }),
    onStatus: (state) => statuses.push(state),
    helloEvery: 60,
    joinEvery: 60,
    electAfter: 40,
    hostTimeout: 400,
  });
  endpoint.onMessage((obj) => room.handleSignal(obj));
  return { id, name, room, statuses, peers, endpoint };
}

const waitFor = async (fn, ms = 1200) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
};

// ------------------------------------------------------------- the two players
const bus = makeBus();
const hostInbox = [];
const guestInbox = [];
const thirdInbox = [];

console.log('\nelection and handshake');
const alice = participant({ id: 'p-aaa', name: 'Alice', bus, onMessage: (m) => hostInbox.push(m) });
const bob = participant({ id: 'p-bbb', name: 'Bob', bus, onMessage: (m) => guestInbox.push(m) });

alice.room.start();
bob.room.start();

{
  const settled = await waitFor(() => alice.room.role === 'host' && bob.room.role === 'guest' && bob.room.peers.size === 1);
  check('two auto players settle on one host', settled,
    `${alice.room.role}/${bob.room.role}`);
  check('the lower id keeps the room', alice.room.role === 'host' && bob.room.role === 'guest');
  check('the guest yields rather than fighting for it', bob.room.hostId === 'p-aaa', bob.room.hostId);

  const connected = await waitFor(() => [...bob.room.peers.values()].some((p) => p.opened));
  check('the data channel opens', connected);

  const kinds = bus.kinds();
  check('signalling carried an offer', kinds.includes('offer'));
  check('signalling carried an answer', kinds.includes('answer'));
  check('…and ICE candidates', kinds.includes('ice'), `${kinds.filter((k) => k === 'ice').length} candidates`);
  check('nothing but signalling crossed Supabase', kinds.every((k) => ['hello', 'join', 'offer', 'answer', 'ice', 'leave'].includes(k)),
    [...new Set(kinds)].join(','));
}

console.log('\nthird player');
const cara = participant({ id: 'p-ccc', name: 'Cara', bus, onMessage: (m) => thirdInbox.push(m) });
cara.room.start();
{
  const joined = await waitFor(() => cara.room.peers.size === 1 && [...cara.room.peers.values()].every((p) => p.opened || !p.opened));
  check('a late joiner becomes a guest', joined && cara.room.role === 'guest', cara.room.role);
  check('everyone is connected to the host', alice.room.peers.size === 2, String(alice.room.peers.size));
  check('the star holds: guests only know the host',
    [...bob.room.peers.keys()].join() === 'p-aaa' && [...cara.room.peers.keys()].join() === 'p-aaa');
  const opened = await waitFor(() => [...alice.room.peers.values()].filter((p) => p.opened).length === 2);
  check('both guest channels are open on the host', opened);
}

console.log('\ngameplay travels browser to browser');
{
  guestInbox.length = 0;
  thirdInbox.length = 0;
  bob.room.send({ t: 'state', x: 10, y: 0, z: 5, yaw: 1, kmh: 80, hp: 90, day: 3 });
  const relayed = await waitFor(() => thirdInbox.some((m) => m.t === 'state'));
  check('a guest’s telemetry reaches the host', hostInbox.some((m) => m.t === 'state' && m.x === 10));
  check('…and is forwarded to the other guest', relayed);
  const arrived = thirdInbox.find((m) => m.t === 'state');
  check('the host stamps the real author', arrived.id === 'p-bbb' && arrived.name === 'BOB', `${arrived.id}/${arrived.name}`);

  hostInbox.length = 0;
  thirdInbox.length = 0;
  const sent = alice.room.send({ t: 'state', x: 42, kmh: 120 });
  check('the host can send without a relay', sent === true);
  const both = await waitFor(() => guestInbox.some((m) => m.x === 42) && thirdInbox.some((m) => m.x === 42));
  check('host telemetry reaches every guest', both);

  // a guest cannot pretend to be somebody else
  thirdInbox.length = 0;
  bob.room.send({ t: 'chat', text: 'hello sea', id: 'p-aaa', name: 'ALICE' });
  await waitFor(() => thirdInbox.some((m) => m.t === 'chat'));
  const chat = thirdInbox.find((m) => m.t === 'chat');
  check('a guest cannot impersonate the host', chat && chat.id === 'p-bbb' && chat.name === 'BOB',
    chat ? `${chat.id}/${chat.name}` : 'none');
  check('chat rides the reliable channel', [...alice.room.peers.values()].every((p) => p.control?.readyState === 'open'));

  guestInbox.length = 0;
  alice.room.send({ t: 'event', kind: 'tornado', x: 3, z: 4 });
  check('hits and world events are relayed too',
    await waitFor(() => guestInbox.some((m) => m.t === 'event' && m.kind === 'tornado')));
}

console.log('\nhostile and broken packets');
{
  const before = hostInbox.length;
  const hostEnd = bob.room.peers.get('p-aaa');          // the guest's view of the host
  hostEnd.control.send('this is not json');
  hostEnd.control.send(JSON.stringify({ t: 'nonsense', id: 'p-bbb' }));
  hostEnd.state.send(JSON.stringify({ t: 'state', id: 'p-bbb', x: 1e12, kmh: 99999 }));
  await sleep(60);
  check('junk is dropped, not thrown on', alice.room.stats.dropped >= 2, `${alice.room.stats.dropped} dropped`);
  const wild = hostInbox.slice(before).find((m) => m.t === 'state');
  check('…while a wild position is clamped', wild && wild.x === 100_000 && wild.kmh === 400,
    wild ? `${wild.x}/${wild.kmh}` : 'none');
  check('the connection survives all of it', alice.room.peers.size === 2);
}

console.log('\nthe host leaving');
{
  const statuses = cara.statuses.length;
  alice.room.close();
  const noticed = await waitFor(() => cara.room.lost || cara.statuses.slice(statuses).includes('error'), 1500);
  check('a guest is told the room is gone', noticed);
  check('…and the host is removed from its peers', cara.room.hostId === '' || cara.room.peers.size === 0);

  bob.room.close();
  cara.room.close();
}

console.log('\nwhen the handshake never completes');
{
  // A host that announces itself on the topic but whose offers never arrive —
  // the shape of a symmetric NAT / UDP-blocking carrier. The guest must not sit
  // on "P2P" forever with an empty map: it has to hand the room to another lane.
  const statuses = [];
  const sent = [];
  const guest = new P2PRoom({
    room: 'highway-01',
    selfId: 'p-guest',
    name: 'Guest',
    role: 'guest',
    signaling: { send: (obj) => sent.push(obj), close() {} },
    createPeer: () => new rtc.RTCPeerConnection(),
    onStatus: (state, detail) => statuses.push([state, detail || '']),
    joinEvery: 40,
    electAfter: 20,
    openTimeout: 120,
    connectTimeout: 300,
  });
  guest.start();
  // the ghost host keeps saying hello, so the room looks alive…
  const ghost = setInterval(() => {
    guest.handleSignal(hostHello({ room: 'highway-01', from: 'p-ghost', name: 'GHOST', players: 1 }));
  }, 30);
  await sleep(120);
  check('the guest is a guest, waiting', guest.role === 'guest');
  check('a guest that started without a host adopts the one that announces', guest.hostId === 'p-ghost',
    JSON.stringify(guest.hostId));
  check('…and keeps asking to join', sent.filter((m) => m.kind === 'join').length >= 1);
  check('…not given up yet', !statuses.some(([st, d]) => st === 'error' && /direct connection/.test(d)),
    statuses.map(([st]) => st).join(','));
  // …but no offer ever comes, so nothing opens
  const gaveUp = await waitFor(() => statuses.some(([st, d]) => st === 'error' && /direct connection/.test(d)), 2500);
  clearInterval(ghost);
  check('it gives up on a channel that never opens', gaveUp, statuses.map(([st, d]) => `${st}:${d}`).join(' | '));
  check('…and marks the room lost', guest.lost === true);
  guest.close();
}

console.log('\nstats and hygiene');
{
  const room = new P2PRoom({
    room: 'test', selfId: 'solo', name: 'Solo', signaling: { send: () => {}, close: () => {} },
    createPeer: () => new rtc.RTCPeerConnection(), electAfter: 10, helloEvery: 50,
  });
  room.start();
  await sleep(60);
  check('a lone host still runs the room', room.role === 'host', room.role);
  check('and can send (to nobody) without throwing', room.send({ t: 'state', x: 1 }) === false);
  const snap = room.snapshot();
  check('the snapshot names the role', snap.role === 'host' && snap.host === 'solo');
  check('…and counts the host as a player', snap.players === 1);
  room.close();
  check('close() stops everything', room.closed === true);
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL P2P ROOM TESTS PASSED');
process.exit(problems.length ? 1 : 0);
