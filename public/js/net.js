import { uid } from './utils.js';
import { SupabaseRealtime } from './realtime.js';

/**
 * MULTIPLAYER TRANSPORT — Supabase first, our relay only as a fallback.
 *
 * Four lanes, tried in this order:
 *  1. Supabase Realtime broadcast — phone → Supabase edge → phones. No server of
 *     ours in the path at all, which is both lower latency and the only lane
 *     that scales without us running anything. The default when the project is
 *     configured (it always is on a normal deploy).
 *  2. WebSocket relay (`npm start`) — a bare clone with no Supabase credentials,
 *     or a self-hosted relay via `?relay=wss://…`.
 *  3. HTTP polling (`/api/room`) — Vercel serverless, best effort.
 *  4. BroadcastChannel — extra tabs in the same browser, always on.
 *
 * All four carry the same JSON envelope, so peers merge cleanly and `consume()`
 * never cares which lane a message arrived on.
 */
export class Net {
  constructor({
    room = 'highway-01', profile, onPeer, onLeave, onChat, onEvent, onStatus, onCount,
    // { url, key } — the Supabase project. When present the room runs on the
    // realtime edge and our own relay is never dialled.
    supabase = null,
    fetchImpl = null,
  }) {
    this.room = (room || 'highway-01').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 12) || 'highway-01';
    this.id = uid();
    this.profile = profile;
    this.onPeer = onPeer; this.onLeave = onLeave; this.onChat = onChat;
    this.onEvent = onEvent; this.onStatus = onStatus; this.onCount = onCount;
    this.peers = new Map();
    this.ws = null;
    this.mode = 'offline';
    this.pollTimer = null;
    this.bc = null;
    this.lastSend = 0;
    this.lastState = null;
    this.seen = new Set();
    this.outbox = [];
    this.alive = true;
    this.wsAttempts = 0;
    this.supabase = supabase && supabase.url && supabase.key ? supabase : null;
    this.rt = null;                 // SupabaseRealtime instance
    this.fetchImpl = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.WebSocketImpl = null;      // injectable for tests
    this.lane = 'offline';          // 'supabase' | 'ws' | 'poll' | 'offline'
    this.degraded = false;
    this.pending = [];              // said before the lane was ready
  }

  get base() { return { id: this.id, name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor }; }

  start() {
    try {
      this.bc = new BroadcastChannel(`outrun-${this.room}`);
      this.bc.onmessage = (e) => this.consume(e.data);
    } catch { /* unsupported */ }
    // LANE 1: Supabase Realtime. If it cannot even try, fall through instantly.
    if (this.supabase && this.connectSupabase()) {
      // nothing else to dial; the socket lane would only duplicate traffic
    } else {
      this.connectWS();
    }
    this.hello();
    this.pruneTimer = setInterval(() => this.prune(), 1000);
  }

  /**
   * Dial the realtime edge. Returns false when the transport is not usable in
   * this environment (no websocket at all), so `start()` can fall back.
   */
  connectSupabase() {
    try {
      this.rt = new SupabaseRealtime({
        url: this.supabase.url,
        key: this.supabase.key,
        room: this.room,
        onMessage: (msg) => this.consume(msg),
        onStatus: (state, detail) => {
          if (!this.alive) return;
          if (state === 'online') {
            this.lane = 'supabase';
            this.mode = 'online';
            this.onStatus?.('online', detail || 'Supabase realtime');
            this.hello();
            if (this.lastState) this.send({ t: 'state', ...this.lastState });
            this.flushPending();
          } else if (state === 'joining') {
            this.lane = 'supabase';
            this.mode = 'online';
            this.onStatus?.('online', detail || 'Supabase realtime');
          } else if (state === 'error') {
            // the project answered and refused (bad key, RLS, paused project):
            // stop trusting this lane and let the relay take over
            this.degraded = true;
            this.fallBackToRelay(detail || 'realtime refused');
          } else if (state === 'reconnecting') {
            this.onStatus?.('poll', detail || 'realtime reconnecting');
            // A socket that never even opened means the project URL or key is
            // wrong, or the edge is unreachable: bring the relay up at once so
            // the player is not left alone in the room while we retry quietly.
            if (!this.rt?.everOpened) this.fallBackToRelay('realtime unreachable');
            // A socket that opens and then keeps dropping is worse than the
            // relay: after a few tries the relay runs beside it too.
            else if ((this.rt?.attempt || 0) >= 3) this.fallBackToRelay('realtime unstable');
          }
        },
      });
      if (!this.rt.available) { this.rt = null; return false; }
      const dialled = this.rt.connect();
      if (dialled) { this.lane = 'supabase'; this.mode = 'online'; }
      return dialled;
    } catch {
      this.rt = null;
      return false;
    }
  }

  /** Starts the WebSocket relay without tearing down a still-working realtime lane. */
  fallBackToRelay(why = '') {
    if (this.relayTried) return;
    this.relayTried = true;
    this.degraded = true;
    if (why) this.onStatus?.('poll', why);
    this.connectWS();
  }

  connectWS() {
    if (!this.alive) return;
    this.relayTried = true;
    let url;
    try {
      const override = new URLSearchParams(location.search).get('relay');
      if (override) {
        url = `${override}${override.includes('?') ? '&' : '?'}room=${encodeURIComponent(this.room)}`;
      } else {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url = `${proto}//${location.host}/ws?room=${encodeURIComponent(this.room)}`;
      }
    } catch {
      // no location (a sandboxed frame, a worker): polling still works
      this.startPolling();
      return;
    }
    let opened = false;
    const SocketImpl = this.WebSocketImpl || globalThis.WebSocket;
    if (!SocketImpl) { this.startPolling(); return; }
    try {
      this.ws = new SocketImpl(url);
    } catch {
      this.startPolling();
      return;
    }
    const failTimer = setTimeout(() => {
      if (!opened) { try { this.ws.close(); } catch {} this.ws = null; this.startPolling(); }
    }, 2200);

    this.ws.onopen = () => {
      opened = true;
      clearTimeout(failTimer);
      this.stopPolling();
      if (this.rt?.joined) return;          // realtime is up; the relay is a spare
      this.lane = 'ws';
      this.mode = 'online';
      this.onStatus?.('online', 'WebSocket relay connected');
      this.hello();
      if (this.lastState) this.send({ t: 'state', ...this.lastState });
    };
    this.ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this.consume(msg);
    };
    this.ws.onerror = () => {};
    this.ws.onclose = () => {
      clearTimeout(failTimer);
      if (!this.alive) return;
      if (opened) {
        this.onStatus?.('reconnecting', 'relay dropped — retrying');
        setTimeout(() => this.connectWS(), 1500);
      } else {
        this.startPolling();
      }
    };
  }

  startPolling() {
    if (this.pollTimer || !this.alive) return;
    this.mode = 'poll';
    if (!this.rt?.joined) this.lane = 'poll';
    this.onStatus?.('poll', 'Using HTTP relay (best-effort)');
    const tick = async () => {
      if (!this.alive) return;
      const queued = this.outbox.splice(0, 25);
      try {
        const res = await this.fetchImpl(`/api/room`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            room: this.room, id: this.id,
            msg: this.lastState
              ? { t: 'state', name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor, ts: Date.now(), ...this.lastState }
              : { t: 'hello', name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor, ts: Date.now() },
            msgs: queued,
          }),
        });
        if (res.ok) {
          const data = await res.json();
          (data.msgs || []).forEach((m) => this.consume(m));
        }
      } catch { /* offline */ }
    };
    tick();
    this.pollTimer = setInterval(tick, 320);
    this.pollSend = true;
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollSend = false;
  }

  hello() {
    this.send({ t: 'hello', ...this.profile });
  }

  send(msg) {
    if (!this.alive) return;
    const payload = {
      ...msg, id: this.id, name: this.profile.name, color: this.profile.color,
      carColor: this.profile.carColor, custom: this.profile.custom || null, ts: Date.now(),
    };
    if (this.bc) { try { this.bc.postMessage(payload); } catch {} }
    let delivered = false;
    // LANE 1: straight to the Supabase edge
    if (this.rt) delivered = this.rt.send(payload);
    if (!delivered && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(payload)); delivered = true; } catch { /* ignore */ }
    }
    // Nothing is listening yet (the channel is still joining): keep the last few
    // lines so a chat message typed in the first second is not silently lost.
    if (!delivered && payload.t !== 'state') {
      this.pending.push(payload);
      if (this.pending.length > 20) this.pending.shift();
    }
    // In polling mode the interval ships the latest state; other messages queue up.
    if (this.pollSend && payload.t !== 'state') {
      this.outbox.push(payload);
      if (this.outbox.length > 40) this.outbox.splice(0, this.outbox.length - 40);
    }
  }

  /** Re-sends what was said before the lane came up. */
  flushPending() {
    if (!this.pending.length) return;
    const queued = this.pending.splice(0);
    queued.forEach((msg) => this.send(msg));
  }

  pushState(state, now) {
    this.lastState = state;
    if (now - this.lastSend < 90) return;
    this.lastSend = now;
    this.send({ t: 'state', ...state });
  }

  chat(text) {
    this.send({ t: 'chat', text: String(text).slice(0, 120) });
    this.onChat?.({ id: this.id, name: this.profile.name, color: this.profile.color, text: String(text).slice(0, 120) }, true);
  }

  event(kind, data = {}) { this.send({ t: 'event', kind, ...data }); }

  consume(msg) {
    if (!msg || !this.alive) return;
    const key = `${msg.id}:${msg.ts}:${msg.t}`;
    if (msg.id === this.id) return;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 800) this.seen.clear();

    if (msg.t === 'hello' || msg.t === 'state') {
      let p = this.peers.get(msg.id);
      if (!p) {
        p = {
          id: msg.id, name: msg.name || 'SURVIVOR', color: msg.color || 0xffb347,
          carColor: msg.carColor || 0xd24a2b, custom: msg.custom || null, first: true,
        };
        this.peers.set(msg.id, p);
        this.onCount?.(this.peers.size);
        if (msg.t === 'hello') {
          this.onChat?.({ name: msg.name || 'SURVIVOR', text: 'joined the highway', color: '#8bf5b4', sys: true }, false);
        }
      }
      Object.assign(p, msg, { last: Date.now(), first: false });
      p.missing = 0;
      this.onPeer?.(p);
      this.onCount?.(this.peers.size);
      if (msg.t === 'hello' && this.lastState) this.send({ t: 'state', ...this.lastState });
    } else if (msg.t === 'chat') {
      this.onChat?.({ id: msg.id, name: msg.name, color: msg.color, text: msg.text }, false);
    } else if (msg.t === 'event') {
      this.onEvent?.(msg);
    } else if (msg.t === 'bye') {
      this.drop(msg.id);
    }
  }

  prune() {
    const now = Date.now();
    for (const [id, p] of this.peers) {
      if (now - (p.last || 0) > 7000) this.drop(id);
    }
  }

  drop(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    this.onLeave?.(p);
    this.onCount?.(this.peers.size);
    this.onChat?.({ name: p.name, text: 'left the highway', color: '#8b93a5', sys: true }, false);
  }

  close() {
    this.alive = false;
    clearInterval(this.pruneTimer);
    this.stopPolling();
    try { this.send({ t: 'bye' }); } catch {}
    try { this.bc?.close(); } catch {}
    try { this.rt?.close(); } catch {}
    try { this.ws?.close(); } catch {}
  }
}
