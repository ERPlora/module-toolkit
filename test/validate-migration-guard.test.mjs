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
  tablesInventedByCommentSplit,
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

// 🔴 NOTA (#70). Estos tres fixtures son copias CONGELADAS de las versiones ROTAS que se publicaron
// el 18-19/08 — los ficheros de `origin/main` de esos módulos ya no llevan el `;` (comprobado: 0
// líneas). Lo que vigilan sigue vigente y es lo caro: que el `;` del comentario NO haga al guard
// inventarse una tabla (`is`, `create`) y rechazar una migración correcta.
//
// Lo que cambia es que ahora el fichero SÍ produce un error — el de compatibilidad — porque los
// hubs pineados a tags lo rechazan de verdad. Así que la aserción se afina en vez de relajarse:
// el ÚNICO error admisible es el del `;`, y ni uno solo sobre tablas. Un `deepEqual(errors, [])`
// aquí volvería a ser un test que no prueba nada.
/** Los errores que NO son la regla de compatibilidad del `;` en comentario (#70). */
function errorsOtherThanSemicolonInComment(errors) {
  return errors.filter((e) => !/dentro de un comentario/i.test(e));
}
test('customers/003: a `;` inside a `--` comment is prose, not the end of a statement', () => {
  const errors = guard(
    'customers',
    'migrations/postgres/003_purchase_ledger.sql',
    fixture('customers_003_purchase_ledger.sql'),
  );
  assert.deepEqual(
    errorsOtherThanSemicolonInComment(errors),
    [],
    'el `;` está dentro de un `--`: no puede generar NINGÚN error de tabla',
  );
  assert.equal(errors.length, 1, 'y sí el de compatibilidad (#70): la flota pineada la rechaza');
});

test('printing/002: neither a `;` nor an apostrophe inside a comment opens anything', () => {
  const errors = guard(
    'printing',
    'migrations/postgres/002_jobs.sql',
    fixture('printing_002_jobs.sql'),
  );
  assert.deepEqual(
    errorsOtherThanSemicolonInComment(errors),
    [],
    'el hub la rechazó por «toca `is`» y era prosa de un comentario',
  );
  assert.match(errors[0], /dentro de un comentario/i, 'queda el de compatibilidad (#70)');
});

test('tables/010: two `;` inside one `--` comment do not split anything either', () => {
  const errors = guard(
    'tables',
    'migrations/postgres/010_settings.sql',
    fixture('tables_010_settings.sql'),
  );
  assert.deepEqual(
    errorsOtherThanSemicolonInComment(errors),
    [],
    'el hub la rechazó por «toca `create`» y era prosa',
  );
  assert.match(errors[0], /dentro de un comentario/i, 'queda el de compatibilidad (#70)');
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

// ── #72: el upsert ───────────────────────────────────────────────────────────────────
//
// `ON CONFLICT … DO UPDATE SET …` es la forma canónica de sembrar datos de referencia
// idempotentes en una migración. El `UPDATE` de esa cláusula NO va seguido de una tabla: va
// seguido de `SET`, que es palabra reservada. Leer `set` como nombre de tabla rechazaba el
// upsert entero (`taxes/005_category_labels.sql`) — un falso positivo que BLOQUEA, que es la
// dirección cara de este guard.
test('PASA (#72): un upsert `ON CONFLICT … DO UPDATE SET` no lee `set` como tabla', () => {
  // The exact case of the issue: a reference-data seed that corrects what an earlier publish
  // already seeded — an UPDATE of a real upsert, not a `DO NOTHING` that only works the first day.
  const upsert = [
    'INSERT INTO taxes_category_label (key, lang, label, description)',
    "VALUES ('reduced', 'es', 'Reducido', NULL)",
    'ON CONFLICT (key, lang) DO UPDATE',
    '  SET label = EXCLUDED.label, description = EXCLUDED.description;',
  ].join('\n');
  assert.deepEqual(
    guard('taxes', 'migrations/postgres/005_category_labels.sql', upsert),
    [],
  );
  // The other leg of the upsert anchors nothing either: `DO NOTHING` carries no `UPDATE` at all.
  const doNothing = [
    'INSERT INTO taxes_category_label (key, lang, label)',
    "VALUES ('reduced', 'es', 'Reducido')",
    'ON CONFLICT (key, lang) DO NOTHING;',
  ].join('\n');
  assert.deepEqual(guard('taxes', 'migrations/postgres/005_category_labels.sql', doNothing), []);
});

test('FALLA (#72): un `UPDATE <tabla ajena> SET` de verdad se sigue rechazando', () => {
  // The control that keeps the fix from opening a hole: the anchor still reads the table of a
  // real `UPDATE` — only the `SET` KEYWORD stops being taken for a table name.
  const errors = guard('taxes', 'm.sql', 'UPDATE inventory_item SET x = 1');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /inventory_item/);
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

// ── Un `contract` retira ESTRUCTURA, no filas (ERPlora/hub#1145) ─────────────────────

test('FALLA: un `contract` no puede vaciar ni borrar filas', () => {
  // El runtime traduce `DROP TABLE`/`DROP COLUMN` a `RENAME … TO _deprecated_…`, así que retirar
  // algo es reversible. De las filas no hay nada que apartar: un `TRUNCATE`/`DELETE FROM` dentro de
  // un `contract` se ejecutaba tal cual sobre la BD de un cliente, y el autor tenía todos los
  // motivos para creer lo contrario, porque es lo que el `kind` promete.
  for (const sql of [
    'TRUNCATE sales_sale',
    'TRUNCATE TABLE sales_sale',
    'DELETE FROM sales_sale',
    "DELETE FROM sales_sale WHERE legacy = 'yes'",
    // Un salto de línea entre el verbo y su `FROM` es la razón de mirar token a token.
    'DELETE\n  FROM sales_sale',
  ]) {
    const errors = guard('sales', 'm.sql', sql, 'contract');
    assert.equal(errors.length, 1, `debería rechazar \`${sql}\``);
    assert.match(errors[0], /backfill/, 'y decir por dónde SÍ se limpian filas');
  }
});

test('PASA: limpiar filas es lo que un `backfill` es', () => {
  // El error de arriba manda al autor a un `backfill`, así que esa puerta tiene que estar abierta
  // de verdad — si no, se le está mandando a un sitio cerrado.
  assert.deepEqual(
    guard('sales', 'm.sql', "DELETE FROM sales_sale WHERE legacy = 'yes'", 'backfill'),
    [],
  );
});

test('PASA: lo que solo SE PARECE a un verbo destructivo no lo es', () => {
  // Un falso positivo aquí deja un módulo sin publicar: por eso se comparan tokens enteros y
  // `DELETE` solo cuenta con su `FROM` detrás.
  for (const sql of [
    'ALTER TABLE sales_sale DROP COLUMN truncate_at',
    'ALTER TABLE sales_line ADD CONSTRAINT sales_line_fk FOREIGN KEY (sale_id) ' +
      'REFERENCES sales_sale (id) ON DELETE CASCADE',
    '-- esto NO hace TRUNCATE ni DELETE FROM nada\nDROP TABLE sales_old',
  ]) {
    assert.deepEqual(guard('sales', 'm.sql', sql, 'contract'), [], `debería pasar \`${sql}\``);
  }
});

test('FALLA: un `contract` retira UNA tabla (o una columna) por sentencia', () => {
  // `DROP TABLE a, b;` es SQL válido, pero `ALTER TABLE … RENAME TO` acepta una sola tabla: el
  // runtime producía `ALTER TABLE a, RENAME TO _deprecated_a,` y reventaba con un `syntax error at
  // or near ","` que no explica nada, dejando además `b` sin retirar.
  for (const [sql, noun] of [
    ['DROP TABLE sales_a, sales_b', 'tabla'],
    ['ALTER TABLE sales_sale DROP COLUMN a, DROP COLUMN b', 'columna'],
    ['ALTER TABLE sales_sale ADD COLUMN x TEXT, DROP COLUMN y', 'columna'],
  ]) {
    const errors = guard('sales', 'm.sql', sql, 'contract');
    assert.equal(errors.length, 1, `debería rechazar \`${sql}\``);
    assert.match(errors[0], new RegExp(`una ${noun} por sentencia`));
  }
});

test('PASA: `CASCADE` no es una lista de tablas', () => {
  assert.deepEqual(guard('sales', 'm.sql', 'DROP TABLE sales_old CASCADE', 'contract'), []);
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

// ── Un `;` dentro de un comentario: la regla es de COMPATIBILIDAD, no de sintaxis (#70) ────────
//
// `splitStatements` ya trata un `;` dentro de `-- …` o `/* … */` como prosa, y hace bien: es lo que
// hace el runtime EN `develop` (`migration_guard.rs`, hub#1027). Pero los hubs de ahí fuera no
// corren `develop`: la flota va pineada a TAGS, y `v1.1.3`…`v1.1.8` NO llevan ese arreglo. En
// todos ellos el `;` parte la sentencia, el trozo pierde su `--`, la prosa se lee como SQL y el
// módulo se RECHAZA ENTERO al instalar.
//
// Por eso esto no puede juzgarse con el runtime que nosotros tenemos delante: se juzga con el que
// tiene el CLIENTE. Un módulo que se publica hoy tiene que instalarse en los hubs que YA están
// desplegados, y un `;` en un comentario se lo impide en todos ellos.
//
// El caso que lo destapó es el peor posible: lo metía la PLANTILLA del propio generador
// (`scaffold.mjs`), así que TODO módulo nuevo nacía sin poder instalarse, y `erplora validate`
// daba verde y exit 0.
test('un `;` en un comentario SOLO es error si el trozo inventa una tabla ajena (#70)', () => {
  // La forma que rompe de verdad, y la única: el `;` corta, el trozo pierde su `--`, y lo que
  // queda se lee como una sentencia sobre una tabla que no es del módulo. Es exactamente como el
  // hub rechazó `printing/002_jobs.sql` por «tocar `is`» — una palabra de la prosa.
  const sql = ['-- ojo al leer(); this table is the ledger', 'CREATE TABLE IF NOT EXISTS demo_x (id uuid);'].join('\n');
  const errors = checkMigrationSql('demo', '001_init.sql', sql);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /dentro de un comentario/i);
  assert.match(errors[0], /v1\.1\.7/, 'y dice a QUÉ hubs afecta');
});

test('un `;` en un comentario INOFENSIVO no bloquea a nadie (#70)', () => {
  // 🔴 El control que evita la catástrofe cara. La primera versión de esta regla marcaba TODO `;`
  // dentro de un comentario: 82 de las 123 migraciones publicadas lo llevan y NINGUNA rompe nada,
  // así que habría puesto en rojo ~20 repos de módulo por un peligro que no tienen.
  //
  // Aquí el trozo que queda tras el corte sigue apuntando a una tabla del propio módulo, que es lo
  // que pasa en la inmensa mayoría de los casos — la plantilla del generador incluida.
  const sql = ['-- el runtime añade hub_id + audit por contrato; aquí solo el dominio.', 'CREATE TABLE IF NOT EXISTS demo_items (id uuid);'].join('\n');
  assert.deepEqual(checkMigrationSql('demo', '001_init.sql', sql), []);
});

test('la regla DISCRIMINA: caza los tres rotos y nombra la tabla que cada hub inventó (#70)', () => {
  // Control POSITIVO sobre los tres ficheros que un hub rechazó de verdad. Y no basta con que dé
  // error: tiene que nombrar la MISMA palabra que salió en el rechazo original, o estaría acertando
  // por casualidad.
  const casos = [
    ['customers', 'customers_003_purchase_ledger.sql', 'it'],
    ['printing', 'printing_002_jobs.sql', 'is'],
    ['tables', 'tables_010_settings.sql', 'create'],
  ];
  for (const [mod, file, palabra] of casos) {
    assert.deepEqual(
      tablesInventedByCommentSplit(mod, fixture(file)),
      [palabra],
      `${mod}: el hub lo rechazó por «tocar \`${palabra}\`», que era prosa de un comentario`,
    );
  }
});

test('control NEGATIVO: ninguna migración publicada HOY cae en la regla (#70)', () => {
  // Los tres de arriba son copias CONGELADAS de las versiones rotas; en `origin/main` de esos
  // repos ya no llevan el `;`. Medido el 2026-08-20 sobre las 123 migraciones publicadas por los
  // 25 módulos: 82 llevan un `;` dentro de un comentario y NINGUNA cae en esta regla.
  //
  // Ese número es la razón de que la regla sea estrecha. Marcar todo `;` en comentario habría
  // puesto en rojo ~20 repos de módulo por un peligro que no tienen — y un gate que bloquea a
  // quien hace las cosas bien deja de ser un gate y pasa a ser un obstáculo.
  const inofensiva = [
    '-- el runtime añade hub_id + audit por contrato; aquí solo el dominio.',
    'CREATE TABLE IF NOT EXISTS demo_items (id uuid PRIMARY KEY);',
  ].join('\n');
  assert.deepEqual(tablesInventedByCommentSplit('demo', inofensiva), []);
  assert.deepEqual(checkMigrationSql('demo', '001_init.sql', inofensiva), []);
});

test('un comentario SIN `;` no molesta a nadie (#70)', () => {
  const sql = ['-- items del dominio, sin nada raro', 'CREATE TABLE IF NOT EXISTS demo_b (id uuid);'].join('\n');
  assert.deepEqual(checkMigrationSql('demo', '001_init.sql', sql), []);
});

test('un `;` dentro de un LITERAL no es un comentario: no puede dar falso positivo (#70)', () => {
  // `'a;b'` es DATO. Confundirlo con prosa dejaría fuera migraciones perfectamente correctas, que
  // es el error caro cuando el gate bloquea 25 repos a la vez.
  const sql = "INSERT INTO demo_c (v) VALUES ('a;b');";
  assert.deepEqual(checkMigrationSql('demo', '001_init.sql', sql), []);
});

test('lo que ESCRIBE el generador pasa su propia regla (#70)', async () => {
  // El control que cierra el círculo, y se hace sobre el ARTEFACTO, no sobre un trozo del fuente
  // sacado con una regex: la primera versión de este test recortaba el fragmento equivocado de
  // `scaffold.mjs` y pasaba en verde con la plantilla ROTA delante. Un test que no puede fallar no
  // vigila nada.
  //
  // Sin esto, arreglar la plantilla hoy no impide que alguien vuelva a meter un `;` mañana — y el
  // castigo lo cobra el cliente, no el CI: `erplora validate` daba OK y exit 0.
  const { generate } = await import('../src/scaffold.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'erplora-scaffold-70-'));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    await generate('module', 'probe70');
    const sql = readFileSync(join(dir, 'probe70', 'migrations', 'postgres', '001_init.sql'), 'utf8');
    assert.match(sql, /CREATE TABLE/, 'el generador escribió algo reconocible');
    assert.deepEqual(
      checkMigrationSql('probe70', '001_init.sql', sql),
      [],
      'el módulo recién generado no se instalaría en ningún hub de la flota',
    );
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Lo que no se puede LEER no entra (espejo de ERPlora/hub#1149) ──────────────────────────────
//
// El guard es un lint sobre el TEXTO y el cuerpo de un `DO`/`CREATE FUNCTION` es opaco: dentro cabe
// un `EXECUTE` que arma la sentencia en tiempo de ejecución, así que ni el verbo ni la tabla son
// tokens que leer. El runtime lo rechaza desde hub#1149; esta puerta tiene que rechazarlo IGUAL, o
// el módulo se publica verde y revienta al instalar — que es exactamente el accidente que este
// port vino a impedir.

test('un cuerpo `$$ … $$` es UNA sentencia, no dos (hub#1149)', () => {
  for (const sql of [
    "DO $$\nBEGIN\n  DELETE FROM sales_line WHERE legacy = 'yes';\nEND\n$$;",
    'CREATE FUNCTION sales_touch() RETURNS trigger AS $body$\nBEGIN\n  DELETE FROM sales_line;\n  RETURN NEW;\nEND\n$body$ LANGUAGE plpgsql;',
  ]) {
    const statements = splitStatements(sql);
    assert.equal(statements.length, 1, `el cuerpo entre \`$…$\` no se parte: ${JSON.stringify(statements)}`);
  }
});

test('un cuerpo procedimental NO entra en una migración de módulo (hub#1149)', () => {
  const bodies = [
    "DO $$\nBEGIN\n  DELETE FROM sales_line WHERE legacy = 'yes';\nEND\n$$",
    "DO $limpia$ BEGIN EXECUTE 'DELETE FROM sales_line'; END $limpia$",
    'CREATE FUNCTION sales_touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql',
    'CREATE OR REPLACE FUNCTION sales_touch() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql',
    'CREATE PROCEDURE sales_clean() LANGUAGE plpgsql AS $$ BEGIN DELETE FROM sales_line; END $$',
  ];
  for (const sql of bodies) {
    for (const kind of ['expand', 'backfill', 'contract']) {
      const errors = checkMigrationSql('sales', 'migrations/postgres/020_x.sql', sql, kind);
      assert.equal(errors.length > 0, true, `\`${sql}\` (${kind}) tenía que rechazarse`);
      assert.match(errors[0], /procedimental|no se puede leer|opaco/i, `y decir por qué: ${errors[0]}`);
    }
  }
});

test('un `$$` dentro de un literal o de un comentario NO abre un cuerpo (hub#1149)', () => {
  for (const sql of [
    "INSERT INTO sales_line (label) VALUES ('$$ no es un cuerpo $$')",
    '-- el coste va en $$ y no abre nada\nCREATE TABLE sales_line (id BIGINT)',
    "CREATE TABLE sales_line (id BIGINT, note TEXT DEFAULT 'precio en $')",
  ]) {
    assert.deepEqual(
      checkMigrationSql('sales', 'migrations/postgres/021_x.sql', sql, 'expand'),
      [],
      `\`${sql}\` es SQL correcto y tiene que pasar`,
    );
  }
});

// ── El upsert: las dos puertas ya dicen lo mismo (hub#1109) ────────────────────────────────────

test('un upsert sobre tabla propia pasa, y el runtime ya no lo rechaza (hub#1109)', () => {
  const upsert =
    "INSERT INTO taxes_category_label (key, lang, label, description) VALUES ('food', 'es', 'x', 'y') " +
    'ON CONFLICT (key, lang) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description';
  assert.deepEqual(
    checkMigrationSql('taxes', 'migrations/postgres/005_category_labels.sql', upsert, 'backfill'),
    [],
  );
  // Y el ancla sigue cazando el positivo: `set` no es una tabla, pero la de otro módulo sí.
  assert.deepEqual(tablesTouched(upsert), ['taxes_category_label']);
  assert.deepEqual(tablesTouched('UPDATE sales_sale SET total = 0'), ['sales_sale']);
});
