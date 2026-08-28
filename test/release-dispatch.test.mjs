// The module's release TELLS the hub it published — module-toolkit#111 (origin: ERPlora/hub#1239).
//
// WHY THIS FILE EXISTS. `ERPlora/hub`'s `test-hub-modules.yml` clones the ~27 PUBLISHED modules and
// runs them against the runtime; since hub#1239 it also accepts a `repository_dispatch` of type
// `module-published`, so the red appears AT PUBLISH TIME and with the culprit's name in the run
// title. That receiver was merged with no emitter: hub#1215 was caused by a MODULE release
// (`invoice` v1.2.27, ADR-0405), no push to the hub could have caught it, and the nightly `schedule`
// only uncovered it hours later, inside somebody else's push.
//
// The emitter is `module-release.yml`, the reusable release workflow the 27 module repos call — one
// file instead of 27 copies, the same shape as `module-gate.yml`.
//
// WHAT IS ASSERTED IS THE WIRING, NEVER THE WORDING: the event name, the target repository, the
// payload keys the receiver reads, the guard that stops a silent skip when the cross-repo token is
// missing, and the three anti-loop layers the bump cannot lose on its way into a reusable workflow.
// Every one of those is a link that fails SILENTLY — a dispatch with no `module` runs as an
// anonymous nightly pass, and an absent secret arrives as an EMPTY STRING, never as an error.
//
// And when a hub checkout is at hand, the event name and the payload keys are checked against the
// receiver itself, so the two halves of the contract cannot drift apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubPath } from './hub-mirror.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_PATH = '.github/workflows/module-release.yml';
const RELEASE = readFileSync(join(REPO, RELEASE_PATH), 'utf8');

/** The payload contract of the receiver (`ERPlora/hub`, `test-hub-modules.yml`). */
const EVENT_TYPE = 'module-published';
const PAYLOAD_KEYS = ['module', 'version'];
/** The cross-repo credential: the caller's `GITHUB_TOKEN` cannot dispatch on another repository. */
const SECRET = 'HUB_DISPATCH_TOKEN';

/** The workflow with every comment line removed — what is asserted are KEYS, not the prose. */
function keysOnly(yaml) {
  return yaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
}

/**
 * The single step of the job that mentions `needle`, comments stripped. A step is read AS A WHOLE
 * because what matters is which keys travel TOGETHER — an `if:` sitting on the wrong step is
 * exactly the kind of hole that reads fine line by line.
 *
 * Only the `steps:` block is searched: an earlier version keyed on any `name:` and matched the JOB
 * name (`bump + aviso al hub`), which then made every assertion read the workflow header instead.
 */
function steps(yaml) {
  const lines = keysOnly(yaml).split('\n');
  const at = lines.findIndex((l) => /^\s+steps:\s*$/.test(l));
  assert.notEqual(at, -1, 'the workflow has no `steps:` block');
  const chunks = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('- ')) chunks.push([line]);
    else if (chunks.length) chunks[chunks.length - 1].push(line);
  }
  return chunks.map((c) => c.join('\n'));
}

function step(yaml, needle) {
  const found = steps(yaml).filter((s) => s.includes(needle));
  assert.equal(found.length, 1, `expected exactly one step mentioning \`${needle}\`, got ${found.length}`);
  return found[0];
}

test('the release workflow is REUSABLE and answers to nothing else (module-toolkit#111)', () => {
  const keys = keysOnly(RELEASE);
  assert.match(keys, /^on:\n(?:\s+\S.*\n)*?\s+workflow_call:/m, `${RELEASE_PATH} must be a \`workflow_call\``);
  assert.doesNotMatch(
    keys,
    /^\s{2}(push|pull_request|schedule):/m,
    'a reusable workflow that also triggers on its own would bump THIS repository, which has no module',
  );
});

test('it declares the cross-repo secret, so a caller can pass or inherit it', () => {
  assert.match(
    keysOnly(RELEASE),
    new RegExp(`workflow_call:[\\s\\S]*?secrets:[\\s\\S]*?^\\s+${SECRET}:`, 'm'),
    `the caller has to be able to hand over \`${SECRET}\`; an undeclared secret never arrives`,
  );
});

test('the bump publishes and SAYS whether it published', () => {
  const bump = step(RELEASE, 'id: bump');
  assert.match(bump, /id:\s*bump\b/, 'the bump step needs an `id:` — the dispatch reads its outputs');
  assert.match(bump, /published=true/, 'it must report that this run is the one that pushed the bump');
  assert.match(bump, /published=false/, 'and that it is NOT, when another run already bumped main');
  for (const key of PAYLOAD_KEYS) {
    assert.match(
      bump,
      new RegExp(`${key}=`),
      `the bump is where \`${key}\` is known; the dispatch must not re-derive it`,
    );
  }
});

test('the dispatch targets ERPlora/hub with the event the receiver accepts', () => {
  const dispatch = step(RELEASE, 'Avisar al hub');
  assert.match(
    dispatch,
    /repos\/ERPlora\/hub\/dispatches/,
    'the receiver is `ERPlora/hub`; a dispatch to the module itself would go nowhere',
  );
  assert.match(
    dispatch,
    new RegExp(`event_type[^\\n]*${EVENT_TYPE}`),
    `the receiver filters on \`types: [${EVENT_TYPE}]\``,
  );
  for (const key of PAYLOAD_KEYS) {
    assert.match(
      dispatch,
      new RegExp(`client_payload[\\s\\S]{0,200}?["']${key}["']`),
      `the receiver reads \`client_payload.${key}\` for the run title and the job summary`,
    );
  }
});

test('the dispatch only fires when the bump actually published', () => {
  const dispatch = step(RELEASE, 'Avisar al hub');
  assert.match(
    dispatch,
    /if:\s*steps\.bump\.outputs\.published\s*==\s*'true'/,
    'two runs race on the same merge; the one that found main already bumped must not cry wolf',
  );
});

test('a missing token fails LOUDLY — an absent secret arrives as an empty string', () => {
  const dispatch = step(RELEASE, 'Avisar al hub');
  assert.match(
    dispatch,
    new RegExp(`\\[\\s*-z\\s*"\\$\\{${SECRET}[^"]*"\\s*\\]`),
    `${SECRET} has to be checked explicitly: organization secrets do not reach private repos on the free plan`,
  );
  assert.match(dispatch, /::error::/, 'and it has to say so as an annotation, not in a log line');
  assert.match(dispatch, /exit 1/, 'never a silent skip: the publish would go unverified for a day');
});

test('the HTTP answer is checked — a 401 must not read as a delivered notice', () => {
  const dispatch = step(RELEASE, 'Avisar al hub');
  assert.match(
    dispatch,
    /204/,
    '`POST /dispatches` answers 204; curl exits 0 on a 401 body, so the status is the only proof',
  );
});

test('the three anti-loop layers survive the move into the reusable workflow', () => {
  const keys = keysOnly(RELEASE);
  assert.match(
    keys,
    /if:\s*\$\{\{\s*!startsWith\(github\.event\.head_commit\.message,\s*'chore\(release\)'\)/,
    'layer 2: a run created for the bot commit must not execute the job',
  );
  assert.ok(
    keys.includes("grep -q '^chore(release)"),
    'layer 3: the step re-reads the tip of origin/main so a bump cannot stack on a bump',
  );
  assert.match(keys, /GITHUB_TOKEN|actions\/checkout/, 'layer 1: the push uses the caller GITHUB_TOKEN');
});

test('the job keeps the runner switch and the write permission it needs', () => {
  const keys = keysOnly(RELEASE);
  assert.match(
    keys,
    /runs-on:\s*\$\{\{\s*vars\.CI_RUNNER_LABEL\s*\|\|\s*'ubuntu-latest'\s*\}\}/,
    'removing the fallback queues 27 releases forever against a label nobody answers to',
  );
  assert.match(keys, /permissions:[\s\S]{0,80}contents:\s*write/, 'the bump pushes to main');
});

test('the emitter and the hub receiver name the SAME event and the SAME payload keys', (t) => {
  const receiver = hubPath(t, '.github/workflows/test-hub-modules.yml');
  if (!receiver) return;
  const yaml = readFileSync(receiver, 'utf8');
  assert.match(
    yaml,
    new RegExp(`repository_dispatch:\\s*\\n\\s*types:\\s*\\[\\s*${EVENT_TYPE}\\s*\\]`),
    `the hub must still accept \`${EVENT_TYPE}\`; if it was renamed, this emitter shouts into the void`,
  );
  for (const key of PAYLOAD_KEYS) {
    assert.match(
      yaml,
      new RegExp(`client_payload\\.${key}`),
      `the hub stopped reading \`client_payload.${key}\` — the contract moved and this emitter did not`,
    );
  }
});

test('a run that finds main already bumped SAYS the hub may not have been told — a re-run is not a delivery (review of module-toolkit#118)', () => {
  // The branch that exits with `published=false` is exactly where a RE-RUN lands after a failed
  // notice (empty secret, 401): the bump is already on main, nothing publishes, the dispatch step is
  // skipped — and the run goes GREEN without the hub ever hearing about the version. The branch has
  // to annotate it and name the manual route, so green never reads as delivered.
  const bump = step(RELEASE, 'id: bump');
  assert.match(
    bump,
    /grep -q '\^chore\(release\)'[\s\S]*?::warning::[\s\S]*?repos\/ERPlora\/hub\/dispatches[\s\S]*?published=false/,
    'the `published=false` branch must carry a `::warning::` annotation and the manual `POST repos/ERPlora/hub/dispatches` route',
  );
});
