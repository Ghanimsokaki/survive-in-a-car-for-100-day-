/**
 * Server-side gate for the owner admin panel.
 *
 * The panel is only a set of conveniences for the account named `ghanimz`.
 * Hiding the button in the browser is not security, so the same rule is
 * enforced here: every admin request carries the caller's Supabase access
 * token, we resolve that token against Supabase's own /auth/v1/user endpoint
 * and only then allow the action. Forging `window.__outrun.admin = true` in
 * the console reveals a panel whose every privileged call comes back 403.
 *
 * Used by:
 *   · api/admin.js   → Vercel serverless function
 *   · server.mjs     → local / self-hosted Node relay
 *   · tests/admin.test.mjs
 */
import { resolveSupabaseConfig } from './supabase-env.mjs';

const EMAIL_DOMAIN = 'players.outrun.local';

/** The owner account. Override with ADMIN_USERNAME for local experiments. */
export const DEFAULT_ADMIN = 'ghanimz';

export function adminUsernames(env = process.env) {
  const extra = String(env?.ADMIN_USERNAME || env?.OWNER_USERNAME || '')
    .split(/[,\s]+/)
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([DEFAULT_ADMIN, ...extra])];
}

/** Pure owner-name check shared with the client. */
export function isOwnerName(username, env = process.env) {
  return adminUsernames(env).includes(normaliseUsername(username));
}

export function normaliseUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/^@/, '');
}

/** Reads `Authorization: Bearer <token>` from either a fetch Request or Node req. */
export function bearerToken(reqLike) {
  const raw = reqLike?.headers?.get
    ? reqLike.headers.get('authorization')
    : reqLike?.headers?.authorization || reqLike?.headers?.Authorization;
  const m = String(raw || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

/** Pulls the username out of a Supabase user object (email prefix or metadata). */
export function usernameFromUser(user) {
  if (!user) return '';
  const meta = normaliseUsername(user.user_metadata?.username || user.user_metadata?.user_name);
  if (meta) return meta;
  const email = String(user.email || '');
  if (email.toLowerCase().endsWith(`@${EMAIL_DOMAIN}`)) {
    return normaliseUsername(email.slice(0, -1 * (`@${EMAIL_DOMAIN}`).length));
  }
  return normaliseUsername(email.split('@')[0]);
}

/**
 * Resolves the caller and decides whether they are the owner.
 * Never throws — the reason is returned for the UI / logs.
 *
 * @returns {Promise<{admin:boolean, configured:boolean, username:string, id:string|null, reason:string}>}
 */
export async function verifyAdmin({ token, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const cfg = resolveSupabaseConfig(env);
  if (!cfg.configured) {
    return { admin: false, configured: false, username: '', id: null, reason: 'supabase_not_configured' };
  }
  if (!token) return { admin: false, configured: true, username: '', id: null, reason: 'missing_token' };
  // the anon key ships to every browser — it must never unlock admin
  if (token === cfg.key) return { admin: false, configured: true, username: '', id: null, reason: 'anon_key_is_not_identity' };

  let user = null;
  try {
    const res = await fetchImpl(`${cfg.url}/auth/v1/user`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { admin: false, configured: true, username: '', id: null, reason: `token_rejected_${res.status}` };
    }
    user = await res.json();
  } catch {
    return { admin: false, configured: true, username: '', id: null, reason: 'network' };
  }

  const username = usernameFromUser(user);
  // Supabase returns an anonymous user object for the raw anon key
  if (!user || !user.id || user.is_anonymous || user.role === 'anon' || user.aud === 'anon') {
    return { admin: false, configured: true, username, id: user?.id || null, reason: 'not_a_signed_in_user' };
  }
  if (!username) return { admin: false, configured: true, username, id: user.id, reason: 'no_username' };

  const allowed = adminUsernames(env);
  const admin = allowed.includes(username);
  return {
    admin,
    configured: true,
    username,
    id: user.id,
    reason: admin ? 'ok' : 'not_owner',
  };
}

/**
 * One implementation shared by the Vercel function and the local server.
 * Returns { status, body } so callers only have to write it out.
 */
export async function handleAdminRequest({
  method = 'GET',
  token = '',
  action = 'verify',
  body = {},
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const who = await verifyAdmin({ token, env, fetchImpl });
  if (!who.admin) {
    return {
      status: who.reason === 'supabase_not_configured' ? 503 : 403,
      body: { ok: false, admin: false, reason: who.reason, username: who.username },
    };
  }

  const cfg = resolveSupabaseConfig(env);
  const restHeaders = { apikey: cfg.key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  switch (action) {
    case 'verify':
      return { status: 200, body: { ok: true, admin: true, username: who.username, id: who.id } };

    case 'bans': {
      // RLS on public.bans only lets admins read/write, so this doubles as a probe
      try {
        const res = await fetchImpl(`${cfg.url}/rest/v1/bans?select=username,reason,created_at&order=created_at.desc&limit=100`, { headers: restHeaders });
        const data = res.ok ? await res.json() : null;
        return { status: res.ok ? 200 : 502, body: { ok: res.ok, admin: true, username: who.username, bans: Array.isArray(data) ? data : [], reason: res.ok ? 'ok' : `bans_table_${res.status}` } };
      } catch {
        return { status: 502, body: { ok: false, admin: true, username: who.username, bans: [], reason: 'network' } };
      }
    }

    case 'ban': {
      const username = normaliseUsername(body.username);
      if (!username) return { status: 400, body: { ok: false, reason: 'username_required' } };
      if (username === who.username) return { status: 400, body: { ok: false, reason: 'cannot_ban_owner' } };
      try {
        const res = await fetchImpl(`${cfg.url}/rest/v1/bans`, {
          method: 'POST',
          headers: { ...restHeaders, Prefer: 'resolution=merge-duplicates,return=representation' },
          body: JSON.stringify({ username, reason: String(body.reason || 'banned by owner').slice(0, 120), banned_by: who.username }),
        });
        const data = res.ok ? await res.json() : null;
        return { status: res.ok ? 200 : 502, body: { ok: res.ok, ban: Array.isArray(data) ? data[0] : data, reason: res.ok ? 'ok' : `ban_failed_${res.status}` } };
      } catch {
        return { status: 502, body: { ok: false, reason: 'network' } };
      }
    }

    case 'unban': {
      const username = normaliseUsername(body.username);
      if (!username) return { status: 400, body: { ok: false, reason: 'username_required' } };
      try {
        const res = await fetchImpl(`${cfg.url}/rest/v1/bans?username=eq.${encodeURIComponent(username)}`, { method: 'DELETE', headers: restHeaders });
        return { status: res.ok ? 200 : 502, body: { ok: res.ok, reason: res.ok ? 'ok' : `unban_failed_${res.status}` } };
      } catch {
        return { status: 502, body: { ok: false, reason: 'network' } };
      }
    }

    default:
      return { status: 400, body: { ok: false, reason: 'unknown_action' } };
  }
}
