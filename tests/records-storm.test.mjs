// Run records, the live storm meter and the workbench "can craft" filter.
// These are the parts a player notices between runs, so they get pinned down.
import { installDOM, El } from './doms.mjs';

installDOM({ width: 1280, height: 720 });

const {
  RECORD_KEY, emptyBook, normalizeBook, loadBook, saveBook, resetBook,
  commitRun, bestLine, careerLine, fmtClock, freshLabels, modeStats, TRACKED,
} = await import('./app/js/records.js');
const { Game } = await import('./app/js/game.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const newGame = (opts = {}) => {
  const g = new Game({
    mount: new El('div', 'app'),
    profile: { name: 'TESTER', color: 0xffb347, carColor: 0xd24a2b },
    room: 'test-room',
    onQuit: () => {},
    ...opts,
  });
  g.started = true;
  return g;
};

// ------------------------------------------------------------------ the book
console.log('\nrecord book');
{
  localStorage.clear();
  const book = emptyBook();
  check('an empty book knows nothing', book.career.runs === 0 && Object.keys(book.modes).length === 0);
  check('a missing store loads an empty book', loadBook().career.runs === 0);
  check('corrupt json degrades to an empty book', normalizeBook({ modes: 'nope', career: 3 }).career.runs === 0);
  check('hand-edited junk numbers are clamped', normalizeBook({
    modes: { classic: { runs: -4, wins: 'x', best: { day: 'abc', distance: 12 } } },
  }).modes.classic.runs === 0);

  const first = commitRun(emptyBook(), 'classic', { day: 12, distance: 4300, kills: 4, itemsLooted: 20, crafted: 3, seconds: 300 });
  check('a first run is logged without a "record" banner', first.first === true && first.fresh.length === 0);
  check('the first run becomes the best', first.best.day === 12 && first.best.distance === 4300);
  check('the career tallies the first run', first.book.career.runs === 1 && first.book.career.km === 4.3);

  const worse = commitRun(first.book, 'classic', { day: 9, distance: 9000, kills: 2, itemsLooted: 4, crafted: 1, seconds: 200 });
  check('a worse day is not a record', worse.fresh.includes('day') === false);
  check('but a longer drive still is', worse.fresh.includes('distance') === true, worse.fresh.join(','));
  check('best day is kept, not overwritten', worse.best.day === 12 && worse.best.distance === 9000);
  check('runs still accumulate', worse.book.career.runs === 2);

  const modeIsolation = commitRun(worse.book, 'siege', { day: 3, distance: 100 });
  check('records are per mode', modeStats(modeIsolation.book, 'siege').best.day === 3
    && modeStats(modeIsolation.book, 'classic').best.day === 12);
  check('a win is counted separately', commitRun(modeIsolation.book, 'classic', { day: 100, won: true }).book.modes.classic.wins === 1);

  check('badge labels are short', freshLabels(['day', 'distance']).join('/') === 'DAY/DIST');
  check('clock formats', fmtClock(300) === '5:00' && fmtClock(3661) === '1:01:01', `${fmtClock(300)} · ${fmtClock(3661)}`);
  check('mode line reads like a scoreboard', bestLine(worse.book, 'classic') === 'BEST DAY 12 · 9.0 KM',
    bestLine(worse.book, 'classic'));
  check('unplayed mode says so', bestLine(worse.book, 'hypercane') === 'NO RUNS YET');
  check('career line has the totals', careerLine(worse.book).includes('2 RUNS'), careerLine(worse.book));
  check('empty career line invites a run', careerLine(emptyBook()).includes('NO RUNS YET'));

  saveBook(worse.book);
  check('the book round-trips through storage', loadBook().career.runs === 2);
  check('storage key is stable', localStorage.getItem(RECORD_KEY) !== null);
  check('reset wipes it', resetBook().career.runs === 0 && loadBook().career.runs === 0);
}

// ------------------------------------------------------------ game integration
console.log('\nrun-over card');
{
  localStorage.clear();
  const g = newGame();
  g.day = 21;
  g.distance = 12000;
  g.kills = 7;
  g.itemsLooted = 30;
  g.craftedCount = 5;
  g.car.anchorTier = 3;
  let ended = null;
  g.onRunEnd = (s) => { ended = s; };
  g.die();

  check('dying writes a record', loadBook().modes.classic?.runs === 1);
  check('the summary reaches the caller', ended && ended.day === 21 && ended.anchorTier === 3,
    ended ? `day ${ended.day} · anchors T${ended.anchorTier}` : 'no callback');
  check('the summary carries the record outcome', ended?.record?.first === true);
  check('the run-over card shows a record banner', g.hud.el.goRecord.innerHTML.includes('FIRST RUN LOGGED'),
    g.hud.el.goRecord.innerHTML.slice(0, 60));
  check('the card shows the personal best', g.hud.el.goRecord.innerHTML.includes('PERSONAL BEST'));
  check('the stats list now names the anchor tier',
    g.hud.el.goStats.innerHTML.includes('ANCHORS') && g.hud.el.goStats.innerHTML.includes('TIER 3'));

  const g2 = newGame();
  g2.day = 4;
  g2.die();
  check('a worse second run says "no new record"', g2.hud.el.goRecord.innerHTML.includes('NO NEW RECORD'),
    g2.hud.el.goRecord.innerHTML.slice(0, 60));
  check('two runs are in the book', loadBook().modes.classic.runs === 2);

  // winning a run counts as a clear
  const g3 = newGame({ mode: 'siege' });
  g3.win();
  check('a cleared run is counted as a win', loadBook().modes.siege.wins === 1);
  g3.hud.showGameOver('X', 'Y', [], null);
  check('clearing the record banner is possible', g3.hud.el.goRecord.innerHTML === '');
}

// ---------------------------------------------------------------- storm meter
console.log('\nstorm meter');
{
  const g = newGame();
  g.clearStorms();
  g.hud.stormMeter(null);
  check('no storm → the meter hides', g.hud.el.stormMeter.classList.contains('hidden'));

  const t = g.adminTornado({ category: 3, distance: 60, count: 1 })[0];
  t.group.position.set(g.pos.x + 40, 0, g.pos.z);
  g.updateStormMeter(1 / 60);
  const html = g.hud.el.stormMeter.innerHTML;
  check('a nearby storm shows its category', html.includes('CAT 3'), html.replace(/\s+/g, ' ').slice(0, 70));
  check('and the range', html.includes('40 M'));
  check('anchoring off warns you', html.includes('SPIKES UP'));

  g.car.anchored = true;
  g.inCar = true;
  g.car.anchorTier = 4;
  g._meterKey = '';
  g.updateStormMeter(1 / 60);
  check('tier 4 reads as a ground lock', g.hud.el.stormMeter.innerHTML.includes('GROUND LOCK'));
  check('the meter is coloured good', g.hud.el.stormMeter.className.includes('good'));

  g.car.anchorTier = 1;
  g._meterKey = '';
  g.updateStormMeter(1 / 60);
  check('tier 1 against a Cat 3 reads as slipping', g.hud.el.stormMeter.innerHTML.includes('SLIPPING'),
    g.hud.el.stormMeter.innerHTML.replace(/\s+/g, ' '));

  t.group.position.set(g.pos.x + 400, 0, g.pos.z);
  g.updateStormMeter(1 / 60);
  check('a far storm clears the meter', g.hud.el.stormMeter.classList.contains('hidden'));
  g.clearStorms();
  g.updateTornadoes(1 / 60);
  check('clearing the storms also clears the meter', g.hud.el.stormMeter.classList.contains('hidden'));
}

// ------------------------------------------------------------- bench filtering
console.log('\nworkbench filter');
{
  localStorage.clear();
  const g = newGame();
  g.benchTier = 4;
  g.materials = { scrap: 0, steel: 0, titanium: 0, carbon: 0, leather: 0, chem: 0, cores: 0 };
  g.toggleBench();
  const hud = g.hud;
  const all = hud.recipes.filter((r) => r.tab === 'upgrades').length;
  hud.affordableOnly = false;
  hud.tab = 'upgrades';
  hud.page = 0;
  hud.renderRecipes();
  check('without the filter the whole tree shows', hud.el.count.textContent === `${all} RECIPES`, hud.el.count.textContent);

  hud.el.affordable.dispatch('click');   // the real listener, not a hand-set flag
  check('the filter button flips the filter', hud.affordableOnly === true);
  check('the button lights up when on', hud.el.affordable.classList.contains('on'));
  check('the filter is remembered for next time', localStorage.getItem('outrun-bench-filter') === '1');
  hud.page = 0;
  hud.renderRecipes();
  check('with no materials the filtered list is empty',
    hud.el.recipes.innerHTML.includes('No recipes match'), hud.el.count.textContent);

  g.materials = { scrap: 40, steel: 40, titanium: 40, carbon: 40, leather: 40, chem: 40, cores: 40 };
  hud.inv = g.materials;
  hud.recipes = g.benchRecipes();
  hud.renderRecipes();
  check('with materials the filter keeps only craftable cards',
    !hud.el.recipes.innerHTML.includes('No recipes match') && hud.el.recipes.innerHTML.includes('CRAFT'),
    hud.el.count.textContent);
  check('the filter still hides the ones you cannot afford',
    Number(hud.el.count.textContent.split(' ')[0]) <= all, hud.el.count.textContent);
  hud.el.affordable.dispatch('click');
  check('clicking again turns the filter off',
    hud.affordableOnly === false && localStorage.getItem('outrun-bench-filter') === '0');
  g.toggleBench(false);
}

// ------------------------------------------------------- the in-run best chip
console.log('\nlive best-day tracker');
{
  localStorage.clear();
  saveBook(commitRun(emptyBook(), 'classic', { day: 30, distance: 1000 }).book);
  const g = newGame();
  check('the run knows the record it has to beat', g.bestBefore === 30, String(g.bestBefore));
  check('the top bar shows the best day', g.hud.el.bestRow.textContent === 'BEST DAY 30',
    g.hud.el.bestRow.textContent);
  g.day = 30;
  g.newDay();
  check('passing the record highlights the chip', g.hud.el.bestRow.classList.contains('new') === true,
    `day ${g.day}`);
  const chatText = g.hud.el.chatLog.children.map((c) => c.textContent).join(' | ');
  check('and the chat calls it out', chatText.includes('outlived'), chatText.slice(-60));
  check('the chip now reads the new best', g.hud.el.bestRow.textContent === 'BEST DAY 31',
    g.hud.el.bestRow.textContent);
}

// ------------------------------------------------------------------ the lobby
console.log('\nlobby records');
{
  localStorage.clear();
  const first = commitRun(emptyBook(), 'classic', { day: 33, distance: 21000, kills: 3, itemsLooted: 9, crafted: 2, seconds: 600 });
  saveBook(first.book);
  const { loadBook: reload } = await import('./app/js/records.js');
  const book = reload();
  check('a saved run is visible in the lobby book', bestLine(book, 'classic').includes('BEST DAY 33'),
    bestLine(book, 'classic'));
  check('the career strip totals it', careerLine(book).includes('1 RUN'), careerLine(book));
  check('every tracked stat has a label', TRACKED.every((f) => f.label && f.short));
}

process.exit(problems.length ? 1 : 0);
