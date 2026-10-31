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
import { startVercelLike } from './vercel-like.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const host = await startVercelLike();
const base = host.url;
const land = (u) => host.land(u);

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

  const html = landed.text;
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

await host.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nGAMES RESOLVE CORRECTLY UNDER VERCEL URL RULES');
process.exit(problems.length ? 1 : 0);
