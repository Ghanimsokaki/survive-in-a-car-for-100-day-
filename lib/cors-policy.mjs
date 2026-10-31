/**
 * CORS POLICY — one place that decides which browser origins may talk to the
 * realtime server, shared by express (HTTP) and socket.io (the WebSocket
 * handshake), so the two can never disagree.
 *
 * The default is OPEN: any front-end may connect, because this is a game relay
 * with no cookies and no secrets — the anon Supabase key is the only thing the
 * page holds, and it is public by design. A deployment that wants the older,
 * narrow behaviour asks for it:
 *
 *   · ALLOWED_ORIGINS="https://gemby-game.vercel.app,https://*.vercel.app"
 *       → only those origins (exact match, or a single `*.` host wildcard).
 *         Setting a list is the opt-in: if you named origins, you meant them.
 *   · CORS=strict
 *       → the built-in production allowlist (`DEFAULT_ORIGINS`), for when the
 *         list lives in code rather than in the dashboard.
 *
 * Requests with no `Origin` at all (curl, native apps, server-to-server) are
 * always allowed: CORS is a browser mechanism, and refusing those would only
 * break tooling.
 *
 * `localhost` / `127.0.0.1` / `192.168.x.x` are always allowed in the closed
 * modes too — that is how you test from a phone on the same Wi-Fi.
 */

/** The production front-end, used by `CORS=strict` when no list is configured. */
export const DEFAULT_ORIGINS = [
  'https://gemby-game.vercel.app',
  'https://www.gemby-game.vercel.app',
  'http://gemby-game.vercel.app',
];

/** Parses `ALLOWED_ORIGINS` into a clean list. */
export function parseOrigins(input) {
  if (Array.isArray(input)) input = input.join(',');
  return String(input ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/\/+$/, ''));
}

function normalise(origin) {
  return String(origin ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** `https://a.b.c` → `a.b.c` ('' when it does not parse). */
function hostOf(origin) {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** A browser on this machine or the same Wi-Fi — always welcome. */
function isLocal(origin) {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true;
    return /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Builds the policy.
 * @returns {{ open: boolean, mode: string, origins: string[], patterns: string[],
 *             allowed: (origin?: string) => boolean }}
 */
export function createCorsPolicy({ env = process.env, extra = [] } = {}) {
  const configured = [...parseOrigins(env?.ALLOWED_ORIGINS ?? ''), ...parseOrigins(extra)];
  const strict = String(env?.CORS ?? '').trim().toLowerCase() === 'strict';

  let mode = 'open';
  if (configured.length) mode = 'allowlist';
  else if (strict) mode = 'strict';

  const origins = mode === 'open'
    ? ['*']
    : [...new Set((mode === 'allowlist' ? configured : DEFAULT_ORIGINS).map(normalise))];
  const patterns = origins.filter((o) => o.includes('*'));

  const allowed = (origin) => {
    if (mode === 'open') return true;                            // any front-end
    if (origin == null || origin === '') return true;            // no Origin header
    const value = normalise(origin);
    if (!value || value === 'null') return true;                  // sandboxed iframe / file://
    if (origins.includes(value)) return true;

    // wildcard entries are matched on the parsed host, never on the raw string,
    // so `https://*.vercel.app` cannot be spoofed by `evil-vercel.app`
    const host = hostOf(value);
    for (const pattern of patterns) {
      const wildcard = pattern.indexOf('*');
      const prefix = pattern.slice(0, wildcard);                  // e.g. "https://"
      const suffix = pattern.slice(wildcard + 1);                 // e.g. ".vercel.app"
      if (!value.startsWith(prefix) || !value.endsWith(suffix)) continue;
      const wantedHost = pattern.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '');
      if (suffix.startsWith('.') && host && host.endsWith(suffix) && host !== wantedHost) return true;
    }
    return isLocal(value);
  };

  return { open: mode === 'open', mode, origins, patterns, allowed };
}

/** The `cors` option socket.io wants: wide open, or the allowlist predicate. */
export function socketIoCors(policy) {
  return {
    origin: policy.open
      ? true                                                     // reflect whatever the browser sent
      : (origin, callback) => {
        if (policy.allowed(origin)) callback(null, true);
        else callback(new Error(`origin not allowed: ${origin}`));
      },
    methods: ['GET', 'POST'],
    credentials: true,
  };
}
