// Tests de la paridad de migraciones manifest↔disco. `node --test`.
//
// Bug 2026-07-05 (hubs Cloud instalaban sin migrar): 16 manifests omitían
// `migrations.postgres` (+1 la listaba a medias) aunque el `.sql` existía en el paquete,
// y `validate` solo miraba los ficheros REFERENCIADOS → el gate no lo cazaba. Regla nueva:
//   - ERROR: un `.sql` de `migrations/<dialecto>/` no referenciado en el manifest;
//   - ERROR: el manifest referencia un fichero que no existe;
//   - WARNING (no error): un dialecto tiene migraciones y el otro ninguna — legítimo en
//     módulos de un solo producto (`backup` es solo-SQLite por diseño, ADR-0040).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkMigrations } from '../src/validate-migrations.mjs';

/** Módulo temporal: `files` = rutas relativas a crear; `migrations` = bloque del manifest. */
function mod(files, migrations) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-migparity-'));
  for (const rel of files) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), '-- sql\n');
  }
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0' };
  if (migrations) manifest.migrations = migrations;
  return { dir, manifest, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('PASA: todos los .sql de ambos dialectos referenciados', () => {
  const m = mod(
    ['migrations/sqlite/001_init.sql', 'migrations/postgres/001_init.sql'],
    { sqlite: ['migrations/sqlite/001_init.sql'], postgres: ['migrations/postgres/001_init.sql'] },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  m.clean();
});

test('FALLA: .sql de postgres en disco sin referenciar (forma exacta del bug: customers)', () => {
  const m = mod(
    ['migrations/sqlite/001_init.sql', 'migrations/postgres/001_init.sql'],
    { sqlite: ['migrations/sqlite/001_init.sql'] },
  );
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /postgres/);
  assert.match(errors[0], /001_init\.sql/);
  m.clean();
});

test('FALLA: referencia parcial (forma exacta del bug: invoice, 002 sin 001)', () => {
  const m = mod(
    [
      'migrations/sqlite/001_init.sql',
      'migrations/sqlite/002_add.sql',
      'migrations/postgres/001_init.sql',
      'migrations/postgres/002_add.sql',
    ],
    {
      sqlite: ['migrations/sqlite/001_init.sql', 'migrations/sqlite/002_add.sql'],
      postgres: ['migrations/postgres/002_add.sql'],
    },
  );
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /migrations\/postgres\/001_init\.sql/);
  m.clean();
});

test('FALLA: el manifest referencia un fichero inexistente', () => {
  const m = mod(['migrations/sqlite/001_init.sql'], {
    sqlite: ['migrations/sqlite/001_init.sql', 'migrations/sqlite/002_missing.sql'],
  });
  const { errors } = checkMigrations(m.dir, m.manifest);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /002_missing\.sql/);
  assert.match(errors[0], /no existe/);
  m.clean();
});

test('WARNING (no error): un dialecto con migraciones y el otro sin ninguna (caso backup)', () => {
  const m = mod(['migrations/sqlite/001_init.sql'], {
    sqlite: ['migrations/sqlite/001_init.sql'],
  });
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /postgres/);
  m.clean();
});

test('PASA: módulo sin migraciones (ni en disco ni en manifest)', () => {
  const m = mod([], undefined);
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  m.clean();
});

test('ignora ficheros no-.sql dentro de migrations/<dialecto>/', () => {
  const m = mod(
    ['migrations/sqlite/001_init.sql', 'migrations/sqlite/README.txt'],
    { sqlite: ['migrations/sqlite/001_init.sql'] },
  );
  const { errors, warnings } = checkMigrations(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, 'solo el warning de paridad postgres');
  m.clean();
});
