// Every scratch `npm install` on the shared gate must use a cache private to its own job —
// module-toolkit#171.
//
// WHAT BROKE. `ci-runner-1` is ONE machine with six runner registrations (`ci-runner-1a`…`1f`,
// module-toolkit#43), and all six log in as the same OS user. npm's cache defaults to `$HOME/.npm`
// — never scoped by `--prefix` — so every `npm install --prefix "$deps" …` in this repository's
// composite actions and its own `ci.yml`, no matter which scratch `$deps` directory it installs
// INTO, was still reading and writing the SAME `/home/runner/.npm` from up to six jobs at once.
// Reproduced across three real runs on 2026-09-03: `ci-runner-1b`, `ci-runner-1e` and `ci-runner-1f`
// (each its own `actions-runner-N` work directory, confirmed distinct from the job logs) all failed
// within the same 20-minute window with npm's arborist bug `Cannot read properties of null
// (reading 'edgesOut')` — the shape a corrupted shared cache takes when two installs race on it.
// Every module gate landing on that runner went red, and a bare re-run did not help: the corruption
// sits in the cache, not in the job.
//
// THE FIX. `--cache` pinned under the SAME scratch `$deps` this install already uses. `$deps`
// is always derived from `$RUNNER_TEMP`, and `$RUNNER_TEMP` IS what differs between the six slots
// (verified: `actions-runner-2`, `-5`, `-6` on the three runs above) — so a cache nested inside it
// is isolated per job the same way the scratch install directory already is, with no new variable
// to keep in sync. A fixed, hard-coded `--cache` path would just move the race, not remove it —
// which is why this asserts the value is derived from `$deps`, not merely present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every place this repository runs a scratch `npm install` on the shared self-hosted runner. */
const CALLERS = [
  '.github/actions/validate-module/action.yml',
  '.github/actions/check-canonical-mirrors/action.yml',
  '.github/workflows/ci.yml',
];

/**
 * Every `npm install` invocation in the file, continuation lines (`\` at end-of-line) joined into
 * one string — the fifth-package install in `validate-module` wraps across several lines.
 */
function npmInstallInvocations(yaml) {
  const lines = yaml.split('\n');
  const invocations = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^npm install\b/.test(lines[i].trim())) continue;
    let text = lines[i];
    let j = i;
    while (text.trimEnd().endsWith('\\') && j + 1 < lines.length) {
      j += 1;
      text += `\n${lines[j]}`;
    }
    invocations.push(text);
  }
  return invocations;
}

for (const caller of CALLERS) {
  test(`${caller}: every scratch npm install pins a cache private to this job`, () => {
    const yaml = readFileSync(join(REPO, caller), 'utf8');
    const invocations = npmInstallInvocations(yaml);
    assert.ok(invocations.length > 0, `expected at least one npm install in ${caller}`);
    for (const invocation of invocations) {
      assert.match(
        invocation,
        /--cache\s+"\$deps\/[^"]+"/,
        'this npm install has no `--cache "$deps/…"`, so it falls back to the default $HOME/.npm ' +
          `— shared by every one of the six slots of ci-runner-1 (module-toolkit#171):\n${invocation}`,
      );
    }
  });
}
