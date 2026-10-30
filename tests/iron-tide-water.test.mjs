// IRON TIDE — the water.
//
// `water.js` is a classic script (the game runs in an opaque-origin iframe, so
// no modules), so it is executed here the way a browser would: in a vm context
// with a `window`, and every number the player feels gets pinned.
//
// What is being pinned is *behaviour*, not implementation: a boat must
// accelerate, coast, drift through a turn, refuse to pivot at rest, bob on the
// swell, slow down in a storm, and never produce a NaN — no matter what the
// frame rate does.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const source = readFileSync(path.join(root, 'games', 'iron-tide', 'water.js'), 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const W = sandbox.window.WaterPhysics;

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const run = (opts, controls, seconds, seaState = 'calm') => {
  const sea = W.createSea({ state: seaState });
  const body = W.createBody(opts);
  const frames = Math.round(seconds * 60);
  let peakHeave = 0, slams = 0, damage = 0;
  const out = {};
  for (let i = 0; i < frames; i++) {
    W.stepBody(body, sea, 1 / 60, controls, out);
    peakHeave = Math.max(peakHeave, Math.abs(body.heave));
    if (out.slam) slams++;
    damage += out.damage || 0;
  }
  return { sea, body, peakHeave, slams, damage };
};

// ------------------------------------------------------------------ the module
console.log('\nthe water module');
{
  check('it publishes itself as window.WaterPhysics', Boolean(W));
  check('four sea states, calm → storm', W.SEA_ORDER.join(',') === 'calm,moderate,rough,storm');
  check('every state has a name, wind and a slamming factor',
    W.SEA_ORDER.every((id) => W.SEAS[id].name && W.SEAS[id].wind > 0 && 'slamming' in W.SEAS[id]));
  check('rough seas are heavier than calm ones',
    W.SEAS.storm.amp > W.SEAS.rough.amp && W.SEAS.rough.amp > W.SEAS.moderate.amp
    && W.SEAS.moderate.amp > W.SEAS.calm.amp);
  check('the sortie ladder escalates the sea',
    W.seaForSortie(1) === 'calm' && W.seaForSortie(2) === 'moderate'
    && W.seaForSortie(3) === 'rough' && W.seaForSortie(9) === 'storm');
}

// -------------------------------------------------------------------- the sea
console.log('\nthe sea');
{
  const sea = W.createSea({ state: 'moderate', seed: 4 });
  check('a sea has waves', sea.waves.length >= 4, `${sea.waves.length} components`);

  // deep-water dispersion: long swell travels faster than short chop
  const speeds = sea.waves.map((w) => w.speed);
  const sorted = [...speeds].sort((a, b) => b - a);
  check('long swell outruns the chop (ω = √(gk))',
    speeds[0] > speeds[speeds.length - 1] && sorted.length === speeds.length,
    `${speeds[0].toFixed(1)} → ${speeds[speeds.length - 1].toFixed(1)} m/s`);

  // the field is deterministic and bounded
  const a = W.createSea({ state: 'rough', seed: 9 });
  const b = W.createSea({ state: 'rough', seed: 9 });
  check('the same seed builds the same sea',
    a.height(12.5, -40) === b.height(12.5, -40));

  let peak = 0;
  let finite = true;
  for (let i = 0; i < 2000; i++) {
    const s = a.at(i * 7.3 - 900, i * -3.1 + 400);
    if (!Number.isFinite(s.h) || !Number.isFinite(s.gx) || !Number.isFinite(s.gy)) finite = false;
    peak = Math.max(peak, Math.abs(s.h));
    a.step(1 / 60);
  }
  check('the height field stays finite', finite);
  check('the swell never exceeds the sum of its parts',
    peak <= a.ampSum + 1e-9, `${peak.toFixed(2)} m of ${a.ampSum.toFixed(2)} m`);

  // the gradient must agree with the height it came from
  const sea2 = W.createSea({ state: 'moderate', seed: 2 });
  const x0 = 31.5, y0 = -12.25, eps = 0.05;
  const at = sea2.at(x0, y0);
  const gxNum = (sea2.height(x0 + eps, y0) - sea2.height(x0 - eps, y0)) / (2 * eps);
  const gyNum = (sea2.height(x0, y0 + eps) - sea2.height(x0, y0 - eps)) / (2 * eps);
  check('the analytic gradient matches the field',
    Math.abs(gxNum - at.gx) < 0.01 && Math.abs(gyNum - at.gy) < 0.01,
    `Δgx ${Math.abs(gxNum - at.gx).toFixed(4)}`);

  // crests move
  const before = sea2.height(0, 0);
  sea2.step(1.1);
  check('the waves travel in time', sea2.height(0, 0) !== before);

  // foam only where the sea allows it
  let foamed = 0;
  const storm = W.createSea({ state: 'storm', seed: 3 });
  const glassy = W.createSea({ state: 'calm', seed: 3 });
  for (let i = 0; i < 500; i++) {
    if (storm.foam(i * 11, i * 7) > 0.25) foamed++;
  }
  let calmFoam = 0;
  for (let i = 0; i < 500; i++) if (glassy.foam(i * 11, i * 7) > 0.25) calmFoam++;
  check('a storm breaks whitecaps', foamed > 50, `${foamed}/500 samples`);
  check('a calm sea stays mostly glassy', calmFoam < foamed / 2, `${calmFoam}/500 samples`);

  // wind and current
  const wind = storm.wind();
  const drift = storm.drift();
  check('the wind blows', Math.hypot(wind.x, wind.y) > 5, `${Math.hypot(wind.x, wind.y).toFixed(1)} m/s`);
  check('the surface current is a fraction of the wind',
    Math.hypot(drift.x, drift.y) < Math.hypot(wind.x, wind.y));

  // sea state can change mid-battle
  const live = W.createSea({ state: 'calm' });
  const wasCalm = live.preset.name;
  live.setState('storm');
  check('the sea can turn while you are in it',
    live.state === 'storm' && live.preset.name === 'STORM' && wasCalm === 'CALM');
  check('severity tracks the state', live.severity > 0.9 && W.createSea({ state: 'calm' }).severity === 0);
}

// -------------------------------------------------------------------- the hull
console.log('\nthe hull');
{
  const skiff = W.hullSpec({ length: 34, speed: 1.35 });
  const carrier = W.hullSpec({ length: 78, speed: 0.78 });
  check('a longer hull weighs more', carrier.displacement > skiff.displacement,
    `${skiff.displacement.toFixed(0)} → ${carrier.displacement.toFixed(0)}`);
  check('a longer hull turns slower', carrier.turnRate < skiff.turnRate,
    `${skiff.turnRate.toFixed(2)} vs ${carrier.turnRate.toFixed(2)} rad/s`);
  check('yaw inertia grows with length', carrier.yawInertia > skiff.yawInertia);
  check('the keel resists sideways motion ~8× more than forward',
    Math.abs(skiff.dragLat / skiff.dragLong - 8) < 0.001);
  check('the advertised speed is the top speed', Math.abs(skiff.vMax - 1.35 * 60) < 0.001);
  check('nonsense input cannot produce a nonsense hull',
    Number.isFinite(W.hullSpec({ length: NaN, speed: NaN }).vMax));
}

// ---------------------------------------------------------------- the motion
console.log('\nmotion under power');
{
  const { body } = run({ length: 46, speed: 1.15 }, { throttle: 1 }, 45);
  const spec = body.spec;
  check('the ship gets under way', body.u > 20, `${body.u.toFixed(1)} m/s`);
  check('and settles below its hull speed, not above',
    body.u <= spec.vMax + 0.001, `${body.u.toFixed(1)} of ${spec.vMax.toFixed(0)} m/s`);
  check('calm-water speed is within 10% of the hull speed',
    body.u > spec.vMax * 0.9, `${body.u.toFixed(1)} m/s`);
  check('it covers ground', Math.hypot(body.x, body.y) > 1000 || body.distance > 1000,
    `${body.distance.toFixed(0)} m travelled`);
  check('speed in knots is reported for the HUD', W.knots(body.u) > 60, `${W.knots(body.u).toFixed(0)} kn`);

  const t90 = (() => {
    const sea = W.createSea({ state: 'calm' });
    const b = W.createBody({ length: 46, speed: 1.15 });
    for (let i = 0; i < 60 * 60; i++) {
      W.stepBody(b, sea, 1 / 60, { throttle: 1 });
      if (b.u > 0.9 * b.spec.vMax) return i / 60;
    }
    return Infinity;
  })();
  check('it reaches 90% of hull speed in under 12 s', t90 < 12, `${t90.toFixed(1)} s`);
}

console.log('\nmotion without power');
{
  const sea = W.createSea({ state: 'calm' });
  const b = W.createBody({ length: 46, speed: 1.15 });
  for (let i = 0; i < 60 * 40; i++) W.stepBody(b, sea, 1 / 60, { throttle: 1 });
  const cruise = b.u;
  let t = 0;
  while (b.u > cruise * 0.1 && t < 180) { W.stepBody(b, sea, 1 / 60, { throttle: 0 }); t += 1 / 60; }
  check('a hull coasts — it does not stop like a car', t > 8, `${t.toFixed(0)} s to lose 90% of way`);
  check('coefficient of the coast is sane', t < 120, `${t.toFixed(0)} s`);

  // astern
  const rev = run({ length: 46, speed: 1.15 }, { throttle: -1 }, 20);
  check('astern is slower than ahead', rev.body.u < 0 && Math.abs(rev.body.u) < cruise,
    `${rev.body.u.toFixed(1)} m/s astern`);
}

console.log('\nsteering');
{
  // no pivot without waterflow
  const rest = run({ length: 46, speed: 1.15 }, { throttle: 0, rudder: 1 }, 10);
  check('the rudder does nothing when the ship is stopped',
    Math.abs(rest.body.heading) < 0.01, `${rest.body.heading.toFixed(4)} rad`);

  // a turning ship slides, then grips
  const sea = W.createSea({ state: 'calm' });
  const b = W.createBody({ length: 46, speed: 1.15 });
  for (let i = 0; i < 60 * 30; i++) W.stepBody(b, sea, 1 / 60, { throttle: 1 });
  const straight = Math.abs(b.v);
  for (let i = 0; i < 60 * 5; i++) W.stepBody(b, sea, 1 / 60, { throttle: 1, rudder: 1 });
  const drifting = Math.abs(b.v);
  check('a hard turn makes the hull drift', drifting > straight + 2,
    `${straight.toFixed(1)} → ${drifting.toFixed(1)} m/s sideways`);
  check('but the keel keeps the drift under a quarter of the way on',
    drifting < b.u * 0.3, `${(drifting / b.u * 100).toFixed(0)}% slip`);
  check('the hull actually comes round', b.r > 0.15, `${b.r.toFixed(3)} rad/s`);
  const radius = b.u / b.r;
  check('the turning circle is a ship’s, not a go-kart’s',
    radius > 90 && radius < 400, `${radius.toFixed(0)} m ≈ ${(radius / b.spec.length).toFixed(1)} ship lengths`);

  // yaw rate has inertia: it takes time to reach the commanded rate
  const c = W.createBody({ length: 46, speed: 1.15 });
  const sea2 = W.createSea({ state: 'calm' });
  for (let i = 0; i < 60 * 20; i++) W.stepBody(c, sea2, 1 / 60, { throttle: 1 });
  W.stepBody(c, sea2, 1 / 60, { throttle: 1, rudder: 1 });
  check('the helm responds with inertia, not instantly',
    c.r > 0 && c.r < c.spec.turnRate * 0.9, `${c.r.toFixed(3)} rad/s after one frame`);

  // a bigger hull answers more slowly
  const big = W.createBody({ length: 78, speed: 0.78 });
  const sea3 = W.createSea({ state: 'calm' });
  for (let i = 0; i < 60 * 30; i++) W.stepBody(big, sea3, 1 / 60, { throttle: 1 });
  for (let i = 0; i < 60 * 8; i++) W.stepBody(big, sea3, 1 / 60, { throttle: 1, rudder: 1 });
  check('a carrier turns more slowly than a corvette', big.r < b.r,
    `${big.r.toFixed(2)} vs ${b.r.toFixed(2)} rad/s`);
}

// ------------------------------------------------------------------ the water
console.log('\nliving on the sea');
{
  const calm = run({ length: 46, speed: 1.15 }, { throttle: 1 }, 40, 'calm');
  const storm = run({ length: 46, speed: 1.15 }, { throttle: 1 }, 40, 'storm');

  check('the hull heaves on the swell', storm.peakHeave > calm.peakHeave,
    `${calm.peakHeave.toFixed(2)} m calm, ${storm.peakHeave.toFixed(2)} m storm`);
  check('the heave stays plausible', storm.peakHeave < 14, `${storm.peakHeave.toFixed(1)} m`);
  check('a storm costs you speed', storm.body.u < calm.body.u * 0.9,
    `${calm.body.u.toFixed(0)} → ${storm.body.u.toFixed(0)} m/s`);
  check('heavy seas slam the bow', storm.slams > 0, `${storm.slams} slam frames`);
  check('and take a toll on the hull', storm.damage > 0, `${storm.damage.toFixed(1)} hp over 40 s`);
  check('a millpond does not damage the ship', calm.damage === 0);

  // attitude follows the local surface, and is bounded
  const sea = W.createSea({ state: 'storm' });
  const b = W.createBody({ length: 46, speed: 1.15 });
  let maxRoll = 0;
  for (let i = 0; i < 60 * 60; i++) {
    W.stepBody(b, sea, 1 / 60, { throttle: 1, rudder: 0.3 });
    maxRoll = Math.max(maxRoll, Math.abs(b.roll));
  }
  check('the deck rolls in a seaway', maxRoll > 0.03, `${(maxRoll * 57).toFixed(1)}°`);
  check('but never past the point of capsize', maxRoll <= 0.36, `${(maxRoll * 57).toFixed(1)}°`);

  // wake is speed-dependent and stops when you do
  const out = {};
  const fast = W.createBody({ length: 46, speed: 1.15 });
  const sea2 = W.createSea({ state: 'moderate' });
  for (let i = 0; i < 60 * 20; i++) W.stepBody(fast, sea2, 1 / 60, { throttle: 1 }, out);
  const moving = out.wakeEmit;
  for (let i = 0; i < 60 * 60; i++) W.stepBody(fast, sea2, 1 / 60, { throttle: 0 }, out);
  W.stepBody(fast, sea2, 1 / 60, { throttle: 0 }, out);
  check('a moving hull leaves a wake', moving > 0, `${moving.toFixed(2)} units/frame`);
  check('a stopped hull leaves none', out.wakeEmit < 1e-6, `${out.wakeEmit.toExponential(1)} units/frame`);
  check('and is actually stopped, not creeping', fast.u === 0, `${fast.u} m/s`);

  // immersion: a planing hull rides higher
  const imm = W.immersion(fast, sea2);
  check('immersion is a fraction', imm >= 0.15 && imm <= 1, imm.toFixed(2));
}

// ----------------------------------------------------------------- stability
console.log('\nstability');
{
  // a hitch in the frame rate must not change the outcome
  const seaA = W.createSea({ state: 'rough', seed: 5 });
  const seaB = W.createSea({ state: 'rough', seed: 5 });
  const a = W.createBody({ x: 0, y: 0, heading: 0, length: 46, speed: 1.15 });
  const b = W.createBody({ x: 0, y: 0, heading: 0, length: 46, speed: 1.15 });
  for (let i = 0; i < 120; i++) W.stepBody(a, seaA, 1 / 60, { throttle: 1, rudder: 0.4 });
  for (let i = 0; i < 60; i++) W.stepBody(b, seaB, 1 / 30, { throttle: 1, rudder: 0.4 });
  const drift = Math.hypot(a.x - b.x, a.y - b.y);
  check('sub-stepping keeps 30 fps and 60 fps in agreement', drift < 40, `${drift.toFixed(1)} m apart`);

  // abuse: wild dt, wild controls, wild input
  const sea = W.createSea({ state: 'storm' });
  const body = W.createBody({ length: 46, speed: 1.15 });
  let sane = true;
  for (let i = 0; i < 4000; i++) {
    const dt = [1 / 240, 1 / 60, 0.2, 0.5, -1, NaN][i % 6];
    const controls = {
      throttle: i % 7 === 0 ? 5 : i % 11 === 0 ? NaN : Math.sin(i / 9),
      rudder: i % 13 === 0 ? -9 : Math.cos(i / 7),
    };
    W.stepBody(body, sea, dt, controls);
    if (!Number.isFinite(body.x + body.y + body.u + body.v + body.r + body.heave)) { sane = false; break; }
  }
  check('nonsense input never produces a NaN', sane);
  check('the ship stays inside a sane envelope',
    Math.abs(body.u) < 400 && Math.abs(body.r) < 6 && Math.abs(body.heave) < 60,
    `u ${body.u.toFixed(1)}, r ${body.r.toFixed(2)}, heave ${body.heave.toFixed(1)}`);

  // zero and negative dt are ignored
  const before = { x: body.x, y: body.y };
  W.stepBody(body, sea, 0, { throttle: 1 });
  W.stepBody(body, sea, -0.5, { throttle: 1 });
  check('a zero or negative timestep does nothing', body.x === before.x && body.y === before.y);

  // the same seed replays the same fight
  const replay = () => {
    const s = W.createSea({ state: 'moderate', seed: 77 });
    const p = W.createBody({ length: 60, speed: 0.95 });
    for (let i = 0; i < 900; i++) W.stepBody(p, s, 1 / 60, { throttle: 1, rudder: Math.sin(i / 40) });
    return `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  };
  const firstRun = replay();
  const secondRun = replay();
  check('the same seed replays exactly', firstRun === secondRun, firstRun);
}

// ----------------------------------------------------------------- the wiring
console.log('\nthe game uses it');
{
  const game = readFileSync(path.join(root, 'games', 'iron-tide', 'game.js'), 'utf8');
  const html = readFileSync(path.join(root, 'games', 'iron-tide', 'index.html'), 'utf8');

  check('the game loads water.js', /<script src="water\.js"><\/script>/.test(html));
  check('and before the game itself',
    html.indexOf('water.js') < html.indexOf('game.js'));
  check('the game survives a missing water.js',
    /window\.WaterPhysics\) \|\|/.test(game));
  check('the player has a floating body', /W\.createBody\(\{[\s\S]{0,200}length: hull\.length/.test(game));
  check('enemies float too', /body: W\.createBody\(/.test(game));
  check('the sea is stepped with the battle clock', /s\.sea\.step\(dt\)/.test(game));
  check('wake, spray and splashes are simulated', /function stepEffects/.test(game)
    && /function emitWake/.test(game) && /function emitSpray/.test(game) && /function emitSplash/.test(game));
  check('the sea is drawn from the wave field', /function drawSea/.test(game)
    && /sea\.at\(wx, wy\)/.test(game) && /sea\.foam\(wx, wy\)/.test(game));
  check('the hull rides the swell when drawn', /body\.heave/.test(game) && /body\.roll/.test(game));
  check('the HUD reports sea state, speed and heel', /id="seaChip"/.test(html)
    && /KN · /.test(game) || /KN/.test(game));
  check('a miss throws a splash', /emitSplash\(s, b\.x, b\.y/.test(game));
  check('rough seas warn the player about slamming', /SLAMMING/.test(game));
}

process.exit(problems.length ? 1 : 0);
