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

// ADR-0398 (module-toolkit#101): the errors-catalog guard compares the manifest against the last
// `chore(release)` commit. With the default shallow checkout (depth 1) that commit is not on disk
// and the guard would silently have no previous self to compare with — a guard that cannot see
// the past passes everything.
test('the gate checks out the FULL history so the last chore(release) commit is there to diff', () => {
  // `stepUsing` keys on a `uses:` continuation line; the checkout is the step's FIRST line
  // (`- uses:`), so the step is read directly: from that line to the next `- `.
  const lines = GATE.split('\n');
  const at = lines.findIndex((l) => l.trim() === '- uses: actions/checkout@v4');
  assert.notEqual(at, -1, 'the gate checks the module out with actions/checkout@v4');
  const step = [];
  for (let i = at + 1; i < lines.length && !lines[i].trimStart().startsWith('- '); i += 1) {
    if (!lines[i].trim().startsWith('#')) step.push(lines[i]);
  }
  assert.match(step.join('\n'), /fetch-depth:\s*0/, 'fetch-depth: 0 on the module checkout');
});

// ── The handler's Rust tests (module-toolkit#146) ────────────────────────────────────────────────
//
// One more chain written in YAML that nothing executes locally, and it is LONGER than the SDK one:
//
//   module-gate.yml  →  ERPlora/hub/.github/actions/module-sdk@develop   (the whole hub on disk)
//                    →  passes its output into validate-module
//   validate-module  →  derives the hub root two levels above `module-sdk-path`
//                    →  exports it as ERPLORA_HUB_DIR
//   run-cargo.mjs    →  reads ERPLORA_HUB_DIR and farms the layout the relative path expects
//
// Break any link and 21 gates stop running 925 tests — and, because «not run» is reported as a ⚠
// and not as a red, they stop running them QUIETLY. That is the exact failure #74 spent a month
// discovering. This is the pull request that would introduce it, caught here.

test('validate-module derives the hub from the SDK path and hands it over as ERPLORA_HUB_DIR', () => {
  assert.match(
    VALIDATE,
    /hub=\$\(cd "\$sdk\/\.\.\/\.\." && pwd\)/,
    'the hub root is two levels above `packages/module-sdk` — the same derivation ci.yml uses',
  );
  assert.match(
    VALIDATE,
    /ERPLORA_HUB_DIR=\$hub" >> "\$GITHUB_ENV"/,
    'and it must reach the toolkit through the environment variable run-cargo.mjs reads',
  );
});

test('the variable the gate exports is the one the toolkit reads', async () => {
  const { HUB_DIR_VAR } = await import('../src/run-cargo.mjs');
  assert.match(
    VALIDATE,
    new RegExp(`${HUB_DIR_VAR}=`),
    `run-cargo.mjs reads ${HUB_DIR_VAR}; the gate has to export that exact name`,
  );
});

test('a hub checkout without the guest-sdk stops the gate instead of blaming the module', () => {
  // The mirror of the `module-sdk-path` rule: a moved crate must fail HERE, where the wiring is,
  // and not three steps later as a module whose handler «does not compile».
  assert.match(
    VALIDATE,
    /crates\/guest-sdk\/Cargo\.toml[\s\S]{0,400}?exit 1/,
    'validate-module must verify the guest-sdk is really under the hub it derived',
  );
});

test('the Rust step is driven by the toolkit’s own count, never by an `ls` of handler/', () => {
  // module-toolkit#55 in one line: the moment the gate re-implements discovery in YAML, the two
  // disagree. The toolchain step keys on `steps.batteries.outputs.rust`, which comes from `--list`.
  assert.match(VALIDATE, /rust=\$rs" >> "\$GITHUB_OUTPUT"/, 'the `--list` output is counted, not `handler/`');
  assert.match(
    VALIDATE,
    /if:\s*steps\.batteries\.outputs\.rust\s*!=\s*'0'/,
    'and the toolchain is installed only for a module that actually has Rust tests',
  );
});

test('a rustup that dies on the machine is annotated as infrastructure, not as the module', () => {
  // module-toolkit#138: a failed download on a full disk used to read «exit 125» in a MODULE's
  // checks list. Every machine-caused death goes through the shared helper.
  assert.match(VALIDATE, /erplora_infra_fail 'no se ha podido descargar el instalador de rustup'/);
  assert.match(VALIDATE, /erplora_infra_fail 'rustup no ha podido instalar la toolchain de Rust'/);
});

test('this repository’s own CI installs Rust, so the #146 controls cannot skip', () => {
  const CI = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');
  assert.match(CI, /sh\.rustup\.rs/, 'the two real-cargo controls must never be allowed to skip');
  assert.match(CI, /test\/run-cargo\.test\.mjs/, 'and the suite that holds them must be in the list');
});

// ── The hub battery pairing is WIRED, and reuses the SDK step's checkout (#163) ─────────────
// Same failure this file exists for, one chain further: the pairing guard is only reachable
// because the `sdk` step already dragged the whole ERPlora/hub onto the runner. Delete that step,
// rename its output, or drop this one, and the guard stops running — silently, on 27 repos, with
// nothing red to say the pair is no longer being checked. hub#1381 is that exact defect.
const PAIRING_ACTION = 'ERPlora/module-toolkit/.github/actions/check-hub-battery-pairing@main';

test('the gate runs the hub battery pairing guard, fed by the SDK step', () => {
  const step = stepUsing(GATE, PAIRING_ACTION);
  assert.match(
    step,
    /sdk-path:\s*\$\{\{\s*steps\.sdk\.outputs\.path\s*\}\}/,
    'the pairing guard must read the hub from the checkout the `sdk` step already fetched — '
      + 'anything else would need a credential this repository cannot have',
  );
  assert.match(
    step,
    /base-sha:\s*\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/,
    'without the base sha the diff is empty and the guard passes everything',
  );
  assert.match(step, /path:\s*\$\{\{\s*inputs\.path\s*\}\}/);
});

test('the pairing guard runs on pull_request, where the other edit can still be demanded', () => {
  const step = stepUsing(GATE, PAIRING_ACTION);
  assert.match(
    step,
    /if:\s*github\.event_name == 'pull_request'/,
    'the pair breaks at the MERGE, so the demand belongs on the pull request',
  );
});

test('the pairing action exists and takes the three inputs the gate passes', () => {
  const action = readFileSync(
    join(REPO, '.github/actions/check-hub-battery-pairing/action.yml'),
    'utf8',
  );
  for (const input of ['path:', 'sdk-path:', 'base-sha:']) {
    assert.match(action, new RegExp(`\\n {2}${input.replace('-', '-')}`), `missing input ${input}`);
  }
  assert.match(
    action,
    /src\/check-hub-battery-pairing\.mjs/,
    'the action must invoke the checked module, not reimplement it',
  );
});
