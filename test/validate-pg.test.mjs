// Postgres guardrails (audit pm#16, 07-17; updated after ADR-0154 + hub#210 and again after the
// 24-module sweep of pm#107, which found two holes — module-toolkit#32).
//
// The family that killed 4 P0s in Hub Cloud (sector QA 07-16) still holds for what is purely a
// Postgres matter. The "booleans" rule changed at the root though: since ADR-0154 the runtime
// COERCES `Json::Bool` → INTEGER 0/1 at a single point (hub#210), so a boolean bind goes STRAIGHT
// into the SQL (`:flag`). The pattern we used to recommend — `CASE WHEN :flag THEN 1 WHEN NOT
// :flag THEN 0 END` — now BREAKS in PG: the bind arrives as bigint 0/1 and `CASE WHEN <bigint>` is
// "argument of WHEN must be type boolean". Hence the inversion: a CASE WHEN over a param is a
// WARNING about an obsolete pattern, and the raw bind is left alone.
//
// Rules (lexical, no AST parser — same philosophy as validate-sql.mjs):
//   1) multi-statement           ERROR — a file of `sql[]` = ONE prepared statement (inventory#28)
//   2) onconflict-unqualified    ERROR — unqualified self-reference in DO UPDATE, in ANY shape
//      (appointments#19 for `col = col + 1`, reservations#19 for `col = COALESCE(:p, col)`)
//   3) boolean-case-obsolete     WARNING — `CASE WHEN :param THEN …` obsolete (ADR-0154; hub#210)
//   4) null-untyped              ERROR — `:param IS NULL` untyped → 42P08 (tables#20, tasks#14)
//
// The real corpus of the four modules that shipped broken lives in validate-pg-real-cases.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPgCompat } from '../src/validate-pg.mjs';

function mod(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-pg-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, manifest };
}

function byRule(findings, rule) {
  return findings.filter((f) => f.rule === rule);
}

test('rule 1: multi-statement in a command file = ERROR (migrations exempt)', () => {
  const { dir, manifest } = mod({
    'commands/two.sql': 'UPDATE t SET a = 1;\nINSERT INTO m (x) VALUES (1);',
    'commands/one.sql': 'UPDATE t SET a = 1;',
    // Post ADR-0154 there are only postgres migrations; and even so the scanner does NOT look at them.
    'migrations/postgres/001.sql': 'CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);',
  }, {
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'm.two': { sql: ['commands/two.sql'] }, 'm.one': { sql: ['commands/one.sql'] } },
  });
  const f = checkPgCompat(dir, manifest);
  const ms = byRule(f, 'multi-statement');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].level, 'error');
  assert.match(ms[0].message, /two\.sql/);
});

test('rule 2: unqualified self-reference in DO UPDATE = ERROR; qualified or excluded passes', () => {
  const { dir, manifest } = mod({
    'commands/bad.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = n + 1;',
    'commands/good.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = c.n + 1, m = excluded.m;',
  }, { commands: { 'm.b': { sql: ['commands/bad.sql'] }, 'm.g': { sql: ['commands/good.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'onconflict-unqualified');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /bad\.sql/);
});

test('rule 2: the WRAPPED shape `col = COALESCE(:col, col)` is caught too (module-toolkit#32)', () => {
  // The hole that let `reservations` publish 13 ambiguous columns in green: the old rule split the
  // assignment list on commas, so `COALESCE(:x, x)` was cut in half and the self-reference —
  // sitting in the second half — was never compared against anything.
  const { dir, manifest } = mod({
    'commands/settings.sql':
      'INSERT INTO s (hub_id, slot, size) VALUES (:hub_id, :slot, :size)\n' +
      'ON CONFLICT(hub_id) DO UPDATE SET\n' +
      '  slot = COALESCE(:slot, slot),\n' +
      '  size = COALESCE(:size, s.size),\n' +
      '  updated_at = :now;',
  }, { commands: { 'm.s': { sql: ['commands/settings.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'onconflict-unqualified');
  assert.equal(f.length, 1, 'only the unqualified one; `s.size` and the `:now` bind are fine');
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /slot/);
  assert.match(f[0].message, /s\.slot|excluded\.slot/, 'suggests the qualified form');
});

test('rule 2: a self-reference in a plain UPDATE (no ON CONFLICT) is NOT flagged', () => {
  // `staff.member_update` does exactly this and it is correct: outside DO UPDATE there is no
  // `excluded` row to be ambiguous with.
  const { dir, manifest } = mod({
    'commands/u.sql': 'UPDATE m SET role_id = COALESCE(:role_id, role_id) WHERE id = :id;',
  }, { commands: { 'm.u': { sql: ['commands/u.sql'] } } });
  assert.deepEqual(checkPgCompat(dir, manifest), []);
});

test('rule 3: `CASE WHEN :param THEN …` = WARNING about an OBSOLETE pattern (ADR-0154; the runtime coerces)', () => {
  const { dir, manifest } = mod({
    'commands/c.sql': 'UPDATE t SET a = CASE WHEN :ok_flag THEN 1 WHEN NOT :ok_flag THEN 0 END;',
  }, { commands: { 'm.c': { sql: ['commands/c.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'boolean-case-obsolete');
  assert.ok(f.length >= 1, 'must warn about the CASE WHEN over a param');
  assert.equal(f[0].level, 'warning');
  assert.match(f[0].message, /obsolet|directo|coerc/i);
});

test('rule 3 (inverse): a RAW boolean bind is already correct — NOT flagged', () => {
  // This is EXACTLY what the old rule marked as an error and asked you to wrap.
  // Post-coercion it is the right thing: the runtime lowers `true`→1 before touching PG.
  const { dir, manifest } = mod({
    'commands/c.sql': 'UPDATE t SET is_active = :active, name = :name WHERE id = :id;',
  }, { commands: { 'm.c': { sql: ['commands/c.sql'] } } });
  const f = checkPgCompat(dir, manifest);
  assert.equal(f.length, 0, 'a direct boolean bind must produce no finding');
});

test('rule 4: `:param IS NULL` untyped = ERROR (42P08 at PREPARE) suggesting the portable CAST', () => {
  // ERROR since module-toolkit#32: it is not a style smell, the statement does not prepare once the
  // bind arrives NULL, and ADR-0154 leaves no other engine where it could work.
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT * FROM t WHERE (:filter IS NULL OR name = :filter) ORDER BY name;',
  }, { queries: { 'm.q': { sql: ['queries/q.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'null-untyped');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /42P08/);
  assert.match(f[0].message, /CAST\(:filter AS TEXT\)/, 'the suggestion must be the portable one, not `::text` (SQLite does not parse it)');
  assert.match(f[0].message, /filter/);
});

test('rule 4: an already CAST bind passes — that is the accepted fix', () => {
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT * FROM t WHERE (CAST(:filter AS TEXT) IS NULL OR name = :filter);',
  }, { queries: { 'm.q': { sql: ['queries/q.sql'] } } });
  assert.deepEqual(checkPgCompat(dir, manifest), []);
});

test('rule 4: `col IS NULL` (a column, not a param) is NOT flagged', () => {
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT * FROM t WHERE deleted_at IS NULL;',
  }, { queries: { 'm.q': { sql: ['queries/q.sql'] } } });
  assert.equal(byRule(checkPgCompat(dir, manifest), 'null-untyped').length, 0);
});
