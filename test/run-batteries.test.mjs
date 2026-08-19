// The module's OWN test batteries, run by the shared gate (module-toolkit#50). `node --test`.
//
// WHY THIS EXISTS. `services`, `staff` and `schedules` already carry batteries — contract checks
// and real-Postgres checks — that NOBODY runs in CI: the shared gate only ran `erplora validate`.
// They are written, they pass on the author's machine, and from there on only whoever remembers
// runs them. A change that breaks one merges green.
//
// 🔴 THE TRAP THIS SUITE EXISTS FOR. Every `*.postgres.test.py` returns **0** when the Postgres
// container is not reachable — it prints «SKIPPED: the test Postgres container is not running» and
// exits clean. Wiring them into the gate without noticing that would buy a row of green ticks that
// prove NOTHING, which is worse than not running them: it is the same failure as a battery nobody
// runs, wearing a passing badge. So «exit 0» is not the contract here; «it actually ran» is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverBatteries,
  looksSkipped,
  pgContainerVars,
  runBatteries,
} from '../src/run-batteries.mjs';

/** Is there a real python3 here? The batteries are python; nothing is faked to pretend otherwise. */
const PYTHON = spawnSync('python3', ['--version']).status === 0;

/** A throwaway module: `{ relative path → contents }`, plus a manifest id. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-batteries-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(dir, rel), body);
    chmodSync(join(dir, rel), 0o755);
  }
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  return { dir, manifest: { id, name: id, version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const GREEN = 'import sys\nprint("✓ all checks passed")\nsys.exit(0)\n';
const RED = 'import sys\nprint("✗ 1 failure(s)")\nsys.exit(1)\n';
const SKIPS_ITSELF =
  'import sys\nprint("SKIPPED: the test Postgres container is not running (erplora-test-pg-5433)")\nsys.exit(0)\n';
const ECHOES_ENV = 'import os, sys\nprint(os.environ.get("DEMO_TEST_PG_CONTAINER", "unset"))\nsys.exit(0)\n';

// ── Descubrimiento ───────────────────────────────────────────────────────────────────

test('discoverBatteries: clasifica por sufijo y deja fuera lo que no es una batería', () => {
  const m = mod({
    'tests/manifest.contract.test.py': GREEN,
    'tests/schemas.contract.test.py': GREEN,
    'tests/engine.postgres.test.py': GREEN,
    'tests/pg_harness.py': '# plumbing, no es una batería\n',
    'ui/components/x/x.test.ts': '// vitest, no se corre aquí\n',
  });
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: ['tests/manifest.contract.test.py', 'tests/schemas.contract.test.py'],
    postgres: ['tests/engine.postgres.test.py'],
  });
  m.clean();
});

test('discoverBatteries: un módulo sin `tests/` no cambia nada', () => {
  const m = mod({});
  assert.deepEqual(discoverBatteries(m.dir), { contract: [], postgres: [] });
  m.clean();
});

// ── El contenedor: el harness lo lee de una variable POR MÓDULO ──────────────────────

test('pgContainerVars: deriva `<ID>_TEST_PG_CONTAINER` del id del manifest', () => {
  assert.deepEqual(pgContainerVars('cash_register', 'pg-123'), {
    CASH_REGISTER_TEST_PG_CONTAINER: 'pg-123',
    ERPLORA_TEST_PG_CONTAINER: 'pg-123',
  });
});

// ── 🔴 El positivo que hay que detectar: la batería que se salta a sí misma ──────────

test('looksSkipped: reconoce el «SKIPPED» del harness', () => {
  assert.equal(looksSkipped('SKIPPED: the test Postgres container is not running'), true);
  assert.equal(looksSkipped('✓ engine.postgres: all checks passed'), false);
});

test('una batería que se SALTA sola es un FALLO, no un verde', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/engine.postgres.test.py': SKIPS_ITSELF });
  const { errors } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /engine\.postgres\.test\.py/);
  assert.match(errors[0], /salt|SKIP/i);
  m.clean();
});

// ── Correr de verdad ─────────────────────────────────────────────────────────────────

test('PASA: baterías en verde', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/manifest.contract.test.py': GREEN, 'tests/engine.postgres.test.py': GREEN });
  const { errors, results } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.deepEqual(errors, []);
  assert.equal(results.filter((r) => r.ran).length, 2);
  m.clean();
});

test('FALLA: una batería en rojo nombra el fichero', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/manifest.contract.test.py': RED });
  const { errors } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /manifest\.contract\.test\.py/);
  m.clean();
});

test('el contenedor llega a la batería por su variable', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/engine.postgres.test.py': ECHOES_ENV });
  const { results } = runBatteries(m.dir, m.manifest, { container: 'pg-abc' });
  assert.match(results[0].output, /pg-abc/);
  m.clean();
});

test('sin contenedor las de Postgres NO se corren, y se dice (no se dan por buenas)', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/manifest.contract.test.py': GREEN, 'tests/engine.postgres.test.py': GREEN });
  const { errors, results, notRun } = runBatteries(m.dir, m.manifest, { container: null });
  assert.deepEqual(errors, []);
  assert.equal(results.filter((r) => r.ran).length, 1, 'la de contrato sí corre: no necesita servicios');
  assert.equal(notRun.length, 1);
  assert.match(notRun[0], /engine\.postgres\.test\.py/);
  m.clean();
});

test('sin intérprete de Python es un ERROR, nunca un verde silencioso', () => {
  const m = mod({ 'tests/manifest.contract.test.py': GREEN });
  const { errors } = runBatteries(m.dir, m.manifest, { python: 'python3-que-no-existe' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /python/i);
  m.clean();
});

test('un módulo sin baterías no dice nada y no falla', () => {
  const m = mod({});
  const { errors, results, notRun } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.deepEqual(errors, []);
  assert.deepEqual(results, []);
  assert.deepEqual(notRun, []);
  m.clean();
});
