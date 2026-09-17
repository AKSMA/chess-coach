#!/usr/bin/env node
/**
 * Fetches the Stockfish lite-single WASM build into public/engine/.
 *
 * We deliberately do NOT depend on the `stockfish` npm package: its `files`
 * field is `["bin/"]`, so installing it downloads all five engine flavours
 * (~251 MB) in order to use ~7 MB of it. These two files are the whole engine.
 *
 * Pinned to the exact npm version via the unpkg CDN, and hash-checked, so this
 * is reproducible without the dependency.
 *
 * Stockfish is GPL-3.0 (c) Chess.com, LLC — see README.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '18.0.8';

/** sha256 verified on 2026-07-31 against unpkg.com/stockfish@18.0.8 */
const FILES = [
  {
    name: 'stockfish-18-lite-single.js',
    sha256: '5243fd9b276cab7dfe3ad1d43ab9ead73568fac76468c614242977a210c4a391',
  },
  {
    name: 'stockfish-18-lite-single.wasm',
    sha256: 'a8fbc05ec6920b56d7485826dcb02c5ffd2826bcbf751cf973046f237a9096f1',
  },
];

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'engine');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function existingIsValid(path, expected) {
  try {
    return sha256(await readFile(path)) === expected;
  } catch {
    return false;
  }
}

async function fetchOne({ name, sha256: expected }) {
  const dest = join(outDir, name);

  if (await existingIsValid(dest, expected)) {
    console.log(`  ${name} — already present`);
    return;
  }

  const url = `https://unpkg.com/stockfish@${VERSION}/bin/${name}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText} from ${url}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(
      `${name}: hash mismatch.\n  expected ${expected}\n  actual   ${actual}\n` +
        `Refusing to write. If the upstream package legitimately changed, update FILES in this script.`,
    );
  }

  await writeFile(dest, buf);
  console.log(`  ${name} — ${(buf.length / 1e6).toFixed(1)} MB, hash ok`);
}

/**
 * The engine build is CommonJS, but our package.json sets `"type": "module"`,
 * which would make Node treat any .js under it as ESM and die on `require`.
 * A scoped marker here overrides that for this directory only.
 *
 * The browser is unaffected either way: it loads the file as a *classic*
 * Worker, not a module.
 */
async function writeCjsMarker() {
  await writeFile(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
}

async function main() {
  console.log(`Fetching Stockfish ${VERSION} (lite, single-threaded) into public/engine/`);
  await mkdir(outDir, { recursive: true });
  for (const file of FILES) await fetchOne(file);
  await writeCjsMarker();
  console.log('Engine ready.');
}

main().catch((err) => {
  console.error(`\nEngine fetch failed: ${err.message}`);
  console.error('The app cannot analyse positions without it. Retry with `npm run engine:fetch`.');
  process.exit(1);
});
