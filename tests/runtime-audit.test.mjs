/**
 * THE AUDIT LANE — nothing the network, a saved profile or a resize can throw.
 *
 * The round-35 report had three symptoms at once: a banner, repeated frame
 * errors, and an "undefined property" exception. The frame-error path was
 * already covered (`graphics.test.mjs`, `render-real.test.mjs`); what was *not*
 * covered is everything that feeds the frame — a profile loaded from storage,
 * a peer envelope from another client, a stage that changes size mid-run.
 *
 * So this suite feeds the game the junk those sources can actually produce and
 * insists that a frame keeps running:
 *
 *   · a profile with no colour / no name / a "#rrggbb" string colour;
 *   · peer messages with no coordinates, NaN, strings, a colour as text;
 *   · every incoming message type, including one this build does not know;
 *   · 0 s, 3 s and negative dt, a 1×1 stage and a 4000×3000 one;
 *   · every action key, pause/resume, and a dispose in the middle of a run.
 *
 * A throw anywhere is a FAIL with the message and the stack line that caused it.
 */
import { installDOM, El } from './doms.mjs';

globalThis.__COARSE__ = true;          // the phone this report came from
globalThis.__TOUCH__ = true;
const stage = installDOM({ width: 412, height: 915 });
const { Game } = await import('./app/js/game.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

/** Runs `fn`, returns '' if it survived, or "message @ line" if it did not. */
function safely(fn) {
  try { fn(); return ''; } catch (err) {
    const where = String(err?.stack || '').split('\n').find((l) => /at .*game\.js/.test(l)) || '';
    return `${err?.message || err}${where ? ` @ ${where.trim().slice(0, 70)}` : ''}`;
  }
}

const makeGame = (opts = {}) => new Game({
  mount: new El('div', 'app'),
  profile: { name: 'AUDIT', color: 0xffb347, carColor: 0xd24a2b },
  room: 'audit', mode: 'sprint', onQuit: () => {},
  ...opts,
});

const MODES = ['classic', 'endless', 'siege', 'sprint', 'hypercane'];

console.log('\na saved profile is not trusted blindly');
{
  // exactly what storage can hand back: an older row, a half-written one, a
  // colour somebody typed as text, and nothing at all
  for (const [label, profile] of [
    ['an empty profile', {}],
    ['a profile with no colour', { name: 'NOVA' }],
    ['a colour typed as text', { name: 'NOVA', color: '#ff0000', carColor: 'red' }],
    ['a nameless profile', { name: null, color: 0x5ff0ff }],
  ]) {
    let game = null;
    const fault = safely(() => {
      game = makeGame({ profile });
      game.started = true;
      for (let i = 0; i < 90; i++) { game.update(1 / 60); game.updateCamera(1 / 60); }
    });
    check(`${label} still runs a frame`, !fault, fault || '90 frames');
    if (game) {
      const rows = game.partyRows();
      check(`${label} gets a party row it can read`, /^#[0-9a-f]{6}$/i.test(rows[0].color) && !/undefined/.test(rows[0].name),
        `${rows[0].name} · ${rows[0].color}`);
    }
  }
}

console.log('\na peer colour arrives as whatever the other client had');
{
  const game = makeGame();
  const seen = [];
  for (const colour of [0xff0000, '#00ff00', 'red', undefined, NaN, null]) {
    game.net.peers = new Map([['p1', { id: 'p1', name: 'PEER', color: colour, inCar: false, x: 1, z: 2 }]]);
    const fault = safely(() => {
      seen.push(game.partyRows()[1].color);
      game.radarBlips();
      game.paintHud?.(true);
    });
    check(`a peer colour of ${String(colour)} paints`, !fault && /^#[0-9a-f]{3,8}$/i.test(seen[seen.length - 1]),
      fault || seen[seen.length - 1]);
  }
}

console.log('\njunk from the wire never breaks a frame');
{
  const game = makeGame();
  game.started = true;
  const junk = [
    null, undefined, {}, { id: 'p1' }, { id: 'p1', x: NaN, z: 3 }, { id: 'p1', x: 'a', z: {} },
    { id: 'p1', x: 1, z: 2, color: '#ff0000' }, { id: 'p1', x: 1e9, z: -1e9, yaw: NaN, hp: 'x' },
  ];
  let fault = '';
  for (const message of junk) {
    fault = safely(() => { game.onPeer(message); game.update(1 / 60); game.updateCamera(1 / 60); });
    if (fault) break;
    fault = safely(() => game.onPeerLeave(message));
    if (fault) break;
  }
  check('a malformed peer is ignored, not fatal', !fault, fault || `${junk.length} envelopes`);

  fault = '';
  for (const t of ['hello', 'state', 'chat', 'event', 'left', 'something-new', null, 5]) {
    fault = safely(() => game.net.consume({ t, id: 'p2', x: 1, z: 2, text: 'hi', kind: 'storm' }));
    if (fault) break;
  }
  check('an unknown message type is ignored, not fatal', !fault, fault || '8 message types');

  fault = safely(() => {
    game.net.peers = new Map([['p3', { id: 'p3', name: null, color: '', inCar: 'yes', x: 0, z: 0 }]]);
    game.paintHud?.(true);
  });
  check('the HUD survives a peer with no usable fields', !fault, fault || 'painted');
}

console.log('\ntime, size and input cannot throw a frame');
{
  for (const mode of MODES) {
    let game = null;
    let fault = safely(() => { game = makeGame({ mode }); game.started = true; });
    if (fault || !game) { check(`${mode} starts`, false, fault); continue; }

    // a tab that was backgrounded, a clock that stepped backwards, a stall
    fault = safely(() => { for (const dt of [0, 0.5, 1 / 60, 3, -0.2]) { game.update(dt); game.updateCamera(dt); } });
    check(`${mode} — odd frame times are clamped, not thrown`, !fault, fault || '0 s · 0.5 s · 3 s · −0.2 s');

    // the stage changes size: rotate a phone, split-screen, a tiny embedded frame
    fault = safely(() => {
      for (const [w, h] of [[915, 412], [1, 1], [200, 120], [4000, 3000]]) {
        stage.width = w; stage.height = h;
        globalThis.innerWidth = w; globalThis.innerHeight = h;
        globalThis.__W__ = w; globalThis.__H__ = h;
        game.resize();
        game.update(1 / 60); game.updateCamera(1 / 60);
      }
    });
    check(`${mode} — every stage size redraws`, !fault, fault || '1×1 … 4000×3000');

    // every control, one at a time, with a frame between them
    fault = safely(() => {
      for (const key of Object.keys(game.keys)) {
        game.keys[key] = 1;
        game.update(1 / 60); game.updateCamera(1 / 60);
        game.keys[key] = 0;
      }
    });
    check(`${mode} — every control is a real key`, !fault, fault || `${Object.keys(game.keys).length} keys`);

    fault = safely(() => {
      for (let i = 0; i < 4; i++) { game.car.speed = 0; game.toggleCar(); game.update(1 / 60); }
      game.paused = true; game.update(1 / 60);
      game.paused = false; game.update(1 / 60);
      for (let i = 0; i < 9; i++) { game.day += 1; game.newDay(); game.update(1 / 60); }
    });
    check(`${mode} — cars, pause and storms keep working`, !fault, fault || 'toggle · pause · 9 days');

    fault = safely(() => { game.dispose?.(); game.update(1 / 60); });
    check(`${mode} — a disposed run is inert, not fatal`, !fault, fault || 'disposed');
  }
}

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nNOTHING THE WIRE OR THE PLAYER CAN DO BREAKS A FRAME');
process.exit(problems.length ? 1 : 0);
