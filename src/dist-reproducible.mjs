// Is the committed `dist/<id>.esm.js` what the module's `ui/` gives when rebuilt against hub
// develop's module SDK? — `erplora build <dir> --check`, module-toolkit#389.
//
// WHY. A module's pull request carries its bundle already built, and the bundle is published as
// committed. The gate ran `validate` (WHICH `ui/` produced it, #93) and `test` (the `.test.ts`
// against develop's SDK), but nothing compared the shipped bytes with a rebuild: a bundle baked
// with an old SDK merged green while its tests passed against the new one — on 2026-09-27 four
// rebuilds took the list controller back to filtering money in cents. #387 refuses that build on
// the developer's machine; this is the door for everything that does not go through it (built
// offline, with an older toolkit, from an SDK copy that is not a hub checkout, or by hand).
//
// HOW. The Web Component is bundled with the SAME recipe `build` uses (`bundleWebComponent`) into a
// scratch directory, never into `dist/`, and compared byte for byte. The SDK is the one handed over
// (`sdkDir`: the gate passes develop's) or, without it, the toolkit's own — and either way it goes
// through the #387 freshness door first, so a stale hub checkout can never be the reference that
// declares a stale bundle «reproducible».
//
// WHAT ELSE HAS TO MATCH. The bundle also carries OutfitKit, and `build` seals which version in
// `dist/outfitkit.json` (hub#1024). The rebuild bakes exactly that version, installed from npm into
// the shared cache (`outfitkit-ci.mjs`) — never the copy this toolkit resolves, which on a laptop is
// the shared `outfitkit/` checkout (module-toolkit#423) — and the gate's screen tests install the
// same one, so what ships is what was tested. No seal means nothing says what the bundle was built with.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { bundleWebComponent, resolveEntry } from './bundle-web-component.mjs';
import { OUTFITKIT_STAMP, toolkitOutfitkitDir } from './outfitkit-stamp.mjs';
import { fetchOutfitkit, sealedOutfitkit } from './outfitkit-ci.mjs';
import { assertSdkFresh, resolvedSdkDir } from './sdk-freshness.mjs';

/** The OutfitKit version the toolkit's own copy is at, or null when none resolves. */
export function resolvedOutfitkitVersion() {
  const pkg = join(toolkitOutfitkitDir(), 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    return JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

function hasWebComponent(dir) {
  try {
    resolveEntry(dir);
    return true;
  } catch {
    return false;
  }
}

/** 1-based line where two texts start to differ. */
function firstDifferentLine(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i + 1;
}

/**
 * @param {string} moduleDir
 * @param {{sdkDir?: string, outfitkit?: {env?: NodeJS.ProcessEnv}, developSha?: string,
 *   env?: NodeJS.ProcessEnv}} [options]
 *   `sdkDir`: the `@erplora/module-sdk` to rebuild with (default: the toolkit's own);
 *   `outfitkit.env`: npm and cache environment for the sealed OutfitKit (injected in tests);
 *   `developSha`/`env`: passed to the #387 freshness check.
 * @returns {Promise<{status: 'reproducible'|'differs'|'missing'|'unsealed'|'outfitkit_unavailable'|
 *   'no_web_component', id: string, file?: string, line?: number, sealed?: string, reason?: string}>}
 */
export async function checkDistReproducible(moduleDir, { sdkDir, outfitkit = {}, developSha, env } = {}) {
  const dir = resolve(process.cwd(), moduleDir);
  const { id } = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  if (!hasWebComponent(dir)) return { status: 'no_web_component', id };

  const file = `dist/${id}.esm.js`;
  if (!existsSync(join(dir, file))) return { status: 'missing', id, file };
  const sealed = sealedOutfitkit(dir);
  if (!sealed) return { status: 'unsealed', id, file };
  let outfitkitPrefix;
  try {
    outfitkitPrefix = fetchOutfitkit(sealed, outfitkit);
  } catch (err) {
    if (err.code !== 'outfitkit_unavailable') throw err;
    return { status: 'outfitkit_unavailable', id, file, sealed, reason: err.message };
  }

  assertSdkFresh({ sdkDir: sdkDir ?? resolvedSdkDir(), developSha, env });

  const scratch = mkdtempSync(join(tmpdir(), 'erplora-dist-check-'));
  try {
    const rebuilt = await bundleWebComponent(dir, id, join(scratch, `${id}.esm.js`), { sdkDir, outfitkitPrefix });
    const committed = readFileSync(join(dir, file), 'utf8');
    if (rebuilt === committed) return { status: 'reproducible', id, file };
    return { status: 'differs', id, file, line: firstDifferentLine(committed, rebuilt) };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Throws `dist_not_reproducible` / `dist_missing` / `dist_unsealed` / `dist_outfitkit_unavailable`
 * (each with `fix`, the command to run) unless the committed bundle is a rebuild's exact bytes;
 * returns the verdict of `checkDistReproducible` otherwise.
 */
export async function assertDistReproducible(moduleDir, options = {}) {
  const result = await checkDistReproducible(moduleDir, options);
  const fix = `erplora build ${moduleDir}`;
  const fail = (code, message, extra = {}) => {
    throw Object.assign(new Error(`${code}: ${message}`), { code, fix, ...extra });
  };
  switch (result.status) {
    case 'differs':
      fail(
        'dist_not_reproducible',
        `${result.file} is not what ${result.id}'s ui/ gives when rebuilt against hub develop's module SDK ` +
          `(the bytes part at line ${result.line}). It was built with another SDK, an older toolkit or ` +
          `by hand, and it would ship as is. Regenerate it with the hub checkout on develop and commit dist/:\n    ${fix}`,
      );
      break;
    case 'missing':
      fail('dist_missing', `${result.id} has a Web Component and no ${result.file}. Build it and commit dist/:\n    ${fix}`);
      break;
    case 'unsealed':
      fail(
        'dist_unsealed',
        `${result.file} has no dist/${OUTFITKIT_STAMP}: nothing says which OutfitKit it was built with, so no ` +
          `rebuild can vouch for it. Regenerate it and commit dist/:\n    ${fix}`,
      );
      break;
    case 'outfitkit_unavailable':
      fail(
        'dist_outfitkit_unavailable',
        `${result.file} was built with @erplora/outfitkit@${result.sealed} (dist/${OUTFITKIT_STAMP}) and npm ` +
          `could not give that version, so no rebuild can reproduce it (${result.reason}). If it was never ` +
          `published, rebuild with the one the gate installs and commit dist/:\n    ${fix}`,
        { sealed: result.sealed },
      );
      break;
    default:
      return result;
  }
}
