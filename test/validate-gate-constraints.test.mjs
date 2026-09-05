// The author's door for the GUARD TABLE of a module (module-toolkit#92, verifactu#40).
//
// Not to be confused with `validate-row-gates.test.mjs`: that one is about `min_affected_rows` /
// `expect_rows`, the gates over how many ROWS a command's `sql` affected. This one is about the
// `<module>__gate` TABLE — the abort mechanism a command uses to refuse in SQL, where an assert
// inserts `(gate, ok)` and `ok = 0` violates a CHECK, rolling the whole transaction back.
//
// The defect: the CHECK was written anonymous, `CHECK (ok = 1)`, so Postgres auto-names it
// `<table>_ok_check` and EVERY gate that ever fails fails with the same message. Which gate refused
// travels in the separate DETAIL field, and DETAIL never reaches the caller — `sqlx::Error::Database`
// wraps `PgDatabaseError`, whose `Display` writes the primary message only and whose `message()`
// drops DETAIL. So code that branches on the text to say WHY cannot ever match, and every refusal
// collapses into one generic sentence: in verifactu a hub with no obligado tributario was told that
// going live is one way — the other gate's problem, naming nothing it could fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGateConstraints, gateConstraintFindings, GRANDFATHERED } from '../src/validate-gate-constraints.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gate-constraints');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** The findings for a module whose declared migrations are `files`, in order. */
const findings = (moduleId, files) => gateConstraintFindings(moduleId, files);

// ---------------------------------------------------------------------------------------------
// 1. The defect, on the SQL four published modules carry today.
// ---------------------------------------------------------------------------------------------

test('an anonymous CHECK (ok = 1) on the gate table is refused, naming the fix', () => {
  const { errors } = findings('mymod', [
    { file: 'migrations/postgres/002_gate.sql', sql: 'CREATE TABLE IF NOT EXISTS mymod__gate (\n  gate TEXT NOT NULL,\n  ok INTEGER NOT NULL CHECK (ok = 1)\n);' },
  ]);
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /mymod__gate/, 'names the table');
  assert.match(errors[0], /002_gate\.sql/, 'names the file to edit');
  assert.match(errors[0], /CONSTRAINT/, 'names the shape of the fix');
  assert.match(errors[0], /DETAIL/, 'says why the anonymous one cannot work');
});

test('the real published SQL of tables/002_gate.sql is the defect', () => {
  const sql = fixture('tables_002_gate.sql');
  // `tables` LEFT the tolerance list when it landed the named constraints (tables#76, migration
  // 011). So those bytes on their own are now the error, with no warning to soften them — which is
  // the whole point of a ratchet: the entry goes and the file stops being special.
  const { errors, warnings } = findings('tables', [{ file: 'migrations/postgres/002_gate.sql', sql }]);
  assert.deepEqual(warnings, [], 'nothing tolerates this file any more');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /tables__gate/, 'names the table');
  assert.match(errors[0], /002_gate\.sql/, 'names the file to edit');
});

// ...and the reason the entry could go: the module's REAL chain. 002 still creates the table with
// the anonymous check — migrations are append-only and that file is published — and 011 swaps it
// for one named constraint per gate plus the whitelist. The verdict is on the END state, so the
// module is green WITHOUT any tolerance. This is what makes retiring the entry a measurement and
// not a promise: break 011 and this test goes red, exactly like the module's own battery.
test('tables is green on its own merits: 002 + 011 leaves no anonymous CHECK', () => {
  const chain = [
    { file: 'migrations/postgres/002_gate.sql', sql: fixture('tables_002_gate.sql') },
    { file: 'migrations/postgres/011_named_gate_constraints.sql', sql: fixture('tables_011_named_gate_constraints.sql') },
  ];
  assert.deepEqual(findings('tables', chain), { errors: [], warnings: [] });

  // And it is 011 that earns it: drop its whitelist and the door says so (a gate that matches no
  // constraint violates nothing, so an assert typo would fail OPEN).
  const withoutWhitelist = fixture('tables_011_named_gate_constraints.sql').replace(
    /ALTER TABLE tables__gate ADD CONSTRAINT tables__gate_is_declared[\s\S]*$/,
    '',
  );
  const { warnings } = findings('tables', [
    chain[0],
    { file: 'migrations/postgres/011_named_gate_constraints.sql', sql: withoutWhitelist },
  ]);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /lista blanca/);
});

// The header of `appointments/003_gate.sql` says, in prose, «ok = 0 violates CHECK (ok = 1)». A
// reader that does not strip comments finds the pattern in the COMMENT of a module that had already
// fixed its SQL and refuses it — the false positive that turns a gate into noise everyone mutes.
test('the pattern inside a COMMENT is not the pattern', () => {
  const header = fixture('appointments_003_gate.sql').split('CREATE TABLE')[0];
  assert.match(header, /CHECK \(ok = 1\)/, 'the fixture must still carry the prose that is the trap');
  const { errors, warnings } = findings('appointments', [
    { file: 'migrations/postgres/003_gate.sql', sql: `${header}\nCREATE TABLE IF NOT EXISTS appointments__gate (\n  gate TEXT NOT NULL,\n  ok INTEGER NOT NULL,\n  CONSTRAINT overlap_free CHECK (gate <> 'overlap_free' OR ok = 1),\n  CONSTRAINT appointments__gate_is_declared CHECK (gate IN ('overlap_free'))\n);` },
  ]);
  assert.deepEqual(errors, [], 'a comment is prose, not a constraint');
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------------------------
// 2. The canonical fix must stay green. This is the control that decides whether the guard is
//    usable at all: verifactu APPLIED the fix (migration 012) and its 010 still creates the table
//    with the anonymous check, because migrations are append-only. A per-file reader would put the
//    one module that did the work in red.
// ---------------------------------------------------------------------------------------------

test('the canonical fix (verifactu 010 + 012, as published) is clean', () => {
  const { errors, warnings } = findings('verifactu', [
    { file: 'migrations/postgres/010_contingency_cancel_gate.sql', sql: fixture('verifactu_010_gate.sql') },
    { file: 'migrations/postgres/012_named_gate_constraints.sql', sql: fixture('verifactu_012_named_gate_constraints.sql') },
  ]);
  assert.deepEqual(errors, [], 'the module that did the work must not be the one in red');
  assert.deepEqual(warnings, []);
});

// Negative control: the same two files with the DROP taken out. If this passes, the check is not
// reading the chain at all and the green above means nothing.
test('the fix WITHOUT its DROP still leaves the anonymous check live', () => {
  const mutated = fixture('verifactu_012_named_gate_constraints.sql').replace(
    /ALTER TABLE verifactu__gate DROP CONSTRAINT IF EXISTS verifactu__gate_ok_check;/,
    '',
  );
  assert.doesNotMatch(mutated, /DROP CONSTRAINT/, 'the mutation must actually remove the DROP');
  const { errors } = findings('verifactu', [
    { file: 'migrations/postgres/010_contingency_cancel_gate.sql', sql: fixture('verifactu_010_gate.sql') },
    { file: 'migrations/postgres/012_named_gate_constraints.sql', sql: mutated },
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /verifactu__gate/);
});

// ---------------------------------------------------------------------------------------------
// 3. A named constraint is not automatically a fix: one name for every gate is the same defect
//    with a nicer name.
// ---------------------------------------------------------------------------------------------

test('a NAMED but global CHECK (ok = 1) is the same defect', () => {
  const { errors } = findings('mymod', [
    { file: 'migrations/postgres/002_gate.sql', sql: 'CREATE TABLE mymod__gate (gate TEXT NOT NULL, ok INTEGER NOT NULL);' },
    { file: 'migrations/postgres/003_named.sql', sql: "ALTER TABLE mymod__gate ADD CONSTRAINT mymod__gate_must_hold CHECK (ok = 1);" },
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /mymod__gate_must_hold/, 'names the constraint that cannot discriminate');
});

// ---------------------------------------------------------------------------------------------
// 4. The hazard this check CREATES if it stops here: it tells the author to drop the anonymous
//    constraint. Half of that instruction disarms the table — `ok = 0` commits, the command answers
//    OK, and the invariant the gate existed for is simply gone.
// ---------------------------------------------------------------------------------------------

test('dropping the anonymous check and putting nothing back DISARMS the gate', () => {
  const { errors } = findings('mymod', [
    { file: 'migrations/postgres/002_gate.sql', sql: 'CREATE TABLE mymod__gate (gate TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));' },
    { file: 'migrations/postgres/003_drop.sql', sql: 'ALTER TABLE mymod__gate DROP CONSTRAINT IF EXISTS mymod__gate_ok_check;' },
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /mymod__gate/);
  assert.match(errors[0], /ok = 0/, 'says what now commits');
});

test('a gate table that never had a check on ok is not judged', () => {
  // Unknown shape: it may be guarded by something this lexical door cannot see. Refusing it would
  // be a correct module that cannot publish, which is how a gate gets switched off.
  const { errors, warnings } = findings('mymod', [
    { file: 'migrations/postgres/002_gate.sql', sql: 'CREATE TABLE mymod__gate (gate TEXT NOT NULL, note TEXT NOT NULL);' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------------------------
// 5. The whitelist: with one constraint per gate, a row whose `gate` matches NONE of them violates
//    nothing — a typo in an assert fails OPEN and the command commits. Warning, not error: failing
//    closed can be expressed in shapes a lexical reader cannot prove absent (a FK to a registry, a
//    trigger), and a false red here is a correct module that cannot publish.
// ---------------------------------------------------------------------------------------------

test('per-gate constraints with no whitelist over `gate` warn: an unregistered gate fails OPEN', () => {
  const { errors, warnings } = findings('mymod', [
    { file: 'migrations/postgres/002_gate.sql', sql: 'CREATE TABLE mymod__gate (gate TEXT NOT NULL, ok INTEGER NOT NULL);' },
    { file: 'migrations/postgres/003_named.sql', sql: "ALTER TABLE mymod__gate ADD CONSTRAINT stock_is_available CHECK (gate <> 'stock_is_available' OR ok = 1);" },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /mymod__gate/);
});

test('a module with no gate table at all says nothing', () => {
  const { errors, warnings } = findings('mymod', [
    { file: 'migrations/postgres/001_init.sql', sql: 'CREATE TABLE mymod_item (id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK (ok = 1));' },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ---------------------------------------------------------------------------------------------
// 6. The ratchet. Four modules publish the defect today; a hard error with no tolerance list would
//    put four green repos in red for a rule of ours, which is how a gate gets disabled instead of
//    obeyed. They are named ONE BY ONE with their issue, they WARN (never silent), and the list can
//    only shrink — a new gate table is born in error.
// ---------------------------------------------------------------------------------------------

test('a grandfathered file warns naming its issue, and does not block', () => {
  const [moduleId, file] = GRANDFATHERED[0];
  const { errors, warnings } = findings(moduleId, [
    { file, sql: `CREATE TABLE ${moduleId}__gate (gate TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));` },
  ]);
  assert.deepEqual(errors, [], 'a published module does not go red for a rule we just wrote');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /#\d+/, 'the warning carries the issue that retires it');
});

test('the tolerance list is exactly the corpus measured on origin/main (01/09/2026)', () => {
  // Pinned so growing it is a deliberate act somebody reviews, never a quiet `push`.
  assert.deepEqual(
    GRANDFATHERED.map(([m, f]) => `${m}:${f}`).sort(),
    [
      'reservations:migrations/postgres/002_gate.sql',
      'services:migrations/postgres/003_package_redemption.sql',
    ],
    'the list only SHRINKS: an entry goes when its module lands the named constraints',
  );
});

// Written against whatever is FIRST on the list rather than a module named here, so retiring an
// entry (which is the only direction the list moves) never drags this test with it — naming
// `tables` is what made it fail the day `tables` landed its fix. When the list finally empties,
// this test and the ratchet above have no subject left and go with it: that is the end state the
// whole mechanism is aiming at, not a regression.
test('grandfathering is per FILE, not per module: a new gate table in an old module is an error', () => {
  const [moduleId, file] = GRANDFATHERED[0];
  const anonymous = (table) => `CREATE TABLE ${table} (gate TEXT NOT NULL, ok INTEGER NOT NULL CHECK (ok = 1));`;
  const { errors } = findings(moduleId, [
    { file, sql: anonymous(`${moduleId}__gate`) },
    { file: 'migrations/postgres/099_second_gate.sql', sql: anonymous(`${moduleId}__gate_hold`) },
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], new RegExp(`${moduleId}__gate_hold`));
});

// ---------------------------------------------------------------------------------------------
// 7. The door as `erplora validate` calls it: the files the MANIFEST declares, read from disk.
// ---------------------------------------------------------------------------------------------

test('checkGateConstraints reads the declared migrations from disk', () => {
  const dir = join(FIXTURES, 'module');
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  assert.deepEqual(checkGateConstraints(dir, manifest), { errors: [], warnings: [] });
});

test('a manifest with no migrations declared is not judged', () => {
  assert.deepEqual(checkGateConstraints(FIXTURES, { id: 'mymod' }), { errors: [], warnings: [] });
});
