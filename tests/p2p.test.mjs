// The peer-to-peer protocol on its own: envelopes, validation, host election,
// and the guard that keeps a hostile data-channel message out of the game.
import {
  CHANNEL, CONTROL_CHANNEL, DEFAULT_ICE, MAX_PEERS, PROTOCOL, SIGNAL_KINDS, STATE_CHANNEL,
  envelope, hostHello, iceSignal, joinRequest, keepsHostship, makePeerId, parseSignal,
  peerMessage, sanitiseRoom, sdpSignal, signalTopicFor,
} from '../public/js/p2p.js';
import { canPeer } from '../public/js/webrtc.js';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

console.log('\nrooms and topics');
{
  check('the room code is normalised like every other lane', sanitiseRoom('Highway 01!') === 'highway01',
    sanitiseRoom('Highway 01!'));
  check('an empty code still gives a room', sanitiseRoom('') === 'highway-01');
  check('signalling has its own topic', signalTopicFor('Highway-01') === 'realtime:room:p2p-highway-01',
    signalTopicFor('Highway-01'));
  check('…which the data lane cannot collide with',
    signalTopicFor('x') !== 'realtime:room:x');
  check('ids are short, safe and random', /^p[a-z0-9]{11}$/.test(makePeerId()) &&
    new Set(Array.from({ length: 50 }, () => makePeerId())).size > 45);
  check('eight players, as everywhere else', MAX_PEERS === 8);
  check('two channels, named', STATE_CHANNEL === 'state' && CONTROL_CHANNEL === 'control');
  check('there is a public STUN server to find the other phone', DEFAULT_ICE[0].urls.length >= 1);
}

console.log('\nsignalling envelopes');
{
  const hello = hostHello({ room: 'hw', from: 'p1', name: 'ann', players: 3, day: 12 });
  check('the host announces who and what it is', hello.kind === 'hello' && hello.host === true);
  check('…with a channel tag and a protocol number', hello.channel === CHANNEL && hello.v === PROTOCOL);
  check('…and a count of the room', hello.players === 3 && hello.max === MAX_PEERS);
  check('…and the day, so a joiner knows the run', hello.day === 12);
  check('names are upper-cased and capped', hello.name === 'ANN');
  check('a silly player count is clamped', hostHello({ room: 'hw', from: 'p1', players: 999 }).players === MAX_PEERS);

  const join = joinRequest({ room: 'hw', from: 'p2', name: 'bob', color: 0x112233 });
  check('a join request names the player', join.kind === 'join' && join.name === 'BOB');
  check('colours are kept', join.color === 0x112233);

  const offer = sdpSignal({ kind: 'offer', room: 'hw', from: 'p1', to: 'p2', sdp: 'v=0…' });
  check('an offer is addressed, not broadcast', offer.to === 'p2' && offer.sdp.type === 'offer');
  check('an answer keeps its own type', sdpSignal({ kind: 'answer', room: 'hw', from: 'p2', to: 'p1', sdp: 'v=0…' }).sdp.type === 'answer');

  const ice = iceSignal({ room: 'hw', from: 'p1', to: 'p2', candidate: { candidate: 'c', sdpMid: '0' } });
  check('ICE candidates travel the same way', ice.kind === 'ice' && ice.candidate.candidate === 'c');

  const custom = envelope({ kind: 'hello', room: 'hw', from: 'p1', extra: 'ignored' });
  check('the envelope stamps a time', typeof custom.ts === 'number' && custom.ts > 0);
  check('every kind is declared', SIGNAL_KINDS.join() === 'hello,join,offer,answer,ice,leave');
}

console.log('\nvalidation — hostile signalling');
{
  check('a foreign channel is refused', parseSignal({ channel: 'other', v: 1, kind: 'hello' }) === null);
  check('a future protocol is refused', parseSignal({ channel: CHANNEL, v: 99, kind: 'hello' }) === null);
  check('an unknown kind is refused', parseSignal({ channel: CHANNEL, v: 1, kind: 'steal', from: 'p1' }) === null);
  check('a bad sender id is refused', parseSignal({ channel: CHANNEL, v: 1, kind: 'hello', from: '"><script>' }) === null);
  check('a bad recipient is refused', parseSignal({ channel: CHANNEL, v: 1, kind: 'offer', from: 'p1', to: 'x y' }) === null);
  check('"*" is allowed as a recipient', parseSignal({ channel: CHANNEL, v: 1, kind: 'hello', from: 'p1', to: '*' }).to === '*');
  check('null is refused', parseSignal(null) === null && parseSignal('hello') === null);

  check('a well-formed hello parses', parseSignal(hostHello({ room: 'x', from: 'p1', name: 'a' }))?.host === true);
  check('an offer without SDP is refused',
    parseSignal({ channel: CHANNEL, v: 1, kind: 'offer', from: 'p1', sdp: null }) === null);
  check('an offer with a mismatched type is refused',
    parseSignal({ channel: CHANNEL, v: 1, kind: 'offer', from: 'p1', sdp: { type: 'answer', sdp: 'x' } }) === null);
  check('a gigantic SDP is refused',
    parseSignal({ channel: CHANNEL, v: 1, kind: 'offer', from: 'p1', sdp: { type: 'offer', sdp: 'x'.repeat(30_000) } }) === null);
  check('end-of-candidates (null) is legal',
    parseSignal(iceSignal({ room: 'x', from: 'p1', to: 'p2', candidate: null })).candidate === null);
  const tidy = parseSignal({
    channel: CHANNEL, v: 1, kind: 'ice', from: 'p1', to: 'p2',
    candidate: { candidate: 'c'.repeat(400), sdpMid: 'm'.repeat(40), sdpMLineIndex: 9999 },
  })?.candidate;
  check('a candidate is sanitised', tidy && tidy.sdpMid.length === 16 && tidy.sdpMLineIndex === 64);
  check('an oversized candidate is refused',
    parseSignal({
      channel: CHANNEL, v: 1, kind: 'ice', from: 'p1', to: 'p2',
      candidate: { candidate: 'c'.repeat(900) },
    }) === null);
  check('a candidate that is not an object is refused',
    parseSignal({ channel: CHANNEL, v: 1, kind: 'ice', from: 'p1', to: 'p2', candidate: 'yes' }) === null);
}

console.log('\nhost election');
{
  check('the lower id keeps the room', keepsHostship('a', 'b') === true);
  check('the higher id yields', keepsHostship('b', 'a') === false);
  check('nobody fights themselves', keepsHostship('a', 'a') === true);
  check('a room nobody claims is ours', keepsHostship('a', '') === true);
}

console.log('\nwhat arrives over the data channel');
{
  const state = peerMessage({ t: 'state', id: 'p1', x: 5, z: -2, kmh: 120, hp: 88, day: 7, inCar: true });
  check('telemetry survives', state.x === 5 && state.kmh === 120 && state.inCar === true);
  check('…with sane defaults', state.y === 0 && state.yaw === 0);
  const wild = peerMessage({ t: 'state', id: 'p1', x: 1e12, hp: -3, kmh: 9999, day: 0 });
  check('wild numbers are clamped', wild.x === 100_000 && wild.hp === 0 && wild.kmh === 400 && wild.day === 1,
    `${wild.x}/${wild.hp}/${wild.kmh}/${wild.day}`);
  check('prototype keys cannot sneak in',
    !Object.prototype.hasOwnProperty.call(peerMessage({ t: 'state', id: 'p1', __proto__: { evil: 1 } }), 'evil'));

  check('chat is trimmed', peerMessage({ t: 'chat', id: 'p1', text: '  hi   there ' }).text === 'hi there');
  check('empty chat is dropped', peerMessage({ t: 'chat', id: 'p1', text: '   ' }) === null);
  check('chat is capped', peerMessage({ t: 'chat', id: 'p1', text: 'x'.repeat(500) }).text.length === 120);
  check('control characters are stripped',
    peerMessage({ t: 'chat', id: 'p1', text: 'a\u0000b' }).text === 'a b');
  check('an event needs a kind', peerMessage({ t: 'event', id: 'p1', kind: 'hit' })?.kind === 'hit');
  check('a message with no author is dropped', peerMessage({ t: 'state', x: 1 }) === null);
  check('an unknown type is dropped', peerMessage({ t: 'exec', id: 'p1' }) === null);
  check('a non-object is dropped', peerMessage('hi') === null && peerMessage(42) === null);
}

console.log('\ncapability probe');
{
  check('no WebRTC in this runtime', canPeer({}) === false);
  check('…and it is detected when present', canPeer({ RTCPeerConnection: class {} }) === true);
  check('an old webview spelling counts too', canPeer({ webkitRTCPeerConnection: class {} }) === true);
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL P2P PROTOCOL TESTS PASSED');
process.exit(problems.length ? 1 : 0);
