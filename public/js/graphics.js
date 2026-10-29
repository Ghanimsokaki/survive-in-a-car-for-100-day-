/**
 * GRAPHICS TIERS — one table the whole renderer reads from.
 *
 * Every quality decision used to be an inline `quality === 'high' ? A : B`
 * ternary spread across game.js, world.js and materials.js, which made adding a
 * tier a hunt through three files. Now there is a single table: each tier is a
 * complete description of what the scene looks like, and the renderer reads the
 * numbers instead of guessing.
 *
 *   low     phones that struggle: no shadows, no environment, thin scenery
 *   medium  most phones and laptops
 *   high    desktop / flagship phone: soft shadows, PBR environment, rim light
 *   ultra   "very high": 4K shadow maps, dense scenery, long draw distance,
 *           stronger rim + fill, bigger particle budget, screen glow and grain
 *
 * Ultra is not free — it is meant for a real GPU. It is the only tier that
 * renders at up to 2.5× device pixel ratio, and the frame governor still trims
 * resolution if the frame time slips, so choosing it can never make the game
 * unplayable.
 */

export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

export const TIERS = {
  low: {
    id: 'low',
    label: 'LOW',
    blurb: 'Fastest. No shadows, thin scenery.',
    pixelCap: 1,
    minScale: 0.5,
    antialias: false,
    shadows: false,
    shadowSize: 0,
    shadowSoft: false,
    shadowRadius: 46,
    shadowFar: 140,
    env: false,
    detail: 'low',
    avatarDetail: 'low',
    effects: 0.45,
    particles: 0.45,
    fog: [70, 300],
    drawDistance: 300,
    props: 56,
    clouds: 0,
    exposure: 1.02,
    rim: 0,
    fill: 0,
    interior: 14,
    post: [],
    anisotropy: 2,
  },
  medium: {
    id: 'medium',
    label: 'MED',
    blurb: 'Balanced. Soft-ish shadows on phones.',
    pixelCap: 1.4,
    minScale: 0.55,
    antialias: true,
    shadows: true,
    shadowSize: 1024,
    shadowSoft: false,
    shadowRadius: 52,
    shadowFar: 160,
    env: false,
    detail: 'medium',
    avatarDetail: 'medium',
    effects: 0.7,
    particles: 0.7,
    fog: [90, 430],
    drawDistance: 430,
    props: 72,
    clouds: 1,
    exposure: 1.04,
    rim: 0,
    fill: 0,
    interior: 22,
    post: ['vignette'],
    anisotropy: 4,
  },
  high: {
    id: 'high',
    label: 'HIGH',
    blurb: 'Desktop look: soft shadows, PBR reflections.',
    pixelCap: 1.85,
    minScale: 0.62,
    antialias: true,
    shadows: true,
    shadowSize: 2048,
    shadowSoft: true,
    shadowRadius: 60,
    shadowFar: 190,
    env: true,
    detail: 'high',
    avatarDetail: 'high',
    effects: 1,
    particles: 1,
    fog: [110, 560],
    drawDistance: 560,
    props: 96,
    clouds: 2,
    exposure: 1.06,
    rim: 0.55,
    fill: 0.18,
    interior: 22,
    post: ['vignette', 'glow'],
    anisotropy: 8,
  },
  ultra: {
    id: 'ultra',
    label: 'ULTRA',
    blurb: 'Very high: 4K shadows, dense world, glow + grain.',
    pixelCap: 2.5,
    minScale: 0.7,
    antialias: true,
    shadows: true,
    shadowSize: 4096,
    shadowSoft: true,
    shadowRadius: 78,
    shadowFar: 240,
    env: true,
    detail: 'ultra',
    avatarDetail: 'ultra',
    effects: 1.5,
    particles: 1.5,
    fog: [150, 760],
    drawDistance: 760,
    props: 124,
    clouds: 3,
    exposure: 1.15,
    rim: 0.95,
    fill: 0.3,
    interior: 26,
    post: ['vignette', 'glow', 'grain', 'flare'],
    anisotropy: 16,
  },
};

/** Anything unknown resolves to `medium` — never to a crash. */
export function tier(id) {
  return TIERS[id] || TIERS.medium;
}

export const isKnownQuality = (id) => Object.prototype.hasOwnProperty.call(TIERS, id);

/**
 * The auto-detect. `choice` is what the player picked in the lobby:
 * 'auto' or a tier id. Coarse pointer + a small screen or few cores means a
 * phone that should not be handed 4K shadows.
 */
export function resolveQuality({ choice = 'auto', coarse = false, smallest = 1280, cores = 8 } = {}) {
  const picked = String(choice || 'auto').toLowerCase();
  if (isKnownQuality(picked)) return picked;
  // Only genuinely weak hardware drops to LOW. A 2022 phone (8 cores, 390 px
  // wide) has no trouble with 1K shadows and dips to MEDIUM, which is what it
  // now gets instead of the old "any phone under 640 px is low" rule.
  const lowEnd = Boolean(coarse && (cores <= 3 || smallest < 360));
  if (lowEnd) return 'low';
  if (coarse) return 'medium';
  // a desktop with plenty of cores can carry ultra by default? No: opt-in only,
  // because a weak integrated GPU would stutter before the governor catches up.
  return 'high';
}

/** The CSS class that turns the screen-space post layer on: `q-low` … `q-ultra`. */
export const postClass = (id) => `q-${isKnownQuality(id) ? id : 'medium'}`;

/** Applies the tier's screen-space effects to a root element (the <html>). */
export function applyPostClass(root, id) {
  try {
    if (!root?.classList) return;
    for (const name of QUALITY_ORDER) root.classList.remove(`q-${name}`);
    root.classList.add(postClass(id));
  } catch { /* detached root */ }
}

/** Human line for the settings card, e.g. "ULTRA — 4K shadows · 760 m view". */
export function describeTier(id) {
  const t = tier(id);
  const bits = [];
  if (t.shadows) bits.push(`${t.shadowSize >= 4096 ? '4K' : t.shadowSize >= 2048 ? '2K' : '1K'} shadows`);
  else bits.push('no shadows');
  bits.push(`${t.drawDistance} m view`);
  if (t.env) bits.push('PBR reflections');
  if (t.post.includes('glow')) bits.push('glow');
  if (t.post.includes('grain')) bits.push('grain');
  return bits.join(' · ');
}

/** Every tier as a list, for building the settings buttons. */
export const tierList = () => QUALITY_ORDER.map((id) => TIERS[id]);
