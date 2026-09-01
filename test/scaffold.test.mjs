// Tests del andamiado de módulos. `node --test`.
//
// ADR-0154 (dialecto ÚNICO Postgres): `g module` genera SOLO la migración de postgres y la
// referencia en el manifest. SQLite quedó deprecado — ni se genera ni se referencia.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/scaffold.mjs';
import { checkMigrations } from '../src/validate-migrations.mjs';
import { checkHubScope } from '../src/validate-hub-scope.mjs';
import { checkContracts, contractsFileIsStale } from '../src/contracts.mjs';

test('g module genera SOLO migración postgres y la referencia en el manifest (ADR-0154)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');

    assert.ok(existsSync(join(dir, 'migrations/postgres/001_init.sql')), 'migración postgres');
    assert.ok(!existsSync(join(dir, 'migrations/sqlite')), 'NO genera dir sqlite');

    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
    assert.deepEqual(manifest.migrations, {
      postgres: ['migrations/postgres/001_init.sql'],
    });

    // El módulo recién andamiado pasa el gate (sin errores ni warnings de deprecación).
    const { errors, warnings } = checkMigrations(dir, manifest);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// module-toolkit#80: el módulo andamiado tiene que OPERAR, no solo compilar.
//
// El scaffold generaba `INSERT INTO <id>_items (id, name, code, amount)` sobre una tabla cuya
// columna `hub_id` es `NOT NULL`, y queries sin `WHERE hub_id = :hub_id`. El runtime inyecta el
// BIND `:hub_id`, nunca la columna ni el predicado (`system_params`, contrato del kernel), así que
// el único camino de escritura del módulo generado fallaba en TODOS los hubs — y la lectura
// devolvía filas de otros hubs en BD compartida. Todo ello con `validate --pg` en VERDE, porque el
// SQL PREPARA perfectamente: el agujero solo aparece al EJECUTAR.
test('g module: el INSERT generado escribe hub_id y los queries acotan por :hub_id (#80)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-hubid-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');
    const read = (p) => readFileSync(join(dir, p), 'utf8');

    const create = read('commands/items_create.sql');
    assert.match(create, /INSERT INTO demo_mod_items \([^)]*\bhub_id\b/, 'el INSERT nombra la columna hub_id');
    assert.match(create, /:hub_id/, 'y la puebla con el bind del runtime');
    assert.match(create, /\bcreated_by\b[\s\S]*\bupdated_by\b/, 'atribución: created_by/updated_by');
    assert.match(create, /:current_user_id/, 'poblados con el bind del runtime');

    for (const q of ['queries/items_list.sql', 'queries/items_get.sql']) {
      assert.match(read(q), /hub_id\s*=\s*:hub_id/, `${q} acota por hub_id`);
    }

    // La misma puerta que corre en `erplora validate` no encuentra nada que objetar.
    const manifest = JSON.parse(read('module.json'));
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// `erplora g command` / `g query` escribían el mismo agujero: un UPDATE sin `WHERE hub_id` es una
// escritura CRUZADA entre hubs, y un SELECT sin él una lectura cruzada. El generador no puede
// producir SQL que el propio `erplora validate` rechace.
test('g command / g query: las plantillas nacen acotadas por :hub_id (#80)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-gsql-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
    await generate('command', 'demo_mod', 'demo_mod.items.touch');
    await generate('query', 'demo_mod', 'demo_mod.items.recent');
    const dir = join(root, 'demo_mod');

    const cmd = readFileSync(join(dir, 'commands/demo_mod_items_touch.sql'), 'utf8');
    assert.match(cmd, /hub_id\s*=\s*:hub_id/, 'el UPDATE generado acota por hub_id');

    const qry = readFileSync(join(dir, 'queries/demo_mod_items_recent.sql'), 'utf8');
    assert.match(qry, /hub_id\s*=\s*:hub_id/, 'el SELECT generado acota por hub_id');
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

// module-toolkit#80, resultado esperado 1: el módulo andamiado funciona «sin editar nada». No lo
// hacía ni siquiera para la puerta más barata — `erplora validate` sobre un módulo recién generado
// fallaba con `.erplora/contracts.json desactualizado o ausente` (ADR-0127), así que el primer
// comando que la desarrolladora corre después de generar salía en ROJO por algo que el generador
// sabe calcular él mismo: el fichero se deriva del manifest y del SQL del propio módulo.
test('g module: el módulo generado pasa `validate` sin tocar nada (#80)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-contracts-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');

    assert.ok(existsSync(join(dir, '.erplora/contracts.json')), 'el scaffold escribe contracts.json');

    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
    assert.equal(contractsFileIsStale(dir, manifest), false, 'y coincide con lo que el código genera');
    assert.deepEqual(checkContracts(dir, manifest).errors, []);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});
