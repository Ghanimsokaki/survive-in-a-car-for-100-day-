/**
 * ARCADE SDK — the little contract between a community game and the hub.
 *
 * Every game runs inside <iframe sandbox="allow-scripts">, so it gets no access
 * to the hub's DOM, storage, Supabase session or network. All it can do is post
 * these four message types to its parent, and the hub validates each one.
 *
 *   arcade:ready   → "I'm loaded, send me the player"
 *   arcade:state   → optional live status  { day, score, status }
 *   arcade:score   → finished run          { score, day, seconds, meta }
 *   arcade:close   → player asked to leave
 *   arcade:fullscreen → toggle the hub's (and therefore this frame's) fullscreen
 *
 * Drop this on the page with <script src="../_shared/sdk.js"></script>.
 * It degrades to a standalone page if nobody is listening (open the file
 * directly to test your game), which is how contributors develop offline.
 */
(function (global) {
  'use strict';

  const CHANNEL = 'outrun-arcade';
  let parentOrigin = '*';
  let ready = false;
  let started = false;
  const listeners = { start: [], message: [], pause: [], resume: [] };
  const emit = (kind, payload) => (listeners[kind] || []).forEach((fn) => fn(payload));
  const post = (type, payload) => {
    try {
      global.parent.postMessage({ channel: CHANNEL, type, payload: payload || {} }, parentOrigin);
    } catch { /* standalone */ }
    return true;
  };

  const isEmbedded = (() => {
    try { return global.parent && global.parent !== global; } catch { return false; }
  })();

  const sdk = {
    CHANNEL,
    /** True when the game is running inside the hub. */
    get embedded() { return isEmbedded; },
    /** Player details handed over by the hub (name, colour, customisation, room). */
    player: { name: 'WANDERER', color: '#5ff0ff', room: 'highway-01', custom: null },
    quality: 'auto',
    /**
     * Top runs for this game, handed over by the hub with `arcade:init`.
     * The hub has the Supabase client and a cached board; a game inside the
     * sandboxed frame has neither, so this is the only cheap way to show a
     * real leaderboard. `[{ score, name, meta, at }]`, best first, or null.
     */
    leaderboard: null,

    on(kind, fn) {
      if (!listeners[kind]) throw new Error(`unknown arcade event "${kind}"`);
      listeners[kind].push(fn);
      return sdk;
    },

    /** Call once your game is ready to receive the player. */
    ready() {
      ready = true;
      post('arcade:ready', { title: document.title || '' });
      return sdk;
    },

    /** Optional live status update (throttle it — the hub ignores spam). */
    state(payload) {
      if (!ready) return sdk;
      post('arcade:state', payload);
      return sdk;
    },

    /** Report a finished run. The hub stores it and shows the summary card. */
    score(payload) {
      const clean = typeof payload === 'number' ? { score: payload } : (payload || {});
      post('arcade:score', {
        score: Math.max(0, Math.round(Number(clean.score) || 0)),
        day: Math.max(0, Math.round(Number(clean.day) || 0)),
        seconds: Math.max(0, Math.round(Number(clean.seconds) || 0)),
        won: Boolean(clean.won),
        meta: typeof clean.meta === 'string' ? clean.meta.slice(0, 80) : '',
      });
      return sdk;
    },

    /** Ask the hub to close the game and go back to the arcade. */
    close() {
      post('arcade:close', {});
      return sdk;
    },

    /**
     * Ask the hub to toggle fullscreen. A sandboxed frame cannot request
     * fullscreen for itself, and the hub element that holds it is the thing the
     * player wants full anyway — so the button in the game HUD routes here.
     */
    fullscreen() {
      post('arcade:fullscreen', {});
      return sdk;
    },

    /** Canvas helper: keep the backing store matched to CSS size + DPR cap. */
    fit(canvas, maxDpr) {
      const dpr = Math.min(global.devicePixelRatio || 1, maxDpr || 2);
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 960));
      const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 540));
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      return { w, h, dpr };
    },
  };

  global.addEventListener('message', (ev) => {
    const data = ev.data;
    if (!data || data.channel !== CHANNEL) return;
    if (ev.origin && ev.origin !== 'null') parentOrigin = ev.origin;
    switch (data.type) {
      case 'arcade:init': {
        sdk.player = Object.assign(sdk.player, data.payload && data.payload.player || {});
        sdk.quality = (data.payload && data.payload.quality) || 'auto';
        if (Array.isArray(data.payload && data.payload.leaderboard)) {
          sdk.leaderboard = data.payload.leaderboard;
        }
        if (!started) { started = true; emit('start', sdk.player); }
        break;
      }
      case 'arcade:message':
        emit('message', (data.payload && data.payload.text) || '');
        break;
      case 'arcade:host':
        if (data.payload === 'pause') emit('pause');
        if (data.payload === 'resume') emit('resume');
        break;
      default:
        break;
    }
  });

  // Standalone fallback so `open games/<slug>/index.html` still runs the game.
  global.addEventListener('load', () => {
    setTimeout(() => {
      if (!started) { started = true; emit('start', sdk.player); }
    }, 60);
  });

  global.Arcade = sdk;
}(window));
