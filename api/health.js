/**
 * Relay + Supabase health.
 *
 * `?deep=1` also asks the Supabase project itself (auth /health) so a
 * deployment can prove the credentials it was handed actually work — not just
 * that the environment variables exist. The shallow call is cheap and safe to
 * poll from a phone.
 */
import { publicConfig, resolveSupabaseConfig } from '../lib/supabase-env.mjs';

let probe = { at: 0, value: null };

async function supabaseStatus(deep) {
  const cfg = resolveSupabaseConfig(process.env);
  const base = {
    configured: Boolean(cfg.configured),
    url: cfg.url || null,
    urlVar: cfg.urlVar || null,
    keyVar: cfg.keyVar || null,
    problems: cfg.problems || [],
  };
  if (!base.configured || !deep) return { ...base, reachable: deep ? false : null };
  if (probe.value && Date.now() - probe.at < 60_000) return probe.value;
  let reachable = false;
  let status = 0;
  try {
    const res = await fetch(`${base.url}/auth/v1/health`, {
      headers: { apikey: cfg.key, authorization: `Bearer ${cfg.key}` },
    });
    status = res.status;
    reachable = res.ok;
  } catch { reachable = false; }
  const value = { ...base, reachable, status, checkedAt: new Date().toISOString() };
  probe = { at: Date.now(), value };
  return value;
}

export default async function handler(req, res) {
  const url = new URL(req.url || '/api/health', 'http://localhost');
  const deep = url.searchParams.get('deep') === '1' || url.searchParams.get('deep') === 'true';
  const supabase = await supabaseStatus(deep);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify({
    ok: true,
    mode: 'vercel-serverless',
    poll: true,
    ts: Date.now(),
    supabase,
    // the same payload /api/config serves, minus the key: useful when a phone
    // can reach Supabase but the browser build never picked the key up
    configKeys: Object.keys(publicConfig(process.env, 'health')),
  }));
}
