// module-toolkit#135: validate debe verificar que el handler WASM es reproducible desde el source.
//
// Regresión de ERPlora/services#11: un módulo pasaba `erplora validate` con un `dist/handler.wasm`
// cuyo source actual NO compilaba (referenciaba `round_cents`, que no existía), y el runtime
// ejecutaba el wasm viejo. El validador comprobaba manifest/SQL/contratos/bundle, pero NO que el
// wasm se generase desde el source presente.
//
// Estos tests cubren la LÓGICA de detección (qué se comprueba y qué no) sin invocar `cargo`, que
// es lento y depende de la toolchain. La compilación real de un handler sano la cubre `npm run
// smoke` (build de inventory/sales, que tienen handler/ real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWasmHandler } from '../src/validate.mjs';

function mod(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, manifest };
}

test('módulo sin handler WASM → checked:false, sin errores ni warnings', () => {
  const { dir, manifest } = mod(
    { 'commands/insert.sql': 'INSERT INTO t (x) VALUES (1);' },
    { commands: { 'm.insert': { sql: ['commands/insert.sql'] } } },
  );
  const r = checkWasmHandler(dir, manifest);
  assert.equal(r.checked, false);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('handler WASM declarado PERO sin handler/Cargo.toml → warning (no bloquea)', () => {
  // El bug: un dist/handler.wasm sin source no se puede verificar que corresponda al commit.
  const { dir, manifest } = mod(
    { 'commands/create.sql': 'INSERT INTO t (x) VALUES (1);' },
    {
      commands: {
        'm.create': {
          sql: ['commands/create.sql'],
          handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'create' },
        },
      },
    },
  );
  const r = checkWasmHandler(dir, manifest);
  assert.equal(r.checked, false);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /handler\/Cargo\.toml/);
});
