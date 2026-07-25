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
