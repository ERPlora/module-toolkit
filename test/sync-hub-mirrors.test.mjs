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
import { VENDORED_FROM_THE_HUB, syncFromTheHub, theHubItReallyIs } from '../scripts/sync-hub-mirrors.mjs';

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
  assert.ok(
    VENDORED_FROM_THE_HUB.includes('schemas/flow.schema.json'),
    'the flow document schema (module-toolkit#209) is vendored too: left out of the sync, the ' +
      'only thing that would ever notice it drifted is the mirror that fails the build',
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

// ── The hub it copies FROM has to be the hub, not a snapshot of it (module-toolkit#249) ─────────
//
// The trap this closes was measured on 2026-09-09, in this very repository, on the resync of
// `schemas/flow.schema.json` after hub#1713: the sibling `../hub` checkout is SHARED by the whole
// fleet, and its `origin/develop` is a LOCAL ref — only as fresh as the last `git fetch` somebody
// happened to run in it. Nobody had. `npm run sync-mirrors` would have copied the OLD schema over
// the old schema, printed `✓ 7 vendored files, all already in sync`, and exited 0: a resync that
// resynced nothing, reporting success, on the branch opened to fix precisely that drift.
//
// The tests above cover the OTHER silence — copying nothing because there is no hub. This one is
// worse, because there is a hub and every file arrives: what is stale is the ref, and nothing in
// the output says so. So the source is verified against the hub's own remote before a byte moves.
//
// The DECLARED hub (`ERPLORA_HUB_DIR`) is deliberately exempt, and that is not an oversight: the
// pair flow (a contract change in the hub and its mirror here, `Depends-On:` both ways) syncs from
// a hub WORKTREE carrying a commit that is not in `develop` yet, and CI declares a tarball with no
// `.git` at all. "Read this tree" is an accepted promise there; "the sibling at origin/develop" is
// a claim about the hub, and a claim gets checked.
import { readdirSync } from 'node:fs';

const BEHIND = '0000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const AHEAD = '1111111bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * A git runner answering what the test dictates, recording every call. Keyed by the git
 * subcommand, so a test says "rev-parse says X, ls-remote says Y" and nothing else.
 */
function fakeGit(answers) {
  const calls = [];
  const run = (dir, args) => {
    calls.push({ dir, args });
    const answer = answers[args[0]];
    if (!answer) return { status: 128, stdout: '', stderr: `fake git: unexpected \`${args[0]}\`` };
    return { status: 0, stdout: '', stderr: '', ...answer };
  };
  run.calls = calls;
  return run;
}

const SIBLING = { kind: 'git', dir: '/nowhere/erplora-hub', ref: 'origin/develop' };

test('a sibling hub whose `origin/develop` is behind its remote is REFUSED before copying (#249)', () => {
  const toolkit = scratchToolkit();
  try {
    assert.throws(
      () =>
        syncFromTheHub({
          source: SIBLING,
          toolkitRoot: toolkit,
          log: () => {},
          git: fakeGit({
            'rev-parse': { stdout: `${BEHIND}\n` },
            'ls-remote': { stdout: `${AHEAD}\trefs/heads/develop\n` },
          }),
        }),
      (error) => {
        assert.match(error.message, /fetch/, 'the error has to say how to fix it');
        assert.match(error.message, new RegExp(BEHIND.slice(0, 7)), 'names what it would have copied');
        assert.match(error.message, new RegExp(AHEAD.slice(0, 7)), 'names what the hub actually is');
        return true;
      },
      'a stale ref copies a stale hub and reports success — the exact resync-that-resyncs-nothing ' +
        'that module-toolkit#249 was opened about',
    );
    assert.deepEqual(
      readdirSync(toolkit),
      [],
      'it refused AFTER copying: half the vendored files would then come from the stale ref',
    );
  } finally {
    rmSync(toolkit, { recursive: true, force: true });
  }
});

test('a remote that cannot be asked is REFUSED too: an unprovable sync is the silent one (#249)', () => {
  const toolkit = scratchToolkit();
  try {
    assert.throws(
      () =>
        syncFromTheHub({
          source: SIBLING,
          toolkitRoot: toolkit,
          log: () => {},
          git: fakeGit({
            'rev-parse': { stdout: `${BEHIND}\n` },
            'ls-remote': { status: 128, stderr: 'fatal: could not read Username for https://github.com' },
          }),
        }),
      // Narrow ON PURPOSE. `/fetch/` would also match the error `git archive` raises for a path
      // missing from the ref, so the test would pass with no guard at all — measured while writing
      // it: the first version was green before a line of the check existed.
      /ls-remote/,
      'no answer from the remote means the copy cannot be shown to be the hub\'s — and a sync ' +
        'nobody can prove is fresh is exactly the one that ships a stale schema under a green line',
    );
  } finally {
    rmSync(toolkit, { recursive: true, force: true });
  }
});

test('a DECLARED hub is never checked against develop — the pair flow syncs from a worktree (#249)', () => {
  const hub = fakeHub();
  const toolkit = scratchToolkit();
  const git = fakeGit({});
  try {
    syncFromTheHub({ source: { kind: 'declared', dir: hub }, toolkitRoot: toolkit, log: () => {}, git });
    assert.deepEqual(
      git.calls,
      [],
      'ERPLORA_HUB_DIR means "read THIS tree": a hub worktree carrying an unmerged contract ' +
        'change, or a CI tarball with no `.git`, would fail a freshness check that has no business ' +
        'running there',
    );
    for (const path of VENDORED_FROM_THE_HUB) {
      assert.equal(readFileSync(join(toolkit, path), 'utf8'), readFileSync(join(hub, path), 'utf8'));
    }
  } finally {
    rmSync(hub, { recursive: true, force: true });
    rmSync(toolkit, { recursive: true, force: true });
  }
});

// And the same guard against REAL git (module-toolkit#249). The three tests above inject the
// runner, so they prove the DECISION and nothing about the argv: a `rev-parse` with the wrong
// spelling, or an `ls-remote` whose output is parsed by the wrong column, would answer the fake
// perfectly and refuse — or accept — every real checkout. Two temporary repositories and a `file:`
// remote cost ~200 ms and need no network.
import { spawnSync } from 'node:child_process';

/** git, run for the fixtures below. Identity is passed per command: a runner may have none. */
function git(dir, ...args) {
  const done = spawnSync(
    'git',
    ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@erplora.test', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8' },
  );
  assert.equal(done.status, 0, `git ${args.join(' ')} failed: ${done.stderr}`);
  return done.stdout.trim();
}

/** A `develop` branch with one commit, and a clone of it that tracks `origin/develop`. */
function hubAndAClone() {
  const remote = mkdtempSync(join(tmpdir(), 'erplora-hub-remote-'));
  git(remote, 'init', '-q', '-b', 'develop');
  writeFileSync(join(remote, 'schema.json'), '{"v":1}\n');
  git(remote, 'add', '-A');
  git(remote, 'commit', '-qm', 'first');
  const parent = mkdtempSync(join(tmpdir(), 'erplora-hub-clone-'));
  const clone = join(parent, 'hub');
  assert.equal(spawnSync('git', ['clone', '-q', remote, clone]).status, 0, 'could not clone');
  return { remote, parent, clone };
}

test('against real git: the clone is accepted, and REFUSED once the hub moves on (#249)', () => {
  const { remote, parent, clone } = hubAndAClone();
  const source = { kind: 'git', dir: clone, ref: 'origin/develop' };
  try {
    assert.equal(
      theHubItReallyIs(source),
      git(remote, 'rev-parse', 'HEAD'),
      'a clone nobody has outrun is the hub, and the guard has to say so — a check that refuses ' +
        'every checkout is not a check, it is an outage',
    );

    writeFileSync(join(remote, 'schema.json'), '{"v":2,"within_last":true}\n');
    git(remote, 'add', '-A');
    git(remote, 'commit', '-qm', 'the contract moves on');
    const moved = git(remote, 'rev-parse', 'HEAD');

    assert.throws(
      () => theHubItReallyIs(source),
      (error) => {
        assert.match(error.message, new RegExp(moved.slice(0, 7)), 'names the commit the hub is at');
        assert.match(error.message, /fetch/, 'names what to run');
        return true;
      },
      'THE case of #249: the hub merged, this checkout never fetched, and its `origin/develop` ' +
        'still answers with the schema of yesterday',
    );

    // The remedy the message prints has to be the one that works — an error that recommends a
    // command that does not fix it is how a guard gets worked around instead of obeyed.
    git(clone, 'fetch', '-q', 'origin', 'develop');
    assert.equal(theHubItReallyIs(source), moved, 'after the fetch it recommends, the guard passes');
  } finally {
    rmSync(remote, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
  }
});
