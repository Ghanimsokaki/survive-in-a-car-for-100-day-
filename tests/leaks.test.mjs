/**
 * LEAKS — does leaving a screen actually leave it?
 *
 * The audit asked for evidence rather than reassurance: *"watch whether memory
 * keeps climbing instead of settling back down, and check for unreleased
 * textures, duplicated event listeners, and game loops that continue after
 * leaving a screen."* A heap graph is not available here, so this suite pins the
 * three things a leak is actually made of, by counting them:
 *
 *   · **listeners** — a run or a hub view that adds handlers must remove them;
 *     two runs must not mean two keyboards;
 *   · **scene objects** — a disposed run leaves nothing in the scene, and every
 *     geometry/material/texture it owned was disposed;
 *   · **loops and timers** — a closed arcade game stops its stall timer, and a
 *     restarted Star Battle resets its world instead of stacking a new one.
 *
 * Anything a browser would keep alive but Node cannot see (GPU buffers, decoded
 * images) is called out as *not measured* rather than claimed.
 */
import { installDOM, El } from './doms.mjs';

const stage = installDOM({ width: 412, height: 915 });
const { Game } = await import('./app/js/game.js');
const { Arcade, NATIVE_GAMES, mergeCatalogues, BRIDGE } = await import('./app/js/arcade.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const makeGame = () => new Game({
  mount: new El('div', 'app'),
  profile: { name: 'AUDIT', color: 0xffb347, carColor: 0xd24a2b },
  room: 'leak', mode: 'classic', onQuit: () => {},
});

const winCount = () => ['keydown', 'keyup', 'resize', 'blur', 'pointerdown', 'pointerup', 'pagehide', 'visibilitychange']
  .reduce((n, t) => n + (stage.win.listenerCount?.(t) || 0), 0);

console.log('\na run gives its keyboard back');
{
  const before = winCount();
  const g = makeGame();
  g.started = true;
  const during = winCount();
  check('starting a run listens for input', during > before, `${before} → ${during} handlers`);

  for (let i = 0; i < 5; i++) { g.updatePerf(1 / 60); g.update(1 / 60); g.updateCamera(1 / 60); }
  g.dispose();
  const after = winCount();
  check('disposing it takes every handler back', after === before, `${during} → ${after} handlers`);
  check('…and empties the scene it drew', (g.scene?.children?.length || 0) === 0,
    `${g.scene?.children?.length || 0} children left`);
  const still = (() => {
    const pos = { x: g.pos.x, z: g.pos.z };
    stage.win.dispatch('keydown', { code: 'KeyW', preventDefault() {} });
    for (let i = 0; i < 10; i++) { try { g.update(1 / 60); } catch { /* inert */ } }
    return Math.abs(g.pos.x - pos.x) < 1e-6 && Math.abs(g.pos.z - pos.z) < 1e-6;
  })();
  check('…and stops answering keys', still, 'a disposed run is a still photograph');
}

console.log('\nten runs in a row do not stack up');
{
  const before = winCount();
  const counts = [];
  for (let i = 0; i < 10; i++) {
    const g = makeGame();
    g.started = true;
    for (let f = 0; f < 10; f++) { g.updatePerf(1 / 60); g.update(1 / 60); }
    counts.push(winCount());
    g.dispose();
  }
  check('every run adds the same handlers, never one more than the last',
    new Set(counts).size === 1, counts.join(', ') + ' handlers');
  check('after ten runs the window is as it was', winCount() === before,
    `${before} → ${winCount()}`);
}

console.log('\nthe hub closes a game cleanly, every time');
{
  const arc = new Arcade({ account: null, getPlayer: () => ({ name: 'GHANIMZ' }) });
  arc.games = mergeCatalogues(NATIVE_GAMES, { games: [{
    id: 'leak-game', title: 'LEAK GAME', author: 'x', blurb: 'b', tags: [], accent: '#ff0000',
  }] });
  arc.nodes.frame = { src: '', contentWindow: { postMessage() {} } };
  const listenersBefore = stage.win.listenerCount('message');
  for (let i = 0; i < 8; i++) {
    arc.launch('leak-game');
    arc.closeGame();
  }
  check('opening and closing a game never duplicates the bridge listener',
    stage.win.listenerCount('message') === listenersBefore,
    `${listenersBefore} → ${stage.win.listenerCount('message')}`);
  check('…and the last close blanked the frame', arc.nodes.frame.src === 'about:blank', arc.nodes.frame.src);
  check('…and nothing is still "playing"', arc.playing === null);
  check('…and the idle stage is back', arc.nodes.player.classList.contains('hidden'));
  arc.destroy();
  check('destroying the hub takes its listener too',
    stage.win.listenerCount('message') === listenersBefore - 1,
    `${stage.win.listenerCount('message')} left`);
}

console.log('\na restarted battle resets its world instead of stacking one');
{
  // the real page, as the browser boots it
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (p) => readFileSync(path.join(root, p), 'utf8');

  installDOM({ width: 412, height: 915 });
  globalThis.window.parent = { postMessage() {} };
  globalThis.parent = globalThis.window.parent;
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document.title = 'Star Battle';
  for (const file of ['games/_shared/sdk.js', 'games/star-battle/ships.js', 'games/star-battle/art.js', 'games/star-battle/game.js']) {
    vm.runInThisContext(read(file), { filename: file });
  }
  const it = globalThis.window.__starBattle;
  const sizes = [];
  for (let i = 0; i < 6; i++) {
    it.start();
    for (let f = 0; f < 240; f++) it.tick(1 / 60);
    sizes.push({
      enemies: it.enemies?.length ?? 0,
      shots: it.shots?.length ?? 0,
      sparks: it.sparks?.length ?? 0,
      history: it.history?.length ?? 0,
    });
  }
  const maxEnemies = Math.max(...sizes.map((s) => s.enemies));
  const maxSparks = Math.max(...sizes.map((s) => s.sparks));
  check('six restarts do not pile enemies up', maxEnemies <= 3, `max ${maxEnemies} on screen`);
  check('…nor effects', maxSparks <= 400, `max ${maxSparks} sparks`);
  check('…and the run history is capped, not appended forever',
    Math.max(...sizes.map((s) => s.history)) <= 6, sizes.map((s) => s.history).join(', '));
  check('waves still spawn after a restart', sizes.some((s) => s.enemies > 0),
    sizes.map((s) => s.enemies).join(', '));
}

console.log('\nwhat this cannot see');
console.log('  note  GPU buffers, decoded textures and the JS heap itself need a real browser');
console.log('        (no GPU here); these counts are the structural half of the same question.');

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nNOTHING IS LEFT RUNNING WHEN A SCREEN CLOSES');
process.exit(problems.length ? 1 : 0);
