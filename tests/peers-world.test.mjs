/**
 * TWO SURVIVORS, IN THE WORLD — can you actually *see* the other player?
 *
 * "I didn't see the players" was true for a long time, and every suite passed
 * anyway, because nothing ever asserted that a peer produced a drawable body.
 * This file runs two real `Game` instances in one process with an in-process
 * relay: each game's `net.send` hands its payload straight to the other game's
 * `net.consume`, so the envelope, the id, the throttle and the dedupe are the
 * real ones — only the wire is local.
 *
 * What must hold:
 *   · a peer who has only said hello has *no visible body* (no ghost at 0,0,0);
 *   · once a position arrives, their body is in the scene, where they are;
 *   · it tracks them as they drive, smoothly, not by teleporting;
 *   · they wear their own name and colour, and a driver keeps their nameplate
 *     (an anonymous vehicle is indistinguishable from a raider);
 *   · getting out of the car swaps the body back to the walking rig;
 *   · a peer who leaves is removed from the scene, not just from a list;
 *   · a peer across the map costs nothing to draw;
 *   · nonsense from the network never becomes a NaN transform.
 */
import { installDOM, El } from './doms.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

globalThis.__COARSE__ = false;
globalThis.__TOUCH__ = false;
installDOM({ width: 1280, height: 800 });
globalThis.BroadcastChannel = undefined;          // no second lane in one process

const { Game } = await import('./app/js/game.js');

/** A game with an in-process relay: whatever it sends, the other one receives. */
function survivor(name, colour, carColour) {
  const game = new Game({
    mount: new El('div', 'app'),
    profile: { name, color: colour, carColor: carColour },
    room: 'peer-room',
    onQuit: () => {},
  });
  game.started = true;
  // a controlled clock: `pushState` throttles to one state per 90 ms, and a test
  // that runs its frames in the same millisecond would only ever send one
  let clock = 0;
  const push = game.net.pushState.bind(game.net);
  game.net.pushState = (state) => { clock += 100; push(state, clock); };
  return game;
}

const host = survivor('HOST', 0xffb347, 0xd24a2b);
const guest = survivor('GUEST', 0x59c9ff, 0x1e88e5);
// A relay stamps its own arrival time. `Net` dedupes on (id, ts, type), and a
// tight test loop never advances `Date.now()`, so reusing it would deliver each
// state exactly once and prove nothing about following a moving player.
let wire = 0;
const deliver = (to, from, msg, name, color) => to.net.consume({
  ...msg, id: from.net.id, name, color, ts: ++wire, last: Date.now(),
});
host.net.send = (msg) => deliver(guest, host, msg, 'HOST', 0xffb347);
guest.net.send = (msg) => deliver(host, guest, msg, 'GUEST', 0x59c9ff);

const step = (n, a = {}, b = {}) => {
  for (let i = 0; i < n; i++) {
    Object.assign(host.keys, a);
    Object.assign(guest.keys, b);
    host.update(1 / 60); host.updateCamera(1 / 60);
    guest.update(1 / 60); guest.updateCamera(1 / 60);
  }
};

console.log('\n[state]', 'host dead', host.dead, 'hp', host.hp.toFixed(0), 'inCar', host.inCar,
  'guest peers', guest.net.peers.size);

/* ------------------------------------------- 1. a hello is not a position */
console.log('\na peer with no position has no body');
{
  // `hello` carries a name and a colour, and nothing else
  host.net.send({ t: 'hello' });
  const seen = guest.peerVisuals?.get(host.net.id);
  check('the peer is remembered the moment they say hello', Boolean(seen), seen ? 'a visual exists' : 'nothing');
  check('…but nothing is drawn for them yet',
    Boolean(seen) && seen.avatar.root.visible === false && seen.car.group.visible === false);
  check('…and the body is not parked at the origin',
    Boolean(seen) && seen.avatar.root.position.lengthSq() === 0 && seen.live === false,
    seen ? `live ${seen.live}` : '');
}

/* ------------------------------------------- 2. a position becomes a body */
console.log('\nthe other survivor is in the world, where they are');
{
  step(4);
  const v = guest.peerVisuals.get(host.net.id);
  check('a body exists and is in the scene', Boolean(v) && Boolean(v.avatar.root.parent),
    v ? `${v.avatar.root.children.length} parts` : 'none');
  check('the host starts in their rig, so the rig is what is drawn',
    Boolean(v) && v.inCar === true && v.car.group.visible === true,
    v ? `inCar ${v.inCar}` : 'no peer');
  const where = v.car.group.position;
  const mine = host.car.pos;
  check('it is drawn where the other player is', Math.hypot(where.x - mine.x, where.z - mine.z) < 2,
    `${Math.hypot(where.x - mine.x, where.z - mine.z).toFixed(2)} m apart`);
  check('it wears their name', v.name === 'HOST', v.name);
  check('…and their colour', v.colour === 0xffb347, '#' + v.colour.toString(16));
  check('the nameplate is over the rig', v.carTag.visible === true);
}

/* ------------------------------------------- 3. it follows, smoothly */
console.log('\nthe body follows the player, it does not teleport');
{
  const v = guest.peerVisuals.get(host.net.id);
  const before = v.car.group.position.clone();
  // the host drives
  for (let i = 0; i < 180; i++) {
    host.keys.forward = 1;
    host.update(1 / 60); host.updateCamera(1 / 60);
    guest.update(1 / 60); guest.updateCamera(1 / 60);
  }
  host.keys.forward = 0;
  const moved = v.car.group.position.distanceTo(before);
  check('the other player drove', host.car.distance > 20, `${host.car.distance.toFixed(0)} m`);
  check('their body moved with them', moved > 8, `${moved.toFixed(1)} m`);
  const target = v.target;
  const pos = v.car.group.position;
  check('it is never more than a few metres behind the truth',
    Math.hypot(pos.x - target.x, pos.z - target.z) < 6,
    `${Math.hypot(pos.x - target.x, pos.z - target.z).toFixed(2)} m lag`);
  check('no NaN crept into the transform',
    [pos.x, pos.y, pos.z, v.car.yaw].every((n) => Number.isFinite(n)));
}

/* ------------------------------------------- 4. a driver keeps a nameplate */
console.log('\na survivor in a car is still a person, not a mystery vehicle');
{
  const v = guest.peerVisuals.get(host.net.id);
  step(30);
  check('the peer is driving', v.inCar === true && host.inCar === true);
  check('the car is the body on screen', v.car.group.visible === true && v.avatar.root.visible === false);
  check('the car carries their name', v.carTag && v.carTag.visible === true && v.carTag.parent === v.car.group,
    v.carTag ? `"${v.name}" over the car` : 'no tag');
  check('the walking nameplate is out of the way', !v.avatar.tag || v.avatar.tag.visible === false);
}

/* ------------------------------------------- 5. getting out swaps the body back */
console.log('\ngetting out of the car puts the walker back');
{
  const v = guest.peerVisuals.get(host.net.id);
  host.car.speed = 0;                     // you cannot bail out at speed
  host.toggleCar();
  check('the host is on foot', host.inCar === false);
  step(30);
  check('the walker is drawn again', v.avatar.root.visible === true && v.car.group.visible === false,
    `inCar ${v.inCar}`);
  check('…with the nameplate back over their head', v.avatar.tag.visible === true);
}

/* ------------------------------------------- 6. a peer across the map costs nothing */
console.log('\na survivor across the map is culled, not drawn');
{
  const v = guest.peerVisuals.get(host.net.id);
  guest.pos.set(0, 0, 0);
  v.target.set(4000, 0, 4000);
  v.live = true;
  guest.updatePeers(1 / 60);
  check('far away, neither body is submitted', v.avatar.root.visible === false && v.car.group.visible === false);
  v.target.set(host.pos.x + 3, 0, host.pos.z + 3);
  guest.updatePeers(1 / 60);
  check('close again, they come back', v.avatar.root.visible === true || v.car.group.visible === true);
}

/* ------------------------------------------- 7. nonsense from the network */
console.log('\nnonsense from the network cannot break the scene');
{
  const v = guest.peerVisuals.get(host.net.id);
  let threw = null;
  try {
    guest.onPeer({ id: host.net.id, name: 'HOST', x: NaN, z: 12 });
    guest.onPeer({ id: host.net.id, x: 'far', z: null });
    guest.onPeer({ id: 'ghost', name: 'GHOST' });          // hello only, again
    guest.updatePeers(1 / 60);
  } catch (err) { threw = err; }
  check('a junk position is ignored instead of applied', !threw && Number.isFinite(v.target.x),
    threw ? threw.message : `target ${v.target.x}`);
  check('an unknown peer does not invent a body in the middle of the map',
    Boolean(guest.peerVisuals.get('ghost')) && guest.peerVisuals.get('ghost').live === false);
  check('every peer transform is still finite', [...guest.peerVisuals.values()].every((p) =>
    [p.avatar.root.position.x, p.avatar.root.position.z, p.target.x, p.target.z].every(Number.isFinite)));
}

/* ------------------------------------------- 8. leaving is leaving */
console.log('\na survivor who leaves is gone from the scene');
{
  const v = guest.peerVisuals.get(host.net.id);
  const had = Boolean(v.avatar.root.parent);
  host.net.send({ t: 'bye' });
  check('the body was in the scene to begin with', had);
  check('…and is gone after the goodbye', !guest.peerVisuals.has(host.net.id),
    `${guest.peerVisuals.size} peer(s) left`);
  check('the scene no longer holds it', v.avatar.root.parent === null && v.car.group.parent === null);
}

/* ------------------------------------------- 9. the radar still names them */
console.log('\nand the radar still shows where they are');
{
  step(20);
  const id = host.net.id;
  check('the peer is back on the map after their next state', guest.peerVisuals.has(id));
  const blips = guest.radarBlips();
  check('a peer is a radar blip', blips.some((b) => b.kind === 'peer'),
    `${blips.filter((b) => b.kind === 'peer').length} peer blip(s)`);
  check('the party list names them', guest.partyRows().some((r) => r.name === 'HOST'),
    guest.partyRows().map((r) => r.name).join(', '));
}

/* ------------------------------------------- 10. it does not cost a frame */
console.log('\ntwo players do not cost a frame');
{
  const samples = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    host.update(1 / 60); host.updateCamera(1 / 60);
    guest.update(1 / 60); guest.updateCamera(1 / 60);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  check('both simulations together fit a frame', mean < 8, `${mean.toFixed(2)} ms per pair of frames`);
}

try { host.net.close(); } catch { /* already closed */ }
try { guest.net.close(); } catch { /* already closed */ }
console.log(problems.length ? `\n${problems.length} FAILURES` : '\nBOTH SURVIVORS ARE VISIBLE');
process.exit(problems.length ? 1 : 0);
