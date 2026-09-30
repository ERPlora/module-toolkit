// The bundle is the same whatever path the module is reached by — module-toolkit#438.
//
// On macOS `$TMPDIR` is `/var/folders/…` and `/var` is a link to `/private/var`. esbuild resolves
// every input to its REAL path, so when the module directory handed to the build went through a
// link, the path annotations no longer hung from it: `// locales/es.json` came out as
// `// @erplora/module-tables/locales/es.json`. Same module, same SDK, same toolkit — and the catalogue
// rebake, working under `$TMPDIR`, saw all 26 modules as stale and baked bundles the Linux gate
// (no links in its temp dir) rejects as not reproducible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bundleWebComponent } from '../src/bundle-web-component.mjs';

function write(root, file, body) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

/** A module with a package name, a shared lib and a catalogue — the shape of `tables`. */
function moduleIn(root, components) {
  const mod = join(root, 'real', 'demo');
  write(mod, 'module.json', '{"id":"demo","version":"1.0.0"}\n');
  write(mod, 'package.json', '{"name":"@erplora/module-demo","private":true}\n');
  write(mod, 'locales/es.json', '{"title":"Demo"}\n');
  write(mod, 'ui/lib/domain-error.ts', "export const code = (e: unknown) => String(e ?? 'unknown');\n");
  for (const name of components) {
    write(
      mod,
      `ui/components/${name}/${name}.ts`,
      "import es from '../../../locales/es.json';\nimport { code } from '../../lib/domain-error';\n" +
        // A side effect, like the `customElements.define` of a real component: the synthetic entry
        // imports each component bare, so a side-effect-free one would be tree-shaken away.
        `(globalThis as Record<string, unknown>)['${name}'] = () => code(es.title);\n`,
    );
  }
  return mod;
}

for (const [label, components] of [
  ['a single component (entry point)', ['erp-demo']],
  ['several components (synthetic entry)', ['erp-demo', 'erp-other']],
]) {
  test(`mt#438: ${label} bakes the same bytes through a linked path and through the real one`, async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'erplora-real-path-')));
    try {
      const mod = moduleIn(root, components);
      symlinkSync(join(root, 'real'), join(root, 'linked'));
      const viaLink = join(root, 'linked', 'demo');

      const real = await bundleWebComponent(mod, 'demo', join(root, 'real.esm.js'));
      const linked = await bundleWebComponent(viaLink, 'demo', join(root, 'linked.esm.js'));

      // The positive control: the annotations are the module-relative ones, not the package name.
      assert.match(real, /^\/\/ locales\/es\.json$/m);
      assert.match(real, /^\/\/ ui\/lib\/domain-error\.ts$/m);
      assert.equal(linked, real);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
