// A module that adds a hub battery must declare it in the hub, IN THE SAME PR — ERPlora/hub#1439
// (transferred here as module-toolkit#163).
//
// WHY THIS EXISTS. `scripts/ci/module-hub-batteries.txt` (ERPlora/hub) and the module's
// `*.hub.test.py|sh` are a PAIR, and the hub checks it in both directions against the PUBLISHED
// catalogue. Only the hub half had a guard, so the halves broke on different machines: the module
// author merges green, publishes green, and the red lands in ANOTHER repo, hours later, in
// somebody else's push.
//
// It happened: inventory#77 added `tests/combo_stock.hub.test.py`, shipped as v1.2.44 on
// 2026-09-02 05:06, and the hub went red for 14 runs — develop, main and the cron. The damage is
// not the red. That guard runs BEFORE `cargo test`, so while it lasts the crater (the 27 published
// modules against the runtime) DOES NOT RUN AT ALL: a real kernel regression sits hidden behind a
// bookkeeping failure. A whole day, that time.
//
// The fix belongs on the side that CAUSES the break, at the moment it causes it — the module's own
// pull request, before the merge. `release.yml` would be too late: the pair breaks when the battery
// reaches the module's `main`, which is what the hub reads as "published", not when a version is
// cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseDeclarations,
  addedBatteries,
  missingDeclarations,
  formatFailure,
  hubRootFromSdkPath,
  main,
} from '../src/check-hub-battery-pairing.mjs';

const LIST = `# Las baterías de los módulos PUBLICADOS.
#
# Una línea de aquí sin fichero en el módulo falla, y al revés.

inventory/tests/stock.hub.test.py
sales/tests/checkout.hub.test.py
`;

test('the declaration list ignores comments and blank lines', () => {
  assert.deepEqual(parseDeclarations(LIST), [
    'inventory/tests/stock.hub.test.py',
    'sales/tests/checkout.hub.test.py',
  ]);
});

test('a battery already declared in the hub passes', () => {
  const missing = missingDeclarations({
    moduleId: 'inventory',
    batteries: ['tests/stock.hub.test.py'],
    declared: parseDeclarations(LIST),
  });
  assert.deepEqual(missing, []);
});

test('a battery the hub does not declare is reported, with the exact line it needs', () => {
  const missing = missingDeclarations({
    moduleId: 'inventory',
    batteries: ['tests/combo_stock.hub.test.py'],
    declared: parseDeclarations(LIST),
  });
  assert.deepEqual(missing, [
    { battery: 'tests/combo_stock.hub.test.py', line: 'inventory/tests/combo_stock.hub.test.py' },
  ]);
});

// module-toolkit#55: recognising a battery by ONE exact suffix left 20 files in 7 modules
// invisible. The hub classifies by name OR by content (`_HUB_BASE_URL`), so this side has to use
// the same rule or the two halves stop meaning the same thing — a new asymmetry replacing the old.
test('a battery detected by CONTENT counts too, even without `.hub.test.` in its name', () => {
  const added = addedBatteries([
    { path: 'tests/totals.test.py', content: 'BASE = os.environ["ERPLORA_HUB_BASE_URL"]\n' },
    { path: 'tests/pure_unit.test.py', content: 'assert 1 + 1 == 2\n' },
  ]);
  assert.deepEqual(added, ['tests/totals.test.py']);
});

test('a battery detected by NAME counts even when its content mentions no hub URL', () => {
  const added = addedBatteries([
    { path: 'tests/combo_stock.hub.test.py', content: 'print("hi")\n' },
  ]);
  assert.deepEqual(added, ['tests/combo_stock.hub.test.py']);
});

test('files outside `tests/` and non-batteries are ignored', () => {
  const added = addedBatteries([
    { path: 'ui/widget.test.ts', content: 'ERPLORA_HUB_BASE_URL\n' },
    { path: 'queries/list.sql', content: 'select 1' },
    { path: 'tests/__init__.py', content: '' },
    { path: 'tests/conftest.py', content: 'ERPLORA_HUB_BASE_URL' },
  ]);
  assert.deepEqual(added, []);
});

// module-toolkit#411: a hub battery's HARNESS (`tests/hub_harness.py`) reads the runtime url
// too, so the content rule alone called it a battery and the gate demanded a hub line for it. But
// the hub only discovers `*.test.py|sh` (`module-hub-batteries.sh`, `find -name '*.test.py'`):
// that line would read «declared but not published» and turn the HUB red. The author of
// payment_gateways#54 had no way out but to drop the battery. A battery is a battery by NAME first,
// exactly as `run-batteries.mjs` (`BATTERY_RE`) and the hub see it; the content only picks its family.
test('a harness that reads the hub url is NOT a battery: the hub would reject its line', () => {
  const added = addedBatteries([
    { path: 'tests/hub_harness.py', content: 'os.environ.get("ERPLORA_HUB_BASE_URL")\n' },
    { path: 'tests/lib/hub_client.sh', content: 'curl "$ERPLORA_HUB_BASE_URL/api"\n' },
    { path: 'tests/hub_harness.pyc', content: 'PAYMENT_GATEWAYS_HUB_BASE_URL' },
    // A merge leftover: `.test.py` in the middle of the name, not at the end. The hub's `find`
    // (`-name '*.test.py'`) never sees it, so the rule must be anchored like `BATTERY_RE`.
    { path: 'tests/totals.hub.test.py.orig', content: 'os.environ["ERPLORA_HUB_BASE_URL"]\n' },
  ]);
  assert.deepEqual(added, []);
});

test('a `.test.sh` without `.hub.` in its name that reads the hub url still counts', () => {
  const added = addedBatteries([
    { path: 'tests/smoke.test.sh', content: 'curl "$PAYMENT_GATEWAYS_HUB_BASE_URL/health"\n' },
  ]);
  assert.deepEqual(added, ['tests/smoke.test.sh']);
});

// The whole point of the issue: «el mensaje de error tiene que nombrar LAS DOS ediciones — qué
// línea falta y en qué fichero de qué repo—, nunca "no cuadra"». A message that only says the
// pair is broken sends the author to read someone else's CI.
test('the failure names BOTH edits: the exact line, the file, and the repo', () => {
  const message = formatFailure({
    moduleId: 'inventory',
    missing: missingDeclarations({
      moduleId: 'inventory',
      batteries: ['tests/combo_stock.hub.test.py'],
      declared: parseDeclarations(LIST),
    }),
  });
  assert.match(message, /inventory\/tests\/combo_stock\.hub\.test\.py/);
  assert.match(message, /scripts\/ci\/module-hub-batteries\.txt/);
  assert.match(message, /ERPlora\/hub/);
  // It must say what to DO, not merely that something is off.
  assert.doesNotMatch(message, /no cuadra/i);
});

test('several missing batteries are all named, not just the first', () => {
  const missing = missingDeclarations({
    moduleId: 'kitchen',
    batteries: ['tests/a.hub.test.py', 'tests/b.hub.test.sh'],
    declared: parseDeclarations(LIST),
  });
  assert.equal(missing.length, 2);
  const message = formatFailure({ moduleId: 'kitchen', missing });
  assert.match(message, /kitchen\/tests\/a\.hub\.test\.py/);
  assert.match(message, /kitchen\/tests\/b\.hub\.test\.sh/);
});

// A battery that was already there is somebody else's debt: failing on it would make an unrelated
// PR the place where an old omission surfaces, and the fleet would learn to bypass the gate.
test('only batteries ADDED by this pull request are demanded', () => {
  const missing = missingDeclarations({
    moduleId: 'inventory',
    batteries: [],
    declared: parseDeclarations(LIST),
  });
  assert.deepEqual(missing, []);
});

// ── The CLI the gate actually runs ──────────────────────────────────────────────────────────
// The step is a shell one-liner that hands over the diff; everything else has to be exercised
// here, or the guard is a thing nobody ever ran end to end.

/** A module dir with a manifest, a hub checkout with a list, and whatever battery files. */
function bench({ moduleId = 'inventory', declared = [], batteries = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pairing-'));
  const moduleDir = join(root, 'module');
  const hubRoot = join(root, 'hub');
  mkdirSync(join(moduleDir, 'tests'), { recursive: true });
  mkdirSync(join(hubRoot, 'scripts/ci'), { recursive: true });
  mkdirSync(join(hubRoot, 'packages/module-sdk'), { recursive: true });
  writeFileSync(join(moduleDir, 'module.json'), JSON.stringify({ id: moduleId }));
  writeFileSync(
    join(hubRoot, 'scripts/ci/module-hub-batteries.txt'),
    `# reviewed list\n\n${declared.join('\n')}\n`,
  );
  for (const [name, content] of Object.entries(batteries)) {
    writeFileSync(join(moduleDir, 'tests', name), content);
  }
  return { root, moduleDir, hubRoot, sdkPath: join(hubRoot, 'packages/module-sdk') };
}

function run(argv) {
  const out = [];
  const code = main(argv, { log: (m) => out.push(String(m)), error: (m) => out.push(String(m)) });
  return { code, output: out.join('\n') };
}

test('CLI: a declared battery exits 0', () => {
  const b = bench({
    declared: ['inventory/tests/combo_stock.hub.test.py'],
    batteries: { 'combo_stock.hub.test.py': 'print(1)' },
  });
  const { code } = run([
    '--module-dir', b.moduleDir, '--sdk-path', b.sdkPath,
    '--added', join(b.moduleDir, 'tests/combo_stock.hub.test.py'),
  ]);
  assert.equal(code, 0);
});

test('CLI: an undeclared battery exits 1 and names both edits', () => {
  const b = bench({ batteries: { 'combo_stock.hub.test.py': 'print(1)' } });
  const { code, output } = run([
    '--module-dir', b.moduleDir, '--sdk-path', b.sdkPath,
    '--added', join(b.moduleDir, 'tests/combo_stock.hub.test.py'),
  ]);
  assert.equal(code, 1);
  assert.match(output, /inventory\/tests\/combo_stock\.hub\.test\.py/);
  assert.match(output, /ERPlora\/hub/);
});

// The payment_gateways#54 shape, end to end: the new battery is declared, its new harness is not
// (and must not be — the hub would reject it). Before #411 this exited 1 demanding
// `payment_gateways/tests/hub_harness.py`.
test('CLI: a declared battery plus its new harness exits 0 and does not ask for the harness', () => {
  const b = bench({
    moduleId: 'payment_gateways',
    declared: ['payment_gateways/tests/deleted_gateway_frees_its_code.hub.test.py'],
    batteries: {
      'deleted_gateway_frees_its_code.hub.test.py': 'from hub_harness import Hub\n',
      'hub_harness.py': 'BASE = os.environ.get("ERPLORA_HUB_BASE_URL")\n',
    },
  });
  const { code, output } = run([
    '--module-dir', b.moduleDir, '--sdk-path', b.sdkPath,
    '--added', join(b.moduleDir, 'tests/deleted_gateway_frees_its_code.hub.test.py'),
    '--added', join(b.moduleDir, 'tests/hub_harness.py'),
  ]);
  assert.equal(code, 0, output);
  assert.doesNotMatch(output, /hub_harness\.py/);
});

test('CLI: a PR that adds no battery exits 0 and says nothing alarming', () => {
  const b = bench();
  writeFileSync(join(b.moduleDir, 'module.json'), JSON.stringify({ id: 'inventory' }));
  const { code } = run([
    '--module-dir', b.moduleDir, '--sdk-path', b.sdkPath,
    '--added', join(b.moduleDir, 'module.json'),
  ]);
  assert.equal(code, 0);
});

// The failure mode this guard must never have: unable to read the hub, and passing anyway.
test('a hub checkout without the list FAILS LOUDLY instead of finding nothing to declare', () => {
  const root = mkdtempSync(join(tmpdir(), 'pairing-nolist-'));
  mkdirSync(join(root, 'packages/module-sdk'), { recursive: true });
  assert.throws(
    () => hubRootFromSdkPath(join(root, 'packages/module-sdk')),
    /module-hub-batteries\.txt/,
  );
});

test('CLI: an unreadable hub checkout exits NON-ZERO, never 0', () => {
  const b = bench({ batteries: { 'x.hub.test.py': 'print(1)' } });
  const { code, output } = run([
    '--module-dir', b.moduleDir, '--sdk-path', join(b.root, 'nowhere/packages/module-sdk'),
    '--added', join(b.moduleDir, 'tests/x.hub.test.py'),
  ]);
  assert.notEqual(code, 0);
  assert.match(output, /module-hub-batteries\.txt/);
});
