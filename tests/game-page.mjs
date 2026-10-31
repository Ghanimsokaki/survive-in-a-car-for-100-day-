/**
 * A SMALL, HONEST BROWSER — load a community game page over HTTP.
 *
 * The hub runs games in `<iframe sandbox="allow-scripts">`: an opaque origin, so
 * `localStorage` throws, and the page is served with whatever URL rules the host
 * uses (Vercel cleans `/games/x/index.html` to `/games/x`, with no trailing
 * slash). This helper reproduces that faithfully enough to catch the failures
 * that only show up in production:
 *
 *   · it fetches the document the way the iframe would, following redirects;
 *   · it *runs* inline scripts, so a `pinBase()` moves the base for real;
 *   · it fetches and executes every `<script src>` in document order;
 *   · a script that 404s is reported by name — never silently skipped;
 *   · the page's `location` and `title` are the ones it would really have.
 *
 * Used by `games-load` (Iron Tide) and `star-battle`.
 */
import vm from 'node:vm';
import { installDOM } from './doms.mjs';

export async function loadGamePage(host, startPath, { opaqueOrigin = true, breakScript = null, stripPin = false } = {}) {
  const landed = await host.land(startPath);
  const posted = [];
  const missing = [];
  const executed = [];
  const errors = [];

  // A page: the DOM stub the other suites use, a parent that records messages,
  // and no storage when the origin is opaque.
  installDOM({ width: 412, height: 915 });
  globalThis.window.parent = {
    postMessage(msg) { posted.push(msg); },
  };
  globalThis.parent = globalThis.window.parent;
  if (opaqueOrigin) {
    globalThis.localStorage = {
      getItem() { throw new Error('SecurityError: the document is sandboxed and lacks the allow-same-origin flag'); },
      setItem() { throw new Error('SecurityError'); },
      removeItem() { throw new Error('SecurityError'); },
    };
    globalThis.window.localStorage = globalThis.localStorage;
  }
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 1;
  const warn = console.warn;
  console.warn = () => {};                       // the game's own (handled) warnings
  if (breakScript) globalThis.document.createElement = () => { throw new Error(breakScript); };

  const finalUrl = new URL(landed.url);
  let baseHref = finalUrl.href;                  // a browser's default base

  let html = landed.text;
  // `stripPin` is the regression experiment: take the `<base>` pin out and the
  // page must fail here exactly the way it failed in production.
  if (stripPin) html = html.replace(/<script>\s*\(function pinBase\(\)[\s\S]*?<\/script>/, '');
  // The page's own view of the world: its URL (that is what a base pin reads)
  // and its title (the SDK reports it in `arcade:ready`).
  globalThis.location = {
    href: finalUrl.href, pathname: finalUrl.pathname, search: finalUrl.search,
    host: finalUrl.host, protocol: finalUrl.protocol, reload() {},
  };
  globalThis.window.location = globalThis.location;
  globalThis.document.title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  // Every <script> in document order — inline ones and src ones.
  const tags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of tags) {
    const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (src) {
      const target = new URL(src, baseHref).href;
      if (breakScript && src.includes(breakScript)) { missing.push(target); continue; }
      const res = await fetch(target);
      if (!res.ok) { missing.push(target); continue; }
      const code = await res.text();
      const file = new URL(target).pathname;
      try {
        vm.runInThisContext(code, { filename: file });
        executed.push(file);
      } catch (err) {
        errors.push(`${file}: ${err && err.message}`);
      }
      continue;
    }
    // Inline: run it, so a `pinBase()` can move the base exactly as it would.
    if (!body.trim()) continue;
    const writes = [];
    const doc = globalThis.document;
    const realWrite = doc.write;
    doc.write = (s) => { writes.push(String(s)); };
    try {
      vm.runInThisContext(body, { filename: `${finalUrl.pathname}#inline` });
    } catch (err) {
      errors.push(`inline: ${err && err.message}`);
    }
    doc.write = realWrite;
    for (const written of writes) {   // each document.write() call, in order
      const href = (written.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (href) baseHref = new URL(href, finalUrl).href;
    }
  }

  console.warn = warn;
  return { posted, missing, executed, errors, baseHref, finalUrl: landed.url, html };
}
