/**
 * FULLSCREEN — one button, everywhere, that actually works.
 *
 * Three facts about the Fullscreen API that shape this module:
 *
 *   1. It must be called inside a user gesture. The listeners below are `click`
 *      and `keydown` handlers for exactly that reason, so the promise resolves.
 *   2. WebKit (iOS Safari, and every browser on iOS because they all use
 *      WebKit) exposes `webkitRequestFullscreen` on elements but refuses for
 *      anything that is not a <video>. There is no second chance, so instead of
 *      breaking, `toggle()` reports `'unsupported'` and the UI hides the button
 *      and shows the "add to home screen" hint once.
 *   3. Android Chrome and Samsung Internet can only lock the orientation while
 *      the page is fullscreen — which is why "go landscape" goes through here.
 *
 * The module also remembers the player's preference, so a phone that went
 * fullscreen once will be asked again on the next PLAY tap (a real gesture),
 * never automatically on load (which browsers block silently).
 */
const STORE_KEY = 'outrun-fullscreen-v1';
const listeners = new Set();
let lastError = null;

const doc = () => (typeof document !== 'undefined' ? document : null);

/** Does this browser have any fullscreen entry point at all? */
export function isSupported() {
  const d = doc();
  if (!d) return false;
  const el = d.documentElement;
  return Boolean(el?.requestFullscreen || el?.webkitRequestFullscreen || d.body?.webkitRequestFullscreen);
}

/** Fullscreen is on if any vendor spelling says so. */
export function isFullscreen() {
  const d = doc();
  if (!d) return false;
  return Boolean(d.fullscreenElement || d.webkitFullscreenElement || d.msFullscreenElement);
}

const emit = () => {
  const state = { fullscreen: isFullscreen(), supported: isSupported(), error: lastError };
  for (const fn of listeners) {
    try { fn(state); } catch { /* a broken listener must not break the others */ }
  }
};

export function onFullscreenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Remember whether the player wants fullscreen, so PLAY can re-apply it. */
export function readPreference() {
  try { return globalThis.localStorage?.getItem(STORE_KEY) === 'on'; } catch { return false; }
}

export function writePreference(on) {
  try { globalThis.localStorage?.setItem(STORE_KEY, on ? 'on' : 'off'); } catch { /* private mode */ }
}

async function enter(element = null) {
  const d = doc();
  const target = element || d?.documentElement || d?.body;
  if (!target) return { ok: false, reason: 'unsupported' };
  try {
    if (target.requestFullscreen) {
      // navigationUI is ignored where it is not supported — harmless
      await target.requestFullscreen({ navigationUI: 'hide' });
    } else if (target.webkitRequestFullscreen) {
      await target.webkitRequestFullscreen();
    } else if (target.msRequestFullscreen) {
      await target.msRequestFullscreen();
    } else {
      return { ok: false, reason: 'unsupported' };
    }
    lastError = null;
    writePreference(true);
    emit();
    return { ok: true };
  } catch (err) {
    lastError = String(err?.message || err);
    writePreference(false);
    emit();
    return { ok: false, reason: 'denied', error: lastError };
  }
}

async function leave() {
  const d = doc();
  try {
    if (d?.exitFullscreen) await d.exitFullscreen();
    else if (d?.webkitExitFullscreen) await d.webkitExitFullscreen();
    else if (d?.msExitFullscreen) await d.msExitFullscreen();
  } catch (err) {
    lastError = String(err?.message || err);
  }
  writePreference(false);
  emit();
  return { ok: true };
}

/**
 * Turns fullscreen on or off (or, with `on`, forces one direction).
 * Resolves to `{ ok, fullscreen, reason? }` and never throws.
 */
export async function toggleFullscreen({ on = null, element = null } = {}) {
  const want = on === null ? !isFullscreen() : Boolean(on);
  if (want === isFullscreen()) {
    emit();
    return { ok: true, fullscreen: want };
  }
  const result = want ? await enter(element) : await leave();
  return { ...result, fullscreen: isFullscreen() };
}

export const enterFullscreen = (opts = {}) => toggleFullscreen({ ...opts, on: true });
export const exitFullscreen = () => toggleFullscreen({ on: false });

/**
 * Wires `[data-fullscreen]` buttons (any number of them) and the keyboard
 * shortcut. Returns a `sync()` so callers can repaint the icons after the
 * browser changes state on its own (Esc, swipe from the top, F11).
 */
export function installFullscreen({ root = null, shortcuts = true } = {}) {
  const d = doc();
  const scope = root || d;
  if (!scope) return { sync: () => {}, destroy: () => {} };

  const buttons = () => {
    try {
      const list = scope.querySelectorAll ? [...scope.querySelectorAll('[data-fullscreen]')] : [];
      if (root && root.matches?.('[data-fullscreen]')) list.push(root);
      return list;
    } catch { return []; }
  };

  const sync = () => {
    const on = isFullscreen();
    const supported = isSupported();
    for (const btn of buttons()) {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('unsupported', !supported);
      const label = on ? 'EXIT FULLSCREEN' : 'FULLSCREEN';
      if (btn.dataset.fullscreen === 'label') btn.textContent = `${on ? '⤡' : '⤢'} ${label}`;
      if (btn.dataset.fullscreen === 'icon') {
        btn.textContent = on ? '⤡' : '⤢';
        btn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
      }
      btn.title = supported ? `${label} (Alt+Enter)` : 'Fullscreen is not available in this browser';
    }
    try { d?.documentElement?.classList.toggle('is-fullscreen', on); } catch { /* detached */ }
  };

  const onClick = (e) => {
    const btn = e.target?.closest?.('[data-fullscreen]');
    if (!btn) return;
    e.preventDefault();
    toggleFullscreen().then(sync);
  };

  const typing = (e) => {
    const t = e?.target;
    const tag = String(t?.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable === true;
  };

  const onKey = (e) => {
    if (typing(e)) return;                 // never steal a keystroke from chat
    // Alt+Enter is the desktop convention; Shift+F is a one-hand phone/desktop
    // shortcut that does not collide with the game's F (attack / horn).
    const altEnter = e.altKey && (e.key === 'Enter' || e.code === 'Enter');
    const shiftF = e.shiftKey && !e.altKey && !e.ctrlKey && (e.key === 'F' || e.key === 'f');
    if (!altEnter && !shiftF) return;
    e.preventDefault();
    toggleFullscreen().then(sync);
  };

  scope.addEventListener?.('click', onClick);
  if (shortcuts) d?.addEventListener?.('keydown', onKey);
  d?.addEventListener?.('fullscreenchange', sync);
  d?.addEventListener?.('webkitfullscreenchange', sync);

  sync();
  return {
    sync,
    destroy() {
      scope.removeEventListener?.('click', onClick);
      if (shortcuts) d?.removeEventListener?.('keydown', onKey);
      d?.removeEventListener?.('fullscreenchange', sync);
      d?.removeEventListener?.('webkitfullscreenchange', sync);
    },
  };
}
