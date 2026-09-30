// `erplora dev` invents rows for a list the module brings no fixture for — module-toolkit#431.
//
// The invented rows guessed each column's type from its NAME: anything matching /num/ got a number.
// In `tables` the table number is TEXT (`tables_table.number TEXT NOT NULL`) and the floor plan sorts
// it with `(label ?? '').replace(...)`, so the preview died with «(label ?? "").replace is not a
// function» on a screen that works in every real hub — a bug the developer chases and cannot find.
//
// The fix reads the type the module DECLARES (its postgres migrations) and only falls back to the
// name for columns no migration declares (aliases like `zone` or `number_sort`), where /num/ no
// longer means "number".
//
// Two layers, both real code: `listColumnKinds` over a module on disk, and the mock client slice of
// the generated harness run in a bare `vm` (same approach as dev-emit-dedup-key.test.mjs). The last
// test starts the REAL preview server and reads the bundle it serves, to prove the kinds reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { harnessEntry, listColumnKinds, startDev } from '../src/dev.mjs';

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// The shape of the `tables` module that broke (with a `;` inside a comment and a literal, which must not
// cut the CREATE TABLE in two): TEXT number, INTEGER flags (ADR-0007: flags are
// 0/1 integers, dates are ISO TEXT), a NUMERIC amount, a column added later by ALTER TABLE, and
// list columns that are query aliases no migration declares.
const MANIFEST = {
  id: 'tables',
  migrations: { postgres: ['migrations/postgres/001_init.sql', { file: 'migrations/postgres/002_more.sql' }] },
  queries: {
    'tables.tables.list': {
      sql: 'queries/tables_list.sql',
      list: {
        search: ['number', 'name'],
        sort: ['id', 'number', 'number_sort', 'capacity', 'is_active', 'paid_total', 'archived', 'opened_at', 'zone', 'zone_id', 'table_count'],
      },
    },
  },
};

const MIGRATION_1 = `-- Mesa física
CREATE TABLE IF NOT EXISTS tables_table (
    id          TEXT PRIMARY KEY,
    hub_id      TEXT NOT NULL,
    number      TEXT NOT NULL,  -- the label the host types; free text, never a number
    name        TEXT NOT NULL DEFAULT 'no; name',
    capacity    INTEGER NOT NULL DEFAULT 4,
    is_active   INTEGER NOT NULL DEFAULT 1,
    paid_total  NUMERIC(12,2) NOT NULL DEFAULT 0,
    opened_at   TEXT NOT NULL,
    FOREIGN KEY (hub_id) REFERENCES hubs (id)
);
`;
const MIGRATION_2 = 'ALTER TABLE tables_table ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;\n';

function moduleDir() {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-synth-'));
  write(join(dir, 'module.json'), JSON.stringify(MANIFEST));
  write(join(dir, 'migrations/postgres/001_init.sql'), MIGRATION_1);
  write(join(dir, 'migrations/postgres/002_more.sql'), MIGRATION_2);
  return dir;
}

/** The DOM-free "Cliente mock" slice of the generated harness, ready to `vm.runInContext`. */
function mockClientSource(source) {
  const start = source.indexOf('const MODULES = ');
  const end = source.indexOf('// ── Shell (layout');
  assert.ok(start >= 0 && end > start, 'the harness template moved — update the markers');
  return source.slice(start, end);
}

function buildErplora(columnKinds) {
  const source = harnessEntry([MANIFEST], {}, [], null, null, columnKinds);
  const sandbox = { performance };
  vm.createContext(sandbox);
  vm.runInContext(mockClientSource(source), sandbox, { filename: 'harness-mock-client.js' });
  return sandbox.erplora;
}

async function inventedRows(columnKinds) {
  const erplora = buildErplora(columnKinds);
  const page = await erplora.queryPage('tables.tables.list', {});
  assert.equal(page.rows.length, 12, 'the preview still invents a page of rows');
  return page.rows;
}

test('listColumnKinds reads each list column type from the module migrations, CREATE and ALTER alike', () => {
  const dir = moduleDir();
  try {
    assert.deepEqual(listColumnKinds(dir, MANIFEST), {
      'tables.tables.list': {
        number: 'text',
        name: 'text',
        capacity: 'integer',
        is_active: 'integer',
        paid_total: 'decimal',
        archived: 'boolean',
        opened_at: 'text',
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listColumnKinds maps the declared SQL types to the kinds the invented rows use', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-synth-'));
  const manifest = {
    id: 'kinds',
    migrations: { postgres: ['m.sql'] },
    queries: { 'kinds.list': { list: { sort: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] } } },
  };
  write(
    join(dir, 'm.sql'),
    'CREATE TABLE kinds_t (a VARCHAR(40), b BIGINT, c SMALLINT, d REAL, e DOUBLE PRECISION, ' +
      'f BOOL, g DATE, h TIMESTAMPTZ, i JSONB, j "UUID");\n',
  );
  try {
    assert.deepEqual(listColumnKinds(dir, manifest), {
      'kinds.list': { a: 'text', b: 'integer', c: 'integer', d: 'decimal', e: 'decimal', f: 'boolean', g: 'date', h: 'timestamp', j: 'text' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a column two tables declare with different kinds is left to the name, not guessed from one of them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-synth-'));
  const manifest = { id: 'x', migrations: { postgres: ['m.sql'] }, queries: { 'x.list': { list: { sort: ['code', 'label'] } } } };
  write(join(dir, 'm.sql'), 'CREATE TABLE x_a (code TEXT, label TEXT);\nCREATE TABLE x_b (code INTEGER, label TEXT);\n');
  try {
    assert.deepEqual(listColumnKinds(dir, manifest), { 'x.list': { label: 'text' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module without migrations or list queries gets no kinds (and does not throw)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-synth-'));
  try {
    assert.deepEqual(listColumnKinds(dir, { id: 'bare' }), {});
    assert.deepEqual(listColumnKinds(dir, { id: 'gone', migrations: { postgres: ['missing.sql'] }, queries: { 'gone.list': { list: { sort: ['a'] } } } }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the symptom: a TEXT column called number is invented as text, so `(label ?? "").replace` works (mt#431)', async () => {
  const dir = moduleDir();
  try {
    const rows = await inventedRows(listColumnKinds(dir, MANIFEST));
    for (const row of rows) {
      assert.equal(typeof row.number, 'string', `number is TEXT in the migration, got ${JSON.stringify(row.number)}`);
      assert.doesNotThrow(() => (row.number ?? '').replace(/[0-9]+/g, (r) => r.padStart(12, '0')));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every declared kind is invented with its own JS type', async () => {
  const dir = moduleDir();
  try {
    const rows = await inventedRows(listColumnKinds(dir, MANIFEST));
    for (const row of rows) {
      assert.equal(typeof row.name, 'string');
      assert.ok(Number.isInteger(row.capacity) && row.capacity > 0, `capacity INTEGER: ${row.capacity}`);
      assert.ok(row.is_active === 0 || row.is_active === 1, `is_active is a 0/1 INTEGER flag: ${row.is_active}`);
      assert.equal(typeof row.paid_total, 'number', `paid_total NUMERIC: ${row.paid_total}`);
      assert.equal(typeof row.archived, 'boolean', `archived BOOLEAN: ${row.archived}`);
      assert.match(row.opened_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'a TEXT *_at column keeps its ISO date');
    }
    assert.ok(rows.some((r) => r.archived) && rows.some((r) => !r.archived), 'both values of a boolean appear');
    assert.ok(new Set(rows.map((r) => r.capacity)).size > 1, 'the integers vary between rows');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a TEXT column with a number-like or flag-like name stays text: the declared kind beats the name', async () => {
  // cash_register's `count_type` and services' `discount_type` are TEXT whose names match /count/.
  const rows = await inventedRows({ 'tables.tables.list': { table_count: 'text', is_active: 'text' } });
  for (const row of rows) {
    assert.equal(typeof row.table_count, 'string', `table_count is TEXT: ${JSON.stringify(row.table_count)}`);
    assert.equal(typeof row.is_active, 'string', `is_active is TEXT: ${JSON.stringify(row.is_active)}`);
  }
});

test('an INTEGER amount with a flag-like name (paid_total in cents) is a number, not a 0/1 flag', async () => {
  const rows = await inventedRows({ 'tables.tables.list': { paid_total: 'integer' } });
  assert.ok(rows.some((r) => r.paid_total > 1), JSON.stringify(rows.map((r) => r.paid_total)));
});

test('a decimal column carries a fraction, so a screen that rounds is exercised', async () => {
  const rows = await inventedRows({ 'tables.tables.list': { capacity: 'decimal' } });
  assert.ok(rows.some((r) => !Number.isInteger(r.capacity)), JSON.stringify(rows.map((r) => r.capacity)));
});

test('date and timestamp kinds are invented as ISO strings of their own shape', async () => {
  const rows = await inventedRows({ 'tables.tables.list': { number: 'date', name: 'timestamp' } });
  for (const row of rows) {
    assert.match(row.number, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(row.name, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
});

test('a column no migration declares falls back to its name, and /num/ no longer means number', async () => {
  const rows = await inventedRows({});
  for (const row of rows) {
    assert.equal(typeof row.number, 'string', `undeclared number: ${JSON.stringify(row.number)}`);
    assert.equal(typeof row.number_sort, 'string', `undeclared number_sort: ${JSON.stringify(row.number_sort)}`);
    assert.equal(typeof row.zone, 'string');
    assert.equal(typeof row.table_count, 'number', 'count still reads as a number');
    assert.equal(typeof row.paid_total, 'number', 'total still reads as a number');
    assert.ok(row.is_active === 0 || row.is_active === 1, 'an is_* name is still a 0/1 flag');
    assert.match(row.opened_at, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('a text *_id column points at rows the preview invents, so a plan filtered by zone is not empty', async () => {
  const erplora = buildErplora({ 'tables.tables.list': { zone_id: 'text' } });
  const tables = (await erplora.queryPage('tables.tables.list', { sort: 'zone_id' })).rows;
  // Every invented list names its rows row-1 … row-12: the zones list is one of them.
  const inventedIds = new Set(Array.from({ length: 12 }, (_, i) => 'row-' + (i + 1)));
  for (const t of tables) assert.ok(inventedIds.has(t.zone_id), `zone_id ${JSON.stringify(t.zone_id)} points at no invented row`);
  assert.ok(tables.filter((t) => t.zone_id === 'row-1').length > 1, 'the first zone holds several tables, as a real room does');

  // An undeclared *_id (a query alias) gets the same, and an INTEGER one stays a number.
  const undeclared = (await buildErplora({}).queryPage('tables.tables.list', {})).rows;
  assert.ok(undeclared.every((r) => inventedIds.has(r.zone_id)), JSON.stringify(undeclared.map((r) => r.zone_id)));
  const integer = (await buildErplora({ 'tables.tables.list': { zone_id: 'integer' } }).queryPage('tables.tables.list', {})).rows;
  assert.ok(integer.every((r) => Number.isInteger(r.zone_id)), JSON.stringify(integer.map((r) => r.zone_id)));
});

test('the preview server bundles the kinds of the module it serves (real startDev)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-dev-synth-'));
  const ws = join(root, 'ws');
  const dir = join(ws, 'tables');
  write(join(dir, 'module.json'), JSON.stringify(MANIFEST));
  write(join(dir, 'migrations/postgres/001_init.sql'), MIGRATION_1);
  write(join(dir, 'migrations/postgres/002_more.sql'), MIGRATION_2);
  write(join(dir, 'ui/components/erp-tables/erp-tables.ts'), 'export const x = 1;\n');
  // An offline npm: the preview falls back to the toolkit's own OutfitKit and never hits the network.
  write(join(root, 'bin/npm'), '#!/usr/bin/env bash\necho "npm error network ENOTFOUND" >&2; exit 1\n');
  chmodSync(join(root, 'bin/npm'), 0o755);
  const env = { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(root, 'cache') };

  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  let handle;
  try {
    handle = await startDev(dir, { port: 0, outfitkit: { env } });
  } finally {
    console.log = log;
    console.warn = warn;
  }
  try {
    const res = await fetch(`http://localhost:${handle.port}/harness.js`);
    assert.equal(res.status, 200);
    const harness = await res.text();
    const at = harness.indexOf('COLUMN_KINDS =');
    assert.ok(at >= 0, 'the served bundle declares COLUMN_KINDS');
    const literal = harness.slice(at, harness.indexOf(';', at));
    assert.match(literal, /"tables\.tables\.list":\s*\{/, literal);
    // esbuild may or may not quote the keys of an object literal.
    assert.match(literal, /"?number"?:\s*"text"/, literal);
    assert.match(literal, /"?archived"?:\s*"boolean"/, literal);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
