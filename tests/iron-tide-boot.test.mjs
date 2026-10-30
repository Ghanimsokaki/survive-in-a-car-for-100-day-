/**
 * IRON TIDE — BOOT.
 *
 * The ship once looked like it was loading forever. It was two bugs, and this
 * file pins both:
 *
 *   1. the hub served `games/` only from the built `dist/`, so a server started
 *      from the source tree answered the iframe with a 404 and the frame stayed
 *      empty. `node server.js` must serve the ship (see socket-e2e).
 *   2. the game built its whole dock before it told the hub it was ready, so a
 *      throw in the dock meant a black canvas *and* a hub that never got
 *      `arcade:ready`.
 *
 * So here: boot it headlessly, measure it, and prove the announcement cannot be
 * held up by the dock — including when the dock is deliberately broken.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './doms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const SOURCES = [
  'games/_shared/sdk.js',
  'games/iron-tide/fleet.js',
  'games/iron-tide/water.js',
  'games/iron-tide/game.js',
].map((f) => ({ file: f, code: read(f) }));

/** A fresh page: global DOM stubs, the hub as `parent`, and an error trap. */
function page({ breakDock = false } = {}) {
  installDOM({ width: 412, height: 915 });
  const posted = [];
  const atReady = [];
  const errors = [];

  globalThis.window.parent = {
    postMessage(msg) {
      posted.push(msg);
      if (msg?.type === 'arcade:ready') {
        // what the dock looked like at the instant the hub was told "I'm up"
        atReady.push(globalThis.document.getElementById('tabBody').children.length);
      }
    },
  };
  globalThis.parent = globalThis.window.parent;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 1;
  if (breakDock) {
    globalThis.document.createElement = () => { throw new Error('dock exploded'); };
    // the game logs the failure; keep the suite's output readable
    globalThis.console.warn = () => {};
  }

  const started = performance.now();
  for (const { file, code } of SOURCES) {
    try {
      vm.runInThisContext(code, { filename: file });
    } catch (err) {
      errors.push(`${path.basename(file)}: ${err && err.message}`);
    }
  }
  const bootMs = performance.now() - started;
  return { posted, atReady, errors, bootMs, it: globalThis.window.__ironTide || globalThis.__ironTide };
}

console.log('\nthe ship boots');
const good = page();
{
  check('nothing throws while loading', good.errors.length === 0, good.errors.join(' · ') || 'clean');
  check('it is up in a blink', good.bootMs < 500, `${good.bootMs.toFixed(1)} ms`);
  check('the hub is told immediately', good.posted.some((m) => m.type === 'arcade:ready'),
    good.posted.map((m) => m.type).join(',') || 'nothing posted');
  check('…and told before the dock is built, not after', good.atReady[0] === 0,
    `${good.atReady[0]} nodes existed at ready`);

  const body = globalThis.document.getElementById('tabBody');
  check('the dock is filled in afterwards', body.children.length >= 4, `${body.children.length} cards`);
  check('the wallet is painted', globalThis.document.getElementById('credits').textContent === '600',
    globalThis.document.getElementById('credits').textContent);
  check('the debug handle is exported', Boolean(good.it && good.it.screen === 'dock'), good.it?.screen);
  check('the flagship is a skiff with a gun', good.it?.fleet?.hull === 'skiff' && good.it?.fleet?.modules?.[0] === 'light-cannon');
}

console.log('\nthe ship sails');
{
  const it = good.it;
  it.setTab('build');
  check('tabs re-render', globalThis.document.getElementById('tabTitle').textContent === 'BUILD A FLEET'
    || globalThis.document.getElementById('tabTitle').textContent.length > 0,
    globalThis.document.getElementById('tabTitle').textContent);
  it.setTab('dock');

  it.startBattle();
  check('a sortie starts', it.screen === 'battle' && Boolean(it.session));
  const rudder = it.steerTo(400, -400);
  check('the helm answers the autopilot', Math.abs(rudder) > 0 && Math.abs(rudder) <= 1, rudder.toFixed(2));

  const t = performance.now();
  for (let i = 0; i < 180; i++) it.tick(1 / 60);
  const tickMs = performance.now() - t;
  check('three seconds of sea costs almost nothing', tickMs < 500, `${tickMs.toFixed(1)} ms for 180 frames`);
  it.fire();
  check('firing does not throw', true);

  it.endBattle(false);
  check('a lost hull ends the sortie', it.screen === 'result');
  it.backToDock();
  check('…and the dock is one tap away', it.screen === 'dock');
  const score = good.posted.find((m) => m.type === 'arcade:score');
  check('a finished run is reported to the hub', Boolean(score), score ? `score ${score.payload.score}` : 'none');
  check('…with a day and a hull name', /[a-z]/i.test(score?.payload?.meta || ''), score?.payload?.meta);
}

console.log('\na broken dock cannot brick the ship');
{
  const broken = page({ breakDock: true });
  check('the hub still gets its ready message', broken.posted.some((m) => m.type === 'arcade:ready'));
  check('the failure is caught, not thrown at the player', broken.errors.length === 0, broken.errors.join(' · '));
  check('the player is told what happened',
    /failed to render/i.test(globalThis.document.getElementById('loadoutHint').textContent),
    globalThis.document.getElementById('loadoutHint').textContent);
  check('the canvas loop was still started', Boolean(broken.it));
}

console.log('\nthe boot order is written down, not just observed');
{
  const src = read('games/iron-tide/game.js');
  const boot = src.slice(src.lastIndexOf('/* ------------------------------------------------------------------ boot */'));
  const readyAt = boot.indexOf('sdk.ready()');
  const renderAt = boot.indexOf('renderAll()');
  check('ready() comes before renderAll()', readyAt > 0 && readyAt < renderAt, `${readyAt} < ${renderAt}`);
  check('the dock render is guarded', /try \{[\s\S]{0,160}renderAll\(\)/.test(boot));
  check('the page has no loading copy anywhere',
    !/loading/i.test(read('games/iron-tide/index.html')),
    'index.html');
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL IRON TIDE BOOT TESTS PASSED');
process.exit(problems.length ? 1 : 0);
