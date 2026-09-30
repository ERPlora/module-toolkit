// Two `erplora dev` previews of the same module, open at once, each serve their OWN build —
// module-toolkit#432.
//
// The preview used to compile into `$TMPDIR/erplora-dev-<module id>`, a folder fixed by the id. A
// developer comparing a branch with main (two worktrees, two ports, same module) got whichever
// build finished last on BOTH ports, with no warning: the "main" tab showed the branch. Each
// preview now builds into a folder of its own and removes it when it closes.
//
// These tests start the REAL preview server twice, from two workspaces whose module has the same
// id but different code, and read the bundle each port serves. `TMPDIR` points at a private folder
// so the test sees exactly what the preview leaves behind; `npm` is a fake that is offline, so the
// preview falls back to the toolkit's own OutfitKit without touching the network or `~/.cache`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startDev } from '../src/dev.mjs';

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const root = mkdtempSync(join(tmpdir(), 'erplora-dev-outdir-'));
const previewTmp = join(root, 'tmp');
const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(root, 'cache') };
let savedTmpdir;

before(() => {
  write(join(root, 'bin', 'npm'), '#!/usr/bin/env bash\necho "npm error network ENOTFOUND" >&2\nexit 1\n');
  chmodSync(join(root, 'bin', 'npm'), 0o755);
  mkdirSync(previewTmp, { recursive: true });
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = previewTmp;
});

after(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(root, { recursive: true, force: true });
});

/** A workspace holding module `demo` whose Web Component stamps `marker` into the bundle. */
function workspace(marker) {
  const ws = join(root, marker);
  write(join(ws, 'demo', 'module.json'), JSON.stringify({ id: 'demo', name: 'demo', version: '1.0.0' }));
  write(join(ws, 'demo', 'ui/components/erp-demo/erp-demo.ts'), `globalThis.__previewOf = ${JSON.stringify(marker)};\nexport const x = 1;\n`);
  return join(ws, 'demo');
}

async function open(dir) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await startDev(dir, { port: 0, outfitkit: { env } });
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

async function harness(handle) {
  const res = await fetch(`http://localhost:${handle.port}/harness.js`);
  assert.equal(res.status, 200);
  return res.text();
}

const buildDirs = () => readdirSync(previewTmp);

test('two previews of the same module open at once each serve their own build', async () => {
  const main = await open(workspace('main-worktree'));
  let branch;
  try {
    branch = await open(workspace('branch-worktree'));
    const onMain = await harness(main);
    const onBranch = await harness(branch);
    assert.ok(onMain.includes('main-worktree'), 'the main preview serves the main build');
    assert.ok(!onMain.includes('branch-worktree'), 'the main preview serves the build of the branch opened after it');
    assert.ok(onBranch.includes('branch-worktree'), 'the branch preview serves the branch build');

    // Closing one preview leaves the other one serving its own build.
    await branch.close();
    branch = null;
    const stillMain = await harness(main);
    assert.ok(stillMain.includes('main-worktree') && !stillMain.includes('branch-worktree'));
  } finally {
    if (branch) await branch.close();
    await main.close();
  }
});

test('a preview removes its build folder when it closes', async () => {
  const before = buildDirs();
  const handle = await open(workspace('closing'));
  try {
    const during = buildDirs().filter((d) => !before.includes(d));
    assert.equal(during.length, 1, `the preview builds into one folder of its own: ${during.join(', ')}`);
  } finally {
    await handle.close();
  }
  assert.deepEqual(buildDirs(), before, 'the build folder is left behind after the preview closed');
});
