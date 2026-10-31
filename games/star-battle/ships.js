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

  const api = {
    SHIPS, PLAYER_SHIP,
    waveFor, waveBonus, scoreOf,
    damage, regen,
    bearing, angleDelta, inArc, beamPower, spawnPoint, rng,
    newRun, clamp,
  };

  root.StarShips = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
