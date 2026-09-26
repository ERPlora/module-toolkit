// The toolkit's package carries the hub's module SDK — module-toolkit#359.
//
// A module's Web Component imports `@erplora/module-sdk`, and that package is not on any public
// registry (ERPlora/hub#1371). So `npm pack` copies it from the hub into `vendor/` of the tarball
// (`prepack`), and the resolver falls back to that copy when no SDK is installed. These tests pin
// the copy itself: what goes in, where it comes from, and that a pack with no SDK to copy STOPS —
// a tarball without it is exactly the broken install #359 is about, under a green `npm pack`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_HUB_PACKAGES, SDK_CONTRACT, bundleHubSdk, hubPackageDir, removeBundle } from '../scripts/bundle-hub-sdk.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'erplora-bundle-sdk-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function write(path, body) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/** The frozen public surface of the SDK (`contracts/kernel/sdk.d.ts`) both sides agree on. */
const CONTRACT = 'export declare function fromMicro(n: number): number;\n';

/** A toolkit checkout whose kernel contract mirror says `contract`. */
function fakeToolkit(name, contract = CONTRACT) {
  const toolkit = join(scratch, name);
  write(join(toolkit, SDK_CONTRACT), contract);
  return toolkit;
}

/** A hub checkout with the two packages, the SDK carrying a test file that must not ship. */
function fakeHub(name, contract = CONTRACT) {
  const hub = join(scratch, name);
  write(join(hub, SDK_CONTRACT), contract);
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
  const toolkit = fakeToolkit('toolkit-declared');
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

// The copy is read from whatever hub is at hand — in the monorepo, `../hub` on whatever branch it was
// left. Measured in the review of #365: `../hub` on a stale feature branch, `npm pack` exited 0 and the
// tarball carried an SDK that was neither develop's nor the one its own `contracts/kernel/sdk.d.ts`
// describes. The kernel contract is the SDK's frozen surface, mirrored here and checked against
// develop by the canonical mirrors: a hub that disagrees with it is not the hub this toolkit speaks to.
test('a hub whose SDK contract is not the one the toolkit ships stops the pack, copying nothing', () => {
  const hub = fakeHub('hub-drifted', 'export declare function fromMicro(n: number, scale: number): number;\n');
  const toolkit = fakeToolkit('toolkit-drifted');
  assert.throws(() => bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } }), { code: 'hub_sdk_out_of_date' });
  assert.equal(existsSync(join(toolkit, 'vendor')), false);
});

test('a hub with no SDK contract to compare stops the pack', () => {
  const hub = fakeHub('hub-no-contract');
  rmSync(join(hub, SDK_CONTRACT));
  assert.throws(
    () => bundleHubSdk({ toolkitRoot: fakeToolkit('toolkit-no-contract'), env: { ERPLORA_HUB_DIR: hub } }),
    { code: 'hub_sdk_out_of_date' },
  );
});

test('the installed SDK is checked against the contract of the hub it lives in', () => {
  const hub = fakeHub('hub-installed-drifted', 'export {};\n');
  const resolve = (spec) => join(hub, 'packages', spec.split('/')[1], 'package.json');
  assert.throws(
    () => bundleHubSdk({ toolkitRoot: fakeToolkit('toolkit-installed-drifted'), env: {}, resolve }),
    { code: 'hub_sdk_out_of_date' },
  );
});

test('a file the hub dropped does not linger in the next pack', () => {
  const hub = fakeHub('hub-shrinks');
  const toolkit = fakeToolkit('toolkit-shrinks');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  rmSync(join(hub, 'packages/module-sdk/src/quantity.ts'));
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  assert.equal(existsSync(join(toolkit, 'vendor/@erplora/module-sdk/src/quantity.ts')), false);
});

test('after the pack, the copy is removed from the checkout', () => {
  const hub = fakeHub('hub-clean');
  const toolkit = fakeToolkit('toolkit-clean');
  bundleHubSdk({ toolkitRoot: toolkit, env: { ERPLORA_HUB_DIR: hub } });
  removeBundle(toolkit);
  assert.equal(existsSync(join(toolkit, 'vendor')), false);
});
