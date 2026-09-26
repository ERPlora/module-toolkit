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
// are copied into `vendor/@erplora/<name>/` (shipped through `files`, ignored by git) and `postpack`
// removes them again. The resolver prefers an INSTALLED SDK and only falls back to `vendor/`, so the
// monorepo and the module gate keep building against the hub they have (module-toolkit#99).
//
// WHERE FROM. A declared hub (`ERPLORA_HUB_DIR`, what CI and the publish job set from the hub's
// `module-sdk` action) is read from disk; otherwise the installed devDependency. Neither → the pack
// STOPS: a tarball without the SDK is the broken install this exists to prevent, and `npm pack`
// would otherwise report it green.
import { cpSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The hub packages a generated module may import, carried in the tarball. */
export const BUNDLED_HUB_PACKAGES = ['module-sdk', 'module-types'];

/** Where the copies live inside the toolkit, relative to its root. */
export const VENDOR_DIR = 'vendor';

/** The SDK's frozen public surface, relative to a hub root AND to the toolkit root (its mirror). */
export const SDK_CONTRACT = 'contracts/kernel/sdk.d.ts';

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

/**
 * Refuses an SDK whose hub disagrees with the kernel contract this toolkit ships. Without it the copy
 * came from whatever branch `../hub` was left on and `npm pack` still exited 0 (review of #365): the
 * tarball carried an SDK its own `contracts/kernel/sdk.d.ts` did not describe. The hub keeps that file
 * equal to the SDK's surface (`contract:check`), and the canonical mirrors keep the toolkit's copy
 * equal to develop's.
 */
function assertSdkMatchesContract(sdkDir, toolkitRoot) {
  const hubContract = join(sdkDir, '..', '..', SDK_CONTRACT);
  const hubSide = existsSync(hubContract) ? readFileSync(hubContract, 'utf8') : null;
  if (hubSide !== null && hubSide === readFileSync(join(toolkitRoot, SDK_CONTRACT), 'utf8')) return;
  throw Object.assign(
    new Error(
      `the module SDK in ${sdkDir} is not the one this toolkit's ${SDK_CONTRACT} describes ` +
        `(${hubSide === null ? `${hubContract} is missing` : 'the two files differ'}): point ERPLORA_HUB_DIR ` +
        'at a hub checkout on develop, or resync the mirrors (npm run sync-mirrors).',
    ),
    { code: 'hub_sdk_out_of_date' },
  );
}

/** Every source file under `src/`, test files excluded — what a build of a module can import. */
function sourcesOf(dir) {
  return readdirSync(join(dir, 'src'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && !/\.test\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

/**
 * Copies the hub packages into `<toolkitRoot>/vendor/@erplora/<name>/`, replacing any older copy.
 *
 * @returns {string[]} the copied files, relative to `toolkitRoot`
 */
export function bundleHubSdk({ toolkitRoot = TOOLKIT, env = process.env, resolve = defaultResolve } = {}) {
  assertSdkMatchesContract(hubPackageDir('module-sdk', { env, resolve }), toolkitRoot);
  const copied = [];
  for (const name of BUNDLED_HUB_PACKAGES) {
    const from = hubPackageDir(name, { env, resolve });
    const to = join(toolkitRoot, VENDOR_DIR, '@erplora', name);
    rmSync(to, { recursive: true, force: true });
    for (const file of ['package.json', ...sourcesOf(from)]) {
      cpSync(join(from, file), join(to, file));
      copied.push(relative(toolkitRoot, join(to, file)));
    }
  }
  return copied;
}

/** Removes the copies from the checkout once the tarball is written (`postpack`). */
export function removeBundle(toolkitRoot = TOOLKIT) {
  rmSync(join(toolkitRoot, VENDOR_DIR), { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.includes('--clean')) {
      removeBundle();
    } else {
      const copied = bundleHubSdk();
      // stderr, not stdout: npm hands a lifecycle script its own stdout, and `npm pack --json`
      // callers parse that stream as the tarball's JSON report.
      console.error(`✓ module SDK bundled into the package (${copied.length} files under ${VENDOR_DIR}/)`);
    }
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
