// Two clients, a real socket and no relay of ours: this is the whole point of
// "Supabase is the main server". The edge here is a local stand-in for
// Supabase's realtime server (tests/ws-edge.mjs) that speaks the same Phoenix
// frames, and Node's built-in WebSocket is the client, so the modules under test
// are the ones that ship.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { startEdge } from './ws-edge.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The modules are classic browser ESM with no DOM needs except `window`, so they
// run in a vm context: same source, no bundler, no shims.
const sandbox = {
  console, window: { addEventListener() {} },
  WebSocket, URLSearchParams, setInterval, clearInterval, setTimeout, clearTimeout,
  fetch: (...a) => globalThis.fetch(...a),
};
vm.createContext(sandbox);
// net.js now imports the P2P lane. This sandbox is deliberately a runtime with
// no RTCPeerConnection — exactly like an old webview — so the two names it needs
// are stubbed, and the suite proves the lane is *declined* rather than fatal.
const source = ['utils.js', 'realtime.js', 'net.js']
  .map((f) => readFileSync(`${ROOT}public/js/${f}`, 'utf8')
    .replace(/export class /g, 'class ')
    .replace(/^export (const|function) /gm, '$1 ')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, ''))
  .join('\n');
const NO_WEBRTC = `
  const canPeer = () => false;
  class P2PRoom { constructor() { throw new Error('this runtime has no WebRTC'); } }
`;
vm.runInContext(`${NO_WEBRTC}\n${source}\n;globalThis.__Net = Net; globalThis.__RT = SupabaseRealtime;`,
  sandbox, { filename: 'net-bundle.js' });
const Net = sandbox.__Net;
const SupabaseRealtime = sandbox.__RT;

const edge = await startEdge();
console.log(`\nedge on ${edge.url}`);

// --------------------------------------------------------------- two players
console.log('\ntwo players, one room');
{
  const aPeers = []; const bPeers = []; const aChat = []; const bChat = [];
  const statuses = [];
  const profileA = { name: 'ALICE', color: 0xffb347, carColor: 0xd24a2b };
  const profileB = { name: 'BOB', color: 0x5ff0ff, carColor: 0x2b6ad2 };
  const supabase = { url: edge.url, key: 'anon-key' };

  const a = new Net({
    room: 'e2e-room', profile: profileA, supabase,
    onPeer: (p) => aPeers.push(p), onChat: (c) => aChat.push(c),
    onStatus: (m, t) => statuses.push([m, t]),
  });
  a.start();
  await wait(150);
  check('without WebRTC the P2P lane is declined, not fatal', a.lane !== 'webrtc' && a.p2p === null,
    `lane ${a.lane}`);
  const b = new Net({
    room: 'e2e-room', profile: profileB, supabase,
    onPeer: (p) => bPeers.push(p), onChat: (c) => bChat.push(c),
    onStatus: (m, t) => statuses.push([m, t]),
  });
  b.start();
  await wait(300);

  check('both joined the same channel', edge.rooms.has('realtime:room:e2e-room'),
    [...edge.rooms.keys()].join(','));
  check('both run on the supabase lane', a.lane === 'supabase' && b.lane === 'supabase', `${a.lane}/${b.lane}`);
  check('neither opened our own relay', a.ws === null && b.ws === null);
  check('the join frame is what the edge expects',
    edge.seen.some((f) => f.event === 'phx_join' && f.topic === 'realtime:room:e2e-room'));
  check('the client asks not to echo its own broadcasts',
    edge.seen.find((f) => f.event === 'phx_join')?.payload?.config?.broadcast?.self === false);

  a.pushState({ x: 12, z: -4 }, Date.now() + 1000);
  await wait(250);
  check('A sees B', aPeers.some((p) => p.name === 'BOB'), JSON.stringify(aPeers.map((p) => p.name)));
  check('B sees A', bPeers.some((p) => p.name === 'ALICE'), JSON.stringify(bPeers.map((p) => p.name)));
  check('nobody is told about themselves', !aPeers.some((p) => p.name === 'ALICE'));

  b.chat('hello from bob');
  await wait(200);
  check('chat crosses the edge', aChat.some((c) => c.text === 'hello from bob'),
    JSON.stringify(aChat.map((c) => c.text)));

  a.event('storm', { cat: 3 });
  await wait(150);
  check('world events cross too', edge.seen.some((f) => f.event === 'broadcast' && f.payload?.payload?.t === 'event'));

  check('the room is a real join, acked by the edge', statuses.some(([s]) => s === 'online'));

  a.close();
  await wait(200);
  check('closing leaves the channel', (edge.rooms.get('realtime:room:e2e-room')?.size || 0) <= 1,
    `${edge.rooms.get('realtime:room:e2e-room')?.size || 0} left`);
  b.close();
  await wait(100);
}

// ------------------------------------------------------- nothing said is lost
console.log('\nmessages before the room is ready');
{
  const heard = [];
  const supabase = { url: edge.url, key: 'anon-key' };
  const early = new Net({ room: 'early-room', profile: { name: 'EARLY', color: 0, carColor: 0 }, supabase, onPeer: () => {} });
  const late = new Net({ room: 'early-room', profile: { name: 'LATE', color: 0, carColor: 0 }, supabase,
    onPeer: () => {}, onChat: (c) => heard.push(c) });
  late.start();
  await wait(200);
  early.start();
  early.chat('said before the socket was joined');   // fires inside the join window
  await wait(400);
  check('a message typed during the join still arrives',
    heard.some((c) => /said before/.test(c.text)), JSON.stringify(heard.map((c) => c.text)));
  early.close(); late.close();
  await wait(100);
}

// ------------------------------------------------------------- rooms are walls
console.log('\nrooms do not leak');
{
  const one = []; const two = [];
  const supabase = { url: edge.url, key: 'anon-key' };
  const roomOne = new Net({ room: 'alpha', profile: { name: 'ONE', color: 0, carColor: 0 }, supabase, onPeer: (p) => one.push(p) });
  const roomTwo = new Net({ room: 'beta', profile: { name: 'TWO', color: 0, carColor: 0 }, supabase, onPeer: (p) => two.push(p) });
  roomOne.start(); roomTwo.start();
  await wait(250);
  roomOne.chat('only for alpha');
  await wait(200);
  check('a different room hears nothing', !two.some((p) => p.name === 'ONE'), `${two.length} peers`);
  roomOne.close(); roomTwo.close();
  await wait(100);
}

// ------------------------------------------------------- a dead project falls back
console.log('\na dead project falls back to the relay');
{
  // port 1 refuses connections: the worst realistic Supabase failure
  const net = new Net({
    room: 'dead', profile: { name: 'X', color: 0, carColor: 0 },
    supabase: { url: 'http://127.0.0.1:1', key: 'k' },
    onStatus: () => {},
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  net.start();
  await wait(400);
  check('the dead lane is marked degraded', net.degraded === true, `${net.lane} · ${net.rt?.lastError}`);
  check('the relay lane is dialled as a spare', net.relayTried === true);
  net.close();
}

// ---------------------------------------------------- realtime beats polling
console.log('\nthe fast lane is preferred');
{
  const p = { name: 'P', color: 0, carColor: 0 };
  const withCreds = new Net({ room: 'pref', profile: p, supabase: { url: edge.url, key: 'k' }, onStatus: () => {} });
  withCreds.start();
  await wait(150);
  check('with credentials there is no polling timer', withCreds.pollTimer === null);
  check('and no relay socket', withCreds.ws === null);
  withCreds.close();

  const noCreds = new Net({ room: 'pref', profile: p, onStatus: () => {} });
  noCreds.start();
  await wait(150);
  check('without credentials the relay still carries play',
    noCreds.rt === null && (noCreds.ws !== null || noCreds.pollTimer !== null),
    noCreds.ws !== null ? 'websocket' : 'http poll');
  noCreds.close();
}

await edge.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nSUPABASE ROOMS WORK END TO END (NO RELAY)');
process.exit(problems.length ? 1 : 0);
