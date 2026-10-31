/**
 * P2P PROTOCOL — the rules of a peer-to-peer room, with no browser in sight.
 *
 * A room is a **star**: the player who creates it is the host, and the host is
 * the only machine that sees everybody. Guests hold exactly one WebRTC
 * connection (to the host) and never talk to each other; the host validates and
 * forwards what they send. That is what "authoritative host" means here:
 *
 *   guest ──state──▶ host ──state──▶ every other guest
 *   guest ◀─state─── host ◀────────  (the host's own simulation)
 *
 * **Signalling** (finding each other) runs over Supabase Realtime — a broadcast
 * topic per room. Only SDP offers/answers and ICE candidates go there; gameplay
 * never does. Once the data channel opens, the edge is out of the path.
 *
 * This module is deliberately pure: envelope shapes, validation, the host
 * election tie-break and the data-channel message guard. `webrtc.js` is the
 * transport that uses it, and both are tested headlessly.
 */

export const CHANNEL = 'gemby-p2p';
export const PROTOCOL = 1;

/** One host + up to seven guests. Matches the server lanes. */
export const MAX_PEERS = 8;

/** Signalling kinds that may appear on the Supabase topic. */
export const SIGNAL_KINDS = ['hello', 'join', 'offer', 'answer', 'ice', 'leave'];

export const MAX_SDP_BYTES = 24_000;
export const MAX_CANDIDATE_BYTES = 512;
export const MAX_ID = 64;
export const MAX_NAME = 16;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `Highway 01!` → `highway-01` (same rules as every other lane). */
export function sanitiseRoom(room) {
  return String(room || 'highway-01')
    .toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 24) || 'highway-01';
}

/**
 * The Supabase topic a room signals on. Kept apart from `realtime:room:<room>`
 * (the broadcast data lane) so signalling and gameplay never share a channel —
 * a guest that falls back to the broadcast lane still signals here.
 */
export const signalTopicFor = (room) => `realtime:room:p2p-${sanitiseRoom(room)}`;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const colour = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(0xffffff, Math.round(v))) : 0xffb347);

/** A fresh id for this session (not a credential — it never leaves the room). */
export function makePeerId(random = Math.random) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = 'p';
  for (let i = 0; i < 11; i += 1) out += alphabet[Math.floor(Math.min(0.999, Math.max(0, random())) * alphabet.length)];
  return out;
}

/** Wraps a signal payload for the Supabase topic. */
export function envelope({ kind, room, from, to = '*', ...rest }) {
  return {
    channel: CHANNEL,
    v: PROTOCOL,
    kind,
    room: sanitiseRoom(room),
    from: String(from || ''),
    to: String(to || '*'),
    ts: Date.now(),
    ...rest,
  };
}

/**
 * The host's presence ping: "this code is mine, this is who is in it". Repeated
 * every couple of seconds so a late joiner sees the room, and so guests notice
 * when it stops.
 */
export function hostHello({ room, from, name, mode = '100-days', players = 1, day = 1, max = MAX_PEERS }) {
  return envelope({
    kind: 'hello', room, from, to: '*',
    host: true,
    name: str(name, MAX_NAME).toUpperCase() || 'HOST',
    mode: str(mode, 16) || '100-days',
    players: Math.max(1, Math.min(MAX_PEERS, Math.round(Number(players) || 1))),
    day: Math.max(1, Math.min(10_000, Math.round(Number(day) || 1))),
    max: Math.max(1, Math.min(MAX_PEERS, Math.round(Number(max) || MAX_PEERS))),
  });
}

/** A guest asking to be let in. */
export function joinRequest({ room, from, name, color, carColor }) {
  return envelope({
    kind: 'join', room, from,
    name: str(name, MAX_NAME).toUpperCase() || 'SURVIVOR',
    color: colour(color),
    carColor: colour(carColor),
  });
}

/** SDP offers and answers — the only bulky thing that crosses Supabase. */
export function sdpSignal({ kind, room, from, to, sdp }) {
  return envelope({ kind, room, from, to, sdp: { type: kind === 'offer' ? 'offer' : 'answer', sdp: String(sdp || '') } });
}

/** One ICE candidate (or `null` for end-of-candidates). */
export function iceSignal({ room, from, to, candidate }) {
  return envelope({ kind: 'ice', room, from, to, candidate: candidate || null });
}

/**
 * Validates anything that claims to be a signal. Returns a clean object, or
 * null — a malformed or hostile message is dropped, never thrown on.
 */
export function parseSignal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.channel !== CHANNEL) return null;
  if (Number(raw.v) !== PROTOCOL) return null;
  const kind = String(raw.kind || '');
  if (!SIGNAL_KINDS.includes(kind)) return null;
  const from = String(raw.from || '');
  if (!ID_RE.test(from)) return null;
  const to = raw.to === '*' ? '*' : String(raw.to || '');
  if (to !== '*' && !ID_RE.test(to)) return null;

  const out = {
    kind,
    from,
    to,
    room: sanitiseRoom(raw.room),
    host: raw.host === true,
    name: str(raw.name, MAX_NAME).toUpperCase(),
    mode: str(raw.mode, 16),
    players: Math.max(1, Math.min(MAX_PEERS, Math.round(Number(raw.players) || 1))),
    day: Math.max(1, Math.min(10_000, Math.round(Number(raw.day) || 1))),
    max: Math.max(1, Math.min(MAX_PEERS, Math.round(Number(raw.max) || MAX_PEERS))),
    color: colour(raw.color),
    carColor: colour(raw.carColor),
    sdp: null,
    candidate: undefined,
  };

  if (kind === 'offer' || kind === 'answer') {
    const sdp = raw.sdp;
    if (!sdp || typeof sdp !== 'object') return null;
    const body = String(sdp.sdp || '');
    if (!body || body.length > MAX_SDP_BYTES) return null;
    if (sdp.type !== kind) return null;
    out.sdp = { type: sdp.type, sdp: body };
  }

  if (kind === 'ice') {
    if (raw.candidate === null) {
      out.candidate = null;                       // end of candidates
    } else {
      const c = raw.candidate;
      if (!c || typeof c !== 'object') return null;
      const candidate = String(c.candidate || '');
      if (candidate.length > MAX_CANDIDATE_BYTES) return null;
      const line = Number(c.sdpMLineIndex);
      out.candidate = {
        candidate,
        sdpMid: c.sdpMid == null ? null : String(c.sdpMid).slice(0, 16),
        sdpMLineIndex: Number.isFinite(line) ? Math.max(0, Math.min(64, Math.round(line))) : null,
        usernameFragment: c.usernameFragment == null ? null : String(c.usernameFragment).slice(0, 64),
      };
    }
  }

  return out;
}

/**
 * Host election tie-break: if two players each claim the same room code, the
 * lower id keeps it and the other yields (becomes a guest). Deterministic, so
 * both sides reach the same answer without another round trip.
 */
export function keepsHostship(myId, otherHostId) {
  if (!otherHostId || otherHostId === myId) return true;
  return String(myId) < String(otherHostId);
}

const MAX_STATE_TEXT = 24;

/**
 * The guard on a data-channel message. Same envelope the rest of the game uses
 * (`{t:'state'|'chat'|'event'|'hello'|'bye'}`), so `Net.consume` needs no
 * changes — but nothing bigger or stranger than that reaches the game.
 */
export function peerMessage(raw, { maxChat = 120 } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const t = String(raw.t || '').slice(0, MAX_STATE_TEXT);
  const out = {
    t,
    id: str(raw.id, MAX_ID),
    name: str(raw.name, MAX_NAME).toUpperCase(),
    color: colour(raw.color),
    carColor: colour(raw.carColor),
    ts: Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : Date.now(),
  };
  if (!out.id) return null;

  if (t === 'state') {
    const num = (v, lo, hi) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
    };
    Object.assign(out, {
      x: num(raw.x, -100_000, 100_000),
      y: num(raw.y, -10_000, 10_000),
      z: num(raw.z, -100_000, 100_000),
      yaw: num(raw.yaw, -Math.PI * 4, Math.PI * 4),
      speed: num(raw.speed, -400, 400),
      kmh: num(raw.kmh, 0, 400),
      hp: num(raw.hp, 0, 1000),
      day: num(raw.day, 1, 10_000),
      inCar: raw.inCar === true,
      car: str(raw.car, 24),
    });
    return out;
  }
  if (t === 'chat') {
    out.text = String(raw.text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChat);
    return out.text ? out : null;
  }
  if (t === 'event') {
    out.kind = str(raw.kind, 24);
    if (typeof raw.x === 'number') out.x = raw.x;
    if (typeof raw.z === 'number') out.z = raw.z;
    return out.kind ? out : null;
  }
  if (t === 'hello' || t === 'bye') return out;
  return null;
}

/** The ICE servers a phone can actually reach (public STUN; no TURN account). */
export const DEFAULT_ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

/** The two channels every connection opens. */
export const STATE_CHANNEL = 'state';
export const CONTROL_CHANNEL = 'control';
