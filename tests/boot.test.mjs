// FAST BOOT + PORTRAIT HOME + SUPABASE-BACKED RELAY
//
// Three promises the last round made, pinned:
//   1. the home does not download the 3D engine (it used to: 1.1 MB before the
//      sign-in box worked)
//   2. the home is portrait; only a run asks for landscape
//   3. the server keeps rooms in Supabase when it is configured, and says so
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './doms.mjs';
import { createRoomStore } from '../lib/room-store.mjs';

// a phone: the orientation helpers only act on touch devices
globalThis.__TOUCH__ = true;
installDOM({ width: 390, height: 844 });

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const publicDir = path.join(root, 'public');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

// ---------------------------------------------------------------- import graph
console.log('\nhome payload');
{
  const seen = new Map();
  const walk = async (file) => {
    if (seen.has(file)) return;
    const code = await readFile(file, 'utf8');
    seen.set(file, code.length);
    const re = /^\s*import\s+(?:[^'"]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(code))) {
      const target = path.normalize(path.join(path.dirname(file), m[1]));
      try { await readFile(target); } catch { continue; }
      await walk(target);
    }
  };
  await walk(path.join(publicDir, 'js', 'main.js'));
  const bytes = [...seen.values()].reduce((a, b) => a + b, 0);
  const names = [...seen.keys()].map((f) => path.basename(f));

  check('the home never statically imports three.js', !names.includes('three.module.js'),
    `${(bytes / 1024).toFixed(0)} KB`);
  check('the home never statically imports the game', !names.includes('game.js'));
  check('the home never statically imports the avatar rig', !names.includes('avatar.js'));
  check('the home payload is under 200 KB', bytes < 200 * 1024,
    `${(bytes / 1024).toFixed(1)} KB across ${seen.size} modules`);
  check('the home is a small graph (no deep chains)', seen.size <= 20, `${seen.size} modules`);

  const main = await readFile(path.join(publicDir, 'js', 'main.js'), 'utf8');
  check('the 3D kit is imported on demand', /import\('\.\/game\.js'\)/.test(main));
  check('the kit is warmed in the background, not on the critical path',
    /loadGameKit\(\)/.test(main) && /requestIdleCallback/.test(main));
  check('the home preview has no imports at all',
    !/^\s*import\s/m.test(await readFile(path.join(publicDir, 'js', 'preview.js'), 'utf8')));

  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  check('the critical modules are preloaded', /rel="modulepreload" href="\.\/js\/main\.js"/.test(html));
  check('the boot card can never trap the player', /STILL LOADING/.test(html) && /booted/.test(html));
}

// ------------------------------------------------------------------- preview
console.log('\n2D avatar preview');
{
  const { AvatarPreview } = await import('./app/js/preview.js');
  const calls = [];
  const ctx = {
    clearRect: () => calls.push('clear'),
    fillRect: () => {}, strokeRect: () => {}, beginPath: () => {}, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, arc: () => {}, ellipse: () => {}, fill: () => {},
    stroke: () => {}, save: () => {}, restore: () => {}, translate: () => {}, scale: () => {},
    quadraticCurveTo: () => {}, fillText: () => {}, createLinearGradient: () => ({ addColorStop: () => {} }),
    createRadialGradient: () => ({ addColorStop: () => {} }),
    set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {},
    set textAlign(v) {}, set globalAlpha(v) {},
  };
  const canvas = { clientWidth: 320, clientHeight: 200, width: 0, height: 0, getContext: () => ctx, addEventListener: () => {} };
  const p = new AvatarPreview(canvas);
  check('the preview constructs without three.js', Boolean(p));
  p.setAvatar(0x5ff0ff, 'GHANIM', { skin: 'bronze', outfit: 'cyan', hair: 'mohawk' });
  check('it remembers the look', p.avatar.name === 'GHANIM' && p.avatar.custom.hair === 'mohawk');
  p.resize();
  const dpr = Math.min(Math.max(1, globalThis.devicePixelRatio || 1), 2.5);
  check('it sizes the canvas at device resolution',
    canvas.width === Math.round(320 * dpr) && canvas.height === Math.round(200 * dpr),
    `${canvas.width}×${canvas.height} (dpr ${dpr})`);
  p.render(1 / 60);
  p.render(1 / 60);
  check('it draws each frame', calls.length >= 2, `${calls.length} frames`);
  p.setAvatar('#b6543a', 'X', { hair: 'bun' });
  check('switching hair does not throw', p.avatar.custom.hair === 'bun');
}

// ------------------------------------------------------------------ landscape
console.log('\nportrait home, landscape run');
{
  const orient = await import('./app/js/orientation.js');
  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));

  check('the manifest does not pin landscape', manifest.orientation === 'any', manifest.orientation);
  check('the page meta does not pin landscape', /name="screen-orientation" content="any"/.test(html));

  document.body.classList.remove('run-live');
  const calls = [];
  screen.orientation = { lock: async (k) => { calls.push(k); } };
  document.documentElement.requestFullscreen = async () => { calls.push('fullscreen'); };

  const idle = await orient.requestLandscape();
  check('the home never turns the phone', idle === false && calls.length === 0, calls.join(','));

  document.body.classList.add('run-live');
  check('a run is detected', orient.isPlaying() === true);
  await orient.requestLandscape();
  check('a run asks for landscape', calls.includes('landscape'), calls.join(','));

  await orient.requestPortrait();
  check('leaving the run hands the phone back to portrait', calls.includes('portrait'), calls.join(','));
  check('the locked flag is cleared', orient.landscapeState().locked === false);

  document.body.classList.remove('run-live');
  orient.installAutoLandscape({ when: 'any' });
  await new Promise((r) => setTimeout(r, 80));
  check('the CSS rotation is never applied to the home',
    !document.body.classList.contains('auto-land'), document.body.className);
}

// ------------------------------------------------------------- room relay
console.log('\nroom store (server side)');
{
  const memory = createRoomStore({ env: {} });
  check('an unconfigured server keeps the in-memory lane', memory.backend === 'memory');
  await memory.push('highway-01', 'p1', [{ t: 'state', day: 3 }]);
  const read = await memory.read('highway-01', 'p2');
  check('a peer sees the message', read.msgs.length === 1 && read.msgs[0].day === 3);
  check('the author does not get an echo', (await memory.read('highway-01', 'p1')).msgs.length === 0);
  check('room names are sanitised', (await memory.read('../etc/passwd', 'p2')).room === 'etcpasswd',
    (await memory.read('../etc/passwd', 'p2')).room);

  // a fake Supabase that records the REST calls
  const ANON = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify({ role: 'anon', ref: 'abcdefghijklmnop' })).toString('base64url')}.sig`;
  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body, headers: opts.headers });
    if ((opts.method || 'GET') === 'GET') {
      return { ok: true, json: async () => [{ author: 'p1', payload: { day: 7, id: 'p1' } }] };
    }
    return { ok: true, json: async () => ({}) };
  };
  const remote = createRoomStore({
    env: { SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: ANON },
    fetchImpl: fakeFetch,
  });
  check('configured means the relay uses Supabase', remote.backend === 'supabase');

  await remote.push('highway-01', 'p2', [{ day: 7 }]);
  const post = calls.find((c) => c.method === 'POST');
  check('messages are inserted through PostgREST', Boolean(post) && post.url.endsWith('/rest/v1/room_messages'),
    post?.url);
  check('the insert carries the room + author', JSON.parse(post.body)[0].room === 'highway-01'
    && JSON.parse(post.body)[0].author === 'p2');
  check('the anon key is the only credential used', post.headers.apikey === ANON);

  const got = await remote.read('highway-01', 'p2');
  const get = calls.find((c) => c.method === 'GET');
  check('reads are scoped to the room and the time window', /room=eq\.highway-01/.test(get.url)
    && /ts=gte\./.test(get.url), get.url.slice(0, 80));
  check('your own messages are filtered by the query', /author=neq\.p2/.test(get.url));
  check('the payload reaches the client', got.msgs[0]?.day === 7 && got.backend === 'supabase');

  // and when the database is down the relay keeps serving
  const broken = createRoomStore({
    env: { SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_ANON_KEY: ANON },
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  await broken.push('storm-room', 'p3', [{ t: 'state' }]);
  const fallback = await broken.read('storm-room', 'p4');
  check('a dead database degrades to memory instead of failing', fallback.degraded === true
    && fallback.msgs.length >= 1,
    `degraded=${fallback.degraded} · ${fallback.msgs.length} msg(s) served from memory`);
  check('the failure is recorded for /api/health', broken.health.lastError.includes('ECONNREFUSED'));

  const schema = await readFile(path.join(root, 'supabase', 'schema.sql'), 'utf8');
  check('the schema ships the room table', /create table if not exists public\.room_messages/.test(schema));
  check('room rows are swept by policy, not a cron job',
    /stale rows can be swept/.test(schema) && /interval '2 minutes'/.test(schema));
}

// ------------------------------------------------------------------- server
console.log('\nnode server');
{
  const port = 8100 + Math.floor(Math.random() * 300);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SUPABASE')));
  const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, env: { ...env, PORT: String(port), HOST: '127.0.0.1' },
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const res = await fetch(`${base}/api/health`);
      up = res.ok;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  check('the server boots', up, up ? `port ${port}` : log.slice(-200));

  if (up) {
    const health = await (await fetch(`${base}/api/health`)).json();
    check('health reports the supabase state', typeof health.supabase?.configured === 'boolean');
    check('health explains what is missing', !health.supabase.configured
      ? health.supabase.problems.length === 2 : health.supabase.url !== null,
      (health.supabase.problems || []).join(' | ').slice(0, 60));
    check('health reports the relay backend', health.relay?.backend === 'memory', health.relay?.backend);

    const cfg = await (await fetch(`${base}/api/config`)).json();
    check('/api/config answers in one round trip', typeof cfg.configured === 'boolean' && 'supabaseUrl' in cfg);
    check('/api/config is not cacheable',
      /no-store/.test((await fetch(`${base}/api/config`)).headers.get('cache-control') || ''));

    // compression + caching: the 690 KB engine must arrive small, then not at all
    // fetch() inflates the body for us, so the wire size is the content-length
    const three = await fetch(`${base}/vendor/three.module.js`, { headers: { 'accept-encoding': 'br' } });
    const wire = Number(three.headers.get('content-length') || 0);
    await three.arrayBuffer();
    const encoding = three.headers.get('content-encoding');
    check('the big module is compressed on the wire', ['br', 'gzip'].includes(encoding),
      `${encoding} · ${(wire / 1024).toFixed(0)} KB`);
    check('compression is a big win', wire > 0 && wire < 260 * 1024, `${(wire / 1024).toFixed(0)} KB`);
    check('vendored code is cached forever',
      /immutable/.test(three.headers.get('cache-control') || ''), three.headers.get('cache-control'));

    const etag = three.headers.get('etag');
    const again = await fetch(`${base}/vendor/three.module.js`, { headers: { 'if-none-match': etag } });
    check('a repeat visit is a 304, not a re-download', again.status === 304, String(again.status));

    const htmlRes = await fetch(`${base}/`);
    check('the shell is never cached', /no-store/.test(htmlRes.headers.get('cache-control') || ''));

    // the relay contract the client already speaks
    const post = await fetch(`${base}/api/room`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'highway-01', id: 'p1', msg: { t: 'state', day: 4 } }),
    });
    const postJson = await post.json();
    check('the relay accepts a message', post.status === 200 && postJson.backend === 'memory', postJson.backend);
    const poll = await fetch(`${base}/api/room`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: 'highway-01', id: 'p2' }),
    });
    const pollJson = await poll.json();
    check('another player receives it', pollJson.msgs.length === 1 && pollJson.msgs[0].day === 4);
  }

  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
}

// ---------------------------------------------------------- the home files
console.log('\nphone gui');
{
  const css = await readFile(path.join(publicDir, 'styles.css'), 'utf8');
  check('the home cannot scroll sideways', /body\{overflow-x:hidden\}/.test(css));
  check('the tab bar docks to the thumb in portrait', /\.arc-rail\{order:2/.test(css));
  check('tap targets are at least 44 px', /min-height:44px/.test(css));
  check('notched phones get safe-area padding', /env\(safe-area-inset-bottom/.test(css));
  check('the rotation fallback is scoped to a live run', /body:not\(\.run-live\)\.auto-land/.test(css));

  const files = await readdir(path.join(publicDir, 'js'));
  check('the js folder still ships the shipped modules', files.includes('preview.js') && files.includes('orientation.js'));
}

process.exit(problems.length ? 1 : 0);
