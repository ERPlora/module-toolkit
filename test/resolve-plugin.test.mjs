// Where the build finds `@erplora/module-sdk` — module-toolkit#359.
//
// Two copies can exist: the INSTALLED one (in the monorepo, the devDependency link to the hub; in a
// module gate, the hub's `module-sdk` action) and the one the npm package carries in `vendor/`. The
// installed one has to win: the gate and the monorepo build against the hub they were given
// (module-toolkit#99), and a vendored copy quietly taking over would test a module against an SDK
// nobody chose. `vendor/` is only for the install that has nothing else — a vendor's `npm install`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
