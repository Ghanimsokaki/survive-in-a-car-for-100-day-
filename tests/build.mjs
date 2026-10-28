/**
 * Copies public/js into tests/app/js with the vendored three.js import swapped
 * for the headless shim, so the browser modules can run under Node.
 */
import { cp, rm, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'public', 'js');
const dest = path.join(here, 'app', 'js');

await rm(path.join(here, 'app'), { recursive: true, force: true });
await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true });

for (const file of await readdir(dest)) {
  if (!file.endsWith('.js')) continue;
  const p = path.join(dest, file);
  const code = await readFile(p, 'utf8');
  await writeFile(p, code.replace(/'\.\.\/vendor\/three\.module\.js'/g, "'../../three-shim.js'"));
}
console.log('prepared tests/app/js');
