/**
 * Minimal Supabase client (Auth + PostgREST) over fetch — no SDK, no build step.
 * Usernames are mapped to synthetic emails so sign-in feels like Roblox
 * (username + password) while still using Supabase's email/password provider.
 */
const EMAIL_DOMAIN = 'players.outrun.local';
const STORE_KEY = 'outrun-auth-v1';
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export const normalizeUsername = (u) => String(u || '').trim().toLowerCase();
export const usernameToEmail = (u) => `${normalizeUsername(u)}@${EMAIL_DOMAIN}`;
export const validUsername = (u) => USERNAME_RE.test(String(u || '').trim());

export class SupabaseError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'SupabaseError';
    this.code = code;
    this.status = status;
  }
}

export class SupabaseClient {
  constructor({ url = '', key = '' } = {}) {
    this.url = String(url || '').replace(/\/+$/, '');
    this.key = String(key || '');
    this.session = null;
    this.user = null;
    this._refreshing = null;
  }

  get configured() { return Boolean(this.url && this.key); }

  // ------------------------------------------------------------ transport
  _headers(useAuth = true) {
    const h = {
      apikey: this.key,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (useAuth) h.Authorization = `Bearer ${this.session?.access_token || this.key}`;
    return h;
  }

  async _fetch(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
    if (!this.configured) throw new SupabaseError('Supabase is not configured', 'not_configured', 0);
    let res;
    try {
      res = await fetch(`${this.url}${path}`, {
        method,
        headers: { ...this._headers(auth), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new SupabaseError('Network error — cannot reach Supabase', 'network', 0);
    }
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      const msg = data?.msg || data?.message || data?.error_description || data?.error || `Request failed (${res.status})`;
      throw new SupabaseError(msg, data?.error_code || data?.code || `http_${res.status}`, res.status);
    }
    return data;
  }

  // ----------------------------------------------------------------- auth
  _adoptSession(data) {
    if (!data?.access_token) return null;
    this.session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    };
    this.user = data.user || this.user;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.session)); } catch {}
    return this.session;
  }

  restoreSession() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s?.access_token) return null;
      this.session = s;
      return s;
    } catch { return null; }
  }

  async signUp(username, password, meta = {}) {
    const data = await this._fetch('/auth/v1/signup', {
      method: 'POST',
      auth: false,
      body: { email: usernameToEmail(username), password, data: { username: normalizeUsername(username), ...meta } },
    });
    if (data?.access_token) this._adoptSession(data);
    else if (data?.user) this.user = data.user;
    return data;
  }

  async signIn(username, password) {
    const data = await this._fetch('/auth/v1/token?grant_type=password', {
      method: 'POST',
      auth: false,
      body: { email: usernameToEmail(username), password },
    });
    this._adoptSession(data);
    return data;
  }

  async refresh() {
    if (!this.session?.refresh_token) return null;
    if (this._refreshing) return this._refreshing;
    this._refreshing = (async () => {
      try {
        const data = await this._fetch('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          auth: false,
          body: { refresh_token: this.session.refresh_token },
        });
        this._adoptSession(data);
        return this.session;
      } catch {
        this.session = null; this.user = null;
        try { localStorage.removeItem(STORE_KEY); } catch {}
        return null;
      } finally {
        this._refreshing = null;
      }
    })();
    return this._refreshing;
  }

  async ensureSession() {
    if (!this.session) return null;
    if (this.session.expires_at && Date.now() > this.session.expires_at - 60_000) {
      return this.refresh();
    }
    return this.session;
  }

  async currentUser() {
    if (!this.session) return null;
    if (this.user?.id) return this.user;
    try {
      const u = await this._fetch('/auth/v1/user');
      this.user = u;
      return u;
    } catch { return null; }
  }

  async signOut() {
    const token = this.session?.access_token;
    this.session = null; this.user = null;
    try { localStorage.removeItem(STORE_KEY); } catch {}
    if (token && this.configured) {
      try { await fetch(`${this.url}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${token}` } }); } catch {}
    }
  }

  // ------------------------------------------------------------- PostgREST
  async select(table, query = '') {
    await this.ensureSession();
    const qs = query ? `?${query}` : '';
    return this._fetch(`/rest/v1/${table}${qs}`, { headers: { Prefer: 'return=representation' } }) || [];
  }

  async insert(table, rows) {
    await this.ensureSession();
    return this._fetch(`/rest/v1/${table}`, {
      method: 'POST',
      body: rows,
      headers: { Prefer: 'return=representation' },
    }) || [];
  }

  async upsert(table, rows, onConflict) {
    await this.ensureSession();
    const qs = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : '';
    return this._fetch(`/rest/v1/${table}${qs}`, {
      method: 'POST',
      body: rows,
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    }) || [];
  }

  async update(table, query, patch) {
    await this.ensureSession();
    return this._fetch(`/rest/v1/${table}?${query}`, {
      method: 'PATCH',
      body: patch,
      headers: { Prefer: 'return=representation' },
    }) || [];
  }

  async rpc(fn, args = {}) {
    await this.ensureSession();
    return this._fetch(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args }) || null;
  }

  async remove(table, query) {
    await this.ensureSession();
    return this._fetch(`/rest/v1/${table}?${query}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    }) || [];
  }
}

/** Friendly error copy for the sign-in screen. */
export function explainAuthError(err) {
  const msg = String(err?.message || '').toLowerCase();
  if (err?.code === 'not_configured') return 'Accounts are not configured on this server yet.';
  if (err?.code === 'network') return 'Cannot reach the account service. Check your connection.';
  if (msg.includes('already registered') || msg.includes('already been registered')) return 'That username is already taken.';
  if (msg.includes('invalid login') || msg.includes('invalid_grant')) return 'Wrong username or password.';
  if (msg.includes('password should be') || msg.includes('password is too short')) return 'Password must be at least 6 characters.';
  if (msg.includes('email not confirmed')) return 'Confirm your email or turn off email confirmation in Supabase.';
  if (msg.includes('rate limit') || err?.status === 429) return 'Too many attempts — wait a minute and retry.';
  if (msg.includes('row-level security')) return 'Your account lacks permission for that action.';
  return err?.message || 'Something went wrong. Try again.';
}
