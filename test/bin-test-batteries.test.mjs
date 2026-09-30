// `erplora test <dir>` from the CLI — the door the shared gate calls (module-toolkit#50).
//
// It runs through `bin/erplora.mjs` on purpose, and with NO node_modules: the gate of the 25 module
// repos runs the CLI on a runner where `npm install` is impossible (three dependencies are `file:`
// paths into sibling checkouts). A `test` command that pulled esbuild or lit at import time would
// die with ERR_MODULE_NOT_FOUND before running a single battery, which is exactly what the lazy
// imports in the CLI exist to avoid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
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

// ── module-toolkit#55 ────────────────────────────────────────────────────────────────────────

test('`--list` enumerates what WILL run, one path per line', () => {
  // The composite action used to detect batteries with its own `ls` of the two suffixes — a second
  // implementation of the discovery rule, in YAML, guaranteed to drift from this one. It asks the
  // toolkit now, and this is the door it asks through.
  const m = mod({
    'tests/manifest.contract.test.py': 'import sys\n',
    'tests/anonymize.pg.test.py': 'import sys\n',
    'tests/pg_harness.py': '# imported by anonymize.pg.test.py\n',
  });
  const r = spawnSync(process.execPath, [BIN, 'test', m.dir, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n').filter(Boolean).sort();
  assert.deepEqual(lines, ['tests/anonymize.pg.test.py', 'tests/manifest.contract.test.py']);
  m.clean();
});

test('`--list` de un módulo sin baterías no imprime nada y sale en 0', () => {
  const m = mod({});
  const r = spawnSync(process.execPath, [BIN, 'test', m.dir, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout.trim(), '');
  m.clean();
});

test('un test que NADIE va a ejecutar tumba el comando', () => {
  const m = mod({ 'tests/forgotten_check.py': 'import sys\nsys.exit(0)\n' });
  const r = run(m.dir);
  assert.equal(r.status, 1, 'un test invisible es peor que no tener test');
  assert.match(r.stdout + r.stderr, /forgotten_check\.py/);
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

// ── module-toolkit#417 ───────────────────────────────────────────────────────────────────────

const REAL_PYTHON = (() => {
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 10) else None'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() && r.stdout.trim() !== 'None' ? r.stdout.trim() : null;
})();

test('en un Mac con el `python3` 3.9 del sistema DELANTE, la suite corre con el que llega y lo dice', { skip: !REAL_PYTHON && 'no hay python ≥3.10' }, () => {
  // The PATH a fleet session had: `python3` is the Command Line Tools 3.9 and the good one only
  // answers to its versioned name. Before #417 every battery with `str | None` went red here.
  const m = mod({
    'tests/union.contract.test.py': 'import sys\ndef f(a: str | None = None) -> str | None:\n    return a\nsys.exit(0)\n',
  });
  const bin = mkdtempSync(join(tmpdir(), 'erplora-bin-python-'));
  writeFileSync(
    join(bin, 'python3'),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.9.6"; exit 0; fi\n' +
      'echo "TypeError: unsupported operand type(s) for |" >&2\nexit 1\n',
  );
  chmodSync(join(bin, 'python3'), 0o755);
  symlinkSync(REAL_PYTHON, join(bin, 'python3.12'));
  const env = { ...process.env, PATH: bin };
  delete env.ERPLORA_PYTHON;
  const r = spawnSync(process.execPath, [BIN, 'test', m.dir], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /python3\.12/, 'dice con qué intérprete corrió');
  assert.match(r.stdout + r.stderr, /3\.9\.6/, 'y cuál se saltó');
  rmSync(bin, { recursive: true, force: true });
  m.clean();
});
