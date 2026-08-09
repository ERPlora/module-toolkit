// module-toolkit#135: validate must verify that the WASM handler is reproducible from its source.
//
// Regression of ERPlora/services#11: a module passed `erplora validate` with a `dist/handler.wasm`
// whose current source did NOT compile (it referenced `round_cents`, which did not exist), and the
// runtime kept executing the old wasm. The validator checked manifest/SQL/contracts/bundle, but not
// that the wasm came from the source at hand.
//
// These tests cover the DETECTION logic (what is checked and what is not) without invoking `cargo`,
// which is slow and toolchain-dependent. A real healthy handler build is covered by `npm run smoke`
// (build of inventory/sales, which have a real handler/).
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

const wasmManifest = {
  commands: {
    'm.create': {
      sql: ['commands/create.sql'],
      handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'create' },
    },
  },
};

test('module with no WASM handler → checked:false, no errors, no warnings', () => {
  const { dir, manifest } = mod(
    { 'commands/insert.sql': 'INSERT INTO t (x) VALUES (1);' },
    { commands: { 'm.insert': { sql: ['commands/insert.sql'] } } },
  );
  const r = checkWasmHandler(dir, manifest);
  assert.equal(r.checked, false);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test('WASM handler declared BUT no handler/Cargo.toml → warning (does not block)', () => {
  // The bug: a dist/handler.wasm with no source cannot be shown to match the commit.
  const { dir, manifest } = mod({ 'commands/create.sql': 'INSERT INTO t (x) VALUES (1);' }, wasmManifest);
  const r = checkWasmHandler(dir, manifest);
  assert.equal(r.checked, false);
  assert.deepEqual(r.errors, []);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /handler\/Cargo\.toml/);
});

test('no checkout of ERPlora/hub → says so OUT LOUD instead of blaming the module (pm#107)', () => {
  // The 21 modules with a handler depend on the hub's guest-sdk BY RELATIVE PATH
  // (`../../../../hub/crates/guest-sdk`). On a CI runner there is no hub checkout, so `cargo` fails
  // for a reason that has nothing to do with the module — which is exactly what produced the false
  // positives of the pm#107 sweep (invoice/sales/taxes "broken" because the local hub checkout sat
  // on a branch older than hub#423). A gate that reports someone else's missing checkout as "your
  // handler does not compile" is a gate that lies, so this is detected BEFORE running cargo.
  const { dir, manifest } = mod(
    {
      'commands/create.sql': 'INSERT INTO t (x) VALUES (1);',
      'handler/Cargo.toml':
        '[package]\nname = "m-handler"\nversion = "0.1.0"\nedition = "2021"\n\n' +
        '[dependencies]\nerplora-guest-sdk = { path = "../../../../hub/crates/guest-sdk" }\n',
      'handler/src/lib.rs': 'pub fn create() {}\n',
    },
    wasmManifest,
  );
  const r = checkWasmHandler(dir, manifest);
  assert.equal(r.checked, false, 'nothing was verified');
  assert.equal(r.unverified, true, 'the caller must be able to say it out loud in the summary');
  assert.deepEqual(r.errors, [], 'a missing checkout is not the module being broken');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /hub\/crates\/guest-sdk/);
  assert.match(r.warnings[0], /ERPlora\/hub/);
  assert.match(r.warnings[0], /NO se ha verificado/i);
});

test('a path dependency that DOES exist is not mistaken for a missing checkout', () => {
  const { dir, manifest } = mod(
    {
      'commands/create.sql': 'INSERT INTO t (x) VALUES (1);',
      'handler/Cargo.toml':
        '[package]\nname = "m-handler"\nversion = "0.1.0"\nedition = "2021"\n\n' +
        '[dependencies]\nlocal-dep = { path = "../local-dep" }\n',
      'handler/src/lib.rs': 'pub fn create() {}\n',
      'local-dep/Cargo.toml': '[package]\nname = "local-dep"\nversion = "0.1.0"\nedition = "2021"\n',
      'local-dep/src/lib.rs': '',
    },
    wasmManifest,
  );
  const r = checkWasmHandler(dir, manifest, { runCargo: false });
  assert.notEqual(r.unverified, true, 'the dependency is right there: nothing to complain about');
  assert.deepEqual(r.warnings, []);
});
