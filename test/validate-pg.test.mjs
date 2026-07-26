// Guardarraíles PG (auditoría pm#16, 07-17; actualizados tras ADR-0154 + hub#210).
//
// La familia que mató 4 P0 en Hub Cloud (QA sectorial 07-16) sigue vigente para lo que es
// puramente de Postgres. PERO la regla de "booleans" cambió de raíz: desde ADR-0154 el runtime
// COERCIONA en un punto central `Json::Bool` → INTEGER 0/1 (hub#210), así que un bind boolean
// va DIRECTO al SQL (`:flag`). El patrón que antes recomendábamos —`CASE WHEN :flag THEN 1
// WHEN NOT :flag THEN 0 END`— ahora ROMPE en PG: el bind llega como bigint 0/1 y `CASE WHEN
// <bigint>` es «argument of WHEN must be type boolean». Por eso invertimos la regla: el CASE
// WHEN sobre un param es un WARNING de patrón obsoleto, y el bind crudo ya no se toca.
//
// Reglas (léxicas, sin parser AST — misma filosofía que validate-sql.mjs):
//   1) multi-statement           ERROR   — un fichero de `sql[]` = UN prepared statement (inventory#28)
//   2) onconflict-unqualified     ERROR   — auto-referencia sin cualificar en DO UPDATE (appointments#19)
//   3) boolean-case-obsolete      WARNING — `CASE WHEN :param THEN …` obsoleto (ADR-0154; hub#210)
//   4) null-untyped               WARNING — `:param IS NULL` sin tipo → posible 42P08 (tables#20)
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

function byRule(findings, rule) {
  return findings.filter((f) => f.rule === rule);
}

test('regla 1: multi-statement en un fichero de command = ERROR (migraciones exentas)', () => {
  const { dir, manifest } = mod({
    'commands/two.sql': 'UPDATE t SET a = 1;\nINSERT INTO m (x) VALUES (1);',
    'commands/one.sql': 'UPDATE t SET a = 1;',
    // Post ADR-0154 solo hay migraciones postgres; y aun así el escáner NO mira migraciones.
    'migrations/postgres/001.sql': 'CREATE TABLE a (x INTEGER);\nCREATE TABLE b (y INTEGER);',
  }, {
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'm.two': { sql: ['commands/two.sql'] }, 'm.one': { sql: ['commands/one.sql'] } },
  });
  const f = checkPgCompat(dir, manifest);
  const ms = byRule(f, 'multi-statement');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].level, 'error');
  assert.match(ms[0].message, /two\.sql/);
});

test('regla 2: auto-referencia sin cualificar en DO UPDATE = ERROR; cualificada o excluded pasa', () => {
  const { dir, manifest } = mod({
    'commands/bad.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = n + 1;',
    'commands/good.sql': 'INSERT INTO c (k, n) VALUES (:k, 1)\nON CONFLICT (k) DO UPDATE SET n = c.n + 1, m = excluded.m;',
  }, { commands: { 'm.b': { sql: ['commands/bad.sql'] }, 'm.g': { sql: ['commands/good.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'onconflict-unqualified');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'error');
  assert.match(f[0].message, /bad\.sql/);
});

test('regla 3: `CASE WHEN :param THEN …` = WARNING de patrón OBSOLETO (ADR-0154; el runtime coerciona)', () => {
  const { dir, manifest } = mod({
    'commands/c.sql': 'UPDATE t SET a = CASE WHEN :ok_flag THEN 1 WHEN NOT :ok_flag THEN 0 END;',
  }, { commands: { 'm.c': { sql: ['commands/c.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'boolean-case-obsolete');
  assert.ok(f.length >= 1, 'debe avisar del CASE WHEN sobre param');
  assert.equal(f[0].level, 'warning');
  assert.match(f[0].message, /obsolet|directo|coerc/i);
});

test('regla 3 (inversa): un bind boolean CRUDO ya es correcto — NO se marca', () => {
  // Esto es EXACTAMENTE lo que la regla vieja marcaba como error y recomendaba envolver.
  // Post-coerción es lo correcto: el runtime baja `true`→1 antes de tocar PG.
  const { dir, manifest } = mod({
    'commands/c.sql': 'UPDATE t SET is_active = :active, name = :name WHERE id = :id;',
  }, { commands: { 'm.c': { sql: ['commands/c.sql'] } } });
  const f = checkPgCompat(dir, manifest);
  assert.equal(f.length, 0, 'el bind boolean directo no debe generar ningún hallazgo');
});

test('regla 4: `:param IS NULL` sin tipo = WARNING (posible 42P08) con sugerencia de CAST', () => {
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT * FROM t WHERE (:filter IS NULL OR name = :filter) ORDER BY name;',
  }, { queries: { 'm.q': { sql: ['queries/q.sql'] } } });
  const f = byRule(checkPgCompat(dir, manifest), 'null-untyped');
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'warning');
  assert.match(f[0].message, /42P08|CAST|::/i);
  assert.match(f[0].message, /filter/);
});

test('regla 4: `col IS NULL` (columna, no param) NO se marca', () => {
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT * FROM t WHERE deleted_at IS NULL;',
  }, { queries: { 'm.q': { sql: ['queries/q.sql'] } } });
  assert.equal(byRule(checkPgCompat(dir, manifest), 'null-untyped').length, 0);
});
