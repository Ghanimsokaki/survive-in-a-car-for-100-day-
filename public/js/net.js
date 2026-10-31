import { uid } from './utils.js';
import { SupabaseRealtime } from './realtime.js';
import { SocketIoLane } from './sio.js';
import { P2PRoom, canPeer } from './webrtc.js';

/**
 * MULTIPLAYER TRANSPORT — peer-to-peer first, relays only as a fallback.
 *
 * Five lanes, tried in this order:
 *  0. **P2P / WebRTC** (`p2p.js` + `webrtc.js`) — the room is a star around the
 *     player who created it. Supabase Realtime is used only to *find* each other
 *     (SDP + ICE); the driving, hits and chat then go straight browser to
 *     browser over a data channel, which is what "low latency at 60 FPS" means
 *     in practice. Needs `RTCPeerConnection` and a configured Supabase project.
 *  1. **Socket.IO server** (`server.js` → `npm start`) — the dedicated realtime
 *     host: rooms of 1–8, matchmaking codes, telemetry at up to 15 Hz. Used
 *     whenever a relay origin is configured and WebRTC is not available
 *     (`?relay=https://…`, the page's own origin, or `window.__OUTRUN_RELAY__`).
 *  2. Supabase Realtime broadcast — phone → Supabase edge → phones, no server of
 *     ours in the path. The fallback when a peer connection cannot be made.
 *  3. WebSocket relay (`server.mjs`) — a bare clone with no credentials.
 *  4. HTTP polling (`/api/room`) — Vercel serverless, best effort.
 *  5. BroadcastChannel — extra tabs in the same browser, always on.
 *
 * Every lane carries the same JSON envelope, so peers merge cleanly and
 * `consume()` never cares which one a message arrived on.
 */
export class Net {
  constructor({
    room = 'highway-01', profile, onPeer, onLeave, onChat, onEvent, onStatus, onCount,
    // { url, key } — the Supabase project. When present the room runs on the
    // realtime edge and our own relay is never dialled.
    supabase = null,
    // the socket.io server origin, e.g. "https://outrun-relay.up.railway.app"
    relayUrl = '',
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
    this.relayUrl = String(relayUrl || '').replace(/\/+$/, '');
    this.sio = null;                // SocketIoLane instance
    this.p2p = null;                // P2PRoom instance
    this.p2pSignal = null;          // SupabaseRealtime instance used for signalling
    this.p2pTried = false;
    this.p2pOnline = false;
    this.rt = null;                 // SupabaseRealtime instance (data lane)
    this.fetchImpl = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.WebSocketImpl = null;      // injectable for tests
    this.lane = 'offline';          // 'supabase' | 'ws' | 'poll' | 'offline'
    this.degraded = false;
    this.pending = [];              // said before the lane was ready
  }

  get base() { return { id: this.id, name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor }; }

  /** 'host' or 'guest' while a peer-to-peer room is live, '' otherwise. */
  get p2pRole() { return this.p2p?.role || ''; }

  /**
   * A relay someone asked for *by name* (`?relay=…` or `__OUTRUN_RELAY__`).
   * Only an explicit override outranks peer-to-peer: a page merely served by the
   * socket.io server is still allowed to play browser-to-browser first, because
   * that is the lower-latency path and it costs the server nothing.
   */
  get relayOverride() {
    try {
      const fromQuery = new URLSearchParams(location.search).get('relay');
      if (fromQuery) return fromQuery;
    } catch { /* no location */ }
    try { return globalThis.window?.__OUTRUN_RELAY__ || ''; } catch { return ''; }
  }

  start() {
    try {
      this.bc = new BroadcastChannel(`outrun-${this.room}`);
      this.bc.onmessage = (e) => this.consume(e.data);
    } catch { /* unsupported */ }
    // LANE 0: peer-to-peer. The room is found over Supabase and then runs
    // browser-to-browser; the slower lanes stay dark until it has had its
    // chance, because dialling two lanes at once would double every message.
    if (this.connectP2P()) {
      // its own failure path calls fallBackFromP2P()
    } else if (this.connectSocketIo()) {
      // its own failure path calls fallBackFromSocketIo()
    } else if (this.supabase && this.connectSupabase()) {
      // LANE 1 took it
    } else {
      this.connectWS();
    }
    this.hello();
    this.pruneTimer = setInterval(() => this.prune(), 1000);
  }

  /**
   * LANE 0. Peer-to-peer: the player who opens the room is the host.
   *
   * Supabase Realtime carries the handshake (offers, answers, ICE) on its own
   * topic — `p2p-<room>` — so signalling never mixes with the broadcast data
   * lane. Once the data channel is open, Supabase is out of the path entirely.
   */
  connectP2P() {
    if (this.p2pTried || this.p2p) return false;
    if (!this.supabase || !canPeer()) return false;
    // an explicit relay wins: it is the one signal a developer (or a player
    // behind a network that cannot do ICE) has to force a particular server
    if (this.relayOverride) { this.p2pTried = true; return false; }
    this.p2pTried = true;
    try {
      const signaling = new SupabaseRealtime({
        url: this.supabase.url,
        key: this.supabase.key,
        room: `p2p-${this.room}`,               // a topic of its own
        onMessage: (msg) => this.p2p?.handleSignal(msg),
        onStatus: (state, detail) => this.onP2PSignalStatus(state, detail),
      });
      if (!signaling.available) return false;
      this.p2pSignal = signaling;

      this.p2p = new P2PRoom({
        room: this.room,
        selfId: this.id,
        name: this.profile.name,
        profile: this.profile,
        signaling: {
          send: (obj) => signaling.send(obj),
          close: () => signaling.close(),
        },
        onMessage: (msg) => this.consume(msg),
        onPeer: (peer) => { if (peer?.id) this.consume({ t: 'hello', ...peer, ts: Date.now() }); },
        onLeave: (peer) => { if (peer?.id) this.drop(peer.id); },
        onStatus: (state, detail) => this.onP2PStatus(state, detail),
        onHostChange: () => { /* the HUD reads this.p2p.snapshot() */ },
      });

      signaling.connect();
      this.p2p.start();
      this.lane = 'webrtc';
      this.mode = 'online';
      this.onStatus?.('joining', `peer-to-peer · room ${this.room}`);
      return true;
    } catch {
      this.p2p = null;
      this.p2pSignal = null;
      return false;
    }
  }

  /** The transport under peer-to-peer (Supabase) came up or went away. */
  onP2PSignalStatus(state, detail = '') {
    if (!this.alive) return;
    if (state === 'reconnecting' || state === 'unavailable') {
      // the signalling channel never opened: no peer connection is possible
      if (!this.p2pSignal?.everOpened) this.fallBackFromP2P(detail || 'signalling unreachable');
      else this.onStatus?.('reconnecting', detail || 'signalling reconnecting');
      return;
    }
    if (state === 'error') this.fallBackFromP2P(detail || 'signalling refused');
  }

  /** The room itself reported a change: connected, electing, or lost. */
  onP2PStatus(state, detail = '') {
    if (!this.alive) return;
    if (state === 'error') { this.fallBackFromP2P(detail || 'p2p failed'); return; }
    this.lane = 'webrtc';
    this.mode = 'online';
    if (state === 'online') {
      this.onStatus?.('online', detail || `peer-to-peer · room ${this.room}`);
      if (!this.p2pOnline) {
        this.p2pOnline = true;
        this.hello();
        if (this.lastState) this.send({ t: 'state', ...this.lastState });
        this.flushPending();
      }
    } else if (state === 'signalling' || state === 'joining') {
      this.onStatus?.('joining', detail || 'finding the room');
    }
  }

  /**
   * A peer connection could not be made (no WebRTC, signalling refused, the ICE
   * handshake timed out). Tears the lane down and hands over to the next one.
   */
  fallBackFromP2P(why = '') {
    if (!this.p2p && !this.p2pSignal) return;
    try { this.p2p?.close(); } catch { /* gone */ }
    try { this.p2pSignal?.close(); } catch { /* gone */ }
    this.p2p = null;
    this.p2pSignal = null;
    this.p2pOnline = false;
    this.degraded = true;
    if (!this.alive) return;
    if (why) this.onStatus?.('poll', `${why} — using the relay`);
    if (this.connectSocketIo()) return;
    if (this.connectSupabase()) return;
    this.connectWS();
  }

  /**
   * LANE 1. Joins the socket.io server. Returns true when a connection attempt
   * was made; the lane reports its own success or gives up to the next one.
   */
  connectSocketIo() {
    if (!this.relayUrl) return false;
    try {
      this.lane = 'socketio';
      this.onStatus?.('joining', `socket.io server · room ${this.room}`);
      this.sio = new SocketIoLane({
        base: this.relayUrl,
        code: this.room,
        name: this.profile.name,
        mode: this.profile.mode || '100-days',
        onMessage: (msg) => this.consume(msg),
        onPeer: (p) => { if (p?.id) this.consume({ t: 'hello', id: p.id, name: p.name, ts: Date.now() }); },
        onStatus: (state, detail) => {
          if (!this.alive) return;
          if (state === 'online') {
            this.mode = 'online';
            this.onStatus?.('online', detail || 'socket.io server');
            this.hello();
            if (this.lastState) this.send({ t: 'state', ...this.lastState });
            this.flushPending();
          } else if (state === 'joining') {
            this.onStatus?.('joining', detail || 'socket.io server');
          } else if (state === 'error' || state === 'reconnecting') {
            this.onStatus?.('poll', detail || 'socket.io unavailable');
          }
        },
      });
      this.sio.connect().then((ok) => {
        if (ok || !this.alive) return;
        this.fallBackFromSocketIo();
      }).catch(() => this.fallBackFromSocketIo());
      return true;
    } catch {
      this.sio = null;
      this.lane = 'offline';
      return false;
    }
  }

  /** The socket.io host refused or is unreachable: move to the next lane. */
  fallBackFromSocketIo(why = 'socket.io unavailable') {
    if (this.socketIoDead) return;
    this.socketIoDead = true;
    this.degraded = true;
    try { this.sio?.close(); } catch { /* already gone */ }
    this.sio = null;
    this.lane = 'offline';
    this.onStatus?.('poll', why);
    if (this.supabase && this.connectSupabase()) return;
    this.connectWS();
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
    // LANE 0: peer-to-peer, straight to the other browsers
    if (this.p2p) delivered = this.p2p.send(payload);
    // LANE 1: the socket.io server
    if (!delivered && this.sio) delivered = this.sio.send(payload);
    // LANE 2: straight to the Supabase edge
    if (!delivered && this.rt) delivered = this.rt.send(payload);
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
    // Say goodbye *while the lanes are still open*: `send()` refuses once `alive`
    // is false, so closing first meant the bye was never actually delivered and
    // the other players kept a ghost on the map until their prune timer noticed.
    try { this.send({ t: 'bye' }); } catch { /* the lane is already gone */ }
    this.alive = false;
    clearInterval(this.pruneTimer);
    this.stopPolling();
    try { this.bc?.close(); } catch {}
    try { this.p2p?.close(); } catch {}
    try { this.p2pSignal?.close(); } catch {}
    try { this.sio?.close(); } catch {}
    try { this.rt?.close(); } catch {}
    try { this.ws?.close(); } catch {}
  }
}
