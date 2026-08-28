// `npm run sync-mirrors` copies what it PROMISES, or says so loudly (module-toolkit#115).
//
// The script it exercises replaces a one-line `cp` of the manifest schema. That `cp` is why this
// suite exists: it copied ONE of the vendored files, and the kernel contract (five more, ADR «El
// Hub se CIERRA como KERNEL») had no way to be refreshed except by hand — which is the same as saying
// it would drift and be resynced in a hurry, one file at a time, by whoever the mirror caught.
//
// Two failure shapes are checked on purpose, and the second is the expensive one:
//
//   1. it copies every declared file, byte for byte;
//   2. it REFUSES when it has no hub to copy from, and when the hub it was given does not carry a
//      file. A sync that finds nothing, copies nothing and exits 0 leaves the vendored copies
//      exactly as stale as they were while reporting success — the very shape (`skipped 7`, green)
//      that module-toolkit#61 was opened about.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { KERNEL_CONTRACT_FILES } from '../src/kernel-contract.mjs';
import { VENDORED_FROM_THE_HUB, syncFromTheHub } from '../scripts/sync-hub-mirrors.mjs';

/** A hub-shaped directory carrying every vendored path, each with its own recognisable body. */
function fakeHub(missing = []) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-sync-hub-'));
  for (const path of VENDORED_FROM_THE_HUB) {
    if (missing.includes(path)) continue;
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `canonical body of ${path}\n`);
  }
  return dir;
}

function scratchToolkit() {
  return mkdtempSync(join(tmpdir(), 'erplora-sync-toolkit-'));
}

test('the five kernel contract snapshots are part of what gets synced (#115, #121)', () => {
  for (const file of KERNEL_CONTRACT_FILES) {
    assert.ok(
      VENDORED_FROM_THE_HUB.includes(`contracts/kernel/${file}`),
      `${file} is declared in src/kernel-contract.mjs but \`npm run sync-mirrors\` would not ` +
        'refresh it: the mirror would then be the only thing that ever notices it drifted',
    );
  }
  assert.ok(
    VENDORED_FROM_THE_HUB.includes('schemas/module.schema.json'),
    'the manifest schema is what this script used to be — it cannot stop being synced',
  );
});

test('every declared file is copied byte for byte from the declared hub (#115)', () => {
  const hub = fakeHub();
  const toolkit = scratchToolkit();
  try {
    const synced = syncFromTheHub({
      source: { kind: 'declared', dir: hub },
      toolkitRoot: toolkit,
      log: () => {},
    });
    assert.deepEqual(
      synced.map((s) => s.path).sort(),
      [...VENDORED_FROM_THE_HUB].sort(),
      'the script reported syncing something other than what it declares',
    );
    for (const path of VENDORED_FROM_THE_HUB) {
      assert.equal(
        readFileSync(join(toolkit, path), 'utf8'),
        readFileSync(join(hub, path), 'utf8'),
        `${path} did not arrive byte for byte`,
      );
    }
  } finally {
    rmSync(hub, { recursive: true, force: true });
    rmSync(toolkit, { recursive: true, force: true });
  }
});

test('a declared hub that does not carry a file is an ERROR naming it (#115)', () => {
  const hub = fakeHub(['contracts/kernel/routes.snapshot']);
  const toolkit = scratchToolkit();
  try {
    assert.throws(
      () =>
        syncFromTheHub({ source: { kind: 'declared', dir: hub }, toolkitRoot: toolkit, log: () => {} }),
      /contracts\/kernel\/routes\.snapshot/,
      'a hub missing a vendored file has to fail naming the file, never copy the other six and ' +
        'report success',
    );
  } finally {
    rmSync(hub, { recursive: true, force: true });
    rmSync(toolkit, { recursive: true, force: true });
  }
});

test('with no hub to copy from it refuses instead of reporting a sync it did not do (#115)', () => {
  const toolkit = scratchToolkit();
  try {
    assert.throws(
      () =>
        syncFromTheHub({
          source: { kind: 'absent', dir: '/nowhere/erplora-hub' },
          toolkitRoot: toolkit,
          log: () => {},
        }),
      /ERPLORA_HUB_DIR|no hub/i,
      'no hub means no sync: exiting 0 here leaves every vendored copy stale under a green line',
    );
  } finally {
    rmSync(toolkit, { recursive: true, force: true });
  }
});
