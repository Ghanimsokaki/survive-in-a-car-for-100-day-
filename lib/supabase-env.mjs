/**
 * Single source of truth for "where do the Supabase credentials come from".
 *
 * Used by:
 *   · api/config.js      → Vercel serverless function
 *   · server.mjs         → local / self-hosted Node relay
 *   · scripts/build.mjs  → bakes public/config.json for static-only hosting
 *
 * Accepts the variable names that Vercel, the Supabase integration, Next.js and
 * Vite projects commonly use, so whatever the dashboard ended up creating will
 * be picked up instead of being silently ignored.
 */

export const URL_VARS = [
  'SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'VITE_SUPABASE_URL',
  'PUBLIC_SUPABASE_URL',
  'NUXT_PUBLIC_SUPABASE_URL',
  'SUPABASE_PROJECT_URL',
];

export const KEY_VARS = [
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_ANON_KEY',
  'PUBLIC_SUPABASE_ANON_KEY',
  'NUXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_PUBLIC_KEY',
  'SUPABASE_KEY', // legacy name some templates still use
];

function pick(env, names) {
  for (const name of names) {
    const raw = env?.[name];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value) return { name, value };
  }
  return null;
}

function base64UrlDecode(input) {
  const normalised = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), '=');
  try {
    if (typeof atob === 'function') {
      const binary = atob(padded);
      return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
    }
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Reads the role + project ref out of a Supabase key without verifying it.
 * Returns { role, ref, kind } where kind is 'jwt' | 'publishable' | 'secret' | 'unknown'.
 */
export function inspectKey(key) {
  const value = String(key || '').trim();
  if (!value) return { kind: 'unknown', role: null, ref: null };

  if (value.startsWith('sb_publishable_')) return { kind: 'publishable', role: 'anon', ref: null };
  if (value.startsWith('sb_secret_')) return { kind: 'secret', role: 'service_role', ref: null };

  if (value.split('.').length === 3) {
    const payload = base64UrlDecode(value.split('.')[1]);
    if (payload) {
      try {
        const claims = JSON.parse(payload);
        return { kind: 'jwt', role: claims.role || null, ref: claims.ref || null };
      } catch { /* fall through */ }
    }
    return { kind: 'jwt', role: null, ref: null };
  }
  return { kind: 'unknown', role: null, ref: null };
}

/**
 * Resolves the browser-facing Supabase config from an environment object.
 * Never throws — problems are returned as readable strings for the UI.
 */
export function resolveSupabaseConfig(env = process.env) {
  const urlHit = pick(env, URL_VARS);
  const keyHit = pick(env, KEY_VARS);
  const problems = [];

  let url = urlHit?.value || '';
  let urlVar = urlHit?.name || null;
  let key = keyHit?.value || '';
  const keyVar = keyHit?.name || null;

  if (url) {
    if (!/^https?:\/\//i.test(url)) {
      problems.push(`${urlVar} must start with https:// (got "${url.slice(0, 24)}…")`);
      url = '';
    } else {
      url = url.replace(/\/+$/, '');
      // tolerate people pasting the REST endpoint instead of the project URL
      url = url.replace(/\/(rest|auth)\/v1$/i, '');
    }
  }

  const keyInfo = inspectKey(key);

  if (key) {
    if (keyInfo.kind === 'secret' || keyInfo.role === 'service_role') {
      problems.push(`${keyVar} looks like a SECRET / service_role key — it must never be shipped to browsers. Use the anon / publishable key.`);
      key = '';
    } else if (keyInfo.kind === 'unknown' && key.length < 24) {
      problems.push(`${keyVar} does not look like a Supabase anon key (too short).`);
      key = '';
    }
  }

  // recover the project URL from the key's project ref when only the key is set
  let urlFromKey = false;
  if (!url && key && keyInfo.ref) {
    url = `https://${keyInfo.ref}.supabase.co`;
    urlVar = `${keyVar} (project ref)`;
    urlFromKey = true;
  }

  if (!key && !keyHit) {
    problems.push(`No Supabase key found. Set ${KEY_VARS[0]} (or ${KEY_VARS[1]}).`);
  }
  if (!url && !urlHit) {
    problems.push(`No Supabase project URL found. Set ${URL_VARS[0]} (or ${URL_VARS[1]}).`);
  }

  return {
    url,
    key,
    configured: Boolean(url && key),
    urlVar,
    keyVar,
    keyKind: keyInfo.kind,
    urlFromKey,
    problems,
  };
}

/** Shape returned by /api/config and /config.json (public data only). */
export function publicConfig(env = process.env, mode = 'node') {
  const resolved = resolveSupabaseConfig(env);
  return {
    supabaseUrl: resolved.url,
    supabaseAnonKey: resolved.key,
    configured: resolved.configured,
    mode,
    env: {
      hasUrl: Boolean(pick(env, URL_VARS)),
      hasKey: Boolean(pick(env, KEY_VARS)),
      urlVar: resolved.urlVar,
      keyVar: resolved.keyVar,
      keyKind: resolved.keyKind,
      urlFromKey: resolved.urlFromKey,
    },
    problems: resolved.problems,
    ts: Date.now(),
  };
}
