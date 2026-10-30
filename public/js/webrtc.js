/**
 * P2P ROOM — browser-to-browser play over WebRTC data channels.
 *
 * Topology is a **star**, not a mesh: the host holds one connection per guest
 * and forwards what they send. That is cheap on a phone (one peer connection),
 * gives one authority for hits and world state, and keeps the guest count where
 * the rest of the game expects it (1–8).
 *
 *   Supabase Realtime  →  signalling only (hello / join / offer / answer / ice)
 *   WebRTC data channel →  gameplay (state at 60 FPS, chat, hits, events)
 *
 * The state channel is unreliable and unordered — a dropped position packet is
 * replaced 16 ms later, and retransmitting it would only add latency. Everything
 * that must arrive (chat, hits, joins) rides a reliable ordered channel.
 *
 * Nothing here touches the DOM, and both the signalling transport and the
 * RTCPeerConnection factory are injectable, so the whole room runs headlessly in
 * the test suite (see tests/p2p-e2e.test.mjs).
 */
import {
  CHANNEL, CONTROL_CHANNEL, DEFAULT_ICE, MAX_PEERS, STATE_CHANNEL,
  hostHello, iceSignal, joinRequest, keepsHostship, peerMessage, sdpSignal,
} from './p2p.js';

export class P2PRoom {
  constructor({
    room,
    selfId,
    name = 'SURVIVOR',
    profile = {},
    /** 'host', 'guest', or 'auto' (settle it by election once signalling is up). */
    role = 'auto',
    signaling,
    createPeer = null,
    iceServers = DEFAULT_ICE,
    onMessage = null,
    onPeer = null,
    onLeave = null,
    onStatus = null,
    onHostChange = null,
    now = () => Date.now(),
    helloEvery = 2000,
    joinEvery = 1600,
    electAfter = 700,
    hostTimeout = 9000,
    maxPeers = MAX_PEERS,
  } = {}) {
    this.room = room;
    this.selfId = selfId;
    this.name = String(name || 'SURVIVOR').slice(0, 16).toUpperCase();
    this.profile = profile || {};
    this.signaling = signaling;
    this.createPeer = createPeer || defaultPeerFactory(iceServers);
    this.iceServers = iceServers;
    this.maxPeers = Math.max(2, Math.min(MAX_PEERS, maxPeers));

    this.onMessage = onMessage;
    this.onPeer = onPeer;
    this.onLeave = onLeave;
    this.onStatus = onStatus;
    this.onHostChange = onHostChange;

    this.now = now;
    this.helloEvery = helloEvery;
    this.joinEvery = joinEvery;
    this.electAfter = electAfter;
    this.hostTimeout = hostTimeout;

    this.role = role === 'host' || role === 'guest' ? role : '';
    this.hostId = role === 'host' ? selfId : '';
    this.hostName = role === 'host' ? this.name : '';
    this.players = 1;
    this.day = 1;
    this.mode = '100-days';

    this.peers = new Map();       // peerId → { id, name, color, carColor, pc, state, control, ... }
    this.started = false;
    this.closed = false;
    this.lost = false;
    this.lastHostSeen = 0;
    this.lastHelloSent = 0;
    this.lastJoinSent = 0;
    this.electTimer = null;
    this.helloTimer = null;
    this.watchTimer = null;
    this.pendingState = null;
    this.stats = { sent: 0, received: 0, relayed: 0, dropped: 0, bytes: 0 };
  }

  /* ------------------------------------------------------------- lifecycle */

  /** Starts signalling. Resolves nothing: the room reports itself via onStatus. */
  start() {
    if (this.started || this.closed) return false;
    if (!this.signaling) return false;
    this.started = true;
    this.onStatus?.('signalling', 'finding the room over Supabase');

    if (this.role === 'host') {
      this.announce(true);
    } else if (this.role === 'guest') {
      this.requestJoin(true);
    } else {
      // nobody has announced yet: wait one beat for a host, then claim the room
      this.electTimer = setTimeout(() => {
        if (this.closed || this.role) return;
        this.becomeHost();
      }, this.electAfter);
    }

    this.helloTimer = setInterval(() => this.tick(), this.helloEvery / 2);
    this.watchTimer = setInterval(() => this.watch(), 1000);
    return true;
  }

  /** A periodic beat: host presence, guest join retries, host liveness. */
  tick() {
    if (this.closed) return;
    const at = this.now();
    if (this.role === 'host') {
      if (at - this.lastHelloSent >= this.helloEvery) this.announce();
      return;
    }
    if (this.role === 'guest') {
      // no answer yet? ask again (the host may have been mid-boot)
      if (!this.peers.size && at - this.lastJoinSent >= this.joinEvery) this.requestJoin();
    }
  }

  watch() {
    if (this.closed || this.role !== 'guest' || !this.hostId) return;
    if (this.now() - this.lastHostSeen <= this.hostTimeout) return;
    // the host stopped announcing *and* the channel is down: the room is gone
    const open = [...this.peers.values()].some((p) => p.opened);
    if (open) return;
    this.lost = true;
    this.onStatus?.('error', 'the host left the room');
    this.onHostChange?.(null);
  }

  close() {
    if (this.closed) return;
    // announce first: sendSignal() refuses once `closed` is set, and a guest
    // sitting on a dead host deserves to know immediately
    if (this.role === 'host') this.announceLeave();
    this.closed = true;
    clearTimeout(this.electTimer);
    clearInterval(this.helloTimer);
    clearInterval(this.watchTimer);
    for (const peer of this.peers.values()) this.destroyPeer(peer, 'bye');
    this.peers.clear();
    try { this.signaling?.close?.(); } catch { /* gone */ }
  }

  /* ------------------------------------------------------------------ host */

  becomeHost() {
    if (this.closed || this.role === 'host') return;
    this.role = 'host';
    this.hostId = this.selfId;
    this.hostName = this.name;
    this.onStatus?.('online', `hosting room ${this.room}`);
    this.onHostChange?.({ id: this.selfId, name: this.name, host: true });
    this.announce(true);
  }

  /** Tells the room this code is live, who is in it, and what day it is. */
  announce(force = false) {
    if (this.role !== 'host' || this.closed) return;
    const at = this.now();
    if (!force && at - this.lastHelloSent < this.helloEvery) return;
    this.lastHelloSent = at;
    this.players = this.peers.size + 1;
    this.sendSignal(hostHello({
      room: this.room, from: this.selfId, name: this.name,
      mode: this.mode, players: this.players, day: this.day, max: this.maxPeers,
    }));
  }

  announceLeave() {
    const at = this.now();
    this.lastHelloSent = at;
    this.sendSignal({
      channel: CHANNEL, v: 1, kind: 'hello', room: this.room, from: this.selfId, to: '*',
      ts: at, host: false, name: this.name, closed: true, players: 0,
    });
  }

  /* ----------------------------------------------------------------- guest */

  requestJoin(force = false) {
    if (this.role !== 'guest' || this.closed) return;
    const at = this.now();
    if (!force && at - this.lastJoinSent < this.joinEvery) return;
    this.lastJoinSent = at;
    this.sendSignal(joinRequest({
      room: this.room, from: this.selfId, name: this.name,
      color: this.profile.color, carColor: this.profile.carColor,
    }));
  }

  /* ------------------------------------------------------------- signalling */

  sendSignal(obj) {
    if (this.closed) return;
    try { this.signaling?.send?.(obj); } catch { /* the lane will fall back */ }
  }

  /**
   * Every signalling message from the Supabase topic lands here. Unknown rooms,
   * malformed payloads and our own echo are dropped silently.
   */
  handleSignal(raw) {
    if (this.closed || !raw) return;
    if (raw.channel !== CHANNEL) return;
    if (raw.from === this.selfId) return;               // our own broadcast
    if (raw.room !== this.room) return;

    const kind = raw.kind;

    // 1. Presence: somebody claims to host this room.
    if (kind === 'hello') {
      if (raw.host === false) {                         // the host left
        if (raw.from === this.hostId) this.hostGone();
        return;
      }
      if (!raw.host) return;
      this.lastHostSeen = this.now();
      if (this.role === 'host') {
        // two hosts, one code: the lower id keeps it, the other yields
        if (keepsHostship(this.selfId, raw.from)) return;
        this.yieldHostship(raw);
        return;
      }
      if (this.role !== 'guest') {
        // an election that had not started yet, or a guest waiting to be let in
        clearTimeout(this.electTimer);
        this.role = 'guest';
        this.hostId = raw.from;
        this.hostName = raw.name || 'HOST';
        this.onStatus?.('joining', `host ${this.hostName} · room ${this.room}`);
        this.onHostChange?.({ id: raw.from, name: this.hostName, host: true, players: raw.players, day: raw.day });
        this.requestJoin(true);
        return;
      }
      if (raw.from !== this.hostId) {
        // a different host appeared: two of them both answered us — trust the
        // lower id, which is the same rule the hosts use between themselves
        if (keepsHostship(this.hostId, raw.from)) return;
        this.hostId = raw.from;
        this.hostName = raw.name || 'HOST';
      }
      this.players = raw.players;
      this.day = raw.day;
      this.onHostChange?.({ id: this.hostId, name: this.hostName, host: true, players: raw.players, day: raw.day });
      if (!this.peers.size) this.requestJoin();
      return;
    }

    // 2. A guest wants in — only the host may answer.
    if (kind === 'join') {
      if (this.role !== 'host') return;
      if (this.peers.has(raw.from)) return;
      if (this.peers.size + 1 >= this.maxPeers) {
        this.sendSignal({
          channel: CHANNEL, v: 1, kind: 'leave', room: this.room,
          from: this.selfId, to: raw.from, ts: this.now(), reason: 'room_full',
        });
        return;
      }
      this.openPeer(raw.from, { name: raw.name, color: raw.color, carColor: raw.carColor });
      return;
    }

    // 3. Connection setup.
    if (kind === 'offer') {
      if (raw.to !== '*' && raw.to !== this.selfId) return;
      if (this.role === 'host') return;                 // guests never offer
      this.acceptOffer(raw);
      return;
    }
    if (kind === 'answer') {
      if (this.role !== 'host') return;
      this.acceptAnswer(raw);
      return;
    }
    if (kind === 'ice') {
      if (raw.to !== '*' && raw.to !== this.selfId) return;
      this.acceptIce(raw);
      return;
    }
    if (kind === 'leave') {
      if (raw.to !== '*' && raw.to !== this.selfId) return;
      if (raw.from === this.hostId) this.hostGone();
      return;
    }
  }

  /** Two players claimed the same code: this one stands down and joins instead. */
  yieldHostship(hello) {
    this.role = 'guest';
    this.hostId = hello.from;
    this.hostName = hello.name || 'HOST';
    this.day = hello.day || this.day;
    this.onStatus?.('joining', `host ${this.hostName} · room ${this.room}`);
    this.onHostChange?.({ id: hello.from, name: this.hostName, host: true, players: hello.players, day: hello.day });
    this.requestJoin(true);
  }

  hostGone() {
    if (this.closed) return;
    this.lost = true;
    this.hostId = '';
    this.onStatus?.('error', 'the host left the room');
    this.onHostChange?.(null);
  }

  /* --------------------------------------------------------------- peer I/O */

  /** Host side: opens a connection to one guest and offers. */
  openPeer(peerId, { name = 'SURVIVOR', color = 0xffb347, carColor = 0xd24a2b } = {}) {
    if (this.peers.has(peerId)) return this.peers.get(peerId);
    let pc;
    try {
      pc = this.createPeer();
    } catch {
      this.onStatus?.('error', 'this browser cannot open a peer connection');
      return null;
    }
    const peer = {
      id: peerId, name: String(name || 'SURVIVOR').toUpperCase(), color, carColor,
      pc, state: null, control: null, opened: false, lastSeen: this.now(), host: false,
    };
    this.peers.set(peerId, peer);

    pc.onicecandidate = (ev) => {
      if (ev?.candidate) this.sendSignal(iceSignal({ room: this.room, from: this.selfId, to: peerId, candidate: ev.candidate }));
    };
    pc.onconnectionstatechange = () => this.onStateChange(peer);

    try {
      peer.state = pc.createDataChannel(STATE_CHANNEL, { ordered: false, maxRetransmits: 0 });
      peer.control = pc.createDataChannel(CONTROL_CHANNEL, { ordered: true });
      this.wireChannel(peer, peer.state, 'state');
      this.wireChannel(peer, peer.control, 'control');
    } catch {
      this.destroyPeer(peer, 'channel_failed');
      return null;
    }

    this.makeOffer(pc).then((offer) => {
      if (!offer || this.closed) return;
      this.sendSignal(sdpSignal({ kind: 'offer', room: this.room, from: this.selfId, to: peerId, sdp: offer.sdp }));
    });
    return peer;
  }

  async makeOffer(pc) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      return pc.localDescription || offer;
    } catch {
      return null;
    }
  }

  /** Guest side: an offer addressed to us. */
  acceptOffer(raw) {
    if (!raw.sdp) return;
    const hostId = raw.from;
    this.hostId = hostId;
    this.lastHostSeen = this.now();

    let peer = this.peers.get(hostId);
    if (!peer) {
      let pc;
      try { pc = this.createPeer(); } catch { this.onStatus?.('error', 'this browser cannot open a peer connection'); return; }
      peer = { id: hostId, name: this.hostName || 'HOST', color: 0xffb347, carColor: 0xd24a2b, pc, state: null, control: null, opened: false, lastSeen: this.now(), host: true };
      this.peers.set(hostId, peer);
      pc.onicecandidate = (ev) => {
        if (ev?.candidate) this.sendSignal(iceSignal({ room: this.room, from: this.selfId, to: hostId, candidate: ev.candidate }));
      };
      pc.onconnectionstatechange = () => this.onStateChange(peer);
      pc.ondatachannel = (ev) => {
        const ch = ev?.channel;
        if (!ch) return;
        const kind = ch.label === STATE_CHANNEL ? 'state' : 'control';
        if (kind === 'state') peer.state = ch; else peer.control = ch;
        this.wireChannel(peer, ch, kind);
      };
    }

    (async () => {
      try {
        await peer.pc.setRemoteDescription(raw.sdp);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        const local = peer.pc.localDescription || answer;
        this.sendSignal(sdpSignal({ kind: 'answer', room: this.room, from: this.selfId, to: hostId, sdp: local.sdp }));
      } catch {
        this.destroyPeer(peer, 'answer_failed');
      }
    })();
  }

  acceptAnswer(raw) {
    if (!raw.sdp) return;
    const peer = this.peers.get(raw.from);
    if (!peer) return;
    peer.pc.setRemoteDescription(raw.sdp).catch(() => { /* the channel state reports it */ });
  }

  acceptIce(raw) {
    const peer = this.peers.get(raw.from) || this.peers.values().next().value;
    if (!peer) return;
    const candidate = raw.candidate;
    if (!candidate) return;                              // end-of-candidates
    try { peer.pc.addIceCandidate(candidate).catch(() => {}); } catch { /* stale */ }
  }

  onStateChange(peer) {
    const state = peer?.pc?.connectionState;
    if (state === 'failed' || state === 'closed') {
      this.destroyPeer(peer, 'connection_failed');
    } else if (state === 'connected') {
      peer.lastSeen = this.now();
    }
  }

  /** Wires one data channel for one peer. Messages in either direction. */
  wireChannel(peer, channel, kind) {
    channel.onopen = () => {
      peer.opened = true;
      peer.lastSeen = this.now();
      this.onStatus?.('online', this.role === 'host' ? `hosting room ${this.room}` : `peer-to-peer · room ${this.room}`);
      if (this.role === 'host') {
        // tell the newcomer who they are and hand over what we already know
        this.deliver(peer, { t: 'hello', id: this.selfId, name: this.name, host: true, ...this.profile, ts: this.now() });
        for (const other of this.peers.values()) {
          if (other === peer || !other.opened) continue;
          this.deliver(peer, { t: 'hello', id: other.id, name: other.name, color: other.color, carColor: other.carColor, ts: this.now() });
        }
        if (this.pendingState) this.deliver(peer, this.pendingState);
        this.announce(true);
      } else {
        this.sendToHost({ t: 'hello', id: this.selfId, name: this.name, ...this.profile, ts: this.now() });
        if (this.pendingState) this.sendToHost(this.pendingState);
      }
      this.onPeer?.({
        id: peer.id, name: peer.name, color: peer.color, carColor: peer.carColor,
        host: this.role !== 'host', first: true, state: null, p2p: true,
      });
      if (this.role === 'host') this.players = this.peers.size + 1;
    };

    channel.onmessage = (ev) => {
      peer.lastSeen = this.now();
      this.stats.received += 1;
      this.stats.bytes += typeof ev.data === 'string' ? ev.data.length : 0;
      let raw;
      try { raw = JSON.parse(ev.data); } catch { this.stats.dropped += 1; return; }
      const msg = peerMessage(raw);
      if (!msg) { this.stats.dropped += 1; return; }
      this.receiveFrom(peer, msg);
    };

    channel.onclose = () => { if (peer.opened) this.destroyPeer(peer, 'channel_closed'); };
  }

  /** The host's rule: validate, stamp the real author, forward to everyone else. */
  receiveFrom(peer, msg) {
    if (this.role === 'host') {
      if (msg.t === 'bye') { this.destroyPeer(peer, 'bye'); return; }
      if (msg.t === 'chat' && !msg.text) return;
      const stamped = { ...msg, id: peer.id, name: peer.name, color: peer.color, carColor: peer.carColor, ts: this.now(), viaHost: true };
      if (msg.t === 'state') peer.lastState = stamped;      // `peer.state` is the channel
      this.stats.relayed += 1;
      this.onMessage?.(stamped);
      for (const other of this.peers.values()) {
        if (other === peer || !other.opened) continue;
        this.deliver(other, stamped);
      }
      return;
    }
    // a guest only ever hears from the host; keep it simple and trust that
    this.onMessage?.(msg);
  }

  /* ------------------------------------------------------------------ send */

  /** Gameplay out. Never throws, never queues more than one stale position. */
  send(msg) {
    if (this.closed || !msg) return false;
    const payload = {
      ...msg,
      id: this.selfId,
      name: this.name,
      color: this.profile.color,
      carColor: this.profile.carColor,
      ts: this.now(),
    };
    if (this.role === 'host') {
      if (payload.t === 'state') this.pendingState = payload;
      let sent = false;
      for (const peer of this.peers.values()) {
        if (!peer.opened) continue;
        if (this.deliver(peer, payload)) sent = true;
      }
      return sent;
    }
    if (payload.t === 'state') this.pendingState = payload;
    return this.sendToHost(payload);
  }

  sendToHost(payload) {
    const peer = this.peers.get(this.hostId) || this.peers.values().next().value;
    if (!peer) return false;
    return this.deliver(peer, payload);
  }

  deliver(peer, payload) {
    const channel = payload.t === 'state' ? peer.state : peer.control;
    if (!channel || channel.readyState !== 'open') return false;
    try {
      channel.send(JSON.stringify(payload));
      this.stats.sent += 1;
      return true;
    } catch {
      return false;
    }
  }

  /* --------------------------------------------------------------- teardown */

  destroyPeer(peer, why = 'closed') {
    if (!peer) return;
    this.peers.delete(peer.id);
    try { peer.state?.close?.(); } catch { /* gone */ }
    try { peer.control?.close?.(); } catch { /* gone */ }
    try { peer.pc?.close?.(); } catch { /* gone */ }
    this.onLeave?.({ id: peer.id, name: peer.name, reason: why });
    if (this.role === 'host') {
      this.players = this.peers.size + 1;
      this.announce(true);
    }
  }

  /** Who is here, for the HUD and for /health-style debugging. */
  snapshot() {
    return {
      role: this.role || 'electing',
      host: this.hostId || '',
      hostName: this.hostName || '',
      players: this.peers.size + (this.role === 'host' ? 1 : 1),
      peers: [...this.peers.values()].map((p) => ({
        id: p.id, name: p.name, opened: p.opened, host: Boolean(p.host),
      })),
      stats: { ...this.stats },
    };
  }
}

/** The real thing, or null where WebRTC does not exist (old webviews, tests). */
export function defaultPeerFactory(iceServers = DEFAULT_ICE) {
  return () => {
    const Impl = globalThis.RTCPeerConnection || globalThis.webkitRTCPeerConnection;
    if (!Impl) throw new Error('no RTCPeerConnection');
    return new Impl({ iceServers, iceCandidatePoolSize: 2 });
  };
}

/** True when this browser can actually do P2P. */
export function canPeer(scope = globalThis) {
  return Boolean(scope?.RTCPeerConnection || scope?.webkitRTCPeerConnection);
}
