// The `flows/` package contract: the automations a module ships with. `node --test`.
//
// WHAT WAS BROKEN (module-toolkit#209). A module can bring its own automations — it writes them in
// `flows/`, publishes, and they reach NO hub: `erplora pack` did not carry the folder into the zip
// (`pack-include.test.mjs` closes that half) and nothing anywhere judged what is inside it. So the
// only door left open was a hand-written COPY of the template in the gallery of the `flows` module,
// and a copy of a document nobody validates falls behind: it did three times in a single day, and
// one resync cost 23.2M tokens.
//
// WHAT THIS FILE JUDGES, and what it deliberately does not. This is the PACKAGE contract — the
// shape of `flows/`: how a template is named, that every family carries its source language and its
// grants, and that each document satisfies the FROZEN root of `flow.schema.json`. It is not the
// semantics of the automation (whether the prompt orders the right tool, whether the grants cover
// what the steps use): that lives in the module's own battery, where the domain is.
//
// Everything closed here is READ from the vendored schema (`schemas/flow.schema.json`, byte for
// byte from the hub, `canonical-mirrors.test.mjs`), never copied into this file: the frozen step
// vocabulary and the closed root are the hub's, and a list re-typed here is the divergence the
// mirrors exist to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFlows } from '../src/validate-flows.mjs';
import { validate } from '../src/validate.mjs';

/** The `paths:` filter of the release workflow, as the stub of the README writes it. */
function releaseWorkflow(paths) {
  return `name: Release\non:\n  push:\n    branches: [main]\n    paths:\n${paths
    .map((p) => `      - '${p}'\n`)
    .join('')}`;
}

/** A module directory whose `flows/` carries exactly `files` (objects are written as JSON). */
function moduleWithFlows(files) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-flows-'));
  mkdirSync(join(dir, 'flows'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(
      join(dir, 'flows', name),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    );
  }
  return dir;
}

/** A valid flow document, shaped like `whatsapp_inbox/flows/appointment-from-whatsapp.*`. */
function doc(overrides = {}) {
  return {
    schema_version: 1,
    name: 'Appointment from WhatsApp',
    triggers: [{ kind: 'event', event: 'hub.whatsapp.message_received' }],
    steps: [
      { id: 'acknowledge', kind: 'notify', channel: 'whatsapp', vars: { text: 'Thanks!' } },
      { id: 'propose_appointment', kind: 'ai', prompt: 'Offer a slot', tools: [] },
    ],
    ...overrides,
  };
}

const GRANTS = { grants: [{ kind: 'notify', value: 'whatsapp' }] };
const REQUIRES = { modules: { appointments: '1.1.69' } };

/** The whole family, well formed: the case every other test breaks exactly one thing of. */
function wellFormed(extra = {}) {
  return {
    'appointment-from-whatsapp.en.flow.json': doc(),
    'appointment-from-whatsapp.es.flow.json': doc({ name: 'Cita desde WhatsApp' }),
    'appointment-from-whatsapp.grants.json': GRANTS,
    'appointment-from-whatsapp.requires.json': REQUIRES,
    ...extra,
  };
}

/** Runs `checkFlows` over a throwaway module and cleans up after itself. */
function check(files) {
  const dir = files === null ? mkdtempSync(join(tmpdir(), 'erplora-flows-')) : moduleWithFlows(files);
  try {
    return checkFlows(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The one line every negative test needs: the finding names the file it is about. */
function assertNames(errors, needle) {
  assert.ok(
    errors.some((e) => e.includes(needle)),
    `no finding names \`${needle}\`:\n  - ${errors.join('\n  - ') || '(none)'}`,
  );
}

test('a module without flows/ has nothing to validate', () => {
  assert.deepEqual(check(null), { errors: [], warnings: [] });
});

test('a well-formed family passes clean — the positive control of every case below', () => {
  const { errors, warnings } = check(wellFormed());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test('the README of the folder is documentation, not a template', () => {
  assert.deepEqual(check(wellFormed({ 'README.md': '# The templates of this module\n' })).errors, []);
});

test('a document not named <family>.<lang>.flow.json is refused', () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.en.flow.json'];
  files['appointment_from_whatsapp.flow.json'] = doc();
  assertNames(check(files).errors, 'appointment_from_whatsapp.flow.json');
});

test('a family without its ENGLISH document is refused (English is the source, ADR-0055)', () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.en.flow.json'];
  assertNames(check(files).errors, 'appointment-from-whatsapp.en.flow.json');
});

// Found by a mutant on the real module (module-toolkit#209): deleting the Spanish document of
// `whatsapp_inbox` left the folder GREEN. A template is user-visible text — the card in the gallery
// and the words the customer reads on WhatsApp — and the standing rule of the house is the English
// string AND its Spanish (ADR-0055/0199). Without it a Spanish salon is offered, and sends, English.
test('a family without its SPANISH translation is refused (ADR-0055/0199)', () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.es.flow.json'];
  assertNames(check(files).errors, 'appointment-from-whatsapp.es.flow.json');
});

test('a family without its grants is refused: nobody can tell what it will ask for', () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.grants.json'];
  assertNames(check(files).errors, 'appointment-from-whatsapp.grants.json');
});

test('a family may ship without a version floor — requires.json is optional', () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.requires.json'];
  assert.deepEqual(check(files).errors, []);
});

test('a sidecar with no template of its own name is refused (orphan grants/requires)', () => {
  const errors = check(wellFormed({ 'reminder.grants.json': GRANTS })).errors;
  assertNames(errors, 'reminder.grants.json');
});

test('anything else in flows/ is refused: no reader would ever open it', () => {
  assertNames(check(wellFormed({ 'notes.json': { a: 1 } })).errors, 'notes.json');
});

test('a document that is not JSON is refused naming the file', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.es.flow.json'] = '{ "schema_version": 1, ';
  assertNames(check(files).errors, 'appointment-from-whatsapp.es.flow.json');
});

test('a schema_version the hub does not know is refused, never run half-way', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({ schema_version: 2 });
  assertNames(check(files).errors, 'schema_version');
});

test('a document without steps is refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({ steps: [] });
  assertNames(check(files).errors, 'steps');
});

test('an unknown root key is refused — the root of the document is closed', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({ description: 'books an appointment' });
  assertNames(check(files).errors, 'description');
});

test('a step outside the FROZEN vocabulary is refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({
    steps: [{ id: 'call', kind: 'webhook', url: 'https://example.com' }],
  });
  assertNames(check(files).errors, 'webhook');
});

test('a step without id or without kind is refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({ steps: [{ kind: 'notify' }] });
  assertNames(check(files).errors, 'id');
});

test('two steps with the same id are refused: later steps read them by id', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({
    steps: [
      { id: 'acknowledge', kind: 'notify' },
      { id: 'acknowledge', kind: 'notify' },
    ],
  });
  assertNames(check(files).errors, 'acknowledge');
});

// This is the one that pays for the file. A translation is PROSE: same steps, same order, other
// words. When the two halves drift, the Spanish hub runs a different automation from the English
// one and nothing says so — the same shape of bug as the gallery copy that fell behind three times
// in a day (ERPlora/flows#52).
test('the languages of a family must declare the SAME steps in the SAME order', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    steps: [
      { id: 'acknowledge', kind: 'notify' },
      { id: 'proponer_cita', kind: 'ai', prompt: 'Ofrece un hueco' },
    ],
  });
  assertNames(check(files).errors, 'propose_appointment');
});

test('the languages of a family must be triggered by the same thing', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    triggers: [{ kind: 'event', event: 'hub.whatsapp.other' }],
  });
  assertNames(check(files).errors, 'hub.whatsapp.other');
});

// A trigger carries NO prose: `kind`, `event`, `filter`, `input`, `cron`, `at` are all machinery
// (`flow.schema.json` `$defs/trigger`). So there is nothing in it a translation may legitimately
// change — and a `filter` that drifts is worse than a different event, because both halves still
// LOOK like the same automation: the Spanish hub simply answers messages the English one ignores.
test('the languages of a family must be filtered the same way', () => {
  const files = wellFormed();
  const triggers = [
    { kind: 'event', event: 'hub.whatsapp.message_received', filter: { 'event.text': { neq: '' } } },
  ];
  files['appointment-from-whatsapp.en.flow.json'] = doc({ triggers });
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    name: 'Cita desde WhatsApp',
    triggers: [{ kind: 'event', event: 'hub.whatsapp.message_received' }],
  });
  assertNames(check(files).errors, 'filter');
});

test('the languages of a family must map the event into the run the same way', () => {
  const files = wellFormed();
  const triggers = (input) => [{ kind: 'event', event: 'hub.whatsapp.message_received', input }];
  files['appointment-from-whatsapp.en.flow.json'] = doc({
    triggers: triggers({ from: 'event.from', text: 'event.text' }),
  });
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    name: 'Cita desde WhatsApp',
    triggers: triggers({ from: 'event.from' }),
  });
  assertNames(check(files).errors, 'input');
});

test('a version floor that is not a version is refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.requires.json'] = { modules: { appointments: 'latest' } };
  assertNames(check(files).errors, 'latest');
});

// The real `requires.json`/`grants.json` of `whatsapp_inbox` carry `_why` and `_appointments`:
// prose explaining why the floor is where it is. Refusing them would fail the only module that
// ships templates today.
test('underscore keys of the sidecars are documentation and are allowed', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.requires.json'] = { _why: 'measured on 2026-09-06', ...REQUIRES };
  files['appointment-from-whatsapp.grants.json'] = { _why: 'the channel it answers on', ...GRANTS };
  assert.deepEqual(check(files).errors, []);
});

test('grants that are not a list of {kind, value} are refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.grants.json'] = { grants: [{ kind: 'notify' }] };
  assertNames(check(files).errors, 'value');
});

test('a family that asks for nothing is refused: it could not do anything either', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.grants.json'] = { grants: [] };
  assertNames(check(files).errors, 'grants');
});

// ── the PIN of a grant (hub#1623) ─────────────────────────────────────────────────────────────
//
// A `command` grant may FIX part of the payload — «may cancel appointments AS THE CUSTOMER» rather
// than «may cancel appointments» — which is the whole contention of a template whose `params` a
// model writes from a stranger's message. The template that needs it is the unattended WhatsApp
// one, so this door has to let it through; and it has to refuse what the HUB refuses, or the
// module publishes green and `PUT …/grants` rejects it at the owner's screen with
// `flow.invalid_grant_payload` — a red nobody can act on, three steps away from here.

test('a command grant may FIX part of the payload: the pin publishes green', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.grants.json'] = {
    grants: [
      { kind: 'notify', value: 'whatsapp' },
      {
        kind: 'command',
        value: 'appointments.appointments.cancel',
        payload: { channel: 'customer' },
      },
    ],
  };
  assert.deepEqual(check(files).errors, []);
});

test('a pin that is not an object is refused, exactly as the hub refuses it', () => {
  for (const payload of ['channel=customer', ['channel'], 42, null]) {
    const files = wellFormed();
    files['appointment-from-whatsapp.grants.json'] = {
      grants: [{ kind: 'command', value: 'appointments.appointments.cancel', payload }],
    };
    assertNames(check(files).errors, 'payload');
  }
});

// The hub stores a pin ONLY for a `command`, because `check_command_grant` is the one gate that is
// handed a payload. A pin on any other kind would put a restriction on the owner's screen that
// nothing applies — which is the failure the whole default-deny design exists to prevent.
test('a pin on a kind that is not `command` is refused: nothing would enforce it', () => {
  for (const kind of ['query', 'notify', 'http', 'recipient_query']) {
    const files = wellFormed();
    files['appointment-from-whatsapp.grants.json'] = {
      grants: [{ kind, value: 'customers.list', payload: { channel: 'customer' } }],
    };
    assertNames(check(files).errors, 'payload');
  }
});

// An EMPTY pin is not a pin: it fixes nothing, so it is the same grant as the bare pair and the hub
// stores it as `'{}'` — the default of every row that existed before hub#1623. Refusing it here
// would be this door inventing a rule the hub does not have.
test('an empty pin is the bare grant, not an error', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.grants.json'] = {
    grants: [{ kind: 'command', value: 'appointments.appointments.cancel', payload: {} }],
  };
  assert.deepEqual(check(files).errors, []);
});

// The door is worth nothing unless `erplora validate` runs it — and `pack` (and therefore
// `publish`) calls `validate` first, which is what turns this file into a PUBLISH gate instead of a
// linter nobody invokes. Without this test, deleting the call in `validate.mjs` leaves every case
// above green while the whole guard goes dead: measured, it was the one mutation that survived.
test('WIRED: `erplora validate` rejects the module, so pack/publish cannot ship it', async () => {
  const files = wellFormed();
  delete files['appointment-from-whatsapp.es.flow.json'];
  const dir = moduleWithFlows(files);
  writeFileSync(
    join(dir, 'module.json'),
    JSON.stringify({ id: 'whatsapp_inbox', name: 'WhatsApp Inbox', version: '1.0.0' }),
  );
  try {
    await assert.rejects(() => validate(dir), /appointment-from-whatsapp\.es\.flow\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The other half of the SAME symptom the issue is about (module-toolkit#209). Carrying `flows/` in
// the zip is worth nothing if publishing never happens: `release.yml` only bumps and republishes on
// the `paths:` it lists, so a merge that touches ONLY a template leaves the published version where
// it was and the template reaches no hub — exactly the failure already documented for `locales/**`.
// It is a WARNING and not an error on purpose: turning it red would fail every open PR of the one
// module that ships templates today, which is how a guard gets switched off instead of obeyed.
test('WARNS when the module ships templates and its release does not publish them', () => {
  const dir = moduleWithFlows(wellFormed());
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'workflows', 'release.yml'),
    releaseWorkflow(['module.json', 'ui/**', 'locales/**', 'dist/**']),
  );
  try {
    const { errors, warnings } = checkFlows(dir);
    assert.deepEqual(errors, [], 'it is a warning, never a red gate');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /flows\/\*\*/);
    assert.match(warnings[0], /release\.yml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stays quiet when release.yml already publishes on flows/**', () => {
  const dir = moduleWithFlows(wellFormed());
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(dir, '.github', 'workflows', 'release.yml'),
    releaseWorkflow(['module.json', 'ui/**', 'locales/**', 'flows/**', 'dist/**']),
  );
  try {
    assert.deepEqual(checkFlows(dir), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A module built outside a repo of its own — the scaffold, a temporary directory, the module the
// gate unpacks — has no workflow to read. Warning there would be noise about something the author
// cannot act on, and noise is what teaches people to ignore the warning that does matter.
test('says nothing about a release workflow that is not there', () => {
  assert.deepEqual(check(wellFormed()), { errors: [], warnings: [] });
});

// Reviewer mutants on the real module (module-toolkit#214): six survived. A translation changes
// the WORDS of a step — `prompt`, `vars`, `params`, `title`, `summary`, `body`, `headers` — and
// nothing else. Changing its `kind`, the tools an `ai` step may call, the command it runs or the
// condition it branches on is another automation wearing the same step id, and the Spanish hub
// would run it while the English one runs something else. Measured on `whatsapp_inbox` before
// writing this: between `en` and `es` only `prompt` and `vars` differ, so the rule costs nothing.
test('the languages of a family must run the same KIND of step under the same id', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    steps: [
      { id: 'acknowledge', kind: 'command', command: 'whatsapp_inbox.messages.mark_read' },
      { id: 'propose_appointment', kind: 'ai', prompt: 'Ofrece un hueco', tools: [] },
    ],
  });
  const errors = check(files).errors;
  assertNames(errors, 'acknowledge');
  assertNames(errors, 'kind');
});

test('the languages of a family must hand an ai step the same tools', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    steps: [
      { id: 'acknowledge', kind: 'notify', channel: 'whatsapp', vars: { text: '¡Gracias!' } },
      { id: 'propose_appointment', kind: 'ai', prompt: 'Ofrece un hueco', tools: ['appointments.appointments.cancel'] },
    ],
  });
  assertNames(check(files).errors, 'tools');
});

test('a translation may change the PROSE of a step — prompt, vars, params, title — and passes clean', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({
    steps: [
      { id: 'acknowledge', kind: 'notify', channel: 'whatsapp', vars: { text: 'Thanks!' } },
      { id: 'propose_appointment', kind: 'ai', prompt: 'Offer a slot', tools: ['appointments.slots.list'] },
      { id: 'note', kind: 'command', command: 'customers.notes.add', params: { text: 'Came via WhatsApp' } },
      { id: 'sign_off', kind: 'approval', title: 'Confirm the booking?', summary: 'A new customer' },
    ],
  });
  files['appointment-from-whatsapp.es.flow.json'] = doc({
    name: 'Cita desde WhatsApp',
    steps: [
      { id: 'acknowledge', kind: 'notify', channel: 'whatsapp', vars: { text: '¡Gracias!' } },
      { id: 'propose_appointment', kind: 'ai', prompt: 'Ofrece un hueco', tools: ['appointments.slots.list'] },
      { id: 'note', kind: 'command', command: 'customers.notes.add', params: { text: 'Vino por WhatsApp' } },
      { id: 'sign_off', kind: 'approval', title: '¿Confirmar la cita?', summary: 'Cliente nuevo' },
    ],
  });
  assert.deepEqual(check(files).errors, []);
});

// The trigger is machinery too, and the hub's `$defs/trigger` is CLOSED with a frozen `kind`
// vocabulary — but nothing here read it, so a trigger the hub refuses published green in BOTH
// languages (they matched each other perfectly). Same shape of hole as an unknown step kind.
test('a trigger outside the FROZEN vocabulary is refused', () => {
  const files = wellFormed();
  const triggers = [{ kind: 'webhook', url: 'https://example.com/hook' }];
  files['appointment-from-whatsapp.en.flow.json'] = doc({ triggers });
  files['appointment-from-whatsapp.es.flow.json'] = doc({ name: 'Cita desde WhatsApp', triggers });
  assertNames(check(files).errors, 'webhook');
});

test('a trigger with a key the contract does not admit is refused — a trigger is closed', () => {
  const files = wellFormed();
  const triggers = [{ kind: 'event', event: 'hub.whatsapp.message_received', retries: 3 }];
  files['appointment-from-whatsapp.en.flow.json'] = doc({ triggers });
  files['appointment-from-whatsapp.es.flow.json'] = doc({ name: 'Cita desde WhatsApp', triggers });
  assertNames(check(files).errors, 'retries');
});

test('a trigger without kind is refused', () => {
  const files = wellFormed();
  const triggers = [{ event: 'hub.whatsapp.message_received' }];
  files['appointment-from-whatsapp.en.flow.json'] = doc({ triggers });
  files['appointment-from-whatsapp.es.flow.json'] = doc({ name: 'Cita desde WhatsApp', triggers });
  assertNames(check(files).errors, 'kind');
});

test('triggers that are not a list are refused', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = doc({ triggers: 'event' });
  files['appointment-from-whatsapp.es.flow.json'] = doc({ name: 'Cita desde WhatsApp', triggers: 'event' });
  assertNames(check(files).errors, 'triggers');
});

// The prose list is a policy of this door (the schema does not tell prose from machinery), so it
// is the one closed thing typed here — and this is what keeps it honest: every key it names is a
// key of `$defs/step` in the vendored schema. A key the hub renames or drops cannot linger here.
test('every prose key of a step is a key of the step contract', async () => {
  const { PROSE_STEP_KEYS } = await import('../src/validate-flows.mjs');
  const { loadFlowSchema } = await import('../src/flow-schema.mjs');
  const known = Object.keys(loadFlowSchema().$defs.step.properties);
  for (const key of PROSE_STEP_KEYS) {
    assert.ok(known.includes(key), `\`${key}\` is not a key of $defs/step (${known.join(', ')})`);
  }
});
