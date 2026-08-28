#!/usr/bin/env node
// Refreshes every file this repository VENDORS from ERPlora/hub — `npm run sync-mirrors`.
//
// WHAT IT REPLACES. A one-line `cp` in package.json that copied exactly one of them
// (`schemas/module.schema.json`) and read the hub's WORKING TREE. Both halves had to change when
// the kernel contract arrived (module-toolkit#115, ADR «El Hub se CIERRA como KERNEL»):
//
//   * the schema stopped being the only vendored file — `contracts/kernel/` adds six more, and a
//     file whose only way of being refreshed is by hand is a file that gets refreshed in a hurry,
//     one at a time, by whoever the mirror happened to catch;
//
//   * `cp ../hub/…` copies whatever branch the neighbouring checkout was left on, with whatever is
//     uncommitted in it. `test/canonical-mirrors.test.mjs` compares against `origin/develop`
//     (module-toolkit#90), so the old `cp` could produce a copy the mirrors then rejected — the
//     resync and the check disagreeing about what "the hub" means.
//
// So the source is resolved by the SAME code the mirrors use (`test/hub-mirror.mjs`): declared
// `ERPLORA_HUB_DIR` read from disk, otherwise the sibling `../hub` read at `origin/develop`. One
// definition of the canonical side, used by the thing that checks and by the thing that fixes.
//
// It never syncs SILENTLY: no hub, or a hub missing a file, is an error. A sync that copies nothing
// and exits 0 leaves the copies exactly as stale as they were, under a green line.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { hubSource, hubPath } from '../test/hub-mirror.mjs';
import { KERNEL_CONTRACT_FILES } from '../src/kernel-contract.mjs';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every path vendored from the hub, identical on both sides. */
export const VENDORED_FROM_THE_HUB = [
  'schemas/module.schema.json',
  ...KERNEL_CONTRACT_FILES.map((file) => `contracts/kernel/${file}`),
];

/**
 * `hubPath` skips when there is no hub, which is right for a test and wrong here: this script's
 * whole job is to copy, so "nothing to copy from" is a failure, not a quieter success.
 */
const REFUSES_TO_SKIP = {
  skip(reason) {
    throw new Error(reason);
  },
};

/**
 * Copies every vendored file from the hub into this checkout.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof hubSource>} [options.source] where the hub is, and how it is read
 * @param {string} [options.toolkitRoot] the checkout to write into
 * @param {(line: string) => void} [options.log] where the per-file report goes
 * @returns {{path: string, changed: boolean}[]} what was copied, and what it changed
 */
export function syncFromTheHub({ source = hubSource(), toolkitRoot = TOOLKIT, log = console.log } = {}) {
  if (source.kind === 'absent') {
    throw new Error(
      `there is no ERPlora/hub to sync from (looked in \`${source.dir}\`). Clone the hub alongside ` +
        'this repository, or point ERPLORA_HUB_DIR at one: copying nothing and exiting 0 would ' +
        'leave every vendored copy as stale as it is now, and report success for it.',
    );
  }

  const synced = [];
  for (const path of VENDORED_FROM_THE_HUB) {
    const canonical = hubPath(REFUSES_TO_SKIP, ...path.split('/'), source);
    const destination = join(toolkitRoot, ...path.split('/'));
    const before = existsSync(destination) ? readFileSync(destination) : null;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(canonical, destination);
    const changed = before === null || !before.equals(readFileSync(destination));
    synced.push({ path, changed });
    log(`${changed ? '↻' : '='} ${path}`);
  }
  return synced;
}

/** Run as a command: report where the hub came from, then what moved. */
function main() {
  const source = hubSource();
  const from =
    source.kind === 'declared'
      ? `ERPLORA_HUB_DIR=${source.dir} (working tree)`
      : `${source.dir} at ${source.ref}`;
  console.log(`→ syncing the vendored copies from ${from}`);
  const synced = syncFromTheHub({ source });
  const moved = synced.filter((s) => s.changed);
  console.log(
    moved.length === 0
      ? `✓ ${synced.length} vendored files, all already in sync`
      : `✓ ${synced.length} vendored files, ${moved.length} updated — commit them`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
