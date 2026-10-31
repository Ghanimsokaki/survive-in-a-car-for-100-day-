/**
 * SUPABASE REALTIME — the multiplayer lane that does not need our server.
 *
 * Until now a room went: phone → our Node relay → (optionally) Supabase. Every
 * message paid for a hop through a single process, which is fine on a laptop and
 * a bottleneck everywhere else. Supabase Realtime speaks a plain websocket, so
 * the client can join a broadcast channel *directly*: messages go phone → edge →
 * phones, with no relay of ours in the path. That is the "main server" now.
 *
 * This is a small hand-written client for Supabase's realtime protocol (which is
 * Phoenix channels underneath). It only does what a room needs:
 *
 *   · join a public broadcast channel        `realtime:room:<room>`
 *   · send / receive `broadcast` frames
 *   · heartbeat every 25 s so the socket is not reaped
 *   · reconnect with backoff, and give up loudly
 *
 * The frame builders are pure functions so the protocol shape is testable
 * without a socket — see tests/net-supabase.test.mjs.
 */

/** `https://abcd.supabase.co` → `wss://abcd.supabase.co/realtime/v1/websocket`. */
export function realtimeSocketUrl(url, key, { vsn = '1.0.0' } = {}) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  const ws = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  const q = new URLSearchParams();
  if (key) q.set('apikey', String(key));
  q.set('vsn', vsn);
  return `${ws}/realtime/v1/websocket?${q.toString()}`;
}

/** The channel a room lives on. Kept stable: both sides must build the same one. */
export const roomTopic = (room) => `realtime:room:${sanitiseRoom(room)}`;

export const sanitiseRoom = (room) => String(room || 'highway-01')
  .toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 24) || 'highway-01';

/**
 * Join frame. `self: false` means the sender does not receive its own broadcast,
 * which saves half the traffic — the game already knows what it sent.
 */
export function joinFrame(topic, ref = '1') {
  return {
    topic,
    event: 'phx_join',
    payload: {
      config: {
        broadcast: { self: false, ack: false },
        presence: { key: '' },
        postgres_changes: [],
      },
      access_token: null,
    },
    ref,
  };
}

/** A broadcast frame: `event` is the room event name, `payload` the message. */
export function broadcastFrame(topic, event, payload, ref) {
  return {
    topic,
    event: 'broadcast',
    payload: { type: 'broadcast', event, payload },
    ref: ref == null ? null : String(ref),
  };
}

export const heartbeatFrame = (ref) => ({
  topic: 'phoenix',
  event: 'heartbeat',
  payload: {},
  ref: ref == null ? null : String(ref),
});

export const leaveFrame = (topic, ref) => ({ topic, event: 'phx_leave', payload: {}, ref: String(ref) });

/**
 * Pulls a room message out of a realtime frame. Returns null for anything that
 * is not a broadcast carrying an object (heartbeat replies, presence, errors).
 */
export function messageFromFrame(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.event !== 'broadcast') return null;
  const body = frame.payload;
  if (!body || typeof body !== 'object') return null;
  const msg = body.payload;
  if (!msg || typeof msg !== 'object') return null;
  return msg;
}

const BACKOFF_MS = [800, 1600, 3200, 6400, 12_000];

export class SupabaseRealtime {
  /**
   * @param {object} o
   * @param {string} o.url        project URL
   * @param {string} o.key        anon key
   * @param {string} o.room       room code
   * @param {(msg: object) => void} o.onMessage
   * @param {(state: string, detail?: string) => void} [o.onStatus]
   * @param {Function} [o.WebSocketImpl]  injectable for tests
   */
  constructor({
    url, key, room, onMessage, onStatus = null,
    WebSocketImpl = globalThis.WebSocket, now = () => Date.now(),
  } = {}) {
    this.url = url;
    this.key = key;
    this.room = sanitiseRoom(room);
    this.topic = roomTopic(this.room);
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.WS = WebSocketImpl;
    this.now = now;
    this.ws = null;
    this.ref = 0;
    this.open = false;
    this.joined = false;
    this.everOpened = false;      // did the socket handshake ever succeed?
    this.closed = false;
    this.attempt = 0;
    this.heartbeat = null;
    this.retryTimer = null;
    this.connectTimer = null;
    this.failureHandled = false;
    this.lastError = '';
  }

  get socketUrl() { return realtimeSocketUrl(this.url, this.key); }
  get available() { return Boolean(this.socketUrl && this.WS); }

  nextRef() { this.ref += 1; return String(this.ref); }

  connect() {
    if (this.closed || !this.available) { this.onStatus?.('unavailable', 'no realtime transport'); return false; }
    let ws;
    try {
      ws = new this.WS(this.socketUrl);
    } catch (e) {
      this.lastError = String(e?.message || e);
      this.scheduleRetry();
      return false;
    }
    this.ws = ws;
    this.failureHandled = false;

    /**
     * One failure path for every way a socket dies. Browsers fire `error` then
     * `close`; some runtimes fire only `error` and leave the socket hanging, so
     * both land here and the first one wins.
     */
    const fail = (why) => {
      if (this.failureHandled) return;
      this.failureHandled = true;
      this.lastError = why;
      this.open = false;
      this.joined = false;
      this.stopHeartbeat();
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      try { ws.close(); } catch { /* already gone */ }
      if (this.closed) return;
      this.onStatus?.('reconnecting', why);
      this.scheduleRetry();
    };
    this.fail = fail;

    // a socket that never answers is a failure too, not a wait
    this.connectTimer = setTimeout(() => { if (!this.open) fail('realtime timed out'); }, 6000);

    ws.onopen = () => {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.open = true;
      this.everOpened = true;
      this.attempt = 0;
      this.joined = false;
      try { ws.send(JSON.stringify(joinFrame(this.topic, this.nextRef()))); } catch { /* ignore */ }
      this.startHeartbeat();
      this.onStatus?.('joining', `Supabase realtime · room ${this.room}`);
    };

    ws.onmessage = (e) => {
      let frame;
      try { frame = JSON.parse(e.data); } catch { return; }
      if (!frame || typeof frame !== 'object') return;
      if (frame.event === 'phx_reply') {
        // the join's reply is what actually means "you are in the room"
        if (frame.payload?.status === 'ok' && !this.joined) {
          this.joined = true;
          this.onStatus?.('online', `Supabase realtime · room ${this.room}`);
        } else if (frame.payload?.status === 'error') {
          this.lastError = String(frame.payload?.response?.reason || 'join refused');
          this.onStatus?.('error', `Supabase refused the room: ${this.lastError}`);
        }
        return;
      }
      if (frame.event === 'phx_error' || frame.event === 'phx_close') {
        this.joined = false;
        this.onStatus?.('reconnecting', 'realtime channel dropped');
        return;
      }
      const msg = messageFromFrame(frame);
      if (msg) this.onMessage?.(msg);
    };

    ws.onerror = () => fail('realtime unreachable');
    ws.onclose = () => fail('realtime socket closed');
    return true;
  }

  scheduleRetry() {
    if (this.closed || this.retryTimer) return;
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, wait);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      if (!this.open) return;
      try { this.ws.send(JSON.stringify(heartbeatFrame(this.nextRef()))); } catch { /* closed */ }
    }, 25_000);
  }

  stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /**
   * Sends one room message. Returns false until the channel join has been acked:
   * a broadcast pushed before then is dropped by the server, and the caller uses
   * the false to keep the message on another lane.
   */
  send(msg) {
    if (!this.open || !this.joined || !this.ws) return false;
    try {
      this.ws.send(JSON.stringify(broadcastFrame(this.topic, 'room', msg, this.nextRef())));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    this.closed = true;
    this.failureHandled = true;
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      if (this.open && this.ws) this.ws.send(JSON.stringify(leaveFrame(this.topic, this.nextRef())));
    } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
    this.open = false;
    this.joined = false;
  }
}
