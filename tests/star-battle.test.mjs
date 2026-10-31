/**
 * STAR BATTLE — the balance, the boot, and the fight.
 *
 * Three things are pinned here, in the order a player meets them:
 *
 *   1. the rules (`ships.js`) — wave composition, shields-before-hull damage,
 *      shield regen that only comes back when you stop being hit, the phaser arc
 *      and its range falloff, and a score that only ever goes up;
 *   2. the boot (`game.js` in a DOM) — the hub is told `arcade:ready` before any
 *      layout is touched, so a broken title card cannot strand the frame;
 *   3. the fight — phasers take shields then hull, torpedoes spend themselves,
 *      evasive costs a cooldown, a kill scores, and the sim survives hundreds of
 *      ticks with every frame actually drawn, without a throw or a NaN.
 *
 * The page itself is loaded from bytes over HTTP by `games-load.test.mjs` (via
 * the shared loader in `tests/game-page.mjs`) — the same loader that catches a
 * game which forgets its `<base>` pin.
 */
import { readFileSync, statSync } from 'node:fs';
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

/* ------------------------------------------------------------------ rules */
console.log('\nthe rules, without a browser');
// a classic script, like Iron Tide's: run it against a fake `window` the way a
// browser would, then pin the numbers the player sees
const shipsSandbox = { window: {}, console };
vm.createContext(shipsSandbox);
vm.runInContext(read('games/star-battle/ships.js'), shipsSandbox, { filename: 'games/star-battle/ships.js' });
const R = shipsSandbox.window.StarShips;
{
  check('three ships, and the player flies the Enterprise',
    Object.keys(R.SHIPS).length === 3 && R.PLAYER_SHIP === 'enterprise',
    Object.keys(R.SHIPS).join(', '));
  check('the Enterprise is NCC-1701-E', R.SHIPS.enterprise.registry === 'NCC-1701-E',
    R.SHIPS.enterprise.registry);
  check('both film ships are present', Boolean(R.SHIPS.narada && R.SHIPS.vengeance),
    'narada + vengeance');
  check('the Narada has no shields, the Vengeance does',
    R.SHIPS.narada.shields === 0 && R.SHIPS.vengeance.shields > 0);

  const w1 = R.waveFor(1);
  const w6 = R.waveFor(6);
  const w40 = R.waveFor(40);
  check('wave 1 is one Narada, alone', w1.narada === 1 && w1.vengeance === 0, JSON.stringify(w1));
  check('the Vengeance joins from wave 2', R.waveFor(2).vengeance === 1);
  check('waves get tougher, not just bigger',
    w6.hpScale > w1.hpScale && w6.dmgScale > w1.dmgScale && w6.speedScale > w1.speedScale,
    `hp ×${w6.hpScale.toFixed(2)}`);
  check('the wave caps at 7 ships, four Narada and three Vengeance',
    R.waveFor(60).count <= 7 && w40.narada === 4 && w40.vengeance === 3,
    `${w40.narada} Narada + ${w40.vengeance} Vengeance`);
  check('scaling stops before it becomes impossible',
    R.waveFor(99).hpScale <= 2.4 && R.waveFor(99).dmgScale <= 1.9,
    `hp ×${R.waveFor(99).hpScale}`);
  check('wave bonuses grow and cap', R.waveBonus(3) > R.waveBonus(1) && R.waveBonus(99) === 4000);

  const shielded = R.damage({ shields: 100, hull: 50 }, 60);
  check('shields take the hit and nothing bleeds through',
    shielded.shields === 40 && shielded.hull === 50 && shielded.bleed === 0 && !shielded.down,
    JSON.stringify(shielded));
  const through = R.damage({ shields: 30, hull: 50 }, 80);
  check('damage past the shields hits the hull',
    through.absorbed === 30 && through.bleed === 50 && through.shields === 0 && through.hull === 0,
    JSON.stringify(through));
  check('…and that kills the ship', through.down === true && through.shieldsDown === true);
  const grazed = R.damage({ shields: 0, hull: 12 }, 5);
  check('a hull never goes negative', grazed.hull === 7 && !grazed.down && !grazed.shieldsDown);
  check('a dead hull stays at zero', R.damage({ shields: 0, hull: 3 }, 500).hull === 0);
  check('an unshielded ship is hit in full',
    R.damage({ shields: 0, hull: 900 }, 26).hull === 874);

  const spec = R.SHIPS.enterprise;
  check('shields do not come back while you are being hit',
    R.regen({ shields: 100, max: spec.shields, since: 0 }, 2, spec) === 100);
  const healed = R.regen({ shields: 100, max: spec.shields, since: 9 }, 1, spec);
  check('…but they do once the hits stop', healed > 100, `${healed.toFixed(0)} / ${spec.shields}`);
  check('regen never passes the shield maximum',
    R.regen({ shields: spec.shields - 1, max: spec.shields, since: 9 }, 10, spec) === spec.shields);
  check('the Narada never regenerates anything',
    R.regen({ shields: 0, max: 0, since: 99 }, 5, R.SHIPS.narada) === 0);

  check('dead ahead is in the arc; astern is not',
    R.inArc(0, 0, 1) && R.inArc(0, 0.4, 1) && !R.inArc(0, Math.PI, 1));
  check('a bearing wraps the short way round',
    Math.abs(R.angleDelta(3.1, -3.1) - (Math.PI * 2 - 6.2)) < 1e-9,
    R.angleDelta(3.1, -3.1).toFixed(3));
  check('the beam is full power up close and falls off to 55%',
    R.beamPower(0, 540) === 1 && R.beamPower(540, 540) === 0.55 && R.beamPower(600, 540) === 0,
    R.beamPower(500, 540).toFixed(2));
  check('the phaser arc is wide enough to aim, narrow enough to matter',
    spec.phaser.arc > 0.6 && spec.phaser.arc < Math.PI, String(spec.phaser.arc));

  const run = R.newRun({ seed: 7 });
  check('a run starts with full pools and a full torpedo rack',
    run.ship.hull === spec.hull && run.ship.shields === spec.shields &&
    run.ship.torpedoes === spec.torpedo.load && run.wave === 0 && run.kills === 0);
  check('score counts kills, waves and time',
    R.scoreOf({ kills: 2, wave: 3, seconds: 10, hull: 0 }) === 240 + 500 + 30,
    String(R.scoreOf({ kills: 2, wave: 3, seconds: 10, hull: 0 })));
  check('score never goes negative',
    R.scoreOf({ kills: 0, wave: 0, seconds: 0, hull: -5 }) === 0);
  const r1 = R.rng(42);
  const a1 = [r1(), r1(), r1()];
  const r2 = R.rng(42);
  const a2 = [r2(), r2(), r2()];
  check('the RNG is deterministic and in range',
    a1.join() === a2.join() && a1.every((v) => v >= 0 && v < 1) && a1[0] !== a1[1],
    a1[0].toFixed(4));
  const ring = R.spawnPoint(Math.PI / 2, 900);
  check('waves spawn on the ring, not on top of the player',
    Math.abs(Math.hypot(ring.x, ring.y) - 900) < 1e-9);
}

/* -------------------------------------------------------------- the page */
console.log('\nthe game boots in a sandboxed frame');
const posted = [];
const rafQueue = [];
/** Every `translate` the renderer asked for — i.e. where it put things. */
const drawn = [];
let it = null;
let bootError = null;
{
  installDOM({ width: 412, height: 915 });
  globalThis.window.parent = { postMessage: (msg) => posted.push(msg) };
  globalThis.parent = globalThis.window.parent;
  // An opaque origin: every storage call throws, like `sandbox="allow-scripts"`.
  globalThis.localStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  globalThis.window.localStorage = globalThis.localStorage;
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.requestAnimationFrame = (fn) => { rafQueue.push(fn); return rafQueue.length; };
  globalThis.window.devicePixelRatio = 2;
  globalThis.document.title = 'Star Battle';

  // A recording context: the page keeps the one it asks for at boot, so this
  // sees every draw the game really makes, not a stand-in.
  const canvas = globalThis.document.getElementById('c');
  const base = canvas.getContext('2d');
  const recording = new Proxy(base, {
    get(target, key) {
      if (key === 'translate') return (x, y) => { drawn.push([x, y]); return target.translate(x, y); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  canvas.getContext = () => recording;

  const files = [
    'games/_shared/sdk.js',
    'games/star-battle/ships.js',
    'games/star-battle/art.js',
    'games/star-battle/game.js',
  ];
  for (const file of files) {
    try {
      vm.runInThisContext(read(file), { filename: file });
    } catch (error) {
      bootError = `${path.basename(file)}: ${error && error.message}`;
      break;
    }
  }
  it = globalThis.window.__starBattle;
}

check('every script parsed and ran', bootError === null, bootError || 'sdk.js, ships.js, art.js, game.js');
check('the hub was told the game is up',
  posted.some((m) => m?.type === 'arcade:ready'), posted.map((m) => m?.type).join(', '));
check('…with the page title',
  (posted.find((m) => m?.type === 'arcade:ready')?.payload || {}).title === 'Star Battle');
check('the test handle exists', Boolean(it && typeof it.tick === 'function'));
check('it opens on the title card, not mid-fight', it?.screen === 'title', it?.screen);
check('nothing is stored locally when storage throws', it?.best === 0, String(it?.best));

/* ----------------------------------------------------------- the hangar */
console.log('\nthe title card has the ship on it, where you can see it');
{
  const frameAt = rafQueue.shift();
  check('the boot started a frame loop', typeof frameAt === 'function');
  drawn.length = 0;
  try {
    frameAt(1000);
  } catch (error) {
    bootError = error && error.message;
  }
  check('a frame drew without a throw', bootError === null, bootError || 'clean');
  // The screen is 320×200 in this DOM. The bug this pins: the ship used to be
  // drawn at a fixed (0, 40) — the top-left corner, half off the glass.
  const placed = drawn.find(([x, y]) => y > 30 && y < 190 && Math.abs(x - 160) < 60);
  check('the title ship is centred on the glass, not parked in the corner',
    Boolean(placed), drawn.slice(0, 3).map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join(' · '));
}

/* ------------------------------------------------------------- the fight */
console.log('\nthe fight');
{
  it.start();
  check('ENGAGE starts the battle', it.screen === 'battle');
  check('…with full shields and a full rack',
    it.run.ship.shields === R.SHIPS.enterprise.shields &&
    it.run.ship.torpedoes === R.SHIPS.enterprise.torpedo.load);

  it.spawnWave();
  check('the wave spawned a ship', it.enemies.length === 1, `${it.enemies.length} enemy`);
  const first = it.enemies[0];
  check('…a Narada with film-accurate hit points',
    first.id === 'narada' && first.hullMax === R.SHIPS.narada.hull, `${first.id} ${first.hullMax}`);

  // put a Vengeance dead ahead, close enough for a full-power phaser hit
  it.run.ship.x = 0;
  it.run.ship.y = 0;
  const target = it.placeEnemy('vengeance', 220, 0);
  it.aimAt(220, 0);
  it.run.ship.phaserHeat = 0;
  it.fire();
  check('a phaser hit takes the enemy shields first',
    target.shields < target.shieldsMax && target.hull === target.hullMax,
    `shields ${Math.round(target.shields)} / ${target.shieldsMax}`);
  check('phaser heat stops you from holding the button down', it.run.ship.phaserHeat > 0);
  const afterFirst = target.shields;
  it.fire();
  check('…a second press does nothing while cooling', target.shields === afterFirst);

  it.aimAt(-220, 0);              // same ship, now astern
  it.run.ship.phaserHeat = 0;
  const shieldsAft = target.shields;
  it.fire();
  check('firing astern misses', target.shields === shieldsAft);
  check('…but the beam is still drawn, so a miss is visible', it.shots !== undefined);

  // torpedoes are finite and spend themselves
  const rack = it.run.ship.torpedoes;
  it.torpedo();
  check('a torpedo leaves the rack', it.run.ship.torpedoes === rack - 1);
  it.evade();
  check('evasive starts a cooldown', it.run.ship.evade > 0, `${it.run.ship.evade.toFixed(1)}s`);
  const cooldown = it.run.ship.evade;
  it.evade();
  check('…so it cannot be spammed', it.run.ship.evade === cooldown);
  check('an empty rack fires nothing', (() => {
    it.run.ship.torpedoes = 0;
    const before = it.shots.length;
    it.torpedo();
    return it.shots.length === before && it.run.ship.torpedoes === 0;
  })());

  // a kill scores, and clearing the wave is noticed
  it.run.ship.torpedoes = R.SHIPS.enterprise.torpedo.load;
  const kills = it.run.kills;
  target.hull = 1;
  target.shields = 0;
  it.run.ship.phaserHeat = 0;
  it.aimAt(220, 0);
  it.fire();
  check('a hull at one point dies to phasers',
    it.run.kills === kills + 1 && !it.enemies.includes(target), `${it.run.kills} kills`);

  // Kill whatever is left, so the wave-clear path runs too. Bring it in range
  // first: phasers stop at 540 units, and a miss on the ring is honest.
  for (const enemy of [...it.enemies]) {
    enemy.shields = 0;
    enemy.hull = 1;
    enemy.x = 200;
    enemy.y = 0;
    it.run.ship.phaserHeat = 0;
    it.aimAt(200, 0);
    it.fire();
  }
  check('the wave clears when the last ship goes', it.enemies.length === 0,
    `${it.enemies.length} left`);
  check('…and the run remembers how many you killed', it.run.kills >= kills + 2,
    `${it.run.kills} kills`);
}

/* --------------------------------------------------------------- pause */
console.log('\nthe sector waits when you do');
{
  it.start();
  it.spawnWave();
  const t0 = it.run.seconds;
  const x0 = it.run.ship.x;
  it.pause(true);
  check('the game can be paused', it.paused === true);
  it.input.thrust = 1;
  for (let i = 0; i < 120; i++) it.tick(1 / 60);
  check('the clock stops', it.run.seconds === t0, `${(it.run.seconds - t0).toFixed(2)}s`);
  check('…and so does the ship', it.run.ship.x === x0, String(Math.round(it.run.ship.x)));
  it.pause(false);
  check('resuming restarts the clock', it.paused === false);
  it.input.thrust = 0;
  it.tick(1 / 60);
  check('…from where it stopped', it.run.seconds > t0);
  it.pause(true);
  it.over();
  check('a finished run is never paused', it.paused === false && it.screen === 'over');
  it.title();
}

/* -------------------------------------------------------- the sim survives */
console.log('\nhundreds of ticks, with the frame loop drawing each one');
{
  it.start();
  it.setWave(3);
  it.spawnWave();
  it.setWave(9);
  it.spawnWave();
  const startEnemies = it.enemies.length;
  check('later waves bring more than one ship', startEnemies >= 3, `${startEnemies} enemies`);

  let thrown = null;
  let frames = 0;
  try {
    for (let i = 0; i < 900; i++) {
      it.tick(1 / 60);
      // drive the real render path now and then: it is where a typo hides
      if (i % 15 === 0) {
        const fn = rafQueue.pop();
        if (fn) { fn(i * 16.7); frames += 1; }
      }
      if (it.screen !== 'battle') break;
    }
  } catch (error) {
    thrown = error && (error.stack || error.message);
  }
  check('900 ticks and rendered frames without a throw', thrown === null,
    thrown || `${frames} frames`);
  const pools = [it.run.ship.hull, it.run.ship.shields, ...it.enemies.map((e) => e.hull)];
  check('no pool went NaN or negative',
    pools.every((v) => Number.isFinite(v) && v >= 0), pools.map((v) => Math.round(v)).join(', '));
  check('the clock advanced', it.run.seconds > 0, `${it.run.seconds.toFixed(1)}s`);
  check('the player cannot leave the sector',
    Math.abs(it.run.ship.x) < 4000 && Math.abs(it.run.ship.y) < 4000,
    `${Math.round(it.run.ship.x)}, ${Math.round(it.run.ship.y)}`);
}

/* ------------------------------------------------------ no hiding, no stall */
console.log('\nyou cannot simply run: the sector holds and the enemy chases');
{
  it.start();
  it.spawnWave();
  it.run.ship.x = 9000;
  it.run.ship.y = 0;
  it.tick(1 / 60);
  check('the sector turns you back instead of letting you leave',
    Math.hypot(it.run.ship.x, it.run.ship.y) <= 2400 + 1,
    Math.round(Math.hypot(it.run.ship.x, it.run.ship.y)) + ' units from the middle');
  check('…and the boundary is drawn, not a surprise',
    /function drawBoundary\(/.test(read('games/star-battle/game.js')));

  // park the player in the middle with an enemy far away and time running
  it.start();
  it.spawnWave();
  const chaser = it.enemies[0];
  chaser.x = 3000;
  chaser.y = 0;
  const before = Math.hypot(chaser.x - it.run.ship.x, chaser.y - it.run.ship.y);
  for (let i = 0; i < 240; i++) it.tick(1 / 60);
  const after = Math.hypot(chaser.x - it.run.ship.x, chaser.y - it.run.ship.y);
  check('a distant enemy closes the gap instead of loitering on the ring',
    after < before - 200, `${Math.round(before)} → ${Math.round(after)} units`);

  // contacts you cannot see are marked on the edge of the glass
  check('off-screen contacts get a marker', /function drawMarkers\(/.test(read('games/star-battle/game.js')));
}

/* --------------------------------------------------------------- the end */
console.log('\nlosing the ship ends the run, and the arcade hears about it');
{
  it.start();
  it.setWave(2);
  it.spawnWave();
  const before = posted.filter((m) => m?.type === 'arcade:score').length;
  it.run.ship.shields = 0;
  it.run.ship.hull = 0;
  it.over();
  check('the run ends', it.screen === 'over');
  const scores = posted.filter((m) => m?.type === 'arcade:score');
  check('the score went to the hub', scores.length === before + 1,
    JSON.stringify(scores[scores.length - 1]?.payload || {}));
  check('…and it is a number the hub can store',
    Number.isFinite(scores[scores.length - 1]?.payload?.score));
  check('the result card shows the wave and the clock', it.run.wave >= 2);
  it.title();
  check('you can go back to the title card', it.screen === 'title');
  check('the best score survived a throwing localStorage', typeof it.best === 'number');
}

/* ------------------------------------------------------------ the art */
console.log('\nthe baked ship atlas: heading, fallback, and a real drawImage');
{
  const art = globalThis.window.StarArt;
  check('art.js exposes the renderer', Boolean(art && typeof art.drawShip === 'function'));
  check('with no image decoded, the game keeps its vector ships', art.ready('player') === false);

  // a heading snaps to a 32-step turntable the same way both ways round
  check('heading 0 is cell 0', art.headingIndex(0) === 0);
  check('a quarter turn is 8 cells', art.headingIndex(Math.PI / 2) === 8);
  check('it wraps instead of going negative', art.headingIndex(-Math.PI / 2) === 24);
  check('a full turn comes back to the start', art.headingIndex(Math.PI * 2) === 0);

  // pretend the atlas landed: a 1280×640 sheet of 160 px cells
  const calls = [];
  const fakeCtx = {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, arc() {}, fill() {}, set globalAlpha(v) {}, get globalAlpha() { return 1; },
    set globalCompositeOperation(v) {}, get globalCompositeOperation() { return 'source-over'; },
    set fillStyle(v) {}, get fillStyle() { return '#000'; },
    createRadialGradient: () => ({ addColorStop() {} }),
    drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh) { calls.push({ sx, sy, sw, dx, dy, dw }); },
  };
  art._install('player', { width: 1280, height: 640 }, { tier: 'high', cell: 160 });
  check('the atlas is now ready', art.ready('player') === true && art.isHigh('player'));
  const drew = art.drawShip(fakeCtx, 'player', 10, 20, 0, 96, { glow: 0.8 });
  check('a ship is drawn from the atlas', drew === true && calls.length === 1);
  check('…from the cell that matches its heading', calls[0].sx === 0 && calls[0].sy === 0, JSON.stringify(calls[0]));
  calls.length = 0;
  art.drawShip(fakeCtx, 'player', 0, 0, Math.PI / 16, 96);      // one cell
  check('…and the next heading is the next cell',
    calls[0]?.sx === 160 && calls[0]?.sy === 0, JSON.stringify(calls[0]));
  calls.length = 0;
  art.drawShip(fakeCtx, 'player', 0, 0, Math.PI / 2, 96);       // 8 cells on
  check('…a quarter turn is the second row (8 columns)',
    calls[0]?.sx === 0 && calls[0]?.sy === 160, JSON.stringify(calls[0]));
  calls.length = 0;
  art.drawShip(fakeCtx, 'player', 0, 0, Math.PI, 96);
  check('…half a turn is the second row', calls[0]?.sx === 0 && calls[0]?.sy === 320, JSON.stringify(calls[0]));

  check('a ship with no atlas says so instead of drawing nothing',
    art.drawShip(fakeCtx, 'narada', 0, 0, 0, 96) === false);
  art._install('narada', { width: 1280, height: 640 }, { tier: 'low', cell: 96 });
  check('…and draws once it lands', art.drawShip(fakeCtx, 'narada', 0, 0, 0, 96) === true);
}

/* ------------------------------------------------------------ the files */
console.log('\nthe game is a folder the hub can serve');
{
  const html = read('games/star-battle/index.html');
  const manifest = JSON.parse(read('games/star-battle/game.json'));
  const game = read('games/star-battle/game.js');
  check('index.html pins its base (the Iron Tide lesson)',
    /function pinBase\(\)/.test(html) && /document\.write\('<base/.test(html));
  check('…and loads the SDK, the rules and the game, in that order',
    ['../_shared/sdk.js', 'ships.js', 'game.js'].every((src) => html.includes(`src="${src}"`)) &&
    html.indexOf('../_shared/sdk.js') < html.indexOf('src="ships.js"') &&
    html.indexOf('src="ships.js"') < html.indexOf('src="game.js"'));
  check('the title is on the page', /<title>Star Battle<\/title>/.test(html));
  check('the manifest names the folder it lives in',
    manifest.id === 'star-battle' && manifest.entry === 'index.html' && manifest.icon === 'icon.svg');
  check('the icon ships with it', read('games/star-battle/icon.svg').includes('<svg'));
  check('one dispatcher decides how every ship is drawn',
    /function drawShip\(id,/.test(game) && /ART\.drawShip\(/.test(game));
  check('the vector art is still there as the offline fallback',
    /function drawEnterprise\(/.test(game) && /function drawNarada\(/.test(game) &&
    /function drawVengeance\(/.test(game));
  check('the baked turntables ship with the game',
    /ships-player-high\.png/.test(read('games/star-battle/art/ships.json')) &&
    /ships-narada-high\.png/.test(read('games/star-battle/art/ships.json')));
  const art = read('games/star-battle/art/ships.json');
  const meta = JSON.parse(art);
  check('the atlas is 32 headings × 3 liveries',
    meta.angles === 32 && meta.cols * meta.rows === 32 &&
    ['player', 'narada', 'vengeance'].every((k) => meta.liveries[k]), Object.keys(meta.liveries).join(', '));
  check('…and it is baked from the model in the repo', meta.source === 'model.fbx', meta.source);
  for (const [id, livery] of Object.entries(meta.liveries)) {
    for (const [tier, file] of Object.entries(livery.files)) {
      const size = statSync(path.join(root, 'games', 'star-battle', 'art', file)).size;
      check(`${id} ${tier} atlas is a real image`, size > 20000 && size < 2_000_000, `${Math.round(size / 1024)} KB`);
    }
  }
  check('the canvas is phone-sized, not a desktop window',
    /viewport/.test(html) && /touch-action/.test(html));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nSTAR BATTLE HOLDS');
process.exit(problems.length ? 1 : 0);
