// Tests del validador de ERPlora SQL portable (ADR-0007). `node --test`.
// Un caso que PASA y un caso que FALLA por cada regla, + casos de falsos positivos
// (literales y comentarios) y el barrido inline/migraciones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSql, validateSql, collectModuleSql, BRIDGE_FUNCTIONS, PORTABLE_TYPES } from '../src/validate-sql.mjs';

const errors = (sql) => lintSql(sql).filter((f) => f.level === 'error');
const warnings = (sql) => lintSql(sql).filter((f) => f.level === 'warning');
const kinds = (sql) => lintSql(sql).map((f) => f.kind);

// ── el set portable está sincronizado con lo que documentamos del shim ───────────────────
// REGLA VINCULANTE: este array DEBE ser idéntico a `BRIDGE_FUNCTIONS` del shim del runtime
// (hub/crates/db/src/lib.rs). Si este test falla tras tocar uno de los dos, re-sincroniza ambos.
test('set portable expone las constantes del shim (espejo de BRIDGE_FUNCTIONS del runtime)', () => {
  assert.deepEqual(BRIDGE_FUNCTIONS, [
    'erp_now',
    'erp_lpad',
    'erp_pad',
    'erp_dt',
    'erp_date',
    'erp_dateadd',
    'erp_month_start',
    'erp_dow_mon0',
    'erp_extract',
    'erp_datediff_days',
    'erp_timefmt',
  ]);
  assert.deepEqual(PORTABLE_TYPES, ['TEXT', 'INTEGER', 'REAL', 'BLOB']);
});

// Sync REAL cross-lenguaje: lee el `BRIDGE_FUNCTIONS` del shim Rust (hub/crates/db/src/lib.rs) y
// exige que sea idéntico al del validador. El mirror de arriba compara contra un literal; este
// test compara contra el FICHERO Rust, así que atrapa el desync que el mirror no ve (p.ej. el
// validador declara una erp_* que el shim no sabe traducir → rompería en runtime, ADR-0007).
test('BRIDGE_FUNCTIONS del validador == las del shim Rust (lee crates/db/src/lib.rs)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const rustPath = join(here, '..', '..', 'hub', 'crates', 'db', 'src', 'lib.rs');
  const src = readFileSync(rustPath, 'utf8');
  const block = /pub const BRIDGE_FUNCTIONS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(src);
  assert.ok(block, 'no se encontró `pub const BRIDGE_FUNCTIONS` en el shim Rust');
  const rustList = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    rustList,
    BRIDGE_FUNCTIONS,
    'shim Rust y validador desincronizados: re-sincroniza BRIDGE_FUNCTIONS en ambos sitios',
  );
});

// ── regla: placeholders posicionales `?` ─────────────────────────────────────────────────
test('PASA: parámetros con nombre :name', () => {
  assert.equal(errors('SELECT * FROM t WHERE hub_id = :hub_id AND id = :id').length, 0);
});
test('FALLA: placeholder posicional ?', () => {
  const e = errors('INSERT INTO t (a, b) VALUES (?, ?)');
  assert.ok(e.length >= 1);
  assert.match(e[0].kind, /placeholder posicional/);
});

// ── regla: INSERT OR REPLACE / IGNORE ────────────────────────────────────────────────────
test('PASA: ON CONFLICT DO UPDATE', () => {
  assert.equal(
    errors('INSERT INTO t (id) VALUES (:id) ON CONFLICT (id) DO UPDATE SET n = :n').length,
    0,
  );
});
test('FALLA: INSERT OR REPLACE', () => {
  assert.match(kinds('INSERT OR REPLACE INTO t (id) VALUES (:id)').join(), /INSERT OR REPLACE/);
});
test('FALLA: INSERT OR IGNORE', () => {
  assert.match(kinds('INSERT OR IGNORE INTO t (id) VALUES (:id)').join(), /INSERT OR IGNORE/);
});

// ── regla: AUTOINCREMENT / SERIAL ────────────────────────────────────────────────────────
test('PASA: PK TEXT', () => {
  assert.equal(errors('CREATE TABLE t (id TEXT PRIMARY KEY)').length, 0);
});
test('FALLA: AUTOINCREMENT', () => {
  assert.match(kinds('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)').join(), /AUTOINCREMENT/);
});
test('FALLA: SERIAL', () => {
  assert.match(kinds('CREATE TABLE t (id SERIAL PRIMARY KEY)').join(), /SERIAL/);
});

// ── regla: tipos no portables ────────────────────────────────────────────────────────────
test('PASA: tipos del subconjunto portable', () => {
  assert.equal(
    errors('CREATE TABLE t (id TEXT, qty INTEGER, w REAL, raw BLOB, cents INTEGER)').length,
    0,
  );
});
test('FALLA: NUMERIC con escala', () => {
  assert.match(kinds('CREATE TABLE t (price NUMERIC(10,2))').join(), /tipo no portable `NUMERIC`/);
});
test('FALLA: TIMESTAMPTZ, VARCHAR, BOOLEAN, DECIMAL', () => {
  const k = kinds(
    'CREATE TABLE t (ts TIMESTAMPTZ, name VARCHAR(50), ok BOOLEAN, amt DECIMAL(8,2))',
  ).join();
  assert.match(k, /TIMESTAMPTZ/);
  assert.match(k, /VARCHAR/);
  assert.match(k, /BOOLEAN/);
  assert.match(k, /DECIMAL/);
});

// ── regla: funciones de fecha/string no portables ────────────────────────────────────────
test('FALLA: strftime / printf / datetime / to_char / julianday / json_each', () => {
  for (const fn of ['strftime', 'printf', 'datetime', 'to_char', 'julianday', 'json_each']) {
    const k = kinds(`SELECT ${fn}(x) FROM t`).join();
    assert.match(k, new RegExp(`función no portable .${fn}`), `esperaba detectar ${fn}(`);
  }
});

// ── regla: funciones-puente erp_* (set cerrado) ──────────────────────────────────────────
test('PASA: erp_pad / erp_now / erp_lpad (en el set)', () => {
  assert.equal(errors("SELECT 'FAC-' || erp_pad(:n, 5), erp_now(), erp_lpad(:c, 8, '*')").length, 0);
});
test('FALLA: erp_foo desconocido', () => {
  const e = errors('SELECT erp_foo(:x)');
  assert.ok(e.length >= 1);
  assert.match(e[0].kind, /función-puente desconocida `erp_foo/);
});
test('PASA: funciones-puente de fecha/hora (en el set)', () => {
  const sql = [
    "SELECT erp_dt(:x), erp_date(:x), erp_month_start(:now),",
    "       erp_dateadd(:now, 5, 'minutes'), erp_dow_mon0(:date),",
    "       erp_extract('hour', :dt), erp_datediff_days(:a, :b),",
    "       erp_timefmt(8, 5)",
    'FROM t WHERE hub_id = :hub_id',
  ].join('\n');
  assert.equal(errors(sql).length, 0);
});

// ── regla: dinero como REAL (WARNING por defecto) ────────────────────────────────────────
test('WARNING: columna de dinero declarada REAL', () => {
  const w = warnings('CREATE TABLE t (price_cents REAL, amount REAL, total REAL)');
  assert.ok(w.length >= 1);
  assert.match(w[0].kind, /declarada REAL/);
  // No es error: no bloquea.
  assert.equal(errors('CREATE TABLE t (price_cents REAL)').length, 0);
});
test('PASA: dinero como INTEGER no warns', () => {
  assert.equal(warnings('CREATE TABLE t (price_cents INTEGER, amount INTEGER)').length, 0);
});

// ── falsos positivos: literales y comentarios ────────────────────────────────────────────
test('no marca construcciones DENTRO de literales', () => {
  assert.equal(errors("SELECT 'INSERT OR REPLACE and ? and NUMERIC(1,2)' AS note").length, 0);
});
test('no marca construcciones DENTRO de comentarios de línea', () => {
  assert.equal(
    errors('-- ADR-0007: usa ON CONFLICT, no INSERT OR IGNORE; nada de ?\nSELECT :id FROM t').length,
    0,
  );
});
test('no marca construcciones DENTRO de comentarios de bloque', () => {
  assert.equal(
    errors('/* legacy: NUMERIC, strftime(), ? */\nSELECT :id FROM t').length,
    0,
  );
});
test('no marca nombres de columna que CONTIENEN la subcadena de un tipo', () => {
  // columna `text_note`, `integer_flag`: el límite \b evita marcar el prefijo, pero el tipo real
  // (TEXT/INTEGER) es portable, así que 0 errores.
  assert.equal(errors('CREATE TABLE t (text_note TEXT, integer_flag INTEGER)').length, 0);
});
test('NO marca date/time/timestamp como TIPO cuando son NOMBRES de columna en DML', () => {
  // SELECT/INSERT que referencian columnas llamadas date/time/timestamp: 0 errores (no es DDL).
  assert.equal(errors('SELECT date, time, timestamp FROM t WHERE hub_id = :hub_id').length, 0);
  assert.equal(errors('INSERT INTO t (date, time, timestamp) VALUES (:d, :t, :ts)').length, 0);
});
test('NO marca columna DDL llamada timestamp/time/date con tipo portable', () => {
  // `timestamp TEXT`, `time TEXT`, `event_date INTEGER` → el nombre contiene el token pero el tipo
  // es portable: 0 errores.
  assert.equal(
    errors('CREATE TABLE t (timestamp TEXT NOT NULL, time TEXT, event_date INTEGER)').length,
    0,
  );
});
test('SÍ marca un tipo no portable real DENTRO de CREATE TABLE', () => {
  assert.match(kinds('CREATE TABLE t (ts TIMESTAMPTZ NOT NULL)').join(), /TIMESTAMPTZ/);
});
test('NO marca tipos fuera de CREATE TABLE (índices, vistas)', () => {
  assert.equal(errors('CREATE INDEX ix ON verifactu_event (hub_id, timestamp)').length, 0);
});

test('reporta la línea correcta', () => {
  const e = errors('SELECT 1;\nSELECT 2;\nINSERT OR REPLACE INTO t (id) VALUES (:id)');
  assert.equal(e[0].line, 3);
});

// ── validateSql lanza ante errores y recoge migraciones de ambos dialectos ───────────────
test('collectModuleSql reúne migraciones (ambos dialectos), queries y commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-mod-'));
  try {
    mkdirSync(join(dir, 'migrations', 'sqlite'), { recursive: true });
    mkdirSync(join(dir, 'migrations', 'postgres'), { recursive: true });
    mkdirSync(join(dir, 'queries'), { recursive: true });
    writeFileSync(join(dir, 'migrations', 'sqlite', '001.sql'), 'CREATE TABLE t (id TEXT)');
    writeFileSync(join(dir, 'migrations', 'postgres', '001.sql'), 'CREATE TABLE t (id TEXT)');
    writeFileSync(join(dir, 'queries', 'q.sql'), 'SELECT id FROM t WHERE hub_id = :hub_id');
    const manifest = {
      id: 'demo',
      migrations: { sqlite: ['migrations/sqlite/001.sql'], postgres: ['migrations/postgres/001.sql'] },
      queries: { 'demo.q': { sql: 'queries/q.sql' } },
      commands: { 'demo.inline': { sql: 'INSERT INTO t (id) VALUES (:id)' } },
    };
    const entries = collectModuleSql(dir, manifest);
    assert.equal(entries.length, 4);
    // El inline se etiqueta module.json#...
    assert.ok(entries.some((e) => e.source === 'module.json#commands.demo.inline'));
    // Y valida sin errores.
    assert.doesNotThrow(() => validateSql(dir, manifest, { print: false }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validateSql LANZA cuando una migración postgres usa tipo no portable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-mod-'));
  try {
    mkdirSync(join(dir, 'migrations', 'postgres'), { recursive: true });
    writeFileSync(join(dir, 'migrations', 'postgres', '001.sql'), 'CREATE TABLE t (ts TIMESTAMPTZ)');
    const manifest = { id: 'demo', migrations: { postgres: ['migrations/postgres/001.sql'] } };
    assert.throws(() => validateSql(dir, manifest, { print: false }), /SQL no portable.*TIMESTAMPTZ/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
