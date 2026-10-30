/**
 * CORS POLICY — one place that decides which browser origins may talk to the
 * realtime server, shared by express (HTTP) and socket.io (WebSocket handshake).
 *
 * The default allowlist is deliberately narrow: the Vercel deployment the game
 * ships from, plus localhost for development. A lookalike such as
 * `https://gemby-game.vercel.app.evil.com` must NOT match, which is why the
 * comparison is on the whole origin, never on a substring.
 *
 * Extra origins come from `ALLOWED_ORIGINS` (comma separated). Entries may use a
 * single leading `*.` wildcard for preview deployments, e.g.
 * `https://*.vercel.app`, which is matched strictly on the host suffix.
 *
 * Requests with no Origin at all (curl, native apps, server-to-server, and the
 * game's own `file://` testing) are allowed: CORS is a browser mechanism, and
 * refusing those would only break tooling without adding any safety.
 */

export const DEFAULT_ORIGINS = [
  'https://gemby-game.vercel.app',
  'https://www.gemby-game.vercel.app',
  'http://gemby-game.vercel.app',
];

/**
 * The coding sandbox this repo is previewed in serves the page from
 * `https://<port>-<sandbox>.e2b.app`, which is a different origin from the game
 * server — so the socket handshake would be refused there without this. It is
 * kept separate (and can be switched off with `PREVIEW_ORIGINS=0`) so the
 * shipping allowlist stays exactly the deploy you meant.
 */
export const SANDBOX_ORIGINS = ['https://*.e2b.app'];

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

/**
 * Builds the allow policy.
 * @returns {{ allowed: (origin?: string) => boolean, origins: string[], patterns: string[] }}
 */
export function createCorsPolicy({ env = process.env, extra = [] } = {}) {
  const configured = [...parseOrigins(env?.ALLOWED_ORIGINS ?? ''), ...parseOrigins(extra)];
  const previews = String(env?.PREVIEW_ORIGINS ?? '') === '0' ? [] : SANDBOX_ORIGINS;
  const origins = [...new Set([
    ...DEFAULT_ORIGINS.map(normalise), ...previews.map(normalise), ...configured.map(normalise),
  ])];
  const patterns = origins.filter((o) => o.includes('*'));

  const allowed = (origin) => {
    if (origin == null || origin === '') return true;            // no Origin header
    const value = normalise(origin);
    if (!value || value === 'null') return true;                  // sandboxed iframe / file://
    if (origins.includes(value)) return true;

    // wildcard entries: matched on the parsed host, never on the raw string
    const host = hostOf(value);
    for (const pattern of patterns) {
      const wildcard = pattern.indexOf('*');
      const prefix = pattern.slice(0, wildcard);                  // e.g. "https://"
      const suffix = pattern.slice(wildcard + 1);                 // e.g. ".vercel.app"
      if (!value.startsWith(prefix)) continue;
      if (!value.endsWith(suffix)) continue;
      const wantedHost = pattern.replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/\/.*$/, '');
      if (suffix.startsWith('.') && host && host.endsWith(suffix)) {
        // `https://*.vercel.app` must not match a bare `vercel.app` or a
        // lookalike such as `evil-vercel.app`
        if (host !== wantedHost && host.length > wantedHost.length) return true;
      }
    }
    // localhost on any port, for `npm start` and phone testing on the LAN
    try {
      const host = new URL(value).hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;   // same Wi-Fi phone
    } catch { /* not a URL: fall through to deny */ }
    return false;
  };

  return { allowed, origins, patterns };
}

/** The `origin` option socket.io wants: an allowlist + a predicate. */
export function socketIoCors(policy) {
  return {
    origin(origin, callback) {
      if (policy.allowed(origin)) callback(null, true);
      else callback(new Error(`origin not allowed: ${origin}`));
    },
    methods: ['GET', 'POST'],
    credentials: true,
  };
}
