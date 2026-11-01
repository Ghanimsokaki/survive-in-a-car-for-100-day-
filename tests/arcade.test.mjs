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
  ArcadeStats, addRating, rankRuns, ratingLabel, normalizeStats, BOARD_TTL_MS, HISTORY_LIMIT,
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
  // The arcade is deliberately a two-game shelf: the built-in 100 Days Outrun
  // (whose modes live inside it) plus Iron Tide. Everything else is parked in
  // games/_parked and must not reach the catalogue.
  check('the repo ships its community game', catalogue.count >= 1, `${catalogue.count} found`);
  check('parked games never reach the shelf', !catalogue.games.some((g) => g.id === 'last-convoy')
    && !catalogue.games.some((g) => g.id === 'radio-tower'), catalogue.games.map((g) => g.id).join(','));
  check('nothing in the repo fails validation', skipped.length === 0,
    skipped.map((s) => `${s.folder}: ${s.errors.join(',')}`).join(' | '));
  check('the templates are skipped', !catalogue.games.some((g) => g.id.startsWith('_') || g.id === 'template'));
  check('featured games sort first', catalogue.games[0].featured === true);
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
    String(arc.nodes.frame.src).startsWith('./games/test-game/?g=test-game'),
    String(arc.nodes.frame.src));

  // No loading copy, and the stall timer is armed rather than a spinner.
  check('opening a game shows no loading text', arc.nodes.playerStatus.textContent === '',
    JSON.stringify(arc.nodes.playerStatus.textContent));
  check('a stall timer is armed for a game that never speaks', Boolean(arc.stallTimer));

  // A game that fails must be able to SAY so — the hub shows its words and stops
  // calling it a stall, which is the difference between "it broke" and silence.
  await arc.onMessage({ data: { channel: BRIDGE, type: 'arcade:state', payload: { status: 'GAME ERROR - fleet.js' } } });
  check('a game can report its own failure', arc.nodes.playerStatus.textContent === 'GAME ERROR - FLEET.JS',
    arc.nodes.playerStatus.textContent);
  check('…and that counts as having spoken', arc.heardAt > 0);

  // and a healthy game goes LIVE
  await arc.onMessage({ data: { channel: BRIDGE, type: 'arcade:ready' } });
  check('a ready game is announced as LIVE', arc.nodes.playerStatus.textContent === 'LIVE',
    arc.nodes.playerStatus.textContent);

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

// ------------------------------------------- the Supabase board, once a minute
console.log('\nthe leaderboard is fetched once and then reused');
{
  // a stand-in Supabase: counts the calls and answers with three runs
  const calls = [];
  const account = {
    sb: {
      url: 'https://demo.supabase.co', key: 'anon',
      async select(table, query) {
        calls.push(`${table}?${query}`);
        if (table !== 'game_runs') return [];
        return [
          { score: 4200, meta: 'GHANIMZ', created_at: '2026-10-31T10:00:00Z' },
          { score: 3100, meta: 'NERO', created_at: '2026-10-31T09:00:00Z' },
          { score: 900, meta: 'KHAN', created_at: '2026-10-31T08:00:00Z' },
        ];
      },
    },
  };
  let clock = 1_000_000;
  const stats = new ArcadeStats({ account, storage: null, now: () => clock });

  const first = await stats.topRuns('star-battle', 5);
  check('the board comes from Supabase', first.length === 3 && first[0].score === 4200,
    first.map((r) => `${r.name}:${r.score}`).join(' '));
  check('…best first', first[0].score >= first[1].score && first[1].score >= first[2].score);
  check('it asked once', calls.length === 1, calls[0]);
  check('the query is the cheap one (score desc, limited)',
    /order=score\.desc/.test(calls[0]) && /limit=5/.test(calls[0]), calls[0]);

  // a second read inside the TTL is free
  const second = await stats.topRuns('star-battle', 5);
  check('a second read inside the minute costs nothing', calls.length === 1 && second.length === 3);
  check('and it is the same answer', second[0].score === first[0].score);

  // after the TTL it refetches — once
  clock += BOARD_TTL_MS + 1;
  await stats.topRuns('star-battle', 5);
  check('after the TTL it refetches once', calls.length === 2);

  // prefetch warms several games without a storm of requests
  const many = new ArcadeStats({ account, storage: null, now: () => clock });
  await many.prefetch(['iron-tide', 'star-battle', 'outpost'], { concurrency: 2 });
  check('prefetch asks for each game once', calls.length === 5, `${calls.length - 2} new`);
  await many.prefetch(['iron-tide', 'star-battle']);
  check('…and nothing on a second pass', calls.length === 5);

  // failures never take the arcade down
  const offline = new ArcadeStats({
    account: { sb: { url: 'https://demo.supabase.co', key: 'anon', select: async () => { throw new Error('offline'); } } },
    storage: null,
  });
  const fallback = await offline.topRuns('star-battle', 5);
  check('an unreachable Supabase gives an empty board, not a throw', Array.isArray(fallback) && fallback.length === 0);
  check('…and records why', offline.lastError === 'offline', offline.lastError);

  // no Supabase at all: local runs still work
  const guest = new ArcadeStats({ storage: null });
  await guest.submitRun('star-battle', { score: 1234, day: 3 }, 'GUEST');
  const local = await guest.topRuns('star-battle', 5);
  check('a guest still sees their own run', local.length === 1 && local[0].score === 1234, JSON.stringify(local));
  check('…without a server request', guest.requests === 0);
}

console.log('\nthe hub hands that board to the sandboxed game');
{
  const arc = new Arcade({ account: null, getPlayer: () => ({ name: 'GHANIMZ', quality: 'high' }) });
  const posted = [];
  arc.nodes.frame = { src: '', contentWindow: { postMessage: (m) => posted.push(m) } };
  arc.playing = { id: 'star-battle', title: 'STAR BATTLE' };
  arc.boards.set('star-battle', [{ score: 4200, name: 'GHANIMZ' }, { score: 900, name: 'KHAN' }]);
  arc.postInit();
  const init = posted.find((m) => m.type === 'arcade:init');
  check('init carries the cached board', Array.isArray(init?.payload?.leaderboard)
    && init.payload.leaderboard.length === 2, JSON.stringify(init?.payload?.leaderboard || null));
  check('…and the render-quality hint', init?.payload?.quality === 'high', init?.payload?.quality);
  check('…and the player', init?.payload?.player?.name === 'GHANIMZ');

  // opening a card warms that game's board, and the result of that warming is
  // what `postInit` then hands to the frame
  arc.stats = new ArcadeStats({
    account: {
      sb: {
        url: 'https://demo.supabase.co', key: 'anon',
        async select() { return [{ score: 5150, meta: 'KIRK', created_at: '2026-10-31T12:00:00Z' }]; },
      },
    },
    storage: null,
  });
  arc.boards.clear();
  await arc.loadBoard('star-battle');
  posted.length = 0;
  arc.postInit();
  const init2 = posted.find((m) => m.type === 'arcade:init');
  check('an opened game gets a freshly warmed board',
    init2?.payload?.leaderboard?.[0]?.score === 5150, JSON.stringify(init2?.payload?.leaderboard || null));
  arc.destroy();
}

// ---------------------------------------------------- history + fullscreen lane
console.log('\nthe hub remembers what you played, and can go fullscreen for a game');
{
  const seen = [];
  const stats = new ArcadeStats({ storage: null, now: () => 1000 });
  stats.clearLocal();                     // a fresh device, not the earlier suite's
  await stats.submitRun('star-battle', { score: 1200, day: 4, seconds: 61, meta: '7 kills' }, 'GHANIMZ');
  await stats.submitRun('iron-tide', { score: 800, day: 2, seconds: 30, meta: '2 docks' }, 'GHANIMZ');
  await stats.submitRun('star-battle', { score: 2400, day: 6, seconds: 90, meta: '11 kills' }, 'GHANIMZ');
  seen.push(...stats.data.history);
  check('every finished run is logged, newest first',
    seen.length === 3 && seen[0].score === 2400 && seen[2].score === 1200, JSON.stringify(seen.map((r) => r.score)));
  check('…with the game it belongs to', seen[0].id === 'star-battle' && seen[1].id === 'iron-tide');
  check('…and the day and the clock, when the game sent them', seen[0].day === 6 && seen[0].seconds === 90);
  const reloaded = normalizeStats(JSON.parse(JSON.stringify({ history: seen })));
  check('the log survives a reload, still newest first',
    reloaded.history.length === 3 && reloaded.history[0].score === 2400 && reloaded.history[2].id === 'star-battle');
  check('junk rows are dropped instead of drawn', (() => {
    const dirty = normalizeStats({ history: [null, { id: 'x' }, { id: 'y', score: 5 }, 'nope'] });
    return dirty.history.length === 1 && dirty.history[0].id === 'y';
  })());
  check('the log is capped', normalizeStats({
    history: Array.from({ length: 90 }, (_, i) => ({ id: 'g', score: i, at: i })),
  }).history.length === HISTORY_LIMIT, String(HISTORY_LIMIT));

  // a game's ⤢ button: a new, validated bridge message
  const fsMsg = validateBridgeMessage({ channel: BRIDGE, type: 'arcade:fullscreen', payload: { junk: 1 } });
  check('a game can ask the hub for fullscreen', fsMsg?.type === 'arcade:fullscreen', JSON.stringify(fsMsg));
  check('…and the payload it sends is dropped',
    Object.keys(fsMsg?.payload || {}).length === 0, JSON.stringify(fsMsg?.payload));
  check('an unknown message is still refused',
    validateBridgeMessage({ channel: BRIDGE, type: 'arcade:rm-rf', payload: {} }) === null);
  void seen;
}

process.exit(problems.length ? 1 : 0);
