// Every scratch npm-install directory on the shared gate must start EMPTY on every job —
// module-toolkit#171 (reopened).
//
// WHAT BROKE, TWICE. #172 (8dc31db) gave every scratch install a private `--cache "$deps/…"`,
// on the theory that `ci-runner-1`'s six slots (module-toolkit#43) were racing on the shared
// `$HOME/.npm`. That premise was true but not the cause: re-running the same six blocked module
// PRs with the fix already on `main` still failed in the same place, same error — evidence
// `33757710972` (taxes, 2026-09-03T16:23:23Z), with the PRIVATE `.npm-cache` already visible in
// the failing log path.
//
// THE REAL CAUSE. `$deps` (`$RUNNER_TEMP/erplora-…-deps`) is a FIXED name, and `$RUNNER_TEMP` on
// a self-hosted runner is the slot's own persistent `_work/_temp` — it is not wiped between jobs
// the way a GitHub-hosted runner's workspace is. So `$deps/node_modules` from a job that got
// killed mid-install (OOM, a cancelled run, a `docker rm -f` racing it — module-toolkit#43 again)
// survives to the NEXT job on that slot, half-installed: dangling symlinks, a partial dependency
// tree. npm's arborist reads that leftover tree to compute what changed, and a half-installed
// tree is exactly the shape that trips its `Cannot read properties of null (reading 'edgesOut')`
// bug — no race needed, a stale directory is enough on its own.
//
// THE FIX. `rm -rf "$deps"` right before every `mkdir -p "$deps"`, so each job's scratch install
// starts from nothing regardless of what a previous job on the same slot left behind — the same
// place `--cache` was pinned, so this rides the identical `$deps` derivation #172 already proved
// isolates by slot. This asserts the wipe is there, not merely that `mkdir -p` runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every place this repository derives a scratch npm-install directory from $RUNNER_TEMP. */
const CALLERS = [
  '.github/actions/validate-module/action.yml',
  '.github/actions/check-canonical-mirrors/action.yml',
  '.github/workflows/ci.yml',
];

/**
 * Each `deps="$RUNNER_TEMP/…"` assignment, paired with the run step's lines up to (and
 * including) its `mkdir -p "$deps"` — the window in which the wipe must appear.
 *
 * Scoped to the `deps` variable name on purpose: it is the one every scratch npm-install site in
 * this repository uses (`erplora-validator-deps`, `erplora-module-ui-deps`,
 * `erplora-mirror-deps`). A `$RUNNER_TEMP` scratch directory for something else entirely — e.g. a
 * Python `venv` — is not this bug's shape and must not be dragged into this assertion.
 */
function scratchDirBlocks(yaml) {
  const lines = yaml.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const assign = lines[i].match(/^\s*(deps)="\$RUNNER_TEMP\/[^"]+"\s*$/);
    if (!assign) continue;
    const varName = assign[1];
    const mkdirRe = new RegExp(`^\\s*mkdir -p "\\$${varName}"`);
    let end = -1;
    for (let j = i + 1; j < lines.length && j < i + 10; j += 1) {
      if (mkdirRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    assert.ok(
      end !== -1,
      `${varName}="$RUNNER_TEMP/…" at line ${i + 1} has no \`mkdir -p "$${varName}"\` within 10 lines`,
    );
    blocks.push({ varName, lines: lines.slice(i, end + 1) });
  }
  return blocks;
}

for (const caller of CALLERS) {
  test(`${caller}: every scratch npm-install directory is wiped before reuse`, () => {
    const yaml = readFileSync(join(REPO, caller), 'utf8');
    const blocks = scratchDirBlocks(yaml);
    assert.ok(blocks.length > 0, `expected at least one scratch deps directory in ${caller}`);
    for (const { varName, lines } of blocks) {
      const rmRe = new RegExp(`^\\s*rm -rf "\\$${varName}"`);
      assert.ok(
        lines.some((line) => rmRe.test(line)),
        `$${varName} is never \`rm -rf\`'d before its \`mkdir -p\` — on ci-runner-1's persistent ` +
          `$RUNNER_TEMP a job that starts here reuses whatever a PREVIOUS job on the same slot ` +
          `left behind (module-toolkit#171, reopened):\n${lines.join('\n')}`,
      );
    }
  });
}
