// CORS: open by default (any front-end), closed on request (ALLOWED_ORIGINS /
// CORS=strict). The socket handshake and every HTTP route share one predicate.
import {
  DEFAULT_ORIGINS, parseOrigins, createCorsPolicy, socketIoCors,
} from '../lib/cors-policy.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const open = createCorsPolicy({ env: {} });

console.log('\nopen by default');
{
  check('the policy is open', open.open === true && open.mode === 'open');
  check('it says so in one value', JSON.stringify(open.origins) === '["*"]');
  check('the Vercel front-end connects', open.allowed('https://gemby-game.vercel.app'));
  check('any other front-end connects too', open.allowed('https://someone-else.example.com'));
  check('a local preview connects', open.allowed('https://8000-abc123.e2b.app'));
  check('a lookalike connects — the tunnel is open, there is nothing to steal',
    open.allowed('https://gemby-game.vercel.app.evil.com'));
  check('no Origin header is fine', open.allowed(undefined) && open.allowed(''));
  check('a sandboxed iframe ("null") is fine', open.allowed('null'));
  check('junk cannot crash it', open.allowed('not-a-url') === true);
}

console.log('\nthe socket handshake follows the same decision');
{
  const ios = socketIoCors(open);
  check('open mode reflects whatever the browser sent', ios.origin === true);
  check('credentials are permitted (there are none, but preflights are simpler)',
    ios.credentials === true);
  check('a GET/POST preflight is enough', JSON.stringify(ios.methods) === '["GET","POST"]');
}

console.log('\nlocking it down with ALLOWED_ORIGINS');
{
  const locked = createCorsPolicy({ env: { ALLOWED_ORIGINS: 'https://gemby-game.vercel.app' } });
  check('setting a list closes the door', locked.open === false && locked.mode === 'allowlist');
  check('the listed origin is allowed', locked.allowed('https://gemby-game.vercel.app'));
  check('…with a trailing slash', locked.allowed('https://gemby-game.vercel.app/'));
  check('…and in any case', locked.allowed('HTTPS://GEMBY-GAME.VERCEL.APP'));
  check('an unlisted origin is refused', locked.allowed('https://evil.example.com') === false);
  check('a lookalike is refused', locked.allowed('https://gemby-game.vercel.app.evil.com') === false);
  check('no Origin header still passes', locked.allowed(undefined) && locked.allowed('null'));
  check('localhost and LAN phones still pass',
    locked.allowed('http://localhost:8000') && locked.allowed('http://192.168.1.42:8000'));

  const wild = createCorsPolicy({ env: { ALLOWED_ORIGINS: 'https://*.vercel.app' } });
  check('a wildcard covers preview deploys', wild.allowed('https://outrun-abc123.vercel.app'));
  check('…but not a bare domain', wild.allowed('https://vercel.app') === false);
  check('…nor a lookalike host', wild.allowed('https://evil-vercel.app') === false);
  check('…nor another scheme', wild.allowed('http://outrun-abc123.vercel.app') === false);

  const injected = createCorsPolicy({ env: {}, extra: ['https://one.example.com'] });
  check('the `extra` option counts as a list', injected.mode === 'allowlist' && injected.allowed('https://one.example.com'));
  check('…and closes everything else', injected.allowed('https://two.example.com') === false);

  const closedSockets = socketIoCors(locked);
  let allowed = null;
  closedSockets.origin('https://gemby-game.vercel.app', (err, ok) => { allowed = !err && ok === true; });
  check('the handshake agrees with the HTTP policy', allowed === true);
  let err = null;
  closedSockets.origin('https://evil.example.com', (e) => { err = e; });
  check('…and refuses a stranger with an error', err instanceof Error && /not allowed/.test(err.message), err?.message);
}

console.log('\nCORS=strict uses the built-in list');
{
  const strict = createCorsPolicy({ env: { CORS: 'strict' } });
  check('the mode is reported', strict.open === false && strict.mode === 'strict');
  check('gemby-game.vercel.app is in it', DEFAULT_ORIGINS.includes('https://gemby-game.vercel.app'));
  check('…and is allowed', strict.allowed('https://gemby-game.vercel.app'));
  check('an arbitrary front-end is refused', strict.allowed('https://evil.example.com') === false);
  check('a Vercel preview URL is not faked', strict.allowed('https://gemby-game-preview.vercel.app') === false);
  check('a list beats the strict default',
    createCorsPolicy({ env: { CORS: 'strict', ALLOWED_ORIGINS: 'https://only.test' } }).allowed('https://only.test'));
}

console.log('\nparsing');
{
  check('commas and spaces both split',
    JSON.stringify(parseOrigins('https://a.com, https://b.com  https://c.com')) ===
      JSON.stringify(['https://a.com', 'https://b.com', 'https://c.com']));
  check('slashes are trimmed', JSON.stringify(parseOrigins('https://a.com//')) === '["https://a.com"]');
  check('an empty value is an empty list', parseOrigins('').length === 0 && parseOrigins(undefined).length === 0);
  check('an array works too', parseOrigins(['https://a.com', 'https://b.com']).length === 2);
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL CORS TESTS PASSED');
process.exit(problems.length ? 1 : 0);
