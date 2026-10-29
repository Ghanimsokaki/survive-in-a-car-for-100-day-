/**
 * Survivor customisation catalogue.
 *
 * Everything the avatar can change lives here so the lobby UI, the preview rig
 * and the in-game model all read the same list. Colours are plain hex ints (the
 * game deals in ints); the UI converts to CSS with `#rrggbb`.
 */

export const SKIN_TONES = [
  { id: 'porcelain', hex: 0xf2d2bb, label: 'PORCELAIN' },
  { id: 'sand', hex: 0xe4b58f, label: 'SAND' },
  { id: 'tan', hex: 0xc98d6b, label: 'TAN' },
  { id: 'bronze', hex: 0xa96f4d, label: 'BRONZE' },
  { id: 'umber', hex: 0x8a5638, label: 'UMBER' },
  { id: 'cocoa', hex: 0x6a3f28, label: 'COCOA' },
  { id: 'ebony', hex: 0x4a2a1b, label: 'EBONY' },
  { id: 'ash', hex: 0x9aa0a6, label: 'ASH GREY' },
];

export const OUTFIT_COLORS = [
  { id: 'rust', hex: 0xd24a2b, label: 'RUST' },
  { id: 'amber', hex: 0xffb347, label: 'AMBER' },
  { id: 'olive', hex: 0x6f7f45, label: 'OLIVE' },
  { id: 'teal', hex: 0x2f8f8a, label: 'TEAL' },
  { id: 'cyan', hex: 0x5ff0ff, label: 'CYAN' },
  { id: 'indigo', hex: 0x4b5ea8, label: 'INDIGO' },
  { id: 'violet', hex: 0x8d5ec8, label: 'VIOLET' },
  { id: 'crimson', hex: 0xa32338, label: 'CRIMSON' },
  { id: 'bone', hex: 0xd8d2c4, label: 'BONE' },
  { id: 'charcoal', hex: 0x2b3140, label: 'CHARCOAL' },
];

export const HAIR_STYLES = [
  { id: 'none', label: 'NONE', icon: '◌' },
  { id: 'cap', label: 'CAP', icon: '🧢' },
  { id: 'beanie', label: 'BEANIE', icon: '🎿' },
  { id: 'hood', label: 'HOOD', icon: '🧥' },
  { id: 'helmet', label: 'HELMET', icon: '⛑' },
  { id: 'mohawk', label: 'MOHAWK', icon: '⚡' },
  { id: 'ponytail', label: 'PONYTAIL', icon: '🎀' },
  { id: 'buzz', label: 'BUZZ', icon: '▮' },
];

export const HAIR_COLORS = [
  { id: 'black', hex: 0x1b1d22, label: 'BLACK' },
  { id: 'brown', hex: 0x4a3220, label: 'BROWN' },
  { id: 'ginger', hex: 0xa85a2a, label: 'GINGER' },
  { id: 'blonde', hex: 0xd9bc7a, label: 'BLONDE' },
  { id: 'grey', hex: 0x9aa1a8, label: 'GREY' },
  { id: 'white', hex: 0xe6e9ee, label: 'WHITE' },
  { id: 'acid', hex: 0x9dff6b, label: 'ACID' },
  { id: 'tie', hex: 0xff5ba8, label: 'HOT PINK' },
];

export const ACCESSORIES = [
  { id: 'none', label: 'NONE', icon: '◌' },
  { id: 'backpack', label: 'BACKPACK', icon: '🎒' },
  { id: 'lamp', label: 'SHOULDER LAMP', icon: '🔦' },
  { id: 'bandana', label: 'BANDANA', icon: '🪢' },
  { id: 'spikes', label: 'SHOULDER SPIKES', icon: '🦔' },
  { id: 'medkit', label: 'MED POUCH', icon: '✚' },
];

export const DEFAULT_CUSTOM = {
  skin: 'tan',
  outfit: 'charcoal',
  hair: 'cap',
  hairColor: 'black',
  accessory: 'lamp',
  height: 1,      // 0.9 – 1.1
  build: 1,       // 0.85 – 1.15
};

const byId = (list, id) => list.find((x) => x.id === id) || list[0];
export const skinHex = (id) => byId(SKIN_TONES, id).hex;
export const outfitHex = (id) => byId(OUTFIT_COLORS, id).hex;
export const hairHex = (id) => byId(HAIR_COLORS, id).hex;

const clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Accepts anything (old saves, half-typed JSON, a profile row) and returns a
 * complete, valid customisation. Never throws.
 */
export function normalizeCustom(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const pick = (list, id, fallback) => (list.some((x) => x.id === id) ? id : fallback);
  return {
    skin: pick(SKIN_TONES, raw.skin, DEFAULT_CUSTOM.skin),
    outfit: pick(OUTFIT_COLORS, raw.outfit, DEFAULT_CUSTOM.outfit),
    hair: pick(HAIR_STYLES, raw.hair, DEFAULT_CUSTOM.hair),
    hairColor: pick(HAIR_COLORS, raw.hairColor, DEFAULT_CUSTOM.hairColor),
    accessory: pick(ACCESSORIES, raw.accessory, DEFAULT_CUSTOM.accessory),
    height: clampNum(raw.height, 0.9, 1.1, DEFAULT_CUSTOM.height),
    build: clampNum(raw.build, 0.85, 1.15, DEFAULT_CUSTOM.build),
  };
}

/** Resolved values the avatar model needs (hex ints + labels). */
export function resolveCustom(input) {
  const c = normalizeCustom(input);
  return {
    ...c,
    skinHex: skinHex(c.skin),
    outfitHex: outfitHex(c.outfit),
    hairHex: hairHex(c.hairColor),
    hairLabel: byId(HAIR_STYLES, c.hair).label,
    accessoryLabel: byId(ACCESSORIES, c.accessory).label,
  };
}

/** Short human summary for the lobby chip. */
export function describeCustom(input) {
  const c = resolveCustom(input);
  return [c.hairLabel, c.accessoryLabel].filter((s) => s && s !== 'NONE').join(' · ') || 'PLAIN KIT';
}
