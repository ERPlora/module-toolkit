// Every scratch npm-install directory on the shared gate starts EMPTY on every job —
// module-toolkit#171 (reopened), kept as belt and braces.
//
// WHAT THIS IS, AND WHAT IT IS NOT. The reopening of #171 hypothesised that `$deps`
// (`$RUNNER_TEMP/erplora-…-deps`, a FIXED name) survived from one job to the next on a self-hosted
// slot, half-installed, and tripped npm's arborist. Measured on ci-runner-1 on 2026-09-03 it does
// not: the runner wipes `_work/_temp` at the start of every job (every idle slot holds an empty
// `_temp`, mtime = the end of its last job), and the crash reproduced 4/4 in a FRESH prefix with a
// FRESH cache. Its real cause is the vitest 5.0.0 release meeting npm 10's peer-set walker — the
// story and the guard that closes it live in `npm-scratch-install-skips-peer-resolution.test.mjs`.
//
// WHY THE WIPE STAYS. The runner's cleanup is best-effort on its side, and a scratch install must
// never DEPEND on it having succeeded: `rm -rf "$deps"` right before every `mkdir -p "$deps"`
// makes each job start its install from nothing regardless of what any previous job on the same
// slot left behind — it rides the identical `$deps` derivation #172 already proved isolates by
// slot. This asserts the wipe is there, not merely that `mkdir -p` runs.
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
