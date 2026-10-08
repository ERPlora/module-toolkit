// The author's door for `commands.*.emit[].when_rows` (ERPlora/hub#2612, ERPlora/module-toolkit#464).
//
// `when_rows` anchors an event to ONE of the command's own `sql` statements: the hub writes the
// outbox row only when THAT statement affected at least one row, inside the same transaction, and
// a pass that changed nothing still answers `ok` (the shape a scheduled sweep needs — unlike
// `min_affected_rows`/`expect_rows`, nothing rolls back). The vendored schema types it as a
// non-empty string and that is all it can say: whether the anchor NAMES a statement of its command,
// and whether the command is resolved by a handler (whose statements are not the ones it declares),
// is knowable only by reading the whole command — which is what the hub's installer does, and
// refuses. This is that refusal one door earlier, with the manifest still open: a manifest that
// passes here and fails there does not fail on the author's machine, it fails on a customer's hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEmitWhenRows } from '../src/validate-emit-when-rows.mjs';

const gate = (command) => ({ id: 'm', name: 'M', version: '1.0.0', commands: { 'm.c': command } });

test('a manifest with no commands, or no emit, says nothing', () => {
  assert.deepEqual(checkEmitWhenRows({ id: 'm', name: 'M', version: '1.0.0' }), []);
  assert.deepEqual(checkEmitWhenRows(gate({ permission: 'm.w', sql: ['sweep.sql'] })), []);
});

test('the plain string shape and a dedup_key-only object say nothing — when_rows is opt-in', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['sweep.sql'],
    emit: ['m.hold.released', { event: 'm.hold.done', dedup_key: 'hold_id' }],
  });
  assert.deepEqual(checkEmitWhenRows(m), []);
});

test('an anchor naming one of the command statements is fine, alone or next to dedup_key', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['commands/holds_expire.sql', 'commands/sweep_stamp.sql'],
    emit: [
      { event: 'm.hold.released', when_rows: 'commands/holds_expire.sql' },
      { event: 'm.hold.stamped', when_rows: 'commands/sweep_stamp.sql', dedup_key: 'hold_id' },
    ],
  });
  assert.deepEqual(checkEmitWhenRows(m), []);
});

test('an anchor naming no statement of its command is refused, naming command, entry and anchor', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['commands/holds_expire.sql'],
    emit: [{ event: 'm.hold.released', when_rows: 'commands/no_such_statement.sql' }],
  });
  const errs = checkEmitWhenRows(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /m\.c/, 'names the command');
  assert.match(errs[0], /emit\[0\]\.when_rows/, 'names the entry');
  assert.match(errs[0], /no_such_statement\.sql/, 'names the dangling anchor');
  assert.match(errs[0], /holds_expire\.sql/, 'and lists the statements it could anchor to');
});

test('an empty anchor names nothing: refused like any dangling one', () => {
  const m = gate({ permission: 'm.w', sql: ['sweep.sql'], emit: [{ event: 'm.x', when_rows: '' }] });
  assert.equal(checkEmitWhenRows(m).length, 1);
});

test('when_rows on a command resolved by a handler is refused: its sql list is not what runs', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['commands/holds_expire.sql'],
    handler: { type: 'wasm', file: 'handler/handler.wasm', function: 'expire' },
    emit: [{ event: 'm.hold.released', when_rows: 'commands/holds_expire.sql' }],
  });
  const errs = checkEmitWhenRows(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /m\.c/);
  assert.match(errs[0], /handler/, 'says why');
  assert.match(errs[0], /when_rows/);
});

test('several emit entries on one command are checked independently, by index', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['a.sql', 'b.sql'],
    emit: [
      'm.legacy',
      { event: 'm.a', when_rows: 'a.sql' },
      { event: 'm.b', when_rows: 'c.sql' },
      { event: 'm.d', dedup_key: 'id' },
    ],
  });
  const errs = checkEmitWhenRows(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /emit\[2\]/);
});

test('a command whose sql is a bare string is read as one statement', () => {
  const m = gate({ permission: 'm.w', sql: 'sweep.sql', emit: [{ event: 'm.x', when_rows: 'sweep.sql' }] });
  assert.deepEqual(checkEmitWhenRows(m), []);
});
