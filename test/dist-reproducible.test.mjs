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
// directory on disk handed over with `sdkDir` — the same way the gate hands over develop's. The
// OutfitKit the check fetches for the seal (module-toolkit#423) comes from a private cache already
// holding it, and `build` asks a fake `npm` on PATH which one is `latest`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDistReproducible, checkDistReproducible } from '../src/dist-reproducible.mjs';
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

// The fixtures' seal is the OutfitKit the rebuild gets, so the SDK is the only variable: a private
// cache that already holds it (the check fetches nothing) and a fake `npm` that calls it `latest`
// (what `build` bakes). Shared by every test in the file; removed when the process exits.
const OK_ROOT = mkdtempSync(join(tmpdir(), 'erplora-dist-repro-ok-'));
write(join(OK_ROOT, 'cache', '0.1.79', 'node_modules', '@erplora', 'outfitkit'), 'package.json', '{"name":"@erplora/outfitkit","version":"0.1.79"}\n');
write(join(OK_ROOT, 'bin'), 'npm', '#!/usr/bin/env bash\n[ "$1" = view ] && { echo \'"0.1.79"\'; exit 0; }\nexit 1\n');
chmodSync(join(OK_ROOT, 'bin', 'npm'), 0o755);
process.on('exit', () => rmSync(OK_ROOT, { recursive: true, force: true }));
const OK_ENV = { ...process.env, PATH: `${join(OK_ROOT, 'bin')}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(OK_ROOT, 'cache') };
const SAME_OUTFITKIT = { outfitkit: { env: OK_ENV } };

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

// A seal npm cannot give (`dist_outfitkit_unavailable`) and a rebuild with the SEALED OutfitKit
// rather than the toolkit's own: test/outfitkit-ci.test.mjs (module-toolkit#423). The old verdict,
// «the toolkit resolves another version, refuse to compare», is gone with the local copy.

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
  // Sealed with the OutfitKit the private cache holds, so the SDK is the only variable.
  const sealed = '0.1.79';
  const stale = await fixture({ builtWith: 'old', sealed });
  const fresh = await fixture({ builtWith: 'develop', sealed });
  try {
    const red = spawnSync(process.execPath, [CLI, 'build', stale.mod, '--check', '--sdk', stale.sdks.develop], { encoding: 'utf8', env: OK_ENV });
    assert.equal(red.status, 1, red.stdout + red.stderr);
    assert.match(red.stderr, /dist_not_reproducible/);
    assert.ok(red.stderr.includes(`erplora build ${stale.mod}`), 'it prints the command that regenerates it');
    assert.ok(!readFileSync(stale.dist, 'utf8').includes('currency_decimals'), 'the CLI check did not rebuild dist/ either');

    const green = spawnSync(process.execPath, [CLI, 'build', fresh.mod, '--check', '--sdk', fresh.sdks.develop], { encoding: 'utf8', env: OK_ENV });
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /✓ dist demo: dist\/demo\.esm\.js/);

    // The `--sdk=<dir>` spelling is the same flag (rv-393): it has to hand over the SAME SDK.
    const equals = spawnSync(process.execPath, [CLI, 'build', fresh.mod, '--check', `--sdk=${fresh.sdks.develop}`], { encoding: 'utf8', env: OK_ENV });
    assert.equal(equals.status, 0, equals.stdout + equals.stderr);
  } finally {
    rmSync(stale.root, { recursive: true, force: true });
    rmSync(fresh.root, { recursive: true, force: true });
  }
});

// module-toolkit#392: the SDK moves on hub develop every few hours, and every move leaves the
// committed bundle of every module behind it. Rebaking them all has to be one command that bakes
// THE SDK it is handed — until this, `build --sdk <dir>` took the flag and baked whatever SDK the
// toolkit resolved, so the only way to bake develop's was to re-point the toolkit's node_modules.
test('`erplora build <dir> --sdk <dir>` bakes THAT SDK: the gate\'s rebuild matches it right after', async () => {
  const f = await fixture({ builtWith: 'old' });
  try {
    const built = spawnSync(process.execPath, [CLI, 'build', f.mod, '--sdk', f.sdks.develop], { encoding: 'utf8', env: OK_ENV });
    assert.equal(built.status, 0, built.stderr + built.stdout);
    assert.match(readFileSync(f.dist, 'utf8'), /list_money_filters_need_currency_decimals/);
    const check = spawnSync(process.execPath, [CLI, 'build', f.mod, '--check', '--sdk', f.sdks.develop], { encoding: 'utf8', env: OK_ENV });
    assert.equal(check.status, 0, check.stderr + check.stdout);

    // And back: the flag is what decides, not whatever the toolkit happens to resolve.
    const old = spawnSync(process.execPath, [CLI, 'build', f.mod, `--sdk=${f.sdks.old}`], { encoding: 'utf8', env: OK_ENV });
    assert.equal(old.status, 0, old.stderr + old.stdout);
    assert.doesNotMatch(readFileSync(f.dist, 'utf8'), /list_money_filters_need_currency_decimals/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
