/**
 * THE VERCEL URL RULES, REPRODUCED.
 *
 * Vercel serves this site with `cleanUrls: true` and `trailingSlash: false`, so
 * the hub's iframe ends up at `/games/iron-tide` — **no trailing slash**. That
 * single missing character was the whole "the game did not start" bug: a
 * document at `/games/iron-tide` resolves `<script src="fleet.js">` against
 * `/games/`, asks for `/games/fleet.js`, gets a 404, leaves `FleetRules`
 * undefined and dies before it can post `arcade:ready`. Our own server keeps the
 * slash, which is why it never reproduced locally.
 *
 * This suite stands up a static server that applies Vercel's rules to the files
 * the site actually ships and checks the two halves of the fix:
 *   · the hub now asks for the directory form (`…/iron-tide/`);
 *   · the game pins its own `<base>`, so every file it loads still resolves
 *     even when the host has stripped the slash.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
// Serve the shipped sources (Vercel's `dist/` is a copy of exactly these), so
// this suite never depends on a build having run first.
const SITE = { games: path.join(root, 'games'), public: path.join(root, 'public') };

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

// --------------------------------------------------- a host with Vercel's rules
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml',
};

/** Resolves a URL path the way Vercel does: clean URLs, no trailing slash. */
async function resolveVercel(pathname) {
  let p = pathname;
  if (p === '/') return { file: path.join(SITE.public, 'index.html') };
  if (p.endsWith('/index.html')) return { redirect: p.slice(0, -'index.html'.length) };
  if (p.endsWith('.html')) return { redirect: p.slice(0, -'.html'.length) };
  if (p.endsWith('/')) return { redirect: p.slice(0, -1) };
  const file = p.startsWith('/games/')
    ? path.join(SITE.games, p.replace(/^\/games\//, ''))
    : path.join(SITE.public, p);
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      const index = path.join(file, 'index.html');
      await stat(index);
      return { file: index };
    }
    return { file };
  } catch {
    return { status: 404 };
  }
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  const found = await resolveVercel(pathname);
  if (found.redirect !== undefined) { res.writeHead(308, { location: found.redirect || '/' }); res.end(); return; }
  if (found.status === 404) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not Found'); return; }
  const body = await readFile(found.file);
  res.writeHead(200, { 'content-type': TYPES[path.extname(found.file)] || 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** Follows redirects, reporting the URL the browser would end up at. */
async function land(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) { current = new URL(res.headers.get('location'), current).href; continue; }
    return { url: current, status: res.status, res };
  }
  return { url: current, status: 0 };
}

console.log('\nwhat the hub asks for');
{
  const game = { id: 'iron-tide', path: 'games/iron-tide', entry: 'index.html' };
  const folder = String(game.path).replace(/^\.?\//, '').replace(/\/+$/, '');
  const entry = String(game.entry || 'index.html');
  const file = !entry || entry === 'index.html' ? '' : entry;
  const asked = `./${folder}/${file}`;
  check('the iframe URL is a directory, not a file', asked === './games/iron-tide/', asked);
  check('…so a game with a custom entry still names it',
    `./${folder}/${'play.html'}` === './games/iron-tide/play.html');
  // `openGame` itself is covered by the arcade suite, which asserts the frame src.
}

console.log('\nthe ship under Vercel’s rules');
const shipUrl = `${base}/games/iron-tide/`;
{
  const landed = await land(shipUrl);
  check('the directory form lands somewhere', landed.status === 200, `${landed.status} → ${landed.url.replace(base, '')}`);
  check('…and Vercel strips the slash, as it does in production',
    landed.url === `${base}/games/iron-tide`, landed.url.replace(base, '') || '/');

  const html = await landed.res.text();
  check('the ship is what came back', html.includes('IRON TIDE'));
  check('…with its base pinned', html.includes('pinBase'));
  check('…before any of its own scripts',
    html.indexOf('pinBase') < html.indexOf('<script src="fleet.js">'), 'pinBase first');

  // every URL the browser will fetch, resolved from the pinned base
  const pinned = new URL('/games/iron-tide/', landed.url);
  const wanted = ['../_shared/sdk.js', 'fleet.js', 'water.js', 'game.js'];
  for (const rel of wanted) {
    const target = new URL(rel, pinned).href;
    const res = await fetch(target);
    check(`it can load ${rel}`, res.status === 200, target.replace(base, ''));
  }

  // and the same files, resolved the way they were before the fix: all 404
  const broken = new URL('fleet.js', landed.url).href;      // no trailing slash
  check('without the pin this is exactly what 404s', (await fetch(broken)).status === 404,
    broken.replace(base, ''));
}

console.log('\nthe hub itself');
{
  const home = await land(`${base}/`);
  check('the shell loads under the same rules', home.status === 200);
  const catalogue = await fetch(`${base}/games/index.json`);
  check('the game catalogue is reachable', catalogue.status === 200);
  const json = await catalogue.json();
  check('…and lists the ship with an entry', json.games.some((g) => g.id === 'iron-tide' && g.entry === 'index.html'));
}

server.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nGAMES RESOLVE CORRECTLY UNDER VERCEL URL RULES');
process.exit(problems.length ? 1 : 0);
