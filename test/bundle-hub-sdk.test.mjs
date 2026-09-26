// The toolkit's package carries the hub's module SDK — module-toolkit#359.
//
// A module's Web Component imports `@erplora/module-sdk`, and that package is not on any public
// registry (ERPlora/hub#1371). So `npm pack` copies it from the hub into `vendor/` of the tarball
// (`prepack`), and the resolver falls back to that copy when no SDK is installed. These tests pin
// the copy itself: what goes in, where it comes from, and that a pack with no SDK to copy STOPS —
// a tarball without it is exactly the broken install #359 is about, under a green `npm pack`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_HUB_PACKAGES, bundleHubSdk, hubPackageDir } from '../scripts/bundle-hub-sdk.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'erplora-bundle-sdk-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/** A hub checkout with the two packages, the SDK carrying a test file that must not ship. */
function fakeHub(name) {
  const hub = join(scratch, name);
  write(join(hub, 'packages/module-sdk/package.json'), JSON.stringify({ name: '@erplora/module-sdk', main: 'src/index.ts' }));
  write(join(hub, 'packages/module-sdk/src/index.ts'), "export * from './quantity.ts';\n");
  write(join(hub, 'packages/module-sdk/src/quantity.ts'), 'export const fromMicro = (n: number) => n / 1e6;\n');
  write(join(hub, 'packages/module-sdk/src/index.test.ts'), "import 'node:test';\n");
  write(join(hub, 'packages/module-sdk/scripts/typecheck.mjs'), '');
  write(join(hub, 'packages/module-types/package.json'), JSON.stringify({ name: '@erplora/module-types', types: 'src/index.ts' }));
  write(join(hub, 'packages/module-types/src/index.ts'), 'export type Id = string;\n');
  return hub;
}

test('both hub packages are carried', () => {
  assert.deepEqual(BUNDLED_HUB_PACKAGES, ['module-sdk', 'module-types']);
});

test('a declared hub is the source: package.json and the sources ship, tests and scripts do not', () => {
  const hub = fakeHub('hub-declared');
  const toolkit = join(scratch, 'toolkit-declared');
  const copied = bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });

  assert.deepEqual(copied.sort(), [
    'vendor/@erplora/module-sdk/package.json',
    'vendor/@erplora/module-sdk/src/index.ts',
    'vendor/@erplora/module-sdk/src/quantity.ts',
    'vendor/@erplora/module-types/package.json',
    'vendor/@erplora/module-types/src/index.ts',
  ]);
  assert.equal(
    readFileSync(join(toolkit, 'vendor/@erplora/module-sdk/src/quantity.ts'), 'utf8'),
    readFileSync(join(hub, 'packages/module-sdk/src/quantity.ts'), 'utf8'),
  );
});

test('without a declared hub, the installed package is the source', () => {
  const hub = fakeHub('hub-installed');
  const resolve = (spec) => {
    assert.match(spec, /^@erplora\/module-(sdk|types)\/package\.json$/);
    return join(hub, 'packages', spec.split('/')[1], 'package.json');
  };
  assert.equal(hubPackageDir('module-sdk', { env: {}, resolve }), join(hub, 'packages/module-sdk'));
});

test('a declared hub that lacks the package stops the pack', () => {
  const empty = join(scratch, 'hub-empty');
  mkdirSync(empty, { recursive: true });
  assert.throws(
    () => bundleHubSdk({ toolkitRoot: join(scratch, 'toolkit-empty'), env: { ERPLORA_HUB_DIR: empty } }),
    { code: 'hub_sdk_missing' },
  );
});

test('no declared hub and nothing installed stops the pack', () => {
  const resolve = () => {
    throw Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
  };
  assert.throws(() => hubPackageDir('module-sdk', { env: {}, resolve }), { code: 'hub_sdk_missing' });
});

test('a file the hub dropped does not linger in the next pack', () => {
  const hub = fakeHub('hub-shrinks');
  const toolkit = join(scratch, 'toolkit-shrinks');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  rmSync(join(hub, 'packages/module-sdk/src/quantity.ts'));
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  assert.equal(existsSync(join(toolkit, 'vendor/@erplora/module-sdk/src/quantity.ts')), false);
});

// Two `npm pack` of the same checkout at once — CI runs `install-from-package` and `npm-publish` in
// parallel, and both pack on load. With a `postpack` that deleted `vendor/`, one pack could remove
// the copy while the other was still reading it and ship a tarball without the SDK. So the copy
// stays in the checkout (git ignores it), and packing again over an identical copy touches nothing:
// a concurrent reader never sees a file missing or half written.
test('the copy stays in the checkout after the pack: no postpack removes it', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.scripts.prepack, 'node scripts/bundle-hub-sdk.mjs');
  assert.equal(manifest.scripts.postpack, undefined);
});

test('packing again from the same hub rewrites nothing', () => {
  const hub = fakeHub('hub-idempotent');
  const toolkit = join(scratch, 'toolkit-idempotent');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  const file = join(toolkit, 'vendor/@erplora/module-sdk/src/index.ts');
  const before = statSync(file);
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  const after = statSync(file);
  assert.equal(after.ino, before.ino, 'the file was replaced');
  assert.equal(after.mtimeMs, before.mtimeMs, 'the file was rewritten');
});

test('a source the hub changed is updated in place', () => {
  const hub = fakeHub('hub-changes');
  const toolkit = join(scratch, 'toolkit-changes');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  writeFileSync(join(hub, 'packages/module-sdk/src/quantity.ts'), 'export const fromMicro = 2;\n');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  assert.equal(readFileSync(join(toolkit, 'vendor/@erplora/module-sdk/src/quantity.ts'), 'utf8'), 'export const fromMicro = 2;\n');
  assert.deepEqual(readdirSync(join(toolkit, 'vendor/@erplora/module-sdk/src')).sort(), ['index.ts', 'quantity.ts'], 'a temporary file was left behind');
});

test('the temporary file of a pack running alongside is not swept as stale', () => {
  const hub = fakeHub('hub-alongside');
  const toolkit = join(scratch, 'toolkit-alongside');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  // What another process leaves for an instant between its write and its rename.
  const theirs = join(toolkit, 'vendor/@erplora/module-sdk/src/quantity.ts.99999.tmp');
  writeFileSync(theirs, 'x');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  assert.equal(existsSync(theirs), true, 'its rename would fail and that pack with it');
});

test('a temporary file never ships in the tarball', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.files.includes('!vendor/**/*.tmp'), `files = ${JSON.stringify(manifest.files)}`);
});
