/**
 * IRON TIDE — fleet rules.
 *
 * A classic script (no modules: the game runs sandboxed with an opaque origin,
 * where module fetches are cross-origin) that puts the whole economy on
 * `window.FleetRules`. Everything here is pure so the hub's test suite can
 * import it under Node and check the balance without a canvas.
 */
(function (root) {
  'use strict';

  /* --------------------------------------------------------------- hulls
   * `slots` is how many weapons fit; `turrets` how many fire per broadside.
   * Bigger hulls carry more, turn slower, and cost a lot more credits.
   */
  const HULLS = [
    { id: 'skiff', name: 'SKIFF', hp: 120, speed: 1.35, slots: 2, turrets: 1, length: 34, cost: 0, blurb: 'Free starter boat. Fast, fragile, one gun.' },
    { id: 'corvette', name: 'CORVETTE', hp: 240, speed: 1.15, slots: 4, turrets: 2, length: 46, cost: 900, blurb: 'The workhorse. Two turrets, room to grow.' },
    { id: 'destroyer', name: 'DESTROYER', hp: 420, speed: 0.95, slots: 6, turrets: 3, length: 60, cost: 2600, blurb: 'Three turrets, deep magazines, slow to turn.' },
    { id: 'carrier', name: 'CARRIER', hp: 620, speed: 0.78, slots: 5, turrets: 2, length: 78, cost: 5200, blurb: 'Launches jets. Two turrets, but the deck is the weapon.' },
  ];

  /* ------------------------------------------------------------- weapons */
  const MODULES = [
    { id: 'light-cannon', name: 'LIGHT CANNON', kind: 'gun', cost: 120, dmg: 16, rate: 1.1, range: 300, blurb: 'Fast, cheap, reliable.' },
    { id: 'heavy-cannon', name: 'HEAVY CANNON', kind: 'gun', cost: 340, dmg: 42, rate: 0.42, range: 360, blurb: 'Slow reload, hits like a hammer.' },
    { id: 'torpedo', name: 'TORPEDO TUBES', kind: 'torpedo', cost: 420, dmg: 120, rate: 0.18, range: 460, blurb: 'Slow, unguided, devastating at range.' },
    { id: 'flak', name: 'FLAK BATTERY', kind: 'aa', cost: 260, dmg: 6, rate: 2.2, range: 280, blurb: 'Shreds incoming jets and aircraft.' },
    { id: 'armour', name: 'ARMOUR BELT', kind: 'armour', cost: 300, hp: 90, blurb: 'Welded plate. +90 hull.' },
    { id: 'engine', name: 'TUNED ENGINE', kind: 'engine', cost: 280, speed: 0.22, blurb: '+0.22 speed, quicker turns.' },
  ];

  /* ---------------------------------------------------------------- jets
   * Bought at the dock, kept in the hangar, launched during battle. Only a
   * carrier can sortie more than one at a time.
   */
  const JETS = [
    { id: 'scout', name: 'SPARROW SCOUT', cost: 260, dmg: 14, cooldown: 7, sorties: 3, blurb: 'Cheap recon pass. Harasses, never finishes.' },
    { id: 'interceptor', name: 'HALBERD INTERCEPTOR', cost: 720, dmg: 32, cooldown: 9, sorties: 3, blurb: 'The default strike package.' },
    { id: 'bomber', name: 'ANVIL BOMBER', cost: 1400, dmg: 68, cooldown: 14, sorties: 2, blurb: 'Two passes, big holes. Needs a carrier to shine.' },
    { id: 'gunship', name: 'VULTURE GUNSHIP', cost: 2100, dmg: 46, cooldown: 8, sorties: 4, blurb: 'Rotary cannon. Best sustained damage in the air.' },
  ];

  const STARTING_CREDITS = 600;

  const byId = (list, id) => list.find((x) => x.id === id) || null;

  /** Credits for a hull upgrade, or 0 if you already own it or cannot afford it. */
  function hullCost(hullId) {
    const hull = byId(HULLS, hullId);
    return hull ? hull.cost : Infinity;
  }

  /** Sum of the module prices, allowing duplicates (two light cannons, etc.). */
  function modulesCost(modules) {
    return (modules || []).reduce((sum, id) => sum + (byId(MODULES, id)?.cost || 0), 0);
  }

  /**
   * Turns a hull + module list into the numbers the battle sim uses.
   * `slots` is enforced here: extras beyond the hull are ignored, not charged.
   */
  function computeLoadout({ hull = 'skiff', modules = [] } = {}) {
    const base = byId(HULLS, hull) || HULLS[0];
    const fitted = [];
    const ignored = [];
    for (const id of modules || []) {
      const mod = byId(MODULES, id);
      if (!mod) { ignored.push(id); continue; }
      if (fitted.length >= base.slots) { ignored.push(id); continue; }
      fitted.push(mod);
    }

    const guns = fitted.filter((m) => m.kind === 'gun');
    const torpedoes = fitted.filter((m) => m.kind === 'torpedo');
    const flak = fitted.filter((m) => m.kind === 'aa');
    const armour = fitted.filter((m) => m.kind === 'armour');
    const engines = fitted.filter((m) => m.kind === 'engine');

    const weapons = [...guns, ...torpedoes];
    const dps = weapons.reduce((sum, m) => sum + m.dmg * m.rate, 0);
    // The battle sim fires one volley per reload: `shot` is the mean damage of a
    // shell and `reload` keeps turrets × shot / reload === the advertised dps.
    const rateSum = weapons.reduce((sum, m) => sum + m.rate, 0);
    const shot = rateSum ? dps / rateSum : 0;
    const reload = rateSum ? Math.max(0.24, base.turrets / rateSum) : 1;
    return {
      hull: base.id,
      hullName: base.name,
      slots: base.slots,
      fitted: fitted.map((m) => m.id),
      ignored,
      guns: guns.length,
      torpedoes: torpedoes.length,
      flak: flak.length,
      armour: armour.length,
      engines: engines.length,
      dps: Math.round(dps * 10) / 10,
      shot: Math.round(shot * 10) / 10,
      reload: Math.round(reload * 100) / 100,
      hp: base.hp + armour.reduce((s, m) => s + m.hp, 0),
      speed: Math.round((base.speed + engines.reduce((s, m) => s + m.speed, 0)) * 100) / 100,
      turrets: base.turrets,
      range: Math.max(0, ...[...guns, ...torpedoes].map((m) => m.range)),
      cost: modulesCost(fitted.map((m) => m.id)),
    };
  }

  /** Can this purchase go through? Returns { ok, reason, credits }. */
  function buy(itemId, kind, credits, owned) {
    const list = kind === 'jet' ? JETS : kind === 'hull' ? HULLS : MODULES;
    const item = byId(list, itemId);
    if (!item) return { ok: false, reason: 'unknown item', credits };
    if (credits < item.cost) return { ok: false, reason: `need ${item.cost - credits} more credits`, credits };
    if (kind === 'hull' && owned?.hulls?.includes(itemId)) {
      return { ok: false, reason: 'hull already in the dock', credits };
    }
    return { ok: true, item, credits: credits - item.cost };
  }

  /* --------------------------------------------------------------- battle */
  /** Enemy fleet strength scales with the sortie number (1-based). */
  function enemyFleet(sortie = 1) {
    const s = Math.max(1, Math.round(sortie));
    const count = Math.min(6, 1 + Math.floor(s / 2));
    return Array.from({ length: count }, (_, i) => {
      const hull = HULLS[Math.min(HULLS.length - 1, Math.floor(s / 4) + (i % 2))];
      return {
        hull: hull.id,
        name: ['RAIDER', 'CORSAIR', 'MARUADER', 'PRIVATEER', 'IRONWOLF', 'DREADNAUGHT'][i % 6],
        hp: Math.round(hull.hp * (0.55 + s * 0.12)),
        speed: Math.round(hull.speed * 100) / 100,
        dmg: Math.round(4 + s * 1.4),
        range: 260 + i * 18,
      };
    });
  }

  /** Credits + score from a finished battle. */
  function battleReward({ kills = 0, survived = false, sortie = 1, hullLost = false } = {}) {
    const base = kills * (120 + sortie * 15);
    const win = survived ? 260 + sortie * 40 : 0;
    const salvage = hullLost ? 0 : Math.round(base * 0.1);
    return {
      credits: Math.round(base + win + salvage),
      score: Math.round(base + win + salvage + (survived ? 200 : 0)),
    };
  }

  /** Flavour line for the result card. */
  function verdict({ survived, kills, hullLost }) {
    if (survived && kills >= 4) return 'FLEET ANNIHILATED — THE TIDE IS YOURS';
    if (survived) return 'SORTIE CLEARED';
    if (hullLost && kills) return 'HULL BREACHED — YOU TOOK SOME OF THEM WITH YOU';
    return 'LOST WITH ALL HANDS';
  }

  /** Default hangar for a new admiral. */
  function newFleet() {
    return {
      credits: STARTING_CREDITS,
      hulls: ['skiff'],
      hull: 'skiff',
      modules: ['light-cannon'],
      jets: [],
      sorties: 0,
      kills: 0,
      best: 0,
    };
  }

  const api = {
    HULLS, MODULES, JETS, STARTING_CREDITS,
    byId, hullCost, modulesCost, computeLoadout, buy,
    enemyFleet, battleReward, verdict, newFleet,
  };

  root.FleetRules = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
