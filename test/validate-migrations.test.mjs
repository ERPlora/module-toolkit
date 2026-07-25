// Tests de la paridad de migraciones manifest↔disco. `node --test`.
//
// ADR-0154 (dialecto ÚNICO Postgres): SQLite quedó deprecado. El gate ya no valida su
// paridad ni la exige — solo AVISA de restos para acompañar la transición. Contrato:
//   - ERROR: un `.sql` de `migrations/postgres/` no referenciado en el manifest;
//   - ERROR: el manifest referencia un fichero postgres que no existe;
//   - WARNING (no error, transición): restos de sqlite — dir `migrations/sqlite/` o claves
//     `migrations.sqlite`/`seed.sqlite` en el manifest.
//
// Antes (bug 2026-07-05) el gate cubría AMBOS dialectos; ese contrato queda superado por 0154.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkMigrations } from '../src/validate-migrations.mjs';

/**
 * Módulo temporal: `files` = rutas relativas a crear; `manifestExtra` = bloque(s) del manifest
 * (p. ej. `{ migrations: {...}, seed: {...} }`).
 */
function mod(files, manifestExtra) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-migparity-'));
  for (const rel of files) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), '-- sql\n');
  }
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0', ...(manifestExtra ?? {}) };
  return { dir, manifest, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('PASA: todos los .sql de postgres referenciados (sin restos sqlite)', () => {
  const m = mod(
    ['migrations/postgres/001_init.sql'],
    { migrations: { postgres: ['migrations/postgres/001_init.sql'] } },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  m.clean();
});

test('FALLA: .sql de postgres en disco sin referenciar', () => {
  const m = mod(['migrations/postgres/001_init.sql'], { migrations: {} });
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /postgres/);
  assert.match(errors[0], /001_init\.sql/);
  m.clean();
});

test('FALLA: referencia parcial de postgres (002 sin 001)', () => {
  const m = mod(
    ['migrations/postgres/001_init.sql', 'migrations/postgres/002_add.sql'],
    { migrations: { postgres: ['migrations/postgres/002_add.sql'] } },
  );
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /migrations\/postgres\/001_init\.sql/);
  m.clean();
});

test('FALLA: el manifest referencia un fichero postgres inexistente', () => {
  const m = mod(['migrations/postgres/001_init.sql'], {
    migrations: { postgres: ['migrations/postgres/001_init.sql', 'migrations/postgres/002_missing.sql'] },
  });
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /002_missing\.sql/);
  assert.match(errors[0], /no existe/);
  m.clean();
});

test('WARNING (no error): dir migrations/sqlite/ presente → deprecado ADR-0154', () => {
  const m = mod(
    ['migrations/sqlite/001_init.sql', 'migrations/postgres/001_init.sql'],
    { migrations: { postgres: ['migrations/postgres/001_init.sql'] } },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, [], 'los .sql de sqlite NO exigen referencia (deprecado)');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /deprecated \(ADR-0154\)/);
  assert.match(warnings[0], /sqlite/);
  m.clean();
});

test('WARNING (no error): clave manifest migrations.sqlite → deprecado ADR-0154', () => {
  const m = mod(
    ['migrations/postgres/001_init.sql'],
    {
      migrations: {
        sqlite: ['migrations/sqlite/001_init.sql'],
        postgres: ['migrations/postgres/001_init.sql'],
      },
    },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /deprecated \(ADR-0154\)/);
  m.clean();
});

test('WARNING (no error): clave manifest seed.sqlite → deprecado ADR-0154', () => {
  const m = mod(
    ['migrations/postgres/001_init.sql'],
    {
      migrations: { postgres: ['migrations/postgres/001_init.sql'] },
      seed: { sqlite: ['seed/sqlite/001_seed.sql'] },
    },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /deprecated \(ADR-0154\)/);
  assert.match(warnings[0], /seed\.sqlite/);
  m.clean();
});

test('PASA: módulo sin migraciones (ni en disco ni en manifest)', () => {
  const m = mod([], undefined);
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  m.clean();
});

test('ignora ficheros no-.sql dentro de migrations/postgres/', () => {
  const m = mod(
    ['migrations/postgres/001_init.sql', 'migrations/postgres/README.txt'],
    { migrations: { postgres: ['migrations/postgres/001_init.sql'] } },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  m.clean();
});
