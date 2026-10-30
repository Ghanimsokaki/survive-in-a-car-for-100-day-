import { SupabaseClient, explainAuthError, normalizeUsername, validUsername } from './supabase.js';

const GUEST_KEY = 'outrun-guest-v1';
const CONFIG_KEY = 'outrun-supabase-config';

/**
 * Owns the signed-in identity, the profile row, the friends list and the
 * presence heartbeat. Degrades to an offline guest account when Supabase is
 * not configured or unreachable, so the game is always playable.
 */
export class Account {
  constructor() {
    this.sb = new SupabaseClient({});
    this.mode = 'guest';            // 'account' | 'guest'
    this.profile = null;            // { id, username, display_name, body_color, car_color, best_day }
    this.friends = [];
    this.friendsLoading = false;
    this.listeners = new Set();
    this.hbTimer = null;
    this.friendsTimer = null;
    this.presence = { room: null, day: 1, status: 'lobby' };
    this.lastError = '';
    this.friendRequests = [];
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind = 'change') { this.listeners.forEach((fn) => { try { fn(kind, this); } catch {} }); }

  // ------------------------------------------------------------ bootstrap
  async boot() {
    const cfg = await this.loadConfig();
    this.configSource = cfg.source;
    if (!cfg.url || !cfg.key) {
      this.mode = 'guest';
      this.restoreGuest();
      this.emit('ready');
      return this;
    }
    this.sb = new SupabaseClient({ url: cfg.url, key: cfg.key });
    this.sb.restoreSession();
    if (this.sb.session) {
      const user = await this.sb.currentUser();
      if (user) {
        try {
          this.profile = await this.loadProfile(user);
          this.mode = 'account';
          this.emit('ready');
          this.startHeartbeat();
          this.refreshFriends();
          return this;
        } catch (e) {
          // profile row missing (first login) — fall back to guest rather than blocking
          this.lastError = explainAuthError(e);
        }
      }
    }
    this.mode = 'guest';
    this.restoreGuest();
    this.emit('ready');
    return this;
  }

  /**
   * Credential lookup, in order of freshness:
   *   1. /api/config      live server env (Vercel function or Node relay)
   *   2. ./config.json    baked at build time from the same env vars
   *   3. localStorage     what the player pasted into CONNECT SUPABASE
   *   4. globalThis.__SUPABASE__  inline script, for file:// / hostile hosts
   * Every attempt records a diagnostic so the setup panel can explain what the
   * deployment actually sees.
   */
  async loadConfig() {
    const report = { server: null, build: null, local: null, inline: null };

    const tryJson = async (url, source) => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) { report[source] = { found: false, status: res.status }; return null; }
        const data = await res.json();
        report[source] = {
          found: Boolean(data?.supabaseUrl && data?.supabaseAnonKey),
          configured: data?.configured ?? Boolean(data?.supabaseUrl && data?.supabaseAnonKey),
          env: data?.env || null,
          problems: Array.isArray(data?.problems) ? data.problems : [],
          mode: data?.mode || null,
        };
        if (data?.supabaseUrl && data?.supabaseAnonKey) {
          return { url: String(data.supabaseUrl).replace(/\/+$/, ''), key: String(data.supabaseAnonKey), source };
        }
        return null;
      } catch (e) {
        report[source] = { found: false, error: e?.message || 'unreachable' };
        return null;
      }
    };

    // 1 + 2. Ask the live server env AND the build-time file at the same time.
    // Doing them in sequence cost a full round trip on every cold start (the
    // first one 404s on a static host, and this ran before the menu was usable).
    const serverPromise = tryJson('/api/config', 'server');
    const buildPromise = tryJson('./config.json', 'build');
    let hit = await serverPromise;
    if (!hit) hit = await buildPromise;
    if (hit) { this.configReport = report; return hit; }

    // 3. credentials pasted on this device
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        report.local = { found: Boolean(parsed?.url && parsed?.key) };
        if (parsed?.url && parsed?.key) {
          this.configReport = report;
          return { url: String(parsed.url).replace(/\/+$/, ''), key: String(parsed.key), source: 'local' };
        }
      }
    } catch { report.local = { found: false, error: 'unreadable' }; }

    // 4. inline script emitted next to index.html at build time
    if (globalThis.__SUPABASE__?.url && globalThis.__SUPABASE__?.key) {
      report.inline = { found: true };
      this.configReport = report;
      return { url: globalThis.__SUPABASE__.url, key: globalThis.__SUPABASE__.key, source: 'inline' };
    }
    report.inline = { found: false };

    this.configReport = report;
    return { url: '', key: '', source: 'none' };
  }

  /** Human summary for the connect panel, e.g. "Vercel env: URL ✓ · KEY ✗". */
  describeConfig() {
    const r = this.configReport || {};
    if (this.canUseAccounts) {
      const label = { server: 'server environment', build: 'build-time config', local: 'this device', inline: 'inline config' }[this.configSource] || this.configSource;
      const env = r.server?.env;
      const vars = env?.urlVar || env?.keyVar
        ? ` (${[env.urlVar, env.keyVar].filter(Boolean).join(' + ')})`
        : '';
      return `Connected via ${label}${vars}.`;
    }
    const lines = [];
    if (r.server) {
      const env = r.server.env;
      if (env) {
        lines.push(`Server env: URL ${env.hasUrl ? '✓' : '✗'} · KEY ${env.hasKey ? '✓' : '✗'}`);
      } else if (r.server.error) {
        lines.push(`Server config unreachable (${r.server.error})`);
      } else {
        lines.push(`Server config: empty (HTTP ${r.server.status ?? '?'})`);
      }
    }
    if (r.build) lines.push(`Build config: ${r.build.found ? '✓' : '✗'}`);
    if (r.local) lines.push(`This device: ${r.local.found ? '✓' : '✗'}`);
    const problems = [...(r.server?.problems || []), ...(r.build?.problems || [])];
    if (problems.length) lines.push(problems[0]);
    return lines.join(' · ') || 'No Supabase credentials found.';
  }

  saveLocalConfig(url, key) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify({ url: String(url).replace(/\/+$/, ''), key: String(key) })); } catch {}
  }

  get canUseAccounts() { return this.sb.configured; }
  get signedIn() { return this.mode === 'account'; }
  get username() { return this.profile?.username || this.profile?.display_name || 'GUEST'; }
  get displayName() { return this.profile?.display_name || this.profile?.username || 'GUEST'; }
  get userId() { return this.profile?.id || null; }

  // --------------------------------------------------------------- guest
  restoreGuest() {
    let g = null;
    try { g = JSON.parse(localStorage.getItem(GUEST_KEY) || 'null'); } catch {}
    if (!g) {
      g = {
        id: `guest-${Math.random().toString(36).slice(2, 9)}`,
        username: 'GUEST',
        display_name: 'GUEST',
        body_color: '#ffb347',
        car_color: '#d24a2b',
        best_day: 0,
        guest: true,
      };
    }
    this.profile = g;
    this.mode = 'guest';
  }

  useGuest(name, colors = {}) {
    const g = {
      id: `guest-${Math.random().toString(36).slice(2, 9)}`,
      username: (name || 'GUEST').toUpperCase().slice(0, 16),
      display_name: (name || 'GUEST').toUpperCase().slice(0, 16),
      body_color: colors.body || this.profile?.body_color || '#ffb347',
      car_color: colors.car || this.profile?.car_color || '#d24a2b',
      best_day: this.profile?.best_day || 0,
      guest: true,
    };
    this.profile = g;
    this.mode = 'guest';
    try { localStorage.setItem(GUEST_KEY, JSON.stringify(g)); } catch {}
    this.emit('profile');
    return g;
  }

  async signIn(username, password) {
    if (!validUsername(username)) throw new Error('Username: 3–16 letters, numbers or _');
    this.lastError = '';
    const data = await this.sb.signIn(username, password);
    const user = data.user || (await this.sb.currentUser());
    this.profile = await this.loadProfile(user, username);
    this.mode = 'account';
    this.emit('profile');
    this.startHeartbeat();
    await this.refreshFriends();
    return this.profile;
  }

  async signUp(username, password, displayName, colors = {}) {
    // never inherit a previous session (or its presence row) when creating an account
    this.stopHeartbeat();
    if (this.sb.session) { try { await this.sb.signOut(); } catch {} }
    if (!validUsername(username)) throw new Error('Username: 3–16 letters, numbers or _');
    if (String(password || '').length < 6) throw new Error('Password must be at least 6 characters.');
    this.lastError = '';
    const data = await this.sb.signUp(username, password, { display_name: displayName || username });
    if (!this.sb.session) {
      throw new Error('Account created — but Supabase needs email confirmation off to sign in. Check your project settings.');
    }
    const user = data.user || (await this.sb.currentUser());
    this.profile = await this.createProfile(user, username, displayName, colors);
    this.mode = 'account';
    this.emit('profile');
    this.startHeartbeat();
    await this.refreshFriends();
    return this.profile;
  }

  async signOut() {
    this.stopHeartbeat();
    await this.sb.signOut();
    this.profile = null;
    this.friends = [];
    this.restoreGuest();
    this.emit('signedout');
  }

  // ------------------------------------------------------------- profile
  async loadProfile(user, fallbackUsername) {
    const uid = user?.id;
    if (!uid) throw new Error('No user id from Supabase');
    const rows = await this.sb.select('profiles', `id=eq.${uid}&select=*`);
    const meta = user.user_metadata || {};
    const username = normalizeUsername(rows[0]?.username || meta.username || fallbackUsername || 'survivor');
    if (!rows[0]) {
      return this.createProfile(user, username, meta.display_name || username, {});
    }
    const p = rows[0];
    return {
      id: p.id,
      username: p.username,
      display_name: p.display_name || p.username,
      body_color: p.body_color || '#ffb347',
      car_color: p.car_color || '#d24a2b',
      best_day: p.best_day || 0,
      customization: p.customization || null,
      created_at: p.created_at,
    };
  }

  async createProfile(user, username, displayName, colors = {}) {
    const uid = user?.id;
    const row = {
      id: uid,
      username: normalizeUsername(username),
      display_name: (displayName || username).slice(0, 20),
      body_color: colors.body || '#ffb347',
      car_color: colors.car || '#d24a2b',
      best_day: 0,
      customization: colors.custom || {},
    };
    const out = await this.sb.upsert('profiles', row, 'id');
    const p = out?.[0] || row;
    return {
      id: p.id || uid,
      username: p.username || row.username,
      display_name: p.display_name || row.display_name,
      body_color: p.body_color || row.body_color,
      car_color: p.car_color || row.car_color,
      best_day: p.best_day || 0,
      customization: p.customization || row.customization || null,
    };
  }

  async saveProfile(patch) {
    if (!this.profile) return;
    this.profile = { ...this.profile, ...patch };
    try { localStorage.setItem(GUEST_KEY, JSON.stringify(this.profile)); } catch {}
    this.emit('profile');
    if (this.mode === 'account' && this.profile.id) {
      const dbPatch = {};
      if (patch.display_name !== undefined) dbPatch.display_name = patch.display_name;
      if (patch.body_color !== undefined) dbPatch.body_color = patch.body_color;
      if (patch.car_color !== undefined) dbPatch.car_color = patch.car_color;
      if (patch.best_day !== undefined) dbPatch.best_day = patch.best_day;
      if (patch.customization !== undefined) dbPatch.customization = patch.customization;
      if (Object.keys(dbPatch).length) {
        try { await this.sb.update('profiles', `id=eq.${this.profile.id}`, dbPatch); }
        catch (e) {
          // an older schema without the customization column must not break saving
          if ('customization' in dbPatch) {
            delete dbPatch.customization;
            if (Object.keys(dbPatch).length) {
              try { await this.sb.update('profiles', `id=eq.${this.profile.id}`, dbPatch); } catch (e2) { this.lastError = explainAuthError(e2); }
            }
          } else {
            this.lastError = explainAuthError(e);
          }
        }
      }
    }
  }

  async recordRun({ day, distance }) {
    if (!this.profile) return;
    const best = Math.max(this.profile.best_day || 0, Math.round(day || 0));
    if (best !== this.profile.best_day) await this.saveProfile({ best_day: best });
  }

  // ------------------------------------------------------------- friends
  async refreshFriends() {
    if (this.mode !== 'account' || !this.profile?.id) { this.friends = []; this.emit('friends'); return []; }
    this.friendsLoading = true;
    this.emit('friends');
    try {
      const links = await this.sb.select('friendships', `or=(user_id.eq.${this.profile.id},friend_id.eq.${this.profile.id})&select=user_id,friend_id`);
      const ids = [...new Set(links.flatMap((l) => [l.user_id, l.friend_id]).filter((id) => id !== this.profile.id))];
      if (!ids.length) { this.friends = []; this.friendsLoading = false; this.emit('friends'); return []; }
      const list = ids.map((i) => `"${i}"`).join(',');
      const [profiles, presence] = await Promise.all([
        this.sb.select('profiles', `id=in.(${list})&select=id,username,display_name,body_color,car_color,best_day`),
        this.sb.select('presence', `user_id=in.(${list})&select=user_id,room,day,status,updated_at`).catch(() => []),
      ]);
      const presenceMap = new Map(presence.map((p) => [p.user_id, p]));
      const now = Date.now();
      this.friends = profiles.map((p) => {
        const pr = presenceMap.get(p.id);
        const updated = pr?.updated_at ? Date.parse(pr.updated_at) : 0;
        const online = Boolean(pr) && now - updated < 75_000;
        return {
          id: p.id,
          username: p.username,
          displayName: p.display_name || p.username,
          color: p.body_color || '#ffb347',
          carColor: p.car_color || '#d24a2b',
          bestDay: p.best_day || 0,
          online,
          room: online ? pr.room : null,
          day: online ? pr.day : null,
          status: online ? (pr.status || 'playing') : 'offline',
          lastSeen: updated || null,
        };
      }).sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
    } catch (e) {
      this.lastError = explainAuthError(e);
    }
    this.friendsLoading = false;
    this.emit('friends');
    return this.friends;
  }

  async findUser(username) {
    if (this.mode !== 'account') throw new Error('Sign in to add friends.');
    const rows = await this.sb.select('profiles', `username=eq.${encodeURIComponent(normalizeUsername(username))}&select=id,username,display_name`);
    return rows[0] || null;
  }

  async addFriend(username) {
    if (this.mode !== 'account') throw new Error('Sign in to add friends.');
    const target = await this.findUser(username);
    if (!target) throw new Error('No survivor with that username.');
    if (target.id === this.profile.id) throw new Error('That is you.');
    if (this.friends.some((f) => f.id === target.id)) throw new Error('Already on your friends list.');

    try {
      // preferred path: security-definer RPC writes both sides of the friendship
      await this.sb.rpc('add_friend', { target_username: normalizeUsername(username) });
    } catch (e) {
      const msg = String(e?.message || '').toLowerCase();
      if (msg.includes('no_such_user')) throw new Error('No survivor with that username.');
      if (msg.includes('cannot_add_self')) throw new Error('That is you.');
      // fallback for projects without the RPC: one-directional row
      await this.sb.insert('friendships', { user_id: this.profile.id, friend_id: target.id });
    }
    await this.refreshFriends();
    return target;
  }

  async removeFriend(id) {
    if (this.mode !== 'account') return;
    try {
      await this.sb.rpc('remove_friend', { target_id: id });
    } catch {
      await this.sb.remove('friendships', `or=(and(user_id.eq.${this.profile.id},friend_id.eq.${id}),and(user_id.eq.${id},friend_id.eq.${this.profile.id}))`);
    }
    await this.refreshFriends();
  }

  // ------------------------------------------------------------ presence
  startHeartbeat() {
    if (this.mode !== 'account') return;
    this.stopHeartbeat();
    const beat = () => this.heartbeat();
    beat();
    this.hbTimer = setInterval(beat, 20_000);
    this.friendsTimer = setInterval(() => this.refreshFriends(), 25_000);
  }

  stopHeartbeat() {
    clearInterval(this.hbTimer); clearInterval(this.friendsTimer);
    this.hbTimer = this.friendsTimer = null;
  }

  /**
   * Coalesced presence write: rapid calls collapse into one in-flight request
   * that always finishes with the newest state, so a slow first beat can never
   * overwrite a room the player just joined.
   */
  async heartbeat(patch = {}) {
    if (this.mode !== 'account' || !this.profile?.id) return;
    this.presence = { ...this.presence, ...patch };
    this._hbPending = { ...this.presence };
    if (this._hbBusy) return;
    this._hbBusy = true;
    try {
      while (this._hbPending) {
        const snap = this._hbPending;
        this._hbPending = null;
        await this.sb.upsert('presence', [{
          user_id: this.profile.id,
          room: snap.room ?? null,
          day: snap.day ?? 1,
          status: snap.status || 'lobby',
          updated_at: new Date().toISOString(),
        }], 'user_id');
      }
    } catch (e) {
      this.lastError = explainAuthError(e);
    } finally {
      this._hbBusy = false;
    }
  }

  async setPresence(patch) {
    this.presence = { ...this.presence, ...patch };
    if (this.mode === 'account') await this.heartbeat();
  }

  async clearPresence() {
    this.stopHeartbeat();
    if (this.mode !== 'account' || !this.profile?.id) return;
    try { await this.sb.remove('presence', `user_id=eq.${this.profile.id}`); } catch {}
  }
}
