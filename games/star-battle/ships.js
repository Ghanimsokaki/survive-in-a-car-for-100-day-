/**
 * STAR BATTLE — ships, waves and damage.
 *
 * A classic script, like Iron Tide's: the game runs in a sandboxed iframe with
 * an opaque origin, where ES-module fetches are cross-origin and fail, so the
 * whole game is plain `<script>` files talking to `window`.
 *
 * Everything here is data and pure maths — no canvas, no DOM — so the hub's test
 * suite runs it under Node and pins the balance without a browser.
 *
 * The three ships are the player's USS Enterprise-E (`NCC-1701-E`) against
 * Nero's mining vessel **Narada** and Khan's dreadnought **Vengeance**. They are
 * drawn from vector art in `game.js` (`drawShip`); if you have real models, that
 * is the one function to replace — the rules and the fight do not care.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ ships
   * `radius` is the collision/art size in world units. `turn` is radians per
   * second. The player's ship is the only one with shields that come back.
   */
  const SHIPS = {
    enterprise: {
      id: 'enterprise',
      name: 'U.S.S. ENTERPRISE',
      registry: 'NCC-1701-E',
      side: 'federation',
      hull: 460,
      shields: 520,
      shieldRegen: 44,          // per second, once the delay has passed
      shieldDelay: 2.8,         // seconds without a hit before regen starts
      speed: 216,
      turn: 2.55,
      radius: 30,
      phaser: { dmg: 30, every: 0.15, range: 540, arc: 0.95 },
      torpedo: { dmg: 190, speed: 640, load: 4, reload: 5.5, splash: 46 },
      evade: { boost: 2.3, time: 0.55, cooldown: 9 },
      score: 0,
    },
    narada: {
      id: 'narada',
      name: 'NARADA',
      registry: 'MINING VESSEL',
      side: 'romulan',
      hull: 900,
      shields: 0,
      shieldRegen: 0,
      shieldDelay: 0,
      speed: 64,
      turn: 0.55,
      radius: 46,
      torpedo: { dmg: 78, speed: 420, every: 3.6, range: 760, splash: 62 },
      score: 500,
      blurb: 'A drilling rig the size of a city. Slow, but its torpedoes take chunks out of you.',
    },
    vengeance: {
      id: 'vengeance',
      name: 'VENGEANCE',
      registry: 'DREADNOUGHT',
      side: 'section31',
      hull: 640,
      shields: 220,
      shieldRegen: 14,
      shieldDelay: 4,
      speed: 132,
      turn: 1.4,
      radius: 36,
      phaser: { dmg: 24, every: 1.1, range: 470, arc: 1.9 },
      torpedo: { dmg: 105, speed: 520, every: 4.6, range: 700, splash: 50 },
      score: 380,
      blurb: 'Faster than it looks, and it shoots on the move. Two of these will bracket you.',
    },
  };

  /** The ship the player flies. One constant, so the HUD and the rules agree. */
  const PLAYER_SHIP = 'enterprise';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ------------------------------------------------------------------ waves
   * Wave 1 is a lone Narada; every second wave adds a Vengeance, every third
   * adds another Narada. Both counts stop growing at 6 total, then the ships
   * themselves get tougher — that is what keeps late waves long, not crowded.
   */
  function waveFor(n) {
    const wave = Math.max(1, Math.floor(n || 1));
    const narada = Math.min(4, 1 + Math.floor((wave - 1) / 3));
    const vengeance = Math.min(3, Math.floor(wave / 2));
    return {
      wave,
      narada,
      vengeance,
      count: narada + vengeance,
      hpScale: Math.min(2.4, 1 + (wave - 1) * 0.12),
      dmgScale: Math.min(1.9, 1 + (wave - 1) * 0.08),
      speedScale: Math.min(1.45, 1 + (wave - 1) * 0.045),
    };
  }

  /** What a wave is worth on top of the kills: 250 × wave, capped. */
  function waveBonus(wave) {
    return Math.min(4000, 250 * Math.max(1, Math.floor(wave || 1)));
  }

  /** Kills, waves and time, in one number the arcade can store. */
  function scoreOf({ kills = 0, wave = 1, seconds = 0, hull = 0 } = {}) {
    const killScore = (kills || 0) * 120;
    const waveScore = Math.max(0, Math.floor(wave || 1) - 1) * 250;
    const timeScore = Math.floor(Math.max(0, seconds || 0) * 3);
    const hullScore = Math.max(0, Math.round(hull || 0));
    return killScore + waveScore + timeScore + hullScore;
  }

  /* ----------------------------------------------------------------- damage
   * Shields absorb first and do not bleed through; anything left over hits the
   * hull. Returns the new pools so a caller never has to do the arithmetic, and
   * always clamps at zero — a ship is destroyed, never negative.
   */
  function damage({ shields = 0, hull = 0 } = {}, amount = 0) {
    const hit = Math.max(0, Number(amount) || 0);
    const absorbed = Math.min(Math.max(0, shields), hit);
    const bleed = hit - absorbed;
    const nextShield = Math.max(0, shields - absorbed);
    const nextHull = Math.max(0, hull - bleed);
    return {
      shields: nextShield,
      hull: nextHull,
      absorbed,
      bleed,
      down: nextHull <= 0,
      shieldsDown: shields > 0 && nextShield <= 0,
    };
  }

  /** Shield regeneration, but only once the ship has been left alone. */
  function regen({ shields = 0, max = 0, since = 99 } = {}, dt = 0, ship = SHIPS.enterprise) {
    if (!(ship?.shieldRegen > 0) || !(max > 0)) return Math.max(0, shields);
    if ((since || 0) < (ship.shieldDelay || 0)) return Math.max(0, Math.min(max, shields));
    return Math.min(max, Math.max(0, shields) + ship.shieldRegen * Math.max(0, dt));
  }

  /* --------------------------------------------------------------- geometry */

  /** Angle from (x1,y1) to (x2,y2), in radians. */
  function bearing(x1, y1, x2, y2) {
    return Math.atan2(y2 - y1, x2 - x1);
  }

  /** Signed difference between two angles, always in -π…π. */
  function angleDelta(a, b) {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  /** Is `target` inside the ship's firing arc, looking along `facing`? */
  function inArc(facing, toTarget, arc) {
    return Math.abs(angleDelta(facing, toTarget)) <= (arc || 0) / 2;
  }

  /**
   * Falls a phaser beam off with distance: full power to 55% of its range, then
   * a straight line down to 55% at the edge. A hit outside `range` is zero.
   */
  function beamPower(dist, range) {
    if (!(range > 0) || dist > range) return 0;
    const near = range * 0.55;
    if (dist <= near) return 1;
    return clamp(1 - ((dist - near) / (range - near)) * 0.45, 0.55, 1);
  }

  /** Where a wave spawns, on a ring around the player, never right on top. */
  function spawnPoint(angle, radius = 900) {
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  /** Deterministic RNG so a seeded test and a replay agree. */
  function rng(seed = 1337) {
    let a = seed | 0;
    return function next() {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A fresh run: the ship, its systems, and the wave counter. */
  function newRun({ seed = (Date.now() & 0xffff) } = {}) {
    const spec = SHIPS[PLAYER_SHIP];
    return {
      seed,
      wave: 0,
      kills: 0,
      seconds: 0,
      screen: 'title',
      ship: {
        x: 0, y: 0, facing: -Math.PI / 2, vx: 0, vy: 0,
        hull: spec.hull, hullMax: spec.hull,
        shields: spec.shields, shieldsMax: spec.shields,
        sinceHit: 99,
        phaserHeat: 0,
        torpedoes: spec.torpedo.load,
        reload: 0,
        evade: 0,
      },
    };
  }

  /* ------------------------------------------------------------- the sector
   * An open world needs places in it. These are the fixed points a captain can
   * see, fly to and be sent to: a starbase, a couple of worlds, a derelict and
   * a debris field. They are seeded, so a seed is a sector — the same fight in
   * the same sky, which is what makes a quest replayable.
   */
  const SITE_DEFS = [
    { kind: 'starbase', name: 'STARBASE 74', size: 46, tint: [0.42, 0.66, 1.0] },
    { kind: 'planet', name: 'RISA', size: 210, tint: [0.24, 0.52, 0.38] },
    { kind: 'derelict', name: 'DERELICT · NCC-1701-C', size: 40, tint: [0.5, 0.46, 0.4] },
    { kind: 'field', name: 'DEBRIS FIELD', size: 260, tint: [0.36, 0.34, 0.32] },
    { kind: 'planet', name: 'VULCAN', size: 180, tint: [0.52, 0.3, 0.2] },
    { kind: 'starbase', name: 'OUTPOST 12', size: 34, tint: [0.4, 0.7, 0.9] },
  ];

  /** The sector's landmarks, laid on a ring so none of them overlap. */
  function sectorSites(seed = 1) {
    const rand = rng((seed | 0) ^ 0x51ed);
    return SITE_DEFS.map((def, i) => {
      const angle = (i / SITE_DEFS.length) * Math.PI * 2 + rand() * 0.55 + 0.3;
      const dist = 520 + rand() * 1500;
      return {
        id: `${def.kind}${i}`,
        kind: def.kind,
        name: def.name,
        size: def.size,
        tint: def.tint,
        r: def.kind === 'field' ? 300 : Math.max(70, def.size * 2.2),
        x: Math.cos(angle) * dist,
        y: Math.sin(angle) * dist,
        angle,
        seed: rand(),
      };
    });
  }

  /**
   * Four objectives, in the order a captain meets them: clear the contacts,
   * pick up the survivors, hold the line, report in. Each one is a plain
   * object with a `progress` and a `need`, so the HUD, the sim and a test all
   * read the same numbers.
   */
  function makeQuests(seed = 1, sites = null) {
    const list = sites || sectorSites(seed);
    const pick = (kind) => (list.find((s) => s.kind === kind) || list[0]);
    const derelict = pick('derelict');
    const base = pick('starbase');
    const outpost = [...list].reverse().find((s) => s.kind === 'starbase') || base;
    return [
      {
        id: 'q1', kind: 'destroy', need: 3, progress: 0, done: false, reward: 400,
        title: 'CLEAR THE SECTOR', hint: 'Destroy 3 hostile contacts', targetId: null,
      },
      {
        id: 'q2', kind: 'reach', need: 1, progress: 0, done: false, reward: 600,
        title: 'RESCUE PARTY', hint: `Warp to ${derelict.name}`, targetId: derelict.id,
      },
      {
        id: 'q3', kind: 'visit', need: 2, progress: 0, done: false, reward: 750,
        title: 'SURVEY THE SECTOR', hint: 'Fly to any two landmarks', targetId: null,
      },
      {
        id: 'q4', kind: 'reach', need: 1, progress: 0, done: false, reward: 1200,
        title: 'REPORT IN', hint: `Dock at ${outpost.name}`, targetId: outpost.id,
      },
    ];
  }

  /** The objective being flown right now: the first one not yet done. */
  function activeQuest(quests = []) {
    return quests.find((q) => q && !q.done) || null;
  }

  /**
   * Feeds an event into a quest. Returns true when it moved.
   *   { type: 'kill' }                        — any hostile destroyed
   *   { type: 'reach', siteId: 'starbase0' }  — you flew to a landmark
   */
  function questEvent(quest, event = {}) {
    if (!quest || quest.done) return false;
    let hit = false;
    if (quest.kind === 'destroy' && event.type === 'kill') hit = true;
    if (quest.kind === 'reach' && event.type === 'reach' && event.siteId === quest.targetId) hit = true;
    if (quest.kind === 'visit' && event.type === 'reach' && Boolean(event.siteId)) hit = true;
    if (!hit) return false;
    quest.progress = Math.min(quest.need, quest.progress + 1);
    quest.done = quest.progress >= quest.need;
    return true;
  }

  /** Where the helm should point for this quest, or null when it is not a place. */
  function questTarget(quest, sites = []) {
    if (!quest) return null;
    if (quest.targetId) return sites.find((s) => s.id === quest.targetId) || null;
    if (quest.kind === 'visit') return null;         // any landmark will do
    return null;
  }

  const api = {
    SHIPS, PLAYER_SHIP,
    sectorSites, makeQuests, activeQuest, questEvent, questTarget,
    waveFor, waveBonus, scoreOf,
    damage, regen,
    bearing, angleDelta, inArc, beamPower, spawnPoint, rng,
    newRun, clamp,
  };

  root.StarShips = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
