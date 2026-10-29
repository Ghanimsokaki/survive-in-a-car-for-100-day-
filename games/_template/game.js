/* TEMPLATE GAME — copy this folder, rename it, and make something.
 * The only rules: call Arcade.ready() when you can accept input, and report a
 * score with Arcade.score({...}) when the run ends.
 */
(() => {
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');
  let t = 0;
  let running = true;

  Arcade.on('start', (player) => {
    // player = { name, color, room, custom } handed over by the hub
    document.title = `My Game — ${player.name}`;
  });

  addEventListener('click', () => {
    if (!running) return;
    running = false;
    Arcade.score({ score: Math.round(t * 10), seconds: Math.round(t), won: true, meta: 'survived' });
  });

  function frame(now) {
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;
    if (running) t += dt;
    const { w, h } = Arcade.fit(canvas, 2);
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

  Arcade.ready();
  requestAnimationFrame(frame);
})();
