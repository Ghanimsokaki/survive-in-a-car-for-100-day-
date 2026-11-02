/**
 * MEMORY — the game remembers your last play so you can pick it up again.
 *
 * A run is forty minutes of scavenging; losing it to a refresh, a locked phone
 * or a closed tab is the difference between a session and a chore. So every
 * game writes a small snapshot of where the player got to, and the hub offers to
 * continue it.
 *
 * Three rules, because this is the one module that can lose a player's progress:
 *
 *   1. **A snapshot is a value, not a handle.** Whatever is handed in is copied,
 *      never stored by reference — a live game that keeps mutating its state
 *      must not be able to corrupt a slot that was already written.
 *   2. **Storage that says no is normal.** A sandboxed frame, private mode, a
 *      full quota: every call is guarded, and the memory simply reports "no".
 *      Nothing throws into a game loop.
 *   3. **A stale or half-written slot is discarded, not half-loaded.** Slots
 *      carry a version and a game id; anything that does not match is dropped,
 *      so an old build's snapshot can never be applied to a new run.
 *
 * The snapshot's *shape* is the game's business; this module only guards size,
 * age and identity.
 */

const PREFIX = 'gemby-memory:';
const VERSION = 1;
/** A snapshot bigger than this is not a save, it is a leak. */
const MAX_BYTES = 24 * 1024;
/** Two weeks: long enough for a holiday, short enough to not be a mystery. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** localStorage, or null where even reading the global throws. */
export function safeStore(store) {
  if (store) return store;
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // Safari in private mode has the object but throws on the first write
    const probe = `${PREFIX}probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

const keyFor = (gameId) => `${PREFIX}${String(gameId || '').slice(0, 40)}`;

function parse(raw, gameId) {
  if (!raw) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  if (data.v !== VERSION) return null;
  if (String(data.game) !== String(gameId)) return null;
  if (!data.state || typeof data.state !== 'object') return null;
  const at = Number(data.at) || 0;
  if (!at || Date.now() - at > MAX_AGE_MS || at > Date.now() + 60000) return null;
  return { game: String(data.game), at, state: data.state, label: String(data.label || '') };
}

/**
 * Writes a slot. Returns the stored record, or null when it could not be saved
 * (no storage, quota, or a snapshot too large to be a save).
 *
 * @param {string} gameId
 * @param {object} state   plain, JSON-safe
 * @param {{ label?: string, at?: number }} [meta]
 */
export function rememberRun(gameId, state, meta = {}, store) {
  if (!gameId || !state) return null;
  const s = safeStore(store);
  if (!s) return null;
  let body;
  try { body = JSON.stringify(state); } catch { return null; }
  if (!body || body.length > MAX_BYTES) return null;
  const record = {
    v: VERSION,
    game: String(gameId),
    at: Number(meta.at) || Date.now(),
    label: String(meta.label || '').slice(0, 48),
    state,
  };
  const payload = JSON.stringify(record);
  try {
    s.setItem(keyFor(gameId), payload);
    return record;
  } catch {
    // Out of room. The slot being written is the one the player just earned, so
    // the oldest *other* slots are the ones to give up — one at a time, and at
    // most a few times, because a snapshot bigger than the whole quota has to
    // fail rather than spin.
    for (let attempt = 0; attempt < 4; attempt++) {
      const oldest = allRuns(s)
        .filter((r) => r.game !== String(gameId))
        .sort((a, b) => a.at - b.at)[0];
      if (!oldest) return null;
      try { s.removeItem(keyFor(oldest.game)); } catch { return null; }
      try {
        s.setItem(keyFor(gameId), payload);
        return record;
      } catch { /* still no room: drop the next oldest */ }
    }
    return null;
  }
}

/** The remembered play for one game, or null. Never throws. */
export function recallRun(gameId, store) {
  const s = safeStore(store);
  if (!s || !gameId) return null;
  try { return parse(s.getItem(keyFor(gameId)), gameId); } catch { return null; }
}

export function forgetRun(gameId, store) {
  const s = safeStore(store);
  if (!s) return;
  try { s.removeItem(keyFor(gameId)); } catch { /* nothing to forget */ }
}

/** Every remembered play, newest first. Used by the hub's continue card. */
export function allRuns(store) {
  const s = safeStore(store);
  if (!s) return [];
  const out = [];
  let keys = [];
  try {
    // the Storage interface is length + key(i); Object.keys is the fallback for
    // the Map-backed stub the tests use
    if (typeof s.length === 'number' && typeof s.key === 'function') {
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k) keys.push(k);
      }
    } else {
      keys = Object.keys(s);
    }
    keys = keys.filter((k) => k.startsWith(PREFIX) && k !== `${PREFIX}probe`);
  } catch { return out; }
  for (const k of keys) {
    const game = k.slice(PREFIX.length);
    const record = recallRun(game, s);
    if (record) out.push(record);
    else {
      // a slot this build cannot read is dead weight — take it out
      try { s.removeItem(k); } catch { /* leave it */ }
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

export function lastRun(store) {
  return allRuns(store)[0] || null;
}

/** "JUST NOW" · "12 MIN AGO" · "3 HRS AGO" · "2 DAYS AGO". */
export function agoLabel(at, now = Date.now()) {
  const ms = Math.max(0, Number(now) - Number(at || 0));
  const min = Math.floor(ms / 60000);
  if (!Number.isFinite(at) || !at) return '';
  if (min < 1) return 'JUST NOW';
  if (min < 60) return `${min} MIN AGO`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs} HR${hrs === 1 ? '' : 'S'} AGO`;
  const days = Math.floor(hrs / 24);
  return `${days} DAY${days === 1 ? '' : 'S'} AGO`;
}

/** "14:32" on the same day, "12 NOV 14:32" otherwise. */
export function whenLabel(at, now = Date.now()) {
  const t = new Date(Number(at) || 0);
  if (!Number.isFinite(t.getTime()) || !at) return '';
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const sameDay = new Date(now).toDateString() === t.toDateString();
  if (sameDay) return clock;
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  return `${t.getDate()} ${months[t.getMonth()]} ${clock}`;
}

/**
 * The one line a continue card needs: what it is and how old it is.
 * @returns {string} e.g. "FUEL RUN · DAY 12 · 6 MIN AGO"
 */
export function describeRun(record, now = Date.now()) {
  if (!record) return '';
  const label = record.label || String(record.game || '').toUpperCase();
  const bits = [label];
  const day = Number(record.state?.day);
  // the label usually already says "DAY 12" — one of them is enough
  if (Number.isFinite(day) && day > 0 && !/\bDAY\s+\d/i.test(label)) bits.push(`DAY ${Math.round(day)}`);
  const ago = agoLabel(record.at, now);
  if (ago) bits.push(ago);
  return bits.join(' · ');
}

export const MEMORY_KEY = PREFIX;
export const MEMORY_VERSION = VERSION;

/**
 * The hub's CONTINUE card, mounted by whoever owns the page state.
 *
 * It lives here, not in `main.js`, for one reason: `js/memory.js` is fetched
 * after the menu paints (see `loadMemory` in main.js), so everything to do with
 * remembering a run — reading the slot, painting the card, refreshing its age —
 * arrives in the same small module instead of growing the home's boot payload.
 *
 * @param {object} hooks
 * @param {() => string} hooks.getMode      the mode selected in the menu
 * @param {(record: object) => void} hooks.onContinue
 * @param {(record: object|null) => void} [hooks.onForget]
 * @returns {() => object|null} repaint; also fires every 30 s on its own
 */
export function installContinueCard({ getMode, onContinue, onForget } = {}) {
  const doc = globalThis.document;
  const $ = (id) => doc?.getElementById?.(id) || null;
  const card = $('continueCard');
  if (!card) return () => null;

  const current = () => recallRun(getMode?.()) || lastRun();

  const refresh = () => {
    const record = current();
    if (!record) {
      card.classList.add('hidden');
      return null;
    }
    card.classList.remove('hidden');
    card.dataset.game = record.game;
    const title = $('continueTitle');
    const when = $('continueWhen');
    if (title) title.textContent = record.label || String(record.game || '').toUpperCase();
    if (when) when.textContent = `${agoLabel(record.at)} · ${whenLabel(record.at)}`;
    return record;
  };

  $('continueBtn')?.addEventListener('click', () => {
    const record = current();
    if (record) onContinue?.(record);
  });
  $('continueForget')?.addEventListener('click', () => {
    const record = current();
    if (record) forgetRun(record.game);
    refresh();
    onForget?.(record);
  });

  refresh();
  // a slot ages while the page is open: keep "6 MIN AGO" honest
  try { globalThis.setInterval?.(refresh, 30000); } catch { /* no timers */ }
  return refresh;
}
