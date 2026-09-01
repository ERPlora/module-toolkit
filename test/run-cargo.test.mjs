// The module's RUST batteries — the `#[cfg(test)] mod tests` of a Tier-2 handler, which until now
// NOBODY ran (module-toolkit#146).
//
// THE HOLE. `erplora validate` compiles the handler (`checkWasmHandler`, module-toolkit#135) and
// `erplora build` recompiles the wasm (#26), so the ARTEFACT is watched. What the artefact DOES was
// not: the handler's own unit tests — where the business logic of a Tier-2 module lives — were
// discovered by nothing and run by nothing. `erplora test` knew `tests/**/*.test.py|.sh` (#50/#55)
// and `ui/**/*.test.ts` (#74) and stopped there.
//
// It is the same shape as #50, #55 and #74, one family of tests further along, and it cost the same
// way: in ERPlora/kitchen#63 the whole bug was one line of the handler building a comanda header
// without `waiter_id`, and the three Rust tests that go from red to green with the fix run on the
// author's laptop and nowhere else. 21 modules carry a handler with tests.
//
// WHY IT COULD NOT RUN IN CI, AND WHAT CHANGED. The 22 handlers reach the hub's `erplora-guest-sdk`
// BY RELATIVE PATH (`../../../../hub/crates/guest-sdk`) — four levels up from `handler/`, a layout
// that only exists in the monorepo. There is no checkout of the private ERPlora/hub in a module
// repo and no credential to make one. But there IS one on the runner already: the composite action
// `ERPlora/hub/.github/actions/module-sdk` leaves the whole hub on disk to be resolvable at all, and
// this repository's own `ci.yml` has been deriving `ERPLORA_HUB_DIR` from it since #90. The farm
// below is what turns that checkout into the layout the relative path expects, without a token,
// without touching 22 `Cargo.toml`, and without writing a byte outside a scratch directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GUEST_SDK_CRATE,
  cargoAvailable,
  discoverRustTests,
  farmManifestPath,
  hubCheckout,
  runRustTests,
} from '../src/run-cargo.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'test/fixtures/handler-tests');

/** A throwaway module tree: `{ 'handler/src/lib.rs': '…' }` → a directory with those files. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-run-cargo-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  if (!files['module.json']) {
    writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  }
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The one line every real handler carries, pointing four levels up at the hub. */
const SDK_DEP = `${GUEST_SDK_CRATE} = { path = "../../../../hub/crates/guest-sdk" }`;

const CARGO_TOML = (name, deps = '') =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib", "rlib"]\n\n[dependencies]\n${deps}\n\n[workspace]\n`;

// ── discovery ────────────────────────────────────────────────────────────────────────────────

test('a module with no handler/ carries no Rust tests', () => {
  const m = mod({ 'ui/lib/a.test.ts': '' });
  try {
    assert.deepEqual(discoverRustTests(m.dir), []);
  } finally {
    m.clean();
  }
});

test('a handler with sources but NO `#[cfg(test)]` carries no Rust tests', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n',
  });
  try {
    assert.deepEqual(discoverRustTests(m.dir), []);
  } finally {
    m.clean();
  }
});

test('finds every handler source carrying `#[cfg(test)]`, at any depth, sorted and relative', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
    'handler/src/deep/nested.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
    'handler/src/plain.rs': 'pub fn f() {}\n',
  });
  try {
    assert.deepEqual(discoverRustTests(m.dir), ['handler/src/deep/nested.rs', 'handler/src/lib.rs']);
  } finally {
    m.clean();
  }
});

// 🔴 module-toolkit#55, one language further along: recognising a test by ONE exact pattern is how
// 20 files in 7 modules stayed invisible. Cargo compiles every top-level `.rs` in `handler/tests/`
// as its own integration-test target, and those files carry `#[test]` WITHOUT any `#[cfg(test)]` —
// there is nothing to gate them behind. `sales/handler/tests/complete_sale_harness.rs` is exactly
// that shape today: 3 `#[test]`, zero `#[cfg(test)]`. A module whose only Rust tests lived there
// would have had the whole family reported as «none», silently.
test('an integration test under `handler/tests/` counts, `#[cfg(test)]` or not', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': 'pub fn f() {}\n',
    'handler/tests/harness.rs': '#[test]\nfn it_works() {}\n',
  });
  try {
    assert.deepEqual(discoverRustTests(m.dir), ['handler/tests/harness.rs']);
  } finally {
    m.clean();
  }
});

test('a helper module under `handler/tests/` is not a test target and is not counted', () => {
  // Cargo only makes a target of the top level; `tests/common/mod.rs` is shared code the targets
  // import. Counting it would report a test that nothing runs — the mirror of `strayTestFiles`.
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/tests/common/mod.rs': 'pub fn helper() {}\n',
  });
  try {
    assert.deepEqual(discoverRustTests(m.dir), []);
  } finally {
    m.clean();
  }
});

test('`target/` is build output, never a source of tests', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/target/debug/build/x.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  });
  try {
    assert.deepEqual(discoverRustTests(m.dir), []);
  } finally {
    m.clean();
  }
});

// ── the hub checkout the relative path needs ─────────────────────────────────────────────────

test('`hubCheckout` takes ERPLORA_HUB_DIR only when the guest-sdk is really under it', () => {
  const good = mkdtempSync(join(tmpdir(), 'erplora-hub-'));
  const bad = mkdtempSync(join(tmpdir(), 'erplora-nothub-'));
  mkdirSync(join(good, 'crates/guest-sdk'), { recursive: true });
  writeFileSync(join(good, 'crates/guest-sdk/Cargo.toml'), '[package]\nname = "erplora-guest-sdk"\n');
  try {
    assert.equal(hubCheckout({ ERPLORA_HUB_DIR: good }), good);
    // A path that is not a hub is the same as no path: better no farm than a farm that lies.
    assert.equal(hubCheckout({ ERPLORA_HUB_DIR: bad }), null);
    assert.equal(hubCheckout({ ERPLORA_HUB_DIR: '' }), null);
    assert.equal(hubCheckout({}), null);
  } finally {
    rmSync(good, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('the farm puts the hub exactly where `../../../../hub/crates/guest-sdk` looks for it', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler', SDK_DEP),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  }, 'demo');
  const hub = mkdtempSync(join(tmpdir(), 'erplora-hub-'));
  const farm = mkdtempSync(join(tmpdir(), 'erplora-farm-'));
  mkdirSync(join(hub, 'crates/guest-sdk'), { recursive: true });
  writeFileSync(join(hub, 'crates/guest-sdk/Cargo.toml'), '[package]\nname = "erplora-guest-sdk"\n');
  try {
    const manifest = farmManifestPath(m.dir, hub, { root: farm, id: 'demo' });
    // The manifest is reached THROUGH the farm — a path cargo will not canonicalise away.
    assert.ok(manifest.startsWith(farm), `${manifest} is not inside ${farm}`);
    assert.ok(manifest.endsWith('/handler/Cargo.toml'));
    // The whole point, spelled out: the dependency's own relative path now resolves.
    const sdk = resolve(dirname(manifest), '../../../../hub/crates/guest-sdk');
    assert.ok(existsSync(join(sdk, 'Cargo.toml')), `${sdk} does not hold the guest-sdk`);
    assert.equal(realpathSync(sdk), realpathSync(join(hub, 'crates/guest-sdk')));
    // And the module's own files are still reachable by the relative path its tests `include_str!`.
    assert.equal(
      realpathSync(resolve(dirname(manifest), '../module.json')),
      realpathSync(join(m.dir, 'module.json')),
    );
  } finally {
    m.clean();
    rmSync(hub, { recursive: true, force: true });
    rmSync(farm, { recursive: true, force: true });
  }
});

// ── what does not run is NAMED, never green ──────────────────────────────────────────────────

test('a module with no Rust test reports nothing at all', () => {
  const m = mod({ 'ui/lib/a.test.ts': '' });
  try {
    const out = runRustTests(m.dir, { env: {} });
    assert.deepEqual(out, { results: [], errors: [], notRun: [] });
  } finally {
    m.clean();
  }
});

test('Rust tests whose guest-sdk is unreachable are NOT RUN, by name — never a silent pass', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler', SDK_DEP),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  });
  try {
    const out = runRustTests(m.dir, { env: {}, runCargo: () => assert.fail('cargo must not be spawned') });
    assert.equal(out.errors.length, 0, 'a laptop without the hub beside it is not a broken module');
    assert.equal(out.results.length, 0);
    assert.equal(out.notRun.length, 1);
    assert.match(out.notRun[0], /handler\/src\/lib\.rs/);
    assert.match(out.notRun[0], new RegExp(GUEST_SDK_CRATE));
    assert.match(out.notRun[0], /ERPLORA_HUB_DIR/);
  } finally {
    m.clean();
  }
});

test('no cargo on the machine is NOT RUN, not a green and not a module bug', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  });
  try {
    const out = runRustTests(m.dir, { env: {}, cargo: 'erplora-no-such-cargo-binary' });
    assert.equal(out.errors.length, 0);
    assert.equal(out.notRun.length, 1);
    assert.match(out.notRun[0], /cargo/);
  } finally {
    m.clean();
  }
});

// ── running them ─────────────────────────────────────────────────────────────────────────────

test('a handler whose tests pass is reported as run, once per crate', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  });
  try {
    const out = runRustTests(m.dir, {
      env: {},
      runCargo: () => ({ status: 0, stdout: 'test result: ok. 3 passed; 0 failed;\n', stderr: '' }),
    });
    assert.deepEqual(out.errors, []);
    assert.deepEqual(out.notRun, []);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].ran, true);
    assert.equal(out.results[0].file, 'handler/');
  } finally {
    m.clean();
  }
});

test('a failing handler test is an ERROR carrying cargo’s own output', () => {
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() { panic!() } }\n',
  });
  try {
    const out = runRustTests(m.dir, {
      env: {},
      runCargo: () => ({ status: 101, stdout: 'test result: FAILED. 1 passed; 1 failed;\n', stderr: '' }),
    });
    assert.equal(out.notRun.length, 0);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /FALLA/);
    assert.match(out.errors[0], /1 failed/);
    assert.equal(out.results[0].ran, false);
  } finally {
    m.clean();
  }
});

test('cargo that exits 0 having compiled nothing does not buy a green', () => {
  // The `.pg.` trap of #50 in Rust clothing: `cargo test` on a crate whose tests were all
  // `#[ignore]`d, or filtered out, exits 0 with «0 passed». Discovery said there ARE tests here.
  const m = mod({
    'handler/Cargo.toml': CARGO_TOML('demo-handler'),
    'handler/src/lib.rs': '#[cfg(test)]\nmod tests { #[test] fn t() {} }\n',
  });
  try {
    const out = runRustTests(m.dir, {
      env: {},
      runCargo: () => ({ status: 0, stdout: 'test result: ok. 0 passed; 0 failed; 1 ignored;\n', stderr: '' }),
    });
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /0 test/i);
  } finally {
    m.clean();
  }
});

// ── the control: a REAL cargo, on a handler mutated to fail ──────────────────────────────────
//
// 🔴 Everything above injects a fake cargo, which proves the reporting and nothing about the
// wiring. These two run the real toolchain over two fixture handlers that differ in ONE line, and
// they are the only reason to believe the gate would have caught ERPlora/kitchen#63. A check that
// has never seen the positive is a check nobody has tested.
//
// They do NOT skip themselves without a toolchain — that is the whole disease of this issue — so
// this repository's CI installs Rust (`.github/workflows/ci.yml`).

test('CONTROL — a real `cargo test` over a healthy fixture handler is GREEN', () => {
  assert.ok(cargoAvailable(), 'cargo is required to run this suite: a control that skips proves nothing');
  const target = mkdtempSync(join(tmpdir(), 'erplora-cargo-target-'));
  try {
    const out = runRustTests(join(FIXTURES, 'green'), { env: {}, targetDir: target });
    assert.deepEqual(out.notRun, []);
    assert.deepEqual(out.errors, [], 'the healthy fixture must not be red, or the control means nothing');
    assert.equal(out.results[0].ran, true);
    assert.match(out.results[0].output, /2 passed/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test('CONTROL — the MUTANT fixture (one assertion broken on purpose) turns the gate RED', () => {
  assert.ok(cargoAvailable(), 'cargo is required to run this suite: a control that skips proves nothing');
  const target = mkdtempSync(join(tmpdir(), 'erplora-cargo-target-'));
  try {
    const out = runRustTests(join(FIXTURES, 'mutant'), { env: {}, targetDir: target });
    assert.deepEqual(out.notRun, []);
    assert.equal(out.errors.length, 1, 'the mutant handler must fail: this is the whole point of #146');
    assert.match(out.errors[0], /FALLA/);
    assert.match(out.errors[0], /the_total_adds_the_lines/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
