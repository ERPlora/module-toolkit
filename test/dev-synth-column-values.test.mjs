// `erplora dev` invents rows for a list the module brings no fixture for — module-toolkit#440.
//
// After #431 the invented rows carry the TYPE each column declares, but a status column still got
// "<Word> status": in `tables` every card read «Alfa status», the screen fell into its «unknown
// status» branch (question-mark icon, no colour) and the preview never showed a free, occupied or
// reserved table — the very thing the developer opened it to look at.
//
// The fix reads the values the module itself declares for a TEXT column — its `CHECK (col IN (...))`
// and its `DEFAULT '<literal>'` — on the table the list query reads the column from, and the invented
// rows deal them out: the default first, then the rest of the CHECK list in order.
//
// Two layers, both real code: `listColumnValues` over a module on disk, and the mock client slice of
// the generated harness run in a bare `vm` (as dev-synth-column-types.test.mjs does). The last test
// starts the REAL preview server and reads the bundle it serves, to prove the values reach it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { harnessEntry, listColumnKinds, listColumnValues, startDev } from '../src/dev.mjs';

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// The shape of `tables`: THREE tables declare a `status` column, each with its own values, so a
// value can only be read on the table the query takes the column from — never by the column name.
const MIGRATION_1 = `-- Mesa física
CREATE TABLE IF NOT EXISTS tables_zone (
    id     TEXT PRIMARY KEY,
    name   TEXT NOT NULL DEFAULT 'Main room'
);
CREATE TABLE IF NOT EXISTS tables_table (
    id        TEXT PRIMARY KEY,
    hub_id    TEXT NOT NULL,
    zone_id   TEXT,
    number    TEXT NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    capacity  INTEGER NOT NULL DEFAULT 4 CHECK (capacity IN (2, 4, 6)),
    shape     TEXT NOT NULL DEFAULT 'square' CHECK (shape IN ('round', 'square', 'rectangle')),
    status    TEXT NOT NULL DEFAULT 'available',  -- available|occupied|reserved|blocked; a comment is no CHECK
    note      TEXT NOT NULL DEFAULT 'it''s; free'
);
CREATE TABLE IF NOT EXISTS tables_session (
    id        TEXT PRIMARY KEY,
    table_id  TEXT NOT NULL,
    status    TEXT NOT NULL DEFAULT 'active'  -- active|closed|transferred
);
`;
const MIGRATION_2 = `CREATE TABLE IF NOT EXISTS tables_table_hold (
    id       TEXT PRIMARY KEY,
    status   TEXT NOT NULL DEFAULT 'held',
    gate     TEXT NOT NULL,
    ok       INTEGER NOT NULL,
    CHECK (status IN ('held', 'consumed', 'released', 'expired')),
    CONSTRAINT tables_hold_gate CHECK (gate <> 'held' OR ok = 1)
);
ALTER TABLE tables_table ADD COLUMN IF NOT EXISTS service TEXT NOT NULL DEFAULT 'dine_in';
ALTER TABLE tables_table ADD CONSTRAINT tables_service_check CHECK (service IN ('bar', 'dine_in', 'terrace'));
ALTER TABLE tables_session ALTER COLUMN status SET DEFAULT 'open';
`;

const MANIFEST = {
  id: 'tables',
  migrations: { postgres: ['migrations/postgres/001_init.sql', { file: 'migrations/postgres/002_more.sql' }] },
  queries: {
    'tables.tables.list': {
      sql: 'queries/tables_list.sql',
      list: {
        search: ['number', 'name'],
        sort: ['id', 'number', 'name', 'capacity', 'shape', 'status', 'service', 'note', 'zone', 'zone_id'],
      },
    },
    'tables.sessions.list': { sql: 'queries/sessions_list.sql', list: { sort: ['id', 'status', 'table_id'] } },
    'tables.holds.list': { sql: 'queries/holds_list.sql', list: { sort: ['id', 'status', 'gate'] } },
  },
};

const TABLES_LIST = `-- status here is tables_table.status: the session's is only read inside the LATERAL
SELECT t.id, t.number, t.name, t.capacity, t.shape, t.status, t.service, t.note,
       t.zone_id, z.name AS zone
FROM tables_table t
LEFT JOIN tables_zone z ON z.id = t.zone_id AND z.hub_id = :hub_id
LEFT JOIN LATERAL (
    SELECT s.status FROM tables_session s WHERE s.table_id = t.id AND s.status = 'active' LIMIT 1
) g ON TRUE
WHERE t.hub_id = :hub_id
`;

function moduleDir() {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  write(join(dir, 'module.json'), JSON.stringify(MANIFEST));
  write(join(dir, 'migrations/postgres/001_init.sql'), MIGRATION_1);
  write(join(dir, 'migrations/postgres/002_more.sql'), MIGRATION_2);
  write(join(dir, 'queries/tables_list.sql'), TABLES_LIST);
  write(join(dir, 'queries/sessions_list.sql'), 'SELECT s.* FROM tables_session AS s WHERE s.hub_id = :hub_id\n');
    // The session's `status` is only read in the NOT EXISTS: `status` still comes from the hold alone.
  write(
    join(dir, 'queries/holds_list.sql'),
    'SELECT id, status, gate FROM tables_table_hold WHERE hub_id = :hub_id\n' +
      "  AND NOT EXISTS (SELECT 1 FROM tables_session s WHERE s.status = 'closed')\n",
  );
  return dir;
}

function withModule(fn) {
  const dir = moduleDir();
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The DOM-free "Cliente mock" slice of the generated harness, ready to `vm.runInContext`. */
function mockClientSource(source) {
  const start = source.indexOf('const MODULES = ');
  const end = source.indexOf('// ── Shell (layout');
  assert.ok(start >= 0 && end > start, 'the harness template moved — update the markers');
  return source.slice(start, end);
}

async function inventedRows(query, columnKinds, columnValues) {
  const source = harnessEntry([MANIFEST], {}, [], null, null, columnKinds, columnValues);
  const sandbox = { performance };
  vm.createContext(sandbox);
  vm.runInContext(mockClientSource(source), sandbox, { filename: 'harness-mock-client.js' });
  const page = await sandbox.erplora.queryPage(query, {});
  assert.equal(page.rows.length, 12, 'the preview still invents a page of rows');
  // Out of the vm's realm, so deepEqual compares values and not the other realm's Array prototype.
  return JSON.parse(JSON.stringify(page.rows));
}

test('listColumnValues reads each TEXT column values on the table the list query reads it from', () => {
  withModule((dir) => {
    assert.deepEqual(listColumnValues(dir, MANIFEST), {
      'tables.tables.list': {
        // Only a DEFAULT: the comment listing the others is not a CHECK.
        status: ['available'],
        // The DEFAULT goes first, then the rest of the CHECK in its order.
        shape: ['square', 'round', 'rectangle'],
        // Added and constrained by ALTER TABLE in a later migration.
        service: ['dine_in', 'bar', 'terrace'],
        // A `;` and an escaped quote inside the literal are part of the value.
        note: ["it's; free"],
        // Through the JOIN alias `z`, from another table.
        zone: ['Main room'],
      },
      // `s.*` over tables_session, whose DEFAULT a later ALTER COLUMN replaced.
      'tables.sessions.list': { status: ['open'] },
      // Unqualified columns of a single-table query; a table-level CHECK counts, `gate <> … OR …` is no list.
      'tables.holds.list': { status: ['held', 'consumed', 'released', 'expired'] },
    });
  });
});

test('an empty DEFAULT, a non-text CHECK and a non-literal DEFAULT give no values (the name decides)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const manifest = {
    id: 'x',
    migrations: { postgres: ['m.sql'] },
    queries: { 'x.list': { sql: 'q.sql', list: { sort: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] } } },
  };
  write(
    join(dir, 'm.sql'),
    "CREATE TABLE x_t (a TEXT NOT NULL DEFAULT '', b INTEGER DEFAULT 1 CHECK (b IN (1, 2)), " +
      "c TEXT DEFAULT to_char(now(), 'YYYY'), d TEXT CHECK (d IN ('x', upper('y'))), e TEXT, " +
      // A JSONB default is an object in a real hub, not the string '{}'; `'a' || 'b'` is no literal.
      "f JSONB NOT NULL DEFAULT '{}', g TEXT DEFAULT 'a' || 'b');\n",
  );
  write(join(dir, 'q.sql'), 'SELECT a, b, c, d, e, f, g FROM x_t\n');
  try {
    assert.deepEqual(listColumnValues(dir, manifest), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a CHECK that ANDs the list with other conditions declares it; one under a top-level OR does not', () => {
  // services' package: `CHECK (discount_type IN ('percentage', 'fixed') AND discount_percent >= 0 …) NOT VALID`.
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const manifest = {
    id: 'x',
    migrations: { postgres: ['m.sql'] },
    queries: { 'x.list': { sql: 'SELECT * FROM x_p', list: { sort: ['discount_type', 'mode', 'kind', 'level', 'tone'] } } },
  };
  write(
    join(dir, 'm.sql'),
    'CREATE TABLE x_p (discount_type TEXT NOT NULL DEFAULT \'percentage\', discount_percent INTEGER, mode TEXT, kind TEXT, level TEXT, tone TEXT,\n' +
      "  CHECK (level IN ('a', 'b') AND tone <> '' OR kind IS NULL));\n" +
      'ALTER TABLE x_p ADD CONSTRAINT x_p_discount\n' +
      "  CHECK (discount_type IN ('fixed', 'percentage')\n         AND (discount_percent >= 0 AND discount_percent <= 100)) NOT VALID;\n" +
      "ALTER TABLE x_p ADD CONSTRAINT x_p_flags CHECK (discount_percent IN (0, 1) AND mode IN ('on', 'off') AND kind IN ('x', 'y'));\n" +
      "ALTER TABLE x_p ADD CHECK (tone IN ('warm', 'cold'));\n",
  );
  try {
    assert.deepEqual(listColumnValues(dir, manifest), {
      'x.list': { discount_type: ['percentage', 'fixed'], mode: ['on', 'off'], kind: ['x', 'y'], tone: ['warm', 'cold'] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every CHECK on a column applies, inline ones included, and DROP CONSTRAINT removes only the one it names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const manifest = {
    id: 'x',
    migrations: { postgres: ['1.sql', '2.sql'] },
    queries: { 'x.list': { sql: 'SELECT * FROM x_t', list: { sort: ['size', 'fit', 'cut', 'hem'] } } },
  };
  // Postgres accepts an inline CHECK on one column that constrains another, and names it after the
  // column it references (x_t_fit_check); an unnamed CHECK whose name is taken gets a number (…_check1).
  write(
    join(dir, '1.sql'),
    "CREATE TABLE x_t (size TEXT CHECK (size IN ('s', 'm', 'l')), fit TEXT, cut TEXT CHECK (fit IN ('slim', 'loose')), hem TEXT);\n" +
      "ALTER TABLE x_t ADD CHECK (size IN ('m', 'l', 'xl'));\n" +
      "ALTER TABLE x_t ADD CONSTRAINT x_cut CHECK (cut IN ('a', 'b'));\nALTER TABLE x_t ADD CONSTRAINT x_cut_too CHECK (cut IN ('b', 'c'));\n" +
      // Two columns in one unnamed CHECK: Postgres calls it x_t_check, so dropping x_t_hem_check leaves it.
      "ALTER TABLE x_t ADD CHECK (hem IN ('raw', 'sewn') AND size <> 'xs');\n",
  );
  write(join(dir, '2.sql'), 'ALTER TABLE x_t DROP CONSTRAINT x_t_size_check;\nALTER TABLE x_t DROP CONSTRAINT IF EXISTS x_t_hem_check;\n');
  try {
    assert.deepEqual(listColumnValues(dir, manifest), {
      // Only x_t_size_check1 is left.
      'x.list': { size: ['m', 'l', 'xl'], fit: ['slim', 'loose'], cut: ['b'], hem: ['raw', 'sewn'] },
    });
    write(join(dir, '2.sql'), 'SELECT 1;\n');
    assert.deepEqual(listColumnValues(dir, manifest)['x.list'].size, ['m', 'l'], 'both CHECKs hold: their intersection');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ALTER COLUMN DROP DEFAULT and DROP CONSTRAINT forget what an earlier migration declared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const manifest = {
    id: 'x',
    migrations: { postgres: ['1.sql', '2.sql'] },
    queries: { 'x.list': { sql: 'SELECT * FROM x_t', list: { sort: ['kind', 'level', 'grade', 'gone'] } } },
  };
  write(
    join(dir, '1.sql'),
    "CREATE TABLE x_t (kind TEXT DEFAULT 'a', level TEXT, grade TEXT CHECK (grade IN ('p', 'q')), gone TEXT DEFAULT 'z', " +
      "CONSTRAINT x_level_check CHECK (level IN ('low', 'high')));\n",
  );
  write(
    join(dir, '2.sql'),
    'ALTER TABLE x_t ALTER COLUMN kind DROP DEFAULT;\nALTER TABLE x_t DROP CONSTRAINT IF EXISTS x_level_check;\n' +
      // Postgres names an inline column CHECK <table>_<column>_check.
      'ALTER TABLE x_t DROP CONSTRAINT x_t_grade_check;\nALTER TABLE x_t DROP COLUMN IF EXISTS gone;\n',
  );
  try {
    assert.deepEqual(listColumnValues(dir, manifest), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an ambiguous column (two joined tables declare it, no qualifier) or an unknown source gets no values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const manifest = {
    id: 'x',
    migrations: { postgres: ['m.sql'] },
    queries: {
      'x.joined.list': { sql: 'SELECT status FROM x_a JOIN x_b ON x_b.id = x_a.id', list: { sort: ['status'] } },
      'x.expr.list': { sql: "SELECT coalesce(a.status, 'x') AS status FROM x_a a", list: { sort: ['status'] } },
      'x.missing.list': { sql: 'missing.sql', list: { sort: ['status'] } },
      'x.nolist': { sql: 'SELECT status FROM x_a' },
      // Sorted by a column the SELECT does not expose: nothing to read it from.
      'x.hidden.list': { sql: 'SELECT id FROM x_a', list: { sort: ['status'] } },
    },
  };
  write(join(dir, 'm.sql'), "CREATE TABLE x_a (id TEXT, status TEXT DEFAULT 'on');\nCREATE TABLE x_b (id TEXT, status TEXT DEFAULT 'off');\n");
  try {
    assert.deepEqual(listColumnValues(dir, manifest), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the symptom: invented tables carry a status the module knows, not «Alfa status» (mt#440)', async () => {
  const rows = await withModule(async (dir) =>
    inventedRows('tables.tables.list', listColumnKinds(dir, MANIFEST), listColumnValues(dir, MANIFEST)),
  );
  for (const row of rows) assert.equal(row.status, 'available', JSON.stringify(row));
});

test('the invented rows deal the values out: row 1 the first, row 2 the second, and round again', async () => {
  const rows = await withModule(async (dir) =>
    inventedRows('tables.tables.list', listColumnKinds(dir, MANIFEST), listColumnValues(dir, MANIFEST)),
  );
  assert.deepEqual(
    rows.slice(0, 4).map((r) => r.shape),
    ['square', 'round', 'rectangle', 'square'],
  );
  assert.deepEqual(new Set(rows.map((r) => r.service)), new Set(['dine_in', 'bar', 'terrace']));
  // What has no values keeps what #431 gave it.
  assert.equal(typeof rows[0].number, 'string');
  assert.ok(Number.isInteger(rows[0].capacity));
  assert.ok(rows.every((r) => /^row-\d+$/.test(r.zone_id)), 'a *_id still points at invented rows');
});

test('a list without declared values is invented as before', async () => {
  const rows = await inventedRows('tables.tables.list', {}, {});
  assert.equal(rows[0].status, 'Alfa status');
  // And the argument is optional: a caller of the old signature still gets a harness.
  const source = harnessEntry([MANIFEST], {}, [], null, null, {});
  assert.match(source, /const COLUMN_VALUES = \{\};/);
});

test('a filter on the invented status finds the rows that carry it', async () => {
  const withValues = await withModule(async (dir) => {
    const source = harnessEntry([MANIFEST], {}, [], null, null, listColumnKinds(dir, MANIFEST), listColumnValues(dir, MANIFEST));
    const sandbox = { performance };
    vm.createContext(sandbox);
    vm.runInContext(mockClientSource(source), sandbox, { filename: 'harness-mock-client.js' });
    return sandbox.erplora.queryPage('tables.holds.list', { filters: { status: 'released' } });
  });
  assert.equal(withValues.total, 3, 'held, consumed, released, expired over 12 rows: three of each');
});

test('the preview server bundles the values of the module it serves (real startDev)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-dev-values-'));
  const ws = join(root, 'ws');
  const dir = join(ws, 'tables');
  // An id of its own: until module-toolkit#441 the preview compiles into $TMPDIR/erplora-dev-<id>, and
  // dev-synth-column-types.test.mjs serves a `tables` from another process at the same time.
  write(join(dir, 'module.json'), JSON.stringify({ ...MANIFEST, id: 'mt440_values' }));
  write(join(dir, 'migrations/postgres/001_init.sql'), MIGRATION_1);
  write(join(dir, 'migrations/postgres/002_more.sql'), MIGRATION_2);
  write(join(dir, 'queries/tables_list.sql'), TABLES_LIST);
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
    const at = harness.indexOf('COLUMN_VALUES =');
    assert.ok(at >= 0, 'the served bundle declares COLUMN_VALUES');
    const literal = harness.slice(at, harness.indexOf(';', at));
    assert.match(literal, /"tables\.tables\.list":\s*\{/, literal);
    // esbuild may or may not quote the keys of an object literal.
    assert.match(literal, /"?status"?:\s*\[\s*"available"\s*\]/, literal);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
