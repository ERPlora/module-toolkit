// The author's door for `commands.*.emit[].dedup_key` (ERPlora/hub#1076, ERPlora/module-toolkit#133).
//
// The vendored schema (`schemas/module.schema.json`, synced from the hub) types `dedup_key` as a
// string and requires it on the object form of an `emit` entry — but it cannot express MORE than
// that without diverging from the hub's own byte-for-byte copy (`canonical-mirrors.test.mjs`).
// An empty string, or a value that could never be a field name (spaces, `:`, punctuation), still
// passes `type: string`, and reaches the runtime, which resolves it against the command's bound
// payload — the SAME namespace a `:field` bind in its SQL uses. A `dedup_key` that cannot possibly
// name a field degrades SILENTLY there (hub#1331: absent/non-scalar emits WITHOUT deduplicating,
// reported by `eprintln!`, never rejected) — exactly the class of gap `checkRowGates` closes for
// `expect_rows.statement`: the runtime's tolerant, visible-at-runtime behaviour is not a reason for
// the author's door to stay silent at publish time, when the manifest is still open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmitDedupKey } from '../src/validate-emit-dedup-key.mjs';

const gate = (command) => ({ id: 'm', name: 'M', version: '1.0.0', commands: { 'm.c': command } });

test('a manifest with no commands, or no emit, says nothing', () => {
  assert.deepEqual(checkEmitDedupKey({ id: 'm', name: 'M', version: '1.0.0' }), []);
  assert.deepEqual(checkEmitDedupKey(gate({ permission: 'm.w' })), []);
});

test('a plain string emit (the historical shape) says nothing — dedup_key is opt-in', () => {
  assert.deepEqual(checkEmitDedupKey(gate({ permission: 'm.w', emit: ['m.thing.created'] })), []);
});

test('a well-formed object emit says nothing', () => {
  const m = gate({ permission: 'm.w', emit: [{ event: 'm.thing.done', dedup_key: 'wa_message_id' }] });
  assert.deepEqual(checkEmitDedupKey(m), []);
});

test('an empty dedup_key is refused: it cannot name any field of the payload', () => {
  const m = gate({ permission: 'm.w', emit: [{ event: 'm.thing.done', dedup_key: '' }] });
  const errs = checkEmitDedupKey(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /m\.c/, 'names the command');
  assert.match(errs[0], /emit\[0\]/, 'names the entry');
  assert.match(errs[0], /dedup_key/);
});

test('a dedup_key that is not a valid field name is refused (the same namespace as a `:field` bind)', () => {
  const m = gate({ permission: 'm.w', emit: [{ event: 'm.thing.done', dedup_key: 'wa message id' }] });
  const errs = checkEmitDedupKey(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /wa message id/);
});

test('several emit entries on one command are checked independently, by index', () => {
  const m = gate({
    permission: 'm.w',
    emit: ['m.thing.legacy', { event: 'm.thing.a', dedup_key: 'ok_field' }, { event: 'm.thing.b', dedup_key: '' }],
  });
  const errs = checkEmitDedupKey(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /emit\[2\]/);
});
