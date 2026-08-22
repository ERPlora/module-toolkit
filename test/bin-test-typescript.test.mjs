// `erplora test <dir>` and the module's TYPESCRIPT tests — the door the shared gate calls
// (module-toolkit#74).
//
// Through `bin/erplora.mjs` and with NO node_modules, for the same reason as
// `bin-test-batteries.test.mjs`: the gate of the 25 module repos runs this CLI on a runner where
// `npm install` is impossible, so a `test` command that pulled a package at import time would die
// before listing a single file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'erplora.mjs');

function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-bin-ts-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const run = (dir, args = [], env = {}) =>
  spawnSync(process.execPath, [BIN, 'test', dir, ...args], {
    encoding: 'utf8',
    // ERPLORA_VITEST is inherited from the surrounding shell otherwise, and these cases are about
    // what the CLI does WITHOUT one.
    env: { ...process.env, ERPLORA_VITEST: '', ...env },
  });

/**
 * Puts an empty package where node would look for it. `happy-dom` is what vitest loads for
 * `environment`, so a module without it is reported as unrunnable — right in general, and it would
 * mask what the cases below are about.
 */
function stub(dir, ...packages) {
  for (const pkg of packages) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg }));
  }
}

/** A stand-in for vitest: this suite tests the CLI's contract, not vitest's behaviour. */
function fakeVitest(body) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-fake-vitest-'));
  const bin = join(dir, 'vitest.mjs');
  writeFileSync(bin, body);
  return { bin, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('`--list` enumera también los `.test.ts` — es lo que el gate lee para decidir', () => {
  // The composite action asks the toolkit what there is to run instead of re-implementing the
  // rule in YAML. Leaving the TypeScript tests out of `--list` is how they stayed invisible.
  const m = mod({
    'tests/manifest.contract.test.py': 'import sys\n',
    'ui/lib/quantity.test.ts': '',
    'ui/components/erp-demo-list/erp-demo-list.test.ts': '',
  });
  const r = run(m.dir, ['--list']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').sort(), [
    'tests/manifest.contract.test.py',
    'ui/components/erp-demo-list/erp-demo-list.test.ts',
    'ui/lib/quantity.test.ts',
  ]);
  m.clean();
});

test('un módulo SIN tests de TypeScript no cambia: verde, y sin pagar nada por ello', () => {
  const m = mod({});
  const r = run(m.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /vitest|TypeScript/i);
  m.clean();
});

test('un `.test.ts` que ningún patrón recoge tumba el comando', () => {
  // La red al revés, la misma que ya protege a `tests/`: un test invisible es peor que no tener
  // test.
  const m = mod({ 'src/helpers.test.ts': '' });
  const r = run(m.dir);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /src\/helpers\.test\.ts/);
  assert.match(r.stdout + r.stderr, /invisible/i);
  m.clean();
});

test('sin vitest al alcance se declaran SIN CORRER, y el gate sigue verde', () => {
  // Medido antes de escribirlo: correrlos necesita `@erplora/module-sdk`, que vive en un repo
  // PRIVADO y no está publicado. Convertir eso en error pondría los 25 repos en rojo por un
  // paquete que el módulo no puede aportar — y un gate que bloquea todo se apaga, no se obedece.
  const m = mod({ 'ui/lib/quantity.test.ts': '' });
  const r = run(m.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /sin correr/i);
  assert.match(r.stdout + r.stderr, /vitest/);
  m.clean();
});

test('un test de TypeScript en ROJO tumba el comando', () => {
  const v = fakeVitest("console.log('FAIL ui/lib/quantity.test.ts > suma');\nprocess.exit(1);\n");
  const m = mod({ 'ui/lib/quantity.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const r = run(m.dir, [], { ERPLORA_VITEST: v.bin });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /quantity\.test\.ts/);
  v.clean();
  m.clean();
});

test('en verde los cuenta y lo dice', () => {
  const v = fakeVitest('process.exit(0);\n');
  const m = mod({ 'ui/lib/a.test.ts': '', 'ui/lib/b.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const r = run(m.dir, [], { ERPLORA_VITEST: v.bin });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2/);
  v.clean();
  m.clean();
});

test('la CLI honra `ERPLORA_VITEST` (el gate instala su propio vitest)', () => {
  // Same door `ERPLORA_PYTHON` opens for the batteries: the gate prepares an installation and
  // hands it over, without touching the 25 module repos.
  const m = mod({ 'ui/lib/a.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const r = run(m.dir, [], { ERPLORA_VITEST: '/no/existe/vitest.mjs' });
  assert.equal(r.status, 1, 'si el binario elegido no existe, falla — no cae a otro en silencio');
  m.clean();
});
