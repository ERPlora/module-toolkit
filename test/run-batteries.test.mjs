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
  migrationFilesVar,
  runBatteries,
  strayTestFiles,
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
    hub: [],
  });
  m.clean();
});

test('discoverBatteries: un módulo sin `tests/` no cambia nada', () => {
  const m = mod({});
  assert.deepEqual(discoverBatteries(m.dir), { contract: [], postgres: [], hub: [] });
  m.clean();
});

// ── El contenedor: el harness lo lee de una variable POR MÓDULO ──────────────────────

// ── Las migraciones YA RESUELTAS: la batería no tiene que releer el manifest ─────────

test('migrationFilesVar: entrega las rutas ya resueltas, una por línea', () => {
  assert.deepEqual(
    migrationFilesVar({
      migrations: {
        postgres: [
          'migrations/postgres/001_init.sql',
          { file: 'migrations/postgres/008_retire.sql', kind: 'contract', since: '1.1.63' },
        ],
      },
    }),
    { ERPLORA_MIGRATION_FILES: 'migrations/postgres/001_init.sql\nmigrations/postgres/008_retire.sql' },
  );
});

test('migrationFilesVar: un módulo sin migraciones entrega la lista VACÍA, no la variable ausente', () => {
  // Ausente y vacía no significan lo mismo: con la variable puesta la batería sabe que `erplora
  // test` la resolvió y que no hay ninguna; sin ella tendría que decidir si volver al manifest.
  assert.deepEqual(migrationFilesVar({ id: 'demo' }), { ERPLORA_MIGRATION_FILES: '' });
});

test('runBatteries: cada batería recibe las migraciones resueltas en el entorno', { skip: !PYTHON }, () => {
  const m = mod({
    'tests/shape.contract.test.py':
      'import os, sys\nprint(os.environ.get("ERPLORA_MIGRATION_FILES", "unset"))\nsys.exit(0)\n',
  });
  const manifest = {
    ...m.manifest,
    migrations: {
      postgres: [
        'migrations/postgres/001_init.sql',
        { file: 'migrations/postgres/008_retire.sql', kind: 'contract' },
      ],
    },
  };
  const { results } = runBatteries(m.dir, manifest);
  assert.equal(results.length, 1);
  assert.equal(
    results[0].output.trim(),
    'migrations/postgres/001_init.sql\nmigrations/postgres/008_retire.sql',
    'la forma objeto llega ya normalizada: es lo que evita el TypeError de module-toolkit#180',
  );
  m.clean();
});

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

// 🔴 module-toolkit#57 — and the SECOND half of the same question: skipped WHAT?
//
// The batteries print two different things with the same word, and the difference is the
// indentation, on purpose:
//
//   `SKIPPED: no Postgres in container …`         at column 0 — the WHOLE battery skipped itself,
//                                                  nothing was verified. This is the lie #50 exists
//                                                  to catch.
//   `  SKIPPED: cargo metadata --locked (no …)`   indented under its `·` section — ONE sub-check of
//                                                  a battery that ran and passed everything else.
//
// The first regex swallowed the indentation (`^\s*SKIPPED:`), so it read the second as the first.
// Measured on a runner-shaped checkout (no `hub/` next to the module, which is EVERY CI run):
// `staff` and `schedules` fail their gate on `manifest.contract.test.py` — a battery whose last
// line is «✓ manifest.contract: all checks passed». A false red is not a smaller problem than a
// false green: it is what teaches everybody to merge past this gate.
test('looksSkipped: un sub-chequeo saltado (indentado) NO es la batería saltándose sola', () => {
  const partial = [
    '· the WASM build: fresh, and pinned by a lockfile',
    '  ok: dist/handler.wasm is the binary build.json describes',
    '  SKIPPED: cargo metadata --locked (no guest-sdk checkout at /x/hub/crates/guest-sdk)',
    '✓ manifest.contract: all checks passed',
  ].join('\n');
  assert.equal(looksSkipped(partial), false);
});

test('looksSkipped: la batería que se salta ENTERA sigue detectándose (control de positivo)', () => {
  // Exactly what `tasks/tests/insert_task.pg.test.py` prints, and its whole output.
  assert.equal(
    looksSkipped('SKIPPED: no Postgres in container nope (nothing was verified)\n'),
    true,
  );
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

// ── 🔴 module-toolkit#55: a battery is one because of WHAT IT IS, not what it is called ──────
//
// The two exact suffixes of #50 left 20 files across 7 modules invisible — `.pg.test.py` in
// `customers`/`reservations`/`pricing`/`tasks`/`whatsapp_inbox`, no family suffix at all in
// `cash_register`, and two bash batteries in `taxes`. They existed, they passed on the author's
// machine, and a change that broke one merged green: the same hole #50 was written to close,
// reopened by a naming convention nobody could enforce.

test('discoverBatteries: `.pg.test.py` is a Postgres battery, like `.postgres.test.py`', () => {
  const m = mod({
    'tests/anonymize.pg.test.py': GREEN,
    'tests/engine.postgres.test.py': GREEN,
  });
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: [],
    postgres: ['tests/anonymize.pg.test.py', 'tests/engine.postgres.test.py'],
    hub: [],
  });
  m.clean();
});

test('discoverBatteries: a `*.test.py` with NO family suffix is still a battery', () => {
  const m = mod({ 'tests/blind_count.test.py': GREEN });
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: ['tests/blind_count.test.py'],
    postgres: [],
    hub: [],
  });
  m.clean();
});

test('discoverBatteries: the CONTENT decides when the name does not say it', () => {
  // `cash_register/tests/auto_close.test.py`: no `.pg.`/`.postgres.` anywhere in the name, and it
  // reads `CASH_REGISTER_TEST_PG_CONTAINER`. Classified as contract it would run with no container
  // handed over, skip itself, and — with the guarantee of #50 — be reported as a FAILURE.
  const m = mod(
    { 'tests/auto_close.test.py': 'import os\nCONTAINER = os.environ["DEMO_TEST_PG_CONTAINER"]\n' },
    'demo',
  );
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: [],
    postgres: ['tests/auto_close.test.py'],
    hub: [],
  });
  m.clean();
});

test('discoverBatteries: bash batteries count too (`taxes` ships two)', () => {
  const m = mod({ 'tests/natural-key.postgres.test.sh': '#!/usr/bin/env bash\nexit 0\n' });
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: [],
    postgres: ['tests/natural-key.postgres.test.sh'],
    hub: [],
  });
  m.clean();
});

test('discoverBatteries: looks into subdirectories, and never into `__pycache__`', () => {
  const m = mod({
    'tests/pg/engine.postgres.test.py': GREEN,
    'tests/__pycache__/engine.postgres.test.py': GREEN,
  });
  assert.deepEqual(discoverBatteries(m.dir), {
    contract: [],
    postgres: ['tests/pg/engine.postgres.test.py'],
    hub: [],
  });
  m.clean();
});

test('PASA: una batería `.sh` se corre de verdad', () => {
  const m = mod({ 'tests/shape.postgres.test.sh': '#!/usr/bin/env bash\necho "✓ ok"\n' });
  const { errors, results } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.deepEqual(errors, []);
  assert.equal(results.filter((r) => r.ran).length, 1);
  m.clean();
});

test('FALLA: una batería `.sh` en rojo nombra el fichero', () => {
  const m = mod({ 'tests/shape.postgres.test.sh': '#!/usr/bin/env bash\nexit 3\n' });
  const { errors } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /shape\.postgres\.test\.sh/);
  m.clean();
});

// ── 🔴 The alarm that stops the relapse ──────────────────────────────────────────────────────
//
// Widening the pattern fixes today's 20 files; it does not stop the 21st from being born with a
// name nobody thought of. So anything under `tests/` that will NOT be executed has to be said out
// loud. A harness — a `.py` another battery imports — is not a stray: it runs inside the battery.

test('strayTestFiles: a file under tests/ that nothing will ever run is reported', () => {
  const m = mod({
    'tests/engine.postgres.test.py': GREEN,
    'tests/forgotten_check.py': 'import sys\nsys.exit(1)\n',
  });
  assert.deepEqual(strayTestFiles(m.dir), ['tests/forgotten_check.py']);
  m.clean();
});

test('strayTestFiles: a harness imported by a battery is NOT a stray', () => {
  const m = mod({
    'tests/pg_harness.py': 'def connect():\n    pass\n',
    'tests/engine.postgres.test.py': 'import pg_harness\nprint("✓")\n',
  });
  assert.deepEqual(strayTestFiles(m.dir), []);
  m.clean();
});

test('strayTestFiles: `__init__.py`, `conftest.py` and `__pycache__` are plumbing, not strays', () => {
  const m = mod({
    'tests/engine.postgres.test.py': GREEN,
    'tests/__init__.py': '',
    'tests/conftest.py': '# pytest plumbing\n',
    'tests/__pycache__/whatever.py': '# byte-compiled\n',
  });
  assert.deepEqual(strayTestFiles(m.dir), []);
  m.clean();
});

test('runBatteries: a stray FAILS the gate, and says its name', () => {
  const m = mod({
    'tests/engine.postgres.test.py': GREEN,
    'tests/forgotten_check.py': GREEN,
  });
  const { errors } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /forgotten_check\.py/);
  m.clean();
});

test('runBatteries: un `tests/` con SOLO un huérfano tampoco pasa en silencio', () => {
  // The early return for «no batteries» is exactly where a lone invisible test would hide.
  const m = mod({ 'tests/forgotten_check.py': GREEN });
  const { errors } = runBatteries(m.dir, m.manifest, { container: 'pg-x' });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /forgotten_check\.py/);
  m.clean();
});
