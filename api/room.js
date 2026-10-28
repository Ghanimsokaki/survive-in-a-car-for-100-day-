/**
 * Vercel serverless relay (HTTP polling lane).
 * WebSockets are not available on Vercel's serverless runtime, so the client
 * falls back to ~3 Hz polling through this endpoint. State is kept in the
 * warm lambda's module scope, which is enough for casual lobby-sized sessions.
 * For always-on low latency, host server.mjs on a Node box and point the game
 * at it with ?relay=wss://your-relay/ws.
 */
const rooms = globalThis.__outrunRooms || (globalThis.__outrunRooms = new Map());
let seq = 0;

const sanitizeRoom = (r) => String(r || 'highway-01').toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 24) || 'highway-01';

function channel(room) {
  if (!rooms.has(room)) rooms.set(room, { msgs: [] });
  return rooms.get(room);
}

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'POST only' }));
    return;
  }

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body || '{}'); } catch { body = {}; }
  body = body || {};

  const room = sanitizeRoom(body.room);
  const id = String(body.id || 'anon').slice(0, 32);
  const ch = channel(room);

  if (body.msg && typeof body.msg === 'object') {
    ch.msgs.push({ seq: ++seq, ts: Date.now(), id, msg: { ...body.msg, id } });
  }
  if (Array.isArray(body.msgs)) {
    for (const m of body.msgs.slice(0, 30)) {
      if (m && typeof m === 'object') ch.msgs.push({ seq: ++seq, ts: Date.now(), id, msg: { ...m, id } });
    }
  }
  if (ch.msgs.length > 140) ch.msgs.splice(0, ch.msgs.length - 140);

  const cutoff = Date.now() - 9000;
  ch.msgs = ch.msgs.filter((m) => m.ts > cutoff);
  const msgs = ch.msgs.filter((m) => m.id !== id).slice(-70).map((m) => m.msg);

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ msgs, room }));
}
