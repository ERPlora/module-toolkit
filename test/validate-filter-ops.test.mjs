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
        { key: 'name', filterTypes: ['text'] },
        { key: 'status', filterTypes: ['select'] },
        { key: 'other', filterTypes: [] },
      ],
    },
  ]);
});

test('listScreens: a column that can paint TWO boxes reports BOTH, not the first', () => {
  // module-toolkit#187. `exec` returns the FIRST match, so a column written as
  // `...(x ? { filterType: 'select' } : { filterType: 'text' })` used to read as a dropdown and the
  // text branch — the one the user actually gets when the catalogue did not load — was invisible.
  const [{ columns }] = listScreens(branchingScreen('payment_method_name', ['select', 'text']));
  assert.deepEqual(columns, [{ key: 'payment_method_name', filterTypes: ['select', 'text'] }]);
});

test('listScreens: the same box painted twice is reported once', () => {
  const [{ columns }] = listScreens(branchingScreen('status', ['select', 'select']));
  assert.deepEqual(columns, [{ key: 'status', filterTypes: ['select'] }]);
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
    { key: 'name', filterTypes: ['text'] },
    { key: 'status', filterTypes: [] },
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
  assert.deepEqual(columns, [{ key: 'name', filterTypes: ['text'] }]);
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
  const id = FILTER_OPS_GRANDFATHERED[0][0];
  const owed = FILTER_OPS_GRANDFATHERED.filter(([m]) => m === id).length;
  const { dir, manifest } = mod({ id, filters: { name: { op: 'like' } } });
  const { errors } = checkFilterOps(dir, manifest);
  assert.equal(errors.length, owed);
  assert.match(errors[0], /module-toolkit/);
  assert.match(errors[0], new RegExp(FILTER_OPS_GRANDFATHERED[0][1].replace(/\./g, '\\.')));
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
    FILTER_OPS_GRANDFATHERED.length <= 34,
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
