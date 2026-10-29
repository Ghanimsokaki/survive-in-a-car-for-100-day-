/**
 * Community game scanner.
 *
 * Every game in this arcade is a folder under ./games with a `game.json`
 * manifest. This module finds them, validates them hard (a bad manifest must
 * never break the hub for everyone else) and writes ./games/index.json, which
 * is the catalogue the lobby reads at runtime.
 *
 * Run directly:   node scripts/scan-games.mjs        → writes games/index.json
 * Called by:      scripts/build.mjs (before copying into dist/)
 *
 * Submitting a game = open a PR that adds games/<slug>/. Nothing else.
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST = 'game.json';
export const MAX_ASSET_BYTES = 18 * 1024 * 1024;   // one folder, all files
export const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const SEMVER = /^\d+\.\d+\.\d+$/;
export const SAFE_PATH = /^[A-Za-z0-9._\-\/]+$/;
const RESERVED = new Set(['index.json', 'readme.md', '_template', 'template', 'node_modules']);

/** Fields a manifest may carry; anything else is dropped (never trusted). */
const TAGS_MAX = 5;
const TAG_SLUG = /^[a-z0-9-]{1,18}$/;

function titleCaseId(id) {
  return id.split('-').map((w) => w.toUpperCase()).join(' ');
}

/**
 * Validates one manifest object.
 * @returns {{ ok: boolean, errors: string[], game?: object }}
 */
export function validateManifest(raw, folder) {
  const errors = [];
  const m = raw && typeof raw === 'object' ? raw : {};
  const id = String(m.id || folder || '').trim().toLowerCase();

  if (!SLUG.test(id)) errors.push(`id must be a slug (a-z, 0-9, -), got "${m.id}"`);
  else if (id !== folder) errors.push(`id "${id}" must match the folder name "${folder}"`);

  const title = String(m.title || titleCaseId(id)).trim().slice(0, 40);
  if (!title) errors.push('title is required');

  const author = String(m.author || 'anonymous').trim().toLowerCase().slice(0, 24);
  if (!/^[a-z0-9_.-]{2,24}$/.test(author)) errors.push(`author "${author}" is not a valid username`);

  const blurb = String(m.blurb || '').trim().slice(0, 160);
  if (!blurb) errors.push('blurb is required (one line, what is the game?)');

  const version = String(m.version || '1.0.0').trim();
  if (!SEMVER.test(version)) errors.push(`version must be x.y.z, got "${m.version}"`);

  const entry = String(m.entry || 'index.html').trim();
  if (!SAFE_PATH.test(entry) || entry.startsWith('/') || entry.includes('..')) {
    errors.push(`entry "${entry}" must be a relative path inside the game folder`);
  }

  const icon = String(m.icon || 'icon.svg').trim();
  if (!SAFE_PATH.test(icon) || icon.startsWith('/') || icon.includes('..')) {
    errors.push(`icon "${icon}" must be a relative path inside the game folder`);
  }

  const tagsRaw = Array.isArray(m.tags) ? m.tags : [];
  const tags = tagsRaw
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => TAG_SLUG.test(t))
    .slice(0, TAGS_MAX);
  if (tagsRaw.length && !tags.length) errors.push('tags must be short slugs like "co-op"');

  const accent = /^#[0-9a-fA-F]{6}$/.test(String(m.accent || '')) ? String(m.accent) : '#6be0ff';
  const players = String(m.players || '1').slice(0, 8);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    game: {
      id,
      title: title.toUpperCase(),
      author,
      blurb,
      version,
      entry,
      icon,
      tags,
      accent,
      players,
      featured: Boolean(m.featured),
      // filled in by the scanner after the files are measured
      files: 0,
      bytes: 0,
    },
  };
}

/** Sorts the catalogue: featured first, then alphabetical. */
export function sortCatalogue(games) {
  return [...games].sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

async function dirSize(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await dirSize(p);
      files += inner.files;
      bytes += inner.bytes;
    } else {
      const s = await stat(p);
      files += 1;
      bytes += s.size;
    }
  }
  return { files, bytes };
}

/**
 * Scans a games directory.
 * @returns {{ catalogue: object, skipped: Array<{folder:string, errors:string[]}> }}
 */
export async function scanGames(gamesDir) {
  const skipped = [];
  const games = [];
  let entries = [];
  try {
    entries = await readdir(gamesDir, { withFileTypes: true });
  } catch {
    return { catalogue: { version: 1, count: 0, games: [] }, skipped };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folder = entry.name;
    if (RESERVED.has(folder.toLowerCase()) || folder.startsWith('.') || folder.startsWith('_')) continue;

    const dir = path.join(gamesDir, folder);
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(dir, MANIFEST), 'utf8'));
    } catch (e) {
      skipped.push({ folder, errors: [`no readable ${MANIFEST} (${e.code || e.message})`] });
      continue;
    }

    const checked = validateManifest(raw, folder);
    if (!checked.ok) { skipped.push({ folder, errors: checked.errors }); continue; }

    const game = checked.game;
    // the manifest may not point outside its own folder, and the files must exist
    for (const rel of [game.entry, game.icon]) {
      const target = path.join(dir, rel);
      if (!target.startsWith(dir + path.sep)) {
        skipped.push({ folder, errors: [`${rel} escapes the game folder`] });
        break;
      }
      try {
        await stat(target);
      } catch {
        skipped.push({ folder, errors: [`${rel} is missing`] });
        break;
      }
    }
    if (skipped.some((s) => s.folder === folder)) continue;

    const size = await dirSize(dir);
    if (size.bytes > MAX_ASSET_BYTES) {
      skipped.push({ folder, errors: [`folder is ${(size.bytes / 1048576).toFixed(1)} MB, limit is ${MAX_ASSET_BYTES / 1048576} MB`] });
      continue;
    }
    game.files = size.files;
    game.bytes = size.bytes;
    game.path = `games/${folder}`;
    games.push(game);
  }

  const ordered = sortCatalogue(games);
  return {
    catalogue: {
      version: 1,
      generatedAt: new Date().toISOString(),
      count: ordered.length,
      games: ordered,
    },
    skipped,
  };
}

/** Writes games/index.json. Returns the catalogue. */
export async function writeCatalogue(gamesDir, outFile = path.join(gamesDir, 'index.json')) {
  const { catalogue, skipped } = await scanGames(gamesDir);
  await writeFile(outFile, `${JSON.stringify(catalogue, null, 2)}\n`, 'utf8');
  return { catalogue, skipped };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const gamesDir = path.join(root, 'games');
  const { catalogue, skipped } = await writeCatalogue(gamesDir);
  console.log(`\n  games/index.json · ${catalogue.count} game${catalogue.count === 1 ? '' : 's'}`);
  for (const g of catalogue.games) {
    console.log(`    ${g.featured ? '★' : '·'} ${g.id.padEnd(20)} ${g.title}`);
  }
  for (const s of skipped) {
    console.log(`    ⚠ skipped ${s.folder}: ${s.errors.join('; ')}`);
  }
  console.log('');
}
