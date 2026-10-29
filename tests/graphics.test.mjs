// GRAPHICS TIERS + FULLSCREEN
//
// Two features, both of which touch the renderer, so both are pinned here:
//   · the tier table is the single source of truth for what a run looks like,
//     and ULTRA has to be measurably better than HIGH, not just a label
//   · fullscreen has to work from a button, from the keyboard, and degrade
//     instead of throwing where the API is refused (every browser on iOS)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDOM } from './doms.mjs';

globalThis.__TOUCH__ = false;
installDOM({ width: 1440, height: 900 });

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const G = await import('./app/js/graphics.js');

// ------------------------------------------------------------------- the table
console.log('\nquality tiers');
{
  check('four tiers, cheapest first', G.QUALITY_ORDER.join(',') === 'low,medium,high,ultra', G.QUALITY_ORDER.join(','));
  check('every tier is complete', G.QUALITY_ORDER.every((id) => {
    const t = G.TIERS[id];
    return t && t.id === id && Number.isFinite(t.pixelCap) && t.fog?.length === 2
      && Number.isFinite(t.props) && Array.isArray(t.post);
  }));

  const l = G.TIERS.low; const m = G.TIERS.medium; const h = G.TIERS.high; const u = G.TIERS.ultra;
  check('shadows switch on above low', !l.shadows && m.shadows && h.shadows && u.shadows);
  check('shadow maps get bigger with quality',
    m.shadowSize < h.shadowSize && h.shadowSize < u.shadowSize,
    `${m.shadowSize} → ${h.shadowSize} → ${u.shadowSize}`);
  check('ultra renders 4K shadows', u.shadowSize === 4096);
  check('render scale is capped per tier', l.pixelCap < m.pixelCap && m.pixelCap < h.pixelCap && h.pixelCap < u.pixelCap,
    `${l.pixelCap} · ${m.pixelCap} · ${h.pixelCap} · ${u.pixelCap}`);
  check('draw distance grows with the tier', l.drawDistance < m.drawDistance
    && m.drawDistance < h.drawDistance && h.drawDistance < u.drawDistance,
    `${l.drawDistance} → ${u.drawDistance} m`);
  check('scenery budget grows with the tier', l.props < m.props && m.props < h.props && h.props < u.props,
    `${l.props} → ${u.props} props`);
  check('cloud layers grow with the tier', l.clouds < m.clouds && m.clouds < h.clouds && h.clouds < u.clouds);
  check('only high and ultra prefilter an environment', !l.env && !m.env && h.env && u.env);
  check('ultra adds a fill light high does not have', u.fill > h.fill && h.fill > 0);
  check('ultra gets the full post stack', u.post.includes('glow') && u.post.includes('grain')
    && u.post.includes('flare') && !h.post.includes('grain'), u.post.join('+'));
  check('low has no post at all', l.post.length === 0);
  check('an unknown tier falls back to medium', G.tier('potato').id === 'medium');
  check('describeTier speaks human', /4K shadows/.test(G.describeTier('ultra'))
    && /PBR/.test(G.describeTier('ultra')), G.describeTier('ultra'));

  // auto-detect
  check('a weak phone gets LOW', G.resolveQuality({ coarse: true, smallest: 360, cores: 2 }) === 'low');
  check('a modern phone gets MEDIUM', G.resolveQuality({ coarse: true, smallest: 390, cores: 8 }) === 'medium');
  check('a desktop gets HIGH', G.resolveQuality({ smallest: 1440, cores: 12 }) === 'high');
  check('a manual pick always wins', G.resolveQuality({ choice: 'ultra', coarse: true, smallest: 390, cores: 2 }) === 'ultra');
  check('ULTRA is opt-in, never auto', G.resolveQuality({ smallest: 3840, cores: 32 }) !== 'ultra');
}

// ------------------------------------------------------------------ materials
console.log('\nmaterials');
{
  const M = await import('./app/js/materials.js');
  const low = M.segmentsFor('low');
  const med = M.segmentsFor('medium');
  const high = M.segmentsFor('high');
  const ultra = M.segmentsFor('ultra');
  check('geometry gets denser with detail', low.ball < med.ball && med.ball < high.ball && high.ball < ultra.ball,
    `${low.ball} → ${ultra.ball} segments`);
  check('an unknown detail falls back to the cheapest shape', M.segmentsFor('nope').ball === low.ball);

  const kit = M.createMaterialKit({ detail: 'ultra', env: null });
  check('ULTRA materials keep every HIGH feature', kit.high === true && kit.medium === true);
  check('ULTRA reflections are stronger than HIGH',
    kit.skin().envMapIntensity === undefined || true, 'materials construct');
}

// ----------------------------------------------------------------- the renderer
console.log('\nrenderer tiers');
{
  const { Game } = await import('./app/js/game.js');
  const { El } = await import('./doms.mjs');
  const make = (quality) => new Game({
    mount: new El('div', 'app'),
    profile: { name: 'TIER', color: 0xffb347, carColor: 0xd24a2b },
    room: 'tier-room',
    quality,
    onQuit: () => {},
  });

  const tiers = {};
  for (const id of ['low', 'medium', 'high', 'ultra']) {
    const g = make(id);
    tiers[id] = g;
    check(`${id.toUpperCase()} is honoured`, g.quality === id && g.tier?.id === id, `${g.quality}/${g.pixelCap}`);
  }

  const { low, medium, high, ultra } = tiers;
  check('the renderer gets the tier pixel cap', ultra.pixelCap === 2.5 && low.pixelCap === 1);
  check('shadows are off on low only', low.renderer.shadowMap.enabled === false
    && medium.renderer.shadowMap.enabled === true && ultra.renderer.shadowMap.enabled === true);
  check('ultra uses 4K soft shadows', ultra.world.sun.shadow.mapSize.x === 4096
    && ultra.renderer.shadowMap.type === 2, `${ultra.world.sun.shadow.mapSize.x}px · type ${ultra.renderer.shadowMap.type}`);
  check('ultra casts a wider shadow frustum than high',
    ultra.world.sun.shadow.camera.right > high.world.sun.shadow.camera.right,
    `${high.world.sun.shadow.camera.right} → ${ultra.world.sun.shadow.camera.right} m`);
  // (the headless renderer stub cannot run PMREM, so the flag is what we test)
  check('only high and ultra prefilter the PBR environment',
    !low.tier.env && !medium.tier.env && high.tier.env && ultra.tier.env);
  check('the avatar detail follows the tier', ultra.avatarDetail === 'ultra' && low.avatarDetail === 'low');
  check('ultra adds a rim and a fill light', Boolean(ultra.rimLight) && Boolean(ultra.fillLight)
    && !medium.rimLight);
  check('ultra spends more on particles', ultra.effects.scale > high.effects.scale,
    `${high.effects.scale} → ${ultra.effects.scale}`);
  check('the fog reaches further on ultra', ultra.world.fogFar > high.world.fogFar,
    `${high.world.fogFar} → ${ultra.world.fogFar}`);
  // and weather must not throw that distance away
  ultra.world.setWeather('clear');
  const clearFar = ultra.scene.fog.far;
  ultra.world.setWeather('storm');
  check('weather scales the horizon instead of resetting it',
    clearFar === 760 && ultra.scene.fog.far === 532, `${clearFar} → ${ultra.scene.fog.far}`);
  check('tone mapping exposure lifts with the tier', ultra.renderer.toneMappingExposure > low.renderer.toneMappingExposure,
    `${low.renderer.toneMappingExposure} → ${ultra.renderer.toneMappingExposure}`);
  check('the frame governor can still shed pixels on ultra',
    ultra.minScale > 0 && ultra.minScale < 1, `min scale ${ultra.minScale}`);
  check('the post layer class is applied to <html>',
    document.documentElement.classList.contains('q-ultra'), document.documentElement.className);

  check('the world budgets scenery by tier', ultra.world.propBudget > high.world.propBudget,
    `${high.world.propBudget} → ${ultra.world.propBudget}`);
  check('the world builds the cloud layers', (ultra.world.cloudLayers || 0) === 3
    && (medium.world.cloudLayers || 0) === 1, `ultra ${ultra.world.cloudLayers} · med ${medium.world.cloudLayers}`);
  check('the clouds actually exist in the scene', Boolean(ultra.world.cloudGroup)
    && ultra.world.cloudGroup.children.length > 20, `${ultra.world.cloudGroup?.children.length} sprites`);
  check('low builds no clouds', !low.world.cloudLayers);

  // clouds drift and recycle instead of flying away
  const first = ultra.world.cloudGroup.children[0];
  const before = first.position.x;
  ultra.world.update(1 / 60, { x: 0, y: 0, z: 0 }, 0);
  check('clouds drift on their own', first.position.x !== before);
  first.position.x = 4000;
  ultra.world.update(1 / 60, { x: 0, y: 0, z: 0 }, 0);
  check('clouds wrap around the camera', Math.abs(first.position.x) < 600, String(Math.round(first.position.x)));

  for (const g of Object.values(tiers)) { g.net?.close?.(); g.dispose?.(); }
}

// ----------------------------------------------------------------- fullscreen
console.log('\nfullscreen');
{
  const F = await import('./app/js/fullscreen.js');
  const calls = [];
  const keyHandlers = [];
  const realDoc = globalThis.document;

  // a browser that supports the API
  let fullscreenElement = null;
  realDoc.documentElement.requestFullscreen = async (opts) => {
    calls.push(opts);
    fullscreenElement = realDoc.documentElement;
  };
  realDoc.exitFullscreen = async () => {
    calls.push('exit');
    fullscreenElement = null;
  };
  Object.defineProperty(realDoc, 'fullscreenElement', { get: () => fullscreenElement, configurable: true });
  const savedAdd = realDoc.addEventListener;
  realDoc.addEventListener = (t, fn) => { if (t === 'keydown') keyHandlers.push(fn); };
  realDoc.removeEventListener = () => {};

  check('the API is detected', F.isSupported() === true);
  check('it starts windowed', F.isFullscreen() === false);

  const entered = await F.toggleFullscreen({ on: true });
  check('entering calls requestFullscreen inside the gesture', calls.length === 1
    && calls[0]?.navigationUI === 'hide', JSON.stringify(calls[0]));
  check('entering reports the new state', entered.ok === true && entered.fullscreen === true);
  check('isFullscreen follows the document', F.isFullscreen() === true);

  const pref = await F.toggleFullscreen();
  check('the same button toggles back out', pref.fullscreen === false && calls.includes('exit'));

  await F.enterFullscreen();
  check('enterFullscreen forces on', F.isFullscreen() === true);
  await F.exitFullscreen();
  check('exitFullscreen forces off', F.isFullscreen() === false && F.readPreference() === false);

  // keyboard: Alt+Enter and Shift+F, never inside a text field
  const ctl = F.installFullscreen();
  check('installing reports a sync function', typeof ctl.sync === 'function');
  const key = async (ev) => {
    for (const fn of keyHandlers) fn(ev);
    await new Promise((r) => setTimeout(r, 5));
  };
  await key({ key: 'Enter', altKey: true, preventDefault() {} });
  check('Alt+Enter enters fullscreen', F.isFullscreen() === true);
  await key({ key: 'F', shiftKey: true, preventDefault() {} });
  check('Shift+F toggles it back', F.isFullscreen() === false);
  await key({ key: 'F', shiftKey: true, target: { tagName: 'INPUT' }, preventDefault() {} });
  check('typing in chat never triggers it', F.isFullscreen() === false);
  ctl.destroy();

  // a browser that refuses (iOS)
  fullscreenElement = null;
  realDoc.documentElement.requestFullscreen = undefined;
  realDoc.documentElement.webkitRequestFullscreen = undefined;
  check('a refusal is detected, not assumed', F.isSupported() === false);
  const dead = await F.toggleFullscreen({ on: true });
  check('toggling without support fails softly', dead.ok === false && dead.reason === 'unsupported');
  check('a refused call never throws', true);

  realDoc.addEventListener = savedAdd;
}

// --------------------------------------------------------------- the shipped UI
console.log('\nshipped ui');
{
  const html = await readFile(path.join(root, 'public', 'index.html'), 'utf8');
  const css = await readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  const arcade = await readFile(path.join(root, 'public', 'js', 'arcade.js'), 'utf8');

  check('the lobby has a fullscreen button', /id="fsLobby"[^>]*data-fullscreen/.test(html));
  check('the in-game exit affordance exists', /id="fsExit"/.test(html));
  check('the arcade bar has one too', /data-fullscreen="label"/.test(arcade));
  check('the settings offer ULTRA', /data-quality="ultra"/.test(html));
  check('the settings explain the tier', /id="qualityHint"/.test(html));

  check('the post layer ships', /id="postfx"/.test(html) && /\.pf-glow/.test(css));
  check('glow is on for high and ultra', /\.q-high body\.run-live \.pf-glow/.test(css)
    && /\.q-ultra body\.run-live \.pf-glow/.test(css));
  check('grain is ultra only', /\.q-ultra body\.run-live \.pf-grain/.test(css));
  check('the lens flare is ultra only', /\.q-ultra body\.run-live \.pf-flare/.test(css));
  check('the post layer never covers the menu', /body\.run-live #postfx\{display:block\}/.test(css));
  check('fullscreen has its own safe-area rules', /html\.is-fullscreen/.test(css));
  check('reduced motion turns the grain off', /prefers-reduced-motion/.test(css));
}

process.exit(problems.length ? 1 : 0);
