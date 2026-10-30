/**
 * Vercel serverless relay (HTTP polling lane).
 *
 * WebSockets are not available on the serverless runtime, so the client polls
 * this endpoint ~3 Hz. With Supabase configured the room lives in Postgres
 * (`room_messages`), which is what makes two phones see each other at all: a
 * lambda's module scope is per-instance and dies on every cold start, so the
 * old in-memory version only worked when both players landed on the same warm
 * container. Without credentials it still falls back to that memory store, so a
 * bare clone keeps working offline.
 */
import { createRoomStore } from '../lib/room-store.mjs';

const store = globalThis.__outrunRoomStore
  || (globalThis.__outrunRoomStore = createRoomStore());

export default async function handler(req, res) {
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

  const room = String(body.room || 'highway-01');
  const id = String(body.id || 'anon').slice(0, 32);
  const incoming = [];
  if (body.msg && typeof body.msg === 'object') incoming.push(body.msg);
  if (Array.isArray(body.msgs)) incoming.push(...body.msgs.slice(0, 30));

  if (incoming.length) await store.push(room, id, incoming);
  const out = await store.read(room, id);

  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ msgs: out.msgs, room: out.room, backend: out.backend }));
}
