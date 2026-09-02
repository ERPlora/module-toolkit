// Regression test for ERPlora/module-toolkit#93 — the gate validated neither the PROVENANCE nor the
// FRESHNESS of `dist/<id>.esm.js`.
//
// The symptom, reproduced from real history: `ERPlora/verifactu@63039d3^:dist/verifactu.esm.js`
// carried 8 esbuild comments with an ABSOLUTE path into another agent's scratchpad
// (`/private/tmp/claude-501/…/scratchpad/vf40/ui/components/…`). Somebody built the bundle from a
// throwaway clone and committed the result; `erplora validate` said `bundle CSP-safe` and nothing
// else, because the only thing it ever read from the bundle was `assertCspSafe`.
//
// The sibling half is the one that bites in production: the bundle is published AS IS (the module
// zip ships `dist/` verbatim), so a PR that edits `ui/**` without running `erplora build` reaches
// no hub at all. Surveyed against `origin/main` of the 27 published modules on 2026-08-28, two were
// already in that state (`flows`, 3 days behind; `sales`, minutes).
//
// The freshness evidence is layered exactly like `wasm.mjs` does for the Tier-2 binary — stamp →
// git → mtime — because a publish gate that cries wolf gets ignored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  BUNDLE_MTIME_TOLERANCE_MS,
  bundleBuildStamp,
  bundleStampFile,
  checkBundleArtifact,
  checkBundleFreshness,
  checkBundleProvenance,
  collectUiSources,
  hashLocaleSources,
  hashUiSources,
  normalizeBundlePaths,
  stableSourcePath,
  stampBundle,
} from '../src/bundle-freshness.mjs';

// --- fixtures -------------------------------------------------------------------------------

const MANIFEST = { id: 'demo', name: 'Demo' };

/** A module dir with `ui/components/demo.ts` and a `dist/demo.esm.js` built from it. */
function moduleFixture({ bundle = 'export const x = 1;\n', ui = 'export class Demo {}\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mt93-'));
  mkdirSync(join(dir, 'ui', 'components'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), ui);
  writeFileSync(join(dir, 'dist', 'demo.esm.js'), bundle);
  return dir;
}

/** Sets mtimes so the bundle looks `ms` milliseconds older than every `ui/` source. */
function ageBundle(dir, ms) {
  const now = Date.now();
  utimesSync(join(dir, 'ui', 'components', 'demo.ts'), now / 1000, now / 1000);
  utimesSync(join(dir, 'dist', 'demo.esm.js'), (now - ms) / 1000, (now - ms) / 1000);
}

const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** Turns the fixture into a git repo with one commit per call to `commit`. */
function initGit(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@erplora.local');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

function commit(dir, message, date) {
  git(dir, 'add', '-A');
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', message], { encoding: 'utf8', env });
}

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

// --- provenance -----------------------------------------------------------------------------

test('mt#93: an absolute path baked into the bundle is an ERROR naming the path', () => {
  const dir = moduleFixture({
    bundle:
      '// /private/tmp/claude-501/-Users-x/2f9a9744/scratchpad/vf40/ui/components/erp-verifactu-records.ts\n' +
      'export const x = 1;\n',
  });
  const out = checkBundleProvenance(dir, MANIFEST);
  assert.equal(out.checked, true);
  assert.equal(out.errors.length, 1, `expected one provenance error, got ${JSON.stringify(out.errors)}`);
  assert.match(out.errors[0], /scratchpad\/vf40/);
  assert.match(out.errors[0], /module-toolkit#93/);
  cleanup(dir);
});

test('mt#93: the REAL verifactu path was RELATIVE into a scratchpad — it must still be caught', () => {
  // ERPlora/verifactu@63039d3^:dist/verifactu.esm.js, verbatim. Anchoring the rule on "absolute"
  // alone would have missed the very bundle that opened this issue.
  const dir = moduleFixture({
    bundle:
      '// ../../../../../../private/tmp/claude-501/-Users-ioan-beilic-workspace-code-ERPlora/' +
      '2f9a9744-b897-46f7-aa33-753a99fdd47b/scratchpad/vf40/ui/components/erp-verifactu-records.ts\n' +
      'export const x = 1;\n',
  });
  const out = checkBundleProvenance(dir, MANIFEST);
  assert.equal(out.errors.length, 1, JSON.stringify(out));
  assert.match(out.errors[0], /scratchpad\/vf40/);
  cleanup(dir);
});

test('mt#93: every shape of build-machine path is caught (/Users, /home, /var/folders, C:\\)', () => {
  for (const path of [
    '/Users/someone/workspace/ui/a.ts',
    '/home/runner/work/mod/ui/a.ts',
    '/var/folders/xy/T/tmp123/ui/a.ts',
    '/private/var/folders/xy/ui/a.ts',
    '/tmp/build-1234/ui/a.ts',
    'C:\\Users\\someone\\ui\\a.ts',
    // A scratchpad reached by a RELATIVE path with no temp dir in it: the only shape that needs the
    // `/scratchpad/` rule on its own (review of #114: dropping that rule left every test green).
    '../../scratchpad/vf40/ui/components/a.ts',
  ]) {
    const dir = moduleFixture({ bundle: `// ${path}\nexport const x = 1;\n` });
    const out = checkBundleProvenance(dir, MANIFEST);
    assert.equal(out.errors.length, 1, `not caught: ${path}`);
    cleanup(dir);
  }
});

test('mt#93: a bundle with only relative paths passes provenance', () => {
  const dir = moduleFixture({ bundle: '// ui/components/demo.ts\nexport const x = 1;\n' });
  const out = checkBundleProvenance(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  cleanup(dir);
});

test('mt#93: no bundle on disk means nothing to check (a module can be UI-less)', () => {
  const dir = moduleFixture();
  rmSync(join(dir, 'dist', 'demo.esm.js'));
  assert.equal(checkBundleProvenance(dir, MANIFEST).checked, false);
  assert.equal(checkBundleFreshness(dir, MANIFEST).checked, false);
  cleanup(dir);
});

// --- freshness: layer 1, the stamp ------------------------------------------------------------

test('mt#93: a stamp matching sources and bundle is FRESH', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  ageBundle(dir, 10 * 86400000); // the stamp outranks mtimes on purpose
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.checked, true);
  cleanup(dir);
});

test('mt#93: a ui/ edit after the stamped build is an ERROR naming the newest file and the fix', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { moved = true; }\n');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.errors.length, 1, JSON.stringify(out));
  assert.match(out.errors[0], /dist\/demo\.esm\.js/);
  assert.match(out.errors[0], /ui\/components\/demo\.ts/);
  assert.match(out.errors[0], /erplora build/);
  cleanup(dir);
});

test('mt#93: a bundle replaced by hand after the stamped build is an ERROR', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'dist', 'demo.esm.js'), 'export const x = 2;\n');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.errors.length, 1, JSON.stringify(out));
  assert.match(out.errors[0], /demo\.build\.json/);
  cleanup(dir);
});

test('mt#93: a corrupt or foreign stamp proves nothing — it falls through, it does not crash', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), '{ not json');
  assert.doesNotThrow(() => checkBundleFreshness(dir, MANIFEST));
  cleanup(dir);
});

test('mt#93: the stamp ignores ui/ test files, which never enter the bundle', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'ui', 'components', 'demo.test.ts'), 'it("x", () => {});\n');
  assert.deepEqual(checkBundleFreshness(dir, MANIFEST).errors, []);
  assert.ok(!collectUiSources(dir).some((p) => p.endsWith('.test.ts')));
  cleanup(dir);
});

// --- freshness: layer 2, git (must outrank mtime) ---------------------------------------------

test('mt#93: on a fresh clone with no stamp, an untouched module is NOT flagged', () => {
  // Every mtime equals checkout time, so the mtime layer alone would say "same age" — but the point
  // of the brief is that the 27 published modules must not go red for cloning the repo.
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  cleanup(dir);
});

test('mt#93: git history outranks mtime — ui/ committed after the bundle is stale even when mtimes lie', () => {
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'bundle', '2026-01-01T10:00:00Z');
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { v = 2; }\n');
  commit(dir, 'ui sin rebuild', '2026-01-08T10:00:00Z');
  ageBundle(dir, -60000); // bundle mtime NEWER than the source: mtime alone would say "fresh"
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.warnings.length, 1, JSON.stringify(out));
  assert.match(out.warnings[0], /7 día\(s\)/);
  // The message must name the FILE, not the directory: "ui/ changed" sends the author looking.
  assert.match(out.warnings[0], /ui\/components\/demo\.ts/);
  assert.match(out.warnings[0], /erplora build/);
  cleanup(dir);
});

test('mt#93: uncommitted ui/ changes with an untouched bundle are stale', () => {
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { v = 3; }\n');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.warnings.length + out.errors.length, 1, JSON.stringify(out));
  cleanup(dir);
});

// --- freshness: layer 3, mtime, and the grandfather ratchet -----------------------------------

test('mt#93: without git and without a stamp, an old bundle is a WARNING, not an error (ratchet)', () => {
  const dir = moduleFixture();
  ageBundle(dir, 3 * 86400000);
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, [], 'a module that never built with a stamping toolkit must not go red');
  assert.equal(out.warnings.length, 1, JSON.stringify(out));
  assert.match(out.warnings[0], /ui\/components\/demo\.ts/);
  assert.match(out.warnings[0], /erplora build/);
  cleanup(dir);
});

test('mt#93: the same lag WITH a stale stamp is an ERROR — the ratchet closes once the module builds', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { v = 4; }\n');
  ageBundle(dir, 3 * 86400000);
  assert.equal(checkBundleFreshness(dir, MANIFEST).errors.length, 1);
  cleanup(dir);
});

test('mt#93: a lag under the clone tolerance is not stale', () => {
  const dir = moduleFixture();
  ageBundle(dir, BUNDLE_MTIME_TOLERANCE_MS / 2);
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  cleanup(dir);
});

// --- the stamp writer -------------------------------------------------------------------------

test('mt#93: stampBundle writes dist/<id>.build.json and makes the module fresh', () => {
  const dir = moduleFixture();
  ageBundle(dir, 5 * 86400000);
  assert.equal(checkBundleFreshness(dir, MANIFEST).warnings.length, 1);

  const written = stampBundle(dir, MANIFEST);
  assert.equal(written, join(dir, bundleStampFile('demo')));
  assert.ok(existsSync(written));
  const stamp = JSON.parse(readFileSync(written, 'utf8'));
  assert.equal(stamp.file, 'dist/demo.esm.js');
  assert.equal(stamp.sources_sha256, hashUiSources(dir));
  assert.match(stamp.built_at, /^\d{4}-\d\d-\d\dT/);

  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  cleanup(dir);
});

// --- the combined report `erplora validate` consumes -------------------------------------------

test('mt#93: checkBundleArtifact joins provenance and freshness', () => {
  const dir = moduleFixture({ bundle: '// /Users/someone/scratch/ui/a.ts\nexport const x = 1;\n' });
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { v = 5; }\n');
  const out = checkBundleArtifact(dir, MANIFEST);
  assert.equal(out.checked, true);
  assert.equal(out.errors.length, 2, JSON.stringify(out));
  cleanup(dir);
});

// --- normalisation: the root cause, at build time ----------------------------------------------

test('mt#93: a RELATIVE path that merely contains /Users/ is not a build-machine path', () => {
  // esbuild prints `../../../../Users/…` when the build ran far from the module. Ugly, but it is
  // the same string on every machine — flagging it would fire the guard on reproducible bundles.
  const dir = moduleFixture({ bundle: '// ../../../../Users/x/ERPlora/outfitkit/dist/define.js\nexport const x = 1;\n' });
  assert.deepEqual(checkBundleProvenance(dir, MANIFEST).errors, []);
  cleanup(dir);
});

test('mt#93: stableSourcePath names a module file relative to the module', () => {
  const dir = moduleFixture();
  assert.equal(stableSourcePath(join(dir, 'ui', 'components', 'demo.ts'), dir), 'ui/components/demo.ts');
  cleanup(dir);
});

test('mt#93: stableSourcePath names a dependency by its package, not by where it is installed', () => {
  const dir = moduleFixture();
  const pkgDir = join(dir, 'vendor-elsewhere', 'node_modules', '.pnpm', 'lit-html@3.3.3', 'lit-html');
  mkdirSync(join(pkgDir, 'lib'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'lit-html' }));
  writeFileSync(join(pkgDir, 'lib', 'render.js'), 'export const r = 1;\n');
  assert.equal(stableSourcePath(join(pkgDir, 'lib', 'render.js'), '/nowhere'), 'lit-html/lib/render.js');
  cleanup(dir);
});

test('mt#93: normalizeBundlePaths rewrites the esbuild annotations and leaves prose alone', () => {
  const dir = moduleFixture();
  const abs = join(dir, 'ui', 'components', 'demo.ts');
  const code = `// ${abs}\n// esto NO es una ruta y no se toca\n// /Users/nadie/no-existe.ts\nexport const x = 1;\n`;
  const out = normalizeBundlePaths(code, dir, { cwd: '/' });
  assert.match(out, /^\/\/ ui\/components\/demo\.ts$/m);
  assert.match(out, /^\/\/ esto NO es una ruta y no se toca$/m);
  assert.match(out, /^\/\/ \/Users\/nadie\/no-existe\.ts$/m, 'a path that does not exist is not a build annotation');
  cleanup(dir);
});

test('mt#93: a bundle normalized from ANY working directory passes provenance', () => {
  const dir = moduleFixture();
  const abs = join(dir, 'ui', 'components', 'demo.ts');
  writeFileSync(join(dir, 'dist', 'demo.esm.js'), normalizeBundlePaths(`// ${abs}\nexport const x = 1;\n`, dir, { cwd: '/' }));
  assert.deepEqual(checkBundleProvenance(dir, MANIFEST).errors, []);
  cleanup(dir);
});

test('mt#93: a commit that only touches a ui/ test does not make the bundle stale', () => {
  // The sweep over the 27 published modules produced exactly two warnings, and BOTH named a
  // `.test.ts` — files `collectTs` provably keeps out of the bundle. A gate that cries wolf twice
  // out of two is a gate nobody reads.
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  writeFileSync(join(dir, 'ui', 'components', 'demo.test.ts'), 'it("x", () => {});\n');
  commit(dir, 'solo tests', '2026-02-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.warnings, [], JSON.stringify(out));
  assert.deepEqual(out.errors, []);
  cleanup(dir);
});

test('mt#93: with the test commit AND a real ui/ commit, it is still stale', () => {
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  writeFileSync(join(dir, 'ui', 'components', 'demo.test.ts'), 'it("x", () => {});\n');
  writeFileSync(join(dir, 'ui', 'components', 'demo.ts'), 'export class Demo { v = 9; }\n');
  commit(dir, 'ui sin rebuild', '2026-02-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.warnings.length, 1, JSON.stringify(out));
  assert.match(out.warnings[0], /ui\/components\/demo\.ts/);
  cleanup(dir);
});

// --- review of PR #114: test-support DIRECTORIES never enter the bundle either ------------------
//
// `collectTs` (build.mjs) walks `ui/components/` only, and a file under `ui/test/` is imported by
// tests alone. Swept over the 27 published modules from a FRESH clone (2026-08-28), `sales` was
// flagged because `ui/test/erplora-double.ts` (a shared test double) was committed 45 min after
// the bundle — and once `sales` gains a stamp, that same edit would be an ERROR. Same reason the
// `*.test.ts` exclusion exists: a commit that provably cannot change a byte of the artifact must
// not make it stale (module-toolkit#93).

test('mt#93: a file under ui/test/ is not a bundle source — the stamp ignores it', () => {
  const dir = moduleFixture();
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  mkdirSync(join(dir, 'ui', 'test'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'test', 'erplora-double.ts'), 'export const double = 1;\n');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, [], JSON.stringify(out));
  assert.ok(!collectUiSources(dir).some((p) => p.includes(`${sep}test${sep}`)), 'ui/test/ must not be collected');
  cleanup(dir);
});

test('mt#93: a commit that only touches ui/test/ does not make the bundle stale (git layer)', () => {
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  mkdirSync(join(dir, 'ui', 'test'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'test', 'erplora-double.ts'), 'export const double = 1;\n');
  commit(dir, 'solo el doble de tests', '2026-02-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.warnings, [], JSON.stringify(out));
  assert.deepEqual(out.errors, []);
  cleanup(dir);
});

test('mt#93: ui/lib/ IS a bundle source — a commit there still makes the bundle stale', () => {
  // The guard against the exclusion over-reaching: 15 of the 27 published modules keep real,
  // component-imported code under `ui/lib/`.
  const dir = moduleFixture();
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  mkdirSync(join(dir, 'ui', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'lib', 'money.ts'), 'export const cents = 1;\n');
  commit(dir, 'lib sin rebuild', '2026-02-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.warnings.length, 1, JSON.stringify(out));
  assert.match(out.warnings[0], /ui\/lib\/money\.ts/);
  cleanup(dir);
});

// --- `locales/` is a bundle source too (module-toolkit#158) -------------------------------------
//
// The half of the pattern the #93 stamp did NOT cover. Every one of the 27 published modules writes
// `import esLocale from '../../../locales/es.json'` in its component, so esbuild INLINES the
// catalogue into `dist/<id>.esm.js` — a merge that only touches `locales/**` changes what the screen
// says and leaves the artifact behind. It is not hypothetical and it is not rare: `locales/**` is a
// trigger path of `release.yml`, so such a merge bumps the version and republishes, and a sweep of
// `origin/main` on 2026-09-02 found **65 commits in 60 days**, across all 27 repos, that touched
// `locales/` without touching `dist/` (`cash_register#69` is the one that was caught by hand).
//
// The ratchet of #93 is kept exactly: a stamp written before this change carries no
// `locales_sha256`, and a module is never turned red for a change of ours — it is grandfathered
// until it builds once more.

/** Adds a `locales/` catalogue to a fixture, the way all 27 published modules carry one. */
function withLocales(dir, es = { hello: 'hola' }) {
  mkdirSync(join(dir, 'locales'), { recursive: true });
  writeFileSync(join(dir, 'locales', 'es.json'), `${JSON.stringify(es, null, 2)}\n`);
  writeFileSync(join(dir, 'locales', 'en.json'), `${JSON.stringify({ hello: 'hello' }, null, 2)}\n`);
  return dir;
}

test('mt#158: a locales/ edit after the stamped build is an ERROR — the catalogue is inlined', () => {
  const dir = withLocales(moduleFixture());
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(bundleBuildStamp(dir, MANIFEST)));
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ hello: 'buenas' }));
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.errors.length, 1, JSON.stringify(out));
  assert.match(out.errors[0], /locales/);
  assert.match(out.errors[0], /erplora build/);
  cleanup(dir);
});

test('mt#158: stampBundle records the catalogue hash, and an untouched module stays fresh', () => {
  const dir = withLocales(moduleFixture());
  const written = stampBundle(dir, MANIFEST);
  const stamp = JSON.parse(readFileSync(written, 'utf8'));
  assert.equal(stamp.locales_sha256, hashLocaleSources(dir));
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.warnings, []);
  cleanup(dir);
});

test('mt#158: RATCHET — a stamp written before this change (no locales_sha256) is NOT turned red', () => {
  // The 8 modules that already carry a #93 stamp must not go red for a change of ours. Their stamp
  // simply does not speak about locales, so the catalogue is not checked until they build again.
  const dir = withLocales(moduleFixture());
  const legacy = bundleBuildStamp(dir, MANIFEST);
  delete legacy.locales_sha256;
  writeFileSync(join(dir, bundleStampFile('demo')), JSON.stringify(legacy));
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ hello: 'buenas' }));
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.deepEqual(out.errors, [], JSON.stringify(out));
  cleanup(dir);
});

test('mt#158: without a stamp, git sees a locales-only commit — the ratchet keeps it a WARNING', () => {
  const dir = withLocales(moduleFixture());
  initGit(dir);
  commit(dir, 'inicial', '2026-01-01T10:00:00Z');
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ hello: 'buenas' }));
  commit(dir, 'traducción sin rebuild', '2026-02-01T10:00:00Z');
  const out = checkBundleFreshness(dir, MANIFEST);
  assert.equal(out.warnings.length, 1, JSON.stringify(out));
  assert.match(out.warnings[0], /locales\/es\.json/);
  assert.deepEqual(out.errors, []);
  cleanup(dir);
});

test('mt#158: a module with NO locales/ is unaffected — nothing to hash, nothing to flag', () => {
  const dir = moduleFixture();
  const written = stampBundle(dir, MANIFEST);
  const stamp = JSON.parse(readFileSync(written, 'utf8'));
  assert.equal(stamp.locales_sha256, hashLocaleSources(dir));
  assert.deepEqual(checkBundleFreshness(dir, MANIFEST).errors, []);
  assert.deepEqual(checkBundleFreshness(dir, MANIFEST).warnings, []);
  cleanup(dir);
});

test('mt#158: the catalogue hash does not disturb the ui/ hash — old stamps still match on ui/', () => {
  // `sources_sha256` keeps meaning exactly what it meant, so the 8 stamps already published stay
  // valid evidence about `ui/`. Anything else would turn 8 repos red for a change of ours.
  const dir = withLocales(moduleFixture());
  const before = hashUiSources(dir);
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify({ hello: 'buenas' }));
  assert.equal(hashUiSources(dir), before);
  cleanup(dir);
});
