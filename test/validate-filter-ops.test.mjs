// The ADR-0125 gate of `erplora validate` (module-toolkit#183).
//
// A column header carries a PROMISE. A free-text box says «type a piece of it»; a dropdown says
// «choose one of these». The manifest is what actually happens: `op: "like"` narrows by fragment,
// `op: "eq"` demands the whole value. When the two disagree nobody gets an error — the list simply
// comes back EMPTY, and the waiter reads «the customer is not here» and creates a duplicate
// (ADR-0125). That rule had a guard, `modules-workspace/guards/filter-ops.test.ts`, but
// `modules-workspace/` is not a repo and has no workflows: nothing ever ran it, and it had been red
// on `main` for weeks. This is the same rule, moved to the one door that DOES run on every module
// PR.
//
// The old guard judged a column by its NAME, against a hand-kept whitelist of free text. Measured
// on `origin/main` of the 27 module repos on 2026-09-05 (579 declared filters), that whitelist is
// only half right, and the half that is wrong is the noisy one:
//
//   · «`like` on a column OUTSIDE the whitelist» → 18 findings, 18 of them FALSE POSITIVES. Every
//     one is a column the module's own component paints as `filterType: 'text'` (`slug`,
//     `reference`, `key`, `region_code`, `display_description`, `order_number`…). Five are not even
//     in the widened whitelist the issue proposed. A published module cannot be blocked for doing
//     the right thing, so that direction does NOT come across.
//   · «the painted `filterType` disagrees with the manifest `op`» → 41 findings in 12 modules, and
//     they are the real ADR-0125 bug: a text box wired to `eq`.
//
// So the evidence the gate trusts is what the MODULE ITSELF declares — the `filterType` its
// component paints and the column type its migration writes — and the name whitelist survives only
// as the last-resort net for a filter no screen paints, and only in the `eq` direction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkFilterOps,
  listScreens,
  declaredColumnTypes,
  isTextualType,
  FILTER_OPS_GRANDFATHERED,
} from '../src/validate-filter-ops.mjs';

const INIT = `CREATE TABLE IF NOT EXISTS demo_items (
  id          TEXT PRIMARY KEY,
  hub_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  party_size  INTEGER NOT NULL DEFAULT 2,
  created_at  TIMESTAMPTZ NOT NULL
);`;

/** A module on disk: `files` verbatim, plus the manifest. */
function mod({ filters = {}, files = {}, id = 'demo', sql = INIT } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-filterops-'));
  const all = { 'migrations/postgres/001_init.sql': sql, ...files };
  for (const [name, body] of Object.entries(all)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  const manifest = {
    id,
    migrations: { postgres: ['migrations/postgres/001_init.sql'] },
    queries: { 'demo.items.list': { list: { filters } } },
  };
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
  return { dir, manifest };
}

/** The manifest's queries plus every grandfathered query of `owed`, declared and clean. */
function declaring(manifest, owed) {
  const queries = { ...manifest.queries };
  for (const [, query] of owed) queries[query] ??= { list: { filters: {} } };
  return queries;
}

/** A Web Component that drives `demo.items.list` and paints `columns`. */
function screen(columns) {
  const cols = columns
    .map(([key, filterType]) =>
      filterType == null ? `{ key: '${key}' }` : `{ key: '${key}', filterType: '${filterType}' }`,
    )
    .join(',\n    ');
  return `import { erplora } from '@erplora/module-sdk';
const columns = [
    ${cols}
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
`;
}

/**
 * A component whose column chooses its box AT RUNTIME — the shape `sales` had: a dropdown while the
 * catalogue of payment methods is loaded, a plain text box when it is not (module-toolkit#187).
 */
function branchingScreen(key, [whenLoaded, whenEmpty], rest = []) {
  const others = rest
    .map(([k, t]) => `  { key: '${k}', filterType: '${t}' },`)
    .join('\n');
  return `import { erplora } from '@erplora/module-sdk';
const columns = [
${others}
  {
    key: '${key}',
    label: 'Pago',
    ...(this.payMethods.length
      ? { filterType: '${whenLoaded}', options: this.payMethods }
      : { filterType: '${whenEmpty}' }),
  },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
`;
}

const UI = 'ui/components/erp-demo-items/erp-demo-items.ts';
const run = (opts) => {
  const { dir, manifest } = mod(opts);
  return checkFilterOps(dir, manifest);
};

// ── reading what the module declares ────────────────────────────────────────────────────────

test('listScreens: pairs the query a component drives with the columns it paints', () => {
  const found = listScreens(screen([['name', 'text'], ['status', 'select'], ['other', null]]));
  assert.deepEqual(found, [
    {
      query: 'demo.items.list',
      columns: [
        { key: 'name', filterTypes: ['text'], filterable: false, sentAs: 'name' },
        { key: 'status', filterTypes: ['select'], filterable: false, sentAs: 'status' },
        { key: 'other', filterTypes: [], filterable: false, sentAs: 'other' },
      ],
      inline: false,
    },
  ]);
});

test('listScreens: a column that can paint TWO boxes reports BOTH, not the first', () => {
  // module-toolkit#187. `exec` returns the FIRST match, so a column written as
  // `...(x ? { filterType: 'select' } : { filterType: 'text' })` used to read as a dropdown and the
  // text branch — the one the user actually gets when the catalogue did not load — was invisible.
  const [{ columns }] = listScreens(branchingScreen('payment_method_name', ['select', 'text']));
  assert.deepEqual(columns, [
    { key: 'payment_method_name', filterTypes: ['select', 'text'], filterable: false, sentAs: 'payment_method_name' },
  ]);
});

test('listScreens: the same box painted twice is reported once', () => {
  const [{ columns }] = listScreens(branchingScreen('status', ['select', 'select']));
  assert.deepEqual(columns, [{ key: 'status', filterTypes: ['select'], filterable: false, sentAs: 'status' }]);
});

test('listScreens: a column ends with ITS object, not at the next `key:`', () => {
  // taxes#54: cutting the source on the next `key: '` hands the LAST column of the array everything
  // written below it, so an unrelated `filterType` further down was credited to a column that
  // paints no box at all.
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  { key: 'name', filterType: 'text' },
  { key: 'status' },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
const toolbar = { filterType: 'select' };
`);
  assert.deepEqual(columns, [
    { key: 'name', filterTypes: ['text'], filterable: false, sentAs: 'name' },
    { key: 'status', filterTypes: [], filterable: false, sentAs: 'status' },
  ]);
});

test('listScreens: a `filterType` inside a comment paints nothing', () => {
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  // was { key: 'name', filterType: 'select' } until we fixed it
  { key: 'name', filterType: 'text' /* not filterType: 'select' any more */ },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
`);
  assert.deepEqual(columns, [{ key: 'name', filterTypes: ['text'], filterable: false, sentAs: 'name' }]);
});

test('listScreens: says whether each column is `filterable` — the flag that draws its box', () => {
  // ok-data-table draws a filter control only for `filterable: true`; with no `filterType` the
  // control is a text box. A comment that mentions the flag draws nothing.
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  { key: 'name', filterable: true },
  { key: 'difference', filterable: true, filterType: 'range' },
  { key: 'status', filterable: false, filterType: 'select' },
  { key: 'notes' /* filterable: true once */ },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
`);
  assert.deepEqual(columns, [
    { key: 'name', filterTypes: [], filterable: true, sentAs: 'name' },
    { key: 'difference', filterTypes: ['range'], filterable: true, sentAs: 'difference' },
    { key: 'status', filterTypes: ['select'], filterable: false, sentAs: 'status' },
    { key: 'notes', filterTypes: [], filterable: false, sentAs: 'notes' },
  ]);
});

test('listScreens: a column the screen RENAMES before it reaches the list is sent under the new name', () => {
  // sales: the table's date column is `created_at`, the server filter is `erp_date`; tables: the
  // zone column shows the name and the list filters `zone_id`. `onFilterChange` swaps the name.
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  { key: 'created_at', filterable: true, filterType: 'daterange' },
  { key: 'zone', filterable: true, filterType: 'select' },
  { key: 'is_active', filterable: true, filterType: 'select' },
  { key: 'name', filterable: true },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
function onFilterChange(e) {
  const col = e.detail.col === 'created_at' ? 'erp_date' : e.detail.col;
  if (e.detail.col === 'is_active') return this.applyStatusFilter(e.detail.value);
  this.ctrl.setFilter(detail.col == 'zone' ? 'zone_id' : col, e.detail.value);
}
`);
  assert.deepEqual(
    columns.map(({ key, sentAs }) => [key, sentAs]),
    [['created_at', 'erp_date'], ['zone', 'zone_id'], ['is_active', null], ['name', 'name']],
  );
});

test('listScreens: a column renamed in one place and taken by hand in another cannot be read', () => {
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [{ key: 'zone', filterable: true }, { key: 'area', filterable: true }];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
const a = col === 'zone' ? 'zone_id' : col;
if (col === 'zone') this.reset();
const b = col === 'area' ? 'area_id' : col;
const c = col === 'area' ? 'area_code' : col;
`);
  assert.deepEqual(columns.map(({ key, sentAs }) => [key, sentAs]), [['zone', null], ['area', null]]);
});

test('listScreens: a name compared only inside a comment or a string renames nothing', () => {
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [{ key: 'zone', filterable: true }];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
// col === 'zone' ? 'zone_id' : col
const help = "col === 'zone' ? 'zone_id' : col";
`);
  assert.deepEqual(columns.map(({ key, sentAs }) => [key, sentAs]), [['zone', 'zone']]);
});

test('listScreens: a ternary over the name that does not hand the column back is not a rename', () => {
  // `col === 'total' ? 'end' : 'start'` aligns a cell; reading it as a rename would judge the box
  // under `end` and refuse a list that declares `total` correctly (review of module-toolkit#408).
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  { key: 'total', filterable: true, filterType: 'range' },
  { key: 'zone', filterable: true },
  { key: 'area', filterable: true },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
const align = (col) => (col === 'total' ? 'end' : 'start');
const next = col === 'zone' ? 'zone_id' : col === 'area' ? 'area_id' : col;
`);
  // A chain of renames hands the column back at its end, so each arm is still a rename.
  assert.deepEqual(
    columns.map(({ key, sentAs }) => [key, sentAs]),
    [['total', null], ['zone', 'zone_id'], ['area', 'area_id']],
  );
});

test('listScreens: the rename is read with the name on either side, and a negated comparison is by hand', () => {
  const [{ columns }] = listScreens(`import { erplora } from '@erplora/module-sdk';
const columns = [
  { key: 'created_at', filterable: true, filterType: 'daterange' },
  { key: 'zone', filterable: true },
];
const ctl = createListController(erplora(), 'demo.items.list', { columns });
function onFilterChange(e) {
  ctl.setFilter('created_at' === e.detail.col ? 'erp_date' : e.detail.col, e.detail.value);
  const wire = e.detail.col !== 'zone' ? 'other' : e.detail.col; // zone is the one NOT renamed
}
`);
  assert.deepEqual(
    columns.map(({ key, sentAs }) => [key, sentAs]),
    [['created_at', 'erp_date'], ['zone', null]],
  );
});

test('listScreens: a source that drives no list says nothing', () => {
  assert.deepEqual(listScreens('export const x = 1;'), []);
});

test('declaredColumnTypes: reads the type of every column a CREATE TABLE declares', () => {
  const types = declaredColumnTypes(INIT);
  assert.equal(types.get('name'), 'TEXT NOT NULL');
  assert.equal(types.get('party_size'), 'INTEGER NOT NULL DEFAULT 2');
  assert.equal(types.get('created_at'), 'TIMESTAMPTZ NOT NULL');
});

test('declaredColumnTypes: a constraint line is not a column', () => {
  const types = declaredColumnTypes(
    'CREATE TABLE t (id TEXT PRIMARY KEY, UNIQUE (id), CHECK (id <> \'\'));',
  );
  assert.deepEqual([...types.keys()], ['id']);
});

test('declaredColumnTypes: ALTER TABLE … ADD COLUMN counts too', () => {
  const types = declaredColumnTypes('CREATE TABLE t (id TEXT);\nALTER TABLE t ADD COLUMN note TEXT;');
  assert.equal(types.get('note'), 'TEXT');
});

test('isTextualType: TEXT/VARCHAR/CITEXT are text; INTEGER/TIMESTAMPTZ/BOOLEAN are not', () => {
  for (const t of ['TEXT NOT NULL', 'VARCHAR(30)', 'character varying(8)', 'CITEXT']) {
    assert.equal(isTextualType(t), true, t);
  }
  for (const t of ['INTEGER NOT NULL DEFAULT 2', 'TIMESTAMPTZ', 'BOOLEAN', 'NUMERIC(10,2)', 'UUID']) {
    assert.equal(isTextualType(t), false, t);
  }
});

// ── rule 1 · the box has to mean what it looks like ─────────────────────────────────────────

test('a text box wired to `eq` is rejected: typing a fragment empties the list (ADR-0125)', () => {
  const { errors } = run({ filters: { name: { op: 'eq' } }, files: { [UI]: screen([['name', 'text']]) } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /demo\.items\.list/);
  assert.match(errors[0], /`name`/);
  assert.match(errors[0], /filterType: 'text'/);
  assert.match(errors[0], /op: 'like'/);
});

test('a text box wired to `like` is what ADR-0125 asks for: nothing to say', () => {
  const { errors, warnings } = run({
    filters: { name: { op: 'like' } },
    files: { [UI]: screen([['name', 'text']]) },
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a dropdown wired to `like` is rejected: «active» would also match «inactive»', () => {
  const { errors } = run({
    filters: { status: { op: 'like' } },
    files: { [UI]: screen([['status', 'select']]) },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`status`/);
  assert.match(errors[0], /op: 'eq'/);
});

test('a dropdown wired to `eq` is correct', () => {
  const { errors } = run({
    filters: { status: { op: 'eq' } },
    files: { [UI]: screen([['status', 'select']]) },
  });
  assert.deepEqual(errors, []);
});

test('a daterange box needs the operator that takes two bounds', () => {
  const bad = run({
    filters: { created_at: { op: 'eq' } },
    files: { [UI]: screen([['created_at', 'daterange']]) },
  });
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0], /op: 'range'/);

  const good = run({
    filters: { created_at: { op: 'range' } },
    files: { [UI]: screen([['created_at', 'daterange']]) },
  });
  assert.deepEqual(good.errors, []);
});

// ── rule 1b · a column that can paint two boxes has to be honest as BOTH (module-toolkit#187) ─

test('a column that falls back to a text box is judged on the FALLBACK too', () => {
  // The shape `sales` had: a dropdown of payment methods, a plain text box when the catalogue did
  // not load. With `op: 'eq'` the dropdown is right and the text box can never match, so the box the
  // user is left with on the bad day is exactly the ADR-0125 bug — and the gate said nothing.
  const { errors } = run({
    filters: { payment_method_name: { op: 'eq' } },
    files: { [UI]: branchingScreen('payment_method_name', ['select', 'text']) },
    sql: 'CREATE TABLE demo_items (id TEXT PRIMARY KEY, payment_method_name TEXT);',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`payment_method_name`/);
  assert.match(errors[0], /filterType: 'text'/);
  assert.match(errors[0], /op: 'like'/);
});

test('the verdict does not depend on WHICH BRANCH IS WRITTEN FIRST', () => {
  // This is the regression that closes module-toolkit#187: before it, swapping the two arms of the
  // ternary — the same screen, the same manifest, the same user — moved the module from 0 errors to
  // 1. A gate whose answer depends on the order of the source is not a gate.
  const of = (order) =>
    run({
      filters: { payment_method_name: { op: 'eq' } },
      files: { [UI]: branchingScreen('payment_method_name', order) },
      sql: 'CREATE TABLE demo_items (id TEXT PRIMARY KEY, payment_method_name TEXT);',
    }).errors;

  const selectFirst = of(['select', 'text']);
  const textFirst = of(['text', 'select']);
  assert.equal(selectFirst.length, 1);
  assert.deepEqual(selectFirst, textFirst);
});

test('a column honest in BOTH branches passes', () => {
  // Two boxes are not a defect by themselves. `select` and `select` both mean «choose one», and
  // `op: 'eq'` serves both, so there is nothing to report — the gate must not tax a fallback.
  const { errors, warnings } = run({
    filters: { status: { op: 'eq' } },
    files: { [UI]: branchingScreen('status', ['select', 'select']) },
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a column that can be text OR a dropdown is reported ONCE, naming both boxes', () => {
  // `text` wants `like` and `select` wants `eq`: no single `op` can serve both, so whichever the
  // manifest picks, one branch lies. The way out is to stop offering the filter on the branch that
  // cannot answer — and the message has to say so, or the author fixes half of it.
  const { errors } = run({
    filters: { payment_method_name: { op: 'like' } },
    files: { [UI]: branchingScreen('payment_method_name', ['select', 'text']) },
    sql: 'CREATE TABLE demo_items (id TEXT PRIMARY KEY, payment_method_name TEXT);',
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /filterType: 'select'/);
});

test('two SCREENS that paint one column differently are judged, not excused', () => {
  // The same hole through the other door: a column two components paint as two boxes used to be
  // DROPPED, so splitting the ternary into two screens would have bought silence back.
  const { errors } = run({
    filters: { name: { op: 'eq' } },
    files: {
      'ui/components/a/a.ts': screen([['name', 'select']]),
      'ui/components/b/b.ts': screen([['name', 'text']]),
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /filterType: 'text'/);
});

test('a text box over a NUMBER is not told to use `like`: it is the BOX that is wrong', () => {
  // The runtime composes `CAST(col AS TEXT) LIKE '%…%'`, so `like` over an INTEGER does not throw —
  // it quietly matches 12, 20 and 22 when the user types «2». The fix is the control, not the op.
  const { errors } = run({
    filters: { party_size: { op: 'eq' } },
    files: { [UI]: screen([['party_size', 'text']]) },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`party_size`/);
  assert.match(errors[0], /INTEGER/);
  assert.match(errors[0], /range/);
  assert.doesNotMatch(errors[0], /op: 'like'/);
});

test('a `filterType` the gate does not know is rejected, not ignored', () => {
  const { errors } = run({
    filters: { name: { op: 'eq' } },
    files: { [UI]: screen([['name', 'colour']]) },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /colour/);
  assert.match(errors[0], /no conoce/); // not the generic «op does not match» message
});

test('a column the screen paints with no `filterType` is not judged by rule 1', () => {
  const { errors } = run({
    filters: { status: { op: 'eq' } },
    files: { [UI]: screen([['status', null]]) },
  });
  assert.deepEqual(errors, []);
});

test('a file that drives TWO lists with no table to attribute its columns is warned, not judged', () => {
  // Under-cover rather than reject correct code: with no `ok-data-table` tag saying which list each
  // column belongs to, guessing is how a gate blocks a working screen. But it is no longer SILENT
  // (module-toolkit#407): the screen was not reviewed, and the warning says so.
  const two = `${screen([['name', 'select']])}
const other = createListController(erplora(), 'demo.other.list', { columns });`;
  const { errors, warnings } = run({ filters: { name: { op: 'like' } }, files: { [UI]: two } });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /module-toolkit#407/);
});

test('a column two screens paint DIFFERENTLY is judged, and judged the same way every run', () => {
  // This test used to assert the OPPOSITE — that the column was DROPPED — on the grounds that
  // judging it might reject one of two correct screens. Measured while closing module-toolkit#187,
  // that reasoning does not hold: the manifest declares ONE `op`, so two boxes that need different
  // operators cannot both be served, and dropping the column excused BOTH of them. Here `select`
  // and `daterange` are each wrong for `op: 'like'`; before, that was zero errors.
  const files = {
    [UI]: screen([['name', 'select']]),
    'ui/components/erp-demo-other/erp-demo-other.ts': screen([['name', 'daterange']]),
  };
  const { errors } = run({ filters: { name: { op: 'like' } }, files });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`name`/);

  // …and the message does not depend on which file `readdir` happened to hand over first.
  const flipped = run({
    filters: { name: { op: 'like' } },
    files: {
      [UI]: screen([['name', 'daterange']]),
      'ui/components/erp-demo-other/erp-demo-other.ts': screen([['name', 'select']]),
    },
  }).errors;
  assert.equal(flipped.length, 1);
});

// ── rule 2 · `like` over a column that is not text ──────────────────────────────────────────

test('`like` on an INTEGER column is rejected: the runtime CASTs, so «2» also matches 12 and 20', () => {
  const { errors } = run({ filters: { party_size: { op: 'like' } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`party_size`/);
  assert.match(errors[0], /INTEGER/);
});

test('`like` on a TIMESTAMPTZ column is rejected too', () => {
  const { errors } = run({ filters: { created_at: { op: 'like' } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`created_at`/);
});

test('`like` on a TEXT column is exactly what ADR-0125 wants', () => {
  const { errors, warnings } = run({ filters: { name: { op: 'like' } } });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a column no migration of this module declares is not judged (it belongs to somebody else)', () => {
  const { errors, warnings } = run({ filters: { foreign_col: { op: 'like' } } });
  assert.deepEqual([...errors, ...warnings], []);
});

// ── rule 3 · the ADR-0125 whitelist, `eq` direction ONLY ────────────────────────────────────

test('a free-text column filtered with `eq` and painted by nobody is still the ADR-0125 bug', () => {
  const { errors } = run({ filters: { name: { op: 'eq' } } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /`name`/);
  assert.match(errors[0], /ADR-0125/);
});

test('`like` OUTSIDE the whitelist says nothing: measured 18/18 false positives on origin/main', () => {
  // `slug`, `reference`, `key`, `region_code`, `display_description`… are free text the old guard
  // did not know. Blocking them would block a published module for doing the right thing.
  const { errors, warnings } = run({
    filters: { slug: { op: 'like' } },
    sql: 'CREATE TABLE demo_items (id TEXT PRIMARY KEY, slug TEXT NOT NULL);',
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a whitelisted name painted as a DROPDOWN keeps `eq`: the box wins over the name', () => {
  // `name` is in the ADR-0125 whitelist, but this screen says the value is CHOSEN, not typed —
  // and a chosen value is matched whole. Judging it by its name would reject a correct screen.
  const { errors, warnings } = run({
    filters: { name: { op: 'eq' } },
    files: { [UI]: screen([['name', 'select']]) },
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('the painted `filterType` wins over the whitelist: no column is reported twice', () => {
  const { errors } = run({
    filters: { name: { op: 'eq' } },
    files: { [UI]: screen([['name', 'text']]) },
  });
  assert.equal(errors.length, 1);
});

// ── rule 4 · a box the screen offers has to be a filter the list accepts (module-toolkit#382) ─

/** A Web Component that drives `query` and paints `columns` written verbatim (object literals). */
function paintedScreen(columns, query = 'demo.items.list') {
  return `import { erplora } from '@erplora/module-sdk';
const columns = [
  ${columns.join(',\n  ')}
];
const ctl = createListController(erplora(), '${query}', { columns });
`;
}

/** A module whose manifest is written whole — for queries the `mod` helper cannot shape. */
function modWith(queries, files) {
  const { dir } = mod({ files });
  const manifest = { id: 'demo', migrations: { postgres: ['migrations/postgres/001_init.sql'] }, queries };
  return checkFilterOps(dir, manifest);
}

test('a range box over a column the list does not filter is rejected, naming the column and the list', () => {
  // cash_register#107: `difference` painted as a range, `list.filters.difference` deleted. The table
  // sends `f_difference_from`, the kernel answers 422 unknown_filter, and validate said exit 0.
  const { errors, warnings } = run({
    filters: { name: { op: 'like' } },
    files: {
      [UI]: paintedScreen([
        "{ key: 'name', filterable: true, filterType: 'text' }",
        "{ key: 'difference', filterable: true, filterType: 'range' }",
      ]),
    },
  });
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`difference`/);
  assert.match(errors[0], /demo\.items\.list/);
  assert.match(errors[0], /list\.filters/);
  assert.match(errors[0], /unknown_filter/);
});

test('a `filterable` column with no `filterType` is a text box, and it is judged too', () => {
  const { errors } = run({
    filters: { name: { op: 'like' } },
    files: { [UI]: paintedScreen(["{ key: 'status', filterable: true }"]) },
  });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`status`/);
});

test('a list with a `list` block but NO `filters` at all still rejects the box it cannot answer', () => {
  const errors = modWith(
    { 'demo.items.list': { list: { sortable: ['name'] } } },
    { [UI]: paintedScreen(["{ key: 'status', filterable: true, filterType: 'select' }"]) },
  ).errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`status`/);
});

test('a box over a filter the list DOES declare is not reported by this rule', () => {
  const { errors, warnings } = run({
    filters: { status: { op: 'eq' }, created_at: { op: 'range' } },
    files: {
      [UI]: paintedScreen([
        "{ key: 'status', filterable: true, filterType: 'select' }",
        "{ key: 'created_at', filterable: true, filterType: 'daterange' }",
      ]),
    },
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a column that is not `filterable` draws no box, so it asks nothing of the list', () => {
  const { errors, warnings } = run({
    filters: {},
    files: {
      [UI]: paintedScreen([
        "{ key: 'status', filterType: 'select' }",
        "{ key: 'name', filterable: false }",
        "{ key: 'notes' /* filterable: true */ }",
      ]),
    },
  });
  assert.deepEqual([...errors, ...warnings], []);
});

test('the runtime also accepts a bind its SQL reads: `:f_<col>` is not an unknown filter', () => {
  // `accepted_params` (hub/crates/runtime/src/queries.rs) takes every bind of the base SQL, so a
  // list that answers the box by hand is not rejected by the kernel — and must not be here either.
  const errors = modWith(
    {
      'demo.items.list': {
        sql: 'SELECT * FROM demo_items WHERE hub_id = :hub_id AND (:f_status IS NULL OR status = :f_status) ' +
          'AND (:f_created_at_from IS NULL OR created_at >= :f_created_at_from) ' +
          'AND (:f_created_at_to IS NULL OR created_at <= :f_created_at_to)',
        list: { filters: {} },
      },
    },
    {
      [UI]: paintedScreen([
        "{ key: 'status', filterable: true, filterType: 'select' }",
        "{ key: 'created_at', filterable: true, filterType: 'daterange' }",
      ]),
    },
  ).errors;
  assert.deepEqual(errors, []);
});

test('a range box needs BOTH bounds accepted: one bind of the pair is still an unknown filter', () => {
  const errors = modWith(
    {
      'demo.items.list': {
        sql: 'SELECT * FROM demo_items WHERE (:f_created_at_from IS NULL OR created_at >= :f_created_at_from)',
        list: { filters: {} },
      },
    },
    { [UI]: paintedScreen(["{ key: 'created_at', filterable: true, filterType: 'daterange' }"]) },
  ).errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /f_created_at_to/);
});

test('a bind written in a SQL FILE counts the same as inline SQL', () => {
  const errors = modWith(
    { 'demo.items.list': { sql: 'queries/items_list.sql', list: { filters: {} } } },
    {
      'queries/items_list.sql': 'SELECT * FROM demo_items -- :f_name in a comment is not a bind\n' +
        "WHERE (:f_status IS NULL OR status = :f_status) AND label <> ':f_name /* nor in a string */'",
      [UI]: paintedScreen([
        "{ key: 'status', filterable: true, filterType: 'select' }",
        "{ key: 'name', filterable: true }",
      ]),
    },
  ).errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`name`/);
});

test('a property the query schema declares is accepted, as the runtime accepts it', () => {
  const errors = modWith(
    {
      'demo.items.list': {
        schema: { type: 'object', properties: { f_status: { type: 'string' } } },
        list: { filters: {} },
      },
    },
    { [UI]: paintedScreen(["{ key: 'status', filterable: true, filterType: 'select' }"]) },
  ).errors;
  assert.deepEqual(errors, []);
});

test('a screen over a query that is not a `list`, or not declared at all, is not judged here', () => {
  // A query with no `list` block is not paged by the runtime's list engine, and a query the manifest
  // does not declare is the contracts gate's finding, not a filter verdict.
  const plain = modWith(
    { 'demo.items.list': { sql: 'SELECT * FROM demo_items' } },
    { [UI]: paintedScreen(["{ key: 'status', filterable: true }"]) },
  );
  assert.deepEqual(plain, { errors: [], warnings: [] });

  const absent = modWith(
    { 'demo.other.list': { list: { filters: {} } } },
    { [UI]: paintedScreen(["{ key: 'status', filterable: true }"]) },
  );
  assert.deepEqual(absent, { errors: [], warnings: [] });
});

test('a box the screen RENAMES is judged under the name it sends: renamed to a declared filter, fine', () => {
  const remap = (target) =>
    paintedScreen(["{ key: 'created_at', filterable: true, filterType: 'daterange' }"]) +
    `function onFilterChange(e) {\n  ctl.setFilter(e.detail.col === 'created_at' ? '${target}' : e.detail.col, e.detail.value);\n}\n`;

  const good = run({ filters: { erp_date: { op: 'range' } }, files: { [UI]: remap('erp_date') } });
  assert.deepEqual([...good.errors, ...good.warnings], []);

  const bad = run({ filters: { erp_date: { op: 'range' } }, files: { [UI]: remap('erp_day') } });
  assert.equal(bad.errors.length, 1, JSON.stringify(bad.errors));
  assert.match(bad.errors[0], /`created_at`/);
  assert.match(bad.errors[0], /f_erp_day_from/);
});

test('a box the screen takes BY HAND (compares its name and does its own thing) is not judged', () => {
  // inventory's product status: one column, three values, two server columns — its filter is not a
  // `setFilter` of the column, and what reaches the wire cannot be read from here.
  const byHand =
    paintedScreen(["{ key: 'state', filterable: true, filterType: 'select' }"]) +
    "function onFilterChange(e) {\n  if (e.detail.col === 'state') return this.applyStatusFilter(e.detail.value);\n" +
    '  ctl.setFilter(e.detail.col, e.detail.value);\n}\n';
  const { errors, warnings } = run({ filters: {}, files: { [UI]: byHand } });
  assert.deepEqual([...errors, ...warnings], []);
});

test('a correct list is not refused because the screen compares a column name for something else', () => {
  // The list declares `total` as the range its box needs; the screen only aligns that cell.
  const aligned =
    paintedScreen(["{ key: 'total', filterable: true, filterType: 'range' }"]) +
    "const align = (col) => (col === 'total' ? 'end' : 'start');\n" +
    'function onFilterChange(e) {\n  ctl.setFilter(e.detail.col, e.detail.value);\n}\n';
  const { errors, warnings } = run({ filters: { total: { op: 'range' } }, files: { [UI]: aligned } });
  assert.deepEqual([...errors, ...warnings], []);
});

// ── a screen that shows TWO lists (module-toolkit#407) ──────────────────────────────────────
// pricing (rates + rules), reservations (slots + blocked days) and schedules (special days +
// overrides) each drive two lists from one file. Their columns used to be dropped whole, because the
// file's column list could not be attributed to one query without guessing — 24 boxes nobody judged.
// A table says which list it belongs to in its own tag: `.columns=${…}` names its columns and
// `@filterChange` hands the box to ONE controller's `setFilter`.

const handler = (ctrl) =>
  `\${(e: CustomEvent<{ col: string; value: unknown }>) => this.${ctrl}.setFilter(e.detail.col, e.detail.value)}`;

/**
 * The shape the three real screens share: two controllers, two column getters, two server tables.
 * `items`/`other` are the column literals of each table; every other piece can be swapped to write
 * the forms a screen may take.
 */
function twoLists({
  items = [],
  other = [],
  members = '',
  itemsTag = `.serverSide=\${true} .columns=\${this.itemColumns} .rows=\${this.itemsCtrl?.rows ?? []} @filterChange=${handler('itemsCtrl')}`,
  otherTag = `.serverSide=\${true} .columns=\${this.otherColumns} .rows=\${this.otherCtrl?.rows ?? []} @filterChange=${handler('otherCtrl')}`,
  extraTags = '',
  tables = null,
} = {}) {
  return `import { LitElement, html } from 'lit';
import { createListController } from '@erplora/module-sdk';
import type { ListController } from '@erplora/module-sdk';

export class ErpDemoTwo extends LitElement {
  private itemsCtrl!: ListController<Item>;

  private otherCtrl!: ListController<Other>;

  private get itemColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      ${items.join(',\n      ')}
    ];
  }

  private get otherColumns(): DataTableColumn[] {
    return [
      ${other.join(',\n      ')}
    ];
  }
${members}
  async connectedCallback(): Promise<void> {
    super.connectedCallback();
    this.itemsCtrl = createListController<Item>(erplora(), 'demo.items.list', () => this.requestUpdate(), {
      pageSize: 50,
    });
    this.otherCtrl = createListController<Other>(erplora(), 'demo.other.list', () => this.requestUpdate(), {
      pageSize: 50,
    });
  }

  render() {
    return html\`
      <div class="page">
        ${tables ?? `<ok-data-table testid="items-table" ${itemsTag}></ok-data-table>
        <ok-data-table testid="other-table" ${otherTag}></ok-data-table>`}
        ${extraTags}
      </div>
    \`;
  }
}
`;
}

/** Both lists declared, each with its own `list.filters`. */
const twoListRun = (itemFilters, otherFilters, source, extra = {}) =>
  modWith(
    {
      'demo.items.list': { list: { filters: itemFilters } },
      'demo.other.list': { list: { filters: otherFilters }, ...extra },
    },
    { [UI]: source },
  );

test('listScreens: a file that drives two lists hands each table ITS columns, not the file\'s', () => {
  const found = listScreens(
    twoLists({
      items: ["{ key: 'name', header: t('ui.name'), filterable: true, filterType: 'text' }"],
      other: ["{ key: 'reason', filterable: true, filterType: 'select' }"],
    }),
  );
  assert.deepEqual(
    found.map((s) => [s.query, s.columns.map((c) => c.key)]),
    [
      ['demo.items.list', ['name']],
      ['demo.other.list', ['reason']],
    ],
  );
});

test('two lists: a box the SECOND table offers over a filter its list does not accept is an error', () => {
  // The issue's own check: drop `rule_type` from `pricing.rules.list` while its table still offers
  // the box — `erplora validate` said exit 0, and in the hub the list failed with 422.
  const { errors, warnings } = twoListRun(
    { name: { op: 'like' } },
    {},
    twoLists({
      items: ["{ key: 'name', filterable: true, filterType: 'text' }"],
      other: ["{ key: 'rule_type', filterable: true, filterType: 'select' }"],
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`rule_type`/);
  assert.match(errors[0], /demo\.other\.list/);
  assert.match(errors[0], /unknown_filter/);
});

test('two lists: a column of one table asks nothing of the OTHER list', () => {
  // Attributing the file's columns to both queries — the guess #382 refused to make — would demand
  // `status` from `demo.other.list`, whose table never shows it: a correct screen, blocked.
  const { errors, warnings } = twoListRun(
    { status: { op: 'eq' } },
    { reason: { op: 'like' } },
    twoLists({
      items: ["{ key: 'status', filterable: true, filterType: 'select' }"],
      other: ["{ key: 'reason', filterable: true, filterType: 'text' }"],
    }),
  );
  assert.deepEqual([...errors, ...warnings], []);
});

test('two lists: rules 1-3 judge each table against its own list (ADR-0125)', () => {
  // A text box on the second table wired to `eq` — the lie ADR-0125 is about — no longer hides
  // behind the first table.
  const { errors } = twoListRun(
    { name: { op: 'like' } },
    { reason: { op: 'eq' } },
    twoLists({
      items: ["{ key: 'name', filterable: true, filterType: 'text' }"],
      other: ["{ key: 'reason', filterable: true, filterType: 'text' }"],
    }),
  );
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`reason`/);
  assert.match(errors[0], /demo\.other\.list/);
  assert.match(errors[0], /op: "eq"/);
});

test('two lists: the columns are read from a getter, a method, a field or an inline array', () => {
  const box = "{ key: 'code', filterable: true, filterType: 'text' }";
  const forms = {
    method: {
      members: `\n  private ruleCols(): DataTableColumn[] {\n    return [${box}];\n  }\n`,
      expr: 'this.ruleCols()',
    },
    field: {
      members: `\n  private readonly ruleCols: DataTableColumn[] = [\n    ${box},\n  ];\n`,
      expr: 'this.ruleCols',
    },
    arrow: {
      members: `\n  private ruleCols = (): DataTableColumn[] => [${box}];\n`,
      expr: 'this.ruleCols()',
    },
    inline: { members: '', expr: `[${box}]` },
  };
  for (const [form, { members, expr }] of Object.entries(forms)) {
    const source = twoLists({
      members,
      otherTag: `.serverSide=\${true} .columns=\${${expr}} @filterChange=${handler('otherCtrl')}`,
    });
    const { errors, warnings } = twoListRun({}, {}, source);
    assert.deepEqual(warnings, [], form);
    assert.equal(errors.length, 1, `${form}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /`code`/, form);
    assert.match(errors[0], /demo\.other\.list/, form);
  }
});

test('two lists: a handler that goes through a method is followed to the controller it feeds', () => {
  const members = `
  private onOtherFilter(e: CustomEvent<{ col: string; value: unknown }>): void {
    this.otherCtrl.setFilter(e.detail.col, e.detail.value);
  }
`;
  for (const call of ['${this.onOtherFilter}', '${(e: CustomEvent) => this.onOtherFilter(e)}']) {
    const { errors } = twoListRun(
      {},
      {},
      twoLists({
        members,
        other: ["{ key: 'reason', filterable: true, filterType: 'select' }"],
        otherTag: `.serverSide=\${true} .columns=\${this.otherColumns} @filterChange=${call}`,
      }),
    );
    assert.equal(errors.length, 1, `${call}: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /demo\.other\.list/, call);
  }
});

test('two lists: a controller read through a local alias is followed to ITS list (cash_register)', () => {
  // cash_register's session detail renders each table in its own method, both with
  // `const ctrl = this.<list>` — the same alias for two lists. The declaration that counts is the one
  // in force where the tag is written.
  const render = (method, field, columns) => `
  private ${method}() {
    const ctrl = this.${field};
    if (!ctrl) return nothing;
    return html\`<ok-data-table .serverSide=\${true} .columns=\${this.${columns}} .rows=\${ctrl.rows ?? []}
      @filterChange=\${(e: CustomEvent<{ col: string; value: unknown }>) => ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>\`;
  }
`;
  const { errors, warnings } = twoListRun(
    { status: { op: 'eq' } },
    {},
    twoLists({
      items: ["{ key: 'status', filterable: true, filterType: 'select' }"],
      other: ["{ key: 'kind', filterable: true, filterType: 'select' }"],
      members: render('renderItems', 'itemsCtrl', 'itemColumns') + render('renderOther', 'otherCtrl', 'otherColumns'),
      tables: '${this.renderItems()} ${this.renderOther()}',
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`kind`/);
  assert.match(errors[0], /demo\.other\.list/);
});

test('two lists: a table with no handler is tied by the alias its tag reads', () => {
  // The tag names no `@filterChange`: the controller it belongs to is the one it reads anywhere —
  // here through `ctrl`, declared differently in each method.
  const render = (method, field, columns) => `
  private ${method}() {
    const ctrl = this.${field};
    return html\`<ok-data-table .serverSide=\${true} .columns=\${this.${columns}} .rows=\${ctrl.rows ?? []}></ok-data-table>\`;
  }
`;
  const { errors, warnings } = twoListRun(
    { status: { op: 'eq' } },
    {},
    twoLists({
      items: ["{ key: 'status', filterable: true, filterType: 'select' }"],
      other: ["{ key: 'kind', filterable: true, filterType: 'select' }"],
      members: render('renderItems', 'itemsCtrl', 'itemColumns') + render('renderOther', 'otherCtrl', 'otherColumns'),
      tables: '${this.renderItems()} ${this.renderOther()}',
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`kind`/);
  assert.match(errors[0], /demo\.other\.list/);
});

test('two lists: columns assigned in two places are WARNED, not read from the first one', () => {
  // Which array the table holds depends on what ran last: judging either one would be a guess.
  const { errors, warnings } = twoListRun(
    {},
    {},
    twoLists({
      members: `
  private extraColumns: DataTableColumn[] = [{ key: 'code', filterable: true }];

  private narrow(): void {
    this.extraColumns = [{ key: 'label', filterable: true }];
  }
`,
      otherTag: `.serverSide=\${true} .columns=\${this.extraColumns} @filterChange=${handler('otherCtrl')}`,
    }),
  );
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /module-toolkit#407/);
});

test('two lists: a quoted binding (`.columns="${…}"`) ties the table the same as a bare one', () => {
  const { errors, warnings } = twoListRun(
    {},
    {},
    twoLists({
      other: ["{ key: 'kind', filterable: true, filterType: 'select' }"],
      otherTag: `.serverSide="\${true}" .columns="\${this.otherColumns}" @filterChange="${handler('otherCtrl')}"`,
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /demo\.other\.list/);
});

test('two lists: a `//` inside a string of a binding does not swallow the attributes after it', () => {
  const { errors, warnings } = twoListRun(
    {},
    {},
    twoLists({
      other: ["{ key: 'kind', filterable: true, filterType: 'select' }"],
      otherTag:
        `.serverSide=\${true} @rowClick=\${(r: Other) => window.open('https://erplora.com/r/' + r.id)} ` +
        `.columns=\${this.otherColumns} @filterChange=${handler('otherCtrl')}`,
    }),
  );
  assert.deepEqual(warnings, []);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /demo\.other\.list/);
});

test('two lists: a rename is read from THAT table\'s handler, not from the other one', () => {
  // The second table sends `zone` as `zone_id`; the first sends it as it is. Reading the rename file-
  // wide would send the first table's `zone` as `zone_id` too, and refuse a list that declares it.
  const renaming =
    `\${(e: CustomEvent<{ col: string; value: unknown }>) => ` +
    `this.otherCtrl.setFilter(e.detail.col === 'zone' ? 'zone_id' : e.detail.col, e.detail.value)}`;
  const { errors, warnings } = twoListRun(
    { zone: { op: 'eq' } },
    { zone_id: { op: 'eq' } },
    twoLists({
      items: ["{ key: 'zone', filterable: true, filterType: 'select' }"],
      other: ["{ key: 'zone', filterable: true, filterType: 'select' }"],
      otherTag: `.serverSide=\${true} .columns=\${this.otherColumns} @filterChange=${renaming}`,
    }),
  );
  assert.deepEqual([...errors, ...warnings], []);
});

test('two lists: a table that cannot be attributed is WARNED, not judged and not silenced', () => {
  // The safe direction stays: a guess can refuse correct code, so there is no error — but a screen
  // whose boxes nobody checked says so, instead of passing as if it had been reviewed.
  const unreadable = {
    'columns built by a call with arguments': twoLists({
      members: `\n  private cols(kind: string): DataTableColumn[] {\n    return [{ key: 'code', filterable: true }];\n  }\n`,
      otherTag: `.serverSide=\${true} .columns=\${this.cols('other')} @filterChange=${handler('otherCtrl')}`,
    }),
    'a handler that feeds both controllers': twoLists({
      other: ["{ key: 'code', filterable: true }"],
      otherTag:
        `.serverSide=\${true} .columns=\${this.otherColumns} @filterChange=\${(e: CustomEvent) => ` +
        `{ this.itemsCtrl.setFilter(e.detail.col, e.detail.value); this.otherCtrl.setFilter(e.detail.col, e.detail.value); }}`,
    }),
    'a server table whose handler reaches no controller': twoLists({
      other: ["{ key: 'code', filterable: true }"],
      otherTag: `.serverSide=\${true} .columns=\${this.otherColumns} @filterChange=\${(e: CustomEvent) => this.dispatchEvent(e)}`,
    }),
  };
  for (const [why, source] of Object.entries(unreadable)) {
    const { errors, warnings } = twoListRun({}, {}, source);
    assert.deepEqual(errors, [], why);
    assert.equal(warnings.length, 1, `${why}: ${JSON.stringify(warnings)}`);
    assert.match(warnings[0], /^\[filter-ops\]/, why);
    assert.match(warnings[0], /erp-demo-items\.ts/, why);
    assert.match(warnings[0], /module-toolkit#407/, why);
  }
});

test('two lists whose tables offer no box say nothing (cash_register session detail)', () => {
  const { errors, warnings } = twoListRun(
    {},
    {},
    twoLists({
      items: ["{ key: 'name', sortable: true }"],
      other: ["{ key: 'amount', align: 'right' }"],
    }),
  );
  assert.deepEqual([...errors, ...warnings], []);
});

test('two lists: a client-side table that drives no list is not a list screen (reservations occupancy)', () => {
  // `ok-data-table` filters its own rows in memory when it is not `serverSide`: no box of it ever
  // reaches the runtime, so it asks nothing of either list and there is nothing to warn about.
  const { errors, warnings } = twoListRun(
    {},
    {},
    twoLists({
      members: `\n  private get occColumns(): DataTableColumn[] {\n    return [{ key: 'occupied', filterable: true, filterType: 'select' }];\n  }\n`,
      extraTags: '<ok-data-table testid="occupancy" .columns=${this.occColumns} .rows=${this.occRows}></ok-data-table>',
    }),
  );
  assert.deepEqual([...errors, ...warnings], []);
});

test('two lists: a table tag written inside a comment is not a table', () => {
  // Read as a table, the comment would hand the FIRST table's `status` to the second list too.
  const source = twoLists({
    items: ["{ key: 'status', filterable: true, filterType: 'select' }"],
    other: ["{ key: 'kind', filterable: true, filterType: 'select' }"],
  }).replace(
    'export class',
    `// <ok-data-table .serverSide=\${true} .columns=\${this.itemColumns} @filterChange=${handler('otherCtrl')}>\nexport class`,
  );
  const { errors, warnings } = twoListRun({ status: { op: 'eq' } }, { kind: { op: 'eq' } }, source);
  assert.deepEqual([...errors, ...warnings], []);
});

test('a template nested inside another is read as markup, not as code', () => {
  // Read as code, the apostrophe of the inner template opens a string that swallows the columns.
  const source =
    "const hint = (empty: boolean) => html`<div>${empty ? html`<p>It's empty</p>` : nothing}</div>`;\n" +
    paintedScreen(["{ key: 'status', filterable: true, filterType: 'select' }"]);
  assert.deepEqual(
    listScreens(source).map((s) => [s.query, s.columns.map((c) => c.key)]),
    [['demo.items.list', ['status']]],
  );
});

// ── what each box SENDS depends on the table, not only on its `filterType` (rv-mt-408) ──────
// `ok-data-table` with `inlineFilters` draws its boxes in the toolbar, and only four kinds of them:
// `select`/`multiselect` as they are, and `date` as a FROM → TO pill that sends `{ from, to }` —
// `f_<col>_from`/`_to` on the wire, where the drawer's `date` sends one `f_<col>`. The funnel (the
// drawer) is not drawn at all, so a text or range box of such a table is never offered.

const inlineScreen = (inline, columns) =>
  paintedScreen(columns) +
  `const view = html\`<ok-data-table .serverSide=\${true} ${inline} .columns=\${columns} @filterChange=\${(e) => ctl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>\`;\n`;

const dateBinds = (...binds) => ({
  'demo.items.list': {
    sql: `SELECT * FROM demo_items WHERE hub_id = :hub_id ${binds.map((b) => `AND (:${b} IS NULL OR created_at::date = :${b})`).join(' ')}`,
    list: { filters: {} },
  },
});

test('inlineFilters: a `date` box sends two bounds, so the list has to accept both', () => {
  const date = ["{ key: 'created_at', filterable: true, filterType: 'date' }"];
  for (const inline of ['.inlineFilters=${true}', 'inlinefilters']) {
    const single = modWith(dateBinds('f_created_at'), { [UI]: inlineScreen(inline, date) }).errors;
    assert.equal(single.length, 1, `${inline}: ${JSON.stringify(single)}`);
    assert.match(single[0], /f_created_at_from/, inline);

    const pair = modWith(dateBinds('f_created_at_from', 'f_created_at_to'), { [UI]: inlineScreen(inline, date) });
    assert.deepEqual([...pair.errors, ...pair.warnings], [], inline);
  }
});

test('without inlineFilters a `date` box is ONE value, as before', () => {
  const date = ["{ key: 'created_at', filterable: true, filterType: 'date' }"];
  for (const inline of ['', '.inlineFilters=${false}']) {
    const single = modWith(dateBinds('f_created_at'), { [UI]: inlineScreen(inline, date) });
    assert.deepEqual([...single.errors, ...single.warnings], [], inline);

    const pair = modWith(dateBinds('f_created_at_from', 'f_created_at_to'), { [UI]: inlineScreen(inline, date) }).errors;
    assert.equal(pair.length, 1, `${inline}: ${JSON.stringify(pair)}`);
    assert.match(pair[0], /`f_created_at`/, inline);
  }
});

test('inlineFilters decided at runtime: a `date` box has to be answerable BOTH ways', () => {
  const date = ["{ key: 'created_at', filterable: true, filterType: 'date' }"];
  const screenSrc = inlineScreen('.inlineFilters=${this.phone}', date);
  assert.equal(modWith(dateBinds('f_created_at'), { [UI]: screenSrc }).errors.length, 1);
  assert.equal(modWith(dateBinds('f_created_at_from', 'f_created_at_to'), { [UI]: screenSrc }).errors.length, 1);
  const all = modWith(dateBinds('f_created_at', 'f_created_at_from', 'f_created_at_to'), { [UI]: screenSrc });
  assert.deepEqual([...all.errors, ...all.warnings], []);
});

test('inlineFilters: one list shown by two tables that disagree has to answer BOTH ways', () => {
  // A phone layout and a desktop one over the same controller: each table sends its own shape.
  const date = ["{ key: 'created_at', filterable: true, filterType: 'date' }"];
  const tag = (inline) =>
    `<ok-data-table .serverSide=\${true} ${inline} .columns=\${columns} @filterChange=\${(e) => ctl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>`;
  for (const order of [['.inlineFilters=${true}', ''], ['', '.inlineFilters=${true}']]) {
    const screenSrc = `${paintedScreen(date)}const view = html\`${order.map(tag).join('\n')}\`;\n`;
    assert.equal(modWith(dateBinds('f_created_at'), { [UI]: screenSrc }).errors.length, 1, order.join('|'));
    assert.equal(modWith(dateBinds('f_created_at_from', 'f_created_at_to'), { [UI]: screenSrc }).errors.length, 1, order.join('|'));
    const all = modWith(dateBinds('f_created_at', 'f_created_at_from', 'f_created_at_to'), { [UI]: screenSrc });
    assert.deepEqual([...all.errors, ...all.warnings], [], order.join('|'));
  }
});

test('inlineFilters: a text or range box is not drawn, so it asks nothing of the list', () => {
  const hidden = [
    "{ key: 'notes', filterable: true, filterType: 'text' }",
    "{ key: 'party_size', filterable: true, filterType: 'range' }",
    "{ key: 'title', filterable: true }",
  ];
  const inline = run({ filters: {}, files: { [UI]: inlineScreen('.inlineFilters=${true}', hidden) } });
  assert.deepEqual([...inline.errors, ...inline.warnings], []);

  // The same columns in the drawer ARE offered — the control that proves the fixture paints them.
  const drawer = run({ filters: {}, files: { [UI]: inlineScreen('', hidden) } });
  assert.equal(drawer.errors.length, 3, JSON.stringify(drawer.errors));
});

test('inlineFilters: a dropdown is still drawn in the toolbar and still judged', () => {
  const select = ["{ key: 'status', filterable: true, filterType: 'select' }"];
  const { errors } = run({ filters: {}, files: { [UI]: inlineScreen('.inlineFilters=${true}', select) } });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /`f_status`/);
});

test('two lists: inlineFilters is read per table', () => {
  const date = "{ key: 'created_at', filterable: true, filterType: 'date' }";
  const source = twoLists({
    items: [date],
    other: [date],
    otherTag: `.serverSide=\${true} .inlineFilters=\${true} .columns=\${this.otherColumns} @filterChange=${handler('otherCtrl')}`,
  });
  const errors = modWith(
    {
      'demo.items.list': { sql: 'SELECT * FROM demo_items WHERE (:f_created_at IS NULL OR 1=1)', list: { filters: {} } },
      'demo.other.list': { sql: 'SELECT * FROM demo_items WHERE (:f_created_at IS NULL OR 1=1)', list: { filters: {} } },
    },
    { [UI]: source },
  ).errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /demo\.other\.list/);
  assert.match(errors[0], /f_created_at_from/);
});

// ── the ratchet ─────────────────────────────────────────────────────────────────────────────

test('a grandfathered filter warns instead of blocking, and names its issue', () => {
  // The fixture reproduces EVERY entry the list owes for one module, so the test says nothing about
  // which rule caught each one and does not break when the list shrinks — only when it empties.
  const id = FILTER_OPS_GRANDFATHERED[0][0];
  const owed = FILTER_OPS_GRANDFATHERED.filter(([m]) => m === id);
  const byQuery = new Map();
  for (const [, query, column] of owed) {
    if (!byQuery.has(query)) byQuery.set(query, []);
    byQuery.get(query).push(column);
  }

  const columns = owed.map(([, , c]) => c);
  const files = { 'migrations/postgres/001_init.sql':
    `CREATE TABLE t (\n${columns.map((c) => `  ${c} TEXT NOT NULL`).join(',\n')}\n);` };
  const queries = {};
  let n = 0;
  for (const [query, cols] of byQuery) {
    n += 1;
    files[`ui/components/s${n}/s${n}.ts`] = `const c = createListController(erplora(), '${query}', {\n  columns: [${cols
      .map((c) => `{ key: '${c}', filterType: 'text' }`)
      .join(', ')}],\n});`;
    queries[query] = {
      list: { filters: Object.fromEntries(cols.map((c) => [c, { op: 'eq' }])) },
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'erplora-filterops-gf-'));
  for (const [name, bodyText] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), bodyText);
  }
  const manifest = { id, migrations: { postgres: ['migrations/postgres/001_init.sql'] }, queries };

  const { errors, warnings } = checkFilterOps(dir, manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, owed.length);
  for (const w of warnings) assert.match(w, /183/);
});

test('a grandfathered entry that no longer applies FAILS: the list only shrinks', () => {
  // The module that DECLARES the query is the one that can have fixed it, so it is the one the
  // stale line blocks — that is what fixes the order of the two pull requests (module-toolkit#189).
  const id = FILTER_OPS_GRANDFATHERED[0][0];
  const owed = FILTER_OPS_GRANDFATHERED.filter(([m]) => m === id);
  const { dir, manifest } = mod({ id, filters: { name: { op: 'like' } } });
  const { errors } = checkFilterOps(dir, { ...manifest, queries: declaring(manifest, owed) });
  assert.equal(errors.length, owed.length);
  assert.match(errors[0], /module-toolkit/);
  assert.match(errors[0], new RegExp(FILTER_OPS_GRANDFATHERED[0][1].replace(/\./g, '\\.')));
});

test('a module that does not even declare the query is not red for somebody else\'s excuse', () => {
  // Reusing a published id is enough to inherit its excuses: `tasks`, `invoice`, `cart_checkout`…
  // A ratchet that blocks on ABSENCE puts red every fixture built on one of those ids — and every
  // module that RETIRED the query — over a line written about another manifest, pointing at
  // screens and columns it does not have and cannot touch (module-toolkit#189). Same split the
  // sister rule `dead-filters` already makes (module-toolkit#178).
  const id = FILTER_OPS_GRANDFATHERED[0][0];
  const owed = FILTER_OPS_GRANDFATHERED.filter(([m]) => m === id);
  const { dir } = mod({ id });
  const { errors, warnings } = checkFilterOps(dir, { id, queries: {} });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, owed.length, JSON.stringify(warnings));
  assert.match(warnings[0], /FILTER_OPS_GRANDFATHERED/, 'it still says which line to delete');
  assert.match(warnings[0], /\[filter-ops\]/, 'and is tagged like every other check of this door');
  assert.ok(dir);
});

test('the module that FIXED it by dropping the filter is blocked: the query is still declared', () => {
  // The other shape of a fix — the query stays, the lying filter leaves `list.filters`. The finding
  // disappears while the query still exists, and that is exactly when the line has to go.
  const [id, query] = FILTER_OPS_GRANDFATHERED[0];
  const owed = FILTER_OPS_GRANDFATHERED.filter(([m]) => m === id).length;
  const { dir } = mod({ id });
  const { errors } = checkFilterOps(dir, { id, queries: { [query]: { list: { filters: {} } } } });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], new RegExp(query.replace(/\./g, '\\.')));
  assert.ok(owed >= 1);
});

test('a module that is not in the list is judged with no exceptions', () => {
  const { errors } = run({ id: 'brand_new', filters: { name: { op: 'eq' } } });
  assert.equal(errors.length, 1);
});

test('the grandfathered list carries no duplicate line', () => {
  const seen = new Set();
  for (const [id, query, column] of FILTER_OPS_GRANDFATHERED) {
    const key = `${id}|${query}|${column}`;
    assert.equal(seen.has(key), false, `duplicada: ${key}`);
    seen.add(key);
  }
});

test('the grandfathered list may only SHRINK', () => {
  // The ceiling is the ratchet itself, and it comes DOWN with every filter the sweep fixes — never
  // up. Lowering it is the last step of a sweep PR, right after deleting the entries; a PR that
  // adds a line has to raise it, which is what makes the addition visible in review. Without this
  // line a new lying filter could be excused by appending one entry and every test stayed green
  // (same contract as `FILL_GRANDFATHERED` and the migration guard's `GRANDFATHERED`).
  assert.ok(
    FILTER_OPS_GRANDFATHERED.length <= 24,
    `the list GREW (${FILTER_OPS_GRANDFATHERED.length}). Nothing gets added: a filter that needs a ` +
      'line here is a filter that lies, and it gets fixed, not excused (ERPlora/pm#244).',
  );
  for (const entry of FILTER_OPS_GRANDFATHERED) {
    assert.equal(entry.length, 3, `bad entry: ${JSON.stringify(entry)} — [moduleId, query, column]`);
    for (const part of entry) assert.equal(typeof part, 'string', `bad entry: ${JSON.stringify(entry)}`);
  }
});

test('a module the sweep already FIXED is out of the list, and stays out', () => {
  // `reservations` fixed its six in ERPlora/reservations#46 (merged 2026-09-05). While its lines
  // stayed, its gate on `origin/main` was RED with six «ya NO incumple» errors — the ratchet doing
  // its job. Naming it here turns «we fixed it» into something that fails if the lines come back.
  const swept = ['reservations'];
  const listed = new Set(FILTER_OPS_GRANDFATHERED.map(([id]) => id));
  for (const id of swept) {
    assert.equal(listed.has(id), false, `${id} was swept and must not return to the list`);
  }
});

// ── it must not fall over on the shapes a real catalogue has ────────────────────────────────

test('a module with no `ui/` and no filters says nothing', () => {
  const { dir } = mod({ id: 'quiet' });
  assert.deepEqual(checkFilterOps(dir, { id: 'quiet', queries: {} }), { errors: [], warnings: [] });
});

test('a manifest with no queries at all does not throw', () => {
  const { dir } = mod({ id: 'quiet' });
  assert.deepEqual(checkFilterOps(dir, { id: 'quiet' }), { errors: [], warnings: [] });
});
