#!/usr/bin/env node
// Puts the hub's module SDK inside the toolkit's tarball — module-toolkit#359.
//
// WHY. The component `erplora g module` writes imports `@erplora/module-sdk`, and the resolver pins
// it to the copy the TOOLKIT carries (`src/resolve-plugin.mjs`). Inside the monorepo that copy is
// the `devDependencies` `file:` link to `../hub/packages/module-sdk`; a vendor who installs the
// toolkit from npm never receives a devDependency, and the SDK is on no public registry
// (ERPlora/hub#1371). So their first `erplora build` stopped on «could not resolve».
//
// HOW. `npm pack`/`npm publish` run this as `prepack`: the TypeScript sources of the two hub packages
// are brought into `vendor/@erplora/<name>/` (shipped through `files`, ignored by git). The copy
// stays in the checkout — see `bundleHubSdk` for why there is no `postpack` removing it. The resolver prefers an INSTALLED SDK and only falls back to `vendor/`, so the
// monorepo and the module gate keep building against the hub they have (module-toolkit#99).
//
// WHERE FROM. A declared hub (`ERPLORA_HUB_DIR`, what CI and the publish job set from the hub's
// `module-sdk` action) is read from disk; otherwise the installed devDependency. Neither → the pack
// STOPS: a tarball without the SDK is the broken install this exists to prevent, and `npm pack`
// would otherwise report it green.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The hub packages a generated module may import, carried in the tarball. */
export const BUNDLED_HUB_PACKAGES = ['module-sdk', 'module-types'];

/** Where the copies live inside the toolkit, relative to its root. */
export const VENDOR_DIR = 'vendor';

function missing(message) {
  return Object.assign(new Error(message), { code: 'hub_sdk_missing' });
}

/**
 * The directory of `@erplora/<name>` to copy from.
 *
 * @param {string} name one of BUNDLED_HUB_PACKAGES
 * @param {{env?: NodeJS.ProcessEnv, resolve?: (spec: string) => string}} [options]
 *   `resolve` returns a FILE path for a specifier (the default resolves from this toolkit).
 */
export function hubPackageDir(name, { env = process.env, resolve = defaultResolve } = {}) {
  if (env.ERPLORA_HUB_DIR) {
    const dir = join(env.ERPLORA_HUB_DIR, 'packages', name);
    if (!existsSync(join(dir, 'package.json'))) {
      throw missing(
        `ERPLORA_HUB_DIR is ${env.ERPLORA_HUB_DIR} and it has no packages/${name}/package.json: ` +
          'the toolkit package would ship without the module SDK.',
      );
    }
    return dir;
  }
  try {
    return dirname(resolve(`@erplora/${name}/package.json`));
  } catch (error) {
    throw missing(
      `@erplora/${name} is not installed next to the toolkit and ERPLORA_HUB_DIR is not set ` +
        `(${error.message}). Run \`npm install\` with ERPlora/hub cloned alongside, or point ` +
        'ERPLORA_HUB_DIR at a hub checkout: the toolkit package would ship without the module SDK.',
    );
  }
}

function defaultResolve(spec) {
  return fileURLToPath(import.meta.resolve(spec));
}

/** Every source file under `src/`, test files excluded — what a build of a module can import. */
function sourcesOf(dir) {
  return readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.test\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/** The name a file has between its write and its rename (`<file>.<pid>.tmp`). */
const TEMPORARY = /\.\d+\.tmp$/;

/** Every file under `dir`, relative to it (empty when `dir` does not exist yet). */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/**
 * Brings `<toolkitRoot>/vendor/@erplora/<name>/` in line with the hub packages.
 *
 * The copy stays in the checkout between packs, and it is refreshed WITHOUT a moment in which a
 * file is missing or half written: two `npm pack` of the same checkout run at once in CI, and a
 * pack reading the copy while another rewrites it would ship without the SDK. So a file whose bytes
 * already match is left alone, a changed one is written to a temporary name and renamed over the
 * old one (atomic), and only files the hub no longer has are removed.
 *
 * @returns {string[]} the files of the copy, relative to `toolkitRoot`
 */
export function bundleHubSdk({ toolkitRoot = TOOLKIT, env = process.env, resolve = defaultResolve } = {}) {
  const copied = [];
  for (const name of BUNDLED_HUB_PACKAGES) {
    const from = hubPackageDir(name, { env, resolve });
    const to = join(toolkitRoot, VENDOR_DIR, '@erplora', name);
    const wanted = ['package.json', ...sourcesOf(from)];
    for (const file of wanted) {
      const source = readFileSync(join(from, file));
      const target = join(to, file);
      if (!existsSync(target) || !readFileSync(target).equals(source)) {
        mkdirSync(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.tmp`;
        writeFileSync(temporary, source);
        renameSync(temporary, target);
      }
      copied.push(relative(toolkitRoot, target));
    }
    // Another pack's temporary file is not stale: removing it would make its rename fail.
    const stales = filesUnder(to).filter((file) => !wanted.includes(file) && !TEMPORARY.test(file));
    for (const stale of stales) {
      rmSync(join(to, stale), { force: true });
    }
  }
  return copied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const copied = bundleHubSdk();
    // stderr, not stdout: npm hands a lifecycle script its own stdout, and `npm pack --json`
    // callers parse that stream as the tarball's JSON report.
    console.error(`✓ module SDK bundled into the package (${copied.length} files under ${VENDOR_DIR}/)`);
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
