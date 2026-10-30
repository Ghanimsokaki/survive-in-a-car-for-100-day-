/* TEMPLATE GAME — copy this folder, rename it, and make something.
 * The only rules: call sdk.ready() when you can accept input, and report a
 * score with sdk.score({...}) when the run ends.
 *
 * `sdk` is the hub bridge from ../_shared/sdk.js (loaded by index.html before
 * this file). The fallback below is what keeps the game playable when the SDK
 * is missing — a file:// copy, a blocked script, a sandbox that refuses it.
 * Copy it into your own game: a missing SDK must never be a ReferenceError in
 * the middle of a frame.
 */
(() => {
  const sdk = (typeof window !== 'undefined' && window.Arcade) || {
    fit(canvas, dpr = 1) {
      const w = canvas.clientWidth || 960;
      const h = canvas.clientHeight || 540;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      return { w, h, dpr };
    },
    on() {},
    ready() {},
    score() {},
  };
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let t = 0;
  let running = true;

  sdk.on('start', (player) => {
    // player = { name, color, room, custom } handed over by the hub
    document.title = `My Game — ${player.name}`;
  });

  addEventListener('click', () => {
    if (!running) return;
    running = false;
    sdk.score({ score: Math.round(t * 10), seconds: Math.round(t), won: true, meta: 'survived' });
  });

  function frame(now) {
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;
    if (running) t += dt;
    const { w, h } = sdk.fit(canvas, 2);
    ctx.fillStyle = '#0b0d12';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#6be0ff';
    ctx.font = '700 18px ui-monospace,monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`MY GAME · ${t.toFixed(1)} s`, w / 2, h / 2 - 10);
    ctx.fillStyle = '#8b93a5';
    ctx.font = '11px ui-monospace,monospace';
    ctx.fillText(running ? 'click to finish' : 'run logged', w / 2, h / 2 + 18);
    requestAnimationFrame(frame);
  }

  sdk.ready();
  requestAnimationFrame(frame);
})();
