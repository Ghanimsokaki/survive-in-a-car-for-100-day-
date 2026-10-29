// Game modes, the frame governor, the anchor safety valve and survivor customisation.
import { installDOM, El } from './doms.mjs';

installDOM({ width: 1280, height: 720 });

const { Game } = await import('./app/js/game.js');
const { MODES, modeById, goalLabel, DEFAULT_MODE } = await import('./app/js/modes.js');
const { buildAvatar } = await import('./app/js/avatar.js');
const {
  SKIN_TONES, OUTFIT_COLORS, HAIR_STYLES, HAIR_COLORS, ACCESSORIES,
  DEFAULT_CUSTOM, normalizeCustom, resolveCustom, describeCustom,
} = await import('./app/js/customize.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const makeGame = (opts = {}) => new Game({
  mount: new El('div', 'app'),
  profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
  room: 'mode-room',
  onQuit: () => {},
  ...opts,
});

console.log('\nmode catalogue');
{
  check('five games inside the game', MODES.length >= 5, MODES.map((m) => m.id).join(','));
  const ids = new Set(MODES.map((m) => m.id));
  check('mode ids are unique', ids.size === MODES.length);
  check('every mode has a name, blurb, icon and finish line',
    MODES.every((m) => m.name && m.blurb && m.icon && 'targetDay' in m));
  check('the classic run is still the 100-day run', modeById('classic').targetDay === 100);
  check('an unknown mode falls back to classic', modeById('nonsense').id === DEFAULT_MODE);
  check('endless has no finish line', modeById('endless').targetDay === Infinity);
  check('the goal label reads correctly', goalLabel(modeById('classic')) === '100' && goalLabel(modeById('endless')) === '∞');
}

console.log('\nrunning a mode');
{
  const classic = makeGame();
  check('a run defaults to classic', classic.modeId === 'classic' && classic.dayLength === 95);
  check('classic starts with 20 litres', Math.abs(classic.car.fuel - 20) < 0.01, `${classic.car.fuel}`);

  const siege = makeGame({ mode: 'siege' });
  check('siege swaps the finish line', siege.modeId === 'siege' && siege.mode.targetDay === 12);
  check('siege starts fuelled and teched up', siege.car.fuel === 30 && siege.benchTier === 2);
  check('siege runs shorter days', siege.dayLength === 80, `${siege.dayLength}`);
  const raidCap = Math.max(1, Math.round(Math.min(4, 1 + Math.floor(6 / 25)) * siege.mode.raiderMult));
  check('siege raises the raider cap', raidCap >= 2, `${raidCap} raiders`);

  const sprint = makeGame({ mode: 'sprint' });
  check('the fuel run starts nearly dry', sprint.car.fuel === 9, `${sprint.car.fuel}`);
  check('the fuel run pays better loot', sprint.mode.lootMult > 1.3);

  // the day loop stops at the mode finish line instead of 100
  siege.day = 11; siege.newDay();
  check('a siege finishes on day 12', siege.day === 12, `${siege.day}`);
  siege.newDay();
  check('and never runs past it', siege.day === 12, `${siege.day}`);
  check('mode progress is complete', siege.modeProgress() === 1);

  // win conditions: classic holds the last stand, an instant mode wins immediately
  const quick = makeGame({ mode: 'siege' });
  quick.mode = { ...quick.mode, finalSeconds: 0 };
  quick.day = quick.mode.targetDay;
  let ended = null;
  quick.onRunEnd = (s) => { ended = s; };
  for (let i = 0; i < 4; i++) quick.update(1 / 60);
  check('reaching the target day wins the mode', quick.won === true);
  check('the summary reports the mode run', ended && ended.won === true, JSON.stringify(ended?.won));

  // endless keeps going
  const endless = makeGame({ mode: 'endless' });
  endless.day = 250;
  endless.newDay();
  check('endless keeps counting', endless.day === 251, `${endless.day}`);

  for (const g of [classic, siege, sprint, quick, endless]) g.net.close();
}

console.log('\nframe governor');
{
  const g = makeGame();
  const startScale = g.renderScale;
  check('starts at full resolution', startScale === 1);
  // feed it slow frames: it must trade pixels for frames
  for (let i = 0; i < 90; i++) g.updatePerf(1 / 24);
  check('slow frames drop the render scale', g.renderScale < startScale, `${g.renderScale.toFixed(2)}`);
  check('the scale never goes below the floor', g.renderScale >= g.minScale - 1e-6, `${g.renderScale.toFixed(2)}`);
  // a very slow device also loses shadows
  for (let i = 0; i < 400; i++) g.updatePerf(1 / 18);
  check('a desperate device turns shadows off', g.renderer.shadowMap.enabled === false);
  // and it climbs back when the device recovers
  const low = g.renderScale;
  for (let i = 0; i < 600; i++) g.updatePerf(1 / 120);
  check('a fast device gets its resolution back', g.renderScale > low, `${low.toFixed(2)} → ${g.renderScale.toFixed(2)}`);
  check('fps is measured', g.fps > 0, `${g.fps} fps`);
  check('the pixel ratio follows the scale', g.targetPixelRatio() > 0 && g.targetPixelRatio() <= g.pixelCap,
    g.targetPixelRatio().toFixed(2));
  g.net.close();
}

console.log('\nanchor safety valve');
{
  const g = makeGame();
  g.car.speed = 0;
  g.toggleAnchor();
  check('anchors deploy', g.car.anchored === true);
  g.keys.forward = 1;
  for (let i = 0; i < 20; i++) g.update(1 / 60);
  check('holding the throttle keeps the anchor for a moment', g.car.anchored === true);
  let released = false;
  for (let i = 0; i < 60; i++) { g.update(1 / 60); if (!g.car.anchored) { released = true; break; } }
  check('then it rips the anchors out so you can drive', released && !g.car.anchored);
  for (let i = 0; i < 40; i++) g.update(1 / 60);
  check('the rig actually moves again', g.car.speed > 1, `${g.car.speed.toFixed(2)} m/s`);

  // a storm keeps you anchored on purpose
  const s = makeGame();
  s.car.speed = 0;
  s.toggleAnchor();
  s.tornadoes.push({
    pos: { x: s.pos.x + 30, z: s.pos.z, y: 0 },
    group: { position: { x: s.pos.x + 30, z: s.pos.z, y: 0 } },
    category: 3, update() {}, dissipate() {},
    forceAt: () => ({ x: 0, z: 0, lift: 0 }),
  });
  s.keys.forward = 1;
  for (let i = 0; i < 90; i++) s.update(1 / 60);
  check('a tornado keeps the anchors planted', s.car.anchored === true);
  s.net.close();
  g.net.close();
}

console.log('\ncustomisation catalogue');
{
  check('skin tones', SKIN_TONES.length >= 6, `${SKIN_TONES.length}`);
  check('outfit colours', OUTFIT_COLORS.length >= 8, `${OUTFIT_COLORS.length}`);
  check('hair styles', HAIR_STYLES.length >= 6, HAIR_STYLES.map((h) => h.id).join(','));
  check('hair colours', HAIR_COLORS.length >= 6, `${HAIR_COLORS.length}`);
  check('accessories', ACCESSORIES.length >= 5, ACCESSORIES.map((a) => a.id).join(','));
  check('options have unique ids',
    [SKIN_TONES, OUTFIT_COLORS, HAIR_STYLES, HAIR_COLORS, ACCESSORIES]
      .every((list) => new Set(list.map((x) => x.id)).size === list.length));

  const junk = normalizeCustom({ skin: 'nope', hair: 42, height: 99, build: 'x', accessory: null });
  check('garbage input normalises', junk.skin === DEFAULT_CUSTOM.skin && junk.height === 1.1 && junk.build === 1,
    `${junk.skin} ${junk.height} ${junk.build}`);
  check('missing input normalises', normalizeCustom(undefined).skin === DEFAULT_CUSTOM.skin);
  const resolved = resolveCustom({ skin: 'ebony', outfit: 'teal', hair: 'mohawk', hairColor: 'acid', accessory: 'backpack' });
  check('resolve turns ids into hex + labels', resolved.skinHex === 0x4a2a1b && resolved.hairLabel === 'MOHAWK');
  check('describe summarises the look', /MOHAWK/.test(describeCustom({ hair: 'mohawk', accessory: 'backpack' })));
}

console.log('\ncustomised avatar');
{
  const avatar = buildAvatar({ color: 0xffb347, name: 'DRESSED', custom: { hair: 'mohawk', accessory: 'backpack', height: 1.1, build: 0.9 } });
  const visibleHair = Object.entries(avatar.parts.hairStyles).filter(([, g]) => g.visible).map(([k]) => k);
  check('one hair style is visible', visibleHair.length === 1 && visibleHair[0] === 'mohawk', visibleHair.join(','));
  const visibleGear = Object.entries(avatar.parts.accessories).filter(([, g]) => g.visible).map(([k]) => k);
  check('one accessory is visible', visibleGear.length === 1 && visibleGear[0] === 'backpack', visibleGear.join(','));
  check('height and build scale the rig', avatar.rig.scale.y === 1.1 && avatar.rig.scale.x === 0.9);
  check('the name tag rides above the head', avatar.tag.position.y > 2.5);

  avatar.setCustom({ hair: 'helmet', accessory: 'none', height: 0.9, build: 1.1 });
  const now = Object.entries(avatar.parts.hairStyles).filter(([, g]) => g.visible).map(([k]) => k);
  check('hair can be swapped live', now.length === 1 && now[0] === 'helmet', now.join(','));
  check('and the gear follows', Object.entries(avatar.parts.accessories).filter(([, g]) => g.visible)[0][0] === 'none');

  // every style must build without throwing
  let err = '';
  for (const h of HAIR_STYLES) {
    try { avatar.setCustom({ hair: h.id, accessory: 'lamp' }); } catch (e) { err = `${h.id}: ${e.message}`; }
  }
  for (const a of ACCESSORIES) {
    try { avatar.setCustom({ accessory: a.id }); } catch (e) { err = `${a.id}: ${e.message}`; }
  }
  check('every hairstyle and accessory swaps cleanly', !err, err);
  avatar.animate(1 / 60, 1);
  avatar.attack();
  avatar.setWeapon('katana');
  avatar.setName('RENAMED');
  check('animation, weapons and renaming still work', avatar.weapon === 'katana');
}

console.log('\nthe run uses the look');
{
  const g = makeGame({
    profile: {
      name: 'LOOKS', color: 0x4a2a1b, carColor: 0xd24a2b,
      custom: { skin: 'ebony', hair: 'ponytail', accessory: 'backpack', height: 1.05, build: 0.95 },
    },
  });
  check('the run avatar wears the saved look',
    g.avatar.custom.hair === 'ponytail' && g.avatar.custom.accessory === 'backpack');
  g.applyCustom({ hair: 'buzz', accessory: 'medkit' });
  check('the look can change mid-run', g.avatar.custom.hair === 'buzz');
  g.net.close();
}

for (const residual of []) residual();
console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL MODE + PERF + AVATAR TESTS PASSED');
process.exit(problems.length ? 1 : 0);
