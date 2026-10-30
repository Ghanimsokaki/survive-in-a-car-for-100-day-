/**
 * A tiny WebSocket server + a thin Supabase-realtime stand-in, for tests only.
 *
 * The multiplayer lane now talks to Supabase's realtime edge directly, so the
 * only way to prove it works is to put a real socket in front of it. This module
 * speaks just enough RFC 6455 (text frames, ping/pong, close) to let Node's
 * built-in WebSocket client connect, and then behaves like the Supabase edge:
 *
 *   phx_join   → phx_reply { status: 'ok' }
 *   broadcast  → the same frame, fanned out to the *other* sockets on the topic
 *   heartbeat  → phx_reply
 *   phx_leave  → phx_reply
 *
 * No dependencies: the frame codec and the handshake are implemented here.
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Encodes one text frame (server → client, unmasked). */
export function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * Pulls complete frames out of a buffer. Returns the decoded frames and the
 * remaining bytes (a frame may arrive split across TCP reads).
 */
export function decodeFrames(buffer) {
  const frames = [];
  let buf = buffer;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) break;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) break;
      len = Number(buf.readBigUInt64BE(offset));
      offset += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) break;
    const mask = masked ? buf.subarray(offset, offset + 4) : null;
    offset += maskLen;
    const data = Buffer.from(buf.subarray(offset, offset + len));
    if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
    frames.push({ opcode, text: data.toString('utf8'), payload: data });
    buf = buf.subarray(offset + len);
  }
  return { frames, rest: buf };
}

/**
 * Starts the stand-in edge. Resolves to `{ url, port, close, rooms, seen }`.
 * `url` is an `http://127.0.0.1:PORT` base, exactly what a real project URL
 * looks like to `realtimeSocketUrl()`.
 */
export async function startEdge({ path = '/realtime/v1/websocket' } = {}) {
  const rooms = new Map();          // topic → Set<socket>
  const seen = [];                  // every frame the server received
  const server = createServer((req, res) => { res.statusCode = 404; res.end(); });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'));

    const peer = {
      socket,
      topic: null,
      send(obj) { try { socket.write(encodeFrame(JSON.stringify(obj))); } catch { /* gone */ } },
    };
    let buffer = Buffer.alloc(0);

    const leave = () => {
      if (!peer.topic) return;
      const set = rooms.get(peer.topic);
      if (set) { set.delete(peer); if (!set.size) rooms.delete(peer.topic); }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) { leave(); try { socket.end(); } catch { /* gone */ } return; }
        if (frame.opcode === 0x9) { try { socket.write(encodeFrame(frame.text, 0xA)); } catch { /* gone */ } continue; }
        if (frame.opcode !== 0x1) continue;
        let msg;
        try { msg = JSON.parse(frame.text); } catch { continue; }
        seen.push(msg);
        handleFrame(peer, msg);
      }
    });
    socket.on('close', leave);
    socket.on('error', leave);

    function handleFrame(self, msg) {
      switch (msg.event) {
        case 'phx_join': {
          self.topic = msg.topic;
          if (!rooms.has(msg.topic)) rooms.set(msg.topic, new Set());
          rooms.get(msg.topic).add(self);
          self.send({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok', response: {} } });
          break;
        }
        case 'heartbeat':
          self.send({ topic: 'phoenix', event: 'phx_reply', ref: msg.ref, payload: { status: 'ok' } });
          break;
        case 'broadcast': {
          const set = rooms.get(msg.topic) || new Set();
          for (const other of set) {
            if (other === self) continue;      // broadcast.self = false
            other.send({
              topic: msg.topic,
              event: 'broadcast',
              payload: { type: 'broadcast', event: msg.payload?.event, payload: msg.payload?.payload },
            });
          }
          break;
        }
        case 'phx_leave':
          leave();
          self.send({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, payload: { status: 'ok' } });
          break;
        default:
          break;
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    path,
    rooms,
    seen,
    async close() {
      for (const set of rooms.values()) for (const peer of set) { try { peer.socket.destroy(); } catch { /* gone */ } }
      rooms.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
