// The runtime's migration guard, run at the author's door (module-toolkit#51). `node --test`.
//
// WHY THIS EXISTS. On 2026-08-19 a sweep of the 117 published migrations of the 25 modules with the
// guard of tag v1.1.7 — the one the fleet runs — rejected FOUR, all published on 18-19/08, all
// green on their gate. Each one left its module uninstalled on new hubs and rolled back on the ones
// that already had it, and `customers` dragged `appointments`, `online_booking`, `reservations` and
// `whatsapp_inbox` down with it.
//
// `erplora validate` looked at NONE of what the runtime is about to demand: `validate-migrations`
// only checks manifest↔disk parity. So the gate could not catch the one thing that actually stops a
// module from installing. The four real files of that day are the fixtures below.
//
// The port follows `hub/crates/runtime/src/migration_guard.rs` on `origin/develop` — the version
// FIXED by hub#1027, not the one in v1.1.7 — because three of the four rejections were the hub's
// bug: a `;` inside a `--` comment split the statement mid-prose and the next word was read as
// another module's table. Validating before publishing is the only defence that does not depend on
// which image each hub happens to run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GRANDFATHERED,
  checkMigrationSql,
  checkMigrationGuard,
  splitStatements,
  stripComments,
  tablesTouched,
} from '../src/validate-migration-guard.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'migration-guard');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** The errors of one migration, with the default `expand` unless another kind is given. */
function guard(moduleId, filename, sql, kind = 'expand') {
  return checkMigrationSql(moduleId, filename, sql, kind);
}

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, manifestExtra) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-migguard-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', ...(manifestExtra ?? {}) };
  return { dir, manifest, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── The four real rejections of 2026-08-19 ───────────────────────────────────────────
//
// Three of them are CORRECT migrations that the fleet refused. They are the positive control that
// matters most: a false positive here does not annoy anyone, it leaves a published module
// uninstalled — which is worse than the problem this check comes to solve.

test('customers/003: a `;` inside a `--` comment is prose, not the end of a statement', () => {
  const errors = guard(
    'customers',
    'migrations/postgres/003_purchase_ledger.sql',
    fixture('customers_003_purchase_ledger.sql'),
  );
  assert.deepEqual(errors, [], 'la migración publicada es correcta: el `;` está dentro de un `--`');
});

test('printing/002: neither a `;` nor an apostrophe inside a comment opens anything', () => {
  const errors = guard(
    'printing',
    'migrations/postgres/002_jobs.sql',
    fixture('printing_002_jobs.sql'),
  );
  assert.deepEqual(errors, [], 'el hub la rechazó por «toca `is`» y era prosa de un comentario');
});

test('tables/010: two `;` inside one `--` comment do not split anything either', () => {
  const errors = guard(
    'tables',
    'migrations/postgres/010_settings.sql',
    fixture('tables_010_settings.sql'),
  );
  assert.deepEqual(errors, [], 'el hub la rechazó por «toca `create`» y era prosa');
});

test('cash_register/006 (versión previa): un `expand` con DROP COLUMN se RECHAZA', () => {
  const errors = guard(
    'cash_register',
    'migrations/postgres/006_auto_close.sql',
    fixture('cash_register_006_auto_close.sql'),
  );
  assert.equal(errors.length, 1, `debería rechazarla: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /DROP COLUMN/);
  assert.match(errors[0], /contract/, 'el error tiene que decir cómo declararla bien');
});

// ── Regla 1: la tabla pertenece al módulo ────────────────────────────────────────────

test('PASA: un módulo toca sus propias tablas', () => {
  assert.deepEqual(guard('sales', 'm.sql', 'CREATE TABLE sales_sale (id BIGINT)'), []);
});

test('FALLA: un módulo NO toca las tablas de otro', () => {
  const errors = guard('sales', 'm.sql', 'ALTER TABLE inventory_item ADD COLUMN x TEXT');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inventory_item/);
});

test('FALLA: los namespaces del sistema (`hub_*`, `_*`) están fuera de límites', () => {
  for (const sql of [
    'ALTER TABLE hub_module ADD COLUMN x TEXT',
    'DROP TABLE _hub_migrations',
    'CREATE TABLE _sales_scratch (id BIGINT)',
  ]) {
    const errors = guard('sales', 'm.sql', sql, 'contract');
    assert.equal(errors.length, 1, `debería rechazar \`${sql}\``);
    assert.match(errors[0], /sistema|system/i);
  }
});

test('FALLA: un índice sobre la tabla de OTRO módulo también la toca', () => {
  const errors = guard('sales', 'm.sql', 'CREATE INDEX idx_x ON inventory_item (hub_id)');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inventory_item/);
});

test('PASA: un índice sobre su propia tabla', () => {
  assert.deepEqual(guard('sales', 'm.sql', 'CREATE INDEX idx_x ON sales_sale (hub_id)'), []);
});

test('PASA: el `ON` de un JOIN no es un nombre de tabla (falso positivo = módulo sin instalar)', () => {
  assert.deepEqual(
    guard(
      'sales',
      'm.sql',
      'UPDATE sales_sale SET total = 0 FROM sales_line l ON l.sale_id = sales_sale.id',
      'backfill',
    ),
    [],
  );
});

test('el `FROM` ancla salvo en una sentencia que EMPIEZA por SELECT', () => {
  // Una lectura pura no toca nada: el `FROM` de un `SELECT` no se ancla (el mismo criterio que el
  // runtime — anclarlo dejaba módulos correctos sin instalar).
  assert.deepEqual(guard('sales', 'm.sql', 'SELECT 1 FROM inventory_item', 'backfill'), []);
  // Un `DELETE FROM`/`UPDATE … FROM` sí escribe, y ahí el `FROM` sí es un ancla.
  const errors = guard('sales', 'm.sql', 'DELETE FROM inventory_item', 'contract');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /inventory_item/);
});

// ── Regla 2: el SQL coincide con el `kind` declarado ─────────────────────────────────

test('FALLA: un `expand` no puede destruir', () => {
  for (const sql of [
    'ALTER TABLE sales_sale DROP COLUMN total',
    'DROP TABLE sales_old',
    'ALTER TABLE sales_sale DROP CONSTRAINT fk_x',
    'TRUNCATE sales_sale',
    'DELETE FROM sales_sale',
    'ALTER TABLE sales_sale ALTER COLUMN total SET NOT NULL',
  ]) {
    const errors = guard('sales', 'm.sql', sql);
    assert.equal(errors.length, 1, `debería rechazar \`${sql}\``);
  }
});

test('PASA: `NOT NULL` dentro de un CREATE TABLE es aditivo (la tabla es nueva)', () => {
  assert.deepEqual(guard('sales', 'm.sql', 'CREATE TABLE sales_sale (total BIGINT NOT NULL)'), []);
});

test('FALLA: un `backfill` no puede cambiar el esquema', () => {
  const errors = guard('sales', 'm.sql', 'ALTER TABLE sales_sale ADD COLUMN total BIGINT', 'backfill');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ALTER/);
});

test('PASA: un `backfill` actualiza sus propias filas', () => {
  assert.deepEqual(
    guard('sales', 'm.sql', 'UPDATE sales_sale SET total = 0 WHERE total IS NULL', 'backfill'),
    [],
  );
});

test('PASA: un `contract` es el único sitio donde se admite `DROP`', () => {
  assert.deepEqual(guard('sales', 'm.sql', 'ALTER TABLE sales_sale DROP COLUMN total', 'contract'), []);
});

test('FALLA: un `kind` que el runtime no sabe deserializar', () => {
  const errors = guard('sales', 'm.sql', 'CREATE TABLE sales_sale (id BIGINT)', 'destroy');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /destroy/);
});

// ── Lo ya publicado: la lista de abuelados ───────────────────────────────────────────

test('PASA: un fichero abuelado se aplica tal cual aunque su SQL ya no sea legal', () => {
  assert.deepEqual(
    guard('sales', 'migrations/postgres/013_drop_legacy_cart.sql', 'DROP TABLE sales_legacy_cart'),
    [],
  );
});

test('FALLA: el pase es por FICHERO, no por módulo', () => {
  const errors = guard('sales', 'migrations/postgres/099_nuevo.sql', 'DROP TABLE sales_x');
  assert.equal(errors.length, 1);
});

test('la lista de abuelados solo puede ENCOGER', () => {
  assert.ok(
    GRANDFATHERED.length <= 9,
    `la lista de abuelados ha CRECIDO (${GRANDFATHERED.length}). No se añade nada: si una migración ` +
      'nueva necesita estar aquí, es que no cumple el contrato.',
  );
});

// ── Las piezas, por separado ─────────────────────────────────────────────────────────

test('stripComments: `--` y `/* */` desaparecen; un literal se conserva', () => {
  assert.equal(stripComments("SELECT 'a--b' -- nota\n, 1").trim(), "SELECT 'a--b' \n, 1".trim());
  assert.match(stripComments('SELECT /* DROP TABLE x */ 1'), /SELECT\s+1/);
});

test('splitStatements: un `;` dentro de un comentario o de un literal no parte nada', () => {
  assert.equal(splitStatements('-- a; b\nCREATE TABLE t (x INT);').length, 1);
  assert.equal(splitStatements("INSERT INTO t VALUES ('a;b');").length, 1);
  assert.equal(splitStatements('CREATE TABLE a (x INT); CREATE TABLE b (y INT);').length, 2);
});

test('tablesTouched: las anclas reales, y nada más', () => {
  assert.deepEqual(tablesTouched('CREATE TABLE IF NOT EXISTS sales_sale (id BIGINT)'), ['sales_sale']);
  assert.deepEqual(tablesTouched('CREATE INDEX i ON sales_sale (hub_id)'), ['sales_sale']);
  assert.deepEqual(tablesTouched('-- DROP TABLE inventory_item\nSELECT 1'), []);
});

// ── La puerta completa: directorio + manifest ────────────────────────────────────────

test('checkMigrationGuard: caza el `expand` destructivo declarado en el manifest', () => {
  const m = mod(
    {
      'migrations/postgres/001_init.sql': 'CREATE TABLE demo_thing (id TEXT PRIMARY KEY);\n',
      'migrations/postgres/002_drop.sql': 'ALTER TABLE demo_thing DROP COLUMN old;\n',
    },
    {
      migrations: {
        postgres: ['migrations/postgres/001_init.sql', 'migrations/postgres/002_drop.sql'],
      },
    },
  );
  const { errors } = checkMigrationGuard(m.dir, m.manifest);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /002_drop\.sql/);
  m.clean();
});

test('checkMigrationGuard: la forma objeto `{file, kind}` deja declarar un `contract` legítimo', () => {
  const m = mod(
    { 'migrations/postgres/002_drop.sql': 'ALTER TABLE demo_thing DROP COLUMN old;\n' },
    {
      migrations: {
        postgres: [{ file: 'migrations/postgres/002_drop.sql', kind: 'contract', since: '1.2.0' }],
      },
    },
  );
  const { errors } = checkMigrationGuard(m.dir, m.manifest);
  assert.deepEqual(errors, [], 'declarado `contract`, el DROP es legal — es para lo que existe el kind');
  m.clean();
});

test('checkMigrationGuard: sin migraciones no dice nada', () => {
  const m = mod({}, {});
  assert.deepEqual(checkMigrationGuard(m.dir, m.manifest), { errors: [], warnings: [] });
  m.clean();
});
