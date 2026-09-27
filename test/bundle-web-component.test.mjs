// The Web Component bundling recipe lives in its own light module — module-toolkit#389.
//
// `build --check` runs in the gate of the 27 module repos, where every package has to be installed
// by hand. `build.mjs` also generates icons and compiles handlers, so loading it pulls `@iconify/*`
// in at import time; the check only needs the bundler. One recipe, two doors: `build` and the check
// must bake with the very same function, or the check compares against a bundle nobody ships.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Bare specifiers reachable from `entry` through static imports (relative ones are followed). */
function packagesReachableFrom(entry) {
  const seen = new Set();
  const packages = new Set();
  const walk = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const source = readFileSync(abs, 'utf8');
    for (const hit of source.matchAll(/(?:^|[\s;])(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]|createRequire[\s\S]{0,200}?require\(\s*['"]([^'"]+)['"]/g)) {
      const specifier = hit[1] || hit[2];
      if (specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.')) walk(join(dirname(abs), specifier));
      else packages.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    }
  };
  walk(join(REPO, entry));
  return packages;
}

test('build and build --check bake with the same function', async () => {
  const build = await import('../src/build.mjs');
  const recipe = await import('../src/bundle-web-component.mjs');
  assert.equal(build.bundleWebComponent, recipe.bundleWebComponent);
  assert.equal(build.resolveEntry, recipe.resolveEntry);
  assert.match(readFileSync(join(REPO, 'src/dist-reproducible.mjs'), 'utf8'), /from '\.\/bundle-web-component\.mjs'/);
});

test('the check needs esbuild and nothing else installed to load', () => {
  // The positive control first: the walk does see what build.mjs drags in.
  assert.ok(packagesReachableFrom('src/build.mjs').has('@iconify/utils'), 'the walk must follow build.mjs into icons.mjs');
  assert.deepEqual([...packagesReachableFrom('src/dist-reproducible.mjs')], ['esbuild']);
});
