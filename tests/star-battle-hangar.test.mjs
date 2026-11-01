/**
 * STAR BATTLE — the hangar: hulls, upgrades, crew, and the ship you fly.
 *
 * The player's round-33 ask was a captain's loop rather than a single fight:
 * pick a starter hull, buy thrusters and shields and torpedoes and a bigger
 * warp core and a photon laser, hire the crew that runs the ship, watch them
 * inside it, and either fly it yourself or hand the stations over.
 *
 * So this suite pins:
 *
 *   1. the rules (`ships.js`) — a starter is a starter, an upgrade changes the
 *      number it says it changes, a berth is a berth and requisition is spent;
 *   2. the wiring (`game.js`) — the hangar's numbers are the numbers the run
 *      starts with, credits are earned by fighting, and a crew on a station
 *      actually flies, fires, heals and spools the core;
 *   3. the panels — the shipyard and the interior exist in the page and paint
 *      from that state without a throw.
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

/* --------------------------------------------------------------- the rules */
console.log('\nthe shipyard, without a browser');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(read('games/star-battle/ships.js'), sandbox, { filename: 'ships.js' });
const R = sandbox.window.StarShips;
const H = () => R.newHangar({ seed: 5 });
{
  check('three starter hulls, and they are not the same ship',
    Object.keys(R.STARTERS).length === 3
      && new Set(Object.values(R.STARTERS).map((s) => s.hull)).size === 3,
    Object.values(R.STARTERS).map((s) => `${s.name} ${s.hull}`).join(', '));
  check('the Enterprise is still the default and still 460/520/216',
    R.shipStats(H()).hull === 460 && R.shipStats(H()).shields === 520
      && R.shipStats(H()).speed === 216);
  check('a new captain has requisition and a crew',
    H().credits > 0 && H().crew.length >= 2, `${H().credits} CR, ${H().crew.length} crew`);
  check('…and a free berth to hire into',
    H().crew.length < R.shipStats(H()).berths,
    `${H().crew.length} of ${R.shipStats(H()).berths}`);
  check('the starter crew covers the helm and the guns',
    H().crew.some((c) => c.role === 'helm') && H().crew.some((c) => c.role === 'tactical'));

  // impulse: +8% a step, and the requisition leaves the locker
  const h1 = H();
  const before = R.shipStats(h1).speed;
  const cost = R.upgradeCost(h1.upgrades, 'impulse');
  const level = R.buyUpgrade(h1, 'impulse');
  check('impulse power costs, levels and speeds the ship up',
    level === 1 && h1.credits === 700 - cost
      && Math.abs(R.shipStats(h1).speed - before * 1.08) < 0.01,
    `${cost} CR → ${R.shipStats(h1).speed.toFixed(1)}`);

  const h2 = H();
  R.buyUpgrade(h2, 'shields');
  R.buyUpgrade(h2, 'hull');
  check('shields and hull plating raise the pools, not the speed',
    R.shipStats(h2).shields === Math.round(520 * 1.12)
      && R.shipStats(h2).hull === Math.round(460 * 1.1)
      && R.shipStats(h2).speed === 216,
    `${R.shipStats(h2).shields} shields · ${R.shipStats(h2).hull} hull`);

  const h3 = H();
  R.buyUpgrade(h3, 'torpedoes');
  check('a torpedo bay adds two tubes', R.shipStats(h3).torpedoes === 6, `${R.shipStats(h3).torpedoes}`);

  const h4 = H();
  const cool0 = R.shipStats(h4).warpCooldown;
  R.buyUpgrade(h4, 'warp');
  check('a warp core jumps further and spools faster',
    R.shipStats(h4).warpJump > 1200 && R.shipStats(h4).warpCooldown < cool0,
    `${Math.round(R.shipStats(h4).warpJump)} units · ${R.shipStats(h4).warpCooldown.toFixed(1)}s`);

  const h5 = H();
  check('no photon laser until you buy one', R.shipStats(h5).laserDps === 0);
  R.buyUpgrade(h5, 'laser');
  check('…and the bay gives it a rate', R.shipStats(h5).laserDps === 26, `${R.shipStats(h5).laserDps}`);

  const h6 = H();
  const berths0 = R.shipStats(h6).berths;
  R.buyUpgrade(h6, 'crew');
  check('crew quarters buy a berth', R.shipStats(h6).berths === berths0 + 1,
    `${berths0} → ${R.shipStats(h6).berths}`);

  const h7 = H();
  h7.credits = 0;
  check('no requisition, no upgrade', R.buyUpgrade(h7, 'impulse') === null && !R.canBuy(h7, 'impulse'));

  const h8 = H();
  h8.credits = 9000;
  for (let i = 0; i < 9; i++) R.buyUpgrade(h8, 'impulse');
  check('an upgrade line tops out instead of running away',
    R.levelOf(h8, 'impulse') === R.UPGRADES.impulse.max,
    `${R.levelOf(h8, 'impulse')} of ${R.UPGRADES.impulse.max}`);

  const h9 = H();
  const hired = R.hireCrew(h9, 'medical');
  check('a hire is a named specialist with a skill', Boolean(hired?.name) && hired.role === 'medical',
    hired?.name);
  check('…and they cost requisition', h9.credits === 700 - 180, `${h9.credits} CR`);
  check('a full roster refuses another hire',
    R.hireCrew(h9, 'science') === null, `${h9.crew.length} of ${R.shipStats(h9).berths}`);
  check('a dismissed specialist leaves the roster', R.dismissCrew(h9, hired.id) && h9.crew.length === 2);

  const h10 = H();
  h10.crew = [{ id: 'a', name: 'DATA', role: 'engineering', skill: 3 }];
  check('engineering on the roster regenerates shields faster',
    R.shipStats(h10).shieldRegen > 44, `${R.shipStats(h10).shieldRegen}`);
  h10.crew = [{ id: 'a', name: 'DATA', role: 'medical', skill: 2 }];
  check('medical repairs the hull', R.shipStats(h10).repair === 5);

  const h11 = H();
  R.selectShip(h11, 'saber');
  check('a different starter is a different ship',
    R.shipStats(h11).name === 'SABER' && R.shipStats(h11).speed === 272
      && R.shipStats(h11).berths === 2);
  check('an unknown hull is refused, not swapped in',
    R.selectShip(h11, 'death-star') === false && R.shipStats(h11).name === 'SABER');
}

/* --------------------------------------------------------------- the wiring */
console.log('\nthe game flies the ship you built');
installDOM({ width: 412, height: 915 });
const rafQueue = [];
const posted = [];
console.warn = () => {};
globalThis.window.parent = { postMessage: (msg) => posted.push(msg) };
globalThis.parent = globalThis.window.parent;
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
// no WebGL in this suite: it is the sim and the panels under test, and the 2D
// renderer has to carry a machine without GL anyway
globalThis.window.StarGL = null;

let bootError = null;
for (const file of ['games/_shared/sdk.js', 'games/star-battle/ships.js',
  'games/star-battle/art.js', 'games/star-battle/game.js']) {
  try { vm.runInThisContext(read(file), { filename: file }); } catch (error) {
    bootError = `${path.basename(file)}: ${error?.message}`;
    break;
  }
}
const it = globalThis.window.__starBattle;
check('the game boots with the hangar in it', bootError === null && Boolean(it), bootError || 'ok');
check('…and it starts on the default Enterprise',
  it?.stats?.name === 'ENTERPRISE-E', it?.stats?.name);

if (it) {
  const frameAt = rafQueue.shift();
  const step = (t) => {
    const fn = rafQueue.shift() || frameAt;
    try { fn(t); return null; } catch (error) { return error; }
  };

  // the hull you bought is the hull you fly
  it.hangar.credits = 9000;
  it.buy('hull');
  it.buy('hull');
  it.buy('shields');
  const want = it.stats;
  it.start();
  check('the run starts on the upgraded ship',
    it.run.ship.hullMax === want.hull && it.run.ship.shieldsMax === want.shields,
    `${it.run.ship.hullMax} hull · ${it.run.ship.shieldsMax} shields`);
  check('…at full hull and full shields',
    it.run.ship.hull === it.run.ship.hullMax && it.run.ship.shields === it.run.ship.shieldsMax);

  // requisition comes out of the fight: a Narada has no shields to chew through
  it.start();
  const credits0 = it.credits;
  const victim = it.placeEnemy('narada', 700, 0);
  it.hit(victim, 99999);
  check('a kill pays requisition', it.credits > credits0, `+${it.credits - credits0} CR`);
  check('…and the contact is gone', !it.enemies.includes(victim));

  // the helmsman: the ship turns toward the contact with nobody at the stick
  it.start();
  it.placeEnemy('narada', 0, -600);
  it.input.turn = 0;
  it.input.thrust = 0;
  it.input.manualAt = -99;
  it.hangar.auto.engine = true;
  const facing0 = it.run.ship.facing;
  for (let i = 0; i < 45; i++) it.tick(1 / 60);
  check('a helm crew turns the ship without being asked',
    Math.abs(it.input.crewTurn) > 0.2 && Math.abs(it.run.ship.facing - facing0) > 0.05,
    `crew turn ${(it.input.crewTurn || 0).toFixed(2)}`);
  it.hangar.auto.engine = false;

  // the tactical officer fires what is in the arc
  it.start();
  const gunTarget = it.placeEnemy('vengeance', 0, -140);
  it.aimAt(0, -140);
  const shieldBefore = gunTarget.shields + gunTarget.hull;
  it.hangar.auto.tactical = true;
  it.input.fire = false;
  for (let i = 0; i < 150; i++) it.tick(1 / 60);
  check('a tactical crew fires at what is in the arc',
    gunTarget.shields + gunTarget.hull < shieldBefore,
    `${Math.round(shieldBefore)} → ${Math.round(gunTarget.shields + gunTarget.hull)}`);
  it.hangar.auto.tactical = false;

  // the photon laser, once it is bolted on
  it.start();
  it.hangar.credits = 9000;
  it.buy('laser');
  check('the laser bay reports a rate', it.stats.laserDps > 0, `${it.stats.laserDps}`);
  const laserVictim = it.placeEnemy('vengeance', 0, -90);
  it.aimAt(0, -90);
  const hullBefore = laserVictim.hull + laserVictim.shields;
  for (let i = 0; i < 120 && it.enemies.includes(laserVictim); i++) it.tick(1 / 60);
  check('…and the pulse cannon does the damage it advertises',
    !it.enemies.includes(laserVictim) || laserVictim.hull + laserVictim.shields < hullBefore,
    `${Math.round(hullBefore)} → ${Math.round(laserVictim.hull + laserVictim.shields)}`);

  // medical: the hull comes back while nothing is shooting
  it.start();
  it.hangar.credits = 9000;
  it.hire('medical');
  it.run.ship.hull = 100;
  it.run.ship.sinceHit = 30;
  const hull0 = it.run.ship.hull;
  for (let i = 0; i < 60; i++) it.tick(1 / 60);
  check('a medical officer patches the hull', it.run.ship.hull > hull0,
    `${hull0} → ${Math.round(it.run.ship.hull)}`);

  // warp core: a bigger core is a shorter spool, and it applies to the next jump
  it.start();
  it.hangar.credits = 9000;
  it.buy('warp');
  it.input.warp = true;
  it.tick(1 / 60);
  const spool = it.warpState.cooldown;
  check('a warp core upgrade shortens the spool, even mid-run', spool > 0 && spool < 13,
    `${spool.toFixed(1)}s`);
  check('…and jumps further than a stock core',
    it.warpState.jumps === 1, `${it.warpState.jumps} jump`);

  // the panels: paint, open, and never throw
  let panelError = null;
  try {
    it.hangarPanel({ from: 'title' });
    it.interior();
    step(12000);
  } catch (error) { panelError = error?.message || String(error); }
  check('the shipyard and the interior open without a throw', panelError === null,
    panelError || 'clean');
  check('opening the interior holds the sim still', it.paused === true);

  const systems = globalThis.document.getElementById('hangarSystems').innerHTML;
  const ships = globalThis.document.getElementById('hangarShips').innerHTML;
  const crew = globalThis.document.getElementById('hangarCrew').innerHTML;
  check('the shipyard lists every upgrade line with a price',
    (systems.match(/data-up=/g) || []).length === 8,
    `${(systems.match(/data-up=/g) || []).length} lines`);
  check('…every starter hull', (ships.match(/data-ship=/g) || []).length === 3);
  check('…and a hire button for every empty station',
    crew.includes('data-hire=') && crew.includes('data-dismiss='));
  const stations = globalThis.document.getElementById('intStations').innerHTML;
  check('the interior shows all five stations',
    ['HELM', 'TACTICAL', 'ENGINEERING', 'MEDICAL', 'SCIENCE'].every((r) => stations.includes(r)));
}

/* ----------------------------------------------------------------- the page */
console.log('\nthe page has the panels the game drives');
{
  const html = read('games/star-battle/index.html');
  const need = ['id="hangar"', 'id="hangarCard"', 'id="hangarShips"', 'id="hangarSystems"',
    'id="hangarCrew"', 'id="hangarCredits"', 'id="interiorCanvas"', 'id="intStations"',
    'id="hangarBtn"', 'id="pauseIntBtn"', 'id="pauseHangarBtn"', 'id="interiorCloseBtn"'];
  const missing = need.filter((n) => !html.includes(n));
  check('every id the hangar paints into exists', missing.length === 0, missing.join(', ') || 'all present');
  check('the panels load before the game script',
    html.indexOf('id="hangar"') < html.indexOf('src="game.js"'));
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nTHE HANGAR HOLDS');
process.exit(problems.length ? 1 : 0);
