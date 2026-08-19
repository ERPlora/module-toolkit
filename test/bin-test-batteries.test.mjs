// `erplora test <dir>` from the CLI — the door the shared gate calls (module-toolkit#50).
//
// It runs through `bin/erplora.mjs` on purpose, and with NO node_modules: the gate of the 25 module
// repos runs the CLI on a runner where `npm install` is impossible (three dependencies are `file:`
// paths into sibling checkouts). A `test` command that pulled esbuild or lit at import time would
// die with ERR_MODULE_NOT_FOUND before running a single battery, which is exactly what the lazy
// imports in the CLI exist to avoid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'erplora.mjs');
const PYTHON = spawnSync('python3', ['--version']).status === 0;

function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-bin-batteries-'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (dir, env = {}) =>
  spawnSync(process.execPath, [BIN, 'test', dir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });

test('un módulo sin baterías sale en verde y lo dice', () => {
  const m = mod({});
  const r = run(m.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /sin baterías|0 batería/i);
  m.clean();
});

test('una batería en rojo hace fallar el comando', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/manifest.contract.test.py': 'import sys\nsys.exit(1)\n' });
  const r = run(m.dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /manifest\.contract\.test\.py/);
  m.clean();
});

test('sin contenedor, las de Postgres se declaran NO CORRIDAS (no pasan por buenas)', { skip: !PYTHON && 'no hay python3' }, () => {
  const m = mod({ 'tests/engine.postgres.test.py': 'import sys\nsys.exit(0)\n' });
  const r = run(m.dir, { ERPLORA_TEST_PG_CONTAINER: '' });
  assert.equal(r.status, 0, 'no correrlas no es un fallo del módulo');
  assert.match(r.stdout + r.stderr, /engine\.postgres\.test\.py/);
  assert.match(r.stdout + r.stderr, /no se ha corrido/i);
  m.clean();
});

test('la CLI honra `ERPLORA_PYTHON` (el gate corre un venv con jsonschema)', { skip: !PYTHON && 'no hay python3' }, () => {
  // `tests/schemas.contract.test.py` de `services`, `staff` y `schedules` NECESITA `jsonschema` y
  // se NIEGA a saltarse («skipping would turn a validation test into a green light for nothing»),
  // así que el gate tiene que darle un intérprete que lo tenga. Que el binario sea elegible es lo
  // que permite pasarle un venv sin tocar los 25 repos.
  const m = mod({ 'tests/manifest.contract.test.py': 'import sys\nsys.exit(0)\n' });
  const r = run(m.dir, { ERPLORA_PYTHON: 'python3-que-no-existe' });
  assert.equal(r.status, 1, 'si el intérprete elegido no existe, falla — no cae a otro en silencio');
  assert.match(r.stdout + r.stderr, /python3-que-no-existe/);
  m.clean();
});
