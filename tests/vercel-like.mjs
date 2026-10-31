/**
 * A static server that applies **Vercel's** URL rules, for tests.
 *
 * The site ships with `cleanUrls: true` and `trailingSlash: false`, which means:
 *
 *   /games/iron-tide/index.html  →  308 →  /games/iron-tide
 *   /games/iron-tide/            →  308 →  /games/iron-tide
 *   /games/iron-tide             →  200  (the folder's index.html)
 *
 * That last line is the one that matters: a document served at
 * `/games/iron-tide` has no trailing slash, so a relative `<script src="fleet.js">`
 * resolves against `/games/` and 404s. Our own Express server keeps the slash,
 * so anything that only ever runs against `node server.js` will never see it.
 *
 * Serving goes straight from `public/` and `games/` (Vercel's `dist/` is a copy
 * of exactly those files) so no test depends on a build having run.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, '..');
export const SITE = { games: path.join(ROOT, 'games'), public: path.join(ROOT, 'public') };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/** Where a URL path lives on disk, or what it redirects to — Vercel's rules. */
export async function resolveVercel(pathname) {
  if (pathname === '/') return { file: path.join(SITE.public, 'index.html') };
  if (pathname.endsWith('/index.html')) return { redirect: pathname.slice(0, -'index.html'.length) };
  if (pathname.endsWith('.html')) return { redirect: pathname.slice(0, -'.html'.length) };
  if (pathname.endsWith('/')) return { redirect: pathname.slice(0, -1) || '/' };
  const file = pathname.startsWith('/games/')
    ? path.join(SITE.games, decodeURIComponent(pathname.replace(/^\/games\//, '')))
    : path.join(SITE.public, pathname);
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

/** Starts the server on a random port. Resolves to `{ url, close }`. */
export async function startVercelLike() {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const found = await resolveVercel(pathname);
    if (found.redirect !== undefined) {
      res.writeHead(308, { location: encodeURI(found.redirect) });
      res.end();
      return;
    }
    if (found.status === 404) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const body = await readFile(found.file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(found.file)] || 'application/octet-stream' });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    /** Follows redirects like a browser, reporting the final URL. */
    async land(target) {
      let current = target.startsWith('http') ? target : `${url}${target}`;
      for (let hop = 0; hop < 6; hop += 1) {
        const res = await fetch(current, { redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
          current = new URL(res.headers.get('location'), current).href;
          continue;
        }
        return { url: current, status: res.status, res, text: res.status === 200 ? await res.text() : '' };
      }
      return { url: current, status: 0, text: '' };
    },
    async close() {
      await new Promise((r) => server.close(r));
    },
  };
}
