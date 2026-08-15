// Tests del validador de ERPlora SQL portable (ADR-0007). `node --test`.
// Un caso que PASA y un caso que FALLA por cada regla, + casos de falsos positivos
// (literales y comentarios) y el barrido inline/migraciones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintSql, validateSql, collectModuleSql, BRIDGE_FUNCTIONS, PORTABLE_TYPES } from '../src/validate-sql.mjs';

const errors = (sql) => lintSql(sql).filter((f) => f.level === 'error');
const warnings = (sql) => lintSql(sql).filter((f) => f.level === 'warning');
const kinds = (sql) => lintSql(sql).map((f) => f.kind);

// ── el set portable está sincronizado con lo que documentamos del shim ───────────────────
// ESTA LISTA ES UN ESPEJO de `BRIDGE_FUNCTIONS` en `hub/crates/db/src/lib.rs`. Se había quedado
// con solo 3 de las 11 que el shim implementa de verdad, así que el validador rechazaba SQL
// perfectamente portable: `erplora validate modules/sales` fallaba con «función-puente desconocida
// `erp_date`» — y como el SQL se valida ANTES que los schemas, ningún módulo que use una función de
// fecha llegaba siquiera a que le revisaran el dinero. Si añades una función-puente al shim,
// añádela aquí.
test('set portable expone las constantes del shim', () => {
  assert.deepEqual(BRIDGE_FUNCTIONS, [
    'erp_now', 'erp_lpad', 'erp_pad', 'erp_dt', 'erp_date', 'erp_dateadd',
    'erp_month_start', 'erp_dow_mon0', 'erp_extract', 'erp_datediff_days', 'erp_timefmt',
  ]);
  assert.deepEqual(PORTABLE_TYPES, ['TEXT', 'INTEGER', 'REAL', 'BLOB']);
});

test('PASA: las funciones de fecha del shim son SQL portable (no «desconocidas»)', () => {
  const sql = 'SELECT erp_date(created_at) FROM sales WHERE erp_dt(expires_at) > erp_dt(:now)';
  assert.equal(errors(sql).length, 0, 'erp_date/erp_dt las implementa el shim');
});

test('FALLA: una erp_* inventada sigue siendo un error', () => {
  // El set es CERRADO: la regla real es «no te inventes funciones-puente», no «no uses fechas».
  const e = errors('SELECT erp_quarter(created_at) FROM sales');
  assert.ok(e.length >= 1);
  assert.match(e[0].kind, /función-puente desconocida/);
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

// ── validateSql lanza ante errores y recoge migraciones postgres (dialecto único, ADR-0154) ─
test('collectModuleSql reúne migraciones (postgres), queries y commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-mod-'));
  try {
    mkdirSync(join(dir, 'migrations', 'postgres'), { recursive: true });
    mkdirSync(join(dir, 'queries'), { recursive: true });
    writeFileSync(join(dir, 'migrations', 'postgres', '001.sql'), 'CREATE TABLE t (id TEXT)');
    writeFileSync(join(dir, 'queries', 'q.sql'), 'SELECT id FROM t WHERE hub_id = :hub_id');
    const manifest = {
      id: 'demo',
      migrations: { postgres: ['migrations/postgres/001.sql'] },
      queries: { 'demo.q': { sql: 'queries/q.sql' } },
      commands: { 'demo.inline': { sql: 'INSERT INTO t (id) VALUES (:id)' } },
    };
    const entries = collectModuleSql(dir, manifest);
    assert.equal(entries.length, 3);
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

// ── regla: aislamiento de tablas por módulo (hub#513) ────────────────────────────────────
// El SQL de un módulo se ejecuta tal cual contra la BD del hub. Sin guarda, un command puede
// llevar `UPDATE hub_user SET role='admin'` o `DELETE FROM _elevation_audit`. Esta regla lo caza
// en build: denylist dura del core (ERROR) + fuera-de-prefijo (WARNING).
const scopeErrs = (sql, moduleId) =>
  lintSql(sql, '<sql>', moduleId ? { moduleId } : undefined).filter(
    (f) => f.level === 'error' && /core|prefijo|tabla/.test(f.kind),
  );
const scopeWarns = (sql, moduleId) =>
  lintSql(sql, '<sql>', moduleId ? { moduleId } : undefined).filter(
    (f) => f.level === 'warning' && /core|prefijo|tabla/.test(f.kind),
  );

test('FALLA: un módulo que borra de _elevation_audit (tabla de sistema)', () => {
  const e = scopeErrs('DELETE FROM _elevation_audit', 'sales');
  assert.ok(e.length >= 1, '_elevation_audit es del sistema → error');
  assert.match(e[0].kind, /tabla de sistema `_elevation_audit`/);
});

test('FALLA: lectura de una tabla de sistema del runtime (_scheduled_tasks)', () => {
  const e = scopeErrs('SELECT * FROM _scheduled_tasks WHERE next_run <= :now', 'sales');
  assert.ok(e.length >= 1, 'una tabla interna del runtime es error incluso en lectura');
});

test('WARN: un módulo que LEE hub_user (tabla del core — lectura es aviso, no bloqueo)', () => {
  // La lectura de tablas hub_* es WARNING (algunas son referencias legítimas). Es un aviso para
  // revisar, no un bloqueo: la medición sobre el catálogo mostró que taxes lee hub_settings y
  // hub_country documentado (ADR-0085). El que aquí usemos hub_user de ejemplo no cambia el nivel.
  const w = scopeWarns('SELECT pin_hash FROM hub_user WHERE id = :id', 'sales');
  assert.ok(w.length >= 1, 'lectura de hub_* → warning (referencia a revisar)');
});

test('FALLA: un módulo que ESCRIBE en hub_user (tabla del core)', () => {
  const e = scopeErrs("UPDATE hub_user SET role = 'admin' WHERE id = :id", 'sales');
  assert.ok(e.length >= 1, 'escritura en hub_* → error');
  assert.match(e[0].kind, /escritura en tabla del core/);
});

test('FALLA: CREATE TABLE con nombre del core', () => {
  const e = scopeErrs('CREATE TABLE hub_foo (k TEXT, v TEXT)', 'sales');
  assert.ok(e.length >= 1, 'un módulo no crea tablas del core');
});

test('WARN: hub_settings en LECTURA (ADR-0085 lo tolera para identidad fiscal)', () => {
  // taxes lee hub_settings.country_code documentado — lectura es WARNING, no ERROR.
  const w = scopeWarns('SELECT country_code FROM hub_settings WHERE hub_id = :hub_id', 'taxes');
  assert.ok(w.length >= 1, 'lectura de hub_settings → warning (no error)');
});

test('FALLA: hub_settings en ESCRITURA (un módulo no reescribe la identidad del negocio)', () => {
  const e = scopeErrs("UPDATE hub_settings SET v = 'ES' WHERE k = 'country_code'", 'taxes');
  assert.ok(e.length >= 1, 'escritura en hub_settings → error');
});

test('WARN: lectura de hub_country (tabla de referencia del core, como hub_settings)', () => {
  // taxes lee hub_country (referencia de países) — mismo trato que hub_settings: lectura tolerada.
  const w = scopeWarns('SELECT code FROM hub_country', 'taxes');
  assert.ok(w.length >= 1, 'lectura de tabla de referencia del core → warning');
});

test('WARN: un módulo que lee la tabla de OTRO módulo (sales_sale_item desde inventory)', () => {
  // El cruce real hoy: inventory lee sales_sale_item. No es error (no es del core), pero avisa.
  const w = scopeWarns('SELECT product_id FROM sales_sale_item WHERE id = :id', 'inventory');
  assert.ok(w.length >= 1, 'tabla sin prefijo del módulo → warning');
  assert.match(w[0].kind, /sin el prefijo del módulo `inventory_`/);
});

test('PASA: un módulo que lee SU PROPIA tabla (prefijo correcto)', () => {
  assert.equal(scopeErrs('SELECT * FROM sales_order WHERE id = :id', 'sales').length, 0);
  assert.equal(scopeWarns('SELECT * FROM sales_order WHERE id = :id', 'sales').length, 0);
});

test('PASA: alias de tabla no se confunde con tabla del core', () => {
  // `FROM hub_user u` — el alias `u` no debe marcarse; la tabla `hub_user` (lectura) sí, como aviso.
  const w = scopeWarns('SELECT u.id FROM hub_user u', 'sales');
  assert.equal(w.length, 1, 'solo la tabla, no el alias');
  assert.match(w[0].kind, /hub_user/);
});

test('PASA: tabla TEMP propia con prefijo _ no se marca como core (carve-out de _taxes_backfill)', () => {
  // Caso real: taxes crea `_taxes_backfill_hubs` como TEMP. Empieza por _ pero es del módulo.
  // Sin embargo, la denylist dura marcaría _taxes_backfill_hubs. Esto es un TENSION conocida:
  // la regla es léxica y no distingue TEMP-propia de tabla-de-sistema. El contracto es que las
  // TEMP propias también lleven el prefijo del módulo. Aquí confirmamos el comportamiento actual.
  const e = scopeErrs('CREATE TEMP TABLE taxes_backfill_hubs AS SELECT 1', 'taxes');
  assert.equal(e.length, 0, 'taxes_backfill_hubs lleva el prefijo del módulo → no es core');
});

test('PASA: JOIN a tabla propia con prefijo correcto', () => {
  const sql =
    'SELECT i.* FROM sales_order o JOIN sales_order_item i ON i.order_id = o.id WHERE o.id = :id';
  assert.equal(scopeErrs(sql, 'sales').length, 0);
  assert.equal(scopeWarns(sql, 'sales').length, 0);
});

// ── module-toolkit#36: un bind `:from` NO es una cláusula FROM ───────────────────────────
// `\bFROM\b` casa DENTRO de `:from` porque `:` no es carácter de palabra, así que el escáner
// leía el token siguiente como nombre de tabla y avisaba de una «tabla `AND`» que no existe.
// No es rebuscado: `from` es el nombre del campo del payload del evento del core
// `hub.whatsapp.message_received`, y un listener recibe el payload verbatim — el módulo NO
// puede renombrarlo. Un aviso que miente sobre su causa se aprende a ignorar, y entonces el
// aviso de verdad (un cruce de tablas real) cae en el mismo montón.
for (const word of ['from', 'join', 'into', 'update', 'table']) {
  test(`PASA: el bind \`:${word}\` no se lee como cláusula SQL (module-toolkit#36)`, () => {
    const sql = `SELECT id FROM wa_conversation c WHERE c.wa_contact_id = :${word} AND c.is_deleted = 0`;
    const found = lintSql(sql, '<sql>', { moduleId: 'wa' });
    assert.deepEqual(
      found.map((f) => f.kind),
      [],
      `el bind :${word} no genera ningún finding`,
    );
  });
}

test('FALLA igual: `::NUMERIC` es un CAST, no un bind — el tipo no portable se sigue viendo', () => {
  // La contrapartida del enmascarado: `::` abre un cast de Postgres. Tratarlo como parámetro se
  // comería el nombre del tipo y la regla que existe para cazarlo dejaría de verlo. Un arreglo
  // que apaga otra puerta no es un arreglo, así que el caso va escrito: sin la excepción de `::`
  // este CHECK pasa en verde.
  const e = errors('CREATE TABLE demo_t (qty INTEGER, CHECK ((qty)::NUMERIC > 0))');
  assert.deepEqual(
    e.map((f) => f.kind),
    ['tipo no portable `NUMERIC`'],
    'el tipo del cast dentro del bloque de columnas sigue siendo error',
  );
});

test('el caso real de whatsapp_inbox: `= :from AND …` no inventa una tabla `AND`', () => {
  // Reproducción literal del aviso reportado en la issue.
  const sql = [
    'SELECT c.id FROM whatsapp_inbox_conversation c',
    'WHERE c.wa_contact_id = :from AND c.is_deleted = 0 LIMIT 1',
  ].join('\n');
  const w = scopeWarns(sql, 'whatsapp_inbox');
  assert.deepEqual(w, [], 'ni tabla `AND` ni ningún otro fantasma');
});

test('PASA: sin moduleId, la regla solo aplica la allowlist de tablas protegidas', () => {
  // lintSql suelto (sin ctx) no puede juzgar el prefijo, pero sí defiende el core.
  assert.equal(scopeErrs('SELECT * FROM sales_order', undefined).length, 0, 'sin ctx no juzga prefijo');
  // Las tablas de sistema del runtime (_*) siempre son error, con o sin ctx.
  assert.ok(scopeErrs('DELETE FROM _elevation_audit', undefined).length >= 1, 'las tablas _ del runtime siempre se defienden');
});
