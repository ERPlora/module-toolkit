// Guardarraíles PG (auditoría pm#16, 07-17). `node --test`.
//
// La familia que mató 4 P0 en Hub Cloud (QA sectorial 07-16): SQLite tolera lo que
// Postgres rechaza, y la suite local nunca lo vio. Tres reglas para que no vuelva:
//   1) Un fichero de `sql[]` de command/query = UN prepared statement. PG rechaza
//      multi-statement («cannot insert multiple commands») — inventory#20.
//   2) Un bind con `"type": "boolean"` en el schema NO puede ir crudo al SQL (las
//      columnas son INTEGER 0/1 por contrato §2.5 y PG no castea boolean→bigint) —
//      debe envolverse en CASE WHEN — verifactu#13.
//   3) En `ON CONFLICT … DO UPDATE SET`, la auto-referencia va CUALIFICADA
//      (`tabla.col`), sin cualificar es ambigua en PG — appointments#19.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPgCompat } from '../src/validate-pg.mjs';

function mod(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-pg-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return { dir, manifest };
}

test('regla 1: multi-statement en un fichero de command = error (migraciones exentas)', () => {
  const { dir, manifest } = mod({
    'commands/two.sql': 'UPDATE t SET a = 1;\nINSERT INTO m (x) VALUES (1);',
    'commands/one.sql': 'UPDATE t SET a = 1;',
    'migrations/sqlite/001.sql': 'CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);',
  }, {
    migrations: { sqlite: ['migrations/sqlite/001.sql'] },
    commands: { 'm.two': { sql: ['commands/two.sql'] }, 'm.one': { sql: ['commands/one.sql'] } },
  });
  const f = checkPgCompat(dir, manifest);
  assert.equal(f.filter((x) => x.rule === 'multi-statement').length, 1);
  assert.match(f[0].message, /two\.sql/);
});

test('regla 2: bind boolean crudo en SQL = error; envuelto en CASE WHEN pasa', () => {
  const { dir, manifest } = mod({
    'schemas/s.json': JSON.stringify({ type: 'object', properties: {
      ok_flag: { type: 'boolean' }, bad_flag: { type: 'boolean' }, texto: { type: 'string' } } }),
    'commands/c.sql': "UPDATE t SET a = CASE WHEN :ok_flag THEN 1 WHEN NOT :ok_flag THEN 0 END, b = :bad_flag, c = :texto;",
  }, { commands: { 'm.c': { schema: 'schemas/s.json', sql: ['commands/c.sql'] } } });
  const f = checkPgCompat(dir, manifest).filter((x) => x.rule === 'boolean-bind');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /bad_flag/);
});

test('regla 2 no aplica a commands con handler WASM (el guest convierte)', () => {
  const { dir, manifest } = mod({
    'schemas/s.json': JSON.stringify({ type: 'object', properties: { flag: { type: 'boolean' } } }),
  }, { commands: { 'm.w': { schema: 'schemas/s.json', handler: { type: 'wasm', file: 'x', function: 'f' } } } });
  assert.equal(checkPgCompat(dir, manifest).length, 0);
});

test('regla 3: auto-referencia sin cualificar en DO UPDATE = error; cualificada o excluded pasa', () => {
  const { dir, manifest } = mod({
    'commands/bad.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = n + 1;',
    'commands/good.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = c.n + 1, m = excluded.m;',
  }, { commands: { 'm.b': { sql: ['commands/bad.sql'] }, 'm.g': { sql: ['commands/good.sql'] } } });
  const f = checkPgCompat(dir, manifest).filter((x) => x.rule === 'onconflict-unqualified');
  assert.equal(f.length, 1);
  assert.match(f[0].message, /bad\.sql/);
});
