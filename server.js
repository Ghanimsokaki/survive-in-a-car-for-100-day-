/**
 * GEMBY GAMES — real-time game server (Express + Socket.IO)
 *
 * This is the dedicated multiplayer host: lobby rooms of 1–8, matchmaking codes,
 * and fast vehicle telemetry relayed at up to 15 Hz per player. It is a
 * different process from `server.mjs` (which stays as the zero-dependency static
 * + Vercel-compatible relay); this one is what you deploy to Railway, Render,
 * Fly, a VPS or any container host that keeps a socket open.
 *
 *   npm install && npm start        →  http://0.0.0.0:${PORT:-8080}
 *
 * On Render the service keeps itself awake: every ten minutes the process GETs
 * its own public URL (`RENDER_EXTERNAL_URL`, which Render sets for you) with
 * node's native https client — see `lib/keepalive.mjs` and `/health`.`keepalive`.
 *
 * Endpoints
 *   GET  /health                    liveness + room/player counts + CORS mode
 *   GET  /api/rooms                 a public summary of live rooms (no ids)
 *   GET  /api/config, /config.json  Supabase credentials + realtime hints for the page
 *   GET  /socket.io/socket.io.js    the client library for the browser
 *   *                               the built game (dist/ if present, else public/)
 *
 * Socket API (all requests take an ack callback: {ok:true,…} | {ok:false,error})
 *   emit  room:create  {name, mode}     → room:joined
 *   emit  room:join    {code, name}     → room:joined
 *   emit  room:quick   {name, mode}     → room:joined
 *   emit  room:sync                     → room:state
 *   emit  room:leave                    → room:left
 *   emit  msg          envelope         → relayed as `msg` to the rest of the room
 *   on    room:joined  {code, you, room}
 *   on    room:state   snapshot
 *   on    player:joined / player:left / msg / room:closed
 *   on    error:msg    {code, message}
 */
import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

import express from 'express';
import { Server as SocketServer } from 'socket.io';

import {
  Lobby, LobbyError, MAX_PLAYERS, STALE_MS, normaliseCode, sanitiseChat,
} from './lib/lobby.mjs';
import { createCorsPolicy, socketIoCors } from './lib/cors-policy.mjs';
import { publicConfig } from './lib/supabase-env.mjs';
import { startKeepAlive } from './lib/keepalive.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Port: honour the host's PORT (Render injects one), default to 8080. */
const PORT = process.env.PORT || 8080;
/** Bind every interface so Render's proxy can route player traffic in. */
const HOST = '0.0.0.0';

// tiny .env loader so `npm start` picks up ALLOWED_ORIGINS / SUPABASE_URL
try {
  const raw = await readFile(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env — fine */ }

const VERSION = (() => {
  try {
    const raw = readFileSync(path.join(__dirname, 'package.json'), 'utf8');
    return JSON.parse(raw).version || '0.0.0';
  } catch { return '0.0.0'; }
})();

const corsPolicy = createCorsPolicy();
/** Declared before the routes, started after `listen` — see the bottom of the file. */
let keepAlive = { state: () => ({ enabled: false }), stop() {} };
const lobby = new Lobby({ maxPlayers: MAX_PLAYERS });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* ------------------------------------------------------------------ CORS ---
 * OPEN by default: any front-end may call the API and open a socket, which is
 * what a game relay wants — there are no cookies here and no secrets behind it.
 * Set ALLOWED_ORIGINS (or CORS=strict) to lock it down; the same predicate is
 * used by every HTTP route and by the socket handshake, so the browser can
 * never be told one thing by /health and another by the WebSocket upgrade.
 */
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (corsPolicy.allowed(origin)) {
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization,x-requested-with');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  next();
});

app.use(express.json({ limit: '32kb' }));

/* ---------------------------------------------------------------- routes --- */
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    service: 'gemby-games-realtime',
    version: VERSION,
    engine: 'socket.io',
    uptimeSeconds: Math.round(process.uptime()),
    rooms: lobby.stats().rooms,
    players: lobby.stats().players,
    maxPlayersPerRoom: MAX_PLAYERS,
    realtime: { engine: 'socket.io', path: '/socket.io' },
    supabase: { configured: publicConfig(process.env).configured },
    keepalive: keepAlive.state(),
    cors: { open: corsPolicy.open, mode: corsPolicy.mode, origins: corsPolicy.origins },
  });
});

app.get('/api/rooms', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rooms = [...lobby.rooms.values()]
    .map((r) => ({ code: r.code, mode: r.mode, players: r.players.size, max: MAX_PLAYERS }))
    .sort((a, b) => b.players - a.players);
  res.json({ counts: lobby.stats(), rooms });
});

/**
 * The same credentials payload `api/config.js` and `server.mjs` serve, so a
 * deployment on this server finds Supabase exactly the way it would on Vercel:
 * `/api/config` → `/config.json` → the inline build config.
 */
function siteConfig() {
  return {
    ...publicConfig(process.env, 'node-socket.io'),
    websocket: true,
    socketio: true,
    realtime: { engine: 'socket.io', path: '/socket.io' },
  };
}

for (const route of ['/api/config', '/config.json']) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json(siteConfig());
  });
}

// The built game, if `npm run build` has been run; the source tree otherwise.
const DIST = path.join(__dirname, 'dist');
const PUBLIC = path.join(__dirname, 'public');
const SITE = existsSync(path.join(DIST, 'index.html')) ? DIST : PUBLIC;

app.use(express.static(SITE, {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, file) {
    if (/\/vendor\/|\.woff2?$|\.png$|\.jpg$|\.svg$/.test(file)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    } else if (/\.js$|\.css$/.test(file)) {
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
    }
  },
}));

// A single-page app: unknown paths get the shell, unless they look like a file.
// (Written as a plain middleware so it behaves the same on express 4 and 5.)
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (/^\/(api|socket\.io)(\/|$)/.test(req.path)) return next();
  if (/\.[a-z0-9]{2,5}$/i.test(req.path)) return next();
  res.sendFile(path.join(SITE, 'index.html'));
});

app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

/* ---------------------------------------------------------------- socket --- */
const server = http.createServer(app);
const io = new SocketServer(server, {
  path: '/socket.io',
  cors: socketIoCors(corsPolicy),
  // mobile-friendly limits: a phone that backgrounds must survive a moment
  pingInterval: 20_000,
  pingTimeout: 25_000,
  maxHttpBufferSize: 32 * 1024,     // telemetry is tiny; refuse blobs
  transports: ['websocket', 'polling'],
  connectionStateRecovery: {
    maxDisconnectionDuration: 45_000,
    skipMiddlewares: true,
  },
});

/** The ack contract every request uses: never throw, always answer. */
const reply = (ack, payload) => { if (typeof ack === 'function') { try { ack(payload); } catch { /* gone */ } } };

const fail = (socket, ack, err) => {
  const code = err instanceof LobbyError ? err.code : 'server_error';
  const message = err instanceof LobbyError ? err.message : 'The server could not do that.';
  if (!(err instanceof LobbyError)) console.error('[socket]', err);
  reply(ack, { ok: false, error: { code, message } });
  if (code === 'server_error') socket.emit('error:msg', { code, message });
};

/** Everyone in a room except one player. */
function broadcast(code, event, payload, exceptId = null) {
  const room = lobby.room(code);
  if (!room) return;
  for (const id of room.players.keys()) {
    if (id === exceptId) continue;
    io.to(id).emit(event, payload);
  }
}

function joinRoom(socket, result, ack, { reconnected = false } = {}) {
  const { room, player } = result;

  // A phone that reconnects without session recovery arrives with a new socket
  // id. If the old seat is dead, hand it over instead of leaving a ghost car.
  if (player.clientId) {
    for (const ghost of lobby.ghosts(room.code, player.clientId, player.id)) {
      if (io.sockets.sockets.has(ghost.id)) continue;      // two live tabs: leave them be
      lobby.leave(ghost.id);
      broadcast(room.code, 'player:left', { id: ghost.id, name: ghost.name, reason: 'reconnected' });
      console.log(`[room ${room.code}] reclaimed the seat of ${ghost.name}`);
    }
  }

  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.name = player.name;

  // tell the room first, so the joiner's snapshot already contains everyone.
  // A returning player (session recovery, or a re-join) is not an arrival.
  if (!reconnected) {
    broadcast(room.code, 'player:joined', {
      id: player.id, name: player.name, joinedAt: player.joinedAt,
    }, player.id);
  }

  const payload = {
    ok: true,
    code: room.code,
    you: { id: player.id, name: player.name },
    reconnected,
    room: lobby.snapshot(room.code),
  };
  reply(ack, payload);
  socket.emit('room:joined', payload);
  io.to(room.code).emit('room:state', lobby.snapshot(room.code));
  console.log(`[room ${room.code}] ${player.name} ${reconnected ? 'reconnected' : 'joined'} (${room.players.size}/${MAX_PLAYERS})`);
  return payload;
}

io.on('connection', (socket) => {
  socket.data.connectedAt = Date.now();

  socket.on('room:create', ({ name, mode, clientId } = {}, ack) => {
    try { joinRoom(socket, lobby.create({ id: socket.id, name, mode, clientId }), ack); }
    catch (err) { fail(socket, ack, err); }
  });

  socket.on('room:join', ({ code, name, clientId } = {}, ack) => {
    try {
      const result = lobby.join({ id: socket.id, code, name, clientId });
      joinRoom(socket, result, ack, { reconnected: Boolean(result.reconnected) });
    } catch (err) { fail(socket, ack, err); }
  });

  socket.on('room:quick', ({ name, mode, clientId } = {}, ack) => {
    try {
      const result = lobby.quickMatch({ id: socket.id, name, mode, clientId });
      joinRoom(socket, result, ack, { reconnected: Boolean(result.reconnected) });
    } catch (err) { fail(socket, ack, err); }
  });

  socket.on('room:sync', (_payload, ack) => {
    const code = socket.data.code;
    const snap = code ? lobby.snapshot(code) : null;
    if (!snap) { reply(ack, { ok: false, error: { code: 'not_in_room', message: 'Join a room first.' } }); return; }
    reply(ack, { ok: true, room: snap });
    socket.emit('room:state', snap);
  });

  socket.on('room:leave', (_payload, ack) => {
    const code = socket.data.code;
    if (!code) { reply(ack, { ok: true, left: false }); return; }
    socket.leave(code);
    socket.data.code = null;
    const gone = lobby.leave(socket.id);
    broadcast(code, 'player:left', { id: socket.id, name: socket.data.name || 'SURVIVOR' });
    if (gone.closed) broadcast(code, 'room:closed', { code });
    else io.to(code).emit('room:state', lobby.snapshot(code));
    reply(ack, { ok: true, left: true, code });
  });

  /**
   * THE FAST PATH. One envelope in, one envelope out to the rest of the room.
   * Position updates are validated and rate-limited by the lobby; chat and world
   * events are relayed with the sender stamped on by the server, never by the
   * client, so nobody can impersonate anybody.
   */
  socket.on('msg', (payload, ack) => {
    try {
      const code = socket.data.code;
      if (!code) throw new LobbyError('not_in_room', 'Join a room first.');
      if (!payload || typeof payload !== 'object') throw new LobbyError('bad_msg', 'Malformed message.');

      const kind = String(payload.t || '').slice(0, 12);
      const room = lobby.room(code);
      const player = room?.players.get(socket.id);
      if (!player) throw new LobbyError('not_in_room', 'Join a room first.');

      if (kind === 'state') {
        const out = lobby.state(socket.id, payload);
        if (!out.ok) { reply(ack, { ok: true, throttled: true }); return; }
        const msg = { t: 'state', id: player.id, name: player.name, ...out.state };
        broadcast(code, 'msg', msg, player.id);
        reply(ack, { ok: true });
        return;
      }

      if (kind === 'chat') {
        const out = lobby.chat(socket.id, payload.text);
        if (!out.ok) {
          reply(ack, { ok: false, error: { code: out.reason === 'rate' ? 'rate_limited' : 'empty_message', message: out.reason === 'rate' ? 'Slow down a little.' : 'Say something first.' } });
          return;
        }
        broadcast(code, 'msg', { t: 'chat', id: player.id, name: player.name, text: out.text, ts: Date.now() }, player.id);
        reply(ack, { ok: true });
        return;
      }

      if (kind === 'event') {
        broadcast(code, 'msg', {
          t: 'event',
          id: player.id,
          name: player.name,
          kind: String(payload.kind || '').slice(0, 24),
          ts: Date.now(),
        }, player.id);
        reply(ack, { ok: true });
        return;
      }

      if (kind === 'hello' || kind === 'bye') {
        broadcast(code, 'msg', { t: kind, id: player.id, name: player.name, ts: Date.now() }, player.id);
        reply(ack, { ok: true });
        return;
      }

      throw new LobbyError('bad_msg', 'Unknown message type.');
    } catch (err) { fail(socket, ack, err); }
  });

  /**
   * A drop is NOT a departure. Phones lock their screens, tunnels eat packets,
   * and socket.io's connection-state-recovery can hand the same session back —
   * so the seat is held for STALE_MS and `pruneTimer` releases it if the player
   * never returns. A deliberate exit goes through `room:leave`, immediately.
   */
  socket.on('disconnect', (reason) => {
    const code = socket.data.code;
    const name = socket.data.name || 'SURVIVOR';
    if (!code) return;
    lobby.gone(socket.id);
    console.log(`[room ${code}] ${name} dropped (${reason || 'gone'}) — seat held for ${Math.round(STALE_MS / 1000)}s`);
  });

  socket.on('error', (err) => {
    console.warn('[socket error]', socket.id, err?.message || err);
  });
});

/* ------------------------------------------------------------- housekeeping */
const pruneTimer = setInterval(() => {
  // a player is only released when their socket is really gone: a live player
  // standing still on the map screen sends no telemetry and must not be dropped
  const { evicted } = lobby.prune({ alive: (id) => io.sockets.sockets.has(id) });
  for (const player of evicted) {
    io.to(player.id).emit('room:evicted', { reason: 'timed_out' });
    broadcast(player.code, 'player:left', { id: player.id, name: player.name, reason: 'timed_out' });
    const snap = lobby.snapshot(player.code);
    if (snap) io.to(player.code).emit('room:state', snap);
  }
}, 2000);
pruneTimer.unref?.();

/* ----------------------------------------------------------------- listen */
server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  GEMBY GAMES — realtime server (socket.io)');
  console.log(`  → listening on http://${HOST}:${PORT}`);
  console.log(`  → rooms: 1–${MAX_PLAYERS} players · telemetry up to 15 Hz`);
  console.log(`  → CORS: ${corsPolicy.open ? 'OPEN — any front-end' : `${corsPolicy.mode}: ${corsPolicy.origins.join(', ')}`}`);
  console.log(`  → static: ${path.relative(__dirname, SITE) || '.'}`);

  /* ---------------------------------------------------------- keep-alive ---
   * Free hosts sleep after ~15 idle minutes; a 10-minute GET to our own public
   * URL counts as traffic and keeps this container awake. Render sets
   * RENDER_EXTERNAL_URL, so on Render this needs no configuration at all; with
   * no URL it logs one line and does nothing. KEEPALIVE=0 turns it off.
   */
  keepAlive = startKeepAlive();
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[fatal] port ${PORT} is already in use`);
    process.exit(1);
  }
  console.error('[server error]', err);
});

/** Leave the room politely before the process goes away. */
function shutdown(signal) {
  console.log(`\n[${signal}] closing the realtime server…`);
  clearInterval(pruneTimer);
  keepAlive.stop();
  io.emit('server:closing', { reason: signal });
  io.close(() => {
    server.close(() => {
      console.log('[shutdown] done');
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { app, server, io, lobby, corsPolicy, normaliseCode, sanitiseChat };
