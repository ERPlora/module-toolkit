// Where the build finds `@erplora/module-sdk` — module-toolkit#359.
//
// Two copies can exist: the INSTALLED one (in the monorepo, the devDependency link to the hub; in a
// module gate, the hub's `module-sdk` action) and the one the npm package carries in `vendor/`. The
// installed one has to win: the gate and the monorepo build against the hub they were given
// (module-toolkit#99), and a vendored copy quietly taking over would test a module against an SDK
// nobody chose. `vendor/` is only for the install that has nothing else — a vendor's `npm install`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePinned } from '../src/resolve-plugin.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'erplora-resolve-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A `vendor/@erplora/` holding the SDK as `prepack` leaves it. */
function vendorRoot(name) {
  const root = join(scratch, name);
  mkdirSync(join(root, 'module-sdk', 'src'), { recursive: true });
  writeFileSync(join(root, 'module-sdk', 'package.json'), JSON.stringify({ main: 'src/index.ts' }));
  writeFileSync(join(root, 'module-sdk', 'src', 'index.ts'), 'export {};\n');
  writeFileSync(join(root, 'module-sdk', 'src', 'quantity.ts'), 'export {};\n');
  mkdirSync(join(root, 'module-types', 'src'), { recursive: true });
  writeFileSync(join(root, 'module-types', 'package.json'), JSON.stringify({ types: 'src/index.ts' }));
  writeFileSync(join(root, 'module-types', 'src', 'index.ts'), 'export {};\n');
  return root;
}

const notInstalled = () => {
  throw Object.assign(new Error("Cannot find package '@erplora/module-sdk'"), { code: 'ERR_MODULE_NOT_FOUND' });
};

test('an installed SDK wins over the copy the package carries', () => {
  const installed = join(scratch, 'hub', 'packages', 'module-sdk', 'src', 'index.ts');
  const path = resolvePinned('@erplora/module-sdk', {
    resolve: () => `file://${installed}`,
    vendorRoot: vendorRoot('vendor-both'),
  });
  assert.equal(path, installed);
});

test('with no SDK installed, the carried copy is used, through its package.json main', () => {
  const root = vendorRoot('vendor-only');
  assert.equal(resolvePinned('@erplora/module-sdk', { resolve: notInstalled, vendorRoot: root }), join(root, 'module-sdk', 'src', 'index.ts'));
  assert.equal(resolvePinned('@erplora/module-types', { resolve: notInstalled, vendorRoot: root }), join(root, 'module-types', 'src', 'index.ts'));
  assert.equal(
    resolvePinned('@erplora/module-sdk/src/quantity.ts', { resolve: notInstalled, vendorRoot: root }),
    join(root, 'module-sdk', 'src', 'quantity.ts'),
  );
});

test('nothing installed and nothing carried is the resolution error, not a guessed path', () => {
  assert.throws(
    () => resolvePinned('@erplora/module-sdk', { resolve: notInstalled, vendorRoot: join(scratch, 'no-vendor') }),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
});

test('only the hub packages fall back: a missing lit or OutfitKit stays an error', () => {
  const root = vendorRoot('vendor-lit');
  // Copies that WOULD be picked up if the fallback reached past the hub packages.
  for (const [dir, main] of [['lit', 'index.js'], ['outfitkit', 'define']]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ main }));
    writeFileSync(join(root, dir, main), 'export {};\n');
  }
  for (const spec of ['lit', '@erplora/outfitkit/define']) {
    assert.throws(() => resolvePinned(spec, { resolve: notInstalled, vendorRoot: root }), { code: 'ERR_MODULE_NOT_FOUND' });
  }
});

// ── `sdkDir`: the SDK the module gate hands over (module-toolkit#389) ──────────────────────────
// `build --check` rebuilds a bundle with hub develop's SDK to compare it with the committed one. If
// that directory does not hold the package, falling back to whatever SDK the toolkit has installed
// would compare against ANOTHER SDK in silence — the check would vouch for a bundle nobody rebuilt
// with develop. It has to be a resolution error instead.

/** The `onResolve` callback the plugin registers, driven without esbuild. */
async function resolveWith(sdkDir, spec) {
  const { erploraResolvePlugin } = await import('../src/resolve-plugin.mjs');
  let callback;
  erploraResolvePlugin({ sdkDir }).setup({ onResolve: (_opts, cb) => { callback = cb; } });
  return callback({ path: spec });
}

test('the SDK handed over is the one resolved, never the installed one', async () => {
  const sdk = join(vendorRoot('handed-over'), 'module-sdk');
  const res = await resolveWith(sdk, '@erplora/module-sdk');
  assert.equal(res.path, join(sdk, 'src', 'index.ts'));
});

test('the module-types a handed-over SDK bakes is its SIBLING, not the SDK itself nor the installed one (rv-393)', async () => {
  const root = vendorRoot('handed-over-types');
  const res = await resolveWith(join(root, 'module-sdk'), '@erplora/module-types');
  assert.equal(res.path, join(root, 'module-types', 'src', 'index.ts'));
});

test('a handed-over directory without the SDK is an error, not a fallback to the installed SDK', async () => {
  const empty = join(scratch, 'no-sdk-here');
  mkdirSync(empty, { recursive: true });
  const res = await resolveWith(empty, '@erplora/module-sdk');
  assert.equal(res.path, undefined, `it resolved ${res.path} although the SDK it was told to use is not there`);
  assert.equal(res.errors?.length, 1);
});

// A module's UI imports the toolkit's own runtime pieces (`@erplora/module-toolkit/money-input`,
// ERPlora/combos#9). The module gate builds BEFORE it links the toolkit into the module's
// node_modules, and a vendor's module may not have it linked at all — so the build has to resolve
// them from the toolkit that is building, the same way it pins lit and the SDK. Two versions of the
// piece (the one a test imported, another the bundle baked) is what this avoids.

/** The `onResolve` registration itself: its filter and its callback. */
async function registration(sdkDir) {
  const { erploraResolvePlugin } = await import('../src/resolve-plugin.mjs');
  let filter;
  let callback;
  erploraResolvePlugin({ sdkDir }).setup({ onResolve: (opts, cb) => { filter = opts.filter; callback = cb; } });
  return { filter, callback };
}

const TOOLKIT_SRC = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

test('the toolkit\'s runtime pieces are pinned to the toolkit that builds (combos#9)', async () => {
  const { filter, callback } = await registration(undefined);
  assert.ok(filter.test('@erplora/module-toolkit/money-input'), 'the plugin does not intercept the toolkit');
  assert.equal(callback({ path: '@erplora/module-toolkit/money-input' }).path, join(TOOLKIT_SRC, 'money-input.mjs'));
});

test('a handed-over SDK does not redirect the toolkit\'s own pieces', async () => {
  const sdk = join(vendorRoot('handed-over-toolkit'), 'module-sdk');
  const { callback } = await registration(sdk);
  assert.equal(callback({ path: '@erplora/module-toolkit/money-input' }).path, join(TOOLKIT_SRC, 'money-input.mjs'));
});

// Only the pieces written to run in a browser: `money-display-guard` reads the module's files with
// `node:fs`, and the package's `./*` export would otherwise hand a bundle the whole CLI.
test('only the toolkit\'s RUNTIME pieces can be bundled: a test guard or a CLI file is an error', async () => {
  const { callback } = await registration(undefined);
  for (const spec of [
    '@erplora/module-toolkit/money-display-guard',
    '@erplora/module-toolkit/src/validate.mjs',
    '@erplora/module-toolkit/no-such-piece',
    '@erplora/module-toolkit',
  ]) {
    const res = callback({ path: spec });
    assert.equal(res.path, undefined, `${spec} resolved to ${res.path}`);
    assert.equal(res.errors?.length, 1, spec);
  }
});

// ── Ionic for the `erplora dev` harness (module-toolkit#430) ─────────────────────────────────────
//
// The harness imports @ionic/core and ionicons; they have to come from the toolkit, whatever the
// previewed workspace installs. ionicons is a dependency of @ionic/core, not of the toolkit: under
// pnpm (and in CI, where only @ionic/core is linked at the top) it sits NEXT TO @ionic/core's real
// directory, never at the top of the toolkit's node_modules.

/** A toolkit whose @ionic/core is a symlink into a pnpm-like store holding ionicons beside it. */
function pnpmToolkit(name) {
  const root = join(scratch, name);
  const store = join(root, 'store', 'node_modules');
  const core = join(store, '@ionic', 'core');
  mkdirSync(join(core, 'components'), { recursive: true });
  writeFileSync(join(core, 'package.json'), JSON.stringify({ name: '@ionic/core', version: '8.0.0' }));
  writeFileSync(join(core, 'components', 'ion-app.js'), 'globalThis.__storeIonApp = true;\n');
  const icons = join(store, 'ionicons');
  mkdirSync(icons, { recursive: true });
  writeFileSync(
    join(icons, 'package.json'),
    JSON.stringify({ name: 'ionicons', type: 'module', exports: { '.': './index.js', './icons': './icons.mjs' } }),
  );
  writeFileSync(join(icons, 'index.js'), 'globalThis.__storeIonicons = true;\n');
  writeFileSync(join(icons, 'icons.mjs'), 'export const storeIcon = "store";\n');
  const toolkit = join(root, 'toolkit');
  mkdirSync(join(toolkit, 'node_modules', '@ionic'), { recursive: true });
  writeFileSync(join(toolkit, 'package.json'), JSON.stringify({ name: '@erplora/module-toolkit' }));
  symlinkSync(core, join(toolkit, 'node_modules', '@ionic', 'core'));
  // A workspace that installs a DIFFERENT ionicons and no @ionic/core at all.
  const ws = join(root, 'ws');
  mkdirSync(join(ws, 'node_modules', 'ionicons'), { recursive: true });
  writeFileSync(join(ws, 'node_modules', 'ionicons', 'package.json'), JSON.stringify({ name: 'ionicons', main: 'index.js' }));
  writeFileSync(join(ws, 'node_modules', 'ionicons', 'index.js'), 'globalThis.__workspaceIonicons = true;\n');
  return { toolkit, ws };
}

async function bundleFrom(ws, plugins, contents) {
  const { build } = await import('esbuild');
  const out = await build({
    stdin: { contents, resolveDir: ws, loader: 'js' },
    bundle: true,
    write: false,
    format: 'esm',
    logLevel: 'silent',
    plugins,
  });
  return out.outputFiles[0].text;
}

test('the harness bakes Ionic and ionicons from the toolkit, found beside @ionic/core, never from the workspace', async () => {
  const { ionicFromToolkitPlugin } = await import('../src/resolve-plugin.mjs');
  const { toolkit, ws } = pnpmToolkit('pnpm-ionic');
  const js = await bundleFrom(
    ws,
    [ionicFromToolkitPlugin({ toolkitDir: toolkit })],
    "import '@ionic/core/components/ion-app.js';\nimport 'ionicons';\nimport * as I from 'ionicons/icons';\nconsole.log(I);\n",
  );
  assert.ok(js.includes('__storeIonApp'), '@ionic/core comes from the toolkit');
  assert.ok(js.includes('__storeIonicons'), 'ionicons comes from beside the toolkit\'s @ionic/core');
  assert.ok(js.includes('storeIcon'), 'ionicons/icons honours the package exports map');
  assert.ok(!js.includes('__workspaceIonicons'), "the workspace's ionicons was bundled");
});

test('the positive control: without the plugin that same workspace bakes its own ionicons', async () => {
  const { ws } = pnpmToolkit('pnpm-ionic-control');
  const js = await bundleFrom(ws, [], "import 'ionicons';\n");
  assert.ok(js.includes('__workspaceIonicons'));
});

test('a toolkit without @ionic/core is a resolution error that says to reinstall the toolkit', async () => {
  const { ionicFromToolkitPlugin } = await import('../src/resolve-plugin.mjs');
  const empty = join(scratch, 'no-ionic-toolkit');
  mkdirSync(empty, { recursive: true });
  await assert.rejects(
    bundleFrom(empty, [ionicFromToolkitPlugin({ toolkitDir: empty })], "import 'ionicons';\n"),
    (err) => err.errors.some((e) => /@erplora\/module-toolkit/.test(e.text) && /ionicons/.test(e.text)),
  );
});
