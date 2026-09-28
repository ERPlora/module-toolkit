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

test('a file that drives TWO lists is not judged: its columns cannot be attributed to one', () => {
  // Under-cover rather than reject correct code: the column array of such a file belongs to both
  // queries, and guessing which one the user is looking at is how a gate blocks a working screen.
  const two = `${screen([['name', 'select']])}
const other = createListController(erplora(), 'demo.other.list', { columns });`;
  const { errors } = run({ filters: { name: { op: 'like' } }, files: { [UI]: two } });
  assert.deepEqual(errors, []);
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
    FILTER_OPS_GRANDFATHERED.length <= 30,
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
