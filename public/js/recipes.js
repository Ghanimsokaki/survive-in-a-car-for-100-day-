/**
 * The crafting tree: 17 hand-authored staples + 1000 procedurally generated
 * recipes, all driven by the same generic `effect` shape so the workbench can
 * render and resolve any of them without a switch statement per recipe.
 *
 * Generated recipes are deterministic (seeded PRNG), so recipe #512 is the same
 * recipe on every device and every reload.
 */
import { mulberry32 } from './utils.js';

/* ------------------------------------------------------------------ staplers
 * The original hand-tuned list. `effect` mirrors the generated ones; the old
 * fields (weapon / upgrade) are kept so nothing else has to change.
 */
export const RECIPES = [
  { id: 'pipe', name: 'SCRAP PIPE BAT', tab: 'weapons', tier: 1, tierReq: 1, cost: { scrap: 4 }, desc: '20 DMG · 80 DUR · heavy pipe swung by hand.', weapon: 'pipe', unique: true },
  { id: 'revolver', name: 'SCAVENGED REVOLVER', tab: 'weapons', tier: 2, tierReq: 2, cost: { steel: 3, scrap: 2, chem: 1 }, desc: '34 DMG · 90 DUR · hitscan sidearm, 48m reach.', weapon: 'revolver', unique: true },
  { id: 'machete', name: 'SCRAP METAL MACHETE', tab: 'weapons', tier: 2, tierReq: 2, cost: { scrap: 5, steel: 2, leather: 1 }, desc: '35 DMG · 100 DUR · fast cuts.', weapon: 'machete', unique: true },
  { id: 'katana', name: 'LEAF SPRING KATANA', tab: 'weapons', tier: 3, tierReq: 3, cost: { carbon: 5, steel: 3, leather: 1 }, desc: '55 DMG · 180 DUR · forged from truck suspension steel. 28% crit.', weapon: 'katana', unique: true },
  { id: 'broadsword', name: 'DAMASCUS SCRAP BROADSWORD', tab: 'weapons', tier: 4, tierReq: 4, cost: { titanium: 6, carbon: 3, cores: 2 }, desc: '120 DMG · 350 DUR · armour-piercing legend.', weapon: 'broadsword', unique: true },

  { id: 'fuelcan', name: 'SIPHON FUEL CAN', tab: 'repairs', tier: 1, cost: { chem: 1, scrap: 1 }, desc: 'Refine chemicals into +12L of usable fuel.', effect: { type: 'fuel', amount: 12 } },
  { id: 'superfuel', name: 'SUPER FUEL BATCH', tab: 'repairs', tier: 2, tierReq: 2, cost: { chem: 3, scrap: 2 }, desc: '+26L of high-grade fuel for the long haul.', effect: { type: 'fuel', amount: 26 } },
  { id: 'repairkit', name: 'FIELD REPAIR KIT', tab: 'repairs', tier: 1, cost: { steel: 2, leather: 1 }, desc: 'Patch the chassis and engine (+30 each).', effect: { type: 'repair', chassis: 30, engine: 30 } },
  { id: 'tirepatch', name: 'TIRE PATCH KIT', tab: 'repairs', tier: 1, cost: { leather: 2, scrap: 1 }, desc: 'Re-tread the rubber (+35 tire tread).', effect: { type: 'tires', amount: 35 } },
  { id: 'fullfix', name: 'FULL RIG OVERHAUL', tab: 'repairs', tier: 3, tierReq: 3, cost: { steel: 4, titanium: 2, leather: 2 }, desc: 'Engine, chassis and tires back to 100%.', effect: { type: 'repair', chassis: 100, engine: 100, tires: 100 } },

  { id: 'armor', name: 'REINFORCED ARMOR PLATING', tab: 'upgrades', tier: 2, tierReq: 1, cost: { steel: 4, titanium: 1 }, desc: 'Welded hull plates. Absorbs 28% of impact damage. Stacks ×3.', upgrade: 'armor' },
  { id: 'anchors', name: 'HYDRAULIC ANCHOR SPIKE SET', tab: 'upgrades', tier: 2, tierReq: 1, cost: { steel: 3, titanium: 2 }, desc: 'Deeper spikes, stronger hold. Negates tornado lift. Max tier 4.', upgrade: 'anchors' },
  { id: 'bench2', name: 'MOBILE WELDING RIG', tab: 'upgrades', tier: 2, cost: { steel: 5, carbon: 2 }, desc: 'Upgrade the car workbench to Tier 2.', upgrade: 'bench' },
  { id: 'bench3', name: 'HYDRAULIC PRESS BAY', tab: 'upgrades', tier: 3, tierReq: 2, cost: { steel: 6, titanium: 3 }, desc: 'Upgrade the car workbench to Tier 3.', upgrade: 'bench' },
  { id: 'bench4', name: 'TITANIUM FORGE', tab: 'upgrades', tier: 4, tierReq: 3, cost: { titanium: 5, cores: 1 }, desc: 'Upgrade the car workbench to Tier 4.', upgrade: 'bench' },
];

/* ------------------------------------------------------------- generators */
const ADJ = [
  'RUSTED', 'REINFORCED', 'SALVAGED', 'IMPROVISED', 'SCORCHED', 'CHROME', 'MILITARY', 'NOMAD',
  'CONVOY', 'JUNKYARD', 'PRECISION', 'HEAVY', 'LIGHTWEIGHT', 'ANODIZED', 'WELDED', 'TEMPEST',
  'RAIDER', 'WANDERER', 'OVERTUNED', 'BONE', 'ASH', 'TITAN', 'STORM', 'DESERT', 'FROST',
  'HYDRAULIC', 'SPIKED', 'ARMORED', 'SERRATED', 'BALANCED', 'TUNED', 'CRUDE', 'GILDED',
];
const NOUN = {
  weapons: ['PIPE', 'MACHETE', 'KATANA', 'BLADE', 'SPIKE BAT', 'CLEAVER', 'HATCHET', 'SPEAR', 'SAW', 'KNUCKLES', 'STUN ROD', 'CHAIN FLAIL', 'GUISARME', 'SHIV'],
  repairs: ['FUEL CAN', 'SIPHON KIT', 'REPAIR PATCH', 'TREAD KIT', 'COOLANT', 'SEALANT', 'WELD KIT', 'TOOL ROLL', 'OIL DRUM'],
  upgrades: ['HULL PLATE', 'ANCHOR SET', 'SUSPENSION', 'TURBO', 'INTAKE', 'ROLL CAGE', 'SPIKE BUMPER', 'FUEL CELL', 'SCAVENGER RIG', 'COOLING RIG'],
  gear: ['TOOLBOX', 'BATTERY', 'WIRING LOOM', 'AMMO CRATE', 'BLUEPRINT FOLDER', 'SIGNAL BOX', 'MED POUCH', 'LOCKPICK SET', 'RANGEFINDER'],
  consumables: ['MEDKIT', 'RATION PACK', 'FLARE BUNDLE', 'STIM SHOT', 'FIELD BANDAGE', 'WATER CAN', 'FUEL CAN', 'ANTISEPTIC'],
};
const SUFFIX = ['', '', '', ' MK2', ' MK3', ' MK4', ' · FIELD', ' · PROTOTYPE', ' · APEX', ' · RUST', ' · STORM'];
const TAB_CYCLE = ['weapons', 'repairs', 'upgrades', 'gear', 'consumables'];
const COSTS = [
  null,
  { scrap: 3 }, { scrap: 5 }, { steel: 2, scrap: 3 }, { leather: 2, scrap: 2 }, { chem: 2, scrap: 3 },
  { steel: 3, carbon: 1 }, { titanium: 1, steel: 2 }, { carbon: 2, chem: 1 }, { titanium: 2, carbon: 1 },
  { cores: 1, titanium: 2 }, { cores: 2, titanium: 3, carbon: 2 },
];

const PERKS = [
  { perk: 'maxhp', amount: 8, label: '+8 MAX HP' },
  { perk: 'maxfuel', amount: 6, label: '+6 L TANK' },
  { perk: 'armor', amount: 0.02, label: '+2% DAMAGE RESIST' },
  { perk: 'dmg', amount: 0.05, label: '+5% WEAPON DAMAGE' },
  { perk: 'scav', amount: 0.06, label: '+6% SCAVENGE YIELD' },
  { perk: 'magnet', amount: 0.25, label: '+0.25 M PICKUP RANGE' },
];

const GIVE_POOL = ['medkit', 'bandage', 'fuelcan', 'jerrycan', 'repairkit', 'tirepatch', 'flare', 'ration', 'battery', 'ammo', 'blueprint', 'dogtag', 'wire', 'cloth'];

function describe(r) {
  if (r.effect?.type === 'give') return `${r.effect.qty}× ${r.effect.item.replace(/_/g, ' ').toUpperCase()} to your pack.`;
  if (r.effect?.type === 'fuel') return `Refined fuel: +${r.effect.amount} L.`;
  if (r.effect?.type === 'repair') return `Repairs the rig on the spot.`;
  if (r.effect?.type === 'tires') return `Re-treads the rubber: +${r.effect.amount} tread.`;
  if (r.effect?.type === 'perk') return `Permanent upgrade: ${r.perkLabel}.`;
  return '';
}

/** Builds the 1000 generated recipes. */
function generate(count = 1000) {
  const rng = mulberry32(0x5eed1e);
  const out = [];
  const seen = new Set(RECIPES.map((r) => r.name));
  for (let i = 0; i < count; i++) {
    const tab = TAB_CYCLE[i % TAB_CYCLE.length];
    const tier = 1 + Math.floor(rng() * 4);
    const tierReq = Math.max(1, Math.min(4, tier - (rng() < 0.35 ? 1 : 0)));
    const cost = { ...COSTS[Math.min(COSTS.length - 1, 1 + Math.floor(rng() * 9) + (tier - 1) * 2)] };
    const adj = ADJ[Math.floor(rng() * ADJ.length)];
    const noun = NOUN[tab][Math.floor(rng() * NOUN[tab].length)];
    const suffix = SUFFIX[Math.floor(rng() * SUFFIX.length)];
    let name = `${adj} ${noun}${suffix}`;
    if (seen.has(name)) name = `${name} #${i + 1}`;
    seen.add(name);

    const r = {
      id: `gen-${String(i + 1).padStart(4, '0')}`,
      name,
      tab,
      tier,
      tierReq,
      cost,
      gen: true,
    };

    if (tab === 'weapons') {
      const p = PERKS[3 + Math.floor(rng() * 3)] || PERKS[3];
      const perk = p.perk === 'magnet' ? PERKS[3] : p;
      r.effect = { type: 'perk', perk: perk.perk, amount: perk.amount };
      r.perkLabel = perk.label;
    } else if (tab === 'repairs') {
      const roll = rng();
      if (roll < 0.34) r.effect = { type: 'fuel', amount: 8 + Math.floor(rng() * 26) + tier * 2 };
      else if (roll < 0.68) r.effect = { type: 'repair', chassis: 15 + Math.floor(rng() * 35) + tier * 5, engine: 10 + Math.floor(rng() * 25) };
      else r.effect = { type: 'tires', amount: 12 + Math.floor(rng() * 40) };
    } else if (tab === 'upgrades') {
      const p = PERKS[Math.floor(rng() * PERKS.length)];
      r.effect = { type: 'perk', perk: p.perk, amount: p.amount };
      r.perkLabel = p.label;
    } else if (tab === 'gear') {
      const item = GIVE_POOL[Math.floor(rng() * GIVE_POOL.length)];
      r.effect = { type: 'give', item, qty: 1 + Math.floor(rng() * 3) };
    } else {
      const item = ['medkit', 'bandage', 'fuelcan', 'jerrycan', 'flare', 'ration', 'repairkit', 'tirepatch'][Math.floor(rng() * 8)];
      r.effect = { type: 'give', item, qty: 1 + Math.floor(rng() * 2) };
    }
    r.desc = describe(r);
    out.push(r);
  }
  return out;
}

export const GENERATED_RECIPES = generate(1000);
export const ALL_RECIPES = [...RECIPES, ...GENERATED_RECIPES];
export const RECIPE_COUNT = { base: RECIPES.length, generated: GENERATED_RECIPES.length, total: ALL_RECIPES.length };

const BY_ID = new Map(ALL_RECIPES.map((r) => [r.id, r]));
export const findRecipe = (id) => BY_ID.get(id) || null;

export const TABS = [
  { id: 'weapons', label: 'WEAPONS' },
  { id: 'repairs', label: 'REPAIRS & FUEL' },
  { id: 'upgrades', label: 'RIG UPGRADES' },
  { id: 'gear', label: 'GEAR' },
  { id: 'consumables', label: 'CONSUMABLES' },
];
