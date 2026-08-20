// Where the mirrors look for ERPlora/hub, and what happens when it is not there
// (module-toolkit#61).
//
// A guard that skips does not deny: it stays OPEN. The six mirrors of
// `canonical-mirrors.test.mjs` each opened with `if (!existsSync(x)) return t.skip(...)`, so a run
// with no hub reported `pass 0 · fail 0 · skipped 7` and the job went green — the same shape a
// PASS has in a summary nobody reads twice.
//
// THE DISTINCTION THIS FILE MAKES. "There is no hub" and "the hub you NAMED is not there" are not
// the same fact:
//
//   * Nobody declared one → an honest skip. The toolkit's own CI has no hub and cannot obtain one:
//     organization secrets do not reach private repositories on the free plan
//     (docs.github.com/actions → "Organization-level secrets and variables are not accessible by
//     private repositories for GitHub Free"), so there is no credential for `actions/checkout` of
//     ERPlora/hub, and putting a read token in 25 repos is a security decision rather than a CI
//     detail. That is why the drift is gated from the HUB's side, where the hub IS checked out:
//     `.github/actions/check-canonical-mirrors`, called by the hub's own workflow.
//
//   * `ERPLORA_HUB_DIR` was set and the file is not under it → an ERROR. The promise "compare
//     against THIS hub" was accepted and then quietly dropped, which is worse than never making
//     it: a typo in the path, or a checkout that has since moved, switches all six mirrors off and
//     the summary still says green. It happened for real — a worker ran the suite from a worktree,
//     reported "full suite green, canonical-mirrors included", and none of them had run.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The hub checkout to compare against, and whether it was DECLARED (`ERPLORA_HUB_DIR`) or merely
 * guessed as the sibling of this repository. The difference is what decides skip vs error.
 */
export function hubDir(env = process.env) {
  const declared = Boolean(env.ERPLORA_HUB_DIR);
  return { dir: declared ? env.ERPLORA_HUB_DIR : join(TOOLKIT, '..', 'hub'), declared };
}

/**
 * A file inside the hub checkout, or `null` after skipping the test when no hub was declared and
 * none sits alongside. Throws when a DECLARED hub does not carry the file.
 *
 * @param {{skip: (reason: string) => void}} t the test context
 * @param {...string} segments path of the file inside the hub, then optionally `{hubDir, declared}`
 */
export function hubPath(t, ...segments) {
  const last = segments.at(-1);
  const opts = typeof last === 'object' && last !== null ? segments.pop() : {};
  const { dir, declared } = 'hubDir' in opts ? { dir: opts.hubDir, declared: opts.declared } : hubDir();

  const full = join(dir, ...segments);
  if (existsSync(full)) return full;

  if (declared) {
    throw new Error(
      `ERPLORA_HUB_DIR points at \`${dir}\`, and \`${segments.join('/')}\` is not under it. ` +
        'A declared hub that cannot be read is an error, never a skip: leaving it as a skip is how ' +
        'six mirrors switch themselves off while the run still reports green (module-toolkit#61). ' +
        'Fix the path, or unset ERPLORA_HUB_DIR to say honestly that there is no hub to compare with.',
    );
  }

  t.skip(
    `ERPlora/hub is not in this checkout (looked in \`${dir}\`) — these mirrors are gated from the ` +
      "hub's own CI instead; set ERPLORA_HUB_DIR to run them here",
  );
  return null;
}
