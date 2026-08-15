// `erplora validate` must run from a bare checkout of the toolkit (ERPlora/pm#107).
//
// The CI gate of the module repos runs the validator straight out of this repository, checked out
// by GitHub as a composite action. `npm install` is NOT an option there: three of the toolkit's
// dependencies are `file:` paths into sibling checkouts (`../hub/packages/module-sdk`,
// `../hub/packages/module-types`, `../outfitkit`) that do not exist on a runner, so the install
// fails as a whole.
//
// So the gate installs, by hand, only the public packages `validate` really needs. Today that is
// `typescript` (contracts.mjs parses the module's .ts to extract the consumed surface). Everything
// else — esbuild, lit, @ionic/core, @iconify — belongs to `build`/`dev`/`pack`, commands the gate
// never runs, and must not be needed just to LOAD the CLI.
//
// This test pins that contract: the whole import graph reachable from `erplora validate` resolves
// with `typescript` alone. Before the lazy imports of the entrypoint it failed with
// `ERR_MODULE_NOT_FOUND: esbuild`, which is exactly how the gate would have died on the runner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A copy of the toolkit with `typescript` as its ONLY dependency, like the CI runner. */
function bareCheckout() {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-toolkit-bare-'));
  cpSync(join(ROOT, 'bin'), join(dir, 'bin'), { recursive: true });
  cpSync(join(ROOT, 'src'), join(dir, 'src'), { recursive: true });
  // The canonical manifest schema travels INSIDE the package (module-toolkit#30): the gate has no
  // checkout of ERPlora/hub, so a schema it had to go and find would leave the unknown-key check
  // switched off in the one door where it matters.
  cpSync(join(ROOT, 'schemas'), join(dir, 'schemas'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  symlinkSync(join(ROOT, 'node_modules', 'typescript'), join(dir, 'node_modules', 'typescript'), 'dir');
  return dir;
}

test('`erplora validate` loads with typescript as the only installed dependency', { skip: existsSync(join(ROOT, 'node_modules', 'typescript')) ? false : 'no local typescript to link' }, () => {
  const dir = bareCheckout();
  const res = spawnSync(process.execPath, [join(dir, 'bin', 'erplora.mjs'), 'validate', join(dir, 'no-such-module')], {
    encoding: 'utf8',
    // A parent node_modules must not rescue the resolution: the copy lives in the OS tmpdir.
    cwd: dir,
  });
  const out = `${res.stdout}\n${res.stderr}`;
  assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND/, `the validate import graph needs a package the gate does not install:\n${out}`);
  // It must fail for the RIGHT reason: the module directory does not exist.
  assert.match(out, /module\.json/, `expected the toolkit's own error about the missing manifest:\n${out}`);
});
