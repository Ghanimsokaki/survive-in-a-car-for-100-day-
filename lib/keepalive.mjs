/**
 * KEEP-ALIVE — stop a free-tier container from falling asleep under Gemby Games.
 *
 * Render (and most free hosts) spin a web service down after a stretch with no
 * traffic. A Node process cannot wake a sleeping container, but while it IS
 * awake it can keep itself awake: every 10 minutes we make one ordinary GET
 * request to our own public URL, from inside, using node's native `http` /
 * `https` — the request goes out through the host's proxy and lands back on
 * `/health`, which counts as traffic, so the idle timer never expires.
 *
 * No dependencies, no scheduler package, one unref'd interval. If the URL is
 * unknown the feature simply does not start; if a ping fails the world does not
 * end — the failure is counted and reported on `/health`.
 *
 * Environment:
 *   RENDER_EXTERNAL_URL   set automatically by Render — the default source
 *   PUBLIC_URL / SELF_URL / KEEPALIVE_URL   manual override (any host)
 *   RENDER_SERVICE_NAME   used to guess https://<name>.onrender.com
 *   KEEPALIVE             0 disables the loop entirely
 *   KEEPALIVE_MINUTES     interval, default 10
 *   KEEPALIVE_PATH        path to hit, default /health
 *   KEEPALIVE_MS          raw interval in ms (tests / impatient humans)
 */

import http from 'node:http';
import https from 'node:https';

/** Ten minutes: comfortably inside every free tier's idle window. */
export const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
export const DEFAULT_PATH = '/health';
export const DEFAULT_TIMEOUT_MS = 15_000;

/** The public URL this process can be reached on, or '' when unknown. */
export function resolvePublicUrl(env = process.env) {
  const candidates = [
    env?.RENDER_EXTERNAL_URL,
    env?.PUBLIC_URL,
    env?.SELF_URL,
    env?.KEEPALIVE_URL,
    env?.RENDER_EXTERNAL_HOSTNAME ? `https://${env.RENDER_EXTERNAL_HOSTNAME}` : '',
    env?.RENDER_SERVICE_NAME ? `https://${env.RENDER_SERVICE_NAME}.onrender.com` : '',
  ];
  for (const raw of candidates) {
    const url = normaliseUrl(raw);
    if (url) return url;
  }
  return '';
}

/** `render.com/x/` → `https://render.com/x` ('' when it is not a usable URL). */
export function normaliseUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/** The interval, in ms, from the environment — clamped to something sane. */
export function resolveInterval(env = process.env) {
  const raw = env?.KEEPALIVE_MS;
  if (raw !== undefined && String(raw).trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.max(250, Number(raw));
  }
  const minutes = Number(env?.KEEPALIVE_MINUTES);
  if (Number.isFinite(minutes) && minutes > 0) return Math.max(250, Math.round(minutes * 60_000));
  return DEFAULT_INTERVAL_MS;
}

/** One GET, resolved (never rejected) with `{ok, status, ms, error}`. */
export function ping(url, { timeoutMs = DEFAULT_TIMEOUT_MS, httpImpl = http, httpsImpl = https } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let target;
    try {
      target = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, ms: 0, error: 'bad_url' });
      return;
    }
    const client = target.protocol === 'https:' ? httpsImpl : httpImpl;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve({ ...result, ms: Date.now() - startedAt });
    };

    let req;
    try {
      req = client.get(target, {
        // a plain browser-ish request: some proxies refuse empty agents
        headers: { 'user-agent': 'gemby-games/keepalive', accept: 'application/json,text/plain,*/*' },
        timeout: timeoutMs,
      }, (res) => {
        res.resume();                                  // we only care about the status
        finish({ ok: true, status: res.statusCode || 0, error: '' });
      });
    } catch (err) {
      finish({ ok: false, status: 0, error: err?.message || 'request_failed' });
      return;
    }

    req.on('timeout', () => {
      finish({ ok: false, status: 0, error: 'timeout' });
      req.destroy();
    });
    req.on('error', (err) => finish({ ok: false, status: 0, error: err?.message || 'error' }));
  });
}

/**
 * Starts the self-ping loop. Returns a handle with `stop()`, `runOnce()` and
 * `state()`, so `/health` can show exactly what is happening.
 *
 * `enabled: false` (KEEPALIVE=0) or no resolvable URL yields a handle that does
 * nothing at all — the server must never fail to boot because of this.
 */
export function startKeepAlive({
  env = process.env,
  log = console.log,
  warn = console.warn,
  now = () => Date.now(),
  intervalMs,
  path = env?.KEEPALIVE_PATH || DEFAULT_PATH,
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  httpImpl = http,
  httpsImpl = https,
  jitter = true,
} = {}) {
  const state = {
    enabled: false,
    url: '',
    intervalMs: 0,
    intervalSeconds: 0,
    pings: 0,
    failures: 0,
    lastStatus: 0,
    lastAt: 0,
    lastMs: 0,
    lastError: '',
    reason: '',
  };

  const off = String(env?.KEEPALIVE ?? '').trim() === '0';
  const target = normaliseUrl(url || resolvePublicUrl(env));
  const every = intervalMs ?? resolveInterval(env);

  if (off) {
    state.reason = 'KEEPALIVE=0';
    log('[keepalive] disabled (KEEPALIVE=0)');
    return { stop() {}, runOnce: async () => null, state: () => ({ ...state }) };
  }
  if (!target) {
    state.reason = 'no public URL';
    log('[keepalive] skipped — set RENDER_EXTERNAL_URL (or PUBLIC_URL) to enable the self-ping');
    return { stop() {}, runOnce: async () => null, state: () => ({ ...state }) };
  }

  const hit = `${target}${path.startsWith('/') ? path : `/${path}`}`;
  state.enabled = true;
  state.url = hit;
  state.intervalMs = every;
  state.intervalSeconds = Math.round(every / 1000);

  let timer = null;
  let stopped = false;
  let inFlight = false;

  const runOnce = async () => {
    if (stopped) return null;
    if (inFlight) return null;                        // a slow host must not stack pings
    inFlight = true;
    const at = now();
    const result = await ping(hit, { timeoutMs, httpImpl, httpsImpl });
    inFlight = false;
    state.pings += 1;
    state.lastAt = at;
    state.lastStatus = result.status;
    state.lastMs = result.ms;
    if (result.ok) {
      state.lastError = '';
      if (result.status >= 400) warn(`[keepalive] ${hit} → HTTP ${result.status} (${result.ms} ms)`);
      else log(`[keepalive] ping ${state.pings} · HTTP ${result.status} · ${result.ms} ms`);
    } else {
      state.failures += 1;
      state.lastError = result.error;
      warn(`[keepalive] ping ${state.pings} failed: ${result.error} (${result.ms} ms)`);
    }
    return result;
  };

  // a quick first call verifies the URL early (and says so in the log), then
  // the steady ten-minute rhythm takes over
  const firstDelay = Math.min(5000, Math.max(50, Math.round(every / 10)));

  const schedule = (first = false) => {
    if (stopped) return;
    // a little jitter so several instances do not hammer the proxy in lockstep
    const wait = first ? firstDelay : (jitter ? Math.round(every * (0.95 + Math.random() * 0.1)) : every);
    timer = setTimeout(async () => {
      await runOnce();
      schedule();
    }, wait);
    timer.unref?.();                                  // never hold the process open
  };

  const label = every >= 1000 ? `${state.intervalSeconds}s` : `${every}ms`;
  log(`[keepalive] self-ping every ${label} → ${hit}`);
  schedule(true);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      state.reason = 'stopped';
    },
    runOnce,
    state: () => ({ ...state }),
  };
}
