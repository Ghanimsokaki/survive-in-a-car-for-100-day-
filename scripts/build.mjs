/** Copies the static game into ./dist for Vercel / any static host. */
import { cp, rm, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'public');
const dest = path.join(root, 'dist');

await rm(dest, { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

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
console.log(`built dist/ · ${files} files · ${(bytes / 1024 / 1024).toFixed(2)} MB`);
