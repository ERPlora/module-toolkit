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
    widgets: { 'demo.widget': { title: 'X', kind: 'kpi', query: 'demo.whatever.at.all' } },
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

test('`navigation[].actions` is RETIRED, not an unknown key (mirror of hub#1237)', () => {
  // Mirror of ERPlora/hub#1237. The runtime parsed the field (`manifest::NavAction`) and the schema
  // declared it, but the shell never painted those buttons and `/api/navigation` never served them,
  // so no `module-action` event ever reached a Web Component. Declared surface that does not exist
  // is RETIRED, not frozen — and retired is not the same as unknown: the manifests already
  // published carrying it must keep installing, and the author has to be told WHY it went, by name.
  const { errors, warnings } = checkManifestKeys({
    ...base(),
    navigation: [
      { id: 'main', label: 'Demo', component: 'demo-view', actions: [{ id: 'x', label: 'X' }] },
    ],
  });
  assert.deepEqual(errors, [], 'not refused: a published manifest carrying it still installs');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /navigation\[0\]\.actions/);
  assert.match(warnings[0], /campo RETIRADO/, 'through the retired path, not the unknown-key one');
  assert.match(warnings[0], /hub#1237/, 'with the number that retires it');
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

// ── ERPlora/hub#1076 / module-toolkit#133: `commands.*.emit[]` gana la forma objeto ──────────
test('`erplora validate` ACCEPTS `emit: [{event, dedup_key}]` (hub#1076 / module-toolkit#133)', async () => {
  const manifest = {
    ...base(),
    commands: {
      'demo.do': { permission: 'demo.write', emit: [{ event: 'demo.thing.done', dedup_key: 'external_id' }] },
    },
  };
  const dir = moduleDir(manifest);
  try {
    await validate(dir); // does not throw
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`erplora validate` REJECTS an empty `dedup_key` (hub#1076 / module-toolkit#133)', async () => {
  const manifest = {
    ...base(),
    commands: { 'demo.do': { permission: 'demo.write', emit: [{ event: 'demo.thing.done', dedup_key: '' }] } },
  };
  const dir = moduleDir(manifest);
  try {
    await assert.rejects(() => validate(dir), /manifest inválido[\s\S]*dedup_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a `dedup_key` typo (e.g. `dedupKey`) is reported by name, not swallowed as free-form (hub#1076 / module-toolkit#133)', () => {
  // Before the schema sync `commands.*.emit[]` was `{ type: 'string' }` with no `properties`, so
  // the walker treated ANY shape there as free-form JSON and reported nothing — an object with a
  // typo'd key would have passed silently. The object branch the hub added has closed properties
  // (`additionalProperties: false`), so the walker can — and now does — name the typo.
  const { warnings, errors } = checkManifestKeys({
    ...base(),
    commands: { 'demo.do': { permission: 'demo.write', emit: [{ event: 'demo.thing.done', dedupKey: 'x' }] } },
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify({ warnings, errors }));
  assert.match(warnings[0], /dedupKey/);
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

// ── Closed vocabularies: the VALUE, not just the key (module-toolkit#62) ──────────────────────
//
// «La clave existe» y «el valor es uno de los que el core sabe atender» son preguntas distintas, y
// hasta aquí solo se hacía la primera. Un manifest con `ai.risk: "catastrophic"` pasaba el gate en
// verde y el fallo aparecía en la INSTALACIÓN, con el módulo ya publicado (ERPlora/hub#1066).
//
// Es el mismo argumento que ya justifica `pattern`/`maxLength` unas líneas más arriba: estas
// formas las aplica el RUNTIME, así que un manifest que pase aquí y falle allí no falla en la
// máquina del autor — falla en el hub de un cliente.
//
// 🔴 EL RIESGO DE ESTA COMPROBACIÓN ES EL FALSO POSITIVO, no el falso negativo: esta puerta bloquea
// 25 repos a la vez, y un enum leído de más deja fuera manifests correctos. Por eso se unen los
// vocabularios de TODAS las ramas que aplican al mismo nodo (`anyOf`/`oneOf`/`allOf`), y una rama
// que admita una cadena SIN enum desactiva la comprobación entera para ese nodo: si el contrato
// deja una alternativa libre, el valor no es inválido.
test('un valor fuera del vocabulario CERRADO es un error (#62, hub#1066)', () => {
  const { errors } = checkManifestKeys({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    records: { invoice: { mutable: false, reason: 'apocalyptic' } },
  });
  assert.equal(errors.length, 1, 'el gate tiene que verlo');
  assert.match(errors[0], /records\.invoice\.reason/);
  assert.match(errors[0], /apocalyptic/);
  assert.match(errors[0], /fiscal/, 'y decir cuáles SÍ admite el contrato');
});

test('el vocabulario cerrado se aplica también dentro de una operación (#62)', () => {
  const { errors } = checkManifestKeys({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    commands: {
      wipe: { permission: 'x', sql: 'SELECT 1', ai: { description: 'd', risk: 'catastrophic' } },
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /risk/);
  assert.match(errors[0], /catastrophic/);
});

test('un valor que SÍ está en el vocabulario pasa (#62)', () => {
  for (const reason of ['fiscal', 'ledger', 'identity', 'audit']) {
    const { errors } = checkManifestKeys({
      id: 'demo',
      name: 'Demo',
      version: '1.0.0',
      records: { invoice: { mutable: false, reason } },
    });
    assert.deepEqual(errors, [], `\`${reason}\` es del contrato y no puede dar error`);
  }
});

test('una rama del contrato SIN enum desactiva la comprobación: nunca un falso positivo (#62)', () => {
  // `depends_on[]` es `anyOf: [string, {id, min_version}]`. La rama string no lleva enum, así que
  // ningún valor de ahí puede declararse fuera de vocabulario.
  const { errors } = checkManifestKeys({
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    depends_on: ['taxes', { id: 'inventory', min_version: '1.2.20' }],
  });
  assert.deepEqual(errors, [], 'una alternativa libre en el contrato no puede volverse un error');
});
