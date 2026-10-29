/**
 * Local run records: the "how far did I get last time" book.
 *
 * Kept entirely on the device (localStorage) so it works for guests and for
 * anyone whose Supabase profile column hasn't been deployed yet. It is per
 * mode — a 12-day Siege best means nothing next to a 100-day Endless best —
 * and it also keeps a career tally for the lobby header.
 *
 * Pure functions (no DOM, no game imports) so the tests can hammer them.
 */
export const RECORD_KEY = 'outrun-records';
export const BOOK_VERSION = 1;

/** The numbers we keep a personal best for, in the order the summary shows. */
export const TRACKED = [
  { key: 'day', label: 'DAYS SURVIVED', short: 'DAY' },
  { key: 'distance', label: 'DISTANCE', short: 'DIST', fmt: 'km' },
  { key: 'kills', label: 'SCAVENGERS DOWN', short: 'KILLS' },
  { key: 'itemsLooted', label: 'ITEMS LOOTED', short: 'LOOT' },
  { key: 'crafted', label: 'ITEMS CRAFTED', short: 'CRAFT' },
  { key: 'seconds', label: 'LONGEST RUN', short: 'TIME', fmt: 'clock' },
];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function emptyMode() {
  return { runs: 0, wins: 0, best: {}, last: {}, at: 0 };
}

export function emptyBook() {
  return {
    v: BOOK_VERSION,
    modes: {},
    career: { runs: 0, wins: 0, km: 0, kills: 0, looted: 0, crafted: 0, seconds: 0, bestDay: 0 },
    updatedAt: 0,
  };
}

/** Tolerant reader: any hand-edited/corrupt blob degrades to an empty book. */
export function normalizeBook(raw) {
  const book = emptyBook();
  if (!raw || typeof raw !== 'object') return book;
  const modes = raw.modes && typeof raw.modes === 'object' ? raw.modes : {};
  for (const [id, entry] of Object.entries(modes)) {
    if (!entry || typeof entry !== 'object') continue;
    const clean = emptyMode();
    clean.runs = Math.max(0, Math.round(num(entry.runs)));
    clean.wins = Math.max(0, Math.round(num(entry.wins)));
    clean.at = num(entry.at);
    for (const f of TRACKED) {
      if (Number.isFinite(Number(entry.best?.[f.key]))) clean.best[f.key] = num(entry.best[f.key]);
      if (Number.isFinite(Number(entry.last?.[f.key]))) clean.last[f.key] = num(entry.last[f.key]);
    }
    book.modes[id] = clean;
  }
  const c = raw.career;
  if (c && typeof c === 'object') {
    book.career = {
      runs: Math.max(0, Math.round(num(c.runs))),
      wins: Math.max(0, Math.round(num(c.wins))),
      km: num(c.km),
      kills: num(c.kills),
      looted: num(c.looted),
      crafted: num(c.crafted),
      seconds: num(c.seconds),
      bestDay: num(c.bestDay),
    };
  }
  book.updatedAt = num(raw.updatedAt);
  return book;
}

const storageOf = (storage) => storage === undefined ? safeStorage() : storage;

function safeStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadBook(storage) {
  const store = storageOf(storage);
  if (!store) return emptyBook();
  try {
    const raw = store.getItem(RECORD_KEY);
    return normalizeBook(raw ? JSON.parse(raw) : null);
  } catch {
    return emptyBook();
  }
}

export function saveBook(book, storage) {
  const store = storageOf(storage);
  const clean = normalizeBook(book);
  clean.updatedAt = Date.now();
  if (store) {
    try { store.setItem(RECORD_KEY, JSON.stringify(clean)); } catch { /* private mode / full */ }
  }
  return clean;
}

export function resetBook(storage) {
  const store = storageOf(storage);
  try { store?.removeItem(RECORD_KEY); } catch { /* ignore */ }
  return emptyBook();
}

export function modeStats(book, modeId) {
  const clean = normalizeBook(book);
  return clean.modes[modeId] || emptyMode();
}

/**
 * Folds one finished run into the book.
 * Returns a NEW book plus what the summary card needs to talk about:
 *   { book, fresh: ['day','distance'], first, best, isRecord }
 * `fresh` stays empty for a player's very first run — nothing to beat yet —
 * but `first` is true so the card can still say "run logged".
 */
export function commitRun(book, modeId, run = {}) {
  const next = normalizeBook(book);
  const id = String(modeId || 'classic');
  const entry = next.modes[id] ? { ...next.modes[id], best: { ...next.modes[id].best }, last: {} } : emptyMode();
  const first = entry.runs === 0;
  const fresh = [];
  const last = {};

  for (const f of TRACKED) {
    const value = Math.max(0, Math.round(num(run[f.key])));
    last[f.key] = value;
    if (value > num(entry.best[f.key])) {
      if (!first) fresh.push(f.key);
      entry.best[f.key] = value;
    }
  }

  entry.runs += 1;
  if (run.won) entry.wins += 1;
  entry.last = last;
  entry.at = Date.now();
  next.modes[id] = entry;

  const km = Math.max(0, num(run.distance)) / 1000;
  next.career.runs += 1;
  if (run.won) next.career.wins += 1;
  next.career.km += km;
  next.career.kills += Math.max(0, Math.round(num(run.kills)));
  next.career.looted += Math.max(0, Math.round(num(run.itemsLooted)));
  next.career.crafted += Math.max(0, Math.round(num(run.crafted)));
  next.career.seconds += Math.max(0, Math.round(num(run.seconds)));
  next.career.bestDay = Math.max(next.career.bestDay, last.day || 0);
  next.updatedAt = Date.now();

  return { book: next, fresh, first, best: entry.best, isRecord: fresh.length > 0 };
}

export function fmtValue(field, value) {
  const v = num(value);
  if (field?.fmt === 'km') return `${(v / 1000).toFixed(1)} KM`;
  if (field?.fmt === 'clock') return fmtClock(v);
  return String(Math.round(v));
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(num(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** One-liner under a mode card in the lobby. */
export function bestLine(book, modeId) {
  const entry = modeStats(book, modeId);
  if (!entry.runs) return 'NO RUNS YET';
  const day = Math.round(num(entry.best.day));
  const km = (num(entry.best.distance) / 1000).toFixed(1);
  return `BEST DAY ${day} · ${km} KM`;
}

/** Career strip for the lobby. */
export function careerLine(book) {
  const clean = normalizeBook(book);
  const c = clean.career;
  if (!c.runs) return 'NO RUNS YET — THE HIGHWAY IS WAITING';
  const parts = [
    `${c.runs} RUN${c.runs === 1 ? '' : 'S'}`,
    `${c.wins} CLEARED`,
    `${c.km.toFixed(1)} KM DRIVEN`,
    `BEST DAY ${Math.round(c.bestDay)}`,
  ];
  return parts.join(' · ');
}

/** Labels for the badges on the run-over card. */
export function freshLabels(fresh) {
  return (fresh || []).map((key) => TRACKED.find((f) => f.key === key)?.short || key.toUpperCase());
}
