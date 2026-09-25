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

// ── Every public package the validator imports is installed by BOTH YAMLs (#247) ─────────────
//
// The same failure as the SDK chain above, one layer down and far easier to introduce: the two
// files that install the validator's dependencies (`validate-module/action.yml` for the 27 module
// gates, `ci.yml` for this repository's own suite) list their packages BY HAND. Adding an import
// to `src/` and forgetting either list does not go red here — it goes red on 27 repos with
// `ERR_MODULE_NOT_FOUND`, blaming the modules. #247 added `ajv` and is that pull request.
//
// The list is not asserted against a hard-coded copy of itself, which would have to be edited by
// the very change it is meant to catch: it is DERIVED from the validator's own static import
// graph.

/** The package a bare specifier resolves to: `ajv/dist/2020.js` → `ajv`, `@a/b/c.js` → `@a/b`. */
function packageOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The public packages reachable from `src/validate.mjs` through static imports. Relative
 * specifiers are followed; `node:` builtins need no installing.
 */
function publicDependenciesOfTheValidator() {
  const seen = new Set();
  const packages = new Set();
  const walk = (abs) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      return; // A specifier that does not resolve to a file is not a package to install.
    }
    const specifiers = /(?:^|[\s;])(?:import|export)[\s\S]{0,400}?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
    let hit;
    while ((hit = specifiers.exec(source))) {
      const specifier = hit[1] || hit[2] || hit[3];
      if (!specifier || specifier.startsWith('node:')) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        walk(join(dirname(abs), specifier));
        continue;
      }
      packages.add(packageOf(specifier));
    }
  };
  walk(join(REPO, 'src/validate.mjs'));
  return { packages, files: seen.size };
}

test('the import graph this guard reads is really the validator’s, not an empty set', () => {
  // Without this, a regex that stops matching turns the two tests below into green prose: an empty
  // set satisfies «every package is installed». `typescript` has been in the graph since #61.
  const { packages, files } = publicDependenciesOfTheValidator();
  assert.ok(files > 20, `the walk reached only ${files} files — the graph is not being followed`);
  assert.ok(
    packages.has('typescript'),
    `contracts.mjs imports typescript; the walk found ${[...packages].join(', ') || 'nothing'}`,
  );
});

for (const [name, file] of [
  ['the module gate', '.github/actions/validate-module/action.yml'],
  ['this repository’s CI', '.github/workflows/ci.yml'],
]) {
  test(`${name} installs every public package the validator imports`, () => {
    const yaml = readFileSync(join(REPO, file), 'utf8');
    const installed = /for pkg in ([^;\n]+); do/.exec(yaml);
    assert.ok(installed, `${file} must install its packages through the \`for pkg in …\` loop`);
    const list = installed[1].trim().split(/\s+/);
    for (const pkg of publicDependenciesOfTheValidator().packages) {
      assert.ok(
        list.includes(pkg),
        `${file} does not install \`${pkg}\`, which src/validate.mjs imports — the gate would die `
          + `with ERR_MODULE_NOT_FOUND. Installed: ${list.join(', ')}`,
      );
      // Installing into the scratch prefix is half of it: ESM ignores NODE_PATH, so the package
      // also has to be resolvable from the toolkit's own node_modules.
      assert.match(
        yaml,
        new RegExp(`ln -sfn "\\$deps/node_modules/(${pkg.replace('/', '\\/')}|\\$pkg)"`),
        `${file} installs \`${pkg}\` but never links it into node_modules`,
      );
    }
  });
}

// ── The neighbours a module's recipes put a floor on are ON the runner (#343) ────────────────
// The module's battery checks every `flows/*.requires.json` floor by reading the neighbour's
// history next to the module. Without this step it printed «skipped» on CI and went green over a
// floor too low (whatsapp_inbox#213). Four links, all in YAML nobody runs locally: the secret the
// stub passes in, the step that clones, its place BEFORE the batteries run, and the cleanup that
// keeps a self-hosted runner from serving one job's neighbours to the next.
const NEIGHBOURS_ACTION = 'ERPlora/module-toolkit/.github/actions/module-neighbours@main';
const NEIGHBOURS = readFileSync(join(REPO, '.github/actions/module-neighbours/action.yml'), 'utf8');

test('the gate accepts the deploy-key bundle as an OPTIONAL secret', () => {
  assert.match(
    GATE,
    /workflow_call:[\s\S]*?\n\s{4}secrets:\s*\n\s{6}MODULES_DEPLOY_KEYS:\s*\n[\s\S]*?required:\s*false/,
    'optional: the 26 modules without floors must keep calling the gate without a secret',
  );
});

test('the gate brings the neighbours with that secret, BEFORE the batteries run', () => {
  const step = stepUsing(GATE, NEIGHBOURS_ACTION);
  assert.match(step, /keys:\s*\$\{\{\s*secrets\.MODULES_DEPLOY_KEYS\s*\}\}/);
  assert.match(step, /path:\s*\$\{\{\s*inputs\.path\s*\}\}/);
  assert.ok(
    GATE.indexOf(NEIGHBOURS_ACTION) < GATE.indexOf('ERPlora/module-toolkit/.github/actions/validate-module@main'),
    'validate-module runs `erplora test`: the neighbours have to be there before it',
  );
});

test('the neighbours are removed even when the gate fails', () => {
  const at = GATE.lastIndexOf(`uses: ${NEIGHBOURS_ACTION}`);
  assert.ok(at > GATE.indexOf('ERPlora/module-toolkit/.github/actions/validate-module@main'));
  const step = stepUsing(GATE.slice(GATE.lastIndexOf('\n      - ', at)), NEIGHBOURS_ACTION);
  assert.match(step, /if:\s*always\(\)/);
  assert.match(step, /cleanup:\s*'?true'?/);
});

test('the action unpacks the keys into RUNNER_TEMP, drops them on exit, and runs the toolkit script', () => {
  assert.match(NEIGHBOURS, /RUNNER_TEMP/);
  assert.match(NEIGHBOURS, /trap 'rm -rf "\$keys"' EXIT/);
  assert.match(NEIGHBOURS, /base64 -d \| tar xz -C "\$keys"/);
  assert.match(NEIGHBOURS, /src\/module-neighbours\.mjs/);
});
