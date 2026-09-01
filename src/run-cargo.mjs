// The module's RUST batteries — the `#[cfg(test)] mod tests` of a Tier-2 handler (module-toolkit#146).
//
// WHAT THIS SOLVES. `erplora validate` compiles the handler (#135) and `erplora build` recompiles
// the wasm and refuses to publish a stale one (#26), so the ARTEFACT has been watched for weeks.
// What the artefact DOES was not: the handler's own unit tests — where the business logic of a
// Tier-2 module lives — were discovered by nothing and executed by nothing. `erplora test` knew
// `tests/**/*.test.py|.sh` (#50/#55) and `ui/**/*.test.ts` (#74) and stopped there, and the gate
// said so out loud in its own header rather than faking it.
//
// Measured on 2026-09-01 across the workspace: 21 modules carry a handler with tests, **925 tests**,
// and CI had run zero of them. In ERPlora/kitchen#63 the entire bug was one line of the handler
// building a comanda header without `waiter_id`; the three Rust tests that go red→green with the fix
// exist only on the machine of whoever wrote them. The day somebody builds that header again the
// gate is green.
//
// ── WHY IT COULD NOT RUN, AND WHAT CHANGED ──────────────────────────────────────────────────────
//
// The 22 handlers reach the hub's `erplora-guest-sdk` BY RELATIVE PATH:
//
//     erplora-guest-sdk = { path = "../../../../hub/crates/guest-sdk" }
//
// Four levels up from `handler/` — the monorepo root, a layout that exists on a developer's laptop
// and nowhere else. A module repository has no checkout of the PRIVATE ERPlora/hub and no credential
// to make one; a PAT with read access living in 22 repositories is a security decision, and it has
// been refused three times (#50, #74, hub#1097).
//
// It does not have to be made. The checkout is ALREADY on the runner, for free: to execute
// `ERPlora/hub/.github/actions/module-sdk` at all, GitHub brings the whole repository down — that is
// the same door #61/#66 opened for the canonical mirrors, and this repository's own `ci.yml` has
// been deriving `ERPLORA_HUB_DIR` from it since #90. So the missing piece was never the hub: it was
// the SHAPE. `farmManifestPath` builds it.
//
// ── THE FARM, AND THE FOUR THINGS THAT ARE NOT IT ───────────────────────────────────────────────
//
// A scratch tree of symlinks that puts the module and the hub at the depths the declared path
// expects, and hands cargo a manifest path THROUGH it:
//
//     <scratch>/hub                  → the hub checkout on this machine
//     <scratch>/_/_/<id>             → the module checkout
//     cargo test --manifest-path <scratch>/_/_/<id>/handler/Cargo.toml
//
// Measured, with both controls, on 2026-09-01: 46/46 of `kitchen`'s handler tests pass from a
// neutral working directory (cargo does NOT canonicalise the manifest path away), and removing the
// `hub` link fails loudly with «failed to load manifest for dependency `erplora-guest-sdk`». Nothing
// is written outside the scratch directory, so the six slots of `ci-runner-1` share no mutable state.
//
// What was measured and rejected, so nobody re-opens it as an idea:
//
//   1. COPY the crate somewhere convenient. It dies: the handlers `include_str!("../../module.json")`
//      and their JSON schemas, so the crate only compiles INSIDE its module. Two errors on `kitchen`.
//   2. `--config 'paths=[…]'`. Does not work — a path dependency has to load before an override can
//      replace it. The first run appeared to pass only because the shell had canonicalised the cwd
//      onto the real monorepo; with an honest layout it fails like case (2) above.
//   3. REWRITE `handler/Cargo.toml` in place. Mutating the checkout under test, on a file that
//      `dist/handler.build.json` hashes — the exact shape that already burned #31 with `Cargo.lock`.
//   4. A separate job filtered on `paths: handler/**`. It would be cheaper and it would be WRONG:
//      the handler tests read `../../module.json` and `../../schemas/*.json`, so a pull request that
//      only edits the manifest or a schema changes what they assert and the filter would skip it.
//
// ── AND THE RULE, WHICH IS THE HOUSE RULE ───────────────────────────────────────────────────────
//
// The same three that #50/#55/#74 arrived at, no carve-out:
//
//   1. discovery lives HERE, once, and `--list` reports exactly what will run. The gate does not
//      re-implement it in YAML — that is how #55 happened;
//   2. what does not run is NAMED, never counted as green. No hub within reach (a laptop with no
//      sibling checkout) or no cargo is reported as «sin correr», exactly like a Postgres battery
//      without its container;
//   3. and `cargo test` exiting 0 having executed NOTHING is a failure, not a pass. That is the
//      `SKIPPED:` trap of #50 in Rust clothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

/** The crate every Tier-2 handler reaches for, and the only one that is not on crates.io. */
export const GUEST_SDK_CRATE = 'erplora-guest-sdk';

/** Where the gate says the ERPlora/hub checkout is. Same name `ci.yml` already exports since #90. */
export const HUB_DIR_VAR = 'ERPLORA_HUB_DIR';

/** Build output and VCS noise; never handler source. Same list `wasm.mjs` walks with. */
const IGNORED_DIRS = new Set(['target', 'node_modules', 'dist']);

/** What makes a `.rs` file carry tests. Deliberately the attribute itself, not a naming convention. */
const RUST_TEST_ATTR = /#\[\s*cfg\s*\(\s*test\s*\)\s*\]/;

/**
 * 🔴 The SECOND shape, and it is module-toolkit#55 one language further along.
 *
 * Cargo compiles every top-level `.rs` in `handler/tests/` as its own integration-test target, and
 * those files carry `#[test]` with NO `#[cfg(test)]` around them — there is nothing to gate them
 * behind. Recognising a Rust test by one exact pattern is precisely how 20 batteries in 7 modules
 * stayed invisible in #55. `sales/handler/tests/complete_sale_harness.rs` is that shape today: 3
 * `#[test]`, zero `#[cfg(test)]`. A module whose only Rust tests lived there would have reported
 * «no Rust tests» and the whole family would have been skipped in silence.
 *
 * Only the TOP level, because only the top level is a target: `tests/common/mod.rs` is shared code
 * the targets import, and counting it would announce a test nothing runs.
 */
const RUST_TEST_FN = /#\[\s*test\s*\]/;
const INTEGRATION_DIR = 'tests';

/**
 * Handler sources that carry `#[cfg(test)]`, relative to the module dir and sorted.
 *
 * Empty when there is no `handler/Cargo.toml` — a module with no Rust crate has nothing to run, and
 * a `handler/` holding only a precompiled third-party wasm has no sources to test either.
 */
export function discoverRustTests(dir) {
  const handlerDir = join(dir, 'handler');
  if (!existsSync(join(handlerDir, 'Cargo.toml'))) return [];
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    // A top-level file of `handler/tests/` IS a cargo target; deeper down it is shared helper code.
    const isTargetDir = abs === join(handlerDir, INTEGRATION_DIR);
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (!entry.name.endsWith('.rs')) continue;
      let source = '';
      try {
        source = readFileSync(child, 'utf8');
      } catch {
        continue;
      }
      const carriesTests = RUST_TEST_ATTR.test(source) || (isTargetDir && RUST_TEST_FN.test(source));
      if (carriesTests) out.push(relative(dir, child).split('\\').join('/'));
    }
  };
  walk(handlerDir);
  return out.sort();
}

/**
 * The hub checkout the relative path needs, or `null`.
 *
 * 🔴 Verified, never promised. A declared path that does not actually hold `crates/guest-sdk` is
 * treated as no path at all: better a named «not run» than a farm that points at nothing and fails
 * three steps later as if the MODULE were broken — the failure mode `ci-infra.sh` exists to stop.
 */
export function hubCheckout(env = process.env) {
  const dir = env?.[HUB_DIR_VAR];
  if (!dir) return null;
  return existsSync(join(dir, 'crates', 'guest-sdk', 'Cargo.toml')) ? dir : null;
}

/** Is there a cargo on this machine? (`--version`, so a broken toolchain answers honestly.) */
export function cargoAvailable(cargo = 'cargo') {
  try {
    return spawnSync(cargo, ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Every `path = "…"` dependency declared in `handler/Cargo.toml`: `{ dep, path, resolved }`.
 *
 * Deliberately a lexical read and not a TOML parser: the toolkit ships with no dependencies, and the
 * shape in the 22 modules that have a handler is always the same one line —
 * `erplora-guest-sdk = { path = "../../../../hub/crates/guest-sdk" }`.
 */
export function pathDeps(handlerDir) {
  const cargoToml = join(handlerDir, 'Cargo.toml');
  if (!existsSync(cargoToml)) return [];
  const out = [];
  for (const line of readFileSync(cargoToml, 'utf8').split('\n')) {
    const hit = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(line.split('#')[0]);
    if (!hit) continue;
    out.push({ dep: hit[1], path: hit[2], resolved: resolve(handlerDir, hit[2]) });
  }
  return out;
}

/**
 * Those of them whose directory is NOT on disk — on a runner, always the guest-sdk.
 *
 * `validate.mjs` re-exports this (it used to own it): it is the one question both halves of the
 * toolkit that touch the handler crate ask, and two implementations of it is how #55 happened.
 */
export function missingPathDeps(handlerDir) {
  return pathDeps(handlerDir).filter((d) => !existsSync(d.resolved));
}

/** The `path = "…"` of the guest-sdk as the handler declares it, or `null`. */
function declaredSdkPath(handlerDir) {
  return pathDeps(handlerDir).find((d) => d.dep === GUEST_SDK_CRATE)?.path ?? null;
}

/**
 * A scratch tree in which the handler's own relative path resolves onto `hubDir`, and the manifest
 * path to hand cargo. Returns `null` when the declared path is not a shape this can satisfy.
 *
 * The depth is DERIVED from what the manifest declares, never hardcoded to four: a handler written
 * tomorrow at another depth works, and one written in a shape this cannot serve is reported as «not
 * run» instead of being silently mis-linked.
 */
export function farmManifestPath(dir, hubDir, { root, id = 'module' } = {}) {
  // 🔴 Absolute on BOTH ends before a single link is made. The gate calls
  // `erplora test "${{ inputs.path }}"` with the path exactly as the stub passed it — relative,
  // `.` in every module stub — and `symlinkSync` stores a relative target VERBATIM, resolved
  // against the directory holding the link. A `module → .` link points at the scratch dir itself,
  // and every `cargo test` dies with «manifest path does not exist»: a red pinned on the module,
  // in all 21 repos at once.
  dir = resolve(dir);
  hubDir = resolve(hubDir);
  const declared = declaredSdkPath(join(dir, 'handler'));
  if (!declared) return null;
  const segments = declared.split('/').filter(Boolean);
  const ups = segments.filter((s) => s === '..').length;
  const tail = segments.slice(ups); // e.g. ['hub', 'crates', 'guest-sdk']
  // `..` only, then a tail: anything else (an absolute path, a `..` in the middle) is not ours.
  if (ups < 2 || !tail.length || segments.slice(0, ups).some((s) => s !== '..')) return null;

  // `handler/` is one level below the module dir, so the module link sits `ups - 2` fillers deep and
  // the `ups`-th parent of the handler lands exactly on `root`.
  const fillers = Array.from({ length: ups - 2 }, (_, i) => `_${i}`);
  const moduleLink = join(root, ...fillers, id);
  mkdirSync(dirname(moduleLink), { recursive: true });
  linkOnto(moduleLink, dir);
  linkOnto(join(root, tail[0]), hubDir);

  const manifest = join(moduleLink, 'handler', 'Cargo.toml');
  // Proven, not assumed — BOTH links, because each has failed for its own reason: the manifest
  // itself (the module link — a broken one is how the relative-path red above was born) and the
  // dependency through the farm (the hub link). If either does not resolve, cargo would fail with
  // a message about the MODULE, and the module is not what broke.
  if (!existsSync(manifest)) return null;
  if (!existsSync(resolve(dirname(manifest), declared, 'Cargo.toml'))) return null;
  return manifest;
}

/** `ln -sfn`: replaces whatever is there, so a re-run never inherits a stale link. */
function linkOnto(link, target) {
  rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'dir');
}

/** Tests cargo says it executed, summed over the lib and the doc-test sections. */
function testsExecuted(output) {
  let total = 0;
  for (const m of output.matchAll(/test result:.*?(\d+) passed/g)) total += Number(m[1]);
  for (const m of output.matchAll(/test result:.*?(\d+) failed/g)) total += Number(m[1]);
  return total;
}

/** `cargo test` over one manifest. Separated so the reporting can be tested without a toolchain. */
function spawnCargo(manifestPath, { cargo = 'cargo', env = process.env, targetDir = null } = {}) {
  // No `--features guest`: the Extism entry points behind it are for wasm32, and the logic the
  // handler's tests exercise sits in front of them (measured — all 21 modules are green without it).
  const res = spawnSync(
    cargo,
    ['test', '--quiet', '--manifest-path', manifestPath],
    {
      encoding: 'utf8',
      timeout: 900000,
      env: { ...env, ...(targetDir ? { CARGO_TARGET_DIR: targetDir } : {}) },
    },
  );
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * Runs the handler's Rust tests. Returns `{ results, errors, notRun }` — the same shape
 * `runBatteries` and `runTsTests` return, so `erplora test` reports all three families identically.
 *
 * `env` is the environment the GATE handed over (it is where `ERPLORA_HUB_DIR` is read from); the
 * child process gets it merged over this process's own, so a caller can isolate the lookup without
 * taking `PATH` away from cargo.
 */
export function runRustTests(
  dir,
  { env = process.env, cargo = 'cargo', runCargo = null, targetDir = null } = {},
) {
  const results = [];
  const errors = [];
  const notRun = [];

  const sources = discoverRustTests(dir);
  if (!sources.length) return { results, errors, notRun };

  const handlerDir = join(dir, 'handler');
  const named = sources.join(', ');
  let manifestPath = join(handlerDir, 'Cargo.toml');
  let scratch = null;

  // The path dependencies the checkout cannot satisfy on its own — on a runner, always the guest-sdk.
  const missing = missingPathDeps(handlerDir);
  if (missing.length) {
    const hub = hubCheckout(env);
    if (!hub) {
      // The split is the house rule of #50, verbatim from `run-batteries.mjs`: an environment
      // NOBODY handed over is a named «not run» (a laptop with no sibling checkout); an environment
      // HANDED OVER but unusable is an ERROR, because a quiet ⚠ here means the Rust family never
      // runs in the gate while the gate stays green — the exact silent skip #146 exists to end.
      if (env?.[HUB_DIR_VAR]) {
        errors.push(
          `handler/: \`${HUB_DIR_VAR}\` apunta a \`${env[HUB_DIR_VAR]}\` y ahí no hay ` +
            `\`crates/guest-sdk/Cargo.toml\` — se ha entregado un checkout del hub que no sirve, y ` +
            `sin él los tests del handler (${named}) no pueden correr (module-toolkit#146)`,
        );
      } else {
        notRun.push(
          `${named}: sin un checkout de ERPlora/hub al alcance no se han corrido — el handler resuelve ` +
            `\`${GUEST_SDK_CRATE}\` por la ruta relativa \`${missing[0].path}\`, que solo existe en el ` +
            `monorepo. El gate lo entrega en \`${HUB_DIR_VAR}\` (module-toolkit#146); contarlos como ` +
            'verdes sería certificar la lógica Tier 2 contra un compilador que nunca la vio',
        );
      }
      return { results, errors, notRun };
    }
    scratch = mkdtempSync(join(tmpdir(), 'erplora-handler-farm-'));
    const farmed = farmManifestPath(dir, hub, { root: scratch, id: 'module' });
    if (!farmed) {
      rmSync(scratch, { recursive: true, force: true });
      // The hub IS at hand and the declaration still cannot be served: these tests will never run
      // in the gate, on any runner, until the module fixes its manifest. A ⚠ would let that merge
      // green forever — so it is an ERROR, the same way a stray file under `tests/` is one.
      errors.push(
        `handler/: \`${GUEST_SDK_CRATE}\` se declara como \`${missing[0].path}\`, una forma que el ` +
          `toolkit no sabe satisfacer con el checkout del hub (${hub}) — los tests del handler ` +
          `(${named}) no van a correr en NINGÚN gate hasta arreglarlo. Declárala como ` +
          '`../../../../hub/crates/guest-sdk`, igual que los demás handlers (module-toolkit#146)',
      );
      return { results, errors, notRun };
    }
    manifestPath = farmed;
  }

  try {
    if (!runCargo && !cargoAvailable(cargo)) {
      notRun.push(
        `${named}: no hay \`cargo\` en esta máquina, así que los tests del handler NO se han ` +
          'corrido. Un test que no corre no puede salir en verde (module-toolkit#146)',
      );
      return { results, errors, notRun };
    }

    const run = runCargo ?? spawnCargo;
    const r = run(manifestPath, { cargo, env: { ...process.env, ...env }, targetDir });
    const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const executed = testsExecuted(output);
    const ran = r.status === 0 && executed > 0;
    results.push({ file: 'handler/', kind: 'rust', ran, code: r.status, output, sources, executed });

    if (r.status !== 0) {
      errors.push(`handler/: \`cargo test\` FALLA (exit ${r.status})\n${indent(output)}`);
    } else if (executed === 0) {
      // Exit 0 having compiled and executed nothing: the `SKIPPED:` green of #50, in Rust. Discovery
      // already said there ARE `#[cfg(test)]` here, so «0 tests» means they did not run.
      errors.push(
        `handler/: \`cargo test\` salió con 0 pero ejecutó 0 test(s), y ${sources.length} fichero(s) ` +
          `declaran \`#[cfg(test)]\` (${named}). Un verde sin comprobación es el fallo que esta ` +
          `puerta viene a evitar (module-toolkit#146)\n${indent(output)}`,
      );
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  return { results, errors, notRun };
}

function indent(text) {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
