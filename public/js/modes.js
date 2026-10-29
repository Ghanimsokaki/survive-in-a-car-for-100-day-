/**
 * Game modes — several "games inside the game".
 *
 * Every mode runs the same survival engine; what changes is the shape of the
 * run: how long the road is, how much fuel you start with, how hard the storms
 * and raiders hit, and how much loot pays out. `targetDay` is the finish line:
 * reach it alive and you win (a 100-day classic, a 12-day siege, a 25-day fuel
 * run…), so the existing day loop drives every mode without special-casing.
 */
export const MODES = [
  {
    id: 'classic',
    spawnRate: 1.0,
    name: '100 DAYS',
    sub: 'THE ORIGINAL RUN',
    blurb: 'One rig, one highway, a hundred days of storms. Reach day 100 alive.',
    icon: '🌪',
    accent: '#ffb347',
    targetDay: 100,
    finalSeconds: 120,
    startFuel: 20,
    startBench: 1,
    dayLength: 95,
    lootMult: 1,
    stormMult: 1,
    raiderMult: 1,
    hollowMult: 1,
    tags: ['100 DAYS', 'STORMS'],
  },
  {
    id: 'endless',
    spawnRate: 1.1,
    name: 'ENDLESS ROAD',
    sub: 'NO FINISH LINE',
    blurb: 'The highway never ends. Only your best day count matters — how far can you push it?',
    icon: '♾',
    accent: '#8fd0ff',
    targetDay: Infinity,
    finalSeconds: 0,
    startFuel: 24,
    startBench: 1,
    dayLength: 95,
    lootMult: 1.05,
    stormMult: 1.15,
    raiderMult: 1.1,
    hollowMult: 1.05,
    tags: ['SCORE RUN', 'ESCALATING'],
  },
  {
    id: 'siege',
    spawnRate: 1.5,
    name: 'SIEGE',
    sub: '12 DAYS OF RAIDERS',
    blurb: 'Raider rigs hunt you from day one. Hold the hull together for twelve days.',
    icon: '⚔',
    accent: '#ff6d7b',
    targetDay: 12,
    finalSeconds: 30,
    startFuel: 30,
    startBench: 2,
    dayLength: 80,
    lootMult: 1.35,
    stormMult: 0.7,
    raiderMult: 2.6,
    hollowMult: 1.7,
    tags: ['COMBAT', 'SHORT'],
  },
  {
    id: 'sprint',
    spawnRate: 1.2,
    name: 'FUEL RUN',
    sub: '25 DAYS · DRY TANK START',
    blurb: 'You start nearly dry and the days are short. Scavenge fast, keep moving.',
    icon: '⛽',
    accent: '#ffd166',
    targetDay: 25,
    finalSeconds: 45,
    startFuel: 9,
    startBench: 1,
    dayLength: 62,
    lootMult: 1.4,
    stormMult: 0.85,
    raiderMult: 0.9,
    hollowMult: 1,
    tags: ['ECONOMY', 'FAST'],
  },
  {
    id: 'hypercane',
    spawnRate: 1.15,
    name: 'STORM CHASER',
    sub: '40 DAYS · CAT 5',
    blurb: 'Hypercanes every other day and double loot in the wreckage. Anchor or die.',
    icon: '🌀',
    accent: '#c9a0ff',
    targetDay: 40,
    finalSeconds: 60,
    startFuel: 26,
    startBench: 2,
    dayLength: 85,
    lootMult: 1.65,
    stormMult: 2.5,
    raiderMult: 1.1,
    hollowMult: 1.2,
    tags: ['STORMS', 'LOOT'],
  },
];

export const DEFAULT_MODE = 'classic';

/** Never throws: an unknown id (old save, bad URL) falls back to the classic run. */
export function modeById(id) {
  const key = String(id || '').toLowerCase();
  return MODES.find((m) => m.id === key) || MODES[0];
}

/** The finish line for the HUD: "DAY 12" for a siege, "ENDLESS" when there is none. */
export function goalLabel(mode) {
  return Number.isFinite(mode?.targetDay) ? `${mode.targetDay}` : '∞';
}
