// A module's UI that imports the shared money reader BUILDS, and the bundle reads money the same
// way the piece does (ERPlora/combos#9).
//
// The module lives in a scratch directory with no node_modules on purpose: that is the module gate
// (it builds before linking the toolkit into the module) and a vendor's repo. If the build found the
// piece by walking up to some node_modules, this test would say nothing about either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { bundleWebComponent } from '../src/bundle-web-component.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'erplora-money-input-bundle-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function moduleWith(name, source) {
  const dir = join(scratch, name);
  mkdirSync(join(dir, 'ui', 'components', 'erp-demo'), { recursive: true });
  writeFileSync(join(dir, 'ui', 'components', 'erp-demo', 'erp-demo.ts'), source);
  return dir;
}

test('a component importing @erplora/module-toolkit/money-input bundles it, and it reads 1.250,50', async () => {
  const dir = moduleWith(
    'uses-piece',
    [
      "import { parseMoneyInput, formatMoneyInput } from '@erplora/module-toolkit/money-input';",
      "export const pasted = parseMoneyInput('1.250,50', 2);",
      "export const shown = formatMoneyInput(125050, 2, 'es');",
      '',
    ].join('\n'),
  );
  const outfile = join(dir, 'dist', 'demo.esm.js');
  const code = await bundleWebComponent(dir, 'demo', outfile);
  assert.doesNotMatch(code, /from\s+['"]@erplora\/module-toolkit/, 'the piece has to be INSIDE the bundle');
  const bundle = await import(pathToFileURL(outfile).href);
  assert.deepEqual(bundle.pasted, { ok: true, minor: 125050 });
  assert.equal(bundle.shown, '1250,50');
});

test('a component importing a toolkit piece that is not for the browser does not build', async () => {
  const dir = moduleWith(
    'uses-guard',
    "import { checkMoneyDisplay } from '@erplora/module-toolkit/money-display-guard';\nexport const x = checkMoneyDisplay;\n",
  );
  await assert.rejects(
    bundleWebComponent(dir, 'demo', join(dir, 'dist', 'demo.esm.js')),
    /not a runtime piece of the toolkit/,
  );
});
