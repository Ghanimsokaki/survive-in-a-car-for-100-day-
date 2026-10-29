/**
 * Copies the static game into ./dist for Vercel / any static host, and bakes
 * the Supabase credentials found in the environment into dist/config.json.
 *
 * That build-time file is the fallback for hosts where serverless functions are
 * unavailable or misconfigured: the client tries /api/config first, then
 * ./config.json. Only the anon / publishable key is ever written.
 */
import { cp, rm, mkdir, readdir, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicConfig, resolveSupabaseConfig, URL_VARS, KEY_VARS } from '../lib/supabase-env.mjs';
import { writeCatalogue } from './scan-games.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'public');
const dest = path.join(root, 'dist');

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

// ------------------------------------------------------- community games
// The manifest scan runs at build time so a merged PR is playable without any
// hand-editing of index.json, and dist/games always matches the repo.
const gamesSrc = path.join(root, 'games');
const gamesDest = path.join(dest, 'games');
let gameCount = 0;
let skippedGames = [];
try {
  const scan = await writeCatalogue(gamesSrc, path.join(gamesSrc, 'index.json'));
  gameCount = scan.catalogue.count;
  skippedGames = scan.skipped;
  await mkdir(gamesDest, { recursive: true });
  for (const entry of await readdir(gamesSrc)) {
    if (entry === 'node_modules') continue;
    await cp(path.join(gamesSrc, entry), path.join(gamesDest, entry), { recursive: true });
  }
} catch (e) {
  console.log(`  warning: could not bundle community games (${e.message})`);
}

// ---------------------------------------------------------------- env → dist
const resolved = resolveSupabaseConfig(process.env);
const config = publicConfig(process.env, 'build');
await writeFile(path.join(dest, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');

// optional inline fallback for file:// or hosts that block JSON fetches
const inline = `// generated at build time — public anon credentials only\nglobalThis.__SUPABASE__ = ${JSON.stringify({
  url: resolved.url,
  key: resolved.key,
})};\n`;
await writeFile(path.join(dest, 'supabase-config.js'), inline, 'utf8');

// inject the inline fallback script into the built HTML only
try {
  const htmlPath = path.join(dest, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  if (!html.includes('supabase-config.js')) {
    const patched = html.replace(
      '<script type="module" src="./js/main.js"></script>',
      '<script src="./supabase-config.js"></script>\n<script type="module" src="./js/main.js"></script>',
    );
    await writeFile(htmlPath, patched, 'utf8');
  }
} catch (e) {
  console.log(`  warning: could not inject inline config script (${e.message})`);
}

console.log('');
if (resolved.configured) {
  console.log(`  supabase accounts: configured`);
  console.log(`    url: ${resolved.url}   (from ${resolved.urlVar})`);
  console.log(`    key: ${resolved.keyVar} (${resolved.keyKind}${resolved.key.length ? `, ${resolved.key.length} chars` : ''})`);
  if (resolved.urlFromKey) console.log('    note: project URL was derived from the key\'s project ref');
} else {
  console.log('  supabase accounts: NOT configured — the build runs in guest mode');
  for (const problem of resolved.problems) console.log(`    · ${problem}`);
  console.log(`    looked for URL vars: ${URL_VARS.slice(0, 3).join(', ')} …`);
  console.log(`    looked for KEY vars: ${KEY_VARS.slice(0, 3).join(', ')} …`);
  console.log('    (Vercel: Settings → Environment Variables, then Redeploy)');
}
console.log('');

// ------------------------------------------------------------------- summary
let files = 0, bytes = 0;
async function walk(dir) {
  for (const entry of await readdir(dir)) {
    const p = path.join(dir, entry);
    const s = await stat(p);
    if (s.isDirectory()) await walk(p);
    else { files++; bytes += s.size; }
  }
}
await walk(dest);
console.log(`built dist/ · ${files} files · ${(bytes / 1024 / 1024).toFixed(2)} MB · config.json ${resolved.configured ? 'ready' : 'guest-only'}`);
console.log(`  arcade: ${gameCount} community game${gameCount === 1 ? '' : 's'} bundled`);
for (const s of skippedGames) console.log(`    ⚠ skipped ${s.folder}: ${s.errors.join('; ')}`);
