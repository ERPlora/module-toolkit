// `erplora build --check`: the committed `dist/<id>.esm.js` has to be what the module's `ui/` gives
// when rebuilt against hub develop's module SDK — module-toolkit#389.
//
// The hole: a module's pull request carries its bundle already built, and the gate only ran
// `validate` (which checks WHICH `ui/` produced it, #93) and `test` (which runs the `.test.ts`
// against develop's SDK). Nothing compared the shipped bytes with a rebuild, so a bundle baked with
// an old SDK — the four rebuilds of 2026-09-27 that took the list controller back to filtering money
// in cents — merged green: the tests checked develop's SDK, the hubs got the old one. #387 closed
// the local door (`erplora build` refuses a checkout behind develop); this is the gate's door, the
// one a bundle built offline, with an older toolkit or from a copy of the SDK that is not the hub's
// still walks through.
//
// No network and no lit: the fixture module imports only `@erplora/module-sdk`, and each SDK is a
// directory on disk handed over with `sdkDir` — the same way the gate hands over develop's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDistReproducible, checkDistReproducible, resolvedOutfitkitVersion } from '../src/dist-reproducible.mjs';
import { bundleWebComponent } from '../src/bundle-web-component.mjs';

const CLI = fileURLToPath(new URL('../bin/erplora.mjs', import.meta.url));

const OLD_CONTROLLER = 'export const moneyFilter = (v) => v; // cents, the bug\n';
const FIXED_CONTROLLER =
  "export const moneyFilter = (v, d) => { if (d == null) throw new Error('list_money_filters_need_currency_decimals'); return v * 10 ** d; };\n";

function write(root, file, body) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** An SDK directory the shape of the hub's `packages/module-sdk` (+ its `module-types` sibling). */
function sdk(root, name, controller) {
  const dir = join(root, name, 'packages', 'module-sdk');
  write(dir, 'package.json', '{"name":"@erplora/module-sdk","main":"src/index.ts"}\n');
  write(dir, 'src/index.ts', controller);
  write(join(root, name, 'packages', 'module-types'), 'package.json', '{"name":"@erplora/module-types","types":"src/index.ts"}\n');
  write(join(root, name, 'packages', 'module-types'), 'src/index.ts', 'export type Row = Record<string, unknown>;\n');
  return dir;
}

/**
 * A module whose Web Component uses the SDK's money filter, its bundle built with `builtWith` and
 * sealed with OutfitKit `sealed` (null: no seal, a bundle from before the seal existed).
 */
async function fixture({ builtWith = 'old', sealed = '0.1.79' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-dist-repro-'));
  const sdks = { old: sdk(root, 'hub-old', OLD_CONTROLLER), develop: sdk(root, 'hub-develop', FIXED_CONTROLLER) };
  const mod = join(root, 'demo');
  write(mod, 'module.json', '{"id":"demo","version":"1.0.0"}\n');
  write(
    mod,
    'ui/components/erp-demo/erp-demo.ts',
    "import { moneyFilter } from '@erplora/module-sdk';\nimport type { Row } from '@erplora/module-types';\n" +
      'export const filter = (row: Row) => moneyFilter(Number(row.total), 2);\n',
  );
  mkdirSync(join(mod, 'dist'), { recursive: true });
  const dist = join(mod, 'dist', 'demo.esm.js');
  await bundleWebComponent(mod, 'demo', dist, { sdkDir: sdks[builtWith] });
  if (sealed) write(mod, 'dist/outfitkit.json', `${JSON.stringify({ outfitkit: sealed }, null, 2)}\n`);
  return { root, mod, dist, sdks };
}

// The seal of the fixtures and the OutfitKit the "toolkit" resolves, so the SDK is the only variable.
const SAME_OUTFITKIT = { outfitkitVersion: '0.1.79' };

test('a bundle built with an OLD SDK is not what develop gives: red, and dist/ is left untouched', async () => {
  const f = await fixture({ builtWith: 'old' });
  try {
    // The positive control: the committed bundle really lacks develop's fix.
    const before = readFileSync(f.dist, 'utf8');
    assert.ok(!before.includes('list_money_filters_need_currency_decimals'));

    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'differs');
    assert.equal(result.file, 'dist/demo.esm.js');
    assert.ok(result.line > 0, 'it says where the bytes start to differ');

    await assert.rejects(
      assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT }),
      (e) => e.code === 'dist_not_reproducible' && e.fix === `erplora build ${f.mod}`,
    );
    assert.equal(readFileSync(f.dist, 'utf8'), before, 'the check never rewrites the committed bundle');
    assert.deepEqual(readdirSync(join(f.mod, 'dist')).sort(), ['demo.esm.js', 'outfitkit.json']);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a bundle built with develop SDK is reproducible byte for byte', async () => {
  const f = await fixture({ builtWith: 'develop' });
  try {
    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'reproducible');
    await assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a bundle sealed with ANOTHER OutfitKit cannot be judged by a rebuild: red, naming the version to install', async () => {
  // Otherwise a difference in OutfitKit would be blamed on the SDK, or — worse — two different
  // bundles would be compared and the verdict would be noise.
  const f = await fixture({ builtWith: 'develop', sealed: '0.1.70' });
  try {
    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'outfitkit_mismatch');
    assert.equal(result.sealed, '0.1.70');
    assert.equal(result.resolved, '0.1.79');
    await assert.rejects(
      assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT }),
      (e) => e.code === 'dist_outfitkit_mismatch' && e.message.includes('@erplora/outfitkit@0.1.70'),
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a bundle without the OutfitKit seal is red: nothing says what it was built with', async () => {
  const f = await fixture({ builtWith: 'develop', sealed: null });
  try {
    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'unsealed');
    await assert.rejects(
      assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT }),
      (e) => e.code === 'dist_unsealed' && e.fix === `erplora build ${f.mod}`,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a Web Component with no committed bundle is red', async () => {
  const f = await fixture({ builtWith: 'develop' });
  try {
    rmSync(f.dist);
    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'missing');
    await assert.rejects(
      assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT }),
      (e) => e.code === 'dist_missing',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a module with no Web Component has no bundle to compare, and that is not an error', async () => {
  const f = await fixture({ builtWith: 'develop' });
  try {
    rmSync(join(f.mod, 'ui'), { recursive: true });
    rmSync(join(f.mod, 'dist'), { recursive: true });
    const result = await checkDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
    assert.equal(result.status, 'no_web_component');
    await assertDistReproducible(f.mod, { sdkDir: f.sdks.develop, ...SAME_OUTFITKIT });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the SDK the check rebuilds with goes through the #387 freshness door: a hub checkout behind develop is refused', async () => {
  // Locally the reference must not be the stale checkout itself — comparing an old bundle with an
  // old rebuild would say «reproducible» about exactly the bundle #387 is about.
  const f = await fixture({ builtWith: 'old' });
  try {
    const hub = join(f.root, 'hub-old');
    const git = (...args) => {
      const r = spawnSync('git', ['-C', hub, ...args], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const commit = (m) => git('-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-am', m);
    spawnSync('git', ['init', '-q', '-b', 'develop', hub]);
    git('add', '-A');
    commit('base');
    git('branch', 'stale');
    writeFileSync(join(f.sdks.old, 'src', 'index.ts'), FIXED_CONTROLLER);
    commit('module-sdk: money filters scale by currency decimals');
    const develop = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'stale');

    await assert.rejects(
      checkDistReproducible(f.mod, { sdkDir: f.sdks.old, developSha: develop, env: {}, ...SAME_OUTFITKIT }),
      (e) => e.code === 'module_sdk_behind_develop',
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('`erplora build <dir> --check --sdk <dir>`: exit 1 with the code on an old bundle, exit 0 on a fresh one', async () => {
  // Sealed with the OutfitKit the toolkit itself resolves, so the SDK is the only variable.
  const sealed = resolvedOutfitkitVersion();
  assert.ok(sealed, 'the toolkit must resolve an OutfitKit for this test (CI installs it)');
  const stale = await fixture({ builtWith: 'old', sealed });
  const fresh = await fixture({ builtWith: 'develop', sealed });
  try {
    const red = spawnSync(process.execPath, [CLI, 'build', stale.mod, '--check', '--sdk', stale.sdks.develop], { encoding: 'utf8' });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /dist_not_reproducible/);
    assert.ok(red.stderr.includes(`erplora build ${stale.mod}`), 'it prints the command that regenerates it');
    assert.ok(!readFileSync(stale.dist, 'utf8').includes('currency_decimals'), 'the CLI check did not rebuild dist/ either');

    const green = spawnSync(process.execPath, [CLI, 'build', fresh.mod, '--check', '--sdk', fresh.sdks.develop], { encoding: 'utf8' });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /✓ dist demo: dist\/demo\.esm\.js/);
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
    rmSync(fresh.root, { recursive: true, force: true });
  }
});
