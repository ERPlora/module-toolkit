#!/usr/bin/env node
// Refreshes every file this repository VENDORS from ERPlora/hub — `npm run sync-mirrors`.
//
// WHAT IT REPLACES. A one-line `cp` in package.json that copied exactly one of them
// (`schemas/module.schema.json`) and read the hub's WORKING TREE. Both halves had to change when
// the kernel contract arrived (module-toolkit#115, ADR «El Hub se CIERRA como KERNEL»):
//
//   * the schema stopped being the only vendored file — `contracts/kernel/` adds five more, and a
//     file whose only way of being refreshed is by hand is a file that gets refreshed in a hurry,
//     one at a time, by whoever the mirror happened to catch;
//
//   * `cp ../hub/…` copies whatever branch the neighbouring checkout was left on, with whatever is
//     uncommitted in it. `test/canonical-mirrors.test.mjs` compares against `origin/develop`
//     (module-toolkit#90), so the old `cp` could produce a copy the mirrors then rejected — the
//     resync and the check disagreeing about what "the hub" means.
//
// So the source is resolved by the SAME code the mirrors use (`test/hub-mirror.mjs`): declared
// `ERPLORA_HUB_DIR` read from disk, otherwise the sibling `../hub` read at `origin/develop`. One
// definition of the canonical side, used by the thing that checks and by the thing that fixes.
//
// It never syncs SILENTLY: no hub, or a hub missing a file, is an error. A sync that copies nothing
// and exits 0 leaves the copies exactly as stale as they were, under a green line. And since
// module-toolkit#249, neither does a hub that is THERE and OUT OF DATE — see `theHubItReallyIs`.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { hubSource, hubPath } from '../test/hub-mirror.mjs';
import { KERNEL_CONTRACT_FILES } from '../src/kernel-contract.mjs';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every path vendored from the hub, identical on both sides. */
export const VENDORED_FROM_THE_HUB = [
  'schemas/module.schema.json',
  // module-toolkit#209: the flow document contract. Vendored so `erplora validate` can judge the
  // automations a module ships in `flows/` on a runner with no hub — see `src/flow-schema.mjs`.
  'schemas/flow.schema.json',
  ...KERNEL_CONTRACT_FILES.map((file) => `contracts/kernel/${file}`),
];

/** Runs git in a checkout. Injected in tests, so the guard below needs neither repo nor network. */
function runGit(dir, args) {
  const done = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return { status: done.status ?? 128, stdout: done.stdout ?? '', stderr: done.stderr ?? '' };
}

/** How a commit is named in these messages: enough to compare two of them at a glance. */
const short = (sha) => sha.slice(0, 7);

/**
 * The commit the sibling checkout would be copied from, CHECKED against the hub's own remote —
 * module-toolkit#249.
 *
 * The sibling `../hub` is read at `origin/develop` (`test/hub-mirror.mjs`), and that is a LOCAL
 * remote-tracking ref: it is only as fresh as the last `git fetch` somebody ran in a checkout the
 * whole fleet shares. Measured on 2026-09-09, resyncing `schemas/flow.schema.json` after hub#1713
 * had been in `develop` for hours: nobody had fetched, so this script would have copied the OLD
 * schema over the old schema and printed `✓ 7 vendored files, all already in sync`. A resync that
 * resyncs nothing and reports success is worse than one that fails — the drift stays, and now
 * there is a green line saying it does not.
 *
 * Fetching here instead of refusing was the other option and is rejected on purpose: that checkout
 * belongs to whoever else is working in it, and a tool that writes into someone else's repository
 * to make its own check pass is how a shared checkout ends up mid-operation under an agent that
 * never touched it. This says what is wrong and what to run.
 *
 * @param {{dir: string, ref: string}} source the sibling checkout and the ref it is read at
 * @param {typeof runGit} [git]
 * @returns {string} the commit both sides agree the hub is at
 */
export function theHubItReallyIs({ dir, ref }, git = runGit) {
  const [remote, ...rest] = ref.split('/');
  const branch = rest.join('/');

  const here = git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (here.status !== 0) {
    throw new Error(
      `\`${dir}\` cannot say what \`${ref}\` is (${here.stderr.trim() || `git exit ${here.status}`}). ` +
        'The vendored copies are read from the hub at that ref, so without it there is nothing to ' +
        `copy from: run \`git -C ${dir} fetch ${remote} ${branch}\`.`,
    );
  }
  const mine = here.stdout.trim();

  const asked = git(dir, ['ls-remote', remote, branch]);
  const line = asked.status === 0 ? asked.stdout.split('\n').find((l) => l.endsWith(`refs/heads/${branch}`)) : null;
  if (!line) {
    throw new Error(
      `could not ask \`${remote}\` what \`${branch}\` is — \`git ls-remote\` in \`${dir}\` ` +
        `answered ${asked.status === 0 ? 'no such branch' : asked.stderr.trim() || `exit ${asked.status}`}. ` +
        `\`${ref}\` here is ${short(mine)}, and whether that is still the hub cannot be shown, so ` +
        'this stops instead of copying: a sync nobody can prove is fresh is exactly the one that ' +
        'vendors a stale contract under a green line (module-toolkit#249).',
    );
  }

  const canonical = line.split(/\s+/)[0];
  if (canonical !== mine) {
    throw new Error(
      `\`${dir}\` has \`${ref}\` at ${short(mine)}, and \`${remote}\` says \`${branch}\` is ` +
        `${short(canonical)}. That checkout is SHARED and its remote-tracking ref is only as fresh ` +
        'as the last fetch anyone happened to run in it, so syncing now would copy a hub that has ' +
        'moved on — every file would arrive, nothing would change, and the run would report ' +
        `\`all already in sync\`. Run \`git -C ${dir} fetch ${remote} ${branch}\` and try again.`,
    );
  }
  return mine;
}

/**
 * `hubPath` skips when there is no hub, which is right for a test and wrong here: this script's
 * whole job is to copy, so "nothing to copy from" is a failure, not a quieter success.
 */
const REFUSES_TO_SKIP = {
  skip(reason) {
    throw new Error(reason);
  },
};

/**
 * Copies every vendored file from the hub into this checkout.
 *
 * @param {object} [options]
 * @param {ReturnType<typeof hubSource>} [options.source] where the hub is, and how it is read
 * @param {string} [options.toolkitRoot] the checkout to write into
 * @param {(line: string) => void} [options.log] where the per-file report goes
 * @param {typeof runGit} [options.git] how git is run, for the freshness check of a sibling hub
 * @returns {{path: string, changed: boolean}[]} what was copied, and what it changed
 */
export function syncFromTheHub({
  source = hubSource(),
  toolkitRoot = TOOLKIT,
  log = console.log,
  git = runGit,
} = {}) {
  if (source.kind === 'absent') {
    throw new Error(
      `there is no ERPlora/hub to sync from (looked in \`${source.dir}\`). Clone the hub alongside ` +
        'this repository, or point ERPLORA_HUB_DIR at one: copying nothing and exiting 0 would ' +
        'leave every vendored copy as stale as it is now, and report success for it.',
    );
  }

  // A DECLARED hub (`ERPLORA_HUB_DIR`) is read from its working tree and is exempt on purpose: the
  // pair flow syncs from a hub WORKTREE carrying a contract change that is not in `develop` yet,
  // and CI declares a tarball of the `module-sdk` action with no `.git` at all. There the promise
  // accepted is "read THIS tree". "The sibling, at `origin/develop`" is a claim about the hub, and
  // a claim gets checked — before a single byte moves (module-toolkit#249).
  if (source.kind === 'git') {
    log(`✓ ${source.ref} is ${short(theHubItReallyIs(source, git))} here and in \`${source.ref.split('/')[0]}\``);
  }

  const synced = [];
  for (const path of VENDORED_FROM_THE_HUB) {
    const canonical = hubPath(REFUSES_TO_SKIP, ...path.split('/'), source);
    const destination = join(toolkitRoot, ...path.split('/'));
    const before = existsSync(destination) ? readFileSync(destination) : null;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(canonical, destination);
    const changed = before === null || !before.equals(readFileSync(destination));
    synced.push({ path, changed });
    log(`${changed ? '↻' : '='} ${path}`);
  }
  return synced;
}

/** Run as a command: report where the hub came from, then what moved. */
function main() {
  const source = hubSource();
  const from =
    source.kind === 'declared'
      ? `ERPLORA_HUB_DIR=${source.dir} (working tree)`
      : `${source.dir} at ${source.ref}`;
  console.log(`→ syncing the vendored copies from ${from}`);
  const synced = syncFromTheHub({ source });
  const moved = synced.filter((s) => s.changed);
  console.log(
    moved.length === 0
      ? `✓ ${synced.length} vendored files, all already in sync`
      : `✓ ${synced.length} vendored files, ${moved.length} updated — commit them`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
}
