// The acceptance test module-toolkit#80 asks for: the scaffolded module has to EXECUTE, not just
// PREPARE.
//
// Every gate we had stops one step short of the only thing that matters. `validate --pg` PREPAREs
// the statement — and `INSERT INTO t (id, name) VALUES ($1, $2)` prepares perfectly against a table
// whose `hub_id` is `NOT NULL`; the mock behind `erplora dev` answers `ok:true` without touching
// SQL; `pack` and `sign` never read semantics. The failure needs a row to actually be written, so
// this test writes one.
//
// It is also the regression guard for the whole class: if the templates ever drop `hub_id` again,
// the INSERT stops here instead of in a customer's hub — and the second half proves the READ side
// too, by seeding a row for another hub and checking the generated list does not return it.
//
// Without Docker it SKIPS, never passes in false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/scaffold.mjs';
import { pgAvailable, defaultContainer, translateForPostgres, shimDdlTypes } from '../src/validate-prepare.mjs';

const CONTAINER = defaultContainer();
const HAS_PG = await pgAvailable(CONTAINER);
const needsPg = { skip: HAS_PG ? false : 'no hay Postgres accesible (NO se ha comprobado nada)' };

const HUB_A = 'hub-aaaa-1111';
const HUB_B = 'hub-bbbb-2222';
const USER = 'user-9999';

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

// `ON_ERROR_STOP=1` is not decoration: WITHOUT it psql exits 0 even when Postgres refused the
// statement, and every assertion here would pass on a session that wrote nothing. It was caught by
// the step that DEMANDS a failure — the reason that step exists.
const psql = (db, sql) =>
  run(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', db, '-q', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    sql,
  );

/** A `$n` statement run the way the runtime runs it: PREPARE, then EXECUTE with the binds. */
function prepared(name, sql, names, params) {
  const args = names.map((n) => {
    const v = params[n];
    if (v === undefined) throw new Error(`bind sin valor: :${n}`);
    return typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  });
  return `PREPARE ${name} AS ${sql};\nEXECUTE ${name}(${args.join(', ')});\nDEALLOCATE ${name};\n`;
}

/** Scaffolds a module in a scratch dir and returns its paths. */
async function scaffolded() {
  const root = mkdtempSync(join(tmpdir(), 'erplora-runs-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
  } finally {
    process.chdir(prev);
  }
  const dir = join(root, 'demo_mod');
  return { root, dir, read: (p) => readFileSync(join(dir, p), 'utf8') };
}

test('el módulo de `g module` EJECUTA su command de escritura en Postgres (#80)', needsPg, async () => {
  const db = `erplora_mt80_${Date.now()}`;
  const { root, dir, read } = await scaffolded();
  await run('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', db]);
  try {
    // 1. El esquema del módulo, tal cual lo instala el hub.
    const migration = shimDdlTypes(read('migrations/postgres/001_init.sql'));
    const ddl = await psql(db, migration);
    assert.equal(ddl.code, 0, `la migración generada no aplica: ${ddl.stderr}`);

    // 2. Su command de creación, con los binds que inyecta `system_params` (contrato del kernel).
    const create = translateForPostgres(read('commands/items_create.sql'));
    const params = { hub_id: HUB_A, current_user_id: USER, id: 'it-1', name: 'Desde Hub', code: 'A-1', amount: 42 };
    const wrote = await psql(db, prepared('mt80_create', create.sql, create.names, params));
    assert.equal(
      wrote.code,
      0,
      `el command generado NO escribe: ${wrote.stderr}\n(este es exactamente el fallo de #80: ` +
        'PREPARA bien y revienta al EJECUTAR)',
    );

    // 3. La fila existe Y lleva el hub que la escribió — no NULL, que es lo que rompía.
    const row = await psql(db, `SELECT hub_id, created_by, updated_by FROM demo_mod_items WHERE id = 'it-1';`);
    assert.equal(row.stdout.trim(), `${HUB_A}|${USER}|${USER}`, 'hub_id/created_by/updated_by escritos');

    // 4. El control detecta el positivo: la forma ANTERIOR (sin hub_id) sigue reventando aquí.
    //    Sin esta comprobación, un fallo del banco haría pasar el test por casualidad.
    const old = await psql(
      db,
      `INSERT INTO demo_mod_items (id, name, code, amount) VALUES ('it-old', 'x', 'X', 1);`,
    );
    assert.notEqual(old.code, 0, 'la plantilla vieja DEBE seguir fallando');
    assert.match(old.stderr, /null value in column "hub_id"/, 'y por la razón de #80');
  } finally {
    await run('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--force', db]);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('las queries de `g module` NO devuelven filas de otro hub (#80)', needsPg, async () => {
  const db = `erplora_mt80_read_${Date.now()}`;
  const { root, dir, read } = await scaffolded();
  await run('docker', ['exec', CONTAINER, 'createdb', '-U', 'postgres', db]);
  try {
    const ddl = await psql(db, shimDdlTypes(read('migrations/postgres/001_init.sql')));
    assert.equal(ddl.code, 0, `la migración generada no aplica: ${ddl.stderr}`);

    // Dos hubs comparten la base de datos (los hubs anteriores a ADR-0201 lo hacen).
    const create = translateForPostgres(read('commands/items_create.sql'));
    for (const [hub, id, name] of [
      [HUB_A, 'a-1', 'Mío'],
      [HUB_B, 'b-1', 'Del vecino'],
    ]) {
      const p = { hub_id: hub, current_user_id: USER, id, name, code: id.toUpperCase(), amount: 1 };
      const w = await psql(db, prepared(`mt80_seed_${id.replace('-', '_')}`, create.sql, create.names, p));
      assert.equal(w.code, 0, `siembra ${hub}: ${w.stderr}`);
    }

    // La lista del hub A ve UNA fila, la suya. El vecino no existe para ella.
    const list = translateForPostgres(read('queries/items_list.sql'));
    const seen = await psql(db, prepared('mt80_list', list.sql, list.names, { hub_id: HUB_A }));
    const names = seen.stdout.trim().split('\n').filter(Boolean);
    assert.equal(seen.code, 0, `la lista generada no corre: ${seen.stderr}`);
    assert.equal(names.length, 1, `la lista del hub A devuelve ${names.length} filas: ${seen.stdout}`);
    assert.match(names[0], /Mío/);
    assert.doesNotMatch(seen.stdout, /Del vecino/, 'ninguna fila del otro hub');

    // `get` por id tampoco cruza: el id del vecino es real y aun así no se lee desde el hub A.
    const get = translateForPostgres(read('queries/items_get.sql'));
    const cross = await psql(db, prepared('mt80_get', get.sql, get.names, { hub_id: HUB_A, id: 'b-1' }));
    assert.equal(cross.code, 0, `el get generado no corre: ${cross.stderr}`);
    assert.equal(cross.stdout.trim(), '', 'el get de un id de OTRO hub no devuelve nada');
  } finally {
    await run('docker', ['exec', CONTAINER, 'dropdb', '-U', 'postgres', '--force', db]);
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
