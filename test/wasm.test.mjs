// module-toolkit#26: `erplora build` did NOT recompile `dist/handler.wasm`, so a module could
// publish STALE Tier-2 logic in complete silence.
//
// Hit twice on 2026-08-07 while working the TODO-MVP queue:
//   • ERPlora/tables#25   — `handler/src/lib.rs` gained `split_session`, `module.json` declared it,
//                           `erplora build` ran fine and `dist/handler.wasm` stayed at its 20-jul
//                           build (8 exported functions, not 9).
//   • ERPlora/pricing#17  — same shape, but the function NAMES did not change: only the logic did.
//
// That second case is why two checks are needed, not one:
//   - EXPORTS (robust): the binary must export every `commands[].handler.function` the manifest
//     declares. Catches tables (a brand new function missing from the binary).
//   - FRESHNESS (cheap): the binary must not be older than any `handler/` source. Catches pricing
//     (same exports, older logic) — the export check is blind to it.
//
// Nothing here needs `cargo`: the toolchain and the cargo run are injected, and the wasm binaries
// are hand-encoded (only the export section is parsed). The real toolchain path is covered by
// `npm run smoke` and by the read-only fixture tests against the tables module at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  buildWasmHandler,
  checkWasmArtifact,
  checkWasmExports,
  checkWasmFreshness,
  collectHandlerSources,
  declaredWasmHandlers,
  hashHandlerSources,
  readWasmExports,
  wasmBuildStamp,
} from '../src/wasm.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

// --- fixtures -------------------------------------------------------------------------------

/** LEB128 (unsigned), the integer encoding of the wasm binary format. */
function leb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

/** Minimal wasm module exporting `names` as functions — enough for the export-section parser. */
function wasmWithExports(names) {
  const payload = [...leb(names.length)];
  names.forEach((name, i) => {
    const bytes = Buffer.from(name, 'utf8');
    payload.push(...leb(bytes.length), ...bytes, 0x00 /* kind: func */, ...leb(i));
  });
  const section = [0x07, ...leb(payload.length), ...payload];
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...section]);
}

/** Manifest declaring one wasm-handled command per function name. */
function manifestWith(functions, file = 'dist/handler.wasm') {
  return {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    commands: Object.fromEntries(
      // `permission` is required by the canonical schema, the same contract the hub applies: a
      // command without it is refused on install (module-toolkit#247).
      functions.map((fn) => [`demo.${fn}`, { permission: `demo.${fn}`, sql: [], handler: { type: 'wasm', file, function: fn } }]),
    ),
  };
}

function write(dir, rel, body, ageMs) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  if (ageMs !== undefined) {
    const seconds = (Date.now() - ageMs) / 1000;
    utimesSync(abs, seconds, seconds);
  }
  return abs;
}

const DAY = 24 * 60 * 60 * 1000;

/** Module dir with a Rust handler source and a `dist/handler.wasm` of the given age. */
function moduleFixture({ functions = ['open_session'], exports = functions, wasmAgeMs = 0, sourceAgeMs = DAY, file } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm26-'));
  const manifest = manifestWith(functions, file);
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  // `lib.rs` is deliberately the NEWEST source (what a dev actually edits), so the staleness
  // message has one unambiguous file to name.
  write(dir, 'handler/Cargo.toml', '[package]\nname = "demo-handler"\n\n[features]\nguest = []\n', sourceAgeMs + 60000);
  write(dir, 'handler/src/lib.rs', '// handler source\n', sourceAgeMs);
  if (exports !== null) write(dir, manifest.commands[`demo.${functions[0]}`].handler.file, wasmWithExports(exports), wasmAgeMs);
  return { dir, manifest };
}

const clean = (dir) => rmSync(dir, { recursive: true, force: true });

/** The stamp `erplora build` would have left for the current state of the fixture. */
function writeStamp(dir, manifest) {
  writeFileSync(join(dir, 'dist', 'handler.build.json'), JSON.stringify(wasmBuildStamp(dir, manifest), null, 2));
}

// --- declaredWasmHandlers -------------------------------------------------------------------

test('declaredWasmHandlers groups the declared functions by binary file', () => {
  const manifest = manifestWith(['open_session', 'close_session']);
  const declared = declaredWasmHandlers(manifest);
  assert.deepEqual(
    declared.map((d) => d.file),
    ['dist/handler.wasm'],
  );
  assert.deepEqual(declared[0].functions.sort(), ['close_session', 'open_session']);
});

test('declaredWasmHandlers ignores commands without a wasm handler', () => {
  assert.deepEqual(declaredWasmHandlers({ commands: { 'demo.create': { sql: ['commands/create.sql'] } } }), []);
});

// --- readWasmExports ------------------------------------------------------------------------

test('readWasmExports reads the export section of a wasm binary', () => {
  const names = readWasmExports(wasmWithExports(['open_session', 'close_session', 'split_session']))
    .filter((e) => e.kind === 0)
    .map((e) => e.name);
  assert.deepEqual(names, ['open_session', 'close_session', 'split_session']);
});

test('readWasmExports rejects a file that is not wasm instead of returning garbage', () => {
  assert.throws(() => readWasmExports(Buffer.from('not a wasm binary at all')), /wasm/i);
});

// --- checkWasmExports (the tables case) -----------------------------------------------------

test('a binary missing a declared function is REJECTED, naming the function (tables#25)', () => {
  // The exact 2026-08-07 shape: the manifest declares 9 functions, the 20-jul binary exports 8.
  const { dir, manifest } = moduleFixture({
    functions: ['open_session', 'close_session', 'split_session'],
    exports: ['open_session', 'close_session'],
  });
  try {
    const r = checkWasmExports(dir, manifest);
    assert.equal(r.checked, true);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /split_session/);
    assert.match(r.errors[0], /dist\/handler\.wasm/);
  } finally {
    clean(dir);
  }
});

test('a binary exporting every declared function passes the export check', () => {
  const { dir, manifest } = moduleFixture({ functions: ['open_session', 'close_session'] });
  try {
    const r = checkWasmExports(dir, manifest);
    assert.equal(r.checked, true);
    assert.deepEqual(r.errors, []);
  } finally {
    clean(dir);
  }
});

test('a module without a wasm handler is not checked at all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm26-'));
  try {
    const manifest = { id: 'demo', commands: { 'demo.create': { sql: ['commands/create.sql'] } } };
    assert.deepEqual(checkWasmExports(dir, manifest), { checked: false, errors: [], warnings: [] });
    assert.deepEqual(checkWasmFreshness(dir, manifest), { checked: false, errors: [], warnings: [] });
  } finally {
    clean(dir);
  }
});

test('a declared binary that does not exist is an error, not a silent pass', () => {
  const { dir, manifest } = moduleFixture({ exports: null });
  try {
    const r = checkWasmExports(dir, manifest);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /no existe/);
  } finally {
    clean(dir);
  }
});

// --- checkWasmFreshness (the pricing case) --------------------------------------------------

test('a binary OLDER than a handler source is REJECTED (pricing#17: same exports, older logic)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 18 * DAY, sourceAgeMs: 0 });
  try {
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.checked, true);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /handler\/src\/lib\.rs/);
    assert.match(r.errors[0], /erplora build/);
  } finally {
    clean(dir);
  }
});

test('a binary NEWER than every handler source passes', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.checked, true);
    assert.deepEqual(r.errors, []);
  } finally {
    clean(dir);
  }
});

test('a sub-second mtime spread does not fail (a fresh git checkout writes everything at once)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 1000, sourceAgeMs: 0 });
  try {
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('handler/target/ does not count as source (cargo writes it AFTER the binary is copied)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: DAY, sourceAgeMs: 2 * DAY });
  try {
    write(dir, 'handler/target/wasm32-unknown-unknown/release/demo_handler.wasm', 'x', 0);
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
    assert.equal(collectHandlerSources(join(dir, 'handler')).some((p) => p.includes('/target/')), false);
  } finally {
    clean(dir);
  }
});

test('a wasm declared WITHOUT handler/ sources cannot be dated: warning, not error', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 30 * DAY });
  try {
    rmSync(join(dir, 'handler'), { recursive: true, force: true });
    const r = checkWasmFreshness(dir, manifest);
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /handler\//);
  } finally {
    clean(dir);
  }
});

test('checkWasmArtifact reports freshness AND exports in one go', () => {
  const { dir, manifest } = moduleFixture({
    functions: ['open_session', 'split_session'],
    exports: ['open_session'],
    wasmAgeMs: 18 * DAY,
    sourceAgeMs: 0,
  });
  try {
    const r = checkWasmArtifact(dir, manifest);
    assert.equal(r.checked, true);
    assert.equal(r.errors.length, 2, r.errors.join(' | '));
    assert.ok(r.errors.some((e) => /split_session/.test(e)));
    assert.ok(r.errors.some((e) => /lib\.rs/.test(e)));
  } finally {
    clean(dir);
  }
});

// --- buildWasmHandler -----------------------------------------------------------------------

const UNAVAILABLE = { available: false, reason: 'cargo no instalado' };
const AVAILABLE = { available: true, cargo: 'cargo' };

/** Fake `cargo build` that drops a binary exporting `exports` where the real one would. */
function fakeCargo(exports, { status = 0, stderr = '' } = {}) {
  const calls = [];
  const run = (cargoToml, toolchain, opts) => {
    calls.push({ cargoToml, toolchain, opts });
    if (status !== 0) return { status, stdout: '', stderr, artifact: null };
    const artifact = join(dirname(cargoToml), 'target', 'wasm32-unknown-unknown', 'release', 'demo_handler.wasm');
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, wasmWithExports(exports));
    return { status: 0, stdout: '', stderr: '', artifact };
  };
  run.calls = calls;
  return run;
}

test('build does not touch cargo when the module declares no wasm handler', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm26-'));
  try {
    const runCargo = fakeCargo([]);
    const r = buildWasmHandler(dir, { id: 'demo', commands: {} }, { toolchain: AVAILABLE, runCargo });
    assert.equal(r.status, 'skipped');
    assert.equal(runCargo.calls.length, 0);
  } finally {
    clean(dir);
  }
});

test('build does not recompile a binary that is already up to date', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    const runCargo = fakeCargo(['open_session']);
    const r = buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo });
    assert.equal(r.status, 'fresh');
    assert.equal(runCargo.calls.length, 0);
  } finally {
    clean(dir);
  }
});

test('build RECOMPILES a stale binary and copies it over dist/handler.wasm (module-toolkit#26)', () => {
  const { dir, manifest } = moduleFixture({
    functions: ['open_session', 'split_session'],
    exports: ['open_session'], // the 20-jul binary, without the new function
    wasmAgeMs: 18 * DAY,
    sourceAgeMs: 0,
  });
  try {
    const runCargo = fakeCargo(['open_session', 'split_session']);
    const r = buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo });
    assert.equal(r.status, 'built');
    assert.equal(runCargo.calls.length, 1);
    assert.equal(runCargo.calls[0].cargoToml, join(dir, 'handler', 'Cargo.toml'));
    // `--features guest`: without it the guest exports are not compiled in and the binary is empty.
    assert.deepEqual(runCargo.calls[0].opts.features, ['guest']);
    const rebuilt = readWasmExports(readFileSync(join(dir, 'dist', 'handler.wasm'))).map((e) => e.name);
    assert.deepEqual(rebuilt, ['open_session', 'split_session']);
    assert.deepEqual(checkWasmArtifact(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('build recompiles a binary that looks recent but does not export a declared function', () => {
  // Found on real data: dropping the 18-jul tables binary in place gives it a NEW mtime, so every
  // date-based signal says fresh while the binary is 8 functions to the manifest's 9. A binary that
  // does not match the manifest has to be rebuilt whatever the clock says.
  const { dir, manifest } = moduleFixture({
    functions: ['open_session', 'split_session'],
    exports: ['open_session'],
    wasmAgeMs: 0,
    sourceAgeMs: DAY,
  });
  try {
    const runCargo = fakeCargo(['open_session', 'split_session']);
    assert.equal(buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo }).status, 'built');
    assert.equal(runCargo.calls.length, 1);
  } finally {
    clean(dir);
  }
});

test('build compiles when dist/handler.wasm does not exist yet', () => {
  const { dir, manifest } = moduleFixture({ exports: null });
  try {
    const runCargo = fakeCargo(['open_session']);
    assert.equal(buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo }).status, 'built');
    assert.ok(existsSync(join(dir, 'dist', 'handler.wasm')));
  } finally {
    clean(dir);
  }
});

test('build FAILS LOUDLY on a stale binary when there is no wasm toolchain to rebuild it', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 18 * DAY, sourceAgeMs: 0 });
  try {
    assert.throws(
      () => buildWasmHandler(dir, manifest, { toolchain: UNAVAILABLE, runCargo: fakeCargo([]) }),
      (err) => /desfasado/i.test(err.message) && /cargo no instalado/.test(err.message),
    );
  } finally {
    clean(dir);
  }
});

test('build fails when cargo fails, showing the compiler output', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 18 * DAY, sourceAgeMs: 0 });
  try {
    const runCargo = fakeCargo([], { status: 101, stderr: 'error[E0425]: cannot find function `round_cents`' });
    assert.throws(() => buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo }), /round_cents/);
  } finally {
    clean(dir);
  }
});

test('build fails when the freshly compiled binary lacks a declared function', () => {
  const { dir, manifest } = moduleFixture({
    functions: ['open_session', 'split_session'],
    exports: ['open_session'],
    wasmAgeMs: 18 * DAY,
    sourceAgeMs: 0,
  });
  try {
    // The Rust source never grew `split_session`: recompiling does not fix the manifest lying.
    const runCargo = fakeCargo(['open_session']);
    assert.throws(() => buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo }), /split_session/);
  } finally {
    clean(dir);
  }
});

// --- build stamp (the authoritative layer) --------------------------------------------------
//
// git and mtime are circumstantial evidence. The stamp `erplora build` leaves next to the binary
// (`dist/handler.build.json`: sha256 of the handler tree + sha256 of the wasm) is the direct one,
// and it is what makes a false positive CLEARABLE: recompiling always refreshes it, even when the
// rebuilt binary comes out byte-identical (a comment-only change), which neither git nor mtime can
// ever settle on their own.

test('build leaves a stamp with the hashes of the sources and of the binary it produced', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 18 * DAY, sourceAgeMs: 0 });
  try {
    buildWasmHandler(dir, manifest, { toolchain: AVAILABLE, runCargo: fakeCargo(['open_session']) });
    const stamp = JSON.parse(readFileSync(join(dir, 'dist', 'handler.build.json'), 'utf8'));
    assert.match(stamp.sources_sha256, /^[0-9a-f]{64}$/);
    assert.match(stamp.wasm_sha256, /^[0-9a-f]{64}$/);
    assert.equal(stamp.file, 'dist/handler.wasm');
    assert.equal(stamp.target, 'wasm32-unknown-unknown');
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('a stamp that matches wins over an mtime that would call the binary stale', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 30 * DAY, sourceAgeMs: 0 });
  try {
    writeStamp(dir, manifest);
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('a stamp whose source hash no longer matches → stale (the sources moved on)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    writeStamp(dir, manifest);
    write(dir, 'handler/src/lib.rs', '// a rule that is not compiled into the binary\n', DAY);
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0], /desfasado/i);
  } finally {
    clean(dir);
  }
});

// --- module-toolkit#31: Cargo.lock is not evidence of what the binary contains ---------------
// The lock is at once an INPUT of the freshness hash and an OUTPUT of cargo, so any build rewrites
// a file the gate is hashing. And its contents are not the module's: the handler resolves the
// guest-sdk BY PATH into the local hub checkout, so two authors with different checkouts produce
// different locks for the same source. What that cost, measured: ERPlora/inventory#46 went red on
// `stamp-sources` with the binary matching its own hash — a merge blocked by a metadata line.

test('a rewritten Cargo.lock does NOT make a stamped handler stale (#31)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    write(dir, 'handler/Cargo.lock', 'version = 4\n\n[[package]]\nname = "erplora-guest-sdk"\nversion = "0.0.0"\n', DAY);
    writeStamp(dir, manifest);
    // What a `cargo build` against a hub that moved to 1.0.0 (hub#515) leaves behind.
    write(dir, 'handler/Cargo.lock', 'version = 4\n\n[[package]]\nname = "erplora-guest-sdk"\nversion = "1.0.0"\n', 0);
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, [], 'metadata is not logic');
  } finally {
    clean(dir);
  }
});

test('and a source edit next to it is STILL caught (#31 does not switch the gate off)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    write(dir, 'handler/Cargo.lock', 'version = 4\n', DAY);
    writeStamp(dir, manifest);
    write(dir, 'handler/Cargo.lock', 'version = 4\n# rewritten\n', 0);
    write(dir, 'handler/src/lib.rs', '// a rule that is not compiled into the binary\n', 0);
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0], /desfasado/i);
  } finally {
    clean(dir);
  }
});

test('a LEGACY stamp (hashed WITH the lock) is still honoured (#31)', () => {
  // 21 modules carry a stamp written by the previous hash. Rejecting them all at once would turn
  // the publish gate red across the catalog for a change of ours, so the old hash keeps being
  // accepted; the immunity to the lock arrives with each module's next build.
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    write(dir, 'handler/Cargo.lock', 'version = 4\n', DAY);
    const legacy = {
      ...wasmBuildStamp(dir, manifest),
      sources_sha256: hashHandlerSources(join(dir, 'handler'), { includeLock: true }),
    };
    writeFileSync(join(dir, 'dist', 'handler.build.json'), JSON.stringify(legacy, null, 2));
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, [], 'an old stamp is not a stale binary');
  } finally {
    clean(dir);
  }
});

test('a stamp whose wasm hash no longer matches → stale (the binary was swapped)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    writeStamp(dir, manifest);
    write(dir, 'dist/handler.wasm', wasmWithExports(['open_session', 'someone_elses_build']));
    assert.equal(checkWasmFreshness(dir, manifest).errors.length, 1);
  } finally {
    clean(dir);
  }
});

// --- git-aware freshness --------------------------------------------------------------------
//
// mtime alone is too noisy in a real workspace: running the check over the 21 modules that carry a
// handler flagged 4, and only ONE (customers, whose handler was fixed on 13-jul over a binary
// committed on 07-jun) was genuinely stale. The other three had source and binary committed in the
// SAME commit and only differed in local mtimes (a checkout, a `cargo build` touching Cargo.lock).
// A publish gate that cries wolf gets ignored, so git decides whenever it can and mtime is the
// fallback for a module without history (a zip, a fresh scaffold).

/** git repo in `dir`; returns a `run(...args)` that can date its commits. */
function gitRepo(dir) {
  const run = (args, date) =>
    spawnSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
    });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);
  return (message, date) => {
    run(['add', '-A']);
    run(['commit', '-q', '-m', message], date);
  };
}

/** Same mtime everywhere: forces the answer to come from git, not from the clock. */
function levelMtimes(dir, files) {
  const seconds = Date.now() / 1000;
  for (const rel of files) utimesSync(join(dir, rel), seconds, seconds);
}

test('git: handler source edited and binary NOT rebuilt → stale even with identical mtimes', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: 0 });
  try {
    const commit = gitRepo(dir);
    commit('initial');
    write(dir, 'handler/src/lib.rs', '// handler source, now with a new rule\n');
    levelMtimes(dir, ['handler/src/lib.rs', 'dist/handler.wasm']);
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0], /desfasado/i);
    assert.match(r.errors[0], /lib\.rs/);
  } finally {
    clean(dir);
  }
});

test('git: handler edited AND binary rebuilt in the same working tree → fresh', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: DAY });
  try {
    const commit = gitRepo(dir);
    commit('initial');
    write(dir, 'handler/src/lib.rs', '// new rule\n', DAY);
    write(dir, 'dist/handler.wasm', wasmWithExports(['open_session', 'rebuilt_marker']), 0);
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('git: handler committed AFTER the binary → stale (the live customers case)', () => {
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 0, sourceAgeMs: 0 });
  try {
    const commit = gitRepo(dir);
    commit('handler + binary', '2026-06-07T21:40:59+02:00');
    write(dir, 'handler/src/lib.rs', '// fix: the handler pointed at a guest-sdk that is not\n');
    commit('fix handler only', '2026-07-13T17:41:13+02:00');
    levelMtimes(dir, ['handler/src/lib.rs', 'handler/Cargo.toml', 'dist/handler.wasm']);
    const r = checkWasmFreshness(dir, manifest);
    assert.equal(r.errors.length, 1, r.errors.join(' | '));
    assert.match(r.errors[0], /desfasado/i);
  } finally {
    clean(dir);
  }
});

test('git: source and binary committed together → fresh however the local mtimes drifted', () => {
  // The false positive to avoid: tickets/invoice_series/whatsapp_inbox, in sync in git, flagged by
  // mtime because a local checkout rewrote lib.rs / Cargo.lock weeks after the binary was written.
  const { dir, manifest } = moduleFixture({ wasmAgeMs: 35 * DAY, sourceAgeMs: 35 * DAY });
  try {
    const commit = gitRepo(dir);
    commit('handler + binary in one commit');
    levelMtimes(dir, ['handler/src/lib.rs', 'handler/Cargo.toml']); // touched now, binary is 35 days old
    assert.deepEqual(checkWasmFreshness(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

// --- wiring: `erplora build` and `erplora validate` -----------------------------------------

/**
 * No module SDK for these builds: the check that it is not behind hub develop (module-toolkit#387,
 * test/sdk-freshness.test.mjs) would otherwise judge the local `../hub` and ask its `origin`.
 */
const NO_SDK = { sdkDir: null };

/** Fixture that survives the full `build`/`validate` pipeline: WC entry + one portable SQL file. */
function cliFixture({ functions = ['open_session'], exports = functions, wasmAgeMs = 18 * DAY } = {}) {
  const { dir, manifest } = moduleFixture({ functions, exports, wasmAgeMs, sourceAgeMs: 0 });
  manifest.commands[`demo.${functions[0]}`].sql = ['commands/open.sql'];
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  write(dir, 'commands/open.sql', 'INSERT INTO demo_sessions (name) VALUES (:name);\n');
  write(dir, 'src/demo.js', 'export const demo = 1;\n');
  writeContractsFile(dir, manifest); // ADR-0127: validate requires .erplora/contracts.json
  return { dir, manifest };
}

test('erplora build recompiles the stale handler as part of the build (module-toolkit#26)', async () => {
  const { dir, manifest } = cliFixture({ functions: ['open_session', 'split_session'], exports: ['open_session'] });
  try {
    const { build } = await import('../src/build.mjs');
    const runCargo = fakeCargo(['open_session', 'split_session']);
    await build(dir, { wasm: { toolchain: AVAILABLE, runCargo }, sdk: NO_SDK });
    assert.equal(runCargo.calls.length, 1, 'build must compile the handler');
    assert.deepEqual(
      readWasmExports(readFileSync(join(dir, 'dist', 'handler.wasm'))).map((e) => e.name),
      ['open_session', 'split_session'],
    );
    assert.ok(existsSync(join(dir, 'dist', 'demo.esm.js')), 'the WC bundle is still built');
    assert.deepEqual(checkWasmArtifact(dir, manifest).errors, []);
  } finally {
    clean(dir);
  }
});

test('erplora build fails instead of bundling a WC over a stale handler it cannot rebuild', async () => {
  const { dir } = cliFixture();
  try {
    const { build } = await import('../src/build.mjs');
    await assert.rejects(() => build(dir, { wasm: { toolchain: UNAVAILABLE }, sdk: NO_SDK }), /desfasado/i);
  } finally {
    clean(dir);
  }
});

// The publish gate: `pack` runs `validate` first, so a stale binary must never reach a module.zip.
test('erplora validate REJECTS a module with a stale handler.wasm (exit 1)', () => {
  const { dir } = cliFixture();
  const bin = fileURLToPath(new URL('../bin/erplora.mjs', import.meta.url));
  try {
    const res = spawnSync(process.execPath, [bin, 'validate', dir], { encoding: 'utf8' });
    assert.equal(res.status, 1, `expected validate to fail:\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /desfasado/i);
  } finally {
    clean(dir);
  }
});

test('erplora validate REJECTS a manifest routed to a function the binary does not export', () => {
  const { dir } = cliFixture({
    functions: ['open_session', 'split_session'],
    exports: ['open_session'],
    wasmAgeMs: 0, // fresh by date: only the export check can see this one
  });
  const bin = fileURLToPath(new URL('../bin/erplora.mjs', import.meta.url));
  try {
    const res = spawnSync(process.execPath, [bin, 'validate', dir], { encoding: 'utf8' });
    assert.equal(res.status, 1, `expected validate to fail:\n${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /split_session/);
  } finally {
    clean(dir);
  }
});

// --- real module (read-only fixture) --------------------------------------------------------

// Verification against the REAL tables module: its manifest + committed binary, frozen byte for byte
// under test/fixtures/real-modules (ERPlora/tables@21a7fbc), are copied to a temp dir. They used to
// be read from the sibling modules workspace, which no CI runner has, so both tests skipped on every
// pull request (module-toolkit#352). A missing fixture is a FAILURE here, never a skip.
const TABLES = fileURLToPath(new URL('./fixtures/real-modules/tables/', import.meta.url));

test('real tables module: the committed binary exports the 9 functions its manifest declares', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm26-tables-'));
  try {
    const manifest = JSON.parse(readFileSync(join(TABLES, 'module.json'), 'utf8'));
    writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
    write(dir, 'dist/handler.wasm', readFileSync(join(TABLES, 'dist', 'handler.wasm')));
    assert.deepEqual(checkWasmExports(dir, manifest).errors, []);
    assert.ok(declaredWasmHandlers(manifest)[0].functions.length >= 9);
  } finally {
    clean(dir);
  }
});

test('real tables module: a function the binary does not export is caught (tables#25 reproduced)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wasm26-tables-'));
  try {
    const manifest = JSON.parse(readFileSync(join(TABLES, 'module.json'), 'utf8'));
    // What the manifest looked like on 2026-08-07 against the 20-jul binary: one function too many.
    manifest.commands['tables.sessions.rename'] = {
      sql: [],
      handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'rename_session' },
    };
    writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
    write(dir, 'dist/handler.wasm', readFileSync(join(TABLES, 'dist', 'handler.wasm')));
    const r = checkWasmExports(dir, manifest);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /rename_session/);
  } finally {
    clean(dir);
  }
});
