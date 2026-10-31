/**
 * THE PAGE ACTUALLY STARTS — a browser-like load of a game, over HTTP.
 *
 * The other suites check the pieces: path resolution (`games-paths`), the boot
 * order (`iron-tide-boot`), the bridge contract (`arcade`). None of them starts
 * from *bytes over the wire* and ends at *the hub being told the game is up*,
 * which is the exact journey that failed with "GAME DID NOT START".
 *
 * So this is a small, honest browser: it fetches the document the way the hub's
 * iframe would (following the host's redirects), reads the `<base>` an inline
 * `pinBase()` script writes — by *running* that script, with a `document.write`
 * that records it — then fetches and executes every `<script src>` in document
 * order in a page with a DOM, and finally checks that a well-formed
 * `arcade:ready` reached the parent.
 *
 * Rules it deliberately keeps:
 *   · a script that 404s is reported by name, because that is the failure the
 *     player saw, and a silent skip would hide it again;
 *   · the URL has no trailing slash (Vercel's `cleanUrls` + `trailingSlash:
 *     false`), so a game that forgets to pin its base fails here;
 *   · the page runs with an opaque origin (no localStorage), like the sandboxed
 *     iframe it really lives in.
 */
import vm from 'node:vm';
import { installDOM } from './doms.mjs';
import { startVercelLike } from './vercel-like.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const host = await startVercelLike();

/**
 * Loads one game page like a browser and reports everything that happened.
 * `opaqueOrigin` removes storage, as `sandbox="allow-scripts"` does.
 */
async function loadPage(startPath, { opaqueOrigin = true, breakScript = null, stripPin = false } = {}) {
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

// ---------------------------------------------------------------- the ship
console.log('\nthe ship, loaded the way Vercel serves it');
{
  const page = await loadPage('/games/iron-tide/');
  check('the document came back', Boolean(page.html), page.finalUrl);
  check('…at a URL with no trailing slash', !page.finalUrl.endsWith('/'), page.finalUrl.replace(host.url, ''));

  check('every script it asks for exists', page.missing.length === 0,
    page.missing.map((m) => new URL(m).pathname).join(', ') || 'all found');
  check('nothing threw while loading', page.errors.length === 0, page.errors.join(' · ') || 'clean');
  check('all four files ran, in order',
    page.executed.join(',') === '/games/_shared/sdk.js,/games/iron-tide/fleet.js,/games/iron-tide/water.js,/games/iron-tide/game.js',
    page.executed.join(', '));

  const ready = page.posted.find((m) => m?.type === 'arcade:ready');
  check('THE HUB IS TOLD THE GAME IS UP', Boolean(ready));
  check('…on the right channel', ready?.channel === 'outrun-arcade', ready?.channel);
  check('…with a title the hub can show', ready?.payload?.title === 'Iron Tide', ready?.payload?.title);

  const dock = globalThis.document.getElementById('tabBody');
  check('the dock is built', dock.children.length >= 4, `${dock.children.length} cards`);
  check('the wallet is painted', globalThis.document.getElementById('credits').textContent === '600');
  check('no error message was posted instead',
    !page.posted.some((m) => /GAME ERROR/.test(m?.payload?.status || '')));
}

console.log('\nwith storage locked (the sandboxed iframe)');
{
  // installDOM's own storage is replaced with one that throws, above — the game
  // must still boot, which is why trySave/tryLoad exist.
  const page = await loadPage('/games/iron-tide/');
  check('the ship still starts without localStorage',
    page.posted.some((m) => m?.type === 'arcade:ready'), page.errors.join(' · ') || 'clean');
  check('…and reports no error', !page.errors.length, page.errors.join(' · '));
}

console.log('\na game with a custom entry, and a missing file');
{
  // the template ships `game.js`; load it the same way to prove the pin is not
  // something only Iron Tide knows about
  const tpl = await loadPage('/games/_template/');
  check('the template pins its base too', tpl.baseHref.endsWith('/games/_template/'), tpl.baseHref.replace(host.url, ''));
  check('…so its own script resolves', tpl.missing.length === 0,
    tpl.missing.map((m) => new URL(m).pathname).join(', ') || 'all found');

  // and the failure path: a script that cannot be fetched must be *reported*,
  // not silently skipped, or the hub would sit on "GAME DID NOT START"
  const broken = await loadPage('/games/iron-tide/', { breakScript: 'water.js' });
  check('a missing file is named', broken.missing.some((m) => m.endsWith('/water.js')),
    broken.missing.map((m) => new URL(m).pathname).join(', ') || 'none');
  check('…and the rest still ran', broken.executed.length === 3, broken.executed.length);
}

console.log('\nand without the fix it fails — the regression this suite guards');
{
  const page = await loadPage('/games/iron-tide/', { stripPin: true });
  check('the game’s own scripts 404', page.missing.some((m) => m.endsWith('/games/fleet.js')),
    page.missing.map((m) => new URL(m).pathname).join(', '));
  check('the hub is NOT told the game is up', !page.posted.some((m) => m?.type === 'arcade:ready'));
  check('…so the whole game is dead, which is "GAME DID NOT START"', page.executed.length === 0,
    page.executed.join(', ') || 'nothing ran');
}

// ------------------------------------------------------ the hub receives it
console.log('\nthe hub turns that message into LIVE');
{
  // Feed the exact message the page posted into the real Arcade bridge.
  const sent = (await loadPage('/games/iron-tide/')).posted.find((m) => m.type === 'arcade:ready');
  const arcade = await import('../public/js/arcade.js');
  const msg = arcade.validateBridgeMessage(sent);
  check('the ready message passes the hub’s validator', Boolean(msg) && msg.type === 'arcade:ready');
  check('…and carries nothing it should not', JSON.stringify(msg.payload) === '{}', JSON.stringify(msg.payload));
}

await host.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nTHE GAME ACTUALLY STARTS FROM THE WIRE');
process.exit(problems.length ? 1 : 0);
