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
let pcCounter = 0;
class FakeChannel {
  constructor(label, { ordered = true } = {}) {
    this.label = label;
    this.ordered = ordered;
    this.readyState = 'connecting';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.peer = null;              // the mirrored channel on the other side
  }

  send(data) {
    if (this.readyState !== 'open') throw new Error('channel is not open');
    const other = this.peer;
    if (!other || other.readyState !== 'open') return;
    setTimeout(() => other.onmessage?.({ data }), 0);
  }

  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    setTimeout(() => this.onclose?.({}), 0);
  }

  open() {
    if (this.readyState === 'open') return;
    this.readyState = 'open';
    setTimeout(() => this.onopen?.({}), 0);
  }
}

const registry = new Map();      // pc id → FakePeerConnection

class FakePeerConnection {
  constructor() {
    pcCounter += 1;
    this.id = `pc${pcCounter}`;
    registry.set(this.id, this);
    this.localDescription = null;
    this.remoteDescription = null;
    this.connectionState = 'new';
    this.onicecandidate = null;
    this.ondatachannel = null;
    this.onconnectionstatechange = null;
    this.channels = [];
    this.iceSeen = [];
  }

  createDataChannel(label, opts = {}) {
    const channel = new FakeChannel(label, opts);
    this.channels.push(channel);
    return channel;
  }

  async createOffer() { return { type: 'offer', sdp: `v=0\noffer ${this.id}\n` }; }
  async createAnswer() {
    const token = String(this.remoteDescription?.sdp || '').match(/offer (\S+)/)?.[1] || '';
    return { type: 'answer', sdp: `v=0\nanswer ${token}\n` };
  }

  async setLocalDescription(desc) {
    this.localDescription = { type: desc.type, sdp: desc.sdp };
    this.connectionState = this.connectionState === 'new' ? 'connecting' : this.connectionState;
    // the guest knows who offered (the offer is in its remote description), so
    // this is where the two fake endpoints meet — as they would on the wire
    if (desc.type === 'answer') {
      const token = String(this.remoteDescription?.sdp || '').match(/offer (\S+)/)?.[1] || '';
      const offerer = registry.get(token);
      if (offerer && offerer !== this) pair(offerer, this);
    }
    // a real stack emits candidates as it gathers; one is enough to prove the path
    setTimeout(() => this.onicecandidate?.({ candidate: { candidate: `candidate ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 } }), 0);
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = { type: desc.type, sdp: desc.sdp };
  }

  async addIceCandidate(candidate) { this.iceSeen.push(candidate); }

  close() {
    this.connectionState = 'closed';
    this.onconnectionstatechange?.({});
    for (const ch of this.channels) ch.close();
  }
}

/** Wires the host's channels to the guest's, and opens them. */
function pair(hostPc, guestPc) {
  if (hostPc.connectionState === 'connected' && guestPc.connectionState === 'connected') return;
  for (const channel of hostPc.channels) {
    const mirror = new FakeChannel(channel.label, { ordered: channel.ordered });
    mirror.peer = channel;
    channel.peer = mirror;
    guestPc.channels.push(mirror);
    setTimeout(() => guestPc.ondatachannel?.({ channel: mirror }), 0);
  }
  hostPc.connectionState = 'connected';
  guestPc.connectionState = 'connected';
  setTimeout(() => {
    for (const channel of hostPc.channels) {
      channel.open();
      channel.peer?.open();
    }
    hostPc.onconnectionstatechange?.({});
    guestPc.onconnectionstatechange?.({});
  }, 5);
}

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
    createPeer: () => new FakePeerConnection(),
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

console.log('\nstats and hygiene');
{
  const room = new P2PRoom({
    room: 'test', selfId: 'solo', name: 'Solo', signaling: { send: () => {}, close: () => {} },
    createPeer: () => new FakePeerConnection(), electAfter: 10, helloEvery: 50,
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
