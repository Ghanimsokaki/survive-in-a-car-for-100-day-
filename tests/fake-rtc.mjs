/**
 * A fake `RTCPeerConnection` that genuinely pairs up.
 *
 * Node has no WebRTC, so every P2P test would otherwise stop at "the object was
 * constructed". This one does the parts that matter: it mints offers/answers
 * with a token in the SDP, so two endpoints can find each other in a shared
 * registry, mirrors the data channels onto the other side exactly once, opens
 * them, and then delivers `send()` payloads asynchronously like a real network
 * would. Channels remember their `label`, `ordered` and `readyState`, which is
 * all `webrtc.js` looks at.
 *
 * `createNetwork()` gives each test its own isolated registry, so two suites in
 * one process cannot pair with each other's endpoints by accident.
 */
export function createNetwork({ connectDelay = 5, channelDelay = 0 } = {}) {
  let counter = 0;
  const registry = new Map();          // pc id → FakePeerConnection
  const connections = [];              // every connection this network minted
  let offerRefused = 0;                // how many offers the far side rejected

  class FakeChannel {
    constructor(label, { ordered = true } = {}) {
      this.label = label;
      this.ordered = ordered;
      this.readyState = 'connecting';
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.peer = null;                // the mirrored channel on the other side
      this.sent = [];
    }

    send(data) {
      if (this.readyState !== 'open') throw new Error('channel is not open');
      this.sent.push(data);
      const other = this.peer;
      if (!other || other.readyState !== 'open') return;
      setTimeout(() => other.onmessage?.({ data }), channelDelay);
    }

    close() {
      if (this.readyState === 'closed') return;
      this.readyState = 'closed';
      setTimeout(() => this.onclose?.({}), channelDelay);
    }

    open() {
      if (this.readyState === 'open') return;
      this.readyState = 'open';
      setTimeout(() => this.onopen?.({}), channelDelay);
    }
  }

  class FakePeerConnection {
    constructor(config = {}) {
      counter += 1;
      this.id = `pc${counter}`;
      this.config = config;
      registry.set(this.id, this);
      connections.push(this);
      this.localDescription = null;
      this.remoteDescription = null;
      this.connectionState = 'new';
      this.onicecandidate = null;
      this.ondatachannel = null;
      this.onconnectionstatechange = null;
      this.channels = [];
      this.iceSeen = [];
    }

    createDataChannel(label, opts = {}) {
      const channel = new FakeChannel(label, opts);
      this.channels.push(channel);
      return channel;
    }

    async createOffer() { return { type: 'offer', sdp: `v=0\noffer ${this.id}\n` }; }

    async createAnswer() {
      const token = String(this.remoteDescription?.sdp || '').match(/offer (\S+)/)?.[1] || '';
      if (!registry.has(token)) offerRefused += 1;
      return { type: 'answer', sdp: `v=0\nanswer ${token}\n` };
    }

    async setLocalDescription(desc) {
      this.localDescription = { type: desc.type, sdp: desc.sdp };
      this.connectionState = this.connectionState === 'new' ? 'connecting' : this.connectionState;
      // The guest knows who offered: the offer is in its remote description, so
      // this is where the two endpoints meet — as they would on the wire.
      if (desc.type === 'answer') {
        const token = String(this.remoteDescription?.sdp || '').match(/offer (\S+)/)?.[1] || '';
        const offerer = registry.get(token);
        if (offerer && offerer !== this) pair(offerer, this);
      }
      // A real stack emits candidates as it gathers; one is enough to prove the path.
      setTimeout(() => this.onicecandidate?.({
        candidate: { candidate: `candidate ${this.id}`, sdpMid: '0', sdpMLineIndex: 0 },
      }), 0);
    }

    async setRemoteDescription(desc) {
      this.remoteDescription = { type: desc.type, sdp: desc.sdp };
    }

    async addIceCandidate(candidate) { this.iceSeen.push(candidate); }

    /** The far end vanished: the connection fails, channels close. */
    drop() {
      this.connectionState = 'failed';
      this.onconnectionstatechange?.({});
      for (const ch of this.channels) ch.close();
    }

    close() {
      if (this.connectionState === 'closed') return;
      this.connectionState = 'closed';
      this.onconnectionstatechange?.({});
      for (const ch of this.channels) ch.close();
    }
  }

  /** Wires the host's channels to the guest's, then opens both ends. */
  function pair(hostPc, guestPc) {
    if (hostPc.connectionState === 'connected' || guestPc.connectionState === 'connected') return;
    for (const channel of hostPc.channels) {
      const mirror = new FakeChannel(channel.label, { ordered: channel.ordered });
      mirror.peer = channel;
      channel.peer = mirror;
      guestPc.channels.push(mirror);
      setTimeout(() => guestPc.ondatachannel?.({ channel: mirror }), channelDelay);
    }
    hostPc.connectionState = 'connected';
    guestPc.connectionState = 'connected';
    setTimeout(() => {
      for (const channel of hostPc.channels) {
        channel.open();
        channel.peer?.open();
      }
      hostPc.onconnectionstatechange?.({});
      guestPc.onconnectionstatechange?.({});
    }, connectDelay);
  }

  return {
    RTCPeerConnection: FakePeerConnection,
    registry,
    connections,
    get refusedOffers() { return offerRefused; },
    /** Everything sent on the wire, for asserting what actually crossed. */
    frames() {
      return connections.flatMap((pc) => pc.channels.flatMap((ch) => ch.sent));
    },
  };
}
