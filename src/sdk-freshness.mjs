// Is the module SDK that `erplora build` is about to bake behind hub `develop`? — module-toolkit#387.
//
// WHY. In the monorepo the toolkit resolves `@erplora/module-sdk` through its `file:` devDependency
// into the SHARED `../hub` checkout, on whatever branch it was left (`src/resolve-plugin.mjs`). The
// bundle is published as committed, so a rebuild there ships the OLD SDK and silently undoes fixes
// already out: on 2026-09-27 four rebuilds took the list controller back to filtering money in
// cents (sales, pricing, kitchen ×2 — one nearly undid kitchen#109).
//
// WHAT COUNTS AS BEHIND. develop has commits touching `packages/module-sdk` or
// `packages/module-types` that the checkout's HEAD does not, AND what is on disk there differs from
// develop. A checkout AHEAD (a hub branch trying an SDK change on a module) or behind only outside
// the SDK builds: what it bakes is not older than develop's.
//
// WHERE DEVELOP COMES FROM. The `developSha` option, else `ERPLORA_HUB_DEVELOP_SHA`, else
// `git ls-remote origin refs/heads/develop` in the hub checkout; a commit the clone lacks is fetched.
// When none of that answers (offline, no `origin`) the result says `unverifiable` and why: the
// build warns and goes on, it cannot claim a staleness it did not see.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolvePinned } from './resolve-plugin.mjs';

/** The hub paths `erplora build` bakes into a bundle (the SDK and its types). */
export const SDK_HUB_PATHS = ['packages/module-sdk', 'packages/module-types'];

const SDK_PREFIX = 'packages/module-sdk/';
const SHA = /^[0-9a-f]{40}$/;

function runGit(dir, args, { timeout = 60_000 } = {}) {
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    timeout,
    // A private remote must fail, not sit waiting for a password nobody will type.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim() };
}

/**
 * The directory of the `@erplora/module-sdk` a build resolves, or null when none is installed (a
 * module that imports it then fails in esbuild with its own «could not resolve»).
 */
export function resolvedSdkDir({ resolve = resolvePinned } = {}) {
  try {
    return dirname(resolve('@erplora/module-sdk/package.json'));
  } catch {
    return null;
  }
}

/** develop's sha as the caller, the environment or the hub's `origin` gives it; null if none does. */
function readDevelopSha(hubDir, { developSha, env, git }) {
  const given = developSha ?? env.ERPLORA_HUB_DEVELOP_SHA;
  if (given) return given.trim();
  const remote = git(hubDir, ['ls-remote', 'origin', 'refs/heads/develop'], { timeout: 20_000 });
  const sha = remote.ok ? remote.out.split(/\s+/)[0] : '';
  return SHA.test(sha) ? sha : null;
}

function hasCommit(hubDir, sha, git) {
  return git(hubDir, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/**
 * @param {string|null} sdkDir the resolved `@erplora/module-sdk` directory (null: none installed)
 * @param {{developSha?: string, env?: NodeJS.ProcessEnv, git?: typeof runGit}} [options]
 * @returns {{status: 'fresh'|'behind'|'no_hub_checkout'|'unverifiable', reason?: string,
 *   hubDir?: string, head?: string, branch?: string, develop?: string, behind?: number}}
 */
export function checkSdkFreshness(sdkDir, { developSha, env = process.env, git = runGit } = {}) {
  if (!existsSync(sdkDir)) return { status: 'no_hub_checkout' };
  const prefix = git(sdkDir, ['rev-parse', '--show-prefix']);
  // The npm tarball's `vendor/` copy, or a plain directory: no hub history to compare with.
  if (!prefix.ok || prefix.out !== SDK_PREFIX) return { status: 'no_hub_checkout' };
  const hubDir = join(sdkDir, '..', '..');
  const head = git(hubDir, ['rev-parse', 'HEAD']).out;
  const branch = git(hubDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const base = { hubDir, head, branch };

  const develop = readDevelopSha(hubDir, { developSha, env, git });
  if (!develop) return { ...base, status: 'unverifiable', reason: 'develop_unreadable' };
  if (!hasCommit(hubDir, develop, git)) {
    git(hubDir, ['fetch', '--quiet', 'origin', 'develop']);
    if (!hasCommit(hubDir, develop, git)) {
      return { ...base, develop, status: 'unverifiable', reason: 'develop_commit_missing' };
    }
  }

  // Same bytes on disk as develop's SDK (working tree included): nothing older can be baked.
  if (git(hubDir, ['diff', '--quiet', develop, '--', ...SDK_HUB_PATHS]).ok) {
    return { ...base, develop, status: 'fresh' };
  }
  const count = git(hubDir, ['rev-list', '--count', `HEAD..${develop}`, '--', ...SDK_HUB_PATHS]);
  // The bytes differ: only the history tells behind from ahead, so without it nothing is claimed.
  if (!count.ok) return { ...base, develop, status: 'unverifiable', reason: 'sdk_history_unreadable' };
  const behind = Number(count.out) || 0;
  if (behind === 0) return { ...base, develop, status: 'fresh' };
  return { ...base, develop, behind, status: 'behind' };
}

/**
 * The command that brings the checkout's SDK up to develop, and how to undo it. Only a local
 * `develop` is fast-forwarded: any other branch may be someone else's work in a SHARED checkout
 * (`../hub` sat on feat/1844 on 2026-09-27), so it is left untouched and HEAD is detached onto
 * develop instead — non-destructive, and one command away from the branch again.
 */
function updateCommand({ hubDir, branch, develop }, git) {
  const q = `'${hubDir.replace(/'/g, `'\\''`)}'`;
  const fetch = `git -C ${q} fetch origin develop`;
  if (branch === 'develop' && git(hubDir, ['merge-base', '--is-ancestor', 'HEAD', develop]).ok) {
    return { fix: `${fetch} && git -C ${q} merge --ff-only origin/develop`, back: null };
  }
  const back = branch && branch !== 'HEAD' ? `git -C ${q} switch ${branch}` : null;
  return { fix: `${fetch} && git -C ${q} switch --detach origin/develop`, back };
}

/**
 * Throws `module_sdk_behind_develop` (with `fix`, the command to run) when the SDK a build would
 * bake is behind hub develop; otherwise returns the verdict of `checkSdkFreshness`.
 *
 * @param {{sdkDir?: string|null, developSha?: string, env?: NodeJS.ProcessEnv, git?: typeof runGit}} [options]
 *   `sdkDir` defaults to the SDK the build resolves; `null` means none is installed.
 */
export function assertSdkFresh({ sdkDir, git = runGit, ...options } = {}) {
  const dir = sdkDir === undefined ? resolvedSdkDir() : sdkDir;
  const result = checkSdkFreshness(dir, { ...options, git });
  if (result.status !== 'behind') return result;
  const { fix, back } = updateCommand(result, git);
  throw Object.assign(
    new Error(
      `the module SDK in ${dir} is ${result.behind} commit(s) behind hub develop ` +
        `(${result.branch}@${result.head.slice(0, 7)}, develop is ${result.develop.slice(0, 7)}): ` +
        'this build would ship the old SDK and undo fixes already published. ' +
        `Update that hub checkout and build again:\n    ${fix}` +
        (back ? `\n  Its branch keeps its commits; back to it afterwards with:\n    ${back}` : ''),
    ),
    { code: 'module_sdk_behind_develop', fix, behind: result.behind, hubDir: result.hubDir },
  );
}
