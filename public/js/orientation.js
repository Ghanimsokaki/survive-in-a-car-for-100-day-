/**
 * AUTO LANDSCAPE
 *
 * Two different screens, two different shapes:
 *
 *   · THE HOME (sign-in, lobby, arcade) is portrait — it is a list of cards,
 *     a friends strip and a big PLAY button, and rotating a menu sideways is
 *     worse than leaving it upright. Nothing here ever turns the home.
 *   · A RUN (the 3D game, a community game) is landscape: wide viewports are
 *     what the HUD and the canvas were built for.
 *
 * `installAutoLandscape()` therefore only ever *asks* for landscape while a run
 * is live (`body.run-live`), and hands the device back to portrait when the run
 * ends. Where the browser allows it, the request uses three fallbacks:
 *
 *   1. `screen.orientation.lock('landscape')`  — Chrome/Android, needs fullscreen
 *   2. fullscreen + a second lock attempt      — same, after the gesture lands
 *   3. CSS rotation of the whole app           — iOS Safari, which refuses both
 *
 * Nothing here throws, and nothing blocks the first frame.
 */
const isCoarse = () => {
  try { return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches); } catch { return false; }
};

export const isTouchDevice = () => {
  try {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0 || isCoarse();
  } catch { return false; }
};

export const isPortrait = () => {
  try { return window.innerHeight > window.innerWidth; } catch { return false; }
};

/** A phone rather than a tablet or a desktop window. */
export const isPhone = () => {
  try {
    if (!isTouchDevice()) return false;
    const smallest = Math.min(window.screen?.width || 9999, window.screen?.height || 9999);
    return smallest < 820;
  } catch { return false; }
};

const state = {
  installed: false,
  locked: false,
  attempts: 0,
  canFullscreen: true,
  listeners: new Set(),
};

const emit = () => state.listeners.forEach((fn) => {
  try { fn({ locked: state.locked, portrait: isPortrait() }); } catch { /* ignore */ }
});

/** Is a run on screen? Only then is landscape wanted. */
export const isPlaying = () => {
  try { return document.body?.classList.contains('run-live') === true; } catch { return false; }
};

/**
 * Hands the device back to portrait and leaves fullscreen. Called when a run
 * ends or the player backs out to the arcade, so the home is upright again.
 */
export async function requestPortrait() {
  state.locked = false;
  try {
    const orientation = typeof screen !== 'undefined' ? screen.orientation : null;
    if (orientation?.lock) {
      await orientation.lock('portrait');
      emit();
      return true;
    }
  } catch { /* iOS and friends: nothing to lock */ }
  try {
    if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
  } catch { /* already out */ }
  emit();
  return false;
}

/** Asks the browser for fullscreen + a landscape lock. Safe to call repeatedly. */
export async function requestLandscape({ fullscreen = true, force = false } = {}) {
  if (!isPhone()) return false;
  // A menu has no business turning the phone. Only a live run may ask.
  if (!force && !isPlaying()) return false;
  state.attempts += 1;

  if (fullscreen && state.canFullscreen) {
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el?.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch {
      // iOS and some Android skins refuse fullscreen outright — stop retrying
      state.canFullscreen = false;
    }
  }

  try {
    const orientation = typeof screen !== 'undefined' ? screen.orientation : null;
    if (orientation?.lock) {
      await orientation.lock('landscape');
      state.locked = true;
      emit();
      return true;
    }
  } catch { /* unsupported or denied */ }
  emit();
  return false;
}

/**
 * Installs the automatic behaviour:
 *   · try immediately (covers returning from a fullscreen exit)
 *   · retry on the first real gesture, which is what browsers actually require
 *   · retry whenever the device is rotated back to portrait
 *   · keep `auto-land` on <body> in sync so CSS can rotate if the API is missing
 *
 * @param {object} [opts]
 * @param {'any'|'phone'} [opts.when]  gate the rotation fallback
 * @param {(s: {locked:boolean, portrait:boolean}) => void} [opts.onChange]
 */
export function installAutoLandscape({ when = 'phone', onChange = null } = {}) {
  if (onChange) state.listeners.add(onChange);
  if (state.installed) return state;
  state.installed = true;

  const gated = () => (when === 'any' ? isTouchDevice() : isPhone());

  const syncClass = () => {
    // `auto-land` means "rotate the run in CSS". Off the home it is meaningless,
    // and on the home it must never be set — the menu is portrait by design.
    const on = gated() && isPlaying() && isPortrait();
    if (document.body) document.body.classList.toggle('auto-land', on);
    if (!on && document.documentElement?.classList) document.documentElement.classList.remove('rot-stage');
    emit();
  };

  const retry = () => {
    if (!gated()) return;
    if (isPlaying() && isPortrait()) requestLandscape();
    syncClass();
  };

  // one-shot gesture listeners: browsers only honour fullscreen/lock inside them
  const onGesture = () => {
    if (!gated()) return;
    if (isPlaying() && isPortrait() && !state.locked && state.attempts < 6) requestLandscape();
    syncClass();
  };
  window.addEventListener('pointerdown', onGesture, { passive: true, once: false });
  window.addEventListener('keydown', onGesture, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(retry, 200));
  window.addEventListener('resize', () => setTimeout(syncClass, 160));
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && isPortrait() && isPlaying()) {
      state.locked = false;
      setTimeout(retry, 120);
    }
  });

  // first pass, after layout so innerWidth/innerHeight are real
  setTimeout(() => { retry(); syncClass(); }, 60);
  return state;
}

/** Escape hatch for an explicit "rotate" button. */
export async function forceLandscape() {
  const ok = await requestLandscape({ force: true });
  document.body.classList.toggle('auto-land', !ok && isPortrait());
  return ok;
}

/**
 * True while <body> is being CSS-rotated into landscape. The transform creates a
 * containing block for fixed children, so everything inside is laid out in
 * "stage" space: `stageSize()` reports that space, not the raw viewport.
 */
export function isRotatedStage() {
  try {
    return document.body?.classList.contains('auto-land') === true
      && document.body.classList.contains('run-live');
  } catch { return false; }
}

/**
 * The size the game should render at. In a rotated stage the viewport is portrait
 * but the player sees it sideways, so width and height swap.
 */
export function stageSize() {
  try {
    if (isRotatedStage()) {
      return { w: window.innerHeight, h: window.innerWidth, rotated: true };
    }
    return { w: window.innerWidth, h: window.innerHeight, rotated: false };
  } catch {
    return { w: 1280, h: 720, rotated: false };
  }
}

/**
 * Maps a pointer's `clientX/clientY` into stage space. Browsers report pointer
 * positions in screen space, which is rotated 90° clockwise from the stage, so
 * the axes have to be swapped or every drag would go sideways.
 */
export function toStagePoint(clientX, clientY) {
  if (!isRotatedStage()) return { x: clientX, y: clientY };
  let vw = 0;
  try { vw = window.innerWidth; } catch { /* keep 0 */ }
  return { x: clientY, y: vw - clientX };
}

export function onOrientation(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

export const landscapeState = () => ({
  locked: state.locked,
  attempts: state.attempts,
  portrait: isPortrait(),
  phone: isPhone(),
});
