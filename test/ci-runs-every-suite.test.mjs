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
 * `file:` paths into sibling checkouts that do not exist there — so anything reaching for esbuild,
 * lit or the workspace stays a local `node --test`.
 */
const CANNOT_RUN_IN_CI = {
  'build-entry.test.mjs': 'builds the bundle: needs esbuild',
  'dev-collect.test.mjs': 'serves the preview: needs esbuild + lit',
  'icons.test.mjs': 'needs @iconify-json/ion',
  'outfitkit-stamp.test.mjs': 'needs the @erplora/outfitkit checkout',
  'pack-include.test.mjs': 'packs a built module: needs esbuild',
  'scaffold.test.mjs': 'scaffolds and builds: needs esbuild + lit',
  'signing.test.mjs': 'signs a packed module: needs esbuild',
  'wasm.test.mjs': 'compiles a handler: needs the Rust toolchain',
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
