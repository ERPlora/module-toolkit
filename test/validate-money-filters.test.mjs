// A «from / to» filter over an amount that the list does not declare as money — module-toolkit#375.
// `node --test`.
//
// WHY THIS EXISTS. Money is stored as an INTEGER in the minor unit (ADR-0123) and a quantity in
// fixed point 10⁶ (ADR-0147), but the person types the major unit: «12» for twelve euros. Since
// hub#2271 the SDK's list controller scales the edges of a range filter itself — only for the
// columns the screen names in `createListController(…, { moneyFilters, quantityFilters })`. A column
// that paints money, lets the person filter it by range and is NOT named there sends «12» as
// 12 cents: «from 12» lets a 0,12 € ticket through and «to 50» hides a 1 € one. Ten lists shipped
// exactly that before each grew its own local copy of the conversion (Sale de ERPlora/hub#2271), and
// nothing told the author. This door does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MONEY_FILTERS_GRANDFATHERED,
  checkMoneyFilters,
  undeclaredRangeFilters,
} from '../src/validate-money-filters.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-moneyfilters-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A list component: `columns` is the body of the columns array, `options` the controller options. */
function component({ columns, options = '', extra = '' }) {
  return [
    "import { createListController, erplora } from '@erplora/module-sdk';",
    extra,
    'class ErpDemoList {',
    '  connectedCallback() {',
    `    this.ctrl = createListController(erplora(), 'demo.list', () => this.requestUpdate(), { pageSize: 50${options} });`,
    '  }',
    '  get columns() {',
    '    return [',
    "      { key: 'name', header: 'Name', sortable: true, filterable: true, filterType: 'text' },",
    columns,
    '    ];',
    '  }',
    '}',
  ].join('\n');
}

const MONEY_COL =
  "      { key: 'total', header: 'Total', align: 'right', filterable: true, filterType: 'range', format: (r) => erplora().formatMoney(Number(r.total || 0)) },";
const QTY_COL =
  "      { key: 'stock', header: 'Stock', align: 'right', filterable: true, filterType: 'range', format: (r) => formatQuantity(Number(r.stock)) },";

const keys = (src) => undeclaredRangeFilters(src).map((c) => `${c.key}:${c.kind}`);

// ── What counts as an undeclared money / quantity range, and what does NOT ─────────

test('FAILS: a range column painted with formatMoney that is not in moneyFilters', () => {
  const src = component({ columns: MONEY_COL });
  assert.deepEqual(keys(src), ['total:money']);
  assert.equal(undeclaredRangeFilters(src)[0].line, 10, 'the line where the column opens');
});

test('FAILS: formatMinor and a rendered <ok-money> are money too', () => {
  const src = component({
    columns: [
      "      { key: 'a', filterable: true, filterType: 'range', format: (r) => erplora().formatMinor(r.a) },",
      "      { key: 'b', filterable: true, filterType: 'range', render: (r) => html`<ok-money .value=${r.b}></ok-money>` },",
    ].join('\n'),
  });
  assert.deepEqual(keys(src), ['a:money', 'b:money']);
});

test('FAILS: a column written over several lines, with double quotes', () => {
  const src = component({
    columns: [
      '      {',
      '        key: "amount",',
      "        header: t('ui.colAmount'),",
      '        filterable: true,',
      '        filterType: "range",',
      '        // The value is MINOR UNITS → `formatMoney` divides.',
      "        format: (r) => erplora().formatMoney(Number(r.amount || 0), { currency: String(r.currency || '') || undefined }),",
      '      },',
    ].join('\n'),
  });
  assert.deepEqual(keys(src), ['amount:money']);
  assert.equal(undeclaredRangeFilters(src)[0].line, 10, 'where the column OPENS, not where its filterType is');
});

test('FAILS: the money is painted through a helper of the same file (a const arrow or a method)', () => {
  // invoice paints with `money(v)` → `<ok-money>`; cash_register with `this.fmt(n)` → `formatMoney`.
  const src = component({
    extra: [
      'const money = (v, currency) => html`<ok-money',
      '  .value=${Number(v || 0)}',
      '></ok-money>`;',
      'function amount(v) {',
      '  const n = Number(v || 0);',
      '  return erplora().formatMoney(n);',
      '}',
      '// What prettier makes of a long arrow: the money is on the CLOSING line of the params.',
      'const balance = (',
      '  n,',
      ') => erplora().formatMoney(Number(n));',
    ].join('\n'),
    columns: [
      "      { key: 'total_amount', filterable: true, filterType: 'range', render: (r) => money(r.total_amount) },",
      "      { key: 'closing_balance', filterable: true, filterType: 'range', format: (r) => this.fmt(r.closing_balance) },",
      "      { key: 'paid', filterable: true, filterType: 'range', format: (r) => amount(r.paid) },",
      "      { key: 'opening_balance', filterable: true, filterType: 'range', format: (r) => balance(r.opening_balance) },",
    ].join('\n'),
  }).replace(
    '  get columns() {',
    "  private fmt(n) { return n == null ? '—' : erplora().formatMoney(Number(n)); }\n  get columns() {",
  );
  assert.deepEqual(keys(src), ['total_amount:money', 'closing_balance:money', 'paid:money', 'opening_balance:money']);
});

test('FAILS: a range column painted with formatQuantity that is not in quantityFilters', () => {
  assert.deepEqual(keys(component({ columns: QTY_COL })), ['stock:quantity']);
});

test('FAILS: declared in the WRONG list — a money column in quantityFilters is still undeclared money', () => {
  const src = component({ columns: MONEY_COL, options: ", quantityFilters: ['total']" });
  assert.deepEqual(keys(src), ['total:money']);
});

test('passes: the column is in moneyFilters (a literal list)', () => {
  assert.deepEqual(keys(component({ columns: MONEY_COL, options: ", moneyFilters: ['total']" })), []);
  assert.deepEqual(keys(component({ columns: QTY_COL, options: ', quantityFilters: ["stock"]' })), []);
});

test('passes: the list is a const of the same file, or a shorthand property', () => {
  const viaConst = component({
    extra: "const MONEY = ['total'] as const;",
    columns: MONEY_COL,
    options: ', moneyFilters: MONEY',
  });
  assert.deepEqual(keys(viaConst), []);
  const shorthand = component({
    extra: "const quantityFilters = ['stock'];",
    columns: QTY_COL,
    options: ', quantityFilters',
  });
  assert.deepEqual(keys(shorthand), []);
});

test('passes: a range over something that is not money nor quantity (party size, a count)', () => {
  const src = component({
    columns: [
      "      { key: 'party_size', filterable: true, filterType: 'range' },",
      "      { key: 'unread', filterable: true, filterType: 'range', format: (r) => String(r.unread) },",
    ].join('\n'),
  });
  assert.deepEqual(keys(src), []);
});

test('passes: money painted in a column WITHOUT a range filter', () => {
  const src = component({
    columns:
      "      { key: 'difference', filterable: true, filterType: 'text', format: (r) => erplora().formatMoney(r.difference) },",
  });
  assert.deepEqual(keys(src), []);
});

test('passes: a `filterType: \'range\'` on a comment line is prose, not a column', () => {
  const src = component({
    columns: "      // e.g. { key: 'total', filterType: 'range', format: (r) => erplora().formatMoney(r.total) }",
  });
  assert.deepEqual(keys(src), []);
});

test('a money helper is judged by its OWN body: a helper that does not paint money is not money', () => {
  const src = component({
    extra: 'const pax = (n) => `${n} pax`;',
    // A declared money column further down: a helper read past its own end would find its money.
    columns: [
      "      { key: 'capacity', filterable: true, filterType: 'range', format: (r) => pax(r.capacity) },",
      MONEY_COL,
    ].join('\n'),
    options: ", moneyFilters: ['total']",
  });
  assert.deepEqual(keys(src), []);
});

// ── The door over a module directory ───────────────────────────────────────────

test('checkMoneyFilters: FAILS with the file, the line, the column and the code to act on', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': component({ columns: MONEY_COL + '\n' + QTY_COL }) });
  try {
    const { errors, warnings } = checkMoneyFilters(m.dir, m.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.deepEqual(warnings, []);
    assert.match(errors[0], /ui\/components\/erp-demo\/erp-demo\.ts/);
    assert.match(errors[0], /L10: total — money_range_filter_undeclared/);
    assert.match(errors[0], /L11: stock — quantity_range_filter_undeclared/);
    assert.match(errors[0], /moneyFilters/, 'the option the author has to fill');
    assert.match(errors[0], /module-toolkit#375/);
  } finally {
    m.clean();
  }
});

test('checkMoneyFilters: a module that declares its money ranges says nothing', () => {
  const m = mod({
    'ui/components/erp-demo/erp-demo.ts': component({
      columns: MONEY_COL + '\n' + QTY_COL,
      options: ", moneyFilters: ['total'], quantityFilters: ['stock']",
    }),
  });
  try {
    assert.deepEqual(checkMoneyFilters(m.dir, m.manifest), { errors: [], warnings: [] });
  } finally {
    m.clean();
  }
});

test('checkMoneyFilters: tests, `dist/` and a module with no `ui/` are not judged', () => {
  const bad = component({ columns: MONEY_COL });
  const m = mod({
    'ui/components/erp-demo/erp-demo.test.ts': bad,
    'ui/dist/bundle.js': bad,
    'ui/node_modules/x/index.js': bad,
  });
  const bare = mod({ 'module.json': '{}' });
  try {
    assert.deepEqual(checkMoneyFilters(m.dir, m.manifest), { errors: [], warnings: [] });
    assert.deepEqual(checkMoneyFilters(bare.dir, bare.manifest), { errors: [], warnings: [] });
  } finally {
    m.clean();
    bare.clean();
  }
});

// ── The ratchet: what is already published is tolerated, and the list only shrinks ──

/** A made-up list, so the mechanism is proven whatever the real list holds that day. */
const SYNTHETIC = [['demo', 'ui/components/erp-demo-old/erp-demo-old.ts', 2]];
const OLD = SYNTHETIC[0][1];

test('a grandfathered file keeps passing with the columns it had — and NOT with one more', () => {
  const exact = mod({ [OLD]: component({ columns: MONEY_COL + '\n' + QTY_COL }) });
  try {
    assert.deepEqual(checkMoneyFilters(exact.dir, exact.manifest, SYNTHETIC).errors, []);
  } finally {
    exact.clean();
  }
  const extraCol =
    "      { key: 'tip', filterable: true, filterType: 'range', format: (r) => erplora().formatMoney(r.tip) },";
  const more = mod({ [OLD]: component({ columns: [MONEY_COL, QTY_COL, extraCol].join('\n') }) });
  try {
    const { errors } = checkMoneyFilters(more.dir, more.manifest, SYNTHETIC);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /L12: tip/, 'only the column past the allowance is named');
    assert.doesNotMatch(errors[0], /L1[01]: /, 'the two tolerated columns are not the author\'s to fix here');
  } finally {
    more.clean();
  }
});

test('the pass is per FILE: a new list component of a grandfathered module inherits nothing', () => {
  const m = mod({
    [OLD]: component({ columns: MONEY_COL + '\n' + QTY_COL }),
    'ui/components/erp-brand-new/erp-brand-new.ts': component({ columns: MONEY_COL }),
  });
  try {
    const { errors } = checkMoneyFilters(m.dir, m.manifest, SYNTHETIC);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /erp-brand-new/);
  } finally {
    m.clean();
  }
});

test('FAILS: the file moved its ranges to the SDK but keeps its entry — the allowance covers nothing', () => {
  const m = mod({
    [OLD]: component({ columns: MONEY_COL + '\n' + QTY_COL, options: ", moneyFilters: ['total'], quantityFilters: ['stock']" }),
  });
  try {
    const { errors } = checkMoneyFilters(m.dir, m.manifest, SYNTHETIC);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /MONEY_FILTERS_GRANDFATHERED/, 'the error names the list to edit');
  } finally {
    m.clean();
  }
});

test('the grandfathered list may only SHRINK', () => {
  // Measured on 2026-09-27 over `origin/main` of the 27 module repos: the ten lists that convert the
  // edges with a LOCAL copy of the recipe (verifactu#137) instead of the SDK. They leave with
  // ERPlora/pm#501, one file at a time; a PR that adds a line has to raise these ceilings. Each
  // module that leaves lowers them: `sales`, `payments`, `cash_register`, `customers`, `kitchen`,
  // `cart_checkout`, `inventory`, `services` and `invoice` left with pm#501 (their «Total», «Amount»,
  // «Opening / Expected / Counted», «Spent», kitchen «Total», the carts/orders «Total» + carts
  // «Items», the products «Price» + «Stock», the services «Price» and the invoices «Total» filters
  // are declared).
  const total = MONEY_FILTERS_GRANDFATHERED.reduce((n, [, , count]) => n + count, 0);
  assert.ok(
    MONEY_FILTERS_GRANDFATHERED.length <= 1 && total <= 1,
    `the list GREW (${MONEY_FILTERS_GRANDFATHERED.length} files / ${total} columns). Nothing gets added: ` +
      'each module still owing empties its own line (ERPlora/pm#501).',
  );
});

test('the grandfathered list is well-formed: [moduleId, ui/ file, count > 0], no duplicates', () => {
  const seen = new Set();
  for (const entry of MONEY_FILTERS_GRANDFATHERED) {
    assert.equal(entry.length, 3, `bad entry: ${JSON.stringify(entry)} — [moduleId, file, count]`);
    assert.ok(entry[2] > 0, `a zero allowance is a leftover: ${entry[1]}`);
    assert.match(entry[1], /^ui\/.*\.(ts|js)$/, `a path outside ui/: ${entry[1]}`);
    const key = `${entry[0]}:${entry[1]}`;
    assert.ok(!seen.has(key), `duplicated entry: ${key}`);
    seen.add(key);
  }
});

// ── Wired into `erplora validate` ──────────────────────────────────────────────

test('validate() refuses a module with an undeclared money range, and not once it is declared', async () => {
  // `demo.list` is declared: the contracts door (ADR-0127) runs before this one.
  const manifest = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    permissions: ['demo.view'],
    queries: { 'demo.list': { sql: 'queries/list.sql', permission: 'demo.view' } },
  };
  const files = (options) => ({
    'module.json': JSON.stringify(manifest),
    'queries/list.sql': 'SELECT 1 AS total',
    'ui/components/erp-demo/erp-demo.ts': component({ columns: MONEY_COL, options }),
  });
  const bad = mod(files(''));
  const good = mod(files(", moneyFilters: ['total']"));
  try {
    for (const m of [bad, good]) writeContractsFile(m.dir, manifest);
    await assert.rejects(() => validate(bad.dir), /money_range_filter_undeclared[\s\S]*erp-demo\.ts|erp-demo\.ts[\s\S]*money_range_filter_undeclared/);
    await assert.doesNotReject(() => validate(good.dir));
  } finally {
    bad.clean();
    good.clean();
  }
});

test(
  'validate() PRINTS the ratchet warnings: a manifest that only reuses a grandfathered id is told, not blocked',
  { skip: !MONEY_FILTERS_GRANDFATHERED.length && 'the list is empty: the ratchet retired with ERPlora/pm#501' },
  async () => {
    // A module with no `ui/` that reuses a published id inherits the id's lines; they point at files
    // it never had (module-toolkit#189): a WARNING, not a failure — and it only reaches the author
    // if `validate()` prints it.
    const [id, file] = MONEY_FILTERS_GRANDFATHERED[0];
    const manifest = { id, name: 'Demo', version: '1.0.0' };
    const m = mod({ 'module.json': JSON.stringify(manifest) }, id);
    const printed = [];
    const warn = console.warn;
    console.warn = (...a) => printed.push(a.join(' '));
    try {
      writeContractsFile(m.dir, manifest);
      await validate(m.dir);
    } finally {
      console.warn = warn;
      m.clean();
    }
    assert.ok(
      printed.some((l) => l.includes(file) && l.includes('MONEY_FILTERS_GRANDFATHERED')),
      `the ratchet warning was not printed:\n${printed.join('\n')}`,
    );
  },
);

test('a range column whose key is not a string literal has no column to name: not judged', () => {
  const src = component({
    extra: "const TOTAL = 'total';",
    columns:
      "      { key: TOTAL, filterable: true, filterType: 'range', format: (r) => erplora().formatMoney(r.total) },",
  });
  assert.deepEqual(undeclaredRangeFilters(src), []);
});
