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
import { hubPath, hubDir } from './hub-mirror.mjs';

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
