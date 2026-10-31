/**
 * PLAYER SETTINGS — the handful of choices that belong to the *player*, not to
 * a single run: how loud the game is, how much the camera shakes, and which
 * graphics tier to use.
 *
 * Everything is plain data with a normaliser that never throws, so an old save,
 * a half-written localStorage value or a profile row with junk in it can be fed
 * straight in. The module also knows how to push a settings object into the live
 * audio kit and game, which keeps the "apply" rules in one place instead of
 * scattered across the boot path and the options panel.
 */

export const SETTINGS_KEY = 'outrun-settings-v1';

/** Graphics tiers, in the order the UI shows them. `auto` picks for the device. */
export const QUALITY_CHOICES = ['auto', 'low', 'medium', 'high', 'ultra'];

export const DEFAULT_SETTINGS = Object.freeze({
  volume: 0.7,      // 0…1 master volume
  muted: false,
  shake: 1,         // 0…1 multiplier on camera shake
  quality: 'auto',
});

const clampNum = (value, lo, hi, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

const asBool = (value) => value === true || value === 1 || value === '1' || value === 'true' || value === 'on';

/** Accepts anything and returns a complete, valid settings object. */
export function normalizeSettings(input) {
  const raw = input && typeof input === 'object' ? input : {};
  return {
    volume: clampNum(raw.volume, 0, 1, DEFAULT_SETTINGS.volume),
    muted: asBool(raw.muted),
    shake: clampNum(raw.shake, 0, 1, DEFAULT_SETTINGS.shake),
    quality: QUALITY_CHOICES.includes(raw.quality) ? raw.quality : DEFAULT_SETTINGS.quality,
  };
}

/** Reads the saved settings; a missing or corrupt blob yields the defaults. */
export function loadSettings(storage = safeStorage()) {
  try {
    const raw = storage?.getItem?.(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merges a patch into the saved settings and returns the merged result. */
export function saveSettings(patch, storage = safeStorage()) {
  const merged = normalizeSettings({ ...loadSettings(storage), ...(patch || {}) });
  try { storage?.setItem?.(SETTINGS_KEY, JSON.stringify(merged)); } catch { /* private mode / full quota */ }
  return merged;
}

export function isDefaultSettings(input) {
  const s = normalizeSettings(input);
  return s.volume === DEFAULT_SETTINGS.volume
    && s.muted === DEFAULT_SETTINGS.muted
    && s.shake === DEFAULT_SETTINGS.shake
    && s.quality === DEFAULT_SETTINGS.quality;
}

/** "70%" — or MUTED / SILENT when it would be a lie to print a number. */
export function describeVolume(input) {
  const s = normalizeSettings(input);
  if (s.volume <= 0) return 'SILENT';
  if (s.muted) return 'MUTED';
  return `${Math.round(s.volume * 100)}%`;
}

/** "100%", or OFF when the player asked for a still camera. */
export function describeShake(input) {
  const s = normalizeSettings(input);
  if (s.shake <= 0) return 'OFF';
  return `${Math.round(s.shake * 100)}%`;
}

export function describeQuality(input) {
  const q = normalizeSettings(input).quality;
  return q === 'auto' ? 'AUTO' : q.toUpperCase();
}

function safeStorage() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

/**
 * Applies settings to whatever is running. Both targets are optional and both
 * are feature-detected: the menu can change the volume long before a Game (or
 * even an AudioContext) exists, and that must not throw.
 */
export function applySettings(input, { audio = null, game = null } = {}) {
  const s = normalizeSettings(input);

  if (audio) {
    try { audio.setMuted?.(s.muted); } catch { /* a locked-down webview */ }
    try { audio.setVolume?.(s.volume); } catch { /* ignore */ }
    // legacy kits only know `enabled`
    if (typeof audio.setVolume !== 'function') {
      try { audio.enabled = !s.muted && s.volume > 0; } catch { /* ignore */ }
    }
  }

  if (game) {
    try { game.setShakeScale?.(s.shake); } catch { /* ignore */ }
  }

  return s;
}
