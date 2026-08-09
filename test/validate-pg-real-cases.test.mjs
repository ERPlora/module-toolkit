// The four modules that shipped SQL Postgres cannot even PREPARE (ERPlora/pm#107, 2026-08-09),
// used here as the corpus `checkPgCompat` has to get right. Each fixture under
// `test/fixtures/pg-real-cases/` is the VERBATIM file the module published — `*.broken.sql` is the
// version that was live in the marketplace, `*.fixed.sql` the one that replaced it — so this file
// proves the hole is closed against the real thing, not against a reduction of it.
//
// Why it matters: since ADR-0154 modules only ship the `postgres` dialect, so "does not prepare"
// means the command/query does not exist in ANY hub. `erplora validate` was green for three of the
// four, which is exactly what would have made the CI gate of pm#107 lie.
//
//   reservations   settings.upsert         13 unqualified self-references in ON CONFLICT DO UPDATE
//                                          wrapped in COALESCE (reservations#19 / PR #20)
//   appointments   availability.slots|check `:staff_id IS [NOT] NULL` sentinel → 42P08 with the
//                                          bind absent, i.e. the global agenda (appointments#35/#36)
//   tasks          _insert_task            `:project_id IS NULL` sentinel → 42P08 creating a task
//                                          with no project, its default (tasks#14 / PR #15)
//   whatsapp_inbox messages.ingest         TEXT >= timestamptz — NO lexical rule catches this one;
//                                          it is the case that justifies `validate --pg` (#24)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPgCompat } from '../src/validate-pg.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pg-real-cases');

/** Runs the PG guardrails over fixture files, addressed relative to the fixtures root. */
function check(files, coll = 'commands') {
  const entries = Object.fromEntries(files.map((rel, i) => [`m.q${i}`, { sql: [rel] }]));
  return checkPgCompat(FIXTURES, { [coll]: entries });
}

const byRule = (findings, rule) => findings.filter((f) => f.rule === rule);

// ── reservations#19 — ON CONFLICT DO UPDATE SET col = COALESCE(:bind, col) ───────────────────

test('reservations: the published settings.upsert is REJECTED (13 ambiguous self-references)', () => {
  const found = byRule(check(['reservations/settings_upsert.broken.sql']), 'onconflict-unqualified');
  assert.equal(found.length, 13, `expected one finding per ambiguous column, got ${found.length}`);
  assert.ok(found.every((f) => f.level === 'error'));
  // The very column Postgres named: `column reference "time_slot_duration" is ambiguous`.
  assert.ok(found.some((f) => /time_slot_duration/.test(f.message)));
  // The suggestion has to be the fix that was actually applied.
  assert.ok(found.every((f) => /reservations_settings\.|excluded\./.test(f.message)));
});

test('reservations: the fixed settings.upsert is ACCEPTED (qualified self-reference)', () => {
  assert.deepEqual(check(['reservations/settings_upsert.fixed.sql']), []);
});

// ── appointments#35 / tasks#14 — untyped bind in an `IS NULL` sentinel (42P08) ───────────────

test('appointments: the published availability engine is REJECTED — `:staff_id IS [NOT] NULL`', () => {
  const found = byRule(
    check(['appointments/availability_slots.broken.sql', 'appointments/availability_check.broken.sql'], 'queries'),
    'null-untyped',
  );
  assert.equal(found.length, 2, 'one finding per file (the bind repeats inside each)');
  assert.ok(found.every((f) => f.level === 'error'), 'must be an ERROR: the query does not prepare');
  assert.ok(found.every((f) => /staff_id/.test(f.message)));
});

test('appointments: the fixed availability engine is ACCEPTED — `CAST(:staff_id AS TEXT)`', () => {
  const files = ['appointments/availability_slots.fixed.sql', 'appointments/availability_check.fixed.sql'];
  assert.deepEqual(check(files, 'queries'), []);
});

test('tasks: the published _insert_task is REJECTED — `:project_id IS NULL` / `:parent_task_id IS NULL`', () => {
  const found = byRule(check(['tasks/_insert_task.broken.sql']), 'null-untyped');
  assert.equal(found.length, 2);
  assert.ok(found.every((f) => f.level === 'error'));
  assert.ok(found.some((f) => /project_id/.test(f.message)));
  assert.ok(found.some((f) => /parent_task_id/.test(f.message)));
});

test('tasks: the fixed _insert_task is ACCEPTED — `CAST(:project_id AS TEXT)`', () => {
  assert.deepEqual(check(['tasks/_insert_task.fixed.sql']), []);
});

// ── whatsapp_inbox#24 — the case no lexical rule can see ─────────────────────────────────────

test('whatsapp_inbox: the lexical guardrails CANNOT see `TEXT >= timestamptz` — that is what --pg is for', () => {
  // Not an aspiration: `m.created_at >= erp_month_start(:now)` is a TEXT column against a
  // `timestamptz` (the runtime rewrites the bridge function to `date_trunc('month', …)`), and no
  // plausible lexical rule tells one identifier's type from another's. Asserting the blind spot
  // keeps it honest: the day someone claims `validate` alone is enough, this test says otherwise.
  assert.deepEqual(check(['whatsapp_inbox/commands/message_ingest_msg.sql']), []);
});
