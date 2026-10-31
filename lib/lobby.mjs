/**
 * LOBBY — the pure room/matchmaking brain of the socket.io server.
 *
 * Kept free of express/socket.io on purpose: the rules (caps, codes, rate
 * limits, pruning) are the part that must never regress, and they can be tested
 * with `node --test`-style plain imports without installing a single dependency.
 * `server.js` is a thin transport around this class.
 *
 * Rules:
 *   · a room holds 1–8 players            (a solo player is a legal room)
 *   · codes are 5 characters, unambiguous (no O/0, I/1) and unique while live
 *   · telemetry is rate-limited per player, and whitelisted field by field
 *   · a player who goes quiet is dropped, and an empty room is freed
 */

export const MIN_PLAYERS = 1;
export const MAX_PLAYERS = 8;
export const CODE_LENGTH = 5;          // generated codes
export const CODE_MIN = 4;             // …and what a client may pick
export const CODE_MAX = 12;
/** No O/0 or I/1: a code is read aloud and typed on a phone. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const STATE_HZ = 15;                 // telemetry budget, per player
export const CHAT_WINDOW_MS = 10_000;
export const CHAT_PER_WINDOW = 6;
export const STALE_MS = 6000;               // silence that evicts a player
export const EMPTY_ROOM_MS = 30_000;        // grace before a room is forgotten
export const MAX_NAME = 16;
export const MAX_CLIENT_ID = 64;         // a browser's stable identity, not a secret
export const MAX_CHAT = 120;

/** A refused operation, with a machine-readable code the client can show. */
export class LobbyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LobbyError';
    this.code = code;
  }
}

/**
 * Accepts what a player types and returns the canonical code, or '' if it cannot
 * be one. Two shapes are legal:
 *
 *   · a generated 5-character code — forgiving about O→Q and I/1→L, because the
 *     alphabet deliberately omits those and people misread them
 *   · a 4–12 character custom code (the game's own room names, e.g. HIGHWAY01),
 *     kept verbatim apart from the case
 */
export function normaliseCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  if (raw.length === CODE_LENGTH) {
    const mapped = [...raw].map((ch) => (
      ch === 'O' || ch === '0' ? 'Q' : ch === 'I' || ch === '1' ? 'L' : ch
    )).join('');
    if ([...mapped].every((ch) => CODE_ALPHABET.includes(ch))) return mapped;
  }
  if (raw.length >= CODE_MIN && raw.length <= CODE_MAX) return raw;
  return '';
}

/** A fresh code. `random` is injectable so tests are deterministic. */
export function makeCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const r = Math.min(0.999999, Math.max(0, Number(random()) || 0));
    out += CODE_ALPHABET[Math.floor(r * CODE_ALPHABET.length)];
  }
  return out;
}

/** Names are display-only: trimmed, stripped of control characters, capped. */
export function sanitiseName(input, fallback = 'SURVIVOR') {
  const clean = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.slice(0, MAX_NAME).toUpperCase();
}

const num = (v, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Telemetry whitelist. Anything not named here is dropped, so a client cannot
 * smuggle a prototype-poisoning key (`__proto__`) or an unbounded string into
 * every other player's session.
 */
export function sanitiseState(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const bool = (v) => (v === true || v === 1 || v === '1');
  return {
    x: num(raw.x, -100_000, 100_000),
    y: num(raw.y, -10_000, 10_000),
    z: num(raw.z, -100_000, 100_000),
    yaw: num(raw.yaw, -Math.PI * 4, Math.PI * 4),
    speed: num(raw.speed, -400, 400),
    kmh: num(raw.kmh, 0, 400),
    hp: num(raw.hp, 0, 1000),
    hpMax: num(raw.hpMax, 1, 1000) || 100,
    weapon: typeof raw.weapon === 'string' ? raw.weapon.slice(0, 16) : '',
    inCar: bool(raw.inCar),
    car: typeof raw.car === 'string' ? raw.car.slice(0, 24) : '',
    day: num(raw.day, 1, 10_000) || 1,
  };
}

/** A browser's own id (kept in localStorage) so a seat can be reclaimed. */
export function sanitiseClientId(input) {
  return String(input ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, MAX_CLIENT_ID);
}

/** Chat: one line, no control characters, capped, never empty. */
export function sanitiseChat(input) {
  return String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT);
}

export class Lobby {
  constructor({ maxPlayers = MAX_PLAYERS, now = () => Date.now(), random = Math.random } = {}) {
    this.maxPlayers = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, maxPlayers));
    this.now = now;
    this.random = random;
    this.rooms = new Map();          // code → room
    this.indexOf = new Map();        // playerId → code
    this.createdAt = now();
    this.totalJoins = 0;
  }

  // ---------------------------------------------------------------- internals
  room(code) { return this.rooms.get(code) || null; }

  roomOf(playerId) {
    const code = this.indexOf.get(playerId);
    return code ? (this.rooms.get(code) || null) : null;
  }

  liveCodes() {
    const codes = new Set();
    for (let i = 0; i < 64; i += 1) {
      const candidate = makeCode(this.random);
      if (!codes.has(candidate)) codes.add(candidate);
    }
    return codes;
  }

  newCode() {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const code = makeCode(this.random);
      if (!this.rooms.has(code)) return code;
    }
    // astronomically unlikely; fall back to counting so it always terminates
    let n = 1;
    for (;;) {
      const code = `R${String(n).padStart(CODE_LENGTH - 1, '0')}`.slice(0, CODE_LENGTH);
      if (!this.rooms.has(code)) return code;
      n += 1;
    }
  }

  makePlayer({ id, name, clientId }) {
    const at = this.now();
    return {
      id: String(id),
      name: sanitiseName(name),
      clientId: sanitiseClientId(clientId),
      joinedAt: at,
      lastSeen: at,
      state: null,
      chatAt: [],
      goneAt: 0,                 // stamped when the socket drops, cleared on return
      dropped: 0,
    };
  }

  // ------------------------------------------------------------------- rooms
  /** Creates a room and seats the caller in it. */
  create({ id, name, mode = '100-days', code: wanted = '', clientId = '' } = {}) {
    const pid = String(id ?? '');
    if (!pid) throw new LobbyError('bad_player', 'A player needs an id.');
    if (this.indexOf.has(pid)) this.leave(pid);

    // an explicit code makes the room matchmaking: the first player to use a
    // name claims it, everybody after them joins the same highway
    let code = '';
    if (wanted) {
      const normalised = normaliseCode(wanted);
      if (!normalised) throw new LobbyError('bad_code', 'That room code is not valid.');
      if (this.rooms.has(normalised)) throw new LobbyError('code_taken', 'That room already exists.');
      code = normalised;
    } else {
      code = this.newCode();
    }
    const room = {
      code,
      mode: String(mode || '100-days').slice(0, 24),
      createdAt: this.now(),
      emptySince: 0,
      players: new Map(),
      host: pid,
    };
    this.rooms.set(code, room);
    this.indexOf.set(pid, code);
    const player = this.makePlayer({ id: pid, name, clientId });
    room.players.set(pid, player);
    this.totalJoins += 1;
    return { room, player };
  }

  /** Joins by code. Codes are forgiving; unknown ones say so. */
  join({ id, code, name, clientId = '' } = {}) {
    const pid = String(id ?? '');
    if (!pid) throw new LobbyError('bad_player', 'A player needs an id.');
    const wanted = normaliseCode(code);
    if (!wanted) throw new LobbyError('bad_code', 'That room code is not valid.');

    const room = this.rooms.get(wanted);
    if (!room) throw new LobbyError('no_room', 'No room with that code — check it and try again.');
    if (room.players.size >= this.maxPlayers) {
      throw new LobbyError('room_full', `That room is full (${this.maxPlayers} players).`);
    }

    const existing = this.indexOf.get(pid);
    if (existing === wanted) {
      // re-joining the room you are already in is a no-op, not an error
      const player = room.players.get(pid);
      player.lastSeen = this.now();
      player.goneAt = 0;                      // a recovery, not a new player
      return { room, player, reconnected: true };
    }
    if (existing) this.leave(pid);

    const player = this.makePlayer({ id: pid, name, clientId });
    room.players.set(pid, player);
    room.emptySince = 0;
    this.indexOf.set(pid, wanted);
    this.totalJoins += 1;
    return { room, player, reconnected: false };
  }

  /**
   * Quick play: the fullest room that still has space (so friends cluster),
   * otherwise a brand-new room. This is the matchmaking the code doubles as.
   */
  quickMatch({ id, name, mode = '100-days', clientId = '' } = {}) {
    const pid = String(id ?? '');
    const current = this.roomOf(pid);
    if (current) {
      const player = current.players.get(pid);
      if (player) { player.lastSeen = this.now(); player.goneAt = 0; }
      return { room: current, player, reconnected: true };
    }

    let best = null;
    for (const room of this.rooms.values()) {
      if (room.players.size >= this.maxPlayers) continue;
      if (!room.players.size) continue;
      if (mode && room.mode !== mode) continue;
      if (!best || room.players.size > best.players.size) best = room;
    }
    if (best) return this.join({ id: pid, code: best.code, name, clientId });
    return { ...this.create({ id: pid, name, mode, clientId }), reconnected: false };
  }

  /** Removes a player. `closed` is true when the room emptied out. */
  leave(playerId) {
    const pid = String(playerId ?? '');
    const code = this.indexOf.get(pid);
    if (!code) return { room: null, player: null, closed: false };
    const room = this.rooms.get(code);
    this.indexOf.delete(pid);
    if (!room) return { room: null, player: null, closed: false };
    const player = room.players.get(pid) || null;
    room.players.delete(pid);
    if (room.host === pid) {
      const next = room.players.keys().next();
      room.host = next.done ? null : next.value;
    }
    if (!room.players.size) {
      room.emptySince = this.now();
      this.rooms.delete(code);
      return { room, player, closed: true };
    }
    return { room, player, closed: false };
  }

  // --------------------------------------------------------------- telemetry
  /**
   * Accepts a position update. Returns `{ ok, state, throttled }`: a client that
   * shouts faster than STATE_HZ is throttled rather than disconnected, because a
   * phone that briefly bursts is not a cheater.
   */
  state(playerId, payload) {
    const pid = String(playerId ?? '');
    const code = this.indexOf.get(pid);
    if (!code) throw new LobbyError('not_in_room', 'Join a room first.');
    const room = this.rooms.get(code);
    const player = room?.players.get(pid);
    if (!player) throw new LobbyError('not_in_room', 'Join a room first.');

    const at = this.now();
    const minGap = 1000 / STATE_HZ;
    if (player.lastStateAt && at - player.lastStateAt < minGap * 0.5) {
      // a hard burst (2× the budget): drop it, do not queue it
      return { ok: false, throttled: true, state: player.state, room, player };
    }
    const state = sanitiseState(payload);
    player.state = state;
    player.lastSeen = at;
    player.lastStateAt = at;
    return { ok: true, throttled: false, state, room, player };
  }

  chat(playerId, text) {
    const pid = String(playerId ?? '');
    const code = this.indexOf.get(pid);
    if (!code) throw new LobbyError('not_in_room', 'Join a room first.');
    const room = this.rooms.get(code);
    const player = room?.players.get(pid);
    if (!player) throw new LobbyError('not_in_room', 'Join a room first.');
    const body = sanitiseChat(text);
    if (!body) return { ok: false, reason: 'empty', room, player };

    const at = this.now();
    player.chatAt = (player.chatAt || []).filter((t) => at - t < CHAT_WINDOW_MS);
    if (player.chatAt.length >= CHAT_PER_WINDOW) {
      return { ok: false, reason: 'rate', room, player };
    }
    player.chatAt.push(at);
    player.lastSeen = at;
    return { ok: true, text: body, room, player };
  }

  /**
   * Seats in `code` that belong to the same browser but to an older socket —
   * a phone that reconnected without session recovery. The transport decides
   * which of them are really gone before reclaiming (see `server.js`).
   */
  ghosts(code, clientId, exceptId = '') {
    const wanted = sanitiseClientId(clientId);
    const room = wanted ? this.room(normaliseCode(code)) : null;
    if (!room) return [];
    return [...room.players.values()].filter((p) => p.clientId === wanted && p.id !== exceptId);
  }

  /**
   * A socket dropped. The seat is KEPT: a phone that locked its screen, or a
   * tunnel, reconnects into the same session and must not be thrown out of the
   * room. `prune()` releases the seat after STALE_MS of silence.
   */
  gone(playerId) {
    const pid = String(playerId ?? '');
    const room = this.roomOf(pid);
    const player = room?.players.get(pid);
    if (!player) return null;
    player.goneAt = this.now();
    return player;
  }

  /** A player's clock, refreshed by any message (socket.io ping excluded). */
  touch(playerId) {
    const pid = String(playerId ?? '');
    const code = this.indexOf.get(pid);
    if (!code) return null;
    const player = this.rooms.get(code)?.players.get(pid);
    if (player) { player.lastSeen = this.now(); player.goneAt = 0; }
    return player || null;
  }

  // ---------------------------------------------------------------- snapshot
  snapshot(code) {
    const room = this.rooms.get(normaliseCode(code));
    if (!room) return null;
    return {
      code: room.code,
      mode: room.mode,
      host: room.host,
      count: room.players.size,
      max: this.maxPlayers,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        joinedAt: p.joinedAt,
      })),
    };
  }

  /**
   * Drops players who went quiet and forgets rooms that have been empty for a
   * while. Returns everything that changed so the transport can tell the room.
   *
   * `alive` is the transport's view of a player: pass a predicate that answers
   * "is that socket still connected?" and a live-but-idle player is never
   * dropped (somebody reading the map screen sends no telemetry). A player whose
   * socket dropped is released STALE_MS after they went.
   */
  prune({ alive = null } = {}) {
    const at = this.now();
    const evicted = [];
    const closed = [];
    for (const room of [...this.rooms.values()]) {
      for (const player of [...room.players.values()]) {
        let stale = false;
        if (player.goneAt) stale = at - player.goneAt > STALE_MS;
        else if (typeof alive !== 'function' || !alive(player.id)) {
          stale = at - player.lastSeen > STALE_MS;
        }
        if (stale) {
          this.leave(player.id);
          evicted.push({ id: player.id, code: room.code, name: player.name });
        }
      }
    }
    for (const room of [...this.rooms.values()]) {
      if (room.players.size) continue;
      if (!room.emptySince) room.emptySince = at;
      if (at - room.emptySince > EMPTY_ROOM_MS) {
        this.rooms.delete(room.code);
        closed.push(room.code);
      }
    }
    return { evicted, closed };
  }

  stats() {
    let players = 0;
    for (const room of this.rooms.values()) players += room.players.size;
    return {
      rooms: this.rooms.size,
      players,
      joins: this.totalJoins,
      maxPlayers: this.maxPlayers,
      uptimeMs: this.now() - this.createdAt,
    };
  }
}
