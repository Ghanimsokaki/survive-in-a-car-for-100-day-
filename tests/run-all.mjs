/** Runs every headless suite in order and reports a single result. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: here, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

const suites = [
  ['env.test.mjs', 'VERCEL ENV → BROWSER'],
  ['game.test.mjs', 'SIMULATION'],
  ['interiors-admin.test.mjs', 'INTERIORS + OWNER CONSOLE'],
  ['loot-inventory.test.mjs', 'LOOT + INVENTORY + RECIPES'],
  ['account.test.mjs', 'ACCOUNTS + FRIENDS'],
  ['app.test.mjs', 'GUEST UI FLOW'],
  ['app-auth.test.mjs', 'SIGNED-IN FRIENDS UI'],
  ['hud-frame.test.mjs', 'HUD FRAME + ORIENTATION'],
  ['modes-avatar.test.mjs', 'GAME MODES + PERF + AVATAR'],
  ['tornado-anchor.test.mjs', 'TORNADO LAB + ANCHOR CRAFTING'],
  ['records-storm.test.mjs', 'RECORDS + STORM METER'],
  ['arcade.test.mjs', 'ARCADE + COMMUNITY GAMES'],
  ['games-paths.test.mjs', 'GAMES UNDER VERCEL URL RULES'],
  ['fleet.test.mjs', 'FLEET BUILDER + AUTO LANDSCAPE'],
  ['boot.test.mjs', 'FAST BOOT + PORTRAIT HOME + SUPABASE RELAY'],
  ['graphics.test.mjs', 'GRAPHICS TIERS + FULLSCREEN'],
  ['iron-tide-water.test.mjs', 'IRON TIDE — WATER PHYSICS'],
  ['iron-tide-boot.test.mjs', 'IRON TIDE — FAST BOOT + DOCK'],
  ['player-profile.test.mjs', 'ACCOUNT PICTURE + SETTINGS'],
  ['p2p.test.mjs', 'P2P PROTOCOL (WEBRTC)'],
  ['p2p-e2e.test.mjs', 'P2P ROOMS — HOST + GUESTS'],
  ['p2p-net-e2e.test.mjs', 'P2P LANE — THROUGH net.js'],
  ['net-supabase.test.mjs', 'SUPABASE-FIRST MULTIPLAYER'],
  ['net-e2e.test.mjs', 'SUPABASE ROOMS — LIVE SOCKET'],
  ['lobby.test.mjs', 'LOBBY + MATCHMAKING CODES'],
  ['cors.test.mjs', 'CORS POLICY'],
  ['socket-e2e.test.mjs', 'SOCKET.IO SERVER — LIVE ROOMS'],
  ['keepalive.test.mjs', 'RENDER KEEP-ALIVE'],
  ['brand.test.mjs', 'GEMBY BRAND + SERVER CONTRACT'],
];

await run(process.execPath, ['build.mjs']);

const results = [];
for (const [file, label] of suites) {
  console.log(`\n──────── ${label} ────────`);
  const code = await run(process.execPath, [file]);
  results.push([label, code]);
}

console.log('\n════════ SUMMARY ════════');
for (const [label, code] of results) console.log(`${code === 0 ? 'PASS' : 'FAIL'}  ${label}`);
const failed = results.filter(([, code]) => code !== 0);
process.exit(failed.length ? 1 : 0);
