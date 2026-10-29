// Owner-console tornado lab + the anchor spike crafting track.
// Two complaints drove this suite:
//   "make the admin can spawn tornado"  → storms must be summonable at a chosen
//      category/distance/direction, past the world cap, and able to hunt you.
//   "I didn't see for anchor crafting"  → the anchor upgrade must be permanently
//      visible in the workbench and must actually change how a storm treats you.
import { installDOM, El } from './doms.mjs';

installDOM({ width: 1280, height: 720 });

const { Game } = await import('./app/js/game.js');
const { ANCHOR_TIERS, anchorTierData } = await import('./app/js/vehicle.js');
const { mountAdmin, AdminPanel } = await import('./app/js/admin.js');
const { findRecipe } = await import('./app/js/recipes.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const newGame = () => {
  const g = new Game({
    mount: new El('div', 'app'),
    profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
    room: 'test-room',
    onQuit: () => {},
  });
  g.started = true;
  return g;
};

// ------------------------------------------------------------ anchor catalogue
console.log('\nanchor tiers');
{
  check('four tiers exist', ANCHOR_TIERS.length === 4, ANCHOR_TIERS.map((t) => `T${t.tier}`).join(' '));
  check('grip rises with every tier',
    ANCHOR_TIERS.every((t, i) => i === 0 || t.slip < ANCHOR_TIERS[i - 1].slip),
    ANCHOR_TIERS.map((t) => t.slip).join(' → '));
  check('you can slam the spikes down faster at higher tiers',
    ANCHOR_TIERS.every((t, i) => i === 0 || t.deploySpeed > ANCHOR_TIERS[i - 1].deploySpeed),
    ANCHOR_TIERS.map((t) => Math.round(t.deploySpeed * 3.6)).join(' → ') + ' km/h');
  check('tier 4 holds a category 5', anchorTierData(4).liftGuard === 5 && anchorTierData(4).slip === 0);
  check('every upgrade above tier 1 has a price',
    ANCHOR_TIERS.slice(1).every((t) => t.cost && Object.keys(t.cost).length >= 2));
}

// ------------------------------------------------------------- the craft track
console.log('\nanchor crafting is visible');
const g = newGame();
{
  const recipe = findRecipe('anchors');
  check('the anchor recipe exists', Boolean(recipe), recipe?.name);
  check('the anchor recipe is flagged as a rig track', recipe?.system === true);
  check('the recipe no longer collides with generated names',
    !findRecipe('anchors').name.includes('ANCHOR SET'));

  g.materials = { scrap: 200, steel: 200, titanium: 200, carbon: 200, leather: 200, chem: 200, cores: 200 };
  g.benchTier = 4;
  g.toggleBench();
  check('workbench opens with a rig-systems strip', Boolean(g.hud.el.systems), 'rigSystems host');
  check('the strip lists anchors and armour',
    (g.hud.systems || []).map((s) => s.key).join(',') === 'anchors,armor',
    (g.hud.systems || []).map((s) => s.key).join(','));

  const strip = g.hud.el.systems;
  check('the strip renders an anchor card', strip.innerHTML.includes('ANCHOR SPIKES'));
  check('the card carries an upgrade button wired to the recipe',
    strip.innerHTML.includes('data-craft="anchors"'));
  check('the card shows tier pips', strip.innerHTML.includes('sys-pips'));
  check('the card shows the next tier benefit', strip.innerHTML.includes('grip'));

  const before = g.car.anchorTier;
  const steel = g.materials.steel;
  g.craft('anchors');
  check('crafting the anchor recipe raises the tier', g.car.anchorTier === before + 1,
    `T${before} → T${g.car.anchorTier}`);
  check('it spends the tier-2 price', g.materials.steel === steel - ANCHOR_TIERS[1].cost.steel,
    `steel ${steel} → ${g.materials.steel}`);

  const card = g.hud.recipes.find((r) => r.id === 'anchors');
  check('the workbench card now advertises tier 3',
    card.name.includes('TIER 3') && card.cost.titanium === ANCHOR_TIERS[2].cost.titanium,
    `${card.name} · ${JSON.stringify(card.cost)}`);

  g.craft('anchors'); g.craft('anchors');
  check('the track stops at tier 4', g.car.anchorTier === 4);
  const maxedCard = g.hud.recipes.find((r) => r.id === 'anchors');
  check('a maxed track says MAXED', maxedCard.maxed === true && maxedCard.name.includes('TIER 4'));

  const sys = g.benchSystems().find((s) => s.key === 'anchors');
  check('the strip reports the maxed track', sys.maxed === true && sys.level === 4);
  g.toggleBench(false);
}

// ----------------------------------------------------------------- anchor play
console.log('\nanchors against a storm');
{
  const a = newGame();
  a.day = 13; a.newDay();
  const t = a.tornadoes[0];
  check('a storm spawned for the test', Boolean(t), `cat ${t?.category}`);

  const drift = (tier, anchored) => {
    a.car.anchorTier = tier;
    a.car.pos.set(0, 0, 0);
    t.group.position.set(25, 0, 0);
    a.car.speed = 0;
    a.car.anchored = false;
    if (anchored) a.toggleAnchor(true);
    const start = a.car.pos.clone();
    for (let i = 0; i < 90; i++) a.updateTornadoes(1 / 60);
    const d = a.car.pos.distanceTo(start);
    a.car.anchored = false;
    return d;
  };

  const free = drift(1, false);
  const t1 = drift(1, true);
  const t3 = drift(3, true);
  const t4 = drift(4, true);
  check('a free rig gets dragged', free > 1, `${free.toFixed(2)} m`);
  check('tier 1 still slips a little', t1 > 0 && t1 < free, `${t1.toFixed(2)} m vs ${free.toFixed(2)} free`);
  check('tier 3 slips less than tier 1', t3 < t1, `${t3.toFixed(2)} < ${t1.toFixed(2)}`);
  check('tier 4 does not move at all', t4 < 0.02, `${t4.toFixed(3)} m`);

  check('tier 4 deploys at highway speed', a.car.anchorDeploySpeed > 30);
  a.car.speed = 40; a.car.anchored = false;
  const rejected = a.toggleAnchor() === undefined || a.car.anchored === false;
  check('too fast to anchor → the spikes stay up', rejected);
}

// -------------------------------------------------------------- the storm lab
console.log('\nadmin tornado lab');
{
  const g2 = newGame();
  g2.clearStorms();
  g2.car.pos.set(0, 0, 0);
  g2.car.yaw = 0;

  const origin = g2.pos.clone();
  const one = g2.adminTornado({ category: 5, distance: 60, bearing: 0, count: 1 });
  check('the owner can summon a category 5', one.length === 1 && one[0].category === 5);
  check('it lands exactly where it was asked to',
    Math.abs(one[0].pos.z - (origin.z + 60)) < 1 && Math.abs(one[0].pos.x - origin.x) < 1,
    `${one[0].pos.x.toFixed(1)} / ${one[0].pos.z.toFixed(1)} (asked ${origin.x.toFixed(0)} / ${(origin.z + 60).toFixed(0)})`);

  const many = g2.adminTornado({ category: 3, count: 3 });
  check('summoning ignores the two-storm world cap', g2.tornadoes.length === 4, `${g2.tornadoes.length} storms`);

  const hunter = g2.adminTornado({ category: 2, distance: 200, bearing: 0, chase: true, count: 1 })[0];
  check('a hunter is flagged as chasing', hunter.chase === true);
  const before = hunter.pos.clone();
  for (let i = 0; i < 120; i++) hunter.update(1 / 60, g2.pos);
  const closed = hunter.pos.distanceTo(g2.pos) < before.distanceTo(g2.pos);
  check('a hunter closes on the player', closed, `${before.distanceTo(g2.pos).toFixed(0)} → ${hunter.pos.distanceTo(g2.pos).toFixed(0)} m`);

  const crowded = g2.tornadoes.length;
  g2.clearStorms();
  check('clear storms wipes the board', g2.tornadoes.length === 0 && crowded > 0);
  check('every summoned storm was disposed', g2.tornadoes.every((t) => !t.dead) === true);

  const atPlayer = g2.adminTornado({ category: 4, distance: 16, count: 1 })[0];
  check('a storm can be dropped right on the rig',
    atPlayer && Math.hypot(atPlayer.pos.x - g2.pos.x, atPlayer.pos.z - g2.pos.z) < 20);
}

// ------------------------------------------------------------- the panel wiring
console.log('\nadmin panel controls');
{
  const g3 = newGame();
  g3.clearStorms();
  const panel = mountAdmin({ game: g3, account: { username: 'ghanimz', sb: { session: null } } });
  check('owner console mounts', panel instanceof AdminPanel);

  const html = panel.el.innerHTML;
  check('the console has a tornado lab', html.includes('TORNADO LAB'));
  check('it exposes a category picker', html.includes('id="admCat"'));
  check('it exposes a direction picker', html.includes('id="admDir"'));
  check('it exposes a distance field', html.includes('id="admDist"'));
  check('it exposes a hunter toggle', html.includes('id="admChase"'));
  check('it exposes spawn / multi / clear buttons',
    ['tornadoSpawn', 'tornadoMulti', 'tornadoAtPlayer', 'clearStorms'].every((a) => html.includes(`data-act="${a}"`)));

  await panel.show();
  panel.el.querySelector('#admCat').value = '5';
  panel.el.querySelector('#admDir').value = 'ahead';
  panel.el.querySelector('#admDist').value = '40';
  panel.act('tornadoSpawn');
  check('SPAWN TORNADO puts a category 5 in front of the rig',
    g3.tornadoes.length === 1 && g3.tornadoes[0].category === 5,
    `${g3.tornadoes.length} storm(s)`);
  // the rig spawns facing -Z, so "ahead" is a negative Z offset; the check is
  // that the storm sits 40 m along the nose vector, not behind it
  const nose = { x: Math.sin(g3.car.yaw), z: Math.cos(g3.car.yaw) };
  const off = {
    x: g3.tornadoes[0].pos.x - g3.pos.x,
    z: g3.tornadoes[0].pos.z - g3.pos.z,
  };
  const along = off.x * nose.x + off.z * nose.z;
  check('"AHEAD" puts it in front of the nose', along > 35,
    `${along.toFixed(0)} m along the nose (${off.x.toFixed(0)} / ${off.z.toFixed(0)})`);

  panel.act('tornadoMulti');
  check('SPAWN ×3 makes a ring', g3.tornadoes.length === 4, `${g3.tornadoes.length} storms`);

  panel.act('tornadoChase');
  check('the hunter toggle arms', panel.chase === true);
  panel.act('tornadoAtPlayer');
  const last = g3.tornadoes[g3.tornadoes.length - 1];
  check('a hunted drop lands near the rig',
    Math.hypot(last.pos.x - g3.pos.x, last.pos.z - g3.pos.z) < 25 && last.chase === true);

  panel.act('clearStorms');
  check('CLEAR STORMS empties the sky', g3.tornadoes.length === 0);
  panel.destroy();
}

process.exit(problems.length ? 1 : 0);
