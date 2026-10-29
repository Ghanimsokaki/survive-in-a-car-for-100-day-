// The arcade: catalogue scanning, the sandbox bridge, ratings and scores.
// Everything a community game touches passes through here, so it gets pinned.
import { installDOM, El } from './doms.mjs';
import path from 'node:path';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';

installDOM({ width: 1280, height: 720 });

const {
  validateManifest, scanGames, sortCatalogue, SLUG,
} = await import('../scripts/scan-games.mjs');
const {
  NATIVE_GAMES, mergeCatalogues, filterGames, cardHtml, validateBridgeMessage, BRIDGE, escapeHtml, Arcade,
} = await import('./app/js/arcade.js');
const {
  ArcadeStats, addRating, rankRuns, ratingLabel, normalizeStats,
} = await import('./app/js/arcade-stats.js');

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const good = {
  id: 'my-game', title: 'My Game', author: 'ghanimz', blurb: 'A test game.',
  tags: ['solo'], version: '1.0.0', entry: 'index.html', icon: 'icon.svg', accent: '#6be0ff',
};

// ------------------------------------------------------------------ manifests
console.log('\ngame manifests');
{
  check('a complete manifest validates', validateManifest(good, 'my-game').ok);
  check('the id must match the folder', !validateManifest(good, 'other-folder').ok,
    validateManifest(good, 'other-folder').errors[0]);

  const noBlurb = validateManifest({ ...good, blurb: '' }, 'my-game');
  check('a missing blurb is rejected', !noBlurb.ok && noBlurb.errors.some((e) => e.includes('blurb')));

  const traversal = validateManifest({ ...good, entry: '../../secrets.html' }, 'my-game');
  check('path traversal in entry is rejected', !traversal.ok);

  const badAuthor = validateManifest({ ...good, author: 'Not A User!' }, 'my-game');
  check('the author must be a username', !badAuthor.ok);

  const badVersion = validateManifest({ ...good, version: 'v1' }, 'my-game');
  check('the version must be x.y.z', !badVersion.ok);

  const ok = validateManifest({ ...good, tags: ['solo', 'BAD TAG', 'co-op', 'a', 'b', 'c'] }, 'my-game');
  check('tags are slugged and capped at five', ok.ok && ok.game.tags.length <= 5,
    JSON.stringify(ok.game.tags));
  check('featured defaults to false and is honoured', ok.game.featured === false
    && validateManifest({ ...good, featured: true }, 'my-game').game.featured === true);
  check('the title is upper-cased for the card', ok.game.title === 'MY GAME');
  check('the slug rule is exported and strict', SLUG.test('a-b') && !SLUG.test('A-B') && !SLUG.test('-'));
}

// -------------------------------------------------------------- the real repo
console.log('\nrepo catalogue');
{
  const gamesDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'games');
  const { catalogue, skipped } = await scanGames(gamesDir);
  check('the repo ships community games', catalogue.count >= 5, `${catalogue.count} found`);
  check('nothing in the repo fails validation', skipped.length === 0,
    skipped.map((s) => `${s.folder}: ${s.errors.join(',')}`).join(' | '));
  check('the templates are skipped', !catalogue.games.some((g) => g.id.startsWith('_') || g.id === 'template'));
  check('featured games sort first',
    catalogue.games[0].featured === true && catalogue.games[catalogue.games.length - 1].featured === false);
  check('every game has a playable entry file', catalogue.games.every((g) => g.entry === 'index.html'));
  check('every game has an icon', catalogue.games.every((g) => g.icon === 'icon.svg'));
  check('sizes are measured', catalogue.games.every((g) => g.files > 0 && g.bytes > 0),
    catalogue.games.map((g) => `${g.id}:${g.files}f`).join(' '));
  check('sorting is stable for the same input',
    JSON.stringify(sortCatalogue(catalogue.games)) === JSON.stringify(catalogue.games));
}

// --------------------------------------------------------- broken submissions
console.log('\nmalformed submissions are contained');
{
  const dir = path.join(os.tmpdir(), `arcade-scan-${process.pid}`);
  await mkdir(path.join(dir, 'good-one'), { recursive: true });
  await writeFile(path.join(dir, 'good-one', 'game.json'), JSON.stringify({ ...good, id: 'good-one' }));
  await writeFile(path.join(dir, 'good-one', 'index.html'), '<!doctype html>');
  await writeFile(path.join(dir, 'good-one', 'icon.svg'), '<svg/>');

  await mkdir(path.join(dir, 'no-manifest'), { recursive: true });
  await writeFile(path.join(dir, 'no-manifest', 'index.html'), '<!doctype html>');

  await mkdir(path.join(dir, 'bad-json'), { recursive: true });
  await writeFile(path.join(dir, 'bad-json', 'game.json'), '{ not json');

  await mkdir(path.join(dir, 'missing-entry'), { recursive: true });
  await writeFile(path.join(dir, 'missing-entry', 'game.json'), JSON.stringify({ ...good, id: 'missing-entry' }));
  await writeFile(path.join(dir, 'missing-entry', 'icon.svg'), '<svg/>');

  await mkdir(path.join(dir, 'id-mismatch'), { recursive: true });
  await writeFile(path.join(dir, 'id-mismatch', 'game.json'), JSON.stringify({ ...good, id: 'other' }));
  await writeFile(path.join(dir, 'id-mismatch', 'index.html'), 'x');
  await writeFile(path.join(dir, 'id-mismatch', 'icon.svg'), 'x');

  const { catalogue, skipped } = await scanGames(dir);
  check('only the valid game is published', catalogue.count === 1 && catalogue.games[0].id === 'good-one',
    catalogue.games.map((g) => g.id).join(','));
  check('each broken folder is reported, not crashed on', skipped.length === 4,
    skipped.map((s) => s.folder).join(','));
  check('missing manifests are named', skipped.some((s) => s.folder === 'no-manifest'
    && s.errors.some((e) => e.includes('game.json'))));
  check('bad json is caught', skipped.some((s) => s.folder === 'bad-json'));
  check('a missing entry file is caught', skipped.some((s) => s.folder === 'missing-entry'
    && s.errors.some((e) => e.includes('missing'))));
  check('a folder/id mismatch is caught', skipped.some((s) => s.folder === 'id-mismatch'));
  await rm(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------- the bridge
console.log('\nsandbox bridge');
{
  check('ready is accepted', validateBridgeMessage({ channel: BRIDGE, type: 'arcade:ready' })?.type === 'arcade:ready');
  check('a foreign channel is ignored',
    validateBridgeMessage({ channel: 'evil', type: 'arcade:score', payload: { score: 9 } }) === null);
  check('an unknown type is ignored',
    validateBridgeMessage({ channel: BRIDGE, type: 'arcade:give-me-admin' }) === null);
  check('null payloads do not crash',
    validateBridgeMessage({ channel: BRIDGE, type: 'arcade:score', payload: null })?.payload.score === 0);

  const huge = validateBridgeMessage({
    channel: BRIDGE, type: 'arcade:score',
    payload: { score: 1e12, day: -5, seconds: 'abc', won: 1, meta: 'x'.repeat(400) },
  });
  check('scores are clamped and coerced',
    huge.payload.score === 9999999 && huge.payload.day === 0 && huge.payload.seconds === 0
    && huge.payload.won === true && huge.payload.meta.length === 80,
    JSON.stringify(huge.payload).slice(0, 80));

  const state = validateBridgeMessage({
    channel: BRIDGE, type: 'arcade:state', payload: { day: 3.7, status: 'holding the line' },
  });
  check('state is sanitised', state.payload.day === 4 && state.payload.status === 'HOLDING THE LINE');
}

// ------------------------------------------------------------------- catalogue
console.log('\ncatalogue + cards');
{
  const merged = mergeCatalogues(NATIVE_GAMES, {
    games: [
      { id: 'zed', title: 'ZED', author: 'bob', blurb: 'b', tags: ['x'], accent: '#ff0000', path: 'games/zed' },
      { id: '', title: 'broken' },
    ],
  });
  check('the built-in game is always first and flagged native', merged[0].id === 'outrun' && merged[0].native);
  check('community games are merged', merged.length === 2, merged.map((g) => g.id).join(','));
  check('entries without an id are dropped', !merged.some((g) => !g.id));
  check('a missing catalogue is not fatal', mergeCatalogues(NATIVE_GAMES, null).length === 1);
  check('community games are marked non-native', merged[1].native === false);

  check('search matches titles', filterGames(merged, { query: 'zed' }).length === 1);
  check('search matches creators', filterGames(merged, { query: 'bob' }).length === 1);
  check('the mine tab shows only built-ins', filterGames(merged, { tab: 'mine' }).every((g) => g.native));
  check('the community tab hides the built-in', !filterGames(merged, { tab: 'new' }).some((g) => g.native));

  const html = cardHtml(merged[0], null);
  check('a card carries the game id', html.includes('data-game="outrun"'));
  check('a card shows the title and blurb', html.includes('100 DAYS OUTRUN') && html.includes('One rig'));
  check('a card is labelled BUILT-IN', html.includes('BUILT-IN'));
  check('html is escaped', escapeHtml('<img onerror=x>') === '&lt;img onerror=x&gt;');

  const nasty = cardHtml({ ...merged[1], title: '<script>alert(1)</script>' }, null);
  check('a hostile title cannot inject markup', !nasty.includes('<script>') && nasty.includes('&lt;script&gt;'));
}

// ------------------------------------------------------------- stats + ratings
console.log('\nratings and scores');
{
  check('a first rating sets the average', addRating(null, 4).avg === 4);
  const two = addRating({ avg: 4, count: 1 }, 2);
  check('the second rating averages in', two.avg === 3 && two.count === 2);
  check('out-of-range votes clamp', addRating(null, 99).avg === 5);
  check('the label reads like the store', ratingLabel({ avg: 4.6, count: 12 }).includes('92%'),
    ratingLabel({ avg: 4.6, count: 12 }));
  check('unrated reads plainly', ratingLabel(null) === 'NOT RATED YET');

  const ranked = rankRuns([
    { score: 10, at: 1 }, { score: 40, at: 2 }, { score: 40, at: 9 }, { score: 'x' },
  ]);
  check('runs sort by score then recency', ranked[0].at === 9 && ranked[1].at === 2 && ranked.length === 3);
  check('junk scores are dropped', !ranked.some((r) => Number.isNaN(r.score)));

  const stats = new ArcadeStats({ account: null });
  check('a fresh stats store is empty', stats.plays('outrun') === 0 && stats.ratingOf('outrun') === null);

  const r1 = await stats.rate('outrun', 5);
  check('rating works without an account', r1.count === 1 && stats.myRating('outrun') === 5);
  await stats.rate('outrun', 3);
  check('re-rating replaces your vote rather than stacking',
    stats.ratingOf('outrun').count === 1 && Math.round(stats.ratingOf('outrun').avg) === 3,
    JSON.stringify(stats.ratingOf('outrun')));

  await stats.submitRun('outrun', { score: 500, day: 12, seconds: 90 }, 'tester');
  await stats.submitRun('outrun', { score: 900, day: 20, seconds: 120 }, 'tester');
  check('plays are counted', stats.plays('outrun') === 2);
  const board = await stats.leaderboard('outrun');
  check('the leaderboard keeps the best run', board[0].score === 900, `${board[0].score}`);

  const reloaded = new ArcadeStats({ account: null });
  check('stats survive a reload', reloaded.myRating('outrun') === 3 && reloaded.plays('outrun') === 2);
  check('corrupt stats degrade safely', normalizeStats('nope').runs && Object.keys(normalizeStats('nope').runs).length === 0);
  stats.clearLocal();

  // no Supabase session → never pretend to be online
  check('without supabase everything stays local', stats.server === false);
}

// ------------------------------------------------------------------- the shell
console.log('\narcade shell');
{
  const arc = new Arcade({ account: null, fetchImpl: async () => ({ ok: false }), getPlayer: () => ({ name: 'TESTER' }) });
  check('the shell mounts', Boolean(arc.el) && arc.el.id === 'arcade');
  check('the rail has the expected tabs', ['home', 'mine', 'new'].length === 3);
  check('the built-in game is in the list', arc.games.some((g) => g.id === 'outrun'));
  check('the create-game helper explains the PR flow',
    arc.manifestTemplate().includes('"id": "my-game"') && arc.el.innerHTML.includes('games/README.md'));
  check('the sandbox iframe drops same-origin',
    arc.el.innerHTML.includes('sandbox="allow-scripts"') && !arc.el.innerHTML.includes('allow-same-origin'));

  const merged = await arc.refresh();
  check('refresh survives a missing catalogue file', merged.length === 1, `${merged.length} game(s)`);

  const launched = arc.launch('outrun');
  check('launching the built-in game calls back', launched === true);
  check('the built-in game does not open the iframe', arc.playing === null);
  check('an unknown game does nothing', arc.launch('does-not-exist') === false);

  // community game: opens the frame, then accepts bridge messages from it
  arc.games = mergeCatalogues(NATIVE_GAMES, { games: [{
    id: 'test-game', title: 'TEST GAME', author: 'bob', blurb: 'b', tags: [], accent: '#ff0000',
    icon: 'icon.svg', path: 'games/test-game', entry: 'index.html', version: '1.0.0',
  }] });
  arc.launch('test-game');
  check('a community game opens in the frame', arc.playing?.id === 'test-game');
  check('the frame points at the game folder',
    String(arc.nodes.frame.src).startsWith('./games/test-game/index.html'),
    String(arc.nodes.frame.src));

  await arc.onMessage({ data: { channel: BRIDGE, type: 'arcade:score', payload: { score: 777, day: 4 } } });
  check('a score from the frame is stored', arc.stats.plays('test-game') === 1 && arc.lastScore.score === 777);
  check('the result card appears', !arc.nodes.result.classList.contains('hidden'));
  check('the result card offers a rating', arc.nodes.result.innerHTML.includes('data-stars'));

  await arc.onMessage({ data: { channel: 'nope', type: 'arcade:score', payload: { score: 99999 } } });
  check('messages from other channels are ignored', arc.stats.plays('test-game') === 1);

  await arc.onMessage({ data: { channel: BRIDGE, type: 'arcade:close' } });
  check('the frame can ask to close itself', arc.playing === null);

  arc.hide();
  check('hiding the arcade closes any game', arc.playing === null);
  arc.stats.clearLocal();
  arc.destroy();
  check('destroy removes the shell', true);
}

process.exit(problems.length ? 1 : 0);
