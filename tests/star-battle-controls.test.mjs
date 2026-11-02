/**
 * STAR BATTLE — do the controls actually do anything?
 *
 * The audit could not confirm "a distinct response to the gameplay inputs", and
 * that is the right thing to be suspicious of: a control can be wired to a
 * listener, update a flag, and still change nothing on screen. So this suite
 * never calls the game's own helpers (`it.fire()`, `it.torpedo()`). It presses
 * **keys and taps buttons**, runs real frames, and measures what moved:
 *
 *   · W / S     → the ship changes speed, and A / D change its heading
 *   · SPACE     → a beam exists and the phaser heats up
 *   · SHIFT     → a torpedo leaves the rack
 *   · Q         → a warp jump happens (cooldown, distance covered)
 *   · E         → evasive starts its cooldown
 *   · P / ESC   → pause, and resume from the pause card
 *   · the ENGAGE AGAIN button → a new sector, with the RUN LOGGED card gone
 *
 * It also pins the run history the hub hands over: a run logged in the hub must
 * be visible on the launch menu, with a time, even though the frame is
 * sandboxed and its own localStorage is empty.
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

/* ------------------------------------------------------------------- boot */
const posted = [];
const rafQueue = [];
const listeners = {};
const dom = installDOM({ width: 412, height: 915 });

globalThis.window.parent = { postMessage: (msg) => posted.push(msg) };
globalThis.parent = globalThis.window.parent;
// opaque origin, like `sandbox="allow-scripts"`
globalThis.localStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('SecurityError'); },
  removeItem() { throw new Error('SecurityError'); },
};
globalThis.window.localStorage = globalThis.localStorage;
// real listeners this time: the whole point is to press keys
globalThis.addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
globalThis.removeEventListener = () => {};
globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
globalThis.window.devicePixelRatio = 2;
globalThis.document.title = 'Star Battle';

const press = (key, extra = {}) => {
  for (const fn of listeners.keydown || []) fn({ key, preventDefault() {}, ...extra });
};
const release = (key) => {
  for (const fn of listeners.keyup || []) fn({ key, preventDefault() {} });
};
/** One real frame at a fixed step, so a measurement is not a guess. */
let clock = 0;
const frame = (ms = 16) => {
  clock += ms;
  const fn = rafQueue.shift();
  if (fn) fn(clock);
  for (const f of [...rafQueue]) { /* keep the queue honest across a tick */ }
  return Boolean(fn);
};
const click = (id) => {
  const el = globalThis.document.getElementById(id);
  if (!el) return false;
  el.dispatch?.('click');
  return Boolean(el._l?.click || el.onclick || el.dispatch);
};

let bootError = null;
for (const file of ['games/_shared/sdk.js', 'games/star-battle/ships.js', 'games/star-battle/art.js', 'games/star-battle/game.js']) {
  try { vm.runInThisContext(read(file), { filename: file }); } catch (err) { bootError = `${path.basename(file)}: ${err.message}`; break; }
}
const it = globalThis.window.__starBattle;

console.log('\nthe game is up, and listening');
check('every script ran', bootError === null && Boolean(it), bootError || 'sdk, ships, art, game');
check('a key handler is registered', (listeners.keydown || []).length > 0, `${(listeners.keydown || []).length} handler(s)`);
check('it opens on the title card', it?.screen === 'title', it?.screen);

/* ------------------------------------------------------------------ keys */
console.log('\nW and S move the ship');
{
  it.start();
  const ship = () => it.run.ship;
  const before = { x: ship().x, y: ship().y };
  press('w');
  for (let i = 0; i < 30; i++) frame();
  const fast = Math.hypot(ship().vx, ship().vy);
  press('s');
  for (let i = 0; i < 30; i++) frame();
  release('s');
  const slow = Math.hypot(ship().vx, ship().vy);
  check('holding W puts the ship under way', fast > 1, `speed ${fast.toFixed(1)}`);
  check('S brakes it again', slow < fast, `${fast.toFixed(1)} → ${slow.toFixed(1)}`);
  check('…and the ship actually moved across the sector',
    Math.hypot(ship().x - before.x, ship().y - before.y) > 1,
    `${Math.round(Math.hypot(ship().x - before.x, ship().y - before.y))} units`);
  release('w');
}

console.log('\nA and D turn it');
{
  const heading = it.run.ship.facing;
  press('d');
  for (let i = 0; i < 20; i++) frame();
  release('d');
  const turnedRight = it.run.ship.facing;
  press('a');
  for (let i = 0; i < 20; i++) frame();
  release('a');
  const turnedLeft = it.run.ship.facing;
  check('D changes the heading', Math.abs(turnedRight - heading) > 0.05, `${heading.toFixed(2)} → ${turnedRight.toFixed(2)}`);
  check('A turns it back the other way', (turnedLeft - turnedRight) * (turnedRight - heading) < 0,
    `${turnedRight.toFixed(2)} → ${turnedLeft.toFixed(2)}`);
}

console.log('SPACE fires, SHIFT torpedoes');
{
  it.run.ship.phaserHeat = 0;
  it.run.ship.torpedoes = 3;
  // a target dead ahead, so "fired" means "hit something", not "made a noise"
  const target = it.placeEnemy('vengeance', 220, 0);
  it.run.ship.x = 0; it.run.ship.y = 0;
  it.run.ship.facing = 0;
  const shieldsBefore = target ? target.shields : 0;
  press(' ');
  frame();
  check('SPACE fires, and something is damaged', Boolean(target) && target.shields < shieldsBefore,
    target ? `shields ${Math.round(shieldsBefore)} → ${Math.round(target.shields)}` : 'no target');
  check('…and heats the emitter, so it is not a free stream', it.run.ship.phaserHeat > 0,
    `heat ${it.run.ship.phaserHeat.toFixed(1)}`);
  release(' ');
  const rack = it.run.ship.torpedoes;
  press('Shift');
  frame();
  release('Shift');
  check('SHIFT spends a torpedo', it.run.ship.torpedoes === rack - 1, `${rack} → ${it.run.ship.torpedoes}`);
}

console.log('\nQ warps, E evades');
{
  const before = it.warpState;
  press('q');
  for (let i = 0; i < 30; i++) frame();
  release('q');
  const after = it.warpState;
  check('Q starts a warp', after.jumps > before.jumps || after.active > 0 || after.cooldown > 0,
    `jumps ${after.jumps} · cooldown ${after.cooldown.toFixed(1)}`);
  const evadeBefore = it.run.ship.evade || 0;
  press('e');
  frame();
  release('e');
  check('E starts evasive', (it.run.ship.evade || 0) > evadeBefore, `evade ${(it.run.ship.evade || 0).toFixed(1)}s`);
}

console.log('\nP and ESC pause, and the pause card resumes');
{
  press('p');
  frame();
  check('P pauses the battle', it.paused === true);
  click('resumeBtn');
  frame();
  check('the resume button starts it again', it.paused === false);
  press('Escape');
  frame();
  check('ESC pauses too', it.paused === true);
  click('resumeBtn');
  frame();
  check('…and can be resumed', it.paused === false);
}

/* ------------------------------------------------------------ the overlay */
console.log('\nENGAGE AGAIN starts a new sector, with nothing on top of it');
{
  // end this run the way the game ends it
  it.over();
  frame();
  const result = globalThis.document.getElementById('result');
  check('losing the ship shows the result card', !result.classList.contains('hidden'));
  check('…and it is the RUN LOGGED card the hub draws', posted.some((m) => m?.type === 'arcade:score'));

  const waveBefore = it.run.wave;
  it.run.wave = 6;
  click('againBtn');
  frame();
  check('ENGAGE AGAIN puts the game back in the sector', it.screen === 'battle', it.screen);
  check('the result card is gone', result.classList.contains('hidden'));
  check('the new sector starts at wave 1, not the old one', it.run.wave <= waveBefore + 1, `wave ${it.run.wave}`);
  check('a fresh hull, not the wreck', it.run.ship.hull > 0, `${Math.round(it.run.ship.hull)}%`);
}

/* ------------------------------------------------------- the run history */
console.log('\nthe launch menu remembers runs, even sandboxed');
{
  const historyList = globalThis.document.getElementById('historyList');
  const now = Date.now();
  // the SDK listens on `window`; deliver it the way a parent frame would
  dom.win.dispatch('message', {
      origin: 'null',
      data: {
        channel: 'outrun-arcade',
        type: 'arcade:init',
        payload: {
          player: { name: 'GHANIMZ' },
          history: [
            { score: 4200, at: now - 60_000, day: 5, seconds: 44, meta: '9 kills' },
            { score: 900, at: now - 86400_000, day: 2, seconds: 20, meta: '3 kills' },
          ],
        },
      },
  });
  it.title();
  frame();
  const html = historyList.innerHTML;
  check('the launch menu lists the runs the hub knows', /4200/.test(html) && !/NO RUNS LOGGED YET/.test(html), html.slice(0, 90));
  check('…with when they happened', /\d{1,2}:\d{2}|\d{1,2} [A-Z]{3}/.test(html), html.slice(0, 90));
}

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nEVERY CONTROL DOES SOMETHING YOU CAN SEE');
process.exit(problems.length ? 1 : 0);
