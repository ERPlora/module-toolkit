// `erplora validate` must run from a bare checkout of the toolkit (ERPlora/pm#107).
//
// The CI gate of the module repos runs the validator straight out of this repository, checked out
// by GitHub as a composite action. `npm install` is NOT an option there: three of the toolkit's
// dependencies are `file:` paths into sibling checkouts (`../hub/packages/module-sdk`,
// `../hub/packages/module-types`, `../outfitkit`) that do not exist on a runner, so the install
// fails as a whole.
//
// So the gate installs, by hand, only the public packages `validate` really needs: `typescript`
// (contracts.mjs parses the module's .ts to extract the consumed surface) and `ajv` (it EVALUATES
// the canonical manifest schema — module-toolkit#247). Everything else — esbuild, lit,
// @ionic/core, @iconify — belongs to `build`/`dev`/`pack`, commands the gate never runs, and must
// not be needed just to LOAD the CLI.
//
// This test pins that contract: the whole import graph reachable from `erplora validate` resolves
// with THAT list and nothing more. Before the lazy imports of the entrypoint it failed with
// `ERR_MODULE_NOT_FOUND: esbuild`, which is exactly how the gate would have died on the runner.
//
// The list is not written down twice: it is read from the gate's own YAML. `gate-wiring.test.mjs`
// proves that same list covers every package `src/validate.mjs` imports, so the chain closes —
// code says what it needs, the gate installs it, and this test runs with exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The public packages the module gate installs, read from the gate's own YAML so this cannot drift. */
function packagesTheGateInstalls() {
  const yaml = readFileSync(join(ROOT, '.github/actions/validate-module/action.yml'), 'utf8');
  const loop = /for pkg in ([^;\n]+); do/.exec(yaml);
  assert.ok(loop, 'the gate installs its packages through the `for pkg in …` loop');
  return loop[1].trim().split(/\s+/);
}

/** A copy of the toolkit with the gate's packages as its ONLY dependencies, like the CI runner. */
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
  for (const pkg of packagesTheGateInstalls()) {
    const link = join(dir, 'node_modules', pkg);
    mkdirSync(dirname(link), { recursive: true }); // a scoped package needs its @scope directory
    // Only the package itself: node resolves a symlink through its realpath, so its own
    // dependencies are found next to the original — exactly what the gate relies on.
    symlinkSync(join(ROOT, 'node_modules', pkg), link, 'dir');
  }
  return dir;
}

const missing = packagesTheGateInstalls().filter((pkg) => !existsSync(join(ROOT, 'node_modules', pkg)));

test('`erplora validate` loads with the gate\u2019s packages as the only installed dependencies', { skip: missing.length ? `not installed locally: ${missing.join(', ')}` : false }, () => {
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
