// IRON TIDE — the ship builder, the dock economy and the auto-landscape helper.
// The fleet rules are a classic script (the game runs in an opaque-origin
// iframe), so they are executed here with a fake window, exactly like a browser
// would, and every number the player sees gets pinned.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './doms.mjs';

installDOM({ width: 1280, height: 720 });

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '..', 'games', 'iron-tide', 'fleet.js'), 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const R = sandbox.window.FleetRules;

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

// ------------------------------------------------------------------ catalogue
console.log('\nship catalogue');
{
  check('the rules module exposes itself', Boolean(R), 'window.FleetRules');
  check('four hulls, cheapest first', R.HULLS.length === 4
    && R.HULLS.every((h, i) => i === 0 || h.cost > R.HULLS[i - 1].cost),
    R.HULLS.map((h) => `${h.name} ${h.cost}`).join(' · '));
  check('the starter skiff is free', R.HULLS[0].id === 'skiff' && R.HULLS[0].cost === 0);
  // the carrier trades a weapon slot for the flight deck, on purpose
  check('bigger hulls carry more slots (carrier trades one for the deck)',
    R.HULLS[1].slots > R.HULLS[0].slots && R.HULLS[2].slots > R.HULLS[1].slots
    && R.HULLS[3].slots < R.HULLS[2].slots,
    R.HULLS.map((h) => `${h.name}:${h.slots}`).join(' '));
  check('bigger hulls are slower', R.HULLS.every((h, i) => i === 0 || h.speed < R.HULLS[i - 1].speed));
  check('a carrier exists for jets', R.HULLS.some((h) => h.id === 'carrier'));
  check('six module types', R.MODULES.length === 6, R.MODULES.map((m) => m.kind).join(','));
  check('four jets, escalating', R.JETS.length === 4
    && R.JETS.every((j, i) => i === 0 || j.cost > R.JETS[i - 1].cost),
    R.JETS.map((j) => j.name).join(' · '));
  check('a new admiral starts with a skiff and one gun',
    R.newFleet().hull === 'skiff' && R.newFleet().modules[0] === 'light-cannon');
  check('a new admiral cannot afford a carrier', R.newFleet().credits < R.hullCost('carrier'),
    `${R.newFleet().credits} < ${R.hullCost('carrier')}`);
}

// -------------------------------------------------------------------- loadout
console.log('\nloadouts');
{
  const skiff = R.computeLoadout({ hull: 'skiff', modules: ['light-cannon', 'heavy-cannon', 'torpedo'] });
  check('extra modules beyond the slots are ignored, not charged',
    skiff.fitted.length === 2 && skiff.ignored.length === 1 && skiff.cost === 460,
    `${skiff.fitted.length} fitted / ${skiff.ignored.length} ignored · ${skiff.cost} cr`);

  const destroyer = R.computeLoadout({
    hull: 'destroyer', modules: ['light-cannon', 'heavy-cannon', 'torpedo', 'torpedo', 'armour', 'engine'],
  });
  check('a destroyer fits all six', destroyer.fitted.length === 6, destroyer.fitted.join(','));
  check('armour adds hull', destroyer.hp > R.HULLS[2].hp, `${destroyer.hp} hull`);
  check('engines add speed', destroyer.speed > R.HULLS[2].speed, `${destroyer.speed}`);
  check('dps sums the guns and torpedoes', destroyer.dps > 30, `${destroyer.dps} dps`);
  check('torpedoes extend the range past the cannons', destroyer.range === 460, `${destroyer.range} m`);
  check('the cost is the sum of the modules',
    destroyer.cost === 120 + 340 + 420 + 420 + 300 + 280, `${destroyer.cost} cr`);

  const bare = R.computeLoadout({ hull: 'corvette', modules: [] });
  check('a bare hull has no dps', bare.dps === 0);
  check('an unknown hull falls back to the skiff', R.computeLoadout({ hull: 'submarine', modules: [] }).hull === 'skiff');
  check('an unknown module is ignored', R.computeLoadout({ hull: 'corvette', modules: ['railgun'] }).fitted.length === 0);
  check('flak is counted separately for jet defence',
    R.computeLoadout({ hull: 'corvette', modules: ['flak'] }).flak === 1);
}

// ----------------------------------------------------------------- purchases
console.log('\ndock economy');
{
  const poor = R.buy('carrier', 'hull', 100, { hulls: ['skiff'] });
  check('you cannot buy what you cannot afford', !poor.ok && poor.reason.includes('more credits'), poor.reason);

  const rich = R.buy('carrier', 'hull', 6000, { hulls: ['skiff'] });
  check('affording a hull spends exactly its price', rich.ok && rich.credits === 6000 - 5200, `${rich.credits} left`);

  const twice = R.buy('carrier', 'hull', 9000, { hulls: ['carrier'] });
  check('owning a hull blocks a double purchase', !twice.ok && twice.reason.includes('already'), twice.reason);

  const jet = R.buy('interceptor', 'jet', 1000, { hulls: ['skiff'] });
  check('jets are bought straight from the dock', jet.ok && jet.credits === 280, `${jet.credits} left`);
  check('an unknown item is refused', !R.buy('submarine', 'jet', 9999, {}).ok);
  check('the hull track has no discount for the starter',
    R.hullCost('skiff') === 0 && R.hullCost('nope') === Infinity);
}

// -------------------------------------------------------------------- fleets
console.log('\nenemy fleets and rewards');
{
  const first = R.enemyFleet(1);
  const later = R.enemyFleet(8);
  check('sortie 1 is a single raider', first.length === 1, `${first.length} ship`);
  check('later sorties send more ships', later.length > first.length, `${first.length} → ${later.length}`);
  check('fleets are capped so a phone can render them', later.length <= 6);
  check('enemy hulls get tougher over time', later[0].hp > first[0].hp, `${first[0].hp} → ${later[0].hp}`);
  check('every enemy has a name', later.every((e) => e.name && e.name.length > 2));

  const win = R.battleReward({ kills: 4, survived: true, sortie: 2 });
  const loss = R.battleReward({ kills: 4, survived: false, sortie: 2, hullLost: true });
  check('winning pays more than losing', win.credits > loss.credits, `${win.credits} vs ${loss.credits}`);
  check('sinking ships always pays something', loss.credits > 0, `${loss.credits} cr`);
  check('surviving boosts the score', win.score > loss.score);
  check('a doomed run reads honestly',
    R.verdict({ survived: false, kills: 3, hullLost: true }).includes('BREACH'),
    R.verdict({ survived: false, kills: 3, hullLost: true }));
  check('a clean sweep is celebrated',
    R.verdict({ survived: true, kills: 5 }).includes('ANNIHILATED'));
  check('losing everything is stated plainly',
    R.verdict({ survived: false, kills: 0 }).includes('ALL HANDS'));
}

// ------------------------------------------------------- a full fleet campaign
console.log('\ncampaign loop');
{
  const fleet = R.newFleet();
  // earn enough to buy a corvette and a jet, exactly as a player would
  let guard = 0;
  while (fleet.credits < 900 + 260 && guard++ < 40) {
    const reward = R.battleReward({ kills: 3, survived: true, sortie: 1 });
    fleet.credits += reward.credits;
  }
  check('grinding sorties funds an upgrade', fleet.credits >= 1160, `${fleet.credits} cr after ${guard} sorties`);

  const hull = R.buy('corvette', 'hull', fleet.credits, fleet);
  fleet.credits = hull.credits;
  fleet.hulls.push('corvette');
  fleet.hull = 'corvette';
  const jet = R.buy('scout', 'jet', fleet.credits, fleet);
  fleet.credits = jet.credits;
  fleet.jets.push('scout');

  const lo = R.computeLoadout({ hull: fleet.hull, modules: fleet.modules });
  check('the fitted corvette keeps its gun', lo.hull === 'corvette' && lo.guns === 1);
  check('the jet is in the hangar', fleet.jets.length === 1);
  check('a corvette launches one jet', R.HULLS.find((h) => h.id === fleet.hull).id !== 'carrier');
  check('the hull is recorded in the dock', fleet.hulls.includes('corvette') && fleet.hulls.includes('skiff'));
}

// ------------------------------------------------------------ auto landscape
console.log('\nauto landscape');
{
  const { installAutoLandscape, requestLandscape, isPortrait, landscapeState, onOrientation } =
    await import('./app/js/orientation.js');
  const listeners = [];
  globalThis.window.addEventListener = (t, fn) => listeners.push([t, fn]);

  const state = installAutoLandscape({ when: 'any' });
  check('installing is idempotent', installAutoLandscape({ when: 'any' }) === state);
  check('it listens for the events that matter',
    listeners.some(([t]) => t === 'orientationchange') && listeners.some(([t]) => t === 'resize')
    && listeners.some(([t]) => t === 'pointerdown'),
    listeners.map(([t]) => t).join(','));

  check('portrait is detected from the viewport', typeof isPortrait() === 'boolean');
  check('landscape state is reported', typeof landscapeState().portrait === 'boolean'
    && typeof landscapeState().locked === 'boolean');
  check('asking for landscape never throws', typeof (await requestLandscape()) === 'boolean');
  check('callbacks can be unsubscribed', typeof onOrientation(() => {}) === 'function');

  const { stageSize, toStagePoint, isRotatedStage } = await import('./app/js/orientation.js');
  const { innerWidth: VW, innerHeight: VH } = globalThis.window;

  const upright = stageSize();
  check('an upright app renders at the viewport size',
    upright.w === VW && upright.h === VH && upright.rotated === false,
    `${upright.w}×${upright.h}`);

  document.body.classList.add('auto-land', 'run-live');
  check('the rotated stage is detected', isRotatedStage() === true);

  const stage = stageSize();
  check('a rotated stage swaps the axes',
    stage.w === VH && stage.h === VW && stage.rotated === true, `${stage.w}×${stage.h}`);

  // the CSS is rotate(90deg) about the top-left corner: stage (x,y) lands on
  // screen (VW - y, x). toStagePoint must be its exact inverse.
  const cases = [
    [0, 0], [40, 0], [stage.w, 0], [stage.w, stage.h], [0, stage.h], [stage.w / 2, stage.h / 2],
  ];
  let worst = 0;
  for (const [x, y] of cases) {
    const sx = VW - y;
    const sy = x;
    const back = toStagePoint(sx, sy);
    worst = Math.max(worst, Math.abs(back.x - x), Math.abs(back.y - y));
  }
  check('touch coordinates map back into stage space', worst < 1e-6, `max error ${worst}`);

  const left = toStagePoint(VW - stage.h / 2, stage.w * 0.2);
  check('a touch on the left half stays on the left half',
    left.x < stage.w / 2, `stage x ${left.x.toFixed(1)} of ${stage.w}`);

  check('a mid-screen drag points the same way it looks',
    Math.abs(toStagePoint(VW / 2, VH / 2).x - stage.w / 2) < 1
    && Math.abs(toStagePoint(VW / 2, VH / 2).y - stage.h / 2) < 1);

  document.body.classList.remove('auto-land', 'run-live');
  check('un-rotating restores the viewport size', stageSize().rotated === false);
}

// ------------------------------------------------------- the game boots clean
console.log('\nirontide boots');
{
  // feed the game exactly what the iframe gives it: the SDK stub + the rules
  const scored = [];
  globalThis.window.Arcade = {
    ready: () => true,
    fit: (c) => ({ w: c.clientWidth, h: c.clientHeight, dpr: 1 }),
    score: (p) => { scored.push(p); return true; },
    on: () => globalThis.window.Arcade,
    state: () => true,
    close: () => true,
  };
  // the page loads fleet.js first; mirror that ordering in this context
  globalThis.window.FleetRules = R;
  globalThis.Arcade = globalThis.window.Arcade;
  // game.js is a classic script: bare addEventListener/performance land on window
  const savedAdd = globalThis.addEventListener;
  globalThis.addEventListener = (...args) => globalThis.window.addEventListener(...args);
  const gameSrc = readFileSync(path.join(here, '..', 'games', 'iron-tide', 'game.js'), 'utf8');
  let bootError = '';
  try {
    vm.runInThisContext(gameSrc, { filename: 'iron-tide/game.js' });
  } catch (e) {
    bootError = e.message;
  }
  globalThis.addEventListener = savedAdd;
  check('the game script boots against the SDK', !bootError, bootError);
  const tide = globalThis.window.__ironTide;
  check('the debug handle is exposed', Boolean(tide));

  if (tide) {
    check('it starts on the dock', tide.screen === 'dock');
    check('a new fleet has a skiff with one gun',
      tide.fleet.hull === 'skiff' && tide.fleet.modules.length === 1);
    check('the loadout preview has dps', tide.loadout().dps > 0, `${tide.loadout().dps} dps`);

    tide.startBattle();
    check('sail into battle switches screens', tide.screen === 'battle' && Boolean(tide.session));
    check('the enemy fleet matches the rules', tide.session.ships.length === R.enemyFleet(1).length);
    check('the ship starts at full hull', tide.session.hull === tide.session.maxHull);

    // steer and shoot for two simulated seconds
    tide.session.keys.up = true;
    tide.session.keys.fire = true;
    for (let i = 0; i < 120; i++) tide.tick(1 / 60);
    check('throttle moves the ship', Math.hypot(tide.session.vel.x, tide.session.vel.y) > 0.5,
      `${Math.hypot(tide.session.vel.x, tide.session.vel.y).toFixed(2)} m/s`);
    check('firing spends rounds', tide.session.shots > 0, `${tide.session.shots} broadsides`);
    check('the sim survives 120 frames without throwing', true);

    // finish the fight: sink everything, then check the payout
    const before = tide.fleet.credits;
    tide.session.ships.forEach((s) => { s.dead = true; s.hp = 0; });
    tide.tick(1 / 60);
    check('clearing the fleet ends the battle', tide.screen === 'result');
    check('the payout lands in the wallet', tide.fleet.credits > before, `${before} → ${tide.fleet.credits}`);
    check('the sortie is counted', tide.fleet.sorties === 1);
    check('a score was reported to the hub', scored.length === 1 && scored[0].won === true,
      scored.length ? JSON.stringify(scored[0]).slice(0, 60) : 'none');
    check('the score carries the kills in its meta', scored[0]?.meta?.includes('kills'));

    tide.backToDock();
    check('returning to the dock resets the session', tide.screen === 'dock' && tide.session === null);

    // losing path
    tide.startBattle();
    tide.session.hull = 1;
    tide.session.ships.forEach((s) => { s.dead = true; s.hp = 0; });
    tide.session.hull = 0;
    tide.tick(1 / 60);
    check('running out of hull ends the sortie', tide.screen === 'result');
    check('a loss still counts as a run', tide.fleet.sorties === 2);
    check('a loss still reports a score', scored.length === 2 && scored[1].won === false);
  }
}

process.exit(problems.length ? 1 : 0);
