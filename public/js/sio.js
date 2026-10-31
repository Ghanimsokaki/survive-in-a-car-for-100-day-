/**
 * SOCKET.IO LANE — the client half of `server.js`.
 *
 * socket.io ships its own browser client from the server itself
 * (`/socket.io/socket.io.js`), so there is nothing to bundle and no CDN to
 * trust: we inject one script tag pointing at the relay origin the page was told
 * about, then speak the room protocol from `server.js`.
 *
 * The lane's job is to look exactly like every other lane to `Net`: it hands
 * room messages to `onMessage` and never decides anything about the game.
 */

/** `https://relay.example/` → `<base>/socket.io/socket.io.js` (version-agnostic). */
export function relayScriptUrl(base) {
  const clean = String(base || '').trim().replace(/\/+$/, '');
  if (!clean) return '';
  if (!/^https?:\/\//i.test(clean) && !/^wss?:\/\//i.test(clean)) return '';
  return `${clean.replace(/^ws(s?):\/\//i, 'http$1://')}/socket.io/socket.io.js`;
}

const CLIENT_ID_KEY = 'outrun-client-id';

/**
 * A stable id for this browser. It is not a credential — it only lets the
 * server hand a reconnected phone its old seat back instead of leaving a ghost
 * car standing in the road. Falls back to an in-memory id when storage is
 * blocked (private mode, file://).
 */
export function clientId() {
  try {
    const store = globalThis.localStorage;
    const existing = store?.getItem(CLIENT_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{8,}$/.test(existing)) return existing;
    const fresh = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    store?.setItem(CLIENT_ID_KEY, fresh);
    return fresh;
  } catch {
    return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** The room protocol payloads, kept pure so they can be asserted in tests. */
export function joinPayload(code, name, id = '') {
  const payload = { code: String(code || '').toUpperCase(), name: String(name || '').slice(0, 16) };
  if (id) payload.clientId = id;
  return payload;
}
export function createPayload(code, name, mode, id = '') {
  const payload = { ...joinPayload(code, name, id), mode: mode || '100-days' };
  return payload;
}

let loading = null;

/**
 * Loads the socket.io client from `base`. Resolves to the `io` function.
 * Idempotent: a second call reuses the same promise (or the already-present io).
 */
export function loadSocketIo(base, { timeoutMs = 8000 } = {}) {
  const src = relayScriptUrl(base);
  if (!src) return Promise.resolve(null);
  if (globalThis.io) return Promise.resolve(globalThis.io);
  if (loading) return loading;

  loading = new Promise((resolve) => {
    const doc = globalThis.document;
    if (!doc?.createElement || !doc.head) { resolve(null); loading = null; return; }
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
      if (!value) loading = null;         // allow a retry later
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const script = doc.createElement('script');
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => finish(globalThis.io || null);
    script.onerror = () => finish(null);
    doc.head.appendChild(script);
  });
  return loading;
}

/**
 * A thin wrapper over one socket.io connection to a room: join (creating the
 * room if the code is free), relay envelopes, and report status changes.
 */
export class SocketIoLane {
  constructor({
    base, code, name, mode = '100-days',
    onMessage = null, onStatus = null, onPeer = null, onLeave = null,
    ioImpl = null,
  } = {}) {
    this.base = String(base || '').replace(/\/+$/, '');
    this.clientId = clientId();
    this.code = String(code || '').toUpperCase();
    this.name = name;
    this.mode = mode;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onPeer = onPeer;
    this.onLeave = onLeave;
    this.ioImpl = ioImpl;
    this.socket = null;
    this.joined = false;
    this.roomCode = '';
    this.failures = 0;
    this.closed = false;
  }

  get available() { return Boolean(this.base); }

  /** Connects and joins. Resolves true once the server confirms the room. */
  async connect() {
    if (!this.available || this.closed) return false;
    const io = this.ioImpl || await loadSocketIo(this.base);
    if (!io) { this.onStatus?.('error', 'socket.io client unavailable'); return false; }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => { if (!settled) { settled = true; resolve(value); } };
      let socket;
      try {
        socket = io(this.base, {
          transports: ['websocket', 'polling'],
          withCredentials: false,
          reconnection: true,
          reconnectionAttempts: 8,
          reconnectionDelay: 700,
          timeout: 8000,
        });
      } catch {
        this.onStatus?.('error', 'socket.io could not connect');
        settle(false);
        return;
      }
      this.socket = socket;

      socket.on('connect', () => {
        this.failures = 0;
        this.onStatus?.('joining', `socket.io server · room ${this.code}`);
        this.join();
      });

      socket.on('connect_error', (err) => {
        this.failures += 1;
        this.onStatus?.('reconnecting', err?.message ? `socket.io: ${err.message}` : 'socket.io unreachable');
        if (this.failures >= 2) settle(false);
      });

      socket.on('disconnect', () => {
        this.joined = false;
        if (this.closed) return;
        this.onStatus?.('reconnecting', 'socket.io disconnected');
      });

      socket.on('room:joined', (payload) => {
        this.joined = true;
        this.roomCode = payload?.code || this.code;
        this.onStatus?.('online', `socket.io server · room ${this.roomCode}`);
        settle(true);
      });

      socket.on('room:state', (snapshot) => {
        (snapshot?.players || []).forEach((p) => {
          if (!p?.id || p.id === socket.id) return;
          this.onPeer?.({ id: p.id, name: p.name, state: p.state || null, first: false });
        });
      });

      socket.on('player:joined', (p) => {
        if (!p?.id || p.id === socket.id) return;
        this.onMessage?.({ t: 'hello', id: p.id, name: p.name, ts: Date.now() });
      });

      socket.on('player:left', (p) => {
        if (!p?.id || p.id === socket.id) return;
        this.onMessage?.({ t: 'bye', id: p.id, name: p.name, ts: Date.now() });
      });

      socket.on('msg', (msg) => { if (msg && typeof msg === 'object') this.onMessage?.(msg); });

      socket.on('error:msg', (err) => {
        this.onStatus?.('error', err?.message || 'socket.io refused that');
      });

      setTimeout(() => settle(this.joined), 9000);
    });
  }

  /** Join the room, creating it when the code is not live yet. */
  join() {
    const s = this.socket;
    if (!s) return;
    const attempt = (event, payload) => new Promise((resolve) => {
      let answered = false;
      s.timeout(6000).emit(event, payload, (err, res) => {
        if (answered) return;
        answered = true;
        if (err) { resolve({ ok: false, error: { code: 'timeout', message: 'The server did not answer.' } }); return; }
        resolve(res || { ok: false, error: { code: 'no_reply', message: 'No reply.' } });
      });
    });

    (async () => {
      const res = await attempt('room:join', joinPayload(this.code, this.name, this.clientId));
      if (res?.ok) return;
      if (res?.error?.code !== 'no_room') {
        this.onStatus?.('error', res?.error?.message || 'could not join');
        return;
      }
      // the first player to use a code creates it — codes are the matchmaking
      const created = await attempt('room:create', createPayload(this.code, this.name, this.mode, this.clientId));
      if (!created?.ok) this.onStatus?.('error', created?.error?.message || 'could not open the room');
    })();
  }

  send(msg) {
    if (!this.socket || !this.joined) return false;
    try { this.socket.emit('msg', msg); return true; } catch { return false; }
  }

  close() {
    this.closed = true;
    this.joined = false;
    try { this.socket?.emit('room:leave'); } catch { /* gone */ }
    try { this.socket?.close(); } catch { /* gone */ }
    this.socket = null;
  }
}
