// Verifies that Vercel environment variables reach the browser in every
// supported spelling, and that unsafe configs are refused rather than shipped.
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig, resolveSupabaseConfig, inspectKey, URL_VARS, KEY_VARS } from '../lib/supabase-env.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const fails = [];
const check = (label, cond, extra = '') => {
  if (cond) console.log(`  ok  ${label}${extra ? ` — ${extra}` : ''}`);
  else { console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); fails.push(label); }
};

// realistic-ish tokens (not valid signatures, but the right shape)
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const ANON = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'anon', exp: 2000000000 })}.sig`;
const SERVICE = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${b64({ iss: 'supabase', ref: 'abcdefghijklmnop', role: 'service_role', exp: 2000000000 })}.sig`;
const PUBLISHABLE = `sb_publishable_${'x'.repeat(40)}`;
const SECRET = `sb_secret_${'y'.repeat(40)}`;

console.log('\nvariable spellings');
{
  const cases = [
    ['SUPABASE_URL + SUPABASE_ANON_KEY', { SUPABASE_URL: 'https://one.supabase.co', SUPABASE_ANON_KEY: ANON }, 'SUPABASE_URL', 'SUPABASE_ANON_KEY'],
    ['NEXT_PUBLIC_* (Vercel integration)', { NEXT_PUBLIC_SUPABASE_URL: 'https://two.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON }, 'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    ['VITE_*', { VITE_SUPABASE_URL: 'https://three.supabase.co', VITE_SUPABASE_ANON_KEY: ANON }, 'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'],
    ['SUPABASE_PUBLISHABLE_KEY (new dashboard)', { SUPABASE_URL: 'https://four.supabase.co', SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE }, 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY'],
    ['legacy SUPABASE_KEY', { SUPABASE_URL: 'https://five.supabase.co', SUPABASE_KEY: ANON }, 'SUPABASE_URL', 'SUPABASE_KEY'],
    ['mixed spellings', { NEXT_PUBLIC_SUPABASE_URL: 'https://six.supabase.co', SUPABASE_ANON_KEY: ANON }, 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_ANON_KEY'],
  ];
  for (const [label, env, urlVar, keyVar] of cases) {
    const r = resolveSupabaseConfig(env);
    check(label, r.configured && r.urlVar === urlVar && r.keyVar === keyVar, `${r.urlVar} / ${r.keyVar}`);
  }
}

console.log('\nnormalisation');
{
  const r = resolveSupabaseConfig({ SUPABASE_URL: '  https://seven.supabase.co/  ', SUPABASE_ANON_KEY: ` ${ANON} ` });
  check('trims whitespace and trailing slash', r.url === 'https://seven.supabase.co' && r.key === ANON, r.url);

  const rest = resolveSupabaseConfig({ SUPABASE_URL: 'https://eight.supabase.co/rest/v1', SUPABASE_ANON_KEY: ANON });
  check('accepts a pasted REST endpoint', rest.url === 'https://eight.supabase.co', rest.url);

  const keyOnly = resolveSupabaseConfig({ SUPABASE_ANON_KEY: ANON });
  check('derives the URL from the key when URL is missing', keyOnly.url === 'https://abcdefghijklmnop.supabase.co' && keyOnly.urlFromKey, keyOnly.url);

  const info = inspectKey(ANON);
  check('inspectKey reads role + project ref', info.role === 'anon' && info.ref === 'abcdefghijklmnop');
}

console.log('\nsafety');
{
  const svc = resolveSupabaseConfig({ SUPABASE_URL: 'https://nine.supabase.co', SUPABASE_ANON_KEY: SERVICE });
  check('service_role key is refused', !svc.configured && svc.key === '');
  check('service_role refusal is explained', svc.problems.some((p) => /service_role|SECRET/i.test(p)), svc.problems[0]);

  const sec = resolveSupabaseConfig({ SUPABASE_URL: 'https://ten.supabase.co', SUPABASE_SECRET_KEY: SECRET, SUPABASE_ANON_KEY: SECRET });
  check('sb_secret_ key is refused', !sec.configured);

  const junk = resolveSupabaseConfig({ SUPABASE_URL: 'ftp://nope', SUPABASE_ANON_KEY: 'short' });
  check('bad URL and short key are rejected', !junk.configured);
  check('bad URL is explained', junk.problems.some((p) => /https/.test(p)));

  const empty = resolveSupabaseConfig({});
  check('empty env reports both missing vars', empty.problems.length === 2 && !empty.configured, empty.problems.join(' | '));

  const publicShape = publicConfig({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: ANON }, 'vercel-serverless');
  check('public payload carries url + key + flags', publicShape.supabaseUrl && publicShape.supabaseAnonKey && publicShape.env.hasUrl && publicShape.env.hasKey);
  check('public payload never leaks the raw env name of a secret', !JSON.stringify(publicShape).includes('service_role'));
}

console.log('\n/api/config handler (Vercel contract)');
{
  const { default: handler } = await import('../api/config.js');
  const call = (env) => new Promise((resolve) => {
    const saved = { ...process.env };
    for (const key of Object.keys(process.env)) if (key.startsWith('SUPABASE')) delete process.env[key];
    Object.assign(process.env, env);
    const res = {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) {
        for (const key of Object.keys(process.env)) if (key.startsWith('SUPABASE')) delete process.env[key];
        Object.assign(process.env, saved);
        resolve({ status: this.statusCode, headers: this.headers, json: JSON.parse(body) });
      },
    };
    handler({ method: 'GET' }, res);
  });

  const good = await call({ SUPABASE_URL: 'https://vercel.supabase.co', SUPABASE_ANON_KEY: ANON });
  check('handler serves the url + key', good.json.supabaseUrl === 'https://vercel.supabase.co' && good.json.supabaseAnonKey === ANON);
  check('handler marks it configured', good.json.configured === true);
  check('handler reports which vars it used', good.json.env.urlVar === 'SUPABASE_URL' && good.json.env.keyVar === 'SUPABASE_ANON_KEY');
  check('handler is not cacheable', /no-store/.test(good.headers['cache-control']));

  const missing = await call({});
  check('handler survives an empty environment', missing.status === 200 && missing.json.configured === false);
  check('handler explains what is missing', missing.json.problems.length === 2, missing.json.problems.join(' | '));
}

console.log('\nbuild bakes config for static hosts');
{
  const dist = path.join(root, 'dist');
  await rm(dist, { recursive: true, force: true });
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
      cwd: root,
      env: { ...process.env, SUPABASE_URL: 'https://built.supabase.co', SUPABASE_ANON_KEY: ANON },
    });
    child.on('exit', resolve);
  });
  check('build succeeds with env vars', code === 0);

  const cfg = JSON.parse(await readFile(path.join(dist, 'config.json'), 'utf8'));
  check('dist/config.json has the credentials', cfg.supabaseUrl === 'https://built.supabase.co' && cfg.supabaseAnonKey === ANON);
  check('dist/config.json is marked configured', cfg.configured === true);

  const inline = await readFile(path.join(dist, 'supabase-config.js'), 'utf8');
  check('inline fallback script written', inline.includes('built.supabase.co') && inline.includes(ANON));

  const html = await readFile(path.join(dist, 'index.html'), 'utf8');
  check('index.html loads the inline fallback before main.js',
    html.indexOf('supabase-config.js') > 0 && html.indexOf('supabase-config.js') < html.indexOf('js/main.js'));

  // and the guest-only build when nothing is set
  await rm(dist, { recursive: true, force: true });
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', 'build.mjs')], {
      cwd: root,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SUPABASE'))),
    });
    child.on('exit', resolve);
  });
  const guestCfg = JSON.parse(await readFile(path.join(dist, 'config.json'), 'utf8'));
  check('guest build still writes config.json', guestCfg.configured === false && guestCfg.supabaseUrl === '');
  check('guest build leaves the game playable', (await readFile(path.join(dist, 'index.html'), 'utf8')).includes('js/main.js'));
  await rm(dist, { recursive: true, force: true });
}

console.log('\nguard: every documented variable name is actually read');
{
  for (const name of URL_VARS) {
    check(`URL var ${name}`, resolveSupabaseConfig({ [name]: 'https://v.supabase.co', SUPABASE_ANON_KEY: ANON }).configured);
  }
  for (const name of KEY_VARS) {
    check(`KEY var ${name}`, resolveSupabaseConfig({ SUPABASE_URL: 'https://v.supabase.co', [name]: ANON }).configured);
  }
}

console.log(fails.length ? `\nFAILED: ${fails.join(', ')}` : '\nALL ENV TESTS PASSED');
process.exit(fails.length ? 1 : 0);
