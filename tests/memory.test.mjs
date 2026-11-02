/**
 * MEMORY — the game remembers your last play, and hands it back intact.
 *
 * The ask was blunt: *"so I can play my last play and continue fixing"*. A run
 * is forty minutes of scavenging; a refresh, a locked phone or a tab closed by
 * accident used to end it. This suite covers both halves of the promise:
 *
 *   1. the slot itself (js/memory.js) — write, read, forget, age out, survive a
 *      full quota, and never let a half-written or foreign slot load;
 *   2. the game's end of it — autosave while playing, a snapshot that restores
 *      the run it came from, and a finished run that keeps nothing.
 */
import { installDOM, El } from './doms.mjs';

const stage = installDOM({ width: 412, height: 915 });

const M = await import('./app/js/memory.js');
const { Game } = await import('./app/js/game.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

/**
 * A Storage-shaped object we own, so a test can lie about quota or age.
 * `cap` is the *total* budget, the way a real origin quota behaves.
 */
function memoryStore({ cap = Infinity } = {}) {
  const map = new Map();
  const used = (skip) => [...map.entries()].reduce((n, [k, v]) => (k === skip ? n : n + k.length + v.length), 0);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const text = String(v);
      if (used(k) + k.length + text.length > cap) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, text);
    },
    removeItem: (k) => map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
}

const makeGame = (opts = {}) => new Game({
  mount: new El('div', 'app'),
  profile: { name: 'AUDIT', color: 0xffb347, carColor: 0xd24a2b },
  room: 'memory', mode: 'classic', onQuit: () => {},
  ...opts,
});

console.log('\na slot is written, read back and forgotten');
{
  const store = memoryStore();
  const saved = M.rememberRun('classic', { day: 12, x: 40, z: -8, items: [['pipe', 1]] }, { label: 'CLASSIC · DAY 12' }, store);
  check('a run can be remembered', Boolean(saved) && saved.state.day === 12, saved ? saved.label : 'nothing stored');

  const back = M.recallRun('classic', store);
  check('it comes back with the same state', back?.state?.day === 12 && back?.state?.x === 40, JSON.stringify(back?.state));
  check('it remembers what it is called', back?.label === 'CLASSIC · DAY 12', back?.label);
  check('another game cannot read it', M.recallRun('sprint', store) === null);

  M.forgetRun('classic', store);
  check('forgetting it leaves nothing behind', M.recallRun('classic', store) === null && store.length === 0);
}

console.log('\nwhat must not load');
{
  const store = memoryStore();
  M.rememberRun('classic', { day: 3 }, {}, store);
  const key = Object.keys(Object.fromEntries(store._map))[0];

  const raw = JSON.parse(store._map.get(key));
  store._map.set(key, JSON.stringify({ ...raw, v: 99 }));
  check('a slot from another version is dropped', M.recallRun('classic', store) === null);

  store._map.set(key, JSON.stringify({ ...raw, at: Date.now() - 30 * 24 * 3600 * 1000 }));
  check('a slot from three weeks ago is dropped', M.recallRun('classic', store) === null);

  store._map.set(key, '{"v":1,"game":"classic","at":');
  check('a half-written slot is dropped, not thrown', M.recallRun('classic', store) === null);

  store._map.set(key, JSON.stringify({ ...raw, game: 'sprint' }));
  check('a slot that names another game is dropped', M.recallRun('classic', store) === null);

  check('a dead slot is swept out when the list is read', M.allRuns(store).length === 0 && store.length === 0);
}

console.log('\nstorage that says no is not a crash');
{
  const tiny = memoryStore({ cap: 120 });
  const ok = M.rememberRun('classic', { blob: 'x'.repeat(400) }, {}, tiny);
  check('a snapshot too big for the quota is refused cleanly', ok === null, 'no throw');

  const small = memoryStore({ cap: 260 });
  M.rememberRun('classic', { day: 1 }, { at: Date.now() - 60000 }, small);
  M.rememberRun('sprint', { day: 2 }, { at: Date.now() - 30000 }, small);
  const third = M.rememberRun('siege', { day: 3, blob: 'y'.repeat(150) }, {}, small);
  check('a full quota makes room by dropping the oldest slot',
    Boolean(third) && M.recallRun('classic', small) === null, `sprint kept: ${Boolean(M.recallRun('sprint', small))}`);

  const broken = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); }, key() { throw new Error('SecurityError'); }, length: 0 };
  let threw = false;
  try {
    M.rememberRun('classic', { day: 1 }, {}, broken);
    M.recallRun('classic', broken);
    M.allRuns(broken);
    M.forgetRun('classic', broken);
  } catch { threw = true; }
  check('a storage that throws on every call is survivable', !threw);
}

console.log('\nthe card says when');
{
  const now = Date.UTC(2026, 10, 2, 12, 0, 0);
  check('a run from a minute ago reads as such', M.agoLabel(now - 60_000, now) === '1 MIN AGO', M.agoLabel(now - 60_000, now));
  check('an hour ago is hours', M.agoLabel(now - 3 * 3600_000, now) === '3 HRS AGO', M.agoLabel(now - 3 * 3600_000, now));
  check('a week ago is days', M.agoLabel(now - 2 * 86400_000, now) === '2 DAYS AGO', M.agoLabel(now - 2 * 86400_000, now));
  const line = M.describeRun({ game: 'sprint', label: 'FUEL RUN · DAY 12', at: now - 6 * 60_000, state: { day: 12 } }, now);
  check('the continue line names the run, the day and the age', /FUEL RUN/.test(line) && /DAY 12/.test(line) && /6 MIN AGO/.test(line), line);
}

console.log('\nthe game writes the slot while you play');
{
  const g = makeGame({ mode: 'classic' });
  g.started = true;
  const before = M.recallRun('classic');
  for (let i = 0; i < 60 * 6; i++) {   // six seconds of play
    g.updatePerf(1 / 60);
    g.update(1 / 60);
    g.updateCamera(1 / 60);
  }
  const after = M.recallRun('classic');
  check('a run in progress is remembered', Boolean(after) && !before, after ? `DAY ${after.state.day}` : 'no slot');
  check('the slot knows which mode it is', after?.game === 'classic', after?.game);
  check('the slot carries the state a player would miss',
    Number.isFinite(after?.state?.hp) && Number.isFinite(after?.state?.fuel) && typeof after?.state?.x === 'number'
    && Array.isArray(after?.state?.items), Object.keys(after?.state || {}).length + ' fields');
}

console.log('\ncontinuing puts you back where you were');
{
  const store = M.safeStore();
  // a run that has been places
  const first = makeGame({ mode: 'classic' });
  first.started = true;
  first.day = 17;
  first.hp = 63;
  first.car.fuel = 7.5;
  first.materials.scrap = 41;
  first.inventory.add('steel', 4);
  first.inventory.add('bandage', 3);
  first.pos.set(123.4, 0, -56.7);
  first.car.pos.set(123.4, 0, -56.7);
  first.distance = 8400;
  first.kills = 12;
  first.saveMemory();

  const saved = M.recallRun('classic', store);
  check('the snapshot matches the run it came from', saved?.state?.day === 17 && saved?.state?.hp === 63,
    saved ? `day ${saved.state.day} · hp ${saved.state.hp}` : 'no slot');

  const again = makeGame({ mode: 'classic', resume: saved.state });
  again.started = true;
  check('the day resumes', again.day === 17, String(again.day));
  check('so does health, and it is not a fresh 100', again.hp === 63, String(again.hp));
  check('so does fuel', Math.abs(again.car.fuel - 7.5) < 0.001, String(again.car.fuel));
  check('so does position', Math.abs(again.pos.x - 123.4) < 0.6 && Math.abs(again.pos.z + 56.7) < 0.6, `${again.pos.x}, ${again.pos.z}`);
  check('so does the pack', again.inventory.count('bandage') === 3 && again.inventory.count('steel') === 4,
    `${again.inventory.count('bandage')} bandages · ${again.inventory.count('steel')} steel`);
  check('so do the materials', again.materials.scrap === 41, String(again.materials.scrap));
  check('so does the distance driven', again.distance === 8400, String(again.distance));
  check('and the run actually plays on', (() => {
    for (let i = 0; i < 120; i++) { again.updatePerf(1 / 60); again.update(1 / 60); again.updateCamera(1 / 60); }
    return !again.dead && again.day >= 17;
  })(), `day ${again.day} · hp ${again.hp}`);
}

console.log('\na junk snapshot is a fresh run, not a broken one');
{
  const junk = [
    {}, { day: 'many', hp: -5, x: NaN, z: Infinity, fuel: -3 },
    { day: 5, hp: 9999, hpMax: 100, x: 1e9, z: -1e9, items: 'nope', hotbar: 7, owned: 'fists' },
  ];
  let fault = '';
  for (const state of junk) {
    try {
      const g = makeGame({ mode: 'classic', resume: state });
      g.started = true;
      for (let i = 0; i < 60; i++) { g.updatePerf(1 / 60); g.update(1 / 60); g.updateCamera(1 / 60); }
      if (!(g.hp >= 1 && g.hp <= g.hpMax) || !Number.isFinite(g.pos.x)) fault = `bad state survived: hp ${g.hp} x ${g.pos.x}`;
    } catch (err) { fault = err.message; break; }
  }
  check('garbage in, a sane run out', !fault, fault || 'clamped and playable');
}

console.log('\na finished run leaves nothing to continue');
{
  const g = makeGame({ mode: 'siege' });
  g.started = true;
  for (let i = 0; i < 60 * 6; i++) { g.updatePerf(1 / 60); g.update(1 / 60); g.updateCamera(1 / 60); }
  check('the run is remembered first', Boolean(M.recallRun('siege')), 'slot written');
  g.hurt(500);
  check('dying clears the slot', M.recallRun('siege') === null, 'nothing left');
}

console.log('\nthe CONTINUE card offers it');
{
  const store = M.safeStore();
  M.rememberRun('classic', { day: 9, hp: 50 }, { label: 'CLASSIC · DAY 9', at: Date.now() - 7 * 60_000 }, store);
  const clicks = [];
  const refresh = M.installContinueCard({
    getMode: () => 'classic',
    onContinue: (record) => clicks.push(['continue', record.game]),
    onForget: (record) => clicks.push(['forget', record?.game]),
  });
  const card = globalThis.document.getElementById('continueCard');
  check('the card appears when there is a run to continue', !card.classList.contains('hidden'));
  check('…and names the run', globalThis.document.getElementById('continueTitle').textContent === 'CLASSIC · DAY 9',
    globalThis.document.getElementById('continueTitle').textContent);
  check('…and says how long ago, and at what time',
    /7 MIN AGO/.test(globalThis.document.getElementById('continueWhen').textContent)
    && /\d{1,2}:\d{2}/.test(globalThis.document.getElementById('continueWhen').textContent),
    globalThis.document.getElementById('continueWhen').textContent);

  globalThis.document.getElementById('continueBtn').dispatch('click');
  check('the button continues that exact run', clicks[0]?.[0] === 'continue' && clicks[0][1] === 'classic',
    JSON.stringify(clicks[0]));

  globalThis.document.getElementById('continueForget').dispatch('click');
  check('…and ✕ forgets it', M.recallRun('classic') === null && card.classList.contains('hidden'),
    JSON.stringify(clicks[clicks.length - 1]));
  void refresh;
}

console.log('\nleaving a run keeps it');
{
  const g = makeGame({ mode: 'endless' });
  g.started = true;
  for (let i = 0; i < 120; i++) { g.updatePerf(1 / 60); g.update(1 / 60); }
  M.forgetRun('endless');
  g.dispose?.();
  check('closing the run writes the last few seconds', Boolean(M.recallRun('endless')), 'saved on dispose');
}

console.log(problems.length ? `\n${problems.length} FAILURES` : '\nTHE GAME REMEMBERS YOUR LAST PLAY');
process.exit(problems.length ? 1 : 0);
