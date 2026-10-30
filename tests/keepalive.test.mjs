// The self-ping that keeps a free Render container from falling asleep.
// Everything here uses a real local HTTP server — no fake sockets, no network.
import http from 'node:http';
import {
  DEFAULT_INTERVAL_MS, DEFAULT_PATH, DEFAULT_TIMEOUT_MS,
  normaliseUrl, resolvePublicUrl, resolveInterval, ping, startKeepAlive,
} from '../lib/keepalive.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server that answers with a fixed status and counts its hits. */
async function countingServer(status = 200, { delayMs = 0 } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), url: req.url, ua: req.headers['user-agent'] || '' });
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, delayMs);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    port,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// ------------------------------------------------------------------- URLs ---
console.log('\nwhere does the server live?');
{
  check('a bare host gets https', normaliseUrl('gemby-game.onrender.com') === 'https://gemby-game.onrender.com');
  check('a trailing slash is trimmed', normaliseUrl('https://x.test/') === 'https://x.test');
  check('a path is kept', normaliseUrl('http://x.test/api/health') === 'http://x.test/api/health');
  check('an explicit port is kept', normaliseUrl('http://127.0.0.1:8080') === 'http://127.0.0.1:8080');
  check('other schemes are refused', normaliseUrl('ftp://x.test') === '');
  check('nonsense is refused', normaliseUrl('not a url') === '' && normaliseUrl('') === '' && normaliseUrl(null) === '');

  check('RENDER_EXTERNAL_URL is the first choice',
    resolvePublicUrl({ RENDER_EXTERNAL_URL: 'https://outrun.onrender.com' }) === 'https://outrun.onrender.com');
  check('PUBLIC_URL / SELF_URL / KEEPALIVE_URL work as overrides',
    resolvePublicUrl({ PUBLIC_URL: 'https://a.test' }) === 'https://a.test' &&
    resolvePublicUrl({ SELF_URL: 'https://b.test' }) === 'https://b.test' &&
    resolvePublicUrl({ KEEPALIVE_URL: 'https://c.test' }) === 'https://c.test');
  check('hostname-only envs are understood',
    resolvePublicUrl({ RENDER_EXTERNAL_HOSTNAME: 'h.test' }) === 'https://h.test');
  check('the service name is enough to guess the URL',
    resolvePublicUrl({ RENDER_SERVICE_NAME: 'outrun' }) === 'https://outrun.onrender.com');
  check('with nothing set there is no URL', resolvePublicUrl({}) === '');
}

console.log('\nhow often?');
{
  check('ten minutes by default', DEFAULT_INTERVAL_MS === 600_000);
  check('…and the health path', DEFAULT_PATH === '/health');
  check('KEEPALIVE_MINUTES scales it', resolveInterval({ KEEPALIVE_MINUTES: '2' }) === 120_000);
  check('KEEPALIVE_MS overrides for tests', resolveInterval({ KEEPALIVE_MS: '1500' }) === 1500);
  check('an absurd interval is clamped up', resolveInterval({ KEEPALIVE_MS: '5' }) === 250);
  check('junk falls back to ten minutes',
    resolveInterval({ KEEPALIVE_MINUTES: 'soon' }) === DEFAULT_INTERVAL_MS &&
    resolveInterval({ KEEPALIVE_MS: '' }) === DEFAULT_INTERVAL_MS);
}

// ------------------------------------------------------------------- ping ---
console.log('\nthe request itself');
{
  const ok = await countingServer(200);
  const first = await ping(`${ok.url}/health`);
  check('a healthy server answers 200', first.ok === true && first.status === 200);
  check('…and the request actually arrived', ok.hits.length === 1 && ok.hits[0].url === '/health');
  check('…identified as the game', /gemby-games/.test(ok.hits[0].ua), ok.hits[0].ua);
  check('…timed', first.ms >= 0 && typeof first.ms === 'number');

  const teapot = await countingServer(503);
  const bad = await ping(teapot.url);
  check('a 5xx still counts as a delivered ping', bad.ok === true && bad.status === 503);

  const dead = await countingServer(200);
  const deadUrl = `${dead.url}/health`;
  await dead.close();
  const refused = await ping(deadUrl, { timeoutMs: 1500 });
  check('a refused connection is reported, not thrown', refused.ok === false && Boolean(refused.error),
    refused.error);

  const slow = await countingServer(200, { delayMs: 400 });
  const timedOut = await ping(`${slow.url}/health`, { timeoutMs: 60 });
  check('a hung server times out', timedOut.ok === false && timedOut.error === 'timeout', timedOut.error);
  await slow.close();

  check('a bad URL never throws', (await ping('nonsense')).error === 'bad_url');
  check('the default timeout is generous but finite', DEFAULT_TIMEOUT_MS >= 5000);
  await ok.close();
}

// ------------------------------------------------------------- the loop ---
console.log('\nthe loop');
{
  // no URL → nothing happens, and it says why
  const lines = [];
  const idle = startKeepAlive({ env: {}, log: (m) => lines.push(m) });
  check('without a URL it stays off', idle.state().enabled === false);
  check('…and explains itself', lines.join(' ').includes('RENDER_EXTERNAL_URL'), lines.join(' '));
  check('…with no timer holding the process open', (await idle.runOnce()) === null);
  idle.stop();

  // explicitly off
  const offLines = [];
  const off = startKeepAlive({
    env: { RENDER_EXTERNAL_URL: 'https://x.test', KEEPALIVE: '0' },
    log: (m) => offLines.push(m),
  });
  check('KEEPALIVE=0 switches it off', off.state().enabled === false);
  check('…even with a URL set', offLines.join(' ').includes('disabled'), offLines.join(' '));
  off.stop();

  // the real thing, accelerated
  const server = await countingServer(200);
  const logs = [];
  const warns = [];
  const ka = startKeepAlive({
    env: { RENDER_EXTERNAL_URL: server.url },
    intervalMs: 200,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
    jitter: false,
  });
  check('a URL turns it on', ka.state().enabled === true && ka.state().url === `${server.url}/health`);
  check('the interval is reported', ka.state().intervalMs === 200, String(ka.state().intervalMs));
  check('the boot log names the target', logs.join(' ').includes(`${server.url}/health`), logs[0]);

  await sleep(900);
  const state = ka.state();
  check('it pings on a timer', state.pings >= 2, `${state.pings} pings`);
  check('…and the server really received them', server.hits.length === state.pings, `${server.hits.length} hits`);
  check('…with a healthy status recorded', state.lastStatus === 200 && state.failures === 0);
  check('…and a timestamp', state.lastAt > 0);

  const manual = await ka.runOnce();
  check('runOnce() is available for a forced check', manual?.status === 200);

  ka.stop();
  const afterStop = server.hits.length;
  await sleep(500);
  check('stop() ends the loop', server.hits.length === afterStop);

  await server.close();
}

console.log('\na failing target does not take the server down');
{
  const dead = await countingServer(200);
  const url = dead.url;
  await dead.close();
  const warns = [];
  const ka = startKeepAlive({
    env: { RENDER_EXTERNAL_URL: url },
    intervalMs: 150,
    jitter: false,
    log: () => {},
    warn: (m) => warns.push(m),
    timeoutMs: 500,
  });
  await sleep(600);
  const state = ka.state();
  check('failures are counted', state.failures >= 1, `${state.failures}`);
  check('…and named', Boolean(state.lastError), state.lastError);
  check('…and warned about', warns.some((w) => w.includes('failed')), warns[0] || '');
  ka.stop();
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL KEEPALIVE TESTS PASSED');
process.exit(problems.length ? 1 : 0);
