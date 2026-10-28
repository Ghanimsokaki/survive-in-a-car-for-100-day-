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
