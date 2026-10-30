// Who is allowed to open a socket to the game. The front-end ships from Vercel,
// so a wrong allowlist means either a broken game or an open relay.
import {
  DEFAULT_ORIGINS, SANDBOX_ORIGINS, parseOrigins, createCorsPolicy, socketIoCors,
} from '../lib/cors-policy.mjs';

const problems = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); problems.push(label); }
};

const policy = createCorsPolicy({ env: {} });

console.log('\nthe shipping front-end');
{
  check('gemby-game.vercel.app is in the defaults',
    DEFAULT_ORIGINS.includes('https://gemby-game.vercel.app'));
  check('the Vercel deployment is allowed', policy.allowed('https://gemby-game.vercel.app'));
  check('…with www', policy.allowed('https://www.gemby-game.vercel.app'));
  check('…and over plain http', policy.allowed('http://gemby-game.vercel.app'));
  check('a trailing slash still matches', policy.allowed('https://gemby-game.vercel.app/'));
  check('an upper-case origin matches', policy.allowed('HTTPS://GEMBY-GAME.VERCEL.APP'));
  check('a Vercel preview URL is listed separately, not faked',
    policy.allowed('https://gemby-game-preview.vercel.app') === false);
}

console.log('\nlookalikes');
{
  const bad = [
    'https://gemby-game.vercel.app.evil.com',
    'https://evil-gemby-game.vercel.app',
    'https://gemby-game.vercel.app@evil.com',
    'https://gembygame.vercel.app',
    'https://gemby-game.vercel.ap',
    'https://gemby-game.vercel.app:8443',
    'http://gemby-game.vercel.app.evil.com',
    'https://evil.com/?next=https://gemby-game.vercel.app',
  ];
  for (const origin of bad) check(`refused: ${origin}`, policy.allowed(origin) === false);
}

console.log('\nthe live preview');
{
  check('the sandbox domain is a pattern, not an origin', SANDBOX_ORIGINS.includes('https://*.e2b.app'));
  check('a preview URL is allowed', policy.allowed('https://8000-abc123def.e2b.app'));
  check('…over the bare domain too', policy.allowed('https://something.e2b.app'));
  check('a lookalike is still refused', policy.allowed('https://e2b.app.evil.com') === false);
  check('…and so is a hyphenated neighbour', policy.allowed('https://evil-e2b.app') === false);
  const strict = createCorsPolicy({ env: { PREVIEW_ORIGINS: '0' } });
  check('PREVIEW_ORIGINS=0 switches previews off', strict.allowed('https://8000-abc.e2b.app') === false);
  check('…without touching the real deploy', strict.allowed('https://gemby-game.vercel.app'));
}

console.log('\ntooling and phones');
{
  check('no Origin header (curl, native apps) is allowed', policy.allowed(undefined) && policy.allowed(''));
  check('a sandboxed iframe ("null") is allowed', policy.allowed('null'));
  check('localhost is allowed', policy.allowed('http://localhost:8000'));
  check('127.0.0.1 is allowed', policy.allowed('http://127.0.0.1:3000'));
  check('a phone on the same Wi-Fi is allowed', policy.allowed('http://192.168.1.42:8000'));
  check('a public IP is not', policy.allowed('http://8.8.8.8:8000') === false);
  check('garbage is not a free pass', policy.allowed('not-a-url') === false);
}

console.log('\nconfiguration');
{
  check('ALLOWED_ORIGINS is split on commas and spaces',
    JSON.stringify(parseOrigins('https://a.com, https://b.com  https://c.com')) ===
      JSON.stringify(['https://a.com', 'https://b.com', 'https://c.com']));
  check('slashes are trimmed', JSON.stringify(parseOrigins('https://a.com//')) === '["https://a.com"]');
  check('an empty value is an empty list', parseOrigins('').length === 0 && parseOrigins(undefined).length === 0);

  const extra = createCorsPolicy({ env: { ALLOWED_ORIGINS: 'https://run.example.com' } });
  check('an extra origin is honoured', extra.allowed('https://run.example.com'));
  check('…without widening everything', extra.allowed('https://other.example.com') === false);
  check('the defaults survive an override', extra.allowed('https://gemby-game.vercel.app'));

  const wild = createCorsPolicy({ env: { ALLOWED_ORIGINS: 'https://*.vercel.app' } });
  check('a wildcard covers preview deploys', wild.allowed('https://outrun-abc123.vercel.app'));
  check('…but not a bare domain', wild.allowed('https://vercel.app') === false);
  check('…nor a lookalike host', wild.allowed('https://evil-vercel.app') === false);
  check('…nor another scheme', wild.allowed('http://outrun-abc123.vercel.app') === false);
  check('the wildcard is reported as a pattern', wild.patterns.includes('https://*.vercel.app'));

  const injected = createCorsPolicy({ env: {}, extra: ['https://one.example.com'] });
  check('the `extra` option is merged, not ignored', injected.allowed('https://one.example.com'));
  check('origins are deduplicated', new Set(injected.origins).size === injected.origins.length);
}

console.log('\nsocket.io handshake');
{
  const cors = socketIoCors(policy);
  check('it exposes an origin predicate', typeof cors.origin === 'function');
  let allowed = null;
  cors.origin('https://gemby-game.vercel.app', (err, allow) => { allowed = !err && allow === true; });
  check('it allows the front-end', allowed === true);
  let err = null;
  cors.origin('https://evil.com', (e) => { err = e; });
  check('it refuses a stranger with an error', err instanceof Error && /not allowed/.test(err.message), err?.message);
  check('credentials are permitted (the game sends no cookies, but does send no preflight surprises)',
    cors.credentials === true);
  check('a GET/POST preflight is enough', JSON.stringify(cors.methods) === '["GET","POST"]');
}

console.log(problems.length ? `\nFAILED: ${problems.join(', ')}` : '\nALL CORS TESTS PASSED');
process.exit(problems.length ? 1 : 0);
