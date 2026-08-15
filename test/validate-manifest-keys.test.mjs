// Unknown manifest keys, against the canonical schema (module-toolkit#30). `node --test`.
//
// The case behind it: `whatsapp_inbox` declared `events.emit` (SINGULAR) for months where the
// contract says `events.emits`. The runtime saw no declared event and left the module in compatible
// mode instead of strict — and NO door caught it: `validate.mjs` did not mention `events` on a
// single line, and the SaaS publish validator only looks at id/name/version. The author of a module
// had no way of finding out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifestKeys, REFUSED_PATHS, RETIRED_FIELDS } from '../src/validate-manifest-keys.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

const base = () => ({ id: 'demo', name: 'Demo', version: '1.0.0' });

test('a correct manifest says nothing', () => {
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    events: { emits: ['demo.thing.created'], listen: { 'other.x.y': { command: 'demo.do' } } },
    commands: { 'demo.do': { sql: 'x.sql', permission: 'demo.write' } },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('`events.emit` (singular) is an ERROR that names the key and the place (#30)', () => {
  const { errors } = checkManifestKeys({ ...base(), events: { emit: ['demo.thing.created'] } });
  assert.equal(errors.length, 1, 'the whatsapp_inbox bug, caught by the door the author runs');
  assert.match(errors[0], /events\.emit\b/);
  assert.match(errors[0], /emits/, 'and it says which key was the right one');
});

test('an unknown key inside a command is an ERROR: it changes what RUNS', () => {
  const { errors } = checkManifestKeys({
    ...base(),
    commands: { 'demo.do': { sql: 'x.sql', gaurd: 'demo.check' } },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /commands\.demo\.do.*gaurd/s);
});

test('an unknown key in a PRESENTATION block only warns', () => {
  // Same line the runtime draws (hub#521): ignoring a field inside an operation or a guard leaves
  // the module WRONG; outside, it costs a screen or a button, and bricking a till over a tab that
  // does not render is the wrong trade.
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    navigation: [{ id: 'main', label: 'Demo', component: 'demo-view', colour: 'red' }],
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /navigation\[0\].*colour/s);
});

test('an open map (`commands`, `queries`, `widgets`) admits ANY operation name', () => {
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    queries: { 'demo.whatever.at.all': { sql: 'q.sql' } },
    widgets: { 'demo.widget': { title: 'X', kind: 'metric', query: 'demo.whatever.at.all' } },
  });
  assert.deepEqual([...errors, ...warnings], [], 'the map key is the name, not a field');
});

test('a RETIRED field is reported by name and issue, not refused', () => {
  // `validates` is declared by 7 commands of inventory/services and the runtime NEVER implemented
  // it (hub#610). Refusing it would be the consistent reading… and would leave those two modules
  // unable to pass their own gate. They install, reported by name — the list is a debt with a
  // number, not a place to park a field so the warning goes away.
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    commands: { 'demo.do': { sql: 'x.sql', validates: 'demo.check' } },
  });
  assert.deepEqual(errors, [], 'not refused');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /validates/);
  assert.match(warnings[0], /hub#610/, 'with the number that decides its fate');
});

test('a retired field is NEVER also a known one (the list is not a junk drawer)', () => {
  for (const [path, field] of RETIRED_FIELDS) {
    assert.ok(!REFUSED_PATHS.includes(`${path}.${field}`), `${path}.${field} cannot be in both`);
  }
});

// ── through the REAL door ────────────────────────────────────────────────────────────────────
// The check on its own proves nothing if `erplora validate` does not run it: the door the bug
// walked through is the command, not the function.
function moduleDir(manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-keys-'));
  mkdirSync(join(dir, 'ui'), { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  writeContractsFile(dir, manifest); // ADR-0127: validate requires .erplora/contracts.json
  return dir;
}

test('`erplora validate` REJECTS the manifest carrying `events.emit`', async () => {
  const dir = moduleDir({ ...base(), events: { emit: ['demo.thing.created'] } });
  try {
    await assert.rejects(() => validate(dir), /manifest inválido[\s\S]*events\.emit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`erplora validate` lets the same manifest through once spelled right', async () => {
  const dir = moduleDir({ ...base(), events: { emits: ['demo.thing.created'] } });
  try {
    await validate(dir); // does not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('where the schema says nothing, the validator does not invent either', () => {
  // A scheduled task's `payload` is free JSON: there is no contract to judge in there, and a
  // validator with opinions would turn every business field into a warning.
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    scheduled_tasks: [
      { name: 'nightly', command: 'demo.do', cron: '0 3 * * *', payload: { whatever: 1 } },
    ],
  });
  assert.deepEqual([...errors, ...warnings], []);
});
