// Plugin de resolución de esbuild: el toolkit ES el "envoltorio" que provee las deps de build.
// El repo de un módulo NO declara `lit`/`@erplora/*`; este plugin intercepta esos specifiers
// (incluidos los que aparecen DENTRO del dist de outfitkit, p.ej. `lit/directives/repeat.js`)
// y los fija a la ÚNICA copia instalada en `node_modules` del toolkit.
//
// Por qué un plugin y no `nodePaths`/`alias`: hace falta DEDUPLICAR `lit`. El WC del módulo
// importa `lit` y el dist de `@erplora/outfitkit` también; si esbuild los resolviese por
// separado (dos rutas reales distintas) habría DOS copias de Lit en el bundle → decoradores
// y reactive-controllers rotos. Interceptando todo `lit*` y `@erplora/*` y resolviéndolos
// SIEMPRE desde este módulo del toolkit, garantizamos una sola copia, sea cual sea el gestor
// de paquetes o el anidamiento (symlinks de `file:` incluidos).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The hub packages the tarball carries in `vendor/` (`scripts/bundle-hub-sdk.mjs`, `prepack`),
// because no public registry serves them yet (ERPlora/hub#1371) — module-toolkit#359.
const VENDORED = /^@erplora\/(module-sdk|module-types)($|\/.*)/;
const VENDOR_ROOT = fileURLToPath(new URL('../vendor/@erplora/', import.meta.url));

/** The file `<dir>` builds from for the subpath `sub` (`''` for the package's own entry). */
function packageFile(dir, sub) {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return null;
  if (sub) return join(dir, sub.slice(1));
  const { main, types } = JSON.parse(readFileSync(manifest, 'utf8'));
  return join(dir, main ?? types ?? 'index.js');
}

/**
 * The copy of a hub package shipped inside the toolkit, or null when there is none (a checkout of
 * the monorepo, where the devDependency link is what resolves).
 */
function vendoredPath(spec, vendorRoot) {
  const m = VENDORED.exec(spec);
  return m ? packageFile(join(vendorRoot, m[1]), m[2]) : null;
}

function defaultResolve(spec) {
  return import.meta.resolve(spec);
}

/**
 * The file a pinned specifier builds from. An INSTALLED package always wins: the module gate and the
 * monorepo build against the hub they were given (module-toolkit#99); the copy in `vendor/` is only
 * for an install that has nothing else. Throws the resolution error when neither exists.
 *
 * @param {string} spec
 * @param {{resolve?: (spec: string) => string, vendorRoot?: string}} [options]
 *   `resolve` returns a `file:` URL (injected in tests)
 */
export function resolvePinned(spec, { resolve = defaultResolve, vendorRoot = VENDOR_ROOT } = {}) {
  try {
    return fileURLToPath(resolve(spec));
  } catch (err) {
    const vendored = vendoredPath(spec, vendorRoot);
    if (vendored && existsSync(vendored)) return vendored;
    throw err;
  }
}

// `import.meta.resolve(spec)` (Node ≥20, estable y síncrono) resuelve relativo a ESTE módulo,
// que vive en el toolkit → cae en `module-toolkit/node_modules`. Honra el "exports" map
// (subpaths de lit y de outfitkit: `/define`, `/ok-data-table`, `/directives/*`).
const PINNED = /^(lit($|\/)|@lit\/|@erplora\/(outfitkit|module-sdk|module-types)($|\/))/;

/**
 * The file a hub package specifier builds from inside a GIVEN `packages/module-sdk` directory (its
 * `module-types` sibling included). This is how `build --check` rebuilds against the SDK the module
 * gate hands over, not the one the toolkit has installed (module-toolkit#389). Throws when that
 * directory does not hold the package: falling back to the installed copy would compare against
 * another SDK in silence.
 */
function fromSdkDir(spec, sdkDir) {
  const m = VENDORED.exec(spec);
  const dir = m[1] === 'module-sdk' ? sdkDir : join(sdkDir, '..', 'module-types');
  const file = packageFile(dir, m[2]);
  if (!file) throw new Error(`no ${join(dir, 'package.json')} for '${spec}'`);
  return file;
}

/**
 * @param {{sdkDir?: string}} [options] `sdkDir`: bake THIS `@erplora/module-sdk` (and its
 *   `module-types` sibling) instead of the toolkit's installed one.
 */
export function erploraResolvePlugin({ sdkDir } = {}) {
  return {
    name: 'erplora-resolve',
    setup(build) {
      build.onResolve({ filter: PINNED }, (args) => {
        try {
          if (sdkDir && VENDORED.test(args.path)) return { path: fromSdkDir(args.path, sdkDir) };
          return { path: resolvePinned(args.path) };
        } catch (err) {
          return {
            errors: [
              {
                text:
                  `Could not resolve '${args.path}' from the toolkit: its installation is ` +
                  `incomplete. Reinstall @erplora/module-toolkit (npm install). (${err.message})`,
              },
            ],
          };
        }
      });
    },
  };
}
