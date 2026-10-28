import { uid } from './utils.js';

/**
 * Multiplayer transport with three lanes:
 *  1. WebSocket relay  (npm start / any node host)             -> best, low latency
 *  2. HTTP polling     (/api/room – works on Vercel serverless)
 *  3. BroadcastChannel (same browser, extra tabs – always on)
 * All carry the same JSON envelope, so peers merge cleanly.
 */
export class Net {
  constructor({ room = 'highway-01', profile, onPeer, onLeave, onChat, onEvent, onStatus, onCount }) {
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
  }

  get base() { return { id: this.id, name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor }; }

  start() {
    try {
      this.bc = new BroadcastChannel(`outrun-${this.room}`);
      this.bc.onmessage = (e) => this.consume(e.data);
    } catch { /* unsupported */ }
    this.connectWS();
    this.hello();
    this.pruneTimer = setInterval(() => this.prune(), 1000);
  }

  connectWS() {
    if (!this.alive) return;
    let url;
    try {
      const override = new URLSearchParams(location.search).get('relay');
      if (override) {
        url = `${override}${override.includes('?') ? '&' : '?'}room=${encodeURIComponent(this.room)}`;
      } else {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url = `${proto}//${location.host}/ws?room=${encodeURIComponent(this.room)}`;
      }
    } catch { return; }
    let opened = false;
    try {
      this.ws = new WebSocket(url);
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
    this.onStatus?.('poll', 'Using HTTP relay (best-effort)');
    const tick = async () => {
      if (!this.alive) return;
      const queued = this.outbox.splice(0, 25);
      try {
        const res = await fetch(`/api/room`, {
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
    const payload = { ...msg, id: this.id, name: this.profile.name, color: this.profile.color, carColor: this.profile.carColor, ts: Date.now() };
    if (this.bc) { try { this.bc.postMessage(payload); } catch {} }
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(payload)); } catch {}
    }
    // In polling mode the interval ships the latest state; other messages queue up.
    if (this.pollSend && payload.t !== 'state') {
      this.outbox.push(payload);
      if (this.outbox.length > 40) this.outbox.splice(0, this.outbox.length - 40);
    }
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
        p = { id: msg.id, name: msg.name || 'SURVIVOR', color: msg.color || 0xffb347, carColor: msg.carColor || 0xd24a2b, first: true };
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
    try { this.ws?.close(); } catch {}
  }
}
