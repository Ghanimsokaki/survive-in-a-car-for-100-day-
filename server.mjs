/**
 * 100 Days Outrun — local game server.
 *  · serves ./public
 *  · /api/room   ← HTTP polling relay (same contract as the Vercel function)
 *  · /api/health ← relay probe
 *  · /ws         ← zero-dependency WebSocket relay for low-latency play
 *
 * Run: npm start   (opens on http://localhost:8000)
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { publicConfig, resolveSupabaseConfig } from './lib/supabase-env.mjs';
import { bearerToken, handleAdminRequest } from './lib/admin-auth.mjs';
import { createRoomStore, sanitizeRoom } from './lib/room-store.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// tiny .env loader so `npm start` picks up SUPABASE_URL / SUPABASE_ANON_KEY
try {
  const raw = await readFile(path.join(__dirname, '.env'), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* no .env — fine */ }
const PUBLIC = path.join(__dirname, 'public');
const GAMES = path.join(__dirname, 'games');   // community games, PR'd into the repo
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

// ---------------------------------------------------------------- rooms
// One room map for both lanes: the WebSocket relay fans out through it directly,
// the HTTP lane goes through the store (Supabase when configured, and this same
// map as its fallback) — so a socket player and a polling player share a room.
const rooms = new Map();
const roomStore = createRoomStore({ memoryRooms: rooms });
let seq = 0;

function roomChannel(room) {
  // the room may already exist because the HTTP lane (through the store) made
  // it, in which case it has messages but no socket set yet
  if (!rooms.has(room)) rooms.set(room, { msgs: [], sockets: new Set() });
  const ch = rooms.get(room);
  if (!Array.isArray(ch.msgs)) ch.msgs = [];
  if (!ch.sockets) ch.sockets = new Set();
  return ch;
}
function pushMsg(room, id, msg) {
  const ch = roomChannel(room);
  const entry = { seq: ++seq, ts: Date.now(), id, msg };
  ch.msgs.push(entry);
  if (ch.msgs.length > 120) ch.msgs.splice(0, ch.msgs.length - 120);
  return entry;
}

// ---------------------------------------------------------------- websocket
function wsFrame(payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsHandleBuffer(socket, state, chunk, onText, onClose) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    const b = state.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2); off = 4;
    } else if (len === 127) {
      if (b.length < 10) return;
      len = Number(b.readBigUInt64BE(2)); off = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (b.length < off + maskLen + len) return;
    let payload = b.subarray(off + maskLen, off + maskLen + len);
    if (masked) {
      const mask = b.subarray(off, off + 4);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    state.buf = b.subarray(off + maskLen + len);
    if (opcode === 0x8) { onClose(); return; }
    if (opcode === 0x9) { try { socket.write(Buffer.from([0x8a, 0])); } catch {} continue; }
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
}


// ------------------------------------------------------- compression + cache
/**
 * Everything this game ships is text (JS, CSS, JSON, SVG), and three.js alone is
 * ~690 KB uncompressed. Compressing it once and keeping the result keyed by
 * mtime takes the first load from "wait a while" to "there it is", especially on
 * mobile: the 690 KB module drops to roughly 160 KB.
 */
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.map', '.txt']);
const compressed = new Map();                 // filePath -> { mtimeMs, size, gzip, br }
const COMPRESS_CACHE_LIMIT = 120;

function cachePolicy(pathname) {
  // vendored third-party code never changes inside a deploy
  if (pathname.startsWith('/vendor/')) return 'public, max-age=31536000, immutable';
  // the game modules and styles are cheap to revalidate but expensive to refetch
  if (pathname.startsWith('/js/') || pathname === '/styles.css') {
    // short: index.html is no-store, so a long window here lets a stale module
    // meet a fresh page after a deploy. The ETag makes revalidation a 304.
    return 'public, max-age=60, stale-while-revalidate=600';
  }
  if (pathname.startsWith('/games/')) return 'public, max-age=300, stale-while-revalidate=3600';
  return 'public, max-age=60';
}

function compress(filePath, data, ext, info) {
  if (!COMPRESSIBLE.has(ext) || data.length < 1024) return null;
  const stamp = info.mtimeMs || 0;
  const hit = compressed.get(filePath);
  if (hit && hit.mtimeMs === stamp && hit.size === data.length) return hit;
  let gzip = null;
  let br = null;
  try { gzip = gzipSync(data, { level: 6 }); } catch { gzip = null; }
  try { br = brotliCompressSync(data, { params: { 1: 4 } }); } catch { br = null; }
  const entry = { mtimeMs: stamp, size: data.length, gzip, br };
  if (compressed.size > COMPRESS_CACHE_LIMIT) compressed.clear();
  compressed.set(filePath, entry);
  return entry;
}

/**
 * Supabase, asked from the server rather than the browser: is the project the
 * deployment was handed actually reachable? Cached so /api/health stays cheap.
 */
let supabaseProbe = { at: 0, value: null };
async function supabaseStatus({ deep = false, ttl = 60_000 } = {}) {
  const cfg = resolveSupabaseConfig(process.env);
  const base = {
    configured: Boolean(cfg.configured),
    url: cfg.url || null,
    urlVar: cfg.urlVar || null,
    keyVar: cfg.keyVar || null,
    problems: cfg.problems || [],
  };
  if (!base.configured) return { ...base, reachable: false, checkedAt: null };
  if (!deep) return { ...base, reachable: null };
  if (supabaseProbe.value && Date.now() - supabaseProbe.at < ttl) return supabaseProbe.value;
  let reachable = false;
  let status = 0;
  try {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 1800) : null;
    const res = await fetch(`${base.url}/auth/v1/health`, {
      headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}` },
      signal: controller?.signal,
    });
    status = res.status;
    reachable = res.ok;
    if (timer) clearTimeout(timer);
  } catch { reachable = false; }
  const value = { ...base, reachable, status, checkedAt: new Date().toISOString() };
  supabaseProbe = { at: Date.now(), value };
  return value;
}

const server = createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    pathname = '/';
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (pathname === '/api/config') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...publicConfig(process.env, 'node-websocket'), websocket: true }));
    return;
  }

  // same payload as a static file, so the client's fallback chain works in dev too
  if (pathname === '/config.json') {
    const cfg = { ...publicConfig(process.env, 'node-websocket'), websocket: true };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(cfg, null, 2));
    return;
  }

  if (pathname === '/api/admin') {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const action = (url.searchParams.get('action') || 'verify').toLowerCase();
    const token = bearerToken(req);
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 4000) req.destroy(); });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      let out;
      try {
        out = await handleAdminRequest({ method: req.method || 'GET', token, action, body, env: process.env });
      } catch (err) {
        out = { status: 500, body: { ok: false, reason: String(err && err.message || err) } };
      }
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out.body));
    });
    return;
  }

  if (pathname === '/api/health') {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('deep') === 'true';
    const supabase = await supabaseStatus({ deep });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      mode: 'node-websocket',
      rooms: rooms.size,
      uptime: Math.round(process.uptime()),
      supabase,
      relay: { backend: roomStore.health.backend, ...roomStore.health },
    }));
    return;
  }

  if (pathname === '/api/room') {
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'POST only' }));
      return;
    }
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 64000) req.destroy(); });
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const room = sanitizeRoom(body.room);
        const id = String(body.id || 'anon').slice(0, 32);
        const incoming = [];
        if (body.msg && typeof body.msg === 'object') incoming.push({ ...body.msg, id });
        if (Array.isArray(body.msgs)) {
          for (const m of body.msgs.slice(0, 30)) if (m && typeof m === 'object') incoming.push({ ...m, id });
        }
        // With Supabase configured this is shared across every instance of the
        // relay (and across serverless invocations on Vercel); without it, it is
        // the local map the WebSocket lane uses too.
        if (incoming.length) await roomStore.push(room, id, incoming);
        const out = await roomStore.read(room, id);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ msgs: out.msgs, backend: out.backend }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ msgs: [] }));
      }
    });
    return;
  }

  // ------------------------------------------------ static files
  // /games/* lives outside ./public so contributors add a folder, not a build
  // step. Everything else is served straight out of ./public.
  const isGamePath = pathname === '/games' || pathname.startsWith('/games/');
  const rootDir = isGamePath ? GAMES : PUBLIC;
  let rel = isGamePath
    ? pathname.replace(/^\/games\/?/, '')
    : (pathname === '/' ? '/index.html' : pathname);
  if (isGamePath && (rel === '' || rel === '/')) rel = 'index.json';
  // `_`-prefixed game folders are developer space (parked samples, templates).
  // They are not in the catalogue; don't serve them either. `_shared` is the
  // SDK every community game loads, so it stays reachable.
  if (isGamePath) {
    const first = rel.replace(/^([/\\])+/, '').split(/[/\\]/)[0];
    if (first.startsWith('_') && first !== '_shared') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Game file not found');
      return;
    }
  }
  let filePath = path.join(rootDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  // a directory is its index.html. If it has none, that is a 404 — a folder
  // that exists must never be answered with the hub page.
  let isDirectory = false;
  try {
    isDirectory = (await stat(filePath)).isDirectory();
    if (isDirectory) filePath = path.join(filePath, 'index.html');
  } catch { /* the block below reports the miss */ }
  try {
    const info = await stat(filePath);
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const etag = `W/"${data.length.toString(16)}-${Math.round(info.mtimeMs || 0).toString(16)}"`;
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : cachePolicy(pathname),
      'x-content-type-options': 'nosniff',
      etag,
      vary: 'accept-encoding',
    };
    // a repeat visit answers from the browser cache in one conditional request
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    let body = data;
    const accepted = String(req.headers['accept-encoding'] || '').toLowerCase();
    const zipped = compress(filePath, data, ext, info);
    if (zipped) {
      if (accepted.includes('br') && zipped.br) {
        body = zipped.br;
        headers['content-encoding'] = 'br';
      } else if (accepted.includes('gzip') && zipped.gzip) {
        body = zipped.gzip;
        headers['content-encoding'] = 'gzip';
      }
    }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    // game folders are literal: a missing file is a 404, not the hub page
    if (isGamePath) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Game file not found');
      return;
    }
    // Only a *navigation* may fall back to the hub. A missing module, icon or
    // catalogue must be a real 404: answering 200 + HTML for `/js/typo.js`
    // makes the browser fail with "responded with a MIME type of text/html",
    // which hides the actual mistake.
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(pathname.split('/').pop() || '');
    if (!isDirectory && wantsHtml && !looksLikeFile) {
      try {
        const data = await readFile(path.join(PUBLIC, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
        res.end(data);
        return;
      } catch { /* fall through to 404 */ }
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(`Not found: ${pathname}`);
  }
});

server.on('upgrade', (req, socket) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { socket.destroy(); return; }
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    'Access-Control-Allow-Origin: *\r\n\r\n'
  );
  socket.setNoDelay(true);

  const room = sanitizeRoom(url.searchParams.get('room'));
  const ch = roomChannel(room);
  const state = { buf: Buffer.alloc(0), id: null, room, closed: false };
  ch.sockets.add(state);

  const cleanup = () => {
    if (state.closed) return;
    state.closed = true;
    ch.sockets.delete(state);
  };

  socket.on('data', (chunk) => {
    wsHandleBuffer(socket, state, chunk, (text) => {
      try {
        const msg = JSON.parse(text);
        if (!msg || typeof msg !== 'object') return;
        if (!msg.id) return;
        state.id = msg.id;
        // lightweight ping/pong so clients can measure
        if (msg.t === 'ping') {
          try { socket.write(wsFrame(JSON.stringify({ t: 'pong', id: 'server', ts: Date.now() }))); } catch {}
          return;
        }
        const stamped = { ...msg, ts: Date.now() };
        // relay to every other socket in the room
        for (const peer of ch.sockets) {
          if (peer === state || peer.closed) continue;
          try {
            if (peer.socket && !peer.socket.destroyed) peer.socket.write(wsFrame(JSON.stringify(stamped)));
          } catch {}
        }
      } catch { /* ignore malformed */ }
    }, cleanup);
  });

  state.socket = socket;
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  socket.on('end', cleanup);
});

server.listen(PORT, HOST, () => {
  console.log(`\n  100 DAYS OUTRUN — relay online`);
  console.log(`  → http://localhost:${PORT}  (bind ${HOST}:${PORT})`);
  console.log(`  → websocket /ws · http relay /api/room`);
  const resolved = resolveSupabaseConfig(process.env);
  if (resolved.configured) {
    console.log(`  → supabase accounts: configured`);
    console.log(`      url: ${resolved.url}  (from ${resolved.urlVar})`);
    console.log(`      key: ${resolved.keyVar} (${resolved.keyKind})`);
    // the server checks the project itself, so "configured" means "reachable"
    supabaseStatus({ deep: true }).then((st) => {
      const line = st.reachable
        ? `      server probe: reachable (auth /health ${st.status})`
        : `      server probe: UNREACHABLE — check the URL/key, players will fall back to guests`;
      console.log(line);
    }).catch(() => {});
  } else {
    console.log('  → supabase accounts: not configured — players run as guests');
    for (const problem of resolved.problems) console.log(`      · ${problem}`);
    console.log('      fix: set SUPABASE_URL + SUPABASE_ANON_KEY in .env, then restart');
  }
  console.log('');
});
