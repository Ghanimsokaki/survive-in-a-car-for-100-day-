/**
 * IRON TIDE — water.
 *
 * Two things live here, and both are pure maths so the hub's suite can check
 * them without a canvas:
 *
 *   1. THE SEA — a directional wave field. A handful of deep-water sine
 *      components, each obeying the real dispersion relation
 *      (ω = √(g·k), so long swell travels faster than short chop), summed into
 *      a height field with an analytic gradient. From that you get everything a
 *      ship or a renderer needs: how high the water is, which way it slopes,
 *      how white the crest is, and the wind-driven surface drift.
 *
 *   2. THE SHIP — a 3-DOF manoeuvring model (surge, sway, yaw) on top of a
 *      1-DOF heave spring, which is what makes a boat feel like a boat instead
 *      of a cursor:
 *
 *        · thrust pushes along the hull, drag is quadratic
 *        · a hull resists sideways motion ~8× more than forward motion, so it
 *          drifts through a turn and then grips — the single most important
 *          detail in any boat feel
 *        · a rudder produces no turning moment when there is no waterflow, so
 *          you cannot pivot on the spot
 *        · yaw has inertia and rate damping, so a big hull swings slowly
 *        · waves lift, roll and pitch the hull, and slowing chop steals speed
 *        · heavy chop slams the bow: the hull heaves hard, loses way, and in a
 *          real storm it takes damage
 *
 * Units are metres and seconds, with g = 9.81. A `speed` of 1.15 means 69 m/s
 * once the game scales it (×60), which is fast for a ship but keeps the fight
 * playable in a 2400 m arena.
 *
 * Classic script: the game runs sandboxed with an opaque origin, so ES modules
 * are not available. Everything hangs off `window.WaterPhysics`, and
 * `module.exports` is set for Node.
 */
(function (root) {
  'use strict';

  const G = 9.81;
  const RHO_AIR = 1.225;      // kg/m³
  const CD_AIR = 1.0;         // a boxy superstructure
  const CURRENT_GRIP = 0.02;  // how hard a surface current drags the hull
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ------------------------------------------------------------------ sea */

  /**
   * Sea states. `amp` is the significant height of the tallest component in
   * metres, `len` the dominant wavelength, `wind` in m/s, `chop` scales how
   * much the short components contribute, `drift` is the surface current
   * (fraction of the wind).
   */
  const SEAS = {
    calm: {
      id: 'calm', name: 'CALM', amp: 1.1, len: 210, wind: 4, chop: 0.30,
      spread: 0.35, drift: 0.025, slamming: 0, blurb: 'Long glassy swell.',
    },
    moderate: {
      id: 'moderate', name: 'MODERATE', amp: 2.4, len: 165, wind: 9, chop: 0.55,
      spread: 0.50, drift: 0.035, slamming: 0, blurb: 'Working sea. Some whitecaps.',
    },
    rough: {
      id: 'rough', name: 'ROUGH', amp: 4.2, len: 140, wind: 15, chop: 0.85,
      spread: 0.70, drift: 0.045, slamming: 0.35, blurb: 'Short and steep. Hold on.',
    },
    storm: {
      id: 'storm', name: 'STORM', amp: 6.8, len: 120, wind: 24, chop: 1.15,
      spread: 0.95, drift: 0.060, slamming: 1, blurb: 'Breaking crests. The sea is in charge.',
    },
  };

  const SEA_ORDER = ['calm', 'moderate', 'rough', 'storm'];

  /** Deterministic PRNG (mulberry32) so a seed always builds the same sea. */
  function rng(seed) {
    let a = (seed | 0) || 1;
    return function next() {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * Builds the wave components for a sea state.
   *
   * Five components is the sweet spot: enough to break the "single sine"
   * regularity, cheap enough to evaluate a few thousand times a frame on a
   * phone. Amplitudes fall off geometrically (long swell carries the energy),
   * directions fan out around the wind, and every component's speed comes from
   * the dispersion relation rather than a made-up constant.
   */
  function buildWaves(state, seed = 7, count = 5) {
    const rand = rng(seed + state.wind);
    const windDir = -0.6;                       // radians, the prevailing bearing
    const waves = [];
    let ampSum = 0;
    for (let i = 0; i < count; i++) {
      const f = i / Math.max(1, count - 1);     // 0 = biggest swell, 1 = chop
      const len = state.len * lerp(1, 0.26, f) * lerp(1, 0.85, rand());
      const amp = (state.amp / (1.9 + i * 0.85)) * lerp(1.15, 1, rand()) * lerp(1, 0.55 + state.chop, f);
      const k = TAU / len;
      const omega = Math.sqrt(G * k);           // deep-water dispersion
      const dir = windDir + (rand() - 0.5) * TAU * state.spread * 0.55;
      waves.push({
        amp, len, k, omega, dir,
        phase: rand() * TAU,
        speed: omega / k,                       // phase speed, m/s
      });
      ampSum += amp;
    }
    return { waves, ampSum, windDir };
  }

  /**
   * A patch of sea. `step` advances the clock, `at` samples the field, `foam`
   * says how white a crest is, `drift` is the surface current.
   */
  function createSea({ state = 'moderate', seed = 7, scale = 1, time = 0 } = {}) {
    const preset = SEAS[state] || SEAS.moderate;
    const built = buildWaves(preset, seed);
    const sea = {
      state: preset.id,
      preset,
      waves: built.waves,
      ampSum: built.ampSum,
      windDir: built.windDir,
      t: time,
      scale: Math.max(0.1, scale),
      /** how hard the sea is working, 0 (calm) → 1 (storm) */
      severity: clamp((preset.amp - SEAS.calm.amp) / (SEAS.storm.amp - SEAS.calm.amp), 0, 1),
    };

    /** Advance the field. Sub-stepped so a hitch cannot skip a whole crest. */
    sea.step = function step(dt) {
      const d = clamp(Number(dt) || 0, 0, 0.25);
      sea.t += d;
      return sea.t;
    };

    /** Wave height (m) at a world point, at the sea's current clock. */
    sea.height = function height(x, y) {
      let h = 0;
      const px = x * sea.scale;
      const py = y * sea.scale;
      for (let i = 0; i < sea.waves.length; i++) {
        const w = sea.waves[i];
        h += w.amp * Math.sin(w.k * (px * Math.cos(w.dir) + py * Math.sin(w.dir)) - w.omega * sea.t + w.phase);
      }
      return h;
    };

    /**
     * Height plus slope. The gradient is analytic — no finite differences, so
     * it is exact and costs the same as one more sine.
     */
    sea.at = function at(x, y) {
      let h = 0, gx = 0, gy = 0;
      const px = x * sea.scale;
      const py = y * sea.scale;
      for (let i = 0; i < sea.waves.length; i++) {
        const w = sea.waves[i];
        const kd = w.k * (px * Math.cos(w.dir) + py * Math.sin(w.dir));
        const phase = kd - w.omega * sea.t + w.phase;
        const s = Math.sin(phase);
        const c = Math.cos(phase);
        h += w.amp * s;
        gx += w.amp * w.k * Math.cos(w.dir) * c;
        gy += w.amp * w.k * Math.sin(w.dir) * c;
      }
      return { h, gx, gy };
    };

    /**
     * Crest whiteness, 0…1. Real foam needs a steep face, so this keys off the
     * slope (not the height) and only fires above what the sea state allows.
     */
    sea.foam = function foam(x, y) {
      const s = sea.at(x, y);
      const slope = Math.hypot(s.gx, s.gy);
      const crest = slope / Math.max(0.0001, sea.preset.chop * 0.55 + 0.12);
      const bias = sea.severity * 0.55;
      return clamp(crest * 0.75 + bias * crest - 0.55, 0, 1);
    };

    /** Surface current from the wind (m/s), as a velocity vector. */
    sea.drift = function drift() {
      const speed = sea.preset.wind * sea.preset.drift;
      return { x: Math.cos(sea.windDir) * speed, y: Math.sin(sea.windDir) * speed };
    };

    /** Wind velocity vector (m/s) — used for leeway and the HUD arrow. */
    sea.wind = function wind() {
      return { x: Math.cos(sea.windDir) * sea.preset.wind, y: Math.sin(sea.windDir) * sea.preset.wind };
    };

    /** Swap sea state mid-battle (the storm rolls in). */
    sea.setState = function setState(id) {
      const next = SEAS[id] || SEAS.moderate;
      const rebuilt = buildWaves(next, seed, sea.waves.length);
      sea.state = next.id;
      sea.preset = next;
      sea.waves = rebuilt.waves;
      sea.ampSum = rebuilt.ampSum;
      sea.severity = clamp((next.amp - SEAS.calm.amp) / (SEAS.storm.amp - SEAS.calm.amp), 0, 1);
      return sea.state;
    };

    return sea;
  }

  /* ----------------------------------------------------------------- hull */

  /**
   * Hull particulars, derived from the hull's length and its advertised speed
   * so the dock stats and the water agree with each other.
   *
   *   length 46 m, speed 1.15 (→ 69 m/s in game units)
   *   beam ≈ length / 6.2, draft ≈ length / 24 (a destroyer floats shallow)
   */
  function hullSpec({ length = 46, speed = 1, mass = null } = {}) {
    const L = clamp(Number(length) || 46, 12, 200);
    const vMax = Math.max(6, (Number(speed) || 1) * 60);   // m/s at full ahead
    const beam = L / 6.2;
    const draft = L / 24;
    // displaced volume → mass. Scaled so a corvette lands near 900 "tonnes".
    const displacement = mass != null ? mass : Math.pow(L / 46, 3) * 900;
    return {
      length: L, beam, draft, displacement, vMax,
      // 0 → vMax in about 3.6 s of thrust, before the sea takes its cut
      accel: vMax / 3.6,
      // quadratic drag so thrust and drag meet exactly at vMax
      dragLong: (vMax / 3.6) / (vMax * vMax),
      // a hull's keel makes sideways motion ~8× more expensive
      dragLat: ((vMax / 3.6) / (vMax * vMax)) * 8,
      // yaw inertia: big ships swing slowly
      yawInertia: Math.pow(L / 46, 2.4),
      // max yaw rate, rad/s. A destroyer's tactical diameter is 3–5 ship
      // lengths, which at cruise works out around 0.35 rad/s — not the
      // instant pivot arcade boats get.
      turnRate: 0.30 + (Number(speed) || 1) * 0.06,
      reverse: 0.42,                                       // astern authority
    };
  }

  /**
   * A floating body: position, three velocity DOF, plus heave/pitch/roll for
   * the renderer. `stepBody` is the only thing that advances it.
   */
  function createBody({ x = 0, y = 0, heading = 0, length = 46, speed = 1, mass = null } = {}) {
    const spec = hullSpec({ length, speed, mass });
    return {
      spec,
      x, y,
      heading,
      u: 0,                                   // surge, along the hull (m/s)
      v: 0,                                   // sway, sideways (m/s)
      r: 0,                                   // yaw rate (rad/s)
      heave: 0, heaveVel: 0,                  // vertical bob (m)
      pitch: 0, roll: 0,                      // radians, for the renderer
      throttle: 0, rudder: 0,
      slams: 0,                               // how hard the sea has hit us
      seaTime: 0,
      wake: 0,                                // 0…1 wake intensity, for foam
      lastAccel: { u: 0, v: 0 },
      distance: 0,
    };
  }

  /** World-space velocity of a body (m/s). */
  function velocityOf(body) {
    const c = Math.cos(body.heading);
    const s = Math.sin(body.heading);
    return {
      x: body.u * c - body.v * s,
      y: body.u * s + body.v * c,
    };
  }

  /** Forward speed in knots, purely for the HUD. */
  function knots(speedMs) {
    return Math.abs(speedMs) * 1.94384;
  }

  // Heave is a damped spring. The natural frequency is deliberately well above
  // the frequency at which a fast hull *meets* the waves (speed / wavelength),
  // otherwise the two resonate and the ship pogos — which is not fun and not
  // what a well-found hull does.
  const HEAVE_W = 3.2;       // natural heave frequency (rad/s)
  const HEAVE_Z = 0.8;       // damping ratio: settles quickly, no wobble
  const YAW_TAU = 0.45;      // s, yaw rate response (kept for the renderer)
  const YAW_DAMP = 2.2;      // 1/s, hydrodynamic damping of the yaw rate
  const RUDDER_GAIN = 26;   // side force at the rudder per unit of required moment
  const SLAM_SPEED = 6.0;    // m/s of vertical velocity that counts as a slam
  const HEEL_LIMIT = 0.30;   // rad (17°) — past this the rail is under

  /**
   * One physics step.
   *
   * @param body      from createBody
   * @param sea       from createSea
   * @param dt        seconds; internally sub-stepped to ≤ 1/120 for stability
   * @param controls  { throttle: -1…1, rudder: -1…1 }  (+1 rudder = starboard)
   * @param out       optional accumulator: { damage, wakeEmit, spray }
   */
  function stepBody(body, sea, dt, controls = {}, out = null) {
    const total = clamp(Number(dt) || 0, 0, 0.25);
    if (total <= 0) return body;
    const steps = Math.max(1, Math.ceil(total / (1 / 120)));
    const h = total / steps;
    const spec = body.spec;

    if (out) {
      out.damage = 0;
      out.wakeEmit = 0;
      out.spray = 0;
      out.slam = false;
    }

    for (let i = 0; i < steps; i++) {
      const throttle = clamp(Number(controls.throttle) || 0, -1, 1);
      const rudder = clamp(Number(controls.rudder) || 0, -1, 1);
      body.throttle = throttle;
      body.rudder = rudder;
      body.seaTime += h;
      if (sea && sea.step) sea.step(h);
      const water = sea ? sea.at(body.x, body.y) : { h: 0, gx: 0, gy: 0 };

      /* ---- surge: thrust vs quadratic hull resistance ------------------ */
      const thrust = throttle >= 0
        ? throttle * spec.accel
        : throttle * spec.accel * spec.reverse;
      let forceU = thrust;

      // wave-making drag: pushing into a head sea costs more than running with it
      const headSea = Math.abs(water.gx * Math.cos(body.heading) + water.gy * Math.sin(body.heading));
      const chopDrag = 1 + clamp(headSea * 1.1, 0, 1.4) * (sea ? 1 + sea.severity : 1);
      forceU -= spec.dragLong * body.u * Math.abs(body.u) * chopDrag;

      // Quadratic resistance is meaningless near zero, so below a couple of
      // knots a linear (viscous) term takes over. Without it a hull would creep
      // forward forever, which is the number one tell of fake boat physics.
      if (Math.abs(body.u) < 2.5) forceU -= body.u * 1.6;

      // slamming through a crest scrubs speed — the hull leaves the water
      if (Math.abs(body.heaveVel) > SLAM_SPEED) {
        forceU -= Math.sign(body.u) * Math.abs(body.u) * 0.12 * Math.min(1, Math.abs(body.heaveVel) / 9);
      }

      /* ---- sway: keel resistance + rudder side-force ------------------- */
      // The rudder only bites when water is flowing past it. It shoves the
      // stern sideways, which is what swings the bow the other way — so its
      // side force is exactly the moment this hull needs to spin up at its
      // rated yaw acceleration.
      const yawInertia = Math.max(0.2, spec.yawInertia);
      // rudder authority, in rad/s²: exactly what it takes to settle at the
      // hull's rated turn rate against its own hydrodynamic yaw damping
      const ratedYaw = spec.turnRate * Math.pow(46 / spec.length, 0.35);
      const yawAccel = YAW_DAMP * ratedYaw * (1 + 1.4 * ratedYaw);
      const flow = clamp(Math.abs(body.u) / (0.35 * spec.vMax), 0, 1);
      const leverage = clamp(Math.abs(body.u) / spec.vMax, 0, 1);   // 0…1 of full way
      const arm = spec.length * 0.5;                                // rudder → centre of mass
      const rudderSide = -rudder * flow * (yawAccel * yawInertia * leverage / arm) * RUDDER_GAIN;
      let forceV = rudderSide;
      forceV -= spec.dragLat * body.v * Math.abs(body.v);
      forceV -= body.r * body.u * 0.06;

      /* ---- wind & current: leeway ------------------------------------- */
      if (sea) {
        // Wind acts on the topsides, the water on the hull. The airflow the
        // ship feels is the true wind minus its own motion — that headwind is
        // real, but it is *air*, so it is two orders of magnitude weaker than
        // the hull's own resistance. Getting this wrong is how a boat ends up
        // with a speed limit nobody asked for.
        const wind = sea.wind();
        const drift = sea.drift();
        const vel = velocityOf(body);
        const relX = wind.x - vel.x;
        const relY = wind.y - vel.y;
        const rel = Math.hypot(relX, relY);
        if (rel > 0.01) {
          const massKg = Math.max(1, spec.displacement * 1000);
          const area = spec.length * spec.beam * 0.45;      // above the waterline
          const airAccel = RHO_AIR * CD_AIR * area * rel / massKg;
          forceU += airAccel * (relX * Math.cos(body.heading) + relY * Math.sin(body.heading));
          // the superstructure is a sail: it pushes the bow off the wind far
          // more than it slows the ship down
          forceV += airAccel * (-relX * Math.sin(body.heading) + relY * Math.cos(body.heading)) * 2.6;
        }
        // a surface current simply carries the hull with it: model it as drag
        // towards the water's own velocity, not as a force
        const curX = drift.x - vel.x;
        const curY = drift.y - vel.y;
        forceU += (curX * Math.cos(body.heading) + curY * Math.sin(body.heading)) * CURRENT_GRIP;
        forceV += (-curX * Math.sin(body.heading) + curY * Math.cos(body.heading)) * CURRENT_GRIP * 0.6;
      }

      /* ---- integrate the horizontal DOF -------------------------------- */
      const accU = forceU;
      const accV = forceV;
      body.u += accU * h;
      body.v += accV * h;
      body.lastAccel = { u: accU, v: accV };

      /* ---- yaw: moment balance with inertia ---------------------------- */
      // A hull has no "turn rate" it snaps to: the rudder applies a moment,
      // the mass answers by accelerating in yaw, and hydrodynamic damping
      // (growing with the square of the rate) decides where it settles — so
      // the bow keeps swinging for a moment after you centre the helm.
      // Yaw damping is scaled to the hull's own inertia, so the settled turn
      // rate depends on the rudder, not on how heavy the ship is.
      const authority = clamp(leverage * 1.6, 0, 1);              // no flow, no steerage
      const moment = rudder * yawAccel * authority * (body.u < 0 ? -0.55 : 1);
      const yawDamp = YAW_DAMP * body.r * (1 + Math.abs(body.r) * 1.4);
      body.r = clamp(body.r + (moment - yawDamp) * h, -1.1, 1.1);
      body.heading += body.r * h;

      /* ---- position ---------------------------------------------------- */
      const vel = velocityOf(body);
      body.x += vel.x * h;
      body.y += vel.y * h;
      body.distance += Math.hypot(vel.x, vel.y) * h;

      /* ---- heave: a damped spring chasing the water surface ------------ */
      // Froude-ish lift: a fast hull climbs out of the water and rides higher
      const lift = clamp(Math.abs(body.u) / spec.vMax, 0, 1) * 0.35 * (1 + (sea ? sea.severity : 0));
      const target = water.h + lift * (1 - (sea ? sea.severity : 0) * 0.4);
      const acc = HEAVE_W * HEAVE_W * (target - body.heave) - 2 * HEAVE_Z * HEAVE_W * body.heaveVel;
      body.heaveVel += acc * h;
      body.heave += body.heaveVel * h;

      /* ---- attitude: the hull lies along the local surface -------------- */
      // The hull lies along the local surface (slope × gain = heel) and heels
      // further out of the turn. Past HEEL_LIMIT the rail is under water and
      // the ship stops heeling — it is being held up by its own beam, not by
      // its righting moment, so the number has to stop too.
      const rollTarget = clamp(
        clamp(-water.gx * 0.5, -0.22, 0.22) + clamp(body.r * Math.abs(body.u) * 0.0018, -0.16, 0.16),
        -HEEL_LIMIT, HEEL_LIMIT);
      const pitchTarget = clamp(-water.gy * 0.35, -0.3, 0.3);
      body.roll = lerp(body.roll, rollTarget, Math.min(1, h * 3.2));
      body.pitch = lerp(body.pitch, pitchTarget, Math.min(1, h * 2.6));

      /* ---- slamming ---------------------------------------------------- */
      if (out && Math.abs(body.heaveVel) > SLAM_SPEED && Math.abs(body.u) > 0.35 * spec.vMax) {
        out.slam = true;
        out.spray += Math.min(1, Math.abs(body.heaveVel) / 9);
        if (sea && sea.preset.slamming > 0) {
          // a storm hurts — proportionally to how hard you are driving
          // damage per second, accumulated over the substep (no extra fudge
          // factors: h is already in seconds)
          out.damage += sea.preset.slamming * 1.6 * Math.min(1, Math.abs(body.heaveVel) / 9) * h;
        }
      }

      /* ---- wake -------------------------------------------------------- */
      body.wake = clamp(Math.abs(body.u) / spec.vMax, 0, 1.4);
      if (out) {
        // particles per second of wake, scaled by how hard the hull is working
        out.wakeEmit += body.wake * Math.abs(body.u) * h * 1.35 * (spec.length / 46);
      }
    }

    // a hull at rest is at rest: snap off the numerical crumbs
    if (Math.abs(body.u) < 0.02) body.u = 0;
    if (Math.abs(body.v) < 0.02) body.v = 0;
    if (Math.abs(body.r) < 0.002) body.r = 0;

    // keep the numbers sane even if a caller hands us nonsense
    if (!Number.isFinite(body.u)) body.u = 0;
    if (!Number.isFinite(body.v)) body.v = 0;
    if (!Number.isFinite(body.r)) body.r = 0;
    if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) { body.x = 0; body.y = 0; }
    if (out && out.damage) body.slams += 1;
    return body;
  }

  /**
   * How much of the hull is under water, 0…1. Used by the renderer to decide
   * whether to show the boot-topping stripe and how big the bow wave is.
   */
  function immersion(body, sea) {
    if (!sea) return 1;
    const h = sea.height(body.x, body.y);
    const depth = body.heave - h;
    return clamp(1 - depth / Math.max(0.4, body.spec.draft), 0.15, 1);
  }

  /** Convenience: the sea state that belongs to a sortie number. */
  function seaForSortie(sortie = 1) {
    const s = Math.max(1, Math.round(sortie));
    if (s <= 1) return 'calm';
    if (s === 2) return 'moderate';
    if (s === 3) return 'rough';
    return 'storm';
  }

  const api = {
    G, SEAS, SEA_ORDER,
    buildWaves, createSea, rng,
    hullSpec, createBody, stepBody, velocityOf, knots, immersion,
    seaForSortie,
    constants: { HEAVE_W, HEAVE_Z, YAW_TAU, YAW_DAMP, RUDDER_GAIN, SLAM_SPEED, HEEL_LIMIT },
  };

  root.WaterPhysics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
