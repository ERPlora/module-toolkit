// Tests del andamiado de módulos. `node --test`.
//
// Bug 2026-07-05: `g module` generaba SOLO la migración de sqlite → los módulos nacían sin
// `migrations.postgres` y en hubs Cloud instalaban sin migrar. El scaffold debe generar
// AMBOS dialectos (el SQL inicial es el subconjunto portable, mismo contenido) y
// referenciarlos en el manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../src/scaffold.mjs';
import { checkMigrations } from '../src/validate-migrations.mjs';

test('g module genera migración de AMBOS dialectos y las referencia en el manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-scaffold-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await generate('module', 'demo_mod');
    const dir = join(root, 'demo_mod');

    assert.ok(existsSync(join(dir, 'migrations/sqlite/001_init.sql')), 'migración sqlite');
    assert.ok(existsSync(join(dir, 'migrations/postgres/001_init.sql')), 'migración postgres');

    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
    assert.deepEqual(manifest.migrations, {
      sqlite: ['migrations/sqlite/001_init.sql'],
      postgres: ['migrations/postgres/001_init.sql'],
    });

    // El módulo recién andamiado pasa el gate de paridad (sin errores ni warnings).
    const { errors, warnings } = checkMigrations(dir, manifest);
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});
