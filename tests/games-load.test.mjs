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
import { installDOM } from './doms.mjs';
import { startVercelLike } from './vercel-like.mjs';
import { loadGamePage } from './game-page.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const host = await startVercelLike();
/** The page loader lives in tests/game-page.mjs, shared with the other games. */
const loadPage = (startPath, opts) => loadGamePage(host, startPath, opts);

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

// ------------------------------------------------------------ star battle
console.log('\nstar battle, loaded the way Vercel serves it');
{
  // no trailing slash: exactly what `cleanUrls` + `trailingSlash: false` hands
  // the iframe, which is the URL that killed Iron Tide
  const page = await loadPage('/games/star-battle');
  check('the document came back', Boolean(page.html), page.finalUrl.replace(host.url, ''));
  check('…with the base pinned to the game folder', page.baseHref.endsWith('/games/star-battle/'),
    page.baseHref.replace(host.url, ''));
  check('every script it asks for exists', page.missing.length === 0,
    page.missing.map((m) => new URL(m).pathname).join(', ') || 'all found');
  check('nothing threw while loading', page.errors.length === 0, page.errors.join(' · ') || 'clean');
  check('the SDK, the rules, the ship art and the game all ran, in order',
    page.executed.join(',') === '/games/_shared/sdk.js,/games/star-battle/ships.js,/games/star-battle/art.js,/games/star-battle/game.js',
    page.executed.join(', '));

  const ready = page.posted.find((m) => m?.type === 'arcade:ready');
  check('THE HUB IS TOLD THE GAME IS UP', Boolean(ready));
  check('…on the right channel', ready?.channel === 'outrun-arcade', ready?.channel);
  check('…with the title the hub shows on the shelf', ready?.payload?.title === 'Star Battle',
    ready?.payload?.title);
  check('the fight is drivable from the page it booted',
    typeof globalThis.window.__starBattle?.start === 'function');
  const icon = await fetch(new URL('/games/star-battle/icon.svg', host.url));
  check('the icon the shelf asks for exists', icon.ok, String(icon.status));

  // the regression experiment: without the pin, the relative scripts resolve to
  // /games/*.js and the game is dead — the exact production failure
  const unpinned = await loadPage('/games/star-battle', { stripPin: true });
  check('without the pin the scripts 404', unpinned.missing.length >= 2,
    unpinned.missing.map((m) => new URL(m).pathname).join(', ') || 'none');
  check('…and the hub is NOT told the game is up',
    !unpinned.posted.some((m) => m?.type === 'arcade:ready'));
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
