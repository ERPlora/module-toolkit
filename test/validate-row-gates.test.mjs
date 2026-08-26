// The author's door for the affected-rows gates (ERPlora/hub#1091).
//
// `min_affected_rows` counts the BATCH and, being a plain INTEGER, has nowhere to name the
// statement that carries the guard — and the manifest may not pair it with `expect_rows`. So over
// more than one statement it is the neutralizable shape with no cure: an unconditional sibling (a
// counter UPSERT, an audit INSERT) satisfies the minimum ON BEHALF of the statement that missed,
// and the command answers `200 ok` with an event for a fact that never happened.
//
// The runtime refuses it at INSTALL. This is the same refusal one door earlier, where the author
// still has the manifest open — the distance the toolkit exists to close: a manifest that passes
// here and fails there does not fail on the author's machine, it fails on a customer's hub, after
// publishing.
//
// Why it is not caught by `checkManifestKeys`: that walker reads unknown keys, string patterns and
// closed vocabularies. The `if/then` the canonical schema declares for this is a CONDITIONAL, and
// the walker does not evaluate conditionals — so without this file the constraint would be inert
// in the toolkit and true only in the hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRowGates } from '../src/validate-row-gates.mjs';

const gate = (command) => ({ id: 'm', name: 'M', version: '1.0.0', commands: { 'm.c': command } });

test('min_affected_rows over more than one statement is refused', () => {
  const errs = checkRowGates(gate({ permission: 'm.w', sql: ['_bump.sql', 'create.sql'], min_affected_rows: 1 }));
  assert.equal(errs.length, 1, `expected exactly one error, got ${JSON.stringify(errs)}`);
  assert.match(errs[0], /m\.c/, 'names the command');
  assert.match(errs[0], /min_affected_rows/, 'names the offending key');
  assert.match(errs[0], /expect_rows\.statement/, 'names the way to express the intent');
});

test('min_affected_rows over ONE statement is fine — one statement IS the batch', () => {
  assert.deepEqual(checkRowGates(gate({ permission: 'm.w', sql: ['resolve.sql'], min_affected_rows: 1 })), []);
});

test('a multi-statement gate anchored with expect_rows.statement is fine', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['_bump.sql', 'create.sql'],
    expect_rows: { op: 'min', n: 1, error: 'm.x', statement: 'create.sql' },
  });
  assert.deepEqual(checkRowGates(m), []);
});

test('an anchor naming no statement of its command is refused', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['_bump.sql', 'create.sql'],
    expect_rows: { op: 'min', n: 1, error: 'm.x', statement: 'nope.sql' },
  });
  const errs = checkRowGates(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /nope\.sql/, 'names the dangling anchor');
});

test('the two gates cannot coexist on one command', () => {
  const m = gate({
    permission: 'm.w',
    sql: ['a.sql'],
    min_affected_rows: 1,
    expect_rows: { op: 'min', n: 1, error: 'm.x' },
  });
  const errs = checkRowGates(m);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.match(errs[0], /min_affected_rows/);
  assert.match(errs[0], /expect_rows/);
});

test('a manifest with no row gates at all says nothing', () => {
  assert.deepEqual(checkRowGates(gate({ permission: 'm.w', sql: ['a.sql', 'b.sql'] })), []);
  assert.deepEqual(checkRowGates({ id: 'm', name: 'M', version: '1.0.0' }), []);
});

// The catalogue as it stands: `flows.drafts.resolve` is the only `min_affected_rows` in the 27
// module repos and it is a single statement. Pinned so a future tightening cannot silently start
// refusing the one shape that is legitimately in production.
test('the shape the published catalogue uses keeps validating', () => {
  const flows = {
    id: 'flows',
    name: 'Flows',
    version: '1.0.0',
    commands: { 'flows.drafts.resolve': { permission: 'flows.change_flow', sql: ['commands/drafts_resolve.sql'], min_affected_rows: 1 } },
  };
  assert.deepEqual(checkRowGates(flows), []);
});

// Paridad con las OTRAS DOS puertas (revisión de hub#1091). Un command de HANDLER no declara `sql`:
// no hay lote, así que no hay guarda que neutralizar. El installer lo acepta
// (`command.sql.len() > 1` → `0 > 1`, falso) y el JSON Schema también, desde que su `if` exige
// `required: ["min_affected_rows", "sql"]` — antes casaba en vacío y lo rechazaba solo él.
// Esta puerta tiene que decir lo mismo que las otras dos.
test('a handler command with no sql may declare min_affected_rows', () => {
  const handler = {
    permission: 'm.w',
    handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'run' },
    min_affected_rows: 1,
  };
  assert.deepEqual(checkRowGates(gate(handler)), []);
});
