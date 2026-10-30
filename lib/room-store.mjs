/**
 * ROOM STORE — where the relay keeps its messages.
 *
 * The polling lane used to store the last few seconds of room traffic in module
 * scope. On a laptop that is fine; on Vercel it means two players only see each
 * other if the platform happens to route them to the same warm lambda, and it
 * evaporates on every cold start. So when Supabase credentials are present the
 * server keeps the room in Postgres instead, and every instance shares it.
 *
 * Two backends, one contract:
 *
 *   memory     (no credentials)  in-process, 9 second window, best effort
 *   supabase   (configured)      `public.room_messages`, shared by every instance
 *
 * Both answer the same shape the client already understands:
 *   await store.push(room, authorId, msgs)     // fire and forget
 *   await store.read(room, authorId)           // → { msgs, room, backend, degraded }
 *
 * Nothing here throws: a dead database must never take the relay down.
 */
import { resolveSupabaseConfig } from './supabase-env.mjs';

export const WINDOW_MS = 9000;
export const MAX_ROWS = 140;
export const READ_LIMIT = 70;
const PRUNE_AFTER_MS = 120_000;

export const sanitizeRoom = (r) => String(r || 'highway-01')
  .toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 24) || 'highway-01';

/**
 * In-process fallback: what the relay always did, kept for dev and outages.
 * `rooms` can be shared with a WebSocket relay so the socket lane and the
 * polling lane see the same room (that is how a phone on /ws and a phone on
 * /api/room end up in the same lobby).
 */
function memoryBackend(rooms = globalThis.__outrunRooms || (globalThis.__outrunRooms = new Map())) {
  let seq = 0;
  const channel = (room) => {
    if (!rooms.has(room)) rooms.set(room, { msgs: [] });
    const ch = rooms.get(room);
    if (!Array.isArray(ch.msgs)) ch.msgs = [];
    return ch;
  };
  return {
    kind: 'memory',
    push(room, id, msgs) {
      const ch = channel(room);
      for (const m of msgs) ch.msgs.push({ seq: ++seq, ts: Date.now(), id, msg: { ...m, id } });
      if (ch.msgs.length > MAX_ROWS) ch.msgs.splice(0, ch.msgs.length - MAX_ROWS);
    },
    read(room, id) {
      const ch = channel(room);
      const cutoff = Date.now() - WINDOW_MS;
      ch.msgs = ch.msgs.filter((m) => m.ts > cutoff);
      return ch.msgs.filter((m) => m.id !== id).slice(-READ_LIMIT).map((m) => m.msg);
    },
  };
}

/**
 * PostgREST backend. The anon key is enough: `room_messages` is a deliberately
 * open table (read + insert for everyone, delete only for rows that are already
 * stale), because a lobby code is not a secret and the rows expire in minutes.
 */
function supabaseBackend(cfg, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const base = cfg.url;
  const headers = {
    apikey: cfg.key,
    authorization: `Bearer ${cfg.key}`,
    'content-type': 'application/json',
  };
  const table = `${base}/rest/v1/room_messages`;

  return {
    kind: 'supabase',
    async push(room, id, msgs) {
      const rows = msgs.map((m) => ({ room, author: id, payload: { ...m, id } }));
      const res = await fetchImpl(table, {
        method: 'POST',
        headers: { ...headers, prefer: 'return=minimal' },
        body: JSON.stringify(rows),
      });
      if (!res.ok) throw new Error(`supabase insert ${res.status}`);
      // opportunistic housekeeping: 1 request in 12 sweeps the stale rows
      if (Math.random() < 0.08) {
        const cutoff = new Date(now() - PRUNE_AFTER_MS).toISOString();
        await fetchImpl(`${table}?ts=lt.${encodeURIComponent(cutoff)}`, {
          method: 'DELETE',
          headers: { ...headers, prefer: 'return=minimal' },
        }).catch(() => {});
      }
    },
    async read(room, id) {
      const since = new Date(now() - WINDOW_MS).toISOString();
      const url = `${table}?room=eq.${encodeURIComponent(room)}`
        + `&ts=gte.${encodeURIComponent(since)}`
        + `&author=neq.${encodeURIComponent(id)}`
        + `&select=author,payload,ts&order=ts.asc&limit=${MAX_ROWS}`;
      const res = await fetchImpl(url, { headers });
      if (!res.ok) throw new Error(`supabase select ${res.status}`);
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : [])
        .map((r) => r?.payload)
        .filter((p) => p && typeof p === 'object')
        .slice(-READ_LIMIT);
    },
  };
}

/**
 * Builds the store the relay should use, and remembers the last failure so the
 * health endpoint can say "configured, but the database is not answering".
 */
export function createRoomStore({ env = process.env, fetchImpl = fetch, memoryRooms = null } = {}) {
  const cfg = resolveSupabaseConfig(env);
  const memory = memoryBackend(memoryRooms || undefined);
  const remote = cfg.configured ? supabaseBackend(cfg, { fetchImpl }) : null;
  const health = {
    backend: remote ? 'supabase' : 'memory',
    configured: Boolean(remote),
    lastError: null,
    lastErrorAt: null,
    writes: 0,
    reads: 0,
    fallbacks: 0,
  };

  const note = (err) => {
    health.lastError = String(err?.message || err);
    health.lastErrorAt = new Date().toISOString();
    health.fallbacks += 1;
  };

  const normalise = (list) => (Array.isArray(list) ? list.slice(0, 30).filter((m) => m && typeof m === 'object') : []);

  return {
    health,
    get backend() { return health.backend; },

    async push(room, id, msgs) {
      const clean = normalise(msgs);
      if (!clean.length) return;
      health.writes += 1;
      if (remote) {
        try {
          await remote.push(sanitizeRoom(room), id, clean);
          health.lastError = null;
          return;
        } catch (err) {
          note(err);
        }
      }
      memory.push(sanitizeRoom(room), id, clean);
    },

    async read(room, id) {
      const safeRoom = sanitizeRoom(room);
      health.reads += 1;
      if (remote) {
        try {
          const msgs = await remote.read(safeRoom, id);
          health.lastError = null;
          return { msgs, room: safeRoom, backend: health.backend, degraded: false };
        } catch (err) {
          note(err);
          return { msgs: memory.read(safeRoom, id), room: safeRoom, backend: 'memory', degraded: true };
        }
      }
      return { msgs: memory.read(safeRoom, id), room: safeRoom, backend: 'memory', degraded: false };
    },
  };
}
