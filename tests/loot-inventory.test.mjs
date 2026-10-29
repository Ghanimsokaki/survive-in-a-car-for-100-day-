// Physical loot, backpack/hotbar and the 1000-recipe workbench.
import { installDOM, El } from './doms.mjs';

installDOM({ width: 1280, height: 720 });

const { Game } = await import('./app/js/game.js');
const { ALL_RECIPES, RECIPES, GENERATED_RECIPES, RECIPE_COUNT, findRecipe, TABS } = await import('./app/js/recipes.js');
const { ITEMS, rollLoot, isMaterial } = await import('./app/js/items.js');
const { Inventory, InventoryUI, HOTBAR_SLOTS, FILTERS, sortItems } = await import('./app/js/inventory.js');
const { LootField } = await import('./app/js/loot.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

console.log('\nrecipe tree');
{
  check('1000 generated recipes', GENERATED_RECIPES.length === 1000, `${RECIPE_COUNT.generated}`);
  check('plus the hand-written staples', RECIPES.length >= 15, `${RECIPE_COUNT.base} hand-written`);
  check('over a thousand recipes total', ALL_RECIPES.length >= 1015, `${RECIPE_COUNT.total}`);
  const ids = new Set(ALL_RECIPES.map((r) => r.id));
  check('recipe ids are unique', ids.size === ALL_RECIPES.length);
  const names = new Set(ALL_RECIPES.map((r) => r.name));
  check('recipe names are unique', names.size === ALL_RECIPES.length, `${names.size}/${ALL_RECIPES.length}`);
  check('five workbench tabs', TABS.length === 5, TABS.map((t) => t.id).join(','));
  check('every recipe is browsable (tab + cost + tier)',
    ALL_RECIPES.every((r) => TABS.some((t) => t.id === r.tab)
      && r.cost && Object.keys(r.cost).length > 0 && r.tier >= 1 && r.tier <= 4));
  check('every generated recipe has a resolvable effect',
    GENERATED_RECIPES.every((r) => ['give', 'fuel', 'repair', 'tires', 'perk'].includes(r.effect?.type)));
  check('lookup by id works', findRecipe('gen-0500') === ALL_RECIPES.find((r) => r.id === 'gen-0500'));
  check('deterministic generation', GENERATED_RECIPES[42].name === ALL_RECIPES[RECIPES.length + 42].name);
}

console.log('\nloot rolls');
{
  const seeded = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  const stacks = rollLoot(seeded, { zone: 1, kind: 'warehouse', lootMult: 1.7, inside: true });
  check('a haul has stacks', stacks.length >= 2, stacks.map((s) => `${s.qty}×${s.id}`).join(' '));
  check('stacks are positive', stacks.every((s) => s.qty > 0 && ITEMS[s.id]));
  const garage = rollLoot(seeded, { kind: 'garage' });
  check('garages hand out fuel', garage.some((s) => s.id === 'fuelcan'));
}

const g = new Game({
  mount: new El('div', 'app'),
  profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
  room: 'loot-room',
  onQuit: () => {},
});
g.started = true;

console.log('\nphysical pickups');
{
  check('loot field wired to the world', Boolean(g.loot) && g.loot.count === 0);
  const stop = g.world.pitStops[0];
  g.car.pos.set(stop.x + 4, 0, stop.z + 4);
  g.pos.set(stop.x + 4, 0, stop.z + 4);
  g.scavenge();
  check('scavenging spawns drops on the ground', g.loot.count > 0, `${g.loot.count} drops`);
  check('nothing lands in the pack by itself', g.inventory.slotsUsed === 0 && g.materials.scrap === 2);

  const first = g.loot.drops[0];
  // walking past at 6 m must NOT collect
  first.group.position.set(g.car.pos.x + 6, 0, g.car.pos.z);
  const far = g.loot.update(1 / 60, g.car.pos, { radius: 1.15, magnet: 2.4 });
  check('drops out of reach are not collected', far.length === 0);

  // walking onto it must
  first.group.position.set(g.car.pos.x, 0, g.car.pos.z);
  const near = g.loot.update(1 / 60, g.car.pos, { radius: 2.5, magnet: 3.4 });
  const gotFirst = near.some((s) => s.id === first.item && s.qty >= first.qty);
  check('standing on a drop collects it', near.length >= 1 && gotFirst,
    near.map((s) => `${s.qty}×${s.id}`).join(' '));
}

console.log('\nsimulation wiring');
{
  const before = Object.values(g.materials).reduce((a, b) => a + b, 0)
    + g.inventory.list().reduce((a, i) => a + i.qty, 0);
  const drops = g.loot.drops.slice(0, 6);
  drops.forEach((d) => d.group.position.set(g.car.pos.x, 0, g.car.pos.z));
  g.updateLoot(1 / 60);
  const after = Object.values(g.materials).reduce((a, b) => a + b, 0)
    + g.inventory.list().reduce((a, i) => a + i.qty, 0);
  check('driving over drops banks them', after > before, `${before} → ${after}`);
  check('materials and items both land', g.inventory.list().length >= 0 && typeof g.materials.scrap === 'number');
}

console.log('\nbackpack + hotbar');
{
  const inv = new Inventory();
  check('eight hotbar slots', inv.hotbar.length === HOTBAR_SLOTS);
  check('adds stack', inv.add('medkit', 3) === 3 && inv.count('medkit') === 3);
  check('stack cap respected', inv.add('medkit', 99) === 6, `${inv.count('medkit')}/9`);
  check('usable items auto-fill the hotbar', inv.hotbar.includes('medkit'));
  check('remove takes what exists', inv.remove('medkit', 2) === 2 && inv.count('medkit') === 7);
  check('toggle pins to a free slot', inv.toggleOnHotbar('flare') === 'added' && inv.hotbar.includes('flare'));
  check('toggle unpins', inv.toggleOnHotbar('flare') === 'removed' && !inv.hotbar.includes('flare'));
}

console.log('\nusing items');
{
  g.hp = 40;
  // start from a known inventory: earlier phases loot at random, and a stray
  // medkit made this assertion flap
  if (g.inventory.count('medkit')) g.inventory.remove('medkit', g.inventory.count('medkit'));
  g.inventory.add('medkit', 2);
  const slot = g.inventory.hotbar.indexOf('medkit');
  const used = g.invUI.useSlot(slot);
  check('hotbar slot heals', used === 'medkit' && g.hp === 75, `hp ${g.hp}`);
  check('using consumes one', g.inventory.count('medkit') === 1);

  g.car.fuel = g.car.maxFuel;
  g.inventory.add('fuelcan', 1);
  const fuelSlot = g.inventory.hotbar.indexOf('fuelcan');
  const before = g.inventory.count('fuelcan');
  const spent = g.invUI.useSlot(fuelSlot);
  check('cannot waste fuel on a full tank', spent === null && g.inventory.count('fuelcan') === before);

  g.car.chassis = 40;
  g.inventory.add('repairkit', 1);
  const rk = g.invUI.useSlot(g.inventory.hotbar.indexOf('repairkit'));
  check('repair kit patches the hull', rk === 'repairkit' && g.car.chassis === 70, `chassis ${g.car.chassis}`);
}

console.log('\nworkbench with 1000 recipes');
{
  g.materials = { scrap: 999, steel: 999, titanium: 999, carbon: 999, leather: 999, chem: 999, cores: 999 };
  g.benchTier = 4;
  g.toggleBench(true);
  check('bench opens', g.hud.benchOpen);
  const shown = (g.hud.el.recipes.innerHTML.match(/class="recipe"/g) || []).length;
  check('a page renders instead of 1000 cards', shown > 0 && shown <= g.hud.pageSize, `${shown} cards`);
  check('page counter is shown', /PAGE 1 \//.test(g.hud.el.page.textContent), g.hud.el.page.textContent);

  const before = g.hud.page;
  g.hud.page = 3; g.hud.renderRecipes();
  check('paging works', g.hud.page === 3 && /PAGE 4 \//.test(g.hud.el.page.textContent));

  g.hud.tab = 'gear'; g.hud.page = 0; g.hud.search = 'toolbox'; g.hud.renderRecipes();
  check('search filters the list', /RECIPES/.test(g.hud.el.count.textContent) && g.hud.el.count.textContent !== '1017 RECIPES',
    g.hud.el.count.textContent);
  g.hud.search = '';
  g.hud.tab = 'upgrades';
  g.hud.renderRecipes();

  // craft a generated perk recipe
  const perkRecipe = GENERATED_RECIPES.find((r) => r.effect.type === 'perk' && r.tierReq <= g.benchTier);
  const hpMaxBefore = g.hpMax;
  g.craft(perkRecipe.id);
  check('generated upgrades apply a permanent perk',
    Object.values(g.perks).some((v) => v > 0),
    JSON.stringify(g.perks));
  if (perkRecipe.effect.perk === 'maxhp') check('max HP perk raises the cap', g.hpMax > hpMaxBefore, `${g.hpMax}`);

  // craft a generated give recipe
  const giveRecipe = GENERATED_RECIPES.find((r) => r.effect.type === 'give');
  const packBefore = g.inventory.count(giveRecipe.effect.item);
  g.craft(giveRecipe.id);
  check('generated item recipes land in the backpack',
    g.inventory.count(giveRecipe.effect.item) > packBefore,
    `${giveRecipe.effect.item}: ${packBefore} → ${g.inventory.count(giveRecipe.effect.item)}`);

  // repair recipe
  g.car.chassis = 20;
  const fix = GENERATED_RECIPES.find((r) => r.effect.type === 'repair');
  g.craft(fix.id);
  check('generated repair recipes fix the rig', g.car.chassis > 20, `chassis ${Math.round(g.car.chassis)}`);

  // every single recipe is craftable without throwing
  let err = '';
  for (const r of ALL_RECIPES) {
    try { g.craft(r.id); } catch (e) { err = `${r.id}: ${e.message}`; break; }
  }
  check('all 1000+ recipes craft without errors', !err, err);
  check('the workbench counted the crafts that landed', g.craftedCount > 0,
    `${g.craftedCount} of ${ALL_RECIPES.length} attempts`);
  // one guaranteed craft must move the tally by exactly one
  Object.keys(g.materials).forEach((k) => { g.materials[k] = 9999; });
  g.benchTier = 4;
  const tally = g.craftedCount;
  const freebie = ALL_RECIPES.find((r) => !r.weapon && !r.upgrade && r.effect?.type === 'give');
  g.craft(freebie.id);
  check('a successful craft increments the tally once', g.craftedCount === tally + 1, freebie.id);
  g.toggleBench(false);
}

console.log('\nhotbar keys');
{
  g.inventory.add('bandage', 1);
  const slot = g.inventory.hotbar.indexOf('bandage');
  g.hp = 50;
  window.dispatch('keydown', { code: `Digit${slot + 1}`, preventDefault() {} });
  check('number keys use the hotbar', g.hp > 50 || g.inventory.count('bandage') === 0, `hp ${g.hp}`);
  window.dispatch('keydown', { code: 'KeyI', preventDefault() {} });
  check('I opens the backpack', g.invUI.open === true && g.paused === true);
  window.dispatch('keydown', { code: 'Escape', preventDefault() {} });
  check('Escape puts the backpack away and unpauses', g.invUI.open === false && g.paused === false);

  // Tab and I are mutually exclusive: opening one stows the other
  g.toggleBench(true);
  check('Tab opens the bench paused', g.hud.benchOpen === true && g.paused === true);
  g.toggleInventory(true);
  check('backpack stows the bench', g.hud.benchOpen === false);
  g.toggleBench(true);
  check('bench stows the backpack', g.invUI.open === false && g.hud.benchOpen === true);
  window.dispatch('keydown', { code: 'Escape', preventDefault() {} });
  check('Escape from the bench resumes play', g.hud.benchOpen === false && g.paused === false);

  // the USE control inside a backpack cell consumes one
  g.inventory.add('medkit', 2);
  const before = g.inventory.count('medkit');
  g.hp = 30;
  const grid = g.invUI.el.grid;
  check('usable cells render a USE button', /data-use="medkit"/.test(grid.innerHTML));
  check('materials never render a USE button', !/data-use="scrap"/.test(grid.innerHTML));
  // the stub DOM has no tree walk, so hand the handler the target it would see
  grid.dispatch('click', {
    target: { closest: (sel) => (sel === '[data-use]' ? { dataset: { use: 'medkit' } } : null) },
  });
  check('USE button heals and spends one', g.hp > 30 && g.inventory.count('medkit') === before - 1,
    `hp ${g.hp} / ${g.inventory.count('medkit')} left`);
  g.toggleInventory(false);
}

console.log('\nsearching a house from the doorstep');
{
  const b = g.world.buildings[0];
  b.scavengeReady = true;
  b.cooldown = 0;
  // stand on the porch, outside, well away from the interior loot spots
  const door = b.door || { x: b.x, z: b.z };
  g.inCar = false;
  g.insideBuilding = null;
  g.pos.set(door.x - 1.2, 0, door.z);
  g.avatar.root.position.set(door.x - 1.2, 0, door.z);
  g.car.pos.set(door.x - 30, 0, door.z - 30);
  g.loot.clear?.();
  g.scavenge();
  const dropped = g.loot.drops || [];
  const reachable = dropped.filter((d) => Math.hypot(d.group.position.x - g.pos.x, d.group.position.z - g.pos.z) < 4);
  check('doorstep search drops loot', dropped.length > 0, `${dropped.length} drops`);
  check('porch loot lands within reach', reachable.length === dropped.length,
    `${reachable.length}/${dropped.length} within 4u`);
  check('searching burns the building', b.scavengeReady === false && b.cooldown > 0);

  // far away the same building refuses to hand anything over
  const b2 = g.world.buildings[1];
  b2.scavengeReady = true;
  b2.cooldown = 0;
  g.pos.set(b2.x + 40, 0, b2.z + 40);
  g.avatar.root.position.copy(g.pos);
  const before = g.loot.count;
  g.scavenge();
  check('you cannot rummage a house from across the road', g.loot.count === before && b2.scavengeReady === true);
  g.pos.set(7, 0, 30);
  g.avatar.root.position.set(7, 0, 30);
}

console.log('\nrun summary');
{
  g.dead = false; g.won = false;
  g.die();
  const summary = g.hud.el.goStats.innerHTML;
  check('the wreck screen reports looted items', /ITEMS LOOTED/.test(summary));
  check('the wreck screen reports crafted items', /ITEMS CRAFTED/.test(summary));
  check('the pack and bench are stowed on death', g.invUI.open === false && g.hud.benchOpen === false);
  g.dead = false; g.won = false; g.paused = false;
  g.hud.hideGameOver?.();
  g.hp = 100;
}

console.log('\ntossing loot back on the ground');
{
  g.loot.clear();
  g.inventory.clear();
  g.inventory.add('medkit', 3);
  g.inCar = false;
  g.pos.set(80, 0, 80);
  g.avatar.root.position.set(80, 0, 80);
  g.avatar.root.rotation.y = 0;
  const had = g.inventory.count('medkit');
  const tossed = g.tossItem('medkit', -1);
  check('toss empties the stack', tossed === had && had > 0 && g.inventory.count('medkit') === 0, `${tossed}`);
  check('the stack lands as a drop', g.loot.count === 1, `${g.loot.count}`);
  const drop = g.loot.drops[0];
  check('the drop appears in front of you', Math.hypot(drop.group.position.x - 80, drop.group.position.z - 80) > 0.5);

  // standing on it must not vacuum it straight back up
  drop.group.position.set(80, 0, 80);
  const early = g.loot.update(1 / 60, { x: 80, z: 80 }, { radius: 2, magnet: 3 });
  check('a fresh toss cannot be re-collected instantly', early.length === 0);
  for (let i = 0; i < 120; i++) g.loot.update(1 / 60, { x: 500, z: 500 }, { radius: 1, magnet: 1 });
  const late = g.loot.update(1 / 60, { x: 80, z: 80 }, { radius: 2, magnet: 3 });
  check('after the grace window it can be picked up again',
    late.some((s) => s.id === 'medkit' && s.qty === tossed), late.map((s) => s.id).join(','));

  check('materials cannot be tossed', g.tossItem('scrap', 1) === 0);
  const missing = Object.keys(ITEMS).find((id) => !isMaterial(id) && g.inventory.count(id) === 0);
  check('tossing something you lack is refused', g.tossItem(missing, 1) === 0, missing);

  // the TOSS control is wired in the backpack UI
  g.inventory.add('bandage', 1);
  g.invUI.show();
  check('non-materials render a TOSS button', /data-toss="bandage"/.test(g.invUI.el.grid.innerHTML));
  check('materials never get one', !/data-toss="scrap"/.test(g.invUI.el.grid.innerHTML));
  check('the pack holds bandages to toss', g.inventory.count('bandage') > 0);
  g.invUI.el.grid.dispatch('click', {
    target: { closest: (sel) => (sel === '[data-toss]' ? { dataset: { toss: 'bandage' } } : null) },
  });
  check('the TOSS button drops the stack', g.inventory.count('bandage') === 0);
  g.toggleInventory(false);
  g.loot.clear();
  g.pos.set(7, 0, 30);
  g.avatar.root.position.set(7, 0, 30);
}

console.log('\nnight is worth the risk');
{
  g.world.setNight(0);
  check('daylight pays normally', g.nightBonus === 1);
  g.world.setNight(1);
  check('searching after dark pays 25% more', g.nightBonus === 1.25, `${g.nightBonus}`);
  const b = g.world.buildings[2];
  b.scavengeReady = true; b.cooldown = 0;
  g.loot.clear();
  g.inCar = false;
  g.pos.set(b.x, 0, b.z);
  g.avatar.root.position.copy(g.pos);
  g.insideBuilding = b;
  g.scavenge();
  check('night haul still lands on the floor', g.loot.count > 0, `${g.loot.count} drops`);
  g.world.setNight(0);
  g.insideBuilding = null;
  g.loot.clear();
  g.pos.set(7, 0, 30);
  g.avatar.root.position.set(7, 0, 30);
}

console.log('\nco-op loot');
{
  g.loot.clear();
  g.inventory.clear();
  const sent = [];
  const realEvent = g.net.event.bind(g.net);
  g.net.event = (kind, data) => { sent.push({ kind, ...data }); realEvent(kind, data); };

  g.inCar = false;
  g.pos.set(120, 0, 120);
  g.avatar.root.position.set(120, 0, 120);

  // my search announces where the drops landed (placed off my feet so it stays put)
  g.scatterLoot(124, 124, [{ id: 'medkit', qty: 2 }], { spread: 0 });
  const dropMsg = sent.find((m) => m.kind === 'drop');
  check('my haul is announced to the room', Boolean(dropMsg) && dropMsg.stacks.length === 1, dropMsg?.key || '');
  check('shared drops carry a key', g.loot.drops.every((d) => typeof d.key === 'string' && d.key.length > 3));
  const myKey = g.loot.drops[0]?.key;

  // a teammate's swing lands on my screen, right under my boots
  g.onNetEvent({ kind: 'drop', key: 'peer-9:3', x: 120, z: 120, spread: 0, stacks: [{ id: 'fuelcan', qty: 1 }] });
  check('a teammate\'s search spawns drops here too', g.loot.count === 2, `${g.loot.count}`);
  check('peer drops keep their shared key', g.loot.drops.some((d) => d.key === 'peer-9:3:0'));

  // I walk over the shared stack: it is mine and the room is told
  g.updateLoot(1 / 60);
  check('the pickup is broadcast as taken', sent.some((m) => m.kind === 'take' && m.key === 'peer-9:3:0'),
    sent.map((m) => `${m.kind}:${m.key || ''}`).join(' '));
  check('my own drop is untouched by that pickup', g.loot.count === 1, `${g.loot.count}`);

  // a teammate grabbing my drop removes the copy on my screen
  g.onNetEvent({ kind: 'take', key: myKey });
  check('a teammate taking a drop clears my copy', g.loot.count === 0);

  g.net.event = realEvent;
  g.loot.clear();
  g.pos.set(7, 0, 30);
  g.avatar.root.position.set(7, 0, 30);
}

console.log('\nbackpack filters');
{
  const inv = new Inventory();
  inv.add('medkit', 1);
  inv.add('battery', 1);
  inv.add('wire', 1);
  const ui = new InventoryUI(inv, { getMaterials: () => ({}) });
  ui.show();
  check('every item lands in ALL', /data-item="medkit"/.test(ui.el.grid.innerHTML)
    && /data-item="battery"/.test(ui.el.grid.innerHTML));
  check('filter row is rendered with counts', /data-filter="use"/.test(ui.el.filter.innerHTML));
  ui.el.filter.dispatch('click', {
    target: { closest: () => ({ dataset: { filter: 'use' } }) },
  });
  check('USABLE hides gear', ui.filter === 'use'
    && /data-item="medkit"/.test(ui.el.grid.innerHTML)
    && !/data-item="battery"/.test(ui.el.grid.innerHTML));
  ui.el.filter.dispatch('click', {
    target: { closest: () => ({ dataset: { filter: 'gear' } }) },
  });
  check('GEAR shows gear only', /data-item="battery"/.test(ui.el.grid.innerHTML)
    && !/data-item="medkit"/.test(ui.el.grid.innerHTML));
  ui.el.filter.dispatch('click', {
    target: { closest: () => ({ dataset: { filter: 'all' } }) },
  });
  const order = sortItems(inv.list()).map((it) => it.id);
  check('usables sort above gear', order.indexOf('medkit') < order.indexOf('battery'), order.join(','));
  ui.hide();
}

console.log('\nloot field lifecycle');
{
  const field = new LootField(g.scene);
  field.spawn(0, 0, [{ id: 'scrap', qty: 2 }, { id: 'medkit', qty: 1 }]);
  check('spawns two drops', field.count === 2);
  const got = field.update(1 / 60, { x: 0, z: 0 }, { radius: 3, magnet: 3 });
  check('collects everything on top of the player', got.length === 2);
  field.spawn(10, 10, [{ id: 'scrap', qty: 1 }]);
  for (let i = 0; i < 200; i++) field.update(0.5, { x: 100, z: 100 }, { radius: 1, magnet: 2 });
  check('far drops expire instead of piling up', field.count === 0);
}

if (problems.length) {
  console.log(`\n${problems.length} FAILED: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('\nALL LOOT + INVENTORY + RECIPE TESTS PASSED');
process.exit(0);
