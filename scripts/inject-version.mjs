/**
 * Fill the __VERSION__ placeholder in the compiled output with the version from
 * package.json.
 *
 * Needed because the bundle would otherwise have to import package.json at
 * runtime, whose relative path changes once the file is published under dist/.
 *
 * Runs as part of `npm run build`.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const marker = '__VERSION__';

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (typeof version !== 'string' || !version) {
  console.error('inject-version: package.json has no version');
  process.exit(1);
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (entry.endsWith('.js') || entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

let patched = 0;
for (const file of walk(join(root, 'dist'))) {
  const source = readFileSync(file, 'utf8');
  if (!source.includes(marker)) continue;
  writeFileSync(file, source.replaceAll(marker, version));
  patched++;
}

// Verify rather than trust the count: a surviving placeholder is invisible when
// it lands in a .d.ts, and very visible when a binary prints `gf __VERSION__`.
const missed = walk(join(root, 'dist')).filter((f) => readFileSync(f, 'utf8').includes(marker));
if (missed.length > 0) {
  console.error(`inject-version: placeholder survived in: ${missed.join(', ')}`);
  process.exit(1);
}

if (patched === 0) {
  console.error(`inject-version: no "${marker}" placeholder found in dist/ — did the build run?`);
  process.exit(1);
}
console.log(`inject-version: stamped ${version} into ${patched} file(s)`);
