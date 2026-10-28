// Enterable interiors, the extra roadside locations, and the owner console gate.
// Runs headless: the building factory + the server-side admin check are the
// parts most likely to break silently, so they get the most coverage.
import { installDOM, El } from './doms.mjs';
import { handleAdminRequest, verifyAdmin, usernameFromUser, isOwnerName } from '../lib/admin-auth.mjs';

installDOM({ width: 1280, height: 720 });

const { Game } = await import('./app/js/game.js');
const { createBuilding, BUILDING_KINDS, pointInside, hitsWalls, placeBuilding, setRoofVisible } = await import('./app/js/buildings.js');
const { isOwnerUsername, mountAdmin, AdminPanel, ownerAccess } = await import('./app/js/admin.js');
const { ZONES } = await import('./app/js/world.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

// ---------------------------------------------------------------- buildings
console.log('\nenterable locations');
{
  check('eleven building archetypes', BUILDING_KINDS.length >= 11, BUILDING_KINDS.join(','));
  check('clinics, depots and farmhouses exist',
    ['clinic', 'depot', 'farmhouse'].every((k) => BUILDING_KINDS.includes(k)));
  check('houses are included', BUILDING_KINDS.includes('house'));

  for (const kind of BUILDING_KINDS) {
    const b = createBuilding(kind, { x: 40, z: 0, facing: 1 });
    let meshes = 0;
    b.group.traverse((o) => { if (o.isMesh) meshes++; });
    const doorwayClear = !hitsWalls(b, b.door.x, b.door.z, 0.4);
    const walkable = !hitsWalls(b, b.door.x + 1.6, b.door.z, 0.45) && pointInside(b, b.door.x + 1.8, b.door.z);
    const wallsSolid = hitsWalls(b, b.bounds.x1 - 0.4, b.z, 0.4) && hitsWalls(b, b.x, b.bounds.z1 - 0.4, 0.4);
    check(`${kind} is enterable`, meshes > 5 && doorwayClear && walkable && wallsSolid,
      `${meshes} meshes · loot×${b.lootMult}`);
  }

  // door always faces the road, whichever side the building sits on
  const left = createBuilding('house', { x: -44, z: 0, facing: -1 });
  const right = createBuilding('house', { x: 44, z: 0, facing: 1 });
  check('door faces the road on both shoulders',
    Math.abs(left.door.x) < Math.abs(left.x) && Math.abs(right.door.x) < Math.abs(right.x),
    `${left.door.x.toFixed(1)} / ${right.door.x.toFixed(1)}`);

  // moving a building rebuilds its colliders + roof state
  const house = createBuilding('house', { x: 40, z: 0, facing: 1 });
  placeBuilding(house, { x: 52, z: 300, facing: -1 });
  check('colliders follow a moved building',
    hitsWalls(house, 52 + house.halfW - 0.3, 302.5, 0.4)
    && !hitsWalls(house, 52 - house.halfW - 2, 300, 0.4)
    && !hitsWalls(house, 44, 0, 0.4));
  setRoofVisible(house, false);
  check('roof hides when the player is inside', house.roof.visible === false);
  setRoofVisible(house, true);
  check('roof returns when the player leaves', house.roof.visible === true);

  // loot scales with the building kind
  const warehouse = createBuilding('warehouse', { x: 40, z: 0 });
  const shack = createBuilding('shack', { x: 40, z: 0 });
  check('warehouse loots better than a shack', warehouse.lootMult > shack.lootMult,
    `${warehouse.lootMult} vs ${shack.lootMult}`);
}

// ------------------------------------------------------------------- world
console.log('\nworld placement');
const g = new Game({
  mount: new El('div', 'app'),
  profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
  room: 'test-room',
  onQuit: () => {},
});
g.started = true;
{
  check('world spawns buildings', g.world.buildings.length >= 8, `${g.world.buildings.length} buildings`);
  check('buildings keep their doors toward the road',
    g.world.buildings.every((b) => Math.sign(b.door.x) === Math.sign(b.x)));
  check('pit stops and houses never stack', g.world.buildings.every((b) => {
    return g.world.pitStops.every((s) => Math.sign(s.x) !== Math.sign(b.x) || Math.abs(s.z - b.z) >= 46);
  }));
  check('radar shows buildings', g.radarBlips().some((b) => b.kind === 'house'));
}

console.log('\nwalking inside');
{
  const b = g.world.buildings[0];
  g.toggleCar();                                    // step out
  // stand outside the doorway (away from the road) and walk in through it
  const outward = Math.sign(b.door.x) || 1;
  g.avatar.root.position.set(b.door.x + outward * 2.5, 0, b.door.z);
  g.pos.copy(g.avatar.root.position);
  g.camYaw = outward > 0 ? Math.PI / 2 : -Math.PI / 2;   // face the building
  for (let i = 0; i < 180; i++) { Object.assign(g.keys, { forward: 1 }); g.updateFoot(1 / 60); }
  check('player walks through the doorway', g.world.buildingAt(g.pos.x, g.pos.z) === b,
    `x=${g.pos.x.toFixed(1)} door=${b.door.x.toFixed(1)}`);
  check('roof lifts while inside', g.insideBuilding === b && b.roof.visible === false);
  check('car cannot enter the building', Boolean(g.world.collide(b.x, b.z, 1.6)));

  g.keys.forward = 0; g.keys.back = 1;
  for (let i = 0; i < 260; i++) g.updateFoot(1 / 60);
  check('player can walk back out', g.world.buildingAt(g.pos.x, g.pos.z) === null);
  check('roof returns after leaving', b.roof.visible === true);
}

console.log('\ninterior looting');
{
  const b = g.world.buildings[1];
  g.avatar.root.position.set(b.x, 0, b.z);
  g.pos.copy(g.avatar.root.position);
  g.trackInterior();
  check('standing indoors is detected', g.insideBuilding === b);
  const haul = () => Object.values(g.materials).reduce((a, c) => a + (c || 0), 0)
    + g.inventory.list().reduce((a, i) => a + i.qty, 0);
  const before = haul();
  g.scavenge();
  check('interior search scatters drops', g.loot.count > 0, `${g.loot.count} drops`);
  check('nothing is banked until it is picked up', haul() === before);
  g.loot.drops.forEach((d) => d.group.position.set(g.pos.x, 0, g.pos.z));
  g.updateLoot(1 / 60);
  check('walking over the drops collects them', haul() > before, `${before} → ${haul()}`);
  check('building goes on cooldown', b.scavengeReady === false && b.cooldown > 0);
  const second = haul();
  g.scavenge();
  check('a picked-clean building yields nothing more', haul() === second);
}

// --------------------------------------------------------------- admin gate
console.log('\nowner gate (client)');
{
  check('ghanimz is the owner', isOwnerUsername('ghanimz'));
  check('casing does not matter', isOwnerUsername('GhanimZ'));
  check('everyone else is refused', !isOwnerUsername('ghanimz2') && !isOwnerUsername('survivor') && !isOwnerUsername('') && !isOwnerUsername(null));
  check('shared helper agrees', isOwnerName('ghanimz') && !isOwnerName('bob'));

  // offline builds: the local survivor name is the only identity there is
  check('guest owner works when accounts are off',
    ownerAccess({ canUseAccounts: false, username: 'GUEST' }, 'ghanimz') === 'guest');
  check('guest owner is refused once accounts exist',
    ownerAccess({ canUseAccounts: true, username: 'GUEST' }, 'ghanimz') === null);
  check('signed-in owner uses the account path',
    ownerAccess({ canUseAccounts: true, username: 'ghanimz' }, 'WANDERER') === 'account');
  check('a guest called something else gets nothing',
    ownerAccess({ canUseAccounts: false, username: 'GUEST' }, 'WANDERER') === null);
}

console.log('\nowner gate (server)');
{
  const ANON = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role: 'anon', ref: 'proj' })).toString('base64url')}.sig`;
  const env = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: ANON };

  const fakeUser = (username, extra = {}) => ({
    ok: true,
    status: 200,
    json: async () => ({
      id: 'user-' + username,
      aud: 'authenticated',
      role: 'authenticated',
      email: `${username}@players.outrun.local`,
      user_metadata: { username },
      ...extra,
    }),
  });
  const fakeFetch = (user) => async (url, init = {}) => {
    if (String(url).endsWith('/auth/v1/user')) {
      const token = String(init.headers?.Authorization || '').replace('Bearer ', '');
      if (!token) return { ok: false, status: 401, json: async () => ({}) };
      return user ? user(token) : { ok: false, status: 401, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const ownerFetch = fakeFetch((token) => (token === 'owner-token' ? fakeUser('ghanimz') : { ok: false, status: 401, json: async () => ({}) }));
  const ok = await verifyAdmin({ token: 'owner-token', env, fetchImpl: ownerFetch });
  check('owner token verifies', ok.admin && ok.username === 'ghanimz', ok.reason);

  const forged = await verifyAdmin({ token: 'bob-token', env, fetchImpl: ownerFetch });
  check('a normal player is not admin', !forged.admin, forged.reason);

  const anonKey = await verifyAdmin({ token: ANON, env, fetchImpl: ownerFetch });
  check('the shipped anon key cannot unlock admin', !anonKey.admin, anonKey.reason);

  const noToken = await verifyAdmin({ token: '', env, fetchImpl: ownerFetch });
  check('no token is refused', !noToken.admin, noToken.reason);

  const unconfigured = await verifyAdmin({ token: 'owner-token', env: {}, fetchImpl: ownerFetch });
  check('unconfigured server refuses (503)', !unconfigured.admin && unconfigured.reason === 'supabase_not_configured');

  // username extraction shapes
  check('username from metadata', usernameFromUser({ user_metadata: { username: 'ghanimz' } }) === 'ghanimz');
  check('username from synthetic email', usernameFromUser({ email: 'ghanimz@players.outrun.local' }) === 'ghanimz');

  // a forged panel cannot ban anyone
  const banned = await handleAdminRequest({ token: 'bob-token', action: 'ban', body: { username: 'carol' }, env, fetchImpl: ownerFetch });
  check('non-owner ban is 403', banned.status === 403 && banned.body.ok === false, banned.body.reason);

  const verifyOwner = await handleAdminRequest({ token: 'owner-token', action: 'verify', env, fetchImpl: ownerFetch });
  check('owner verify is 200', verifyOwner.status === 200 && verifyOwner.body.admin === true);

  const ownerBan = await handleAdminRequest({ token: 'owner-token', action: 'ban', body: { username: 'carol' }, env, fetchImpl: ownerFetch });
  check('owner can ban', ownerBan.status === 200 && ownerBan.body.ok === true);
  const selfBan = await handleAdminRequest({ token: 'owner-token', action: 'ban', body: { username: 'ghanimz' }, env, fetchImpl: ownerFetch });
  check('owner cannot ban themselves', selfBan.status === 400, selfBan.body.reason);
  const offlineBans = await handleAdminRequest({ token: 'owner-token', action: 'bans', env: {}, fetchImpl: ownerFetch });
  check('ban list needs configured Supabase', offlineBans.status === 503);
}

console.log('\nadmin actions in the run');
{
  const panelGame = g;
  panelGame.godMode = true;
  panelGame.hp = 100;
  panelGame.hurt(50, 'test');
  check('god mode ignores damage', panelGame.hp === 100);

  panelGame.spawnHollow(2);
  check('spawning hollows works', panelGame.hollows.length >= 2, `${panelGame.hollows.length}`);
  panelGame.clearHostiles();
  check('clearing hostiles works', panelGame.hollows.length === 0 && panelGame.raiders.length === 0);

  panelGame.car.chassis = 10;
  panelGame.healAll();
  check('full heal restores the rig', panelGame.car.chassis === 100 && panelGame.car.fuel === panelGame.car.maxFuel);

  panelGame.teleport(12, -300);
  check('teleport moves the rig and avatar',
    Math.abs(panelGame.car.pos.x - 12) < 0.01 && Math.abs(panelGame.pos.z + 300) < 0.01,
    `${panelGame.car.pos.x} / ${panelGame.car.pos.z}`);
}

console.log('\nowner console UI');
{
  const stranger = mountAdmin({ game: g, account: { username: 'bob', sb: { session: null } } });
  check('nobody else gets a console', stranger === null);

  const panel = mountAdmin({ game: g, account: { username: 'ghanimz', sb: { session: null } } });
  check('owner gets a console', panel instanceof AdminPanel);

  const opened = await panel.show();
  check('console opens for the owner', opened && panel.open === true);
  check('the run pauses while the console is open', g.paused === true);
  check('offline owner is flagged local', panel.verifyReason === 'local_owner', panel.verifyReason);

  const scrapBefore = g.materials.scrap || 0;
  panel.act('give');
  check('console grants materials', (g.materials.scrap || 0) === scrapBefore + 50, `${scrapBefore} → ${g.materials.scrap}`);
  panel.act('tier');
  check('console unlocks the workbench', g.benchTier === 4);
  const godBefore = Boolean(g.godMode);
  panel.act('god');
  check('console toggles god mode', g.godMode === !godBefore);
  const buildingsBefore = g.world.buildings.length;
  panel.act('placeBuilding');
  check('console drops a building', g.world.buildings.length === buildingsBefore + 1,
    `${buildingsBefore} → ${g.world.buildings.length}`);

  panel.act('clearHostiles');
  panel.act('heal');
  check('console heals the rig', g.car.chassis === 100);

  panel.refresh();
  check('stats render without an error', typeof g.day === 'number');

  panel.hide();
  check('closing resumes the run', panel.open === false && g.paused === false);
  panel.destroy();
  check('console tears down cleanly', panel.el === null);
}

console.log('\nzones');
check('five zones still defined', ZONES.length === 5);

if (problems.length) {
  console.log(`\n${problems.length} FAILED: ${problems.join(', ')}`);
  process.exit(1);
}
console.log('\nALL INTERIOR + OWNER CONSOLE TESTS PASSED');
process.exit(0);
