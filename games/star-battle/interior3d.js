/* STAR BATTLE — the ship interior, in 3D.
 *
 * The captain asked to see *inside* the ship: the crews at their stations, the
 * warp core, and the decks between them. The first answer was a schematic (a
 * cutaway drawn in 2D). This is the real one: a compartment you look into, lit
 * like main engineering, built from `gl.js` primitives so it costs nothing new —
 * no second renderer, no models to download.
 *
 * What is in the room:
 *
 *   · deck plating with seams, bulkheads broken into bays, strip lighting, and
 *     ceiling ribs that fade into the dark;
 *   · the warp core — a column of drums with plasma climbing it, brighter and
 *     faster with every core upgrade, and red-hot when the hull is holed;
 *   · a console at every station (helm, tactical, engineering, medical, science)
 *     with an emissive screen;
 *   · a figure standing at every station that has somebody at it, in the colour
 *     of their role — and an empty bay with no figure at all when the berth is
 *     vacant, which is the whole point of the panel.
 *
 * Two lessons are baked into the geometry, both learned by rendering it offline:
 *
 *   1. there is no `rescale()` in `gl.js`. Sizes go through `gl.solid(...)`, one
 *      call per part. A post-hoc scale shim silently leaves every slab a cube.
 *   2. the camera stands *inside* the hull. Parked outside it, the near
 *      bulkhead is all you see, and the room looks like a wall of grey boxes.
 *
 * The renderer is created on its own canvas (`#c4`) because a canvas that has
 * handed out a 2D context can never hand out a WebGL one, and the 2D schematic
 * stays as the fallback for a device with no WebGL at all.
 */
(function (root) {
  'use strict';

  /** A small deterministic hash, so a crew member always looks like themselves. */
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
  }

  const ROLE_COLOUR = {
    helm: [0.42, 0.78, 1.0],
    tactical: [1.0, 0.55, 0.32],
    engineering: [0.55, 1.0, 0.62],
    medical: [0.85, 0.92, 1.0],
    science: [0.72, 0.62, 1.0],
  };

  /** Where each station stands, in the room's own units (x along the hull). */
  const STATIONS = {
    helm: { x: -8.5, z: -5.2, yaw: 0.55 },
    tactical: { x: -6.0, z: 5.4, yaw: -0.6 },
    engineering: { x: 4.2, z: -5.6, yaw: 0.5 },
    medical: { x: -1.0, z: 6.0, yaw: -0.5 },
    science: { x: 1.2, z: -6.2, yaw: 0.4 },
  };

  function create(canvas) {
    const GL = root.StarGL;
    if (!canvas || !GL || typeof GL.create !== 'function') return null;
    let gl = null;
    try { gl = GL.create(canvas); } catch { gl = null; }
    if (!gl) return null;

    const api = {
      ok: true,
      mode: 'webgl',
      /** The camera's orbit, which the panel nudges with a tap. */
      orbit: 0,
      get tris() { return gl.tris; },

      /**
       * One frame of main engineering.
       *
       * `state` is the hangar, flattened: `{ crew, stats, hull, time, core }`.
       * Nothing in here reaches into the game — the panel decides what is true,
       * this decides what it looks like.
       */
      frame(w, h, dpr, state = {}) {
        const t = Number(state.time) || 0;
        const crew = Array.isArray(state.crew) ? state.crew : [];
        const hullPct = Math.max(0, Math.min(1, (state.hull ?? 1)));
        const coreLevel = Math.max(1, Math.min(8, (state.core | 0) || 1));

        gl.begin(w, h, dpr);

        // the camera stands inside the compartment, aft, looking down its
        // length at the core — never outside, where the hull is all you see
        const orbit = (api.orbit || 0) + Math.sin(t * 0.13) * 0.18;
        const eyeX = -9 + Math.cos(orbit) * 2.6 - 2.6;
        const eyeZ = -2.8 - Math.sin(orbit) * 3.4;
        const eyeY = 5.4 + Math.sin(t * 0.4) * 0.14;
        gl.camera(eyeX, eyeY, eyeZ, 6.5, 3.6, 0, 64);

        // no star shell in here: the room is the sky
        drawRoom(t, hullPct);
        drawCore(t, coreLevel, hullPct);
        for (const role of Object.keys(STATIONS)) {
          const at = STATIONS[role];
          const member = crew.find((c) => c && c.role === role);
          drawConsole(at, role, Boolean(member), t);
          if (member) drawCrew(at, member, t);
        }
        // the far bulkhead, so the room has an end
        gl.solid('box', 13.2, 4.2, 0, 0.6, 11, 16, 0, [0.10, 0.16, 0.22], [0.05, 0.10, 0.16], 0.35);
        gl.sprites();
        return api;
      },
    };

    /* ------------------------------------------------------------ the room */
    function drawRoom(t, hullPct) {
      const deck = [0.12, 0.16, 0.20];
      const wall = [0.10, 0.14, 0.19];
      const rib = [0.16, 0.21, 0.26];
      const panel = [0.25, 0.62, 0.85];

      // deck plating, with a seam every two metres
      for (let x = -13; x <= 13; x += 2) {
        gl.solid('box', x, -0.35, 0, 1.9, 0.6, 13.6, 0, deck, [0.04, 0.08, 0.12], 0.12);
        // the seam between two plates: a thin bright line, just proud of the deck
        gl.solid('box', x, 0.0, 0, 1.8, 0.04, 0.16, 0, [0.26, 0.34, 0.40], [0.16, 0.26, 0.34], 0.5);
      }
      // a wide deck slab underneath so there are no gaps at the edges
      gl.solid('box', 0, -0.62, 0, 28, 0.5, 14, 0, [0.07, 0.10, 0.13], [0.03, 0.06, 0.09], 0.1);

      // the forward bulkhead, so a swung camera never looks out into the void,
      // and a lit frame around the door we came in through
      gl.solid('box', -13.6, 4.6, 0, 0.5, 10.6, 15.4, 0, [0.09, 0.12, 0.16], [0.05, 0.09, 0.13], 0.2);
      gl.solid('box', -13.3, 4.6, 0, 0.16, 6.4, 5.2, 0, panel, panel, 0.7);

      // the outer hull, one plate a side: without it the room is a paling fence
      // and the space between two wall bays reads as a black slit. Kept a hand's
      // width behind the bays — two surfaces at the same depth fight for pixels.
      for (const side of [-1, 1]) {
        gl.solid('box', 0, 4.4, side * 7.98, 29, 10.4, 0.3, 0, [0.06, 0.09, 0.13], [0.03, 0.06, 0.09], 0.12);
      }
      // side walls in bays, with light panels between them. Alternating depth so
      // neighbouring bays never share a plane (a shared plane z-fights).
      for (let x = -12; x <= 12; x += 3) {
        const jitter = (Math.round((x + 12) / 3) % 2) * 0.09;
        gl.solid('box', x, 4.4, -7.4 - jitter, 3.2, 9.0, 0.4 + jitter, 0, wall, [0.05, 0.10, 0.15], 0.2);
        gl.solid('box', x, 4.4, 7.4 + jitter, 3.2, 9.0, 0.4 + jitter, 0, wall, [0.05, 0.10, 0.15], 0.2);
        // the light strips: emissive, so the room reads even with no sun
        for (const side of [-1, 1]) {
          gl.solid('box', x, 7.0, side * 7.1, 2.2, 0.18, 0.12, 0, panel, panel, 0.95);
          gl.solid('box', x, 5.4, side * 7.1, 1.1, 0.1, 0.1, 0, panel, panel, 0.55);
        }
      }
      // ceiling ribs: they fade into the dark and sell the ship as a tunnel
      for (let x = -12; x <= 12; x += 2.4) {
        gl.solid('box', x, 9.4, 0, 0.35, 0.6, 15, 0, rib, [0.04, 0.07, 0.10], 0.15);
      }
      // two long conduits running the length of the compartment
      for (const z of [-3.6, 3.6]) {
        gl.solid('box', 0, 8.4, z, 26, 0.3, 0.34, 0, [0.14, 0.18, 0.22], [0.10, 0.22, 0.30], 0.35);
      }
      // damage: embers where the hull is holed
      if (hullPct < 0.45) {
        const n = Math.round((1 - hullPct / 0.45) * 9);
        for (let i = 0; i < n; i++) {
          const a = hash(`spark${i}`) * Math.PI * 2;
          const x = -6 + hash(`x${i}`) * 16;
          gl.sprite(x, 1 + ((t * 1.7 + i * 0.37) % 1) * 6, Math.sin(a) * 5.4,
            0.18 + ((t + i * 0.3) % 1) * 0.3, 1.0, 0.45, 0.18);
        }
      }
    }

    /* ------------------------------------------------------- the warp core */
    function drawCore(t, level, hullPct) {
      const coreX = 8.6;
      const glow = [0.35, 0.85, 1.0];
      const hot = hullPct < 0.35 ? [1.0, 0.35, 0.25] : glow;

      // the cradle
      gl.solid('box', coreX, 0.5, 0, 4.2, 1.2, 4.2, 0, [0.13, 0.17, 0.22], [0.06, 0.10, 0.14], 0.2);
      gl.solid('box', coreX, 0.5, 0, 3.0, 1.0, 3.0, 0, [0.20, 0.26, 0.31], [0.10, 0.18, 0.24], 0.3);

      // the column: three stacked drums, shrinking as they rise
      for (let i = 0; i < 3; i++) {
        const y = 2.0 + i * 2.1;
        const r = 0.9 - i * 0.13;
        gl.solid('drum', coreX, y, 0, r, 2.2, r, 0, [0.12, 0.26, 0.36], [0.20, 0.70, 0.95], 0.55);
      }
      // the plasma itself: rising blobs, brighter and faster with the core level
      const rise = 1.4 + level * 0.22;
      for (let i = 0; i < 14; i++) {
        const phase = ((t * rise) / 6.5 + i / 14) % 1;
        const y = 1.6 + phase * 6.4;
        const size = 0.55 + Math.sin(phase * Math.PI) * 0.55;
        const fade = Math.sin(phase * Math.PI) * (0.55 + level * 0.05);
        gl.sprite(coreX + Math.sin(t * 1.7 + i) * 0.10, y, Math.cos(t * 1.3 + i) * 0.10,
          size, hot[0] * fade, hot[1] * fade, hot[2] * fade);
      }
      // injectors, aimed at the column
      for (const side of [-1, 1]) {
        gl.solid('box', coreX - 0.2, 3.2, side * 2.3, 0.5, 0.5, 1.8, 0,
          [0.18, 0.22, 0.26], [0.14, 0.30, 0.38], 0.35);
        gl.solid('box', coreX - 2.6, 5.6, side * 3.0, 1.2, 0.5, 0.5, 0,
          [0.15, 0.19, 0.23], [0.10, 0.24, 0.30], 0.3);
      }
      // a halo at the base, so the core lights the deck
      gl.sprite(coreX, 1.2, 0, 3.2, hot[0] * 0.16, hot[1] * 0.16, hot[2] * 0.16);
      gl.sprite(coreX, 1.2, 0, 5.2, hot[0] * 0.07, hot[1] * 0.07, hot[2] * 0.07);
    }

    /* ------------------------------------------------------- the stations */
    function drawConsole(at, role, crewed, t) {
      const colour = ROLE_COLOUR[role] || [0.6, 0.8, 1];
      const dim = crewed ? colour : [0.22, 0.26, 0.30];
      // the console body, the slanted top, and the screen. Waist height: a
      // console a person can stand behind, not a monolith they disappear into.
      gl.solid('box', at.x, 0.55, at.z, 1.5, 1.1, 0.8, at.yaw,
        [0.15, 0.19, 0.24], [0.07, 0.12, 0.17], 0.25);
      gl.solid('box', at.x, 1.18, at.z, 1.66, 0.16, 0.94, at.yaw,
        [0.19, 0.24, 0.29], [0.09, 0.15, 0.20], 0.3);
      gl.solid('box', at.x, 1.34, at.z, 1.2, 0.4, 0.7, at.yaw, dim, dim, crewed ? 0.95 : 0.5);
      // a soft light on the deck in front of a crewed console
      if (crewed) {
        const pulse = 0.5 + Math.sin(t * 2.1 + at.x) * 0.18;
        gl.sprite(at.x, 1.55, at.z, 1.9,
          colour[0] * 0.10 * pulse, colour[1] * 0.10 * pulse, colour[2] * 0.10 * pulse);
      }
    }

    function drawCrew(at, member, t) {
      const colour = ROLE_COLOUR[member.role] || [0.7, 0.85, 1];
      const seed = hash(`${member.name || ''}${member.role}`);
      const bob = Math.sin(t * 1.9 + seed * 6.28) * 0.05;
      // *In front of* the console, facing the room — clear of it, never inside
      // it. (Standing behind a waist-high console means the camera sees a head
      // floating over a box; standing a step out means it sees a person.)
      const side = hash(`${member.role}side`) > 0.5 ? 1 : -1;
      const step = at.z > 0 ? -1 : 1;               // toward the middle of the room
      const x = at.x + side * 0.72;
      const z = at.z + step * 1.45;
      const legsH = 0.92 + bob;
      const torsoH = 0.86;
      // legs, torso, head, in that order — a figure needs three masses to read
      gl.solid('box', x, legsH * 0.5, z, 0.42, legsH, 0.30, at.yaw,
        [0.11, 0.14, 0.19], [0.05, 0.08, 0.12], 0.15);
      gl.solid('box', x, legsH + torsoH * 0.5, z, 0.56, torsoH, 0.38, at.yaw, colour,
        [colour[0] * 0.45, colour[1] * 0.45, colour[2] * 0.45], 0.4);
      gl.solid('sphere', x, legsH + torsoH + 0.16, z, 0.18, 0.21, 0.18, 0,
        [0.78, 0.70, 0.62], [0.55, 0.48, 0.42], 0.25);
      // the badge: a small emissive pip on the shoulder, in the role colour
      gl.solid('sphere', x + 0.2, legsH + torsoH - 0.1, z, 0.07, 0.07, 0.07, 0, colour, colour, 0.95);
      // and a collar light, so a face-height dot of role colour shows from the door
      gl.sprite(x, legsH + torsoH + 0.2, z, 0.55,
        colour[0] * 0.5, colour[1] * 0.5, colour[2] * 0.5);
    }

    return api;
  }

  root.StarInterior = { create, STATIONS, ROLE_COLOUR };
}(typeof window !== 'undefined' ? window : globalThis));
