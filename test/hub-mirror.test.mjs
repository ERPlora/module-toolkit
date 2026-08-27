// The mirrors' door: when is "the hub is not here" a skip, and when is it a FAILURE
// (module-toolkit#61).
//
// THE HOLE. `canonical-mirrors.test.mjs` guards six things the toolkit copies by hand from
// ERPlora/hub, and every one of them opens with the same line:
//
//     if (!existsSync(canonical)) return t.skip('ERPlora/hub is not in this checkout');
//
// A guard that skips does not deny — it stays OPEN, and a silent skip is indistinguishable from a
// PASS in a run summary. Measured on 2026-08-20: `CI=1` with no hub gives `tests 7 · pass 0 ·
// fail 0 · skipped 7`, and the job is GREEN.
//
// The expensive case is not the absent hub — it is the DECLARED one. A worker ran the suite from a
// worktree, where `../hub` does not exist, reported "full suite green, canonical-mirrors included",
// and canonical-mirrors had not run at all. The same thing happens to anyone who exports
// `ERPLORA_HUB_DIR` with a typo, or points it at a checkout that has moved: the promise "compare
// against THIS hub" is accepted and then quietly dropped.
//
// THE CONTRACT. Declaring a hub is a promise. If it cannot be kept, that is an ERROR — never a
// skip. Not declaring one is honest, and stays a skip: the toolkit's own CI has no hub and cannot
// get one (organization secrets do not reach private repositories on the free plan, so there is no
// credential for a cross-repo checkout), which is why the drift is gated from the HUB's side
// instead — see `.github/actions/check-canonical-mirrors`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hubPath, hubDir, hubSource } from './hub-mirror.mjs';

/** A stand-in for node's `t`, recording whether `skip` was called and with what reason. */
function fakeT() {
  const calls = [];
  return { calls, skip: (reason) => calls.push(reason) };
}

test('a hub that is DECLARED and not there is an error, never a skip (#61)', () => {
  const t = fakeT();
  assert.throws(
    () => hubPath(t, 'schemas', 'module.schema.json', { hubDir: '/nonexistent-hub-61', declared: true }),
    /nonexistent-hub-61/,
    'a declared hub that cannot be read has to fail: the promise was accepted and then dropped',
  );
  assert.deepEqual(t.calls, [], 'it must not have skipped on the way out');
});

test('the error names the variable that made the promise, so the fix is obvious (#61)', () => {
  const t = fakeT();
  assert.throws(
    () => hubPath(t, 'schemas', 'module.schema.json', { hubDir: '/nonexistent-hub-61', declared: true }),
    /ERPLORA_HUB_DIR/,
  );
});

test('no hub declared and none alongside is an honest skip (#61)', () => {
  const t = fakeT();
  const found = hubPath(t, 'schemas', 'module.schema.json', { hubDir: '/nonexistent-hub-61', declared: false });
  assert.equal(found, null, 'nothing to compare against');
  assert.equal(t.calls.length, 1, 'it skips');
  assert.match(t.calls[0], /hub/i);
});

test('a hub that IS there returns the path, declared or not (#61)', () => {
  for (const declared of [true, false]) {
    const t = fakeT();
    const found = hubPath(t, 'schemas', 'module.schema.json', { hubDir: hubDirOfThisRepoStandIn(), declared });
    assert.ok(found?.endsWith('module.schema.json'), `declared=${declared}: it returns the file`);
    assert.deepEqual(t.calls, [], `declared=${declared}: nothing is skipped when the file is there`);
  }
});

/** This repository has `schemas/module.schema.json` too, so it stands in for a hub in this test. */
function hubDirOfThisRepoStandIn() {
  return new URL('..', import.meta.url).pathname;
}

test('hubDir() reports whether the hub was DECLARED or merely found alongside (#61)', () => {
  assert.deepEqual(hubDir({ ERPLORA_HUB_DIR: '/somewhere' }), { dir: '/somewhere', declared: true });
  const fallback = hubDir({});
  assert.equal(fallback.declared, false);
  assert.match(fallback.dir, /hub$/, 'it falls back to the sibling checkout');
});

// ── The reference is `origin/develop`, never a working tree (module-toolkit#90) ────────────────
//
// THE SECOND HOLE, and it is the mirror image of the first. `hubPath` returned a path on DISK of
// the sibling `../hub` checkout, and the mirrors `readFileSync`d it — so they compared against
// whatever branch that checkout happened to be on, with whatever was uncommitted in it. That is
// somebody else's work in progress, not a canonical source.
//
// Measured on 2026-08-28 (`module-toolkit@origin/main dd0686a`, sibling `hub` on
// `fix/blueprint-media-auth`): `schemas/module.schema.json` was IDENTICAL to hub `origin/develop`
// and the mirror still failed. Three workers in a row reported it as "pre-existing failure on
// main, not mine" — right about the second half, wrong about the first. A guard that cries wolf
// gets muted, which costs more than the drift it was watching for.
//
// THE CONTRACT. Three sources, in this order:
//
//   1. `ERPLORA_HUB_DIR` — a DECLARED hub, read from disk. That is what the hub's own CI passes
//      (`.github/actions/check-canonical-mirrors`), where the working tree IS the thing under
//      test: it is the pull request's checkout. Missing file → error (module-toolkit#61).
//   2. the sibling `../hub` checkout, read at `origin/develop` through git — never its working
//      tree, never its branch. Missing file in that ref → error naming the ref, because a stale
//      `origin/develop` is a `git fetch` away and silence would be the same false red again.
//   3. no hub at all → an honest skip.
const CANONICAL = '{ "canonical": true }\n';
const DRIFTED_IN_THE_WORKING_TREE = '{ "canonical": false }\n';

/**
 * A hub-shaped git repository whose `origin/develop` carries `CANONICAL`, checked out on another
 * branch and with the file rewritten in the working tree — the exact shape of the false red.
 */
function hubCheckoutOnAnotherBranch() {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-hub-mirror-fixture-'));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'feature/somebody-elses-work');
  git('config', 'user.email', 'test@erplora.com');
  git('config', 'user.name', 'test');
  const file = join(dir, 'schemas', 'module.schema.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, CANONICAL);
  git('add', 'schemas/module.schema.json');
  git('commit', '-qm', 'canonical');
  // A remote-tracking ref, as a real checkout has it after a fetch.
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD');
  writeFileSync(file, DRIFTED_IN_THE_WORKING_TREE);
  return dir;
}

test('a sibling hub is read at origin/develop, not at its working tree (#90)', () => {
  const t = fakeT();
  const dir = hubCheckoutOnAnotherBranch();
  const found = hubPath(t, 'schemas', 'module.schema.json', {
    kind: 'git',
    dir,
    ref: 'origin/develop',
  });
  assert.deepEqual(t.calls, [], 'a readable hub is never a skip');
  assert.equal(
    readFileSync(found, 'utf8'),
    CANONICAL,
    'the mirrors compared against the checkout\'s working tree: whatever branch it sits on, with ' +
      'whatever is uncommitted in it, decides whether 25 module repos see a red gate (#90)',
  );
});

test('a directory comes out of the ref whole, so the .vue walk still works (#90)', () => {
  const t = fakeT();
  const dir = hubCheckoutOnAnotherBranch();
  const found = hubPath(t, 'schemas', { kind: 'git', dir, ref: 'origin/develop' });
  assert.deepEqual(readdirSync(found), ['module.schema.json'], 'the subtree is exported, not just a file');
});

test('a file missing from origin/develop is an error naming the ref (#90)', () => {
  const t = fakeT();
  const dir = hubCheckoutOnAnotherBranch();
  assert.throws(
    () => hubPath(t, 'crates', 'db', 'src', 'lib.rs', { kind: 'git', dir, ref: 'origin/develop' }),
    /origin\/develop/,
    'a stale `origin/develop` is a `git fetch` away: staying quiet about it is the same false red',
  );
  assert.deepEqual(t.calls, [], 'it must not have skipped on the way out');
});

test('hubSource() prefers ERPLORA_HUB_DIR, then git, then nothing (#90)', () => {
  assert.deepEqual(
    hubSource({ ERPLORA_HUB_DIR: '/somewhere' }),
    { kind: 'declared', dir: '/somewhere' },
    'a declared hub wins: it is what the hub\'s own CI passes, and there the working tree IS the ' +
      'thing under test',
  );
  const found = hubSource({});
  assert.ok(
    ['git', 'absent'].includes(found.kind),
    `with no hub declared it is either the sibling at a git ref or nothing, got ${found.kind}`,
  );
  if (found.kind === 'git') assert.equal(found.ref, 'origin/develop', 'the stable reference');
});

test('CI hands the mirrors the hub the module-sdk action already left on disk (#90)', () => {
  // The other half of #90: the toolkit's own CI checks the hub out — it has to, to reach
  // `packages/module-sdk` — and then ran the six mirrors against no hub at all, `skipped 7`, green.
  // The alarm now rings on BOTH sides, and this is what keeps it that way: a workflow that stops
  // declaring the hub puts the mirrors back to skipping, and nothing else would say so.
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(
    ci,
    /ERPLORA_HUB_DIR=.*>>\s*"?\$GITHUB_ENV/,
    'ci.yml no longer declares ERPLORA_HUB_DIR: the six canonical mirrors go back to skipping in ' +
      "this repository's own CI, and `skipped 7` reads exactly like a pass (#90)",
  );
});
