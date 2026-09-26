// module-toolkit#361: the workspace `startproject` writes must install and build on the first try,
// inside the monorepo and outside it (toolkit installed from npm).
//
// It used to write `@erplora/outfitkit: file:<toolkit>/../hub/packages/outfitkit`, a folder that
// no longer exists (OutfitKit is its own repo, published on npm). `npm install` exited 0 with a
// dangling symlink and the first module build failed. Installed from npm, `../hub/packages` falls
// inside `node_modules/@erplora/`, so the SDK and types links were dangling as well.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startproject, workspaceDevDependencies } from '../src/scaffold.mjs';

const toolkitPkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fileTargets(projectDir, devDependencies) {
  return Object.entries(devDependencies)
    .filter(([, spec]) => spec.startsWith('file:'))
    .map(([name, spec]) => ({ name, target: resolve(projectDir, spec.slice('file:'.length)) }));
}

test('startproject: every file: dependency points to an existing package (#361)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-startproject-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await startproject('demo-ws');
    const dir = join(root, 'demo-ws');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

    for (const { name, target } of fileTargets(dir, pkg.devDependencies)) {
      assert.ok(existsSync(join(target, 'package.json')), `${name} -> ${target} does not exist`);
    }
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test('startproject: OutfitKit comes from the registry with the toolkit range (#361)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-startproject-ok-'));
  const prev = process.cwd();
  process.chdir(root);
  try {
    await startproject('demo-ws');
    const pkg = JSON.parse(readFileSync(join(root, 'demo-ws', 'package.json'), 'utf8'));
    assert.equal(
      pkg.devDependencies['@erplora/outfitkit'],
      toolkitPkg.dependencies['@erplora/outfitkit'],
    );
  } finally {
    process.chdir(prev);
    rmSync(root, { recursive: true, force: true });
  }
});

test('toolkit installed from npm: no dangling SDK/types links, a warning per missing package (#361)', () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-startproject-npm-'));
  try {
    const projectDir = join(root, 'demo-ws');
    const toolkitDir = join(root, 'global', 'node_modules', '@erplora', 'module-toolkit');
    mkdirSync(toolkitDir, { recursive: true });
    writeFileSync(join(toolkitDir, 'package.json'), '{}');

    const { devDependencies, warnings } = workspaceDevDependencies(projectDir, {
      toolkitDir,
      hubPackagesDir: resolve(toolkitDir, '../hub/packages'),
    });

    assert.equal(devDependencies['@erplora/module-sdk'], undefined);
    assert.equal(devDependencies['@erplora/module-types'], undefined);
    assert.equal(devDependencies['@erplora/outfitkit'], toolkitPkg.dependencies['@erplora/outfitkit']);
    for (const { name, target } of fileTargets(projectDir, devDependencies)) {
      assert.ok(existsSync(join(target, 'package.json')), `${name} -> ${target} does not exist`);
    }
    assert.deepEqual(
      warnings.map((w) => [w.code, w.package]),
      [
        ['local_package_missing', '@erplora/module-sdk'],
        ['local_package_missing', '@erplora/module-types'],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hub packages present: SDK and types are linked locally, without warnings (#361)', () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-startproject-mono-'));
  try {
    const projectDir = join(root, 'demo-ws');
    const toolkitDir = join(root, 'module-toolkit');
    const hubPackagesDir = join(root, 'hub', 'packages');
    for (const d of [toolkitDir, join(hubPackagesDir, 'module-sdk'), join(hubPackagesDir, 'module-types')]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, 'package.json'), '{}');
    }

    const { devDependencies, warnings } = workspaceDevDependencies(projectDir, {
      toolkitDir,
      hubPackagesDir,
    });

    assert.equal(devDependencies['@erplora/module-sdk'], 'file:../hub/packages/module-sdk');
    assert.equal(devDependencies['@erplora/module-types'], 'file:../hub/packages/module-types');
    assert.equal(devDependencies['@erplora/module-toolkit'], 'file:../module-toolkit');
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
