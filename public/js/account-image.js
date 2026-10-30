/**
 * ACCOUNT PICTURES — the player's own profile image.
 *
 * A picture is uploaded from the phone or desktop, cropped square, shrunk to a
 * 196 px JPEG and stored as a `data:` URL. Doing the resize *here* means the
 * server never sees a 6 MB camera photo: a profile row stays a few kilobytes,
 * which keeps the friends list, the hub and the Supabase free tier happy.
 *
 * The pure helpers (initials, crop maths, validation) are exported separately so
 * the test suite can pin the behaviour without a canvas.
 */

export const AVATAR_SIZE = 196;                    // stored image is N×N px
export const AVATAR_QUALITY = 0.82;
export const AVATAR_MAX_FILE = 8 * 1024 * 1024;    // biggest file we will open
export const AVATAR_MAX_DATA = 420 * 1024;         // longest data: URL we will store

const DATA_URL = /^data:image\/(?:png|jpe?g|webp);base64,[a-z0-9+/=]+$/i;

/** "GHANIM Z" → "GZ", "wanderer" → "WA", "" → "?" */
export function initialsOf(name) {
  const parts = String(name ?? '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, ' ')
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** A data URL we are willing to store and render. Everything else is rejected. */
export function isAvatarImage(url) {
  const s = typeof url === 'string' ? url.trim() : '';
  if (!s || s.length > AVATAR_MAX_DATA) return false;
  return DATA_URL.test(s);
}

/** Coerces a profile row's value into '' (none) or a valid picture. */
export function cleanAvatar(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return isAvatarImage(s) ? s : '';
}

/**
 * Centre-crop maths: the square we cut out of a w×h picture. Portrait photos
 * lose their sides, landscape photos lose their top and bottom — never their
 * subject's face, which is why we crop from the middle rather than the corner.
 */
export function squareCrop(width, height) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const side = Math.min(w, h);
  return { x: Math.round((w - side) / 2), y: Math.round((h - side) / 2), side, width: w, height: h };
}

/** Cheap gate before we decode anything: right kind of file, small enough. */
export function checkImageFile(file) {
  if (!file) return { ok: false, reason: 'Pick a picture first.' };
  const type = String(file.type || '');
  if (type && !/^image\//.test(type)) {
    return { ok: false, reason: 'That is not an image — try a JPG, PNG or WebP.' };
  }
  const size = Number(file.size || 0);
  if (size > AVATAR_MAX_FILE) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `That picture is ${mb} MB — pick one under 8 MB.` };
  }
  return { ok: true, reason: '' };
}

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const FR = globalThis.FileReader;
  if (!FR) { reject(new Error('This browser cannot read files.')); return; }
  const reader = new FR();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(new Error('Could not read that file.'));
  reader.readAsDataURL(file);
});

const loadImageElement = (src) => new Promise((resolve, reject) => {
  const Img = globalThis.Image;
  if (!Img) { reject(new Error('This browser cannot open pictures.')); return; }
  const img = new Img();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error('That picture could not be opened.'));
  img.src = src;
});

/** Decodes the file into something drawable, preferring the cheap path. */
async function decodeImage(file) {
  if (typeof globalThis.createImageBitmap === 'function') {
    try {
      const bitmap = await globalThis.createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
    } catch { /* fall through to the <img> path */ }
  }
  const url = await readAsDataUrl(file);
  const img = await loadImageElement(url);
  const width = img.naturalWidth || img.width || 0;
  const height = img.naturalHeight || img.height || 0;
  if (!width || !height) throw new Error('That picture looks empty.');
  return { source: img, width, height, close: () => {} };
}

/**
 * File → stored avatar. Throws a human-readable Error when the picture is the
 * wrong type, too big, undecodable, or refuses to compress small enough.
 */
export async function fileToAvatar(file, { size = AVATAR_SIZE, quality = AVATAR_QUALITY } = {}) {
  const gate = checkImageFile(file);
  if (!gate.ok) throw new Error(gate.reason);

  const decoded = await decodeImage(file);
  try {
    const crop = squareCrop(decoded.width, decoded.height);
    if (typeof document === 'undefined' || !document.createElement) {
      throw new Error('Pictures need a browser.');
    }
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext?.('2d');
    if (!ctx || typeof canvas.toDataURL !== 'function') {
      throw new Error('This browser cannot resize pictures.');
    }
    ctx.drawImage(decoded.source, crop.x, crop.y, crop.side, crop.side, 0, 0, size, size);

    // Try the good quality first, then step down only if the result is too big.
    const ladder = [quality, 0.72, 0.6, 0.45];
    for (const q of ladder) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (isAvatarImage(url)) return url;
    }
    throw new Error('That picture is too detailed to store — try a simpler one.');
  } finally {
    decoded.close?.();
  }
}

/**
 * Paints an element as a round portrait, falling back to initials + a colour
 * when the player has no picture yet.
 */
export function paintAvatar(el, { image = '', name = '', color = '#ffb347' } = {}) {
  if (!el?.style) return;
  const url = cleanAvatar(image);
  el.textContent = url ? '' : initialsOf(name);
  if (el.classList?.toggle) el.classList.toggle('has-img', Boolean(url));
  if (url) {
    // the shorthand clears background-image, so it has to be written first
    el.style.background = '';
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
  } else {
    el.style.backgroundImage = 'none';
    el.style.background = color || '#ffb347';
  }
  if (el.title !== undefined) el.title = url ? `${name || 'PLAYER'} — account picture` : `${name || 'PLAYER'}`;
  return el;
}
