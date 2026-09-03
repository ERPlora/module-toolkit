// Every scratch `npm install` on the shared gate must skip npm's peer-dependency resolution —
// module-toolkit#171 (reopened): the third diagnosis, and the one that reproduces.
//
// WHAT BROKE. On 2026-09-03 between 12:21Z and 12:24Z the whole `vitest@5.0.0` family was
// published (`vitest`, `@vitest/ui`, `@vitest/coverage-v8`, `@vitest/browser-*`, …). The gate
// installs `vitest@^4.1.10`, which still resolves to 4.1.10 — but 4.1.10 declares those same
// packages as OPTIONAL peers pinned to `4.1.10`, and the arborist bundled with npm 10.9.x (the npm
// of Node 22: this action's default `node-version`, and what all six slots of ci-runner-1 carry,
// npm 10.9.8 measured) crashes walking that peer set the minute their `latest` moved to 5.0.0:
// `#loadPeerSet`, three levels deep under `idealTree:node_modules/vitest`, «Cannot read properties
// of null (reading 'edgesOut')». Timeline: last green install 12:03:08Z (taxes run 33752991977,
// «added 65 packages in 7s»), first red 12:24:19Z (appointments job 100645204000), same step,
// same command, same slot (`ci-runner-1e`).
//
// Neither earlier fix could touch this: #172's private `--cache` and the `rm -rf "$deps"` beside
// it both assume a dirty runner, and the runner was clean — the crash reproduced 4/4 on
// 2026-09-03 with npm 10.9.4 and 10.9.8 in a FRESH prefix with a FRESH cache. The same command
// passes with npm 11.16, and passes with npm 10.9.8 plus `--legacy-peer-deps`, producing the
// identical 97-entry tree npm 11 produces.
//
// THE FIX. `--legacy-peer-deps` on every scratch install: arborist then never builds a peer set,
// so no registry-side release of a peer family can crash it again. Nothing here relies on npm
// auto-installing peers — each step installs a fixed, explicit list of tools into a throwaway
// prefix, and vitest's only required peer (`vite`) is also its regular dependency. This asserts
// the flag is on every `npm install` in every caller, so the next scratch install added to the
// gate inherits the rule instead of re-finding the crash.
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
  test(`${caller}: every scratch npm install skips peer-dependency resolution`, () => {
    const yaml = readFileSync(join(REPO, caller), 'utf8');
    const invocations = npmInstallInvocations(yaml);
    assert.ok(invocations.length > 0, `expected at least one npm install in ${caller}`);
    for (const invocation of invocations) {
      assert.match(
        invocation,
        /(^|\s)--legacy-peer-deps(\s|\\|$)/,
        'this npm install has no `--legacy-peer-deps`, so npm 10 builds a peer set for it and ' +
          'crashes the day a peer family bumps major on the registry — vitest 5.0.0 took the whole ' +
          `module CI down on 2026-09-03 (module-toolkit#171):\n${invocation}`,
      );
    }
  });
}
