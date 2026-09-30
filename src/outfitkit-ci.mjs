// Which OutfitKit a module's bundle bakes — the one the module gate installs from npm, never the
// copy the toolkit happens to resolve on this machine. module-toolkit#423.
//
// WHY. On a laptop the toolkit's `node_modules/@erplora/outfitkit` is a link to the shared
// `outfitkit/` checkout. On 2026-09-30 it sat at 0.1.79 with npm at 0.1.125, and every local
// `erplora build` baked and SEALED 0.1.79 while the gate ran the module's screen tests against
// npm's: 21 of 27 modules shipped 0.1.79 with tests that needed ≥ 0.1.97 passing in CI.
// `build --check` could not see it, because it rebuilt with the very version the bundle sealed.
// Moving the checkout is not the fix: it changes the library under every other worktree.
//
// THE RULE, one per side, and the two sides agree by construction:
//   - `build` asks npm for what the module declares in its package.json (a version or a range) or
//     `latest` — the rule the gate used for its screen tests (all 27 modules declare `workspace:*`
//     or nothing, so today it is `latest`) — installs it once per version in a cache shared with
//     the fleet's `outfitkit-ci.sh`/`merge-pr.sh` (pm#547), bakes it and seals it;
//   - the gate (`build --check` and the screen tests) takes the SEALED version when there is one:
//     the tests run against what ships, and the rebuild reproduces it byte for byte.
// With `latest` published ~10 times a day, «seal == latest when the gate runs» would be red for
// reasons nobody did; «tests == seal» cannot drift.
//
// No npm, no build: falling back to the local copy is exactly the bug, so `outfitkit_unresolvable`
// stops before `dist/` is touched.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTFITKIT_STAMP } from './outfitkit-stamp.mjs';

export const OUTFITKIT_PACKAGE = '@erplora/outfitkit';

const VERSION = /^\d+\.\d+\.\d+$/;
// The gate's own test for «a spec npm understands», kept identical: a version or a `^`/`~` range.
const CONCRETE_SPEC = /^[~^]?[0-9]/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function declaredSpec(moduleDir) {
  const pkg = readJson(join(moduleDir, 'package.json'));
  const spec = { ...pkg?.dependencies, ...pkg?.devDependencies }[OUTFITKIT_PACKAGE];
  return typeof spec === 'string' && CONCRETE_SPEC.test(spec) ? spec : null;
}

/** The OutfitKit version `dist/outfitkit.json` seals, or null when there is no real one. */
export function sealedOutfitkit(moduleDir) {
  const v = readJson(join(moduleDir, 'dist', OUTFITKIT_STAMP))?.outfitkit;
  return typeof v === 'string' && VERSION.test(v) ? v : null;
}

/** What `build` asks npm for: the module's declared version/range, else `latest`. */
export function buildOutfitkitSpec(moduleDir) {
  return declaredSpec(moduleDir) ?? 'latest';
}

/** What the gate's screen tests install: the sealed version (what ships), else what build would. */
export function gateOutfitkitSpec(moduleDir) {
  return sealedOutfitkit(moduleDir) ?? buildOutfitkitSpec(moduleDir);
}

/** Where installed versions live: `<cache>/<version>/node_modules/@erplora/outfitkit`. */
export function outfitkitCache(env = process.env) {
  if (env.ERPLORA_OUTFITKIT_CACHE) return env.ERPLORA_OUTFITKIT_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'erplora', 'outfitkit');
}

function npm(args, env) {
  return spawnSync('npm', args, { encoding: 'utf8', env });
}

function fail(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

/** The version `spec` resolves to on npm today — the highest match, as `npm install` takes. */
export function npmOutfitkitVersion(spec, { env = process.env } = {}) {
  const res = npm(['view', `${OUTFITKIT_PACKAGE}@${spec}`, 'version', '--json'], env);
  let answer = null;
  if (res.status === 0) {
    try {
      answer = JSON.parse(res.stdout);
    } catch {
      answer = null;
    }
  }
  const version = Array.isArray(answer) ? answer[answer.length - 1] : answer;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    const why = (res.error?.message ?? res.stderr ?? '').trim().split('\n').pop() || 'no version in the answer';
    throw fail(
      'outfitkit_unresolvable',
      `npm could not say which ${OUTFITKIT_PACKAGE}@${spec} the module gate installs (${why}). ` +
        'The bundle is baked with that one, never with the copy this machine has: check the network ' +
        'and run the build again.',
    );
  }
  return version;
}

/**
 * The directory whose `node_modules` holds `@erplora/outfitkit@<version>`, installed from npm the
 * first time and reused after. Installed aside and renamed into place, so a half-done install is
 * never read as the package.
 */
export function fetchOutfitkit(version, { env = process.env } = {}) {
  const cache = outfitkitCache(env);
  const prefix = join(cache, version);
  if (existsSync(join(prefix, 'node_modules', OUTFITKIT_PACKAGE, 'package.json'))) return prefix;
  mkdirSync(cache, { recursive: true });
  const tmp = mkdtempSync(join(cache, '.install.'));
  const res = npm(
    ['install', '--prefix', tmp, '--cache', join(tmp, '.npm-cache'), '--no-audit', '--no-fund', '--loglevel=error',
      '--legacy-peer-deps', `${OUTFITKIT_PACKAGE}@${version}`],
    env,
  );
  if (res.status !== 0 || !existsSync(join(tmp, 'node_modules', OUTFITKIT_PACKAGE, 'package.json'))) {
    rmSync(tmp, { recursive: true, force: true });
    const why = (res.error?.message ?? res.stderr ?? '').trim().split('\n').pop() || `exit ${res.status}`;
    throw fail('outfitkit_unavailable', `npm could not install ${OUTFITKIT_PACKAGE}@${version} (${why})`);
  }
  rmSync(join(tmp, '.npm-cache'), { recursive: true, force: true });
  try {
    renameSync(tmp, prefix);
  } catch {
    // Another build won the race: its copy is as good as ours.
    rmSync(tmp, { recursive: true, force: true });
  }
  return prefix;
}

/**
 * `{ version, prefix }` of the OutfitKit `build` bakes into this module. Throws when npm cannot tell.
 * `version` names it instead (`build --outfitkit <v>`): `merge-pr.sh` rebakes a dist/ conflict with
 * the version the two sides sealed (pm#547). Still from npm, never the toolkit's own copy.
 */
export function resolveOutfitkit(moduleDir, { env = process.env, version: named } = {}) {
  if (named !== undefined) {
    if (typeof named !== 'string' || !VERSION.test(named)) {
      throw fail('outfitkit_version_invalid', `--outfitkit takes a published version like 0.1.125, not '${named}'`);
    }
    return { version: named, prefix: fetchOutfitkit(named, { env }) };
  }
  const version = npmOutfitkitVersion(buildOutfitkitSpec(moduleDir), { env });
  return { version, prefix: fetchOutfitkit(version, { env }) };
}

// `node src/outfitkit-ci.mjs gate-spec <module-dir>`: the spec the module gate's screen tests install.
// `node src/outfitkit-ci.mjs drift <module-dir>`: `<sealed>\t<version build bakes today>` (`-` when
// unsealed) — what the catalog rebake compares (module-toolkit#424); exit 1 when npm cannot tell.
// Real paths on both sides: run through a symlink (macOS's /tmp and /var/folders are ones), argv
// keeps the link while import.meta.url is resolved, and the CLI would print nothing with exit 0.
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, dir] = process.argv.slice(2);
  if (!['gate-spec', 'drift'].includes(cmd) || !dir) {
    process.stderr.write('usage: outfitkit-ci.mjs gate-spec|drift <module-dir>\n');
    process.exit(2);
  }
  const mod = resolve(dir);
  if (cmd === 'gate-spec') {
    process.stdout.write(gateOutfitkitSpec(mod));
  } else {
    try {
      const target = npmOutfitkitVersion(buildOutfitkitSpec(mod));
      process.stdout.write(`${sealedOutfitkit(mod) ?? '-'}\t${target}`);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
  }
}
