// The gate's YAML says what the toolkit's code assumes — ERPlora/hub#1097.
//
// WHY A TEST OVER YAML. `run-vitest.mjs` now FAILS a module whose `.test.ts` cannot run, and the
// only reason they can run is a chain of three links written in two files nobody executes locally:
//
//   module-gate.yml  →  uses ERPlora/hub/.github/actions/module-sdk@develop   (the SDK on disk)
//                    →  passes its output into validate-module
//   validate-module  →  links it into the module's node_modules/@erplora/module-sdk
//
// Delete any link and the gate goes RED on 26 repos at once, blaming the modules for a package the
// gate stopped supplying. That is the failure this file is here to catch on the pull request that
// introduces it, not on the fleet.
//
// It asserts the WIRING, never the wording: what has to hold is that the two files still name the
// same action, the same output and the same input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = readFileSync(join(REPO, '.github/workflows/module-gate.yml'), 'utf8');
const VALIDATE = readFileSync(join(REPO, '.github/actions/validate-module/action.yml'), 'utf8');

/** The action that carries the SDK, pinned the same way the gate pins the validator. */
const SDK_ACTION = 'ERPlora/hub/.github/actions/module-sdk@develop';

/**
 * The lines of the step that `uses:` the given action, up to the next step. Comments stripped:
 * what is asserted is the step's KEYS, not the prose around them — an earlier version of this
 * matched the word «token» inside the comment that explains why there is no token.
 */
function stepUsing(yaml, action) {
  const lines = yaml.split('\n');
  const at = lines.findIndex((l) => l.trim() === `uses: ${action}`);
  assert.notEqual(at, -1, `no step uses ${action}`);
  const indent = lines[at].search(/\S/);
  const out = [];
  // Walk backwards over the keys of the same step (`- id: sdk` sits above the `uses:`).
  for (let i = at; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.trim().startsWith('#') || !l.trim()) continue;
    out.unshift(l);
    if (l.trimStart().startsWith('- ')) break;
  }
  for (let i = at + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim().startsWith('#') || !l.trim()) continue;
    if (l.search(/\S/) < indent || l.trimStart().startsWith('- ')) break;
    out.push(l);
  }
  return out.join('\n');
}

test('the gate fetches the SDK through the hub action, with no credential', () => {
  const step = stepUsing(GATE, SDK_ACTION);
  assert.doesNotMatch(
    step,
    /\btoken\s*:/,
    'the whole point is that it resolves without one — a token here would be a PAT in 26 repos',
  );
});

test('what the hub action outputs is what validate-module is given', () => {
  const step = /id:\s*(\S+)[\s\S]{0,300}?uses:\s*ERPlora\/hub\/\.github\/actions\/module-sdk@develop/.exec(
    GATE,
  );
  assert.ok(step, 'the SDK step must carry an `id:` — its output is read by name');
  const id = step[1];
  assert.match(
    GATE,
    new RegExp(`module-sdk-path:\\s*\\$\\{\\{\\s*steps\\.${id}\\.outputs\\.path\\s*\\}\\}`),
    `module-gate.yml must pass steps.${id}.outputs.path as \`module-sdk-path\``,
  );
});

test('validate-module declares the input and links it where node will look', () => {
  assert.match(VALIDATE, /^\s{2}module-sdk-path:/m, 'the input has to exist to be passed');
  assert.match(
    VALIDATE,
    /node_modules\/@erplora\/module-sdk/,
    'and it has to end up where node resolves it from the module',
  );
});

test('an absent SDK is never silently tolerated by the gate', () => {
  // The mirror of `run-vitest.mjs`: if the path arrives empty the step must say so and stop, not
  // skip the link and let the module go red on «Cannot find module».
  assert.match(
    VALIDATE,
    /module-sdk-path[\s\S]*?exit 1/,
    'validate-module must fail loudly when the SDK path it was promised is not there',
  );
});
