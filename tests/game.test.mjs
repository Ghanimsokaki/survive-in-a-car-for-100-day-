// Regression test for the simulation itself (runs without a browser).
import { installDOM, El } from './doms.mjs';

installDOM({ width: 1280, height: 720 });
const { Game, RECIPES } = await import('./app/js/game.js');

const problems = [];
process.on('uncaughtException', (e) => { console.error('uncaught', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('unhandled', e); process.exit(1); });

const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const g = new Game({
  mount: new El('div', 'app'),
  profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
  room: 'test-room',
  onQuit: () => {},
});
g.started = true;

const step = (n, keys = {}) => {
  for (let i = 0; i < n; i++) {
    Object.assign(g.keys, keys);
    g.update(1 / 60);
    g.updateCamera(1 / 60);
  }
};

step(900, { forward: 1 });
check('car drives', g.car.distance > 50, `${g.car.distance.toFixed(0)} m`);
check('fuel is consumed', g.car.fuel < 20, `${g.car.fuel.toFixed(1)} L`);

g.car.speed = 0;
g.toggleAnchor();
check('anchors deploy', g.car.anchored);
g.toggleAnchor();
check('anchors release', !g.car.anchored);

g.day = 13; g.newDay();
check('day advances', g.day === 14);
check('storm spawns a tornado', g.tornadoes.length === 1, `cat ${g.tornadoes[0]?.category}`);

// anchored rig ignores the vortex, free rig does not
const t = g.tornadoes[0];
t.group.position.set(g.car.pos.x + 25, 0, g.car.pos.z);
g.car.speed = 0; g.toggleAnchor(true);
const before = g.car.pos.clone();
step(120);
const driftAnchored = g.car.pos.distanceTo(before);
g.toggleAnchor(false);
const before2 = g.car.pos.clone();
step(120);
const driftFree = g.car.pos.distanceTo(before2);
check('anchor negates tornado pull', driftAnchored < 0.5, `${driftAnchored.toFixed(2)} m`);
check('free rig is dragged', driftFree > 1, `${driftFree.toFixed(2)} m`);

g.tornadoes.forEach((x) => x.dissipate()); g.tornadoes = [];
g.day = 40; g.spawnTimer = 0;
step(30);
check('boss rig appears on day 40', g.raiders.some((r) => r.boss));

const stop = g.world.pitStops[0];
g.car.pos.set(stop.x + 6, 0, stop.z + 6);
step(3);
// scavenging now scatters physical drops — they only count once picked up
const haul = () => Object.values(g.materials).reduce((a, b) => a + (b || 0), 0)
  + g.inventory.list().reduce((a, i) => a + i.qty, 0);
const haulBefore = haul();
g.scavenge();
check('scavenging scatters drops (nothing banked yet)', g.loot.count > 0 && haul() === haulBefore, `${g.loot.count} drops`);
const grab = g.inCar ? g.car.pos : g.avatar.root.position;
g.loot.drops.forEach((d) => d.group.position.set(grab.x, 0, grab.z));
g.updateLoot(1 / 60);
check('picking the drops up fills the pack', haul() > haulBefore, `${haulBefore} → ${haul()}`);

g.materials = { scrap: 99, steel: 99, titanium: 99, carbon: 99, leather: 99, chem: 99, cores: 99 };
g.benchTier = 4;
let craftErr = '';
for (const r of RECIPES) {
  try { g.craft(r.id); g.craft(r.id); g.craft(r.id); g.craft(r.id); } catch (e) { craftErr = `${r.id}: ${e.message}`; }
}
check('every recipe crafts', !craftErr, craftErr);
check('all weapons owned', ['pipe', 'machete', 'katana', 'broadsword', 'revolver'].every((w) => g.owned.has(w)));
check('armor + anchors upgraded', g.car.armorLevel === 3 && g.car.anchorTier === 4, `armor ${g.car.armorLevel} anchors ${g.car.anchorTier}`);

g.toggleBench();
check('workbench opens', g.hud.benchOpen);
g.toggleBench(false);
check('workbench closes', !g.hud.benchOpen);

// on-foot combat
g.car.pos.set(0, 0, 0); g.car.speed = 0;
g.toggleCar();
check('player can exit the rig', !g.inCar && g.avatar.root.visible);
const { Hollow } = await import('./app/js/enemies.js');
g.hollows.forEach((h) => h.die()); g.hollows = [];
const h = new Hollow(g.scene, 2, 0, 5);
g.hollows.push(h);
g.avatar.root.position.set(0, 0, 0);
g.avatar.root.rotation.y = Math.PI / 2;
g.weapon = 'broadsword'; g.syncWeapon(); g.durability.broadsword = 350;
for (let i = 0; i < 6; i++) { g.time += 1; g.lastAttack = 0; g.attack(); step(4); }
check('broadsword kills a hollow', h.dead);
check('the corpse spills loot instead of banking it', g.loot.count > 0, `${g.loot.count} drops`);
{
  const banked = () => Object.values(g.materials).reduce((a, c) => a + (c || 0), 0)
    + g.inventory.list().reduce((a, i) => a + i.qty, 0);
  const before = banked();
  g.loot.drops.forEach((d) => d.group.position.set(g.avatar.root.position.x, 0, g.avatar.root.position.z));
  for (let i = 0; i < 50; i++) g.updateLoot(1 / 60);
  check('standing on the corpse loot banks it', banked() > before, `${before} → ${banked()}`);
}
// a boss rig pays out a better haul
{
  const boss = new Hollow(g.scene, 0, 0, 6);
  boss.boss = true;
  g.loot.clear();
  g.onKill(boss);
  const ids = g.loot.drops.map((d) => d.item);
  check('boss wrecks drop boss-grade loot', ids.includes('cores') && ids.includes('blueprint'), ids.join(','));
  g.loot.clear();
}
g.toggleCar();
check('player re-enters the rig', g.inCar);

// multiplayer peers
g.onPeer({ id: 'p1', name: 'BUDDY', color: 0x5ff0ff, carColor: 0x2b6ad2, x: 10, y: 0, z: 5, yaw: 0, inCar: true, hp: 80, day: 12 });
g.onPeer({ id: 'p2', name: 'WALKER', color: 0x8bf5b4, carColor: 0x3aa06a, x: -6, y: 0, z: 8, yaw: 1, inCar: false, hp: 55, day: 12 });
step(200, { forward: 1 });
check('peer visuals created', g.peerVisuals.size === 2);
check('party list always includes you', g.partyRows()[0].name.includes('(YOU)'));
g.onPeerLeave({ id: 'p2' });
check('peer removal cleans up', g.peerVisuals.size === 1);

// zone + weather sweep
let zoneErr = '';
for (const d of [15, 30, 45, 60, 70, 85, 90, 100]) {
  try { g.day = d; g.newDay(); step(90, { forward: 1 }); } catch (e) { zoneErr = `day ${d}: ${e.message}`; }
}
check('days 1-100 run without errors', !zoneErr, zoneErr);
check('reached the final zone', g.zone === 4);

// death / respawn / win
g.hp = 1; g.hurt(50, 'test');
check('hull breach ends the run', g.dead && g.paused);
g.resetRun();
check('respawn resets the run', g.day === 1 && g.hp === 100 && g.inCar && g.car.fuel === 20);
g.day = 100; g.won = false; g.dead = false; g.paused = false;
g.win();
check('surviving day 100 wins', g.won);

// weather has real handling costs
{
  const { Vehicle } = await import('./app/js/vehicle.js');
  const drive = (env, { left = 0, frames = 60 } = {}) => {
    const v = new Vehicle({ color: 0xffffff });
    v.pos.set(0, 0, 0);
    for (let i = 0; i < frames; i++) {
      v.update(1 / 60, { forward: 1, back: 0, left, right: 0, boost: 0 }, g.world, () => {}, env);
    }
    return v;
  };
  const dry = drive({ grip: 1, wind: 0 });
  check('a straight run stays on the centre line when it is calm', Math.abs(dry.pos.x) < 0.01, `${dry.pos.x.toFixed(2)}`);
  const blown = drive({ grip: 1, wind: 3 });
  check('a gale pushes the rig sideways', blown.pos.x > 1.5, `${blown.pos.x.toFixed(2)}`);

  const gripDry = drive({ grip: 1, wind: 0 }, { left: 1 });
  const gripWet = drive({ grip: 0.72, wind: 0 }, { left: 1 });
  const turned = (v) => Math.abs(v.yaw - Math.PI);
  check('wet tarmac turns in less than dry tarmac', turned(gripWet) < turned(gripDry),
    `${turned(gripWet).toFixed(2)} vs ${turned(gripDry).toFixed(2)}`);

  g.setWeather('gale');
  check('weather changes grip for the live rig', g.weather === 'gale');
  g.setWeather('clear');
}

// fuzz: random input + actions for 8k frames
g.resetRun();
let fuzzErr = '';
try {
  for (let i = 0; i < 8000; i++) {
    if (i % 23 === 0) {
      g.keys.forward = Math.random() < 0.5 ? 1 : 0;
      g.keys.back = Math.random() < 0.2 ? 1 : 0;
      g.keys.left = Math.random() < 0.4 ? 1 : 0;
      g.keys.right = Math.random() < 0.4 ? 1 : 0;
      g.keys.boost = Math.random() < 0.3;
    }
    if (i % 97 === 0) {
      const a = i % 5;
      if (a === 0) g.toggleAnchor();
      if (a === 1) g.attack();
      if (a === 2) g.scavenge();
      if (a === 3) g.toggleCar();
      if (a === 4) g.toggleBench(false);
    }
    if (i % 2400 === 0 && g.day < 90) { g.day += 9; g.newDay(); }
    g.update(1 / 60);
    if (!Number.isFinite(g.car.pos.x) || !Number.isFinite(g.hp)) throw new Error('NaN state');
    if (g.dead) g.resetRun();
  }
} catch (e) { fuzzErr = e.message; }
check('fuzz run stays stable', !fuzzErr, fuzzErr);

g.net.close();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL GAME TESTS PASSED');
process.exit(problems.length ? 1 : 0);
