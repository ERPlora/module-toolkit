// Every suite in `test/` either RUNS in CI or is named here with the reason — ERPlora/hub#1097.
//
// WHY THIS FILE EXISTS, and it is not theory: it caught its own pull request. `ci.yml` runs an
// EXPLICIT list of files, on purpose (a `validate-*` glob would have left the vendored schema
// unchecked — module-toolkit#30/#40), and it asks in a comment that «a new dependency-free suite
// belongs on this line». A comment is not a check. `test/gate-wiring.test.mjs` was added, was
// green locally, and CI ran 367 tests without it — a test nobody executes, which is the exact
// defect this repository keeps re-finding in other people's code (#50, #55, #61, #74).
//
// The rule is the one those four already apply: what does not run is NAMED, never silent. A suite
// that CI genuinely cannot run — the ones needing `esbuild`, `lit` or the workspace, which no
// runner can `npm install` here — goes in `CANNOT_RUN_IN_CI` **with its reason**. Adding a suite
// then forces a decision instead of allowing an omission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Suites CI cannot run, and why. `npm install` is impossible on a runner — three dependencies are
 * `file:` paths into sibling checkouts that do not exist there — so only what reaches for one of
 * THOSE stays a local `node --test`. Public npm packages are not an excuse: `ci.yml` installs them
 * one by one, and the last test below fails the day an excuse blames one it already installs
 * (module-toolkit#148: `wasm.test.mjs` sat here as «needs the Rust toolchain» after #146 had put
 * Rust on the runner, and nine suites «needed esbuild», a public package).
 */
const CANNOT_RUN_IN_CI = {
  'pack-outfitkit-floor.test.mjs':
    'its #201 controls run `erplora pack`, which shells out to the `zip`/`unzip` binaries the self-hosted runner does not have (#389)',
};

/** The `test/…` arguments of the `Tests` step, as written. */
function ciPatterns() {
  const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const step = /name: Tests\n\s*run: >\n((?:[ \t]+\S.*\n)+)/.exec(ci);
  assert.ok(step, 'the `Tests` step of ci.yml is not shaped the way this check reads it');
  return step[1]
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('test/'));
}

/** `test/bin-*.test.mjs` → matches `bin-smoke.test.mjs`. Only `*`, and it never crosses a `/`. */
function matches(pattern, file) {
  const re = new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
  );
  return re.test(`test/${file}`);
}

const SUITES = readdirSync(join(REPO, 'test'))
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();

test('every suite either runs in CI or is named as one that cannot', () => {
  const patterns = ciPatterns();
  const orphans = SUITES.filter(
    (f) => !patterns.some((p) => matches(p, f)) && !(f in CANNOT_RUN_IN_CI),
  );
  assert.deepEqual(
    orphans,
    [],
    `these suites run NOWHERE: not in ci.yml and not declared unrunnable. Add them to the ` +
      `\`Tests\` step of .github/workflows/ci.yml, or to CANNOT_RUN_IN_CI with the reason. A test ` +
      `nobody executes is worse than no test: it buys the confidence without doing the check`,
  );
});

test('nothing is declared unrunnable AND run at the same time', () => {
  // Two truths that contradict each other age into whichever one nobody reads.
  const patterns = ciPatterns();
  const both = Object.keys(CANNOT_RUN_IN_CI).filter((f) => patterns.some((p) => matches(p, f)));
  assert.deepEqual(both, [], 'declared as unrunnable in CI, yet ci.yml runs them');
});

test('the excuse list has no ghosts', () => {
  // A suite renamed or deleted leaves its excuse behind, and the excuse then covers a file that
  // does not exist while the real one goes unwatched. Same shape as the grandfathered entry that
  // outlived its module (module-toolkit#96).
  const ghosts = Object.keys(CANNOT_RUN_IN_CI).filter((f) => !SUITES.includes(f));
  assert.deepEqual(ghosts, [], 'CANNOT_RUN_IN_CI names files that are not in test/ any more');
});

test('every excuse says WHY, not just that there is one', () => {
  for (const [file, reason] of Object.entries(CANNOT_RUN_IN_CI)) {
    assert.ok(reason && reason.length > 10, `${file}: the reason has to be readable, got ${reason}`);
  }
});

/** The public packages the `for pkg in …` loop of ci.yml installs on the runner. */
function ciInstalledPackages() {
  const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const loop = /for pkg in ([^;\n]+); do/.exec(ci);
  assert.ok(loop, 'ci.yml installs its public packages through a `for pkg in …` loop');
  return loop[1].trim().split(/\s+/);
}

/** Whether `reason` names `name` as a whole word: `esbuild` yes, `@esbuild/x` or `esbuilder` no. */
function mentions(reason, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(^|[^\\w@/-])${escaped}($|[^\\w/-])`).test(reason);
}

test('no excuse blames something ci.yml already provides (module-toolkit#148)', () => {
  // The excuse that outlives its reason is the defect #148 found: a suite parked as «needs the
  // Rust toolchain» on a runner that installs Rust, never run by anyone. The reason is read for
  // the names of what CI provides; if it names one, the suite belongs in the `Tests` step.
  const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  const provided = ciInstalledPackages();
  if (/sh\.rustup\.rs/.test(ci)) provided.push('Rust', 'cargo');
  const stale = Object.entries(CANNOT_RUN_IN_CI)
    .filter(([, reason]) => provided.some((name) => mentions(reason, name)))
    .map(([file, reason]) => `${file}: «${reason}»`);
  assert.deepEqual(stale, [], `these excuses blame what ci.yml installs (${provided.join(', ')})`);
});

test('the stale-excuse check reads the install loop, not an empty list', () => {
  // Without this, a loop that stops matching turns the check above into green prose.
  assert.ok(ciInstalledPackages().includes('typescript'), 'typescript has been installed since #61');
});

// A suite that runs in CI can still check nothing there: module-toolkit#352. Three tests against the
// REAL tables and inventory modules read them from `../../modules-workspace/modules/<id>`, a sibling
// checkout no runner has, and `t.skip`ped on its absence — `skipped 3` behind a green check on every
// pull request, so the tables#25 and inventory#32 regressions were caught only on a laptop with the
// whole workspace. What a test needs from a real module is frozen under `test/fixtures/`; reaching
// for the sibling workspace from code is what this refuses.
const SIBLING_WORKSPACE = /['"`]\.\.\/\.\.\/modules-workspace\//;

/** Suites whose CODE (comments ignored) reaches for the sibling `modules-workspace` checkout. */
function suitesReachingForTheWorkspace(files) {
  return files.filter((f) =>
    readFileSync(join(REPO, 'test', f), 'utf8')
      .split('\n')
      .some((line) => !/^\s*(\/\/|\*)/.test(line) && SIBLING_WORKSPACE.test(line)),
  );
}

test('no suite depends on a sibling modules-workspace checkout CI never has (module-toolkit#352)', () => {
  assert.deepEqual(
    suitesReachingForTheWorkspace(SUITES),
    [],
    'these suites read a real module from ../../modules-workspace/: on a runner it is absent and ' +
      'the test skips behind a green check. Freeze what the test needs under test/fixtures/',
  );
});

test('the sibling-workspace check catches the shape it exists for (module-toolkit#352)', () => {
  // Control: the exact line the three skipped tests used, so a regex that stops matching cannot
  // turn the check above into a green that looks at nothing.
  // Split in two so this very file does not match its own check.
  const probe = "const TABLES = fileURLToPath(new URL('../../" + "modules-workspace/modules/tables/', import.meta.url));";
  assert.ok(SIBLING_WORKSPACE.test(probe));
  assert.ok(!SIBLING_WORKSPACE.test('// `modules-workspace/` is not a repo and has no workflows'));
});

test('ci.yml installs EVERY runtime dependency of the toolkit (module-toolkit#389)', () => {
  // `dependencies` is what `npm install @erplora/module-toolkit` gives a user, so it is what the
  // suites are entitled to import. Leaving one out does not fail on the laptop, where a full install
  // has it: it fails on CI — #389 moved `pack-outfitkit-floor` into the `Tests` step and its Lit
  // fixture died on «Could not resolve 'lit'», because `lit` was the one dependency never installed.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  const installed = ciInstalledPackages();
  const missing = Object.keys(pkg.dependencies).filter((name) => !installed.includes(name));
  assert.deepEqual(missing, [], `ci.yml does not install: ${missing.join(', ')}`);
});

// The self-hosted runner (ci-runner-1*) is a bare Ubuntu with no `zip`/`unzip`, and `erplora pack`
// shells out to `zip`. #389 moved `pack-outfitkit-floor` into the `Tests` step once its OutfitKit was
// installable, and it went red on «spawnSync zip ENOENT» — its excuse had named the wrong reason. A
// suite that needs those binaries stays out until ci.yml provides them.
const NEEDS_ZIP = /(['"])(?:un)?zip\1|\(\s*['"]pack['"]/;

test('no suite in the `Tests` step needs the zip binaries the runner lacks', () => {
  const ci = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  if (/\b(apt-get|apt) install[^\n]*\bzip\b/.test(ci)) return;
  const patterns = ciPatterns();
  const offenders = SUITES.filter((f) => f !== 'ci-runs-every-suite.test.mjs' && patterns.some((p) => matches(p, f))).filter((f) =>
    NEEDS_ZIP.test(readFileSync(join(REPO, 'test', f), 'utf8')),
  );
  assert.deepEqual(offenders, [], 'these suites run `pack`/`zip`/`unzip`, which ci-runner-1* does not have');
});

test('the zip detector recognises the calls it is there to catch', () => {
  // Control: without it a regex that stops matching turns the check above into green prose.
  assert.ok(NEEDS_ZIP.test("const res = erplora('pack', dir);"));
  assert.ok(NEEDS_ZIP.test("execFileSync('unzip', ['-p', zip])"));
  assert.ok(!NEEDS_ZIP.test("spawnSync('npm', ['pack'])"));
});

// `npm test` has to run the suites and nothing else (module-toolkit#400). A bare `node --test` leaves
// the choice to Node's default discovery, and that set moves with the Node version: from 22.18 type
// stripping is on without a flag and `**/test/**/*.ts` joins it, so the Lit fixture under
// `test/fixtures/real-modules/` ran as a test and failed on its decorators — red on every laptop,
// green on CI, which passes its own list. The script names its files, so the set is the same
// everywhere: every suite CI runs plus the ones declared in CANNOT_RUN_IN_CI, and no fixture.

/** The file patterns `scripts.test` hands to `node --test` (flags dropped). */
function npmTestPatterns(script) {
  const m = /^node --test(?:\s+(.*))?$/.exec(script.trim());
  assert.ok(m, `scripts.test is expected to be \`node --test <patterns>\`, got «${script}»`);
  return (m[1] ?? '').split(/\s+/).filter((a) => a && !a.startsWith('-'));
}

/** Every file under `test/`, fixtures included, as `a/b.ext` relative to `test/`. */
function allTestTreeFiles() {
  return readdirSync(join(REPO, 'test'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? e.path, e.name).slice(join(REPO, 'test').length + 1))
    .sort();
}

/** The files a script would run: what its patterns match in the `test/` tree. */
function npmTestFiles(script) {
  const patterns = npmTestPatterns(script);
  assert.ok(
    patterns.length > 0,
    'scripts.test runs `node --test` with no pattern: which files run is then up to the Node ' +
      'version (22.18+ also picks the .ts fixtures under test/), not to this repository',
  );
  for (const p of patterns) assert.ok(!p.includes('**'), `«${p}»: \`**\` would reach test/fixtures/`);
  return allTestTreeFiles().filter((f) => patterns.some((p) => matches(p, f)));
}

/** Fails unless `script` runs every suite in `test/` and nothing else. */
function assertRunsExactlyTheSuites(script) {
  assert.deepEqual(npmTestFiles(script), SUITES, `«${script}» does not run exactly the suites`);
}

test('`npm test` runs exactly the suites, never the fixtures (module-toolkit#400)', () => {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assertRunsExactlyTheSuites(pkg.scripts.test);
});

test('the npm-test check refuses the scripts that pick up fixtures (module-toolkit#400)', () => {
  // Control: the three shapes that reintroduce #400, so the check above cannot go green by
  // accepting anything.
  assert.throws(() => assertRunsExactlyTheSuites('node --test'), /no pattern/);
  assert.throws(() => assertRunsExactlyTheSuites("node --test 'test/**/*.test.mjs'"), /reach test\/fixtures/);
  assert.throws(() => assertRunsExactlyTheSuites('node --test test/*'), /does not run exactly/);
  assert.throws(() => assertRunsExactlyTheSuites('node --test test/validate-*.test.mjs'), /does not run exactly/);
  assert.ok(allTestTreeFiles().some((f) => f.startsWith('fixtures/') && f.endsWith('.ts')));
});
