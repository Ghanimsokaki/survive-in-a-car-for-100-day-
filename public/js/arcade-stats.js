/**
 * Arcade stats: ratings, play counts and leaderboards.
 *
 * Supabase is the shared source of truth (a table per concern, RLS-protected),
 * but the arcade must still work for guests and for deployments where the SQL
 * has not been re-run yet. So every call here has a local fallback:
 *
 *   · ratings  → localStorage, merged with whatever the server knows
 *   · scores   → localStorage leaderboard per game
 *
 * Nothing here touches the render loop. This is a database, not a frame budget:
 * it makes the catalogue shared across devices, it does not make the game faster.
 */
const LOCAL_KEY = 'outrun-arcade-stats';

const safeParse = (raw, fallback) => {
  try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
};

export function emptyStats() {
  return { ratings: {}, my: {}, runs: {}, best: {} };
}

export function normalizeStats(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, r] of Object.entries(raw.ratings || {})) {
    if (!r || typeof r !== 'object') continue;
    out.ratings[id] = {
      avg: Math.max(0, Math.min(5, Number(r.avg) || 0)),
      count: Math.max(0, Math.round(Number(r.count) || 0)),
    };
  }
  for (const [id, stars] of Object.entries(raw.my || {})) {
    const s = Math.round(Number(stars) || 0);
    if (s >= 1 && s <= 5) out.my[id] = s;
  }
  for (const [id, n] of Object.entries(raw.runs || {})) out.runs[id] = Math.max(0, Math.round(Number(n) || 0));
  for (const [id, list] of Object.entries(raw.best || {})) {
    if (Array.isArray(list)) {
      out.best[id] = list
        .filter((r) => r && Number.isFinite(Number(r.score)))
        .map((r) => ({
          score: Math.max(0, Math.round(Number(r.score))),
          name: String(r.name || 'SURVIVOR').slice(0, 14).toUpperCase(),
          at: Number(r.at) || 0,
          meta: String(r.meta || '').slice(0, 40),
        }))
        .slice(0, 10);
    }
  }
  return out;
}

/** Folds a new rating into the {avg,count} aggregate (score is kept in range). */
export function addRating(aggregate, stars) {
  const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
  const prev = aggregate || { avg: 0, count: 0 };
  const count = prev.count + 1;
  const avg = (prev.avg * prev.count + s) / count;
  return { avg, count };
}

/** Best-first, newest-first tiebreak — used for both local and server boards. */
export function rankRuns(runs) {
  return [...runs]
    .filter((r) => r && Number.isFinite(Number(r.score)))
    .sort((a, b) => (Number(b.score) - Number(a.score)) || (Number(b.at) - Number(a.at)));
}

/** "95% ★★★★★ (12)" style label, kept out of the DOM layer so tests can pin it. */
export function ratingLabel(aggregate) {
  if (!aggregate || !aggregate.count) return 'NOT RATED YET';
  const pct = Math.round((aggregate.avg / 5) * 100);
  const stars = '★'.repeat(Math.round(aggregate.avg)) + '☆'.repeat(5 - Math.round(aggregate.avg));
  return `${pct}% ${stars} (${aggregate.count})`;
}

const storage = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export class ArcadeStats {
  constructor({ account = null, storage: store = null } = {}) {
    this.account = account;
    this.store = store || storage();
    this.data = this.loadLocal();
    this.server = false;      // true once a Supabase read succeeded
    this.lastError = '';
  }

  loadLocal() {
    if (!this.store) return emptyStats();
    return normalizeStats(safeParse(this.store.getItem(LOCAL_KEY), null));
  }

  saveLocal() {
    if (!this.store) return;
    try { this.store.setItem(LOCAL_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  get sb() {
    const sb = this.account?.sb;
    return sb?.url && sb?.key ? sb : null;
  }

  get profileId() { return this.account?.profile?.id || null; }

  /** Pulls the shared aggregates; silently falls back to local on any failure. */
  async load() {
    const sb = this.sb;
    if (!sb) return this.data;
    try {
      const [ratingRows, runRows, mine] = await Promise.all([
        sb.select('game_ratings', 'select=game_id,stars'),
        sb.select('game_runs', 'select=game_id'),
        this.profileId
          ? sb.select('game_ratings', `user_id=eq.${this.profileId}&select=game_id,stars`)
          : Promise.resolve([]),
      ]);
      const ratings = {};
      for (const row of ratingRows || []) {
        const id = String(row.game_id || '');
        if (!id) continue;
        ratings[id] = ratings[id] || { sum: 0, count: 0 };
        ratings[id].sum += Math.max(1, Math.min(5, Number(row.stars) || 0));
        ratings[id].count += 1;
      }
      const runs = {};
      for (const row of runRows || []) {
        const id = String(row.game_id || '');
        if (id) runs[id] = (runs[id] || 0) + 1;
      }
      const my = {};
      for (const row of mine || []) my[String(row.game_id)] = Math.round(Number(row.stars) || 0);

      this.data.ratings = Object.fromEntries(Object.entries(ratings)
        .map(([id, r]) => [id, { avg: r.sum / r.count, count: r.count }]));
      this.data.runs = runs;
      this.data.my = my;
      this.server = true;
      this.saveLocal();
    } catch (err) {
      this.server = false;
      this.lastError = err?.message || 'unreachable';
    }
    return this.data;
  }

  ratingOf(gameId) { return this.data.ratings[gameId] || null; }
  myRating(gameId) { return this.data.my[gameId] || 0; }
  plays(gameId) { return this.data.runs[gameId] || 0; }

  /** 1–5 stars. Guests still get a local rating so the UI responds instantly. */
  async rate(gameId, stars) {
    const s = Math.max(1, Math.min(5, Math.round(Number(stars) || 0)));
    if (!s) return null;
    const previousMine = this.data.my[gameId] || 0;
    const aggregate = this.data.ratings[gameId] || { avg: 0, count: 0 };
    // replacing your own vote: drop the old one before adding the new one
    const base = previousMine
      ? {
        avg: aggregate.count > 1 ? ((aggregate.avg * aggregate.count) - previousMine) / (aggregate.count - 1) : 0,
        count: Math.max(0, aggregate.count - 1),
      }
      : aggregate;
    this.data.ratings[gameId] = addRating(base, s);
    this.data.my[gameId] = s;
    this.saveLocal();

    const sb = this.sb;
    if (sb && this.profileId) {
      try {
        await sb.upsert('game_ratings', [{
          user_id: this.profileId, game_id: gameId, stars: s, updated_at: new Date().toISOString(),
        }], 'user_id,game_id');
      } catch (err) {
        this.lastError = err?.message || 'rating_offline';
      }
    }
    return this.data.ratings[gameId];
  }

  /** Logs a finished run. Local board always updates; server is best-effort. */
  async submitRun(gameId, run = {}, playerName = 'SURVIVOR') {
    const entry = {
      score: Math.max(0, Math.round(Number(run.score) || 0)),
      name: String(playerName || 'SURVIVOR').slice(0, 14).toUpperCase(),
      at: Date.now(),
      meta: String(run.meta || '').slice(0, 40),
    };
    const board = this.data.best[gameId] || [];
    this.data.best[gameId] = rankRuns([...board, entry]).slice(0, 10);
    this.data.runs[gameId] = (this.data.runs[gameId] || 0) + 1;
    this.saveLocal();

    const sb = this.sb;
    if (sb) {
      try {
        await sb.insert('game_runs', [{
          user_id: this.profileId,
          game_id: gameId,
          score: entry.score,
          day: Math.max(0, Math.round(Number(run.day) || 0)),
          seconds: Math.max(0, Math.round(Number(run.seconds) || 0)),
          won: Boolean(run.won),
          meta: entry.meta,
        }]);
      } catch (err) {
        this.lastError = err?.message || 'run_offline';
      }
    }
    return entry;
  }

  /** Top scores: server first, then merge the local board so guests see theirs. */
  async leaderboard(gameId, limit = 10) {
    const local = rankRuns(this.data.best[gameId] || []);
    const sb = this.sb;
    if (!sb) return local.slice(0, limit);
    try {
      const rows = await sb.select('game_runs',
        `game_id=eq.${encodeURIComponent(gameId)}&won=not.is.null&select=score,meta,created_at,user_id&order=score.desc&limit=${limit}`);
      const merged = rankRuns([
        ...local,
        ...(rows || []).map((r) => ({
          score: Number(r.score) || 0,
          name: 'PLAYER',
          at: Date.parse(r.created_at) || 0,
          meta: String(r.meta || '').slice(0, 40),
        })),
      ]).slice(0, limit);
      return merged;
    } catch {
      return local.slice(0, limit);
    }
  }

  clearLocal() {
    this.data = emptyStats();
    if (this.store) { try { this.store.removeItem(LOCAL_KEY); } catch { /* ignore */ } }
    return this.data;
  }
}
