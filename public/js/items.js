/**
 * Item catalogue.
 *
 * Two families live here:
 *   · materials  → feed the workbench (scrap, steel, titanium, carbon, leather, chem, cores)
 *   · items      → physical things you carry: medkits, fuel cans, repair kits, flares…
 *
 * Nothing is handed to the player any more: scavenging *scatters* stacks in the
 * world (see loot.js) and you have to walk over them to collect them.
 */

export const MATERIALS = ['scrap', 'steel', 'titanium', 'carbon', 'leather', 'chem', 'cores'];

export const ITEMS = {
  // ------------------------------------------------------------- materials
  scrap: { name: 'SCRAP METAL', kind: 'material', glyph: '▰', color: 0xb9a07a, stack: 999, rarity: 1 },
  steel: { name: 'STEEL PLATE', kind: 'material', glyph: '▤', color: 0x9aa6b4, stack: 999, rarity: 2 },
  titanium: { name: 'TITANIUM', kind: 'material', glyph: '◆', color: 0xbfe6ff, stack: 999, rarity: 3 },
  carbon: { name: 'CARBON', kind: 'material', glyph: '▲', color: 0x6f7a86, stack: 999, rarity: 3 },
  leather: { name: 'LEATHER', kind: 'material', glyph: '❏', color: 0x9c6b3f, stack: 999, rarity: 1 },
  chem: { name: 'CHEMICALS', kind: 'material', glyph: '☣', color: 0x9dff8a, stack: 999, rarity: 2 },
  cores: { name: 'SWORD CORE', kind: 'material', glyph: '⬢', color: 0xffcf6b, stack: 99, rarity: 4 },

  // ------------------------------------------------------------ consumables
  medkit: {
    name: 'FIELD MEDKIT', kind: 'consumable', glyph: '✚', color: 0xff6b7a, stack: 9, rarity: 2,
    use: { heal: 35 }, desc: 'Stitch yourself up: +35 HP.',
  },
  bandage: {
    name: 'GAUZE ROLL', kind: 'consumable', glyph: '✚', color: 0xffa2ac, stack: 12, rarity: 1,
    use: { heal: 12 }, desc: 'Quick patch: +12 HP.',
  },
  fuelcan: {
    name: 'FUEL CAN', kind: 'consumable', glyph: '⛽', color: 0xffb347, stack: 6, rarity: 2,
    use: { fuel: 12 }, desc: 'Siphon 12 L into the tank.',
  },
  jerrycan: {
    name: 'JERRY CAN', kind: 'consumable', glyph: '⛽', color: 0xffd166, stack: 3, rarity: 3,
    use: { fuel: 30 }, desc: 'A full 30 L of high-grade fuel.',
  },
  repairkit: {
    name: 'REPAIR KIT', kind: 'consumable', glyph: '🛠', color: 0x8fd0ff, stack: 5, rarity: 2,
    use: { chassis: 30, engine: 25 }, desc: '+30 chassis, +25 engine.',
  },
  tirepatch: {
    name: 'TIRE PATCH', kind: 'consumable', glyph: '◍', color: 0xc9a0ff, stack: 6, rarity: 1,
    use: { tires: 35 }, desc: 'Re-tread the rubber: +35 tires.',
  },
  flare: {
    name: 'ROAD FLARE', kind: 'consumable', glyph: '✦', color: 0xff7b3c, stack: 9, rarity: 1,
    use: { light: 1 }, desc: 'Burn a bright marker for 20 s.',
  },
  ration: {
    name: 'CANNED RATION', kind: 'consumable', glyph: '▣', color: 0xd7c48a, stack: 9, rarity: 1,
    use: { heal: 15, stamina: 1 }, desc: 'Eat: +15 HP and a burst of energy.',
  },

  // ------------------------------------------------------------------ gear
  battery: { name: 'CAR BATTERY', kind: 'gear', glyph: '▮', color: 0xffe066, stack: 4, rarity: 2, desc: 'Trades for a workbench tier.' },
  wire: { name: 'COPPER WIRE', kind: 'gear', glyph: '∿', color: 0xd08b4a, stack: 30, rarity: 1 },
  cloth: { name: 'RAG CLOTH', kind: 'gear', glyph: '▨', color: 0xa9b2a0, stack: 30, rarity: 1 },
  ammo: { name: 'AMMO BOX', kind: 'gear', glyph: '▦', color: 0xc7a34a, stack: 20, rarity: 2 },
  blueprint: { name: 'BLUEPRINT', kind: 'gear', glyph: '▧', color: 0x8fd0ff, stack: 10, rarity: 3, desc: 'Unlocks a random recipe tier.' },
  dogtag: { name: 'DOGTAG', kind: 'gear', glyph: '⚑', color: 0xc8cdd6, stack: 20, rarity: 2 },
  convoypass: { name: 'CONVOY PASS', kind: 'gear', glyph: '❖', color: 0xffcf6b, stack: 5, rarity: 4, desc: 'Owner-grade salvage token.' },
};

export const MATERIAL_NAMES = {
  scrap: 'SCRAP METAL', steel: 'STEEL PLATES', titanium: 'TITANIUM ALLOY',
  carbon: 'HIGH-CARBON STEEL', leather: 'LEATHER STRAPS', chem: 'CHEM COMPOUNDS',
  cores: 'SWORD CORES', fuel: 'FUEL',
};

export const itemName = (id) => ITEMS[id]?.name || String(id).toUpperCase();
export const itemKind = (id) => ITEMS[id]?.kind || 'gear';
export const itemGlyph = (id) => ITEMS[id]?.glyph || '▪';
export const itemColor = (id) => ITEMS[id]?.color ?? 0xb9a07a;
export const isMaterial = (id) => MATERIALS.includes(id);
export const isUsable = (id) => Boolean(ITEMS[id]?.use);

/** Weighted pick that stays deterministic when handed a seeded rng. */
export function weighted(rng, pairs) {
  const total = pairs.reduce((a, [, w]) => a + w, 0);
  let roll = rng() * total;
  for (const [value, weight] of pairs) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return pairs[pairs.length - 1][0];
}

const COMMON = [
  ['scrap', 34], ['leather', 12], ['cloth', 9], ['wire', 8], ['chem', 7], ['bandage', 8],
  ['steel', 6], ['ammo', 5], ['tirepatch', 4], ['ration', 5], ['fuelcan', 4], ['flare', 3],
];
const RARE = [
  ['steel', 16], ['chem', 12], ['carbon', 8], ['titanium', 6], ['medkit', 6], ['repairkit', 5],
  ['battery', 4], ['jerrycan', 3], ['blueprint', 2], ['dogtag', 4], ['cores', 1],
];

/**
 * Rolls a scavenge haul.
 * @param {() => number} rng
 * @param {{zone?:number, kind?:string, lootMult?:number, inside?:boolean, rolls?:number}} opts
 * @returns {{id:string, qty:number}[]}
 */
export function rollLoot(rng = Math.random, { zone = 0, kind = '', lootMult = 1, inside = false, rolls = 3 } = {}) {
  const n = Math.max(2, Math.round((rolls + (inside ? 1 : 0)) * Math.min(1.8, lootMult)));
  const out = new Map();
  for (let i = 0; i < n; i++) {
    const table = rng() < 0.26 + zone * 0.06 ? RARE : COMMON;
    const id = weighted(rng, table);
    const base = MATERIALS.includes(id) ? 2 : 1;
    const qty = Math.max(1, Math.round((base + Math.floor(rng() * 3)) * (0.7 + lootMult * 0.3)));
    out.set(id, (out.get(id) || 0) + qty);
  }
  // a garage/warehouse always pays a little fuel out
  if (kind === 'garage' || kind === 'depot' || kind === 'gas') out.set('fuelcan', (out.get('fuelcan') || 0) + 1);
  // corpses are a different table: what a survivor was carrying when they went down
  if (kind === 'hollow') {
    out.set('dogtag', (out.get('dogtag') || 0) + 1);
    if (rng() < 0.45) out.set('bandage', (out.get('bandage') || 0) + 1);
    if (rng() < 0.2) out.set('medkit', (out.get('medkit') || 0) + 1);
  }
  if (kind === 'raider') {
    out.set('ammo', (out.get('ammo') || 0) + 2);
    if (rng() < 0.5) out.set('fuelcan', (out.get('fuelcan') || 0) + 1);
    if (rng() < 0.35) out.set('repairkit', (out.get('repairkit') || 0) + 1);
    if (rng() < 0.25) out.set('tirepatch', (out.get('tirepatch') || 0) + 1);
  }
  if (kind === 'boss') {
    out.set('cores', (out.get('cores') || 0) + 1);
    out.set('blueprint', (out.get('blueprint') || 0) + 1);
    out.set('titanium', (out.get('titanium') || 0) + 2);
  }
  return [...out].map(([id, qty]) => ({ id, qty }));
}
