// A filter the SQL already answered: `erplora validate`'s door for module-toolkit#178.
//
// The runtime does not splice a list filter INTO the module's query — it wraps it
// (`crates/runtime/src/queries.rs`): `SELECT sub.*, COUNT(*) OVER() … FROM ( <the module's SQL> )
// AS sub WHERE CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)`. So when the module's own WHERE
// already pins that column to a constant, the two conditions stack: `col = 1 AND col = 0`. Not an
// error — ZERO ROWS, always, for every value but the pinned one, with nothing on screen that says
// why (the silence of hub#1182).
//
// `erplora validate` used to give that green: the manifest is coherent with itself, and the box
// guard next door (`validate-filter-ops.mjs`) compares SCREEN ↔ MANIFEST, which cannot see the SQL.
//
// Measured over `origin/main` of the 27 module repos on 2026-09-05 (`~/.erplora/fleet/logs/178`):
// 9 dead filters alive in 7 modules, every one of them `is_active`. The three `taxes` ones the
// issue names were already fixed by hand (ERPlora/taxes#53) — which is exactly the cost this gate
// removes: closing the pattern once instead of 27 times.
//
// The two NEGATIVE controls below are not invented, they are the two shapes the catalogue actually
// carries, and both would fall to a naive `grep 'is_active = 1'`:
//
//   · `tables.zones.list` — the `= 1` lives in the `ON` of a LEFT JOIN over ANOTHER table (`t`),
//     while the list's base table is `z`. Nothing is pinned.
//   · `taxes.rules.list`  — `AND (r.is_active = 1 OR :include_archived …)`. A pin behind an OR is
//     not a pin: the caller can open the door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deadFilterFindings,
  pinnedColumns,
  DEAD_FILTERS_GRANDFATHERED,
} from '../src/validate-dead-filters.mjs';

/** One query, the shape `deadFilterFindings` takes. */
const q = (name, sql, filters, extra = {}) => ({ name, sql, filters, ...extra });

// The real SQL of the four queries the issue measured, verbatim from `origin/main` on 2026-09-05.
const TIMESLOTS = `-- Ventanas horarias activas del hub. Runtime inyecta :hub_id.
SELECT id, day_of_week, start_time, end_time, max_reservations, is_active
FROM reservations_timeslot
WHERE hub_id = :hub_id AND is_deleted = 0 AND is_active = 1`;

const ZONES = `SELECT z.id, z.name, z.description, z.color, z.sort_order, z.is_active,
       COUNT(t.id)                                            AS table_count
FROM tables_zone z
LEFT JOIN tables_table t
       ON t.zone_id = z.id AND t.hub_id = z.hub_id AND t.is_deleted = 0 AND t.is_active = 1
WHERE z.hub_id = :hub_id AND z.is_deleted = 0
GROUP BY z.id, z.name, z.description, z.color, z.sort_order, z.is_active`;

const TAX_RULES = `SELECT r.id, r.name, r.is_active
FROM taxes_rule r
WHERE r.hub_id = :hub_id AND r.is_deleted = 0
  AND (r.is_active = 1 OR COALESCE(CAST(:include_archived AS TEXT), '0') IN ('1', 'true'))`;

// ---------------------------------------------------------------------------------------------
// 1. The defect, on the query that is still alive today.
// ---------------------------------------------------------------------------------------------

// The identity used here is a FRESH one, never `reservations.timeslots.list`: that one is on the
// grandfathered list and its verdict is a warning, which is section 6's subject. What is under test
// here is the SHAPE — and the SQL is the real one, verbatim.
test('a filter over a column the query itself pins to a constant is refused', () => {
  const { errors } = deadFilterFindings('newmod', [
    q('newmod.timeslots.list', TIMESLOTS, { is_active: { op: 'eq' } }),
  ]);
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /newmod\.timeslots\.list/, 'names the query');
  assert.match(errors[0], /is_active/, 'names the column');
  assert.match(errors[0], /is_active = 1/, 'quotes the predicate that pins it');
  assert.match(errors[0], /\b4\b/, 'names the line of the SQL to look at');
});

test('the pin is found however the column is qualified', () => {
  const sql = `SELECT r.id, r.is_active FROM staff_role r
WHERE r.hub_id = :hub_id AND r.is_deleted = 0 AND r.is_active = 1`;
  const { errors } = deadFilterFindings('newmod', [
    q('newmod.roles.list', sql, { is_active: { op: 'eq' } }),
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /r\.is_active = 1/);
});

test('every op is dead the same way — the wrapper stacks its condition on top whatever it is', () => {
  for (const op of ['eq', 'like', 'range']) {
    const { errors } = deadFilterFindings('newmod', [
      q('newmod.timeslots.list', TIMESLOTS, { is_active: { op } }),
    ]);
    assert.equal(errors.length, 1, `op ${op} should be refused, got ${JSON.stringify(errors)}`);
  }
});

test('a module with several dead filters gets one error per filter, none swallowed', () => {
  const sql = `SELECT id, is_active, source FROM customers_tag
WHERE hub_id = :hub_id AND is_active = 1 AND source = 'manual'`;
  const { errors } = deadFilterFindings('newmod', [
    q('newmod.tags.list', sql, { is_active: { op: 'eq' }, source: { op: 'eq' }, name: { op: 'like' } }),
  ]);
  assert.equal(errors.length, 2, JSON.stringify(errors));
  assert.ok(errors.some((e) => /is_active/.test(e)), 'the integer pin');
  assert.ok(errors.some((e) => /source/.test(e)), "the string pin");
});

// ---------------------------------------------------------------------------------------------
// 2. The negative controls — the two shapes a naive grep gets wrong.
// ---------------------------------------------------------------------------------------------

test('a constant in the ON of a JOIN over ANOTHER table pins nothing (tables.zones.list)', () => {
  const { errors, warnings } = deadFilterFindings('tables', [
    q('tables.zones.list', ZONES, {
      name: { op: 'like' }, color: { op: 'eq' }, sort_order: { op: 'eq' }, is_active: { op: 'eq' },
    }),
  ]);
  assert.deepEqual(errors, [], 'the `t.is_active = 1` belongs to the joined table, not to the list');
  assert.deepEqual(warnings, []);
});

test('a pin behind an OR is not a pin — the caller can open the door (taxes.rules.list)', () => {
  const { errors } = deadFilterFindings('taxes', [
    q('taxes.rules.list', TAX_RULES, { is_active: { op: 'eq' } }),
  ]);
  assert.deepEqual(errors, [], 'ERPlora/taxes#53 kept this filter ON PURPOSE, with its escape hatch');
});

test('a column compared against a BIND is not pinned — that is the filter working', () => {
  const sql = `SELECT id, status FROM t WHERE hub_id = :hub_id AND status = :status`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { status: { op: 'eq' } })]);
  assert.deepEqual(errors, []);
});

test('a pin on a column NOBODY filters is somebody else\'s business', () => {
  const { errors } = deadFilterFindings('newmod', [
    q('newmod.timeslots.list', TIMESLOTS, { day_of_week: { op: 'eq' } }),
  ]);
  assert.deepEqual(errors, [], '`is_deleted = 0` and `is_active = 1` pin no DECLARED filter');
});

test('a pin inside a subquery is not the list\'s WHERE', () => {
  const sql = `SELECT id, is_active FROM m_thing
WHERE hub_id = :hub_id
  AND id IN (SELECT thing_id FROM m_link WHERE is_active = 1)`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { is_active: { op: 'eq' } })]);
  assert.deepEqual(errors, []);
});

test('a pin in a CTE body is not the list\'s WHERE either', () => {
  const sql = `WITH active AS (SELECT id FROM m_thing WHERE is_active = 1)
SELECT t.id, t.is_active FROM m_thing t JOIN active a ON a.id = t.id
WHERE t.hub_id = :hub_id`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { is_active: { op: 'eq' } })]);
  assert.deepEqual(errors, []);
});

test('a query with no `list.filters` at all is not judged', () => {
  const { errors, warnings } = deadFilterFindings('newmod', [
    q('newmod.timeslots.list', TIMESLOTS, undefined),
  ]);
  assert.deepEqual([...errors, ...warnings], []);
});

// ---------------------------------------------------------------------------------------------
// 3. What the output column REALLY is — the wrapper filters `sub.<output name>`.
// ---------------------------------------------------------------------------------------------

test('a renamed output is followed back to the column its WHERE pins', () => {
  const sql = `SELECT z.id, z.is_active AS active_flag FROM m_zone z
WHERE z.hub_id = :hub_id AND z.is_active = 1`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { active_flag: { op: 'eq' } })]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /active_flag/, 'names the filter as the manifest declares it');
  assert.match(errors[0], /z\.is_active = 1/, 'and the predicate as the SQL writes it');
});

test('a filter over a column of a JOINED table is not pinned by the base table\'s own constant', () => {
  const sql = `SELECT z.id, t.is_active FROM m_zone z JOIN m_table t ON t.zone_id = z.id
WHERE z.hub_id = :hub_id AND z.is_active = 1`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { is_active: { op: 'eq' } })]);
  assert.deepEqual(errors, [], 'the list exposes `t.is_active`; what is pinned is `z.is_active`');
});

test('a computed output is not a column, so nothing can pin it', () => {
  const sql = `SELECT z.id, COUNT(t.id) AS table_count FROM m_zone z LEFT JOIN m_table t ON t.zone_id = z.id
WHERE z.hub_id = :hub_id AND z.table_count = 1
GROUP BY z.id`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { table_count: { op: 'range' } })]);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------------------------
// 4. The other shapes that leave ONE possible value.
// ---------------------------------------------------------------------------------------------

test('`IN` with a single literal pins as hard as `=`', () => {
  const sql = `SELECT id, status FROM t WHERE hub_id = :hub_id AND status IN ('open')`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { status: { op: 'eq' } })]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /IN \('open'\)/);
});

test('`IN` with SEVERAL literals leaves a choice, so the filter still works', () => {
  const sql = `SELECT id, status FROM t WHERE hub_id = :hub_id AND status IN ('open', 'closed')`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { status: { op: 'eq' } })]);
  assert.deepEqual(errors, []);
});

test('`IS NULL` pins the column to the one value the filter can never send', () => {
  const sql = `SELECT id, closed_at FROM t WHERE hub_id = :hub_id AND closed_at IS NULL`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { closed_at: { op: 'range' } })]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /IS NULL/);
});

test('`IS TRUE` / `IS FALSE` pin a boolean', () => {
  const sql = `SELECT id, is_active FROM t WHERE hub_id = :hub_id AND is_active IS TRUE`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { is_active: { op: 'eq' } })]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
});

test('`IS NOT NULL` leaves every real value on the table, so it pins nothing', () => {
  const sql = `SELECT id, closed_at FROM t WHERE hub_id = :hub_id AND closed_at IS NOT NULL`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { closed_at: { op: 'range' } })]);
  assert.deepEqual(errors, []);
});

test('`<> literal` pins ONLY a boolean — on anything else it kills one value, not the filter', () => {
  const sql = `SELECT id, is_active, kind FROM t
WHERE hub_id = :hub_id AND is_active <> FALSE AND kind <> 'draft'`;
  const columnTypes = new Map([['is_active', new Set(['BOOLEAN NOT NULL'])], ['kind', new Set(['TEXT'])]]);
  const { errors } = deadFilterFindings(
    'm',
    [q('m.list', sql, { is_active: { op: 'eq' }, kind: { op: 'eq' } })],
    { columnTypes },
  );
  assert.equal(errors.length, 1, `only the boolean is dead: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /is_active/);
});

test('`<> literal` on a column of unknown type is left alone', () => {
  const sql = `SELECT id, is_active FROM t WHERE hub_id = :hub_id AND is_active <> 0`;
  const { errors } = deadFilterFindings('m', [q('m.list', sql, { is_active: { op: 'eq' } })]);
  assert.deepEqual(errors, [], 'without the declared type there is no proof only one value survives');
});

// ---------------------------------------------------------------------------------------------
// 5. `pinnedColumns` on its own — the parser, away from the verdict.
// ---------------------------------------------------------------------------------------------

test('pinnedColumns reads the top-level WHERE and nothing else', () => {
  const pins = pinnedColumns(ZONES);
  assert.deepEqual([...pins.keys()], ['z.is_deleted'], 'only the base table\'s own WHERE');
});

test('pinnedColumns skips a UNION rather than guess which arm the wrapper sees', () => {
  const sql = `SELECT id, is_active FROM a WHERE is_active = 1
UNION ALL
SELECT id, is_active FROM b WHERE is_active = 1`;
  assert.equal(pinnedColumns(sql).size, 0);
});

test('pinnedColumns ignores a constant written inside a comment', () => {
  const sql = `SELECT id, is_active FROM t
-- WHERE is_active = 1 (removed in v2)
WHERE hub_id = :hub_id`;
  assert.equal(pinnedColumns(sql).size, 0);
});

test('pinnedColumns does not read a WHERE that lives inside a string literal', () => {
  const sql = `SELECT id, label FROM t WHERE hub_id = :hub_id AND label <> 'x AND is_active = 1'`;
  assert.deepEqual([...pinnedColumns(sql).keys()], [], 'the quoted text is data, not a predicate');
});

// ---------------------------------------------------------------------------------------------
// 6. The ratchet — the published catalogue warns, everything new is refused.
// ---------------------------------------------------------------------------------------------

test('a filter on the grandfathered list warns instead of blocking, and says so', () => {
  const [moduleId, query, column] = DEAD_FILTERS_GRANDFATHERED.find(
    ([id]) => id === 'reservations',
  );
  assert.equal(query, 'reservations.timeslots.list');
  assert.equal(column, 'is_active');
  const { errors, warnings } = deadFilterFindings(moduleId, [
    q(query, TIMESLOTS, { [column]: { op: 'eq' } }),
  ]);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /ABUELAD/i, 'the warning says why it is not an error');
  assert.match(warnings[0], /dead-filters/, 'and is tagged like every other check of this door');
});

test('a module that does not even declare the query is not red for somebody else\'s excuse', () => {
  // `test/validate-errors-catalog.test.mjs` builds an `appointments` with one command and no
  // queries at all. A ratchet that blocks on absence puts every such fixture — and every module
  // that RETIRED the query — red on a line written about another manifest.
  const { errors, warnings } = deadFilterFindings('appointments', [], { declared: new Set() });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /DEAD_FILTERS_GRANDFATHERED/);
});

test('an entry that no longer covers a filter FAILS — a dead excuse is a permanent permission', () => {
  const clean = `SELECT id, is_active FROM reservations_timeslot
WHERE hub_id = :hub_id AND is_deleted = 0`;
  const { errors } = deadFilterFindings('reservations', [
    q('reservations.timeslots.list', clean, { is_active: { op: 'eq' } }),
  ]);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /DEAD_FILTERS_GRANDFATHERED/, 'names the list to delete the line from');
});

test('the module that FIXED it the taxes#53 way — filter out of `list.filters` — is blocked too', () => {
  // The fix ERPlora/taxes#53 chose leaves the query in place and drops the filter, so the finding
  // disappears while the query still exists. That is exactly when the line has to go.
  const { errors } = deadFilterFindings(
    'reservations',
    [q('reservations.timeslots.list', TIMESLOTS, { day_of_week: { op: 'eq' } })],
    { declared: new Set(['reservations.timeslots.list']) },
  );
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /DEAD_FILTERS_GRANDFATHERED/);
});

test('the grandfathered list is the measurement of 2026-09-05 and may only SHRINK', () => {
  assert.equal(
    DEAD_FILTERS_GRANDFATHERED.length,
    9,
    'a line ADDED here excuses a dead filter forever — fix the module instead (ERPlora/pm#251)',
  );
  const seen = new Set();
  for (const entry of DEAD_FILTERS_GRANDFATHERED) {
    assert.equal(entry.length, 3, `each line is [module, query, column]: ${JSON.stringify(entry)}`);
    const key = entry.join('|');
    assert.ok(!seen.has(key), `duplicated line: ${key}`);
    seen.add(key);
    assert.ok(entry[1].startsWith(`${entry[0]}.`), `${entry[1]} is not a query of ${entry[0]}`);
  }
});
