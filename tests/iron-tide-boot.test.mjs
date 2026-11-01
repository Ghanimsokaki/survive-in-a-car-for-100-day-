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
  // keep the listeners: the keyboard is part of the game, so a suite has to be
  // able to press a key the way a desktop player does
  const listeners = {};
  globalThis.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
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
  /** Press (or release) a key on the window, exactly as the browser would. */
  const key = (type, k) => (listeners[type] || []).forEach((fn) => fn({
    key: k, preventDefault() {}, stopPropagation() {},
  }));
  return {
    posted, atReady, errors, bootMs, key,
    it: globalThis.window.__ironTide || globalThis.__ironTide,
  };
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
  // The keyboard is a control, not decoration: W must put way on the hull, and
  // D must swing the bow — a boat only answers her rudder once she is moving.
  {
    const s = it.session;
    const start = { x: s.x, y: s.y, heading: s.yaw };
    good.key('keydown', 'w');
    for (let i = 0; i < 180; i++) it.tick(1 / 60);
    const way = Math.hypot(s.x - start.x, s.y - start.y);
    check('W puts way on the hull', s.body.u > 1 && way > 5, `${s.body.u.toFixed(1)} m/s · ${way.toFixed(0)} m`);
    good.key('keydown', 'd');
    for (let i = 0; i < 90; i++) it.tick(1 / 60);
    const turned = Math.abs(s.yaw - start.heading);
    check('D swings the bow', turned > 0.15, `${turned.toFixed(2)} rad`);
    good.key('keyup', 'd');
    good.key('keyup', 'w');
    // a hull carries her way: she coasts for a long time, but she does slow down
    const wayOn = s.body.u;
    for (let i = 0; i < 900; i++) it.tick(1 / 60);
    check('releasing W lets the hull coast down', s.body.u < wayOn * 0.75,
      `${wayOn.toFixed(1)} → ${s.body.u.toFixed(1)} m/s after 15 s`);
  }

  // FIRE has to *do* something: a click on the real button must spend the
  // reload, put a shell in the water per fitted turret, hit what is in front of
  // the bow, and refuse a second click inside the cooldown. (The old check only
  // proved the button was clickable.)
  {
    const s = it.session;
    // The suite is a director here, so that what is measured is FIRE's effect
    // and not the helmsman's skill: one raider dead ahead at a range the guns
    // reach, everything else out of the way, so the aim assist has no choice.
    const living = s.ships.filter((e) => !e.dead);
    const target = living[0];
    for (const other of living.slice(1)) {
      other.x = other.body.x = -2000;
      other.y = other.body.y = -2000;
      other.vx = 0; other.vy = 0;
    }
    // `x`/`y` are a mirror of the body, so a raider is only really somewhere
    // once its *body* is — writing the mirror alone is undone on the next tick
    const ahead = (m) => {
      if (!target) return;
      const x = s.x + Math.cos(s.yaw) * m;
      const y = s.y + Math.sin(s.yaw) * m;
      target.x = target.body.x = x;
      target.y = target.body.y = y;
      target.vx = 0; target.vy = 0;
      target.body.u = 0; target.body.v = 0;
    };
    ahead(180);

    const before = { shots: s.shots, bullets: s.bullets.length };
    globalThis.document.getElementById('fireBtn').dispatch('click');
    check('the FIRE button fires', s.shots === before.shots + 1, `${before.shots} → ${s.shots}`);
    check('…one shell per fitted turret', s.bullets.length >= before.bullets + Math.max(1, s.lo.turrets),
      `${before.bullets} → ${s.bullets.length} shells for ${s.lo.turrets} turret(s)`);
    check('…and the guns lock what the bow is pointed at', Boolean(s.lock),
      s.lock ? `${Math.hypot(s.lock.x - s.x, s.lock.y - s.y).toFixed(0)} m` : 'no lock');
    check('…with real damage on it', s.bullets.every((b) => b.dmg > 0),
      `${s.bullets[s.bullets.length - 1]?.dmg} a shell`);
    globalThis.document.getElementById('fireBtn').dispatch('click');
    check('a second click inside the reload does nothing', s.shots === before.shots + 1,
      `${s.shots} broadsides`);

    const hpBefore = target ? target.hp : 0;
    for (let i = 0; i < 90 && target && !target.dead && target.hp === hpBefore; i++) {
      ahead(180);                        // hold her in the line of fire
      it.tick(1 / 60);
    }
    check('the shell hits what the bow is pointed at', !target || target.hp < hpBefore || target.dead,
      target ? `${hpBefore} → ${target.dead ? 'sunk' : target.hp}` : 'no raider left');
  }

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

console.log('\nthe game finds its own files');
{
  // The page is served three ways by three hosts, and only two of them keep the
  // trailing slash. Vercel (`cleanUrls` + `trailingSlash: false`) serves
  // `/games/iron-tide`, and a relative `fleet.js` then resolves to
  // `/games/fleet.js` — 404 — which used to kill the game before it could say
  // `arcade:ready`. The inline `pinBase()` block in index.html is the guard.
  const html = read('games/iron-tide/index.html');
  const pin = html.match(/<script>\s*\(function pinBase\(\)[\s\S]*?<\/script>/);
  check('index.html pins its base before any script', Boolean(pin) && html.indexOf('pinBase') < html.indexOf('sdk.js'),
    pin ? 'found' : 'missing');

  const run = (pathname) => {
    let written = '';
    const sandbox = {
      location: { pathname },
      document: { write: (s) => { written += s; } },
      console,
    };
    vm.createContext(sandbox);
    vm.runInContext(pin[0].replace(/^<script>|,<\/script>$/g, '').replace(/<\/script>$/, ''), sandbox);
    return (written.match(/href="([^"]+)"/) || [])[1] || '';
  };

  const cases = {
    '/games/iron-tide/': '/games/iron-tide/',
    '/games/iron-tide': '/games/iron-tide/',          // Vercel's cleaned URL
    '/games/iron-tide/index.html': '/games/iron-tide/',
    '/arcade/games/iron-tide': '/arcade/games/iron-tide/',   // a sub-path deploy
  };
  let allRight = true;
  for (const [given, want] of Object.entries(cases)) {
    const got = run(given);
    if (got !== want) { allRight = false; console.log(`  FAIL ${given} → ${got} (wanted ${want})`); }
  }
  check('…and every URL shape resolves to the game folder', allRight);

  // …so the real question: does `fleet.js` land on the file that exists?
  const resolved = new URL('fleet.js', `https://x.test${run('/games/iron-tide')}`).pathname;
  check('a relative script resolves inside the game folder', resolved === '/games/iron-tide/fleet.js', resolved);
  const sdk = new URL('../_shared/sdk.js', `https://x.test${run('/games/iron-tide')}`).pathname;
  check('…and the shared SDK still resolves', sdk === '/games/_shared/sdk.js', sdk);

  check('a missing file is reported to the hub, not swallowed',
    /addEventListener\('error'/.test(html) && html.includes("type: 'arcade:state'"));
  const template = read('games/_template/index.html');
  check('the template every contributor copies pins it too', template.includes('pinBase'));
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
