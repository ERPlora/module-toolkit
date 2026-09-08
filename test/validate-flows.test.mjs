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

// A `query` grant may pin too since hub#1662 — «may read a diary» becomes «may read THIS
// customer's diary», which is what makes an agenda read safe in a template whose params a model
// writes from a stranger's message. `GrantKind::can_pin` is `Command | Query`, and this door has to
// say the same: refusing it here is what stopped whatsapp_inbox#119 from publishing at all.
test('a query grant may FIX part of the payload: the pin publishes green (hub#1662)', () => {
  const files = wellFormed();
  files['appointment-from-whatsapp.grants.json'] = {
    grants: [
      { kind: 'notify', value: 'whatsapp' },
      {
        kind: 'query',
        value: 'appointments.appointments.list_for_customer',
        payload: { customer_id: 'steps.resolve_customer.id' },
      },
    ],
  };
  assert.deepEqual(check(files).errors, []);
});

// The hub stores a pin only for the kinds that are ever HANDED values to judge — a `command`'s
// payload (hub#1623) and a `query`'s parameters (hub#1662). A pin on any other kind would put a
// restriction on the owner's screen that nothing applies, which is the failure the whole
// default-deny design exists to prevent.
//
// 🔴 `query` used to be in this list and it was RIGHT to be: until hub#1662 the hub refused it.
// The list mirrors `GrantKind::can_pin`, so it moves when the kernel moves — it is not a rule of
// this file's own.
test('a pin on a kind that cannot enforce it is refused: nothing would apply it', () => {
  for (const kind of ['notify', 'http', 'recipient_query']) {
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

// ── the VALUE of a pin (hub#1662, module-toolkit#233) ─────────────────────────────────────────
//
// #231 mirrored WHICH kind may fix values; this mirrors WHICH VALUES are ones. A pin is a literal
// or a reference into the run, and the run scope the executor builds is `{ input, steps }` and
// nothing else (`grants.rs::run_scope`), so `PIN_ROOTS` is those two:
//
//   - `secret.…` is out ON PURPOSE — a gate that answered «granted» exactly when a value equalled
//     a secret is an ORACLE, and a caller that can retry reads the secret one guess at a time.
//   - `event.…` is out because the scope does not carry it, so the pin could only ever deny: a
//     permission that authorises nothing.
//   - `{{…}}` prose is out because a pin is a VALUE, not a sentence — rendering flattens a number
//     to a string and an UNRESOLVED template renders EMPTY, so the pin silently stops matching and
//     the containment reads as working while it denies everything.
//
// Without this mirror the module publishes green and the owner meets `flow.invalid_grant_payload`
// at `PUT …/grants` — and because that call is ALL-OR-NOTHING the recipe is not left with the wide
// permission, it is left with NO permission and dies at its first step.
/** The well-formed family with one pinned grant, which is what every case below varies. */
function withPin(kind, payload) {
  const value = kind === 'command' ? 'appointments.appointments.cancel' : 'appointments.appointments.list_for_customer';
  return wellFormed({
    'appointment-from-whatsapp.grants.json': {
      grants: [
        { kind: 'notify', value: 'whatsapp' },
        { kind, value, payload },
      ],
    },
  });
}

// The hub asks `text.contains("{{")`, not «starts with»: a template buried in prose
// (`cust-{{…}}`) is exactly the «text with templates in it» the rule names, and it renders to a
// string the run will never equal. Measured: with `startsWith('{{')` the suite stayed green, so the
// second value below is the one that keeps this door as wide as the hub's.
test('a pin written as a TEMPLATE is refused: an unresolved `{{…}}` renders empty and stops matching', () => {
  for (const kind of ['command', 'query']) {
    for (const written of ['{{steps.resolve_customer.id}}', 'cust-{{steps.resolve_customer.id}}']) {
      const errors = check(withPin(kind, { customer_id: written })).errors;
      assertNames(errors, 'customer_id');
      assert.equal(errors.length, 1, `${kind} ${written}: ${errors.join(' | ')}`);
    }
  }
});

test('a pin on a root this run does not carry is refused: `event.…` could only ever deny', () => {
  for (const kind of ['command', 'query']) {
    assertNames(check(withPin(kind, { customer_id: 'event.payload.from' })).errors, 'event.payload.from');
  }
});

test('a pin on `secret.…` is refused: a gate that matched a secret would be an ORACLE', () => {
  for (const kind of ['command', 'query']) {
    assertNames(check(withPin(kind, { token: 'secret.whatsapp_token' })).errors, 'secret.whatsapp_token');
  }
});

// The other direction of the same mirror, and the one that cost whatsapp_inbox#119 a whole round:
// a door that refuses what the hub ALLOWS stops the module from publishing at all. Every value
// below is one `check_pin_value` returns `Ok` for, so every one of them has to publish green.
test('the two roots the run DOES carry publish green — the pin the kernel landed for', () => {
  for (const path of ['steps.resolve_customer.id', 'input.customer_id']) {
    assert.deepEqual(check(withPin('query', { customer_id: path })).errors, [], path);
  }
});

// `'{one brace}'` rides along on purpose: the template rule is `{{`, and a single brace is an
// ordinary character the hub stores as it stands — a door that refused `{` would stop a literal
// the hub keeps. Measured: with `includes('{')` the suite stayed green.
test('a LITERAL publishes green whatever its type: the hub compares it as it stands', () => {
  for (const literal of [42, true, null, 'customer', '{one brace}', ['a'], { nested: 1 }]) {
    assert.deepEqual(check(withPin('command', { channel: literal })).errors, [], JSON.stringify(literal));
  }
});

// `def::is_path` asks for a KNOWN root AND something after the dot, so these are plain strings and
// not references — a pin fixing a status to `steps` or a code to `event.` is nobody's mistake, but
// a door that widened `is_path` to «any dotted string» would refuse `appointments.list` too, and
// that one is an ordinary value a template does pin.
test('a string that is not a reference publishes green: `is_path` needs a KNOWN root and a path after it', () => {
  for (const literal of ['appointments.list', 'steps', 'event.', 'input', 'secret', 'customer.vip']) {
    assert.deepEqual(check(withPin('command', { channel: literal })).errors, [], literal);
  }
});

// The kind is the FIRST thing the hub refuses (`replace` returns before it reads any value), and
// this door says the same: an author who picked the wrong kind gets one finding naming the cause,
// not a second one about a value that was never going to be looked at.
test('the wrong KIND is one finding, not two: the hub never reaches the values either', () => {
  const files = wellFormed({
    'appointment-from-whatsapp.grants.json': {
      grants: [{ kind: 'notify', value: 'whatsapp', payload: { text: '{{steps.draft.body}}' } }],
    },
  });
  const { errors } = check(files);
  assert.equal(errors.length, 1, errors.join(' | '));
  assert.ok(errors[0].includes('`notify` grant'), errors[0]);
});

// The hub judges the pin's TOP-LEVEL fields only (`replace` iterates `payload`, `resolve_pin`
// asks `pin_reference` of each written value and never descends). Refusing a nested one here would
// be this door inventing a rule the hub does not have — which is the failure that cuts the other
// way. Reported as its own hub question in ERPlora/hub#1666.
test('the pin is judged FIELD BY FIELD, exactly as the hub iterates it — nothing nested', () => {
  assert.deepEqual(check(withPin('command', { where: { customer: 'secret.token' } })).errors, []);
});

// The finding has to name the FIELD, because a pin is a map and «this grant is wrong» sends the
// author to read four values to find the one the hub will reject.
//
// 🔴 The bad value is deliberately the SECOND one, and the good one comes FIRST: the hub judges
// EVERY field (`for (field, written) in payload`), so a door that stopped at the first — the shape
// every «scan» guard drifts into — would publish this pin green. Measured: with the loop cut to
// `.slice(0, 1)` this is the test that goes red.
test('the refusal names the field and the file, so the author knows which value to fix', () => {
  const [first, ...rest] = check(withPin('query', { staff_id: 'input.staff', customer_id: 'event.from' })).errors;
  assert.equal(rest.length, 0);
  assert.ok(first.includes('appointment-from-whatsapp.grants.json'), first);
  assert.ok(first.includes('customer_id'), first);
  assert.ok(!first.includes('staff_id'), first);
  assert.ok(first.includes('flow.invalid_grant_payload'), first);
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

// ── The keys that are prose AND machinery at once (module-toolkit#209, hub#1633/#1639) ──────────
//
// `PROSE_STEP_KEYS` reads a step key as one thing or the other, which was true the day it was
// written and stopped being true twice in a week:
//
//   · `interactive` (hub#1633) is Meta's object as it travels — `{type, header?, body, footer?,
//     action}`. Its `type`, its `rows` mapping and the `id` of a row are machinery, and its
//     `body.text`, its button and the title of a section are THE WORDS THE CUSTOMER READS on her
//     phone. Comparing it whole tells a Spanish salon to send `Tap whichever slot suits you.`;
//   · `output` (hub#1639) is what an `ai` step publishes — `{<field>: {type, describe}}`. The
//     `type` is the closed vocabulary the kernel enforces; the `describe` is the only thing the
//     MODEL reads about the field, and a model told in English what a Spanish conversation is
//     about answers worse.
//
// So the door has to judge them PATH by path: the prose inside them is free, the rest is not.
// Found on `whatsapp_inbox#101`, whose gate went red on a translation that was correct.
function interactiveDoc(overrides = {}) {
  return doc({
    steps: [
      {
        id: 'find_slots',
        kind: 'ai',
        prompt: 'Find her slots',
        tools: [],
        output: { slots: { type: 'options', describe: 'The free slots she may tap' } },
      },
      {
        id: 'offer_slots',
        kind: 'notify',
        channel: 'whatsapp',
        interactive: {
          type: 'list',
          body: { text: 'Tap whichever slot suits you.' },
          action: { button: 'See slots', sections: [{ title: 'Free slots', rows: 'steps.find_slots.slots' }] },
        },
      },
    ],
    ...overrides,
  });
}

/** The same family, its Spanish half built by patching the English steps. */
function interactiveFamily(patch) {
  const files = wellFormed();
  files['appointment-from-whatsapp.en.flow.json'] = interactiveDoc();
  const es = interactiveDoc({ name: 'Cita desde WhatsApp' });
  patch(es.steps[0], es.steps[1]);
  files['appointment-from-whatsapp.es.flow.json'] = es;
  return files;
}

test('a translation may translate the words the customer READS inside `interactive`', () => {
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.body.text = 'Toca el hueco que te venga bien.';
    notify.interactive.action.button = 'Ver huecos';
    notify.interactive.action.sections[0].title = 'Huecos libres';
  });
  assert.deepEqual(check(files).errors, []);
});

test('a translation may translate what the MODEL reads about an output field — `describe`', () => {
  const files = interactiveFamily((ai) => {
    ai.output.slots.describe = 'Los huecos libres que puede tocar';
  });
  assert.deepEqual(check(files).errors, []);
});

test('a translation may translate the words of a row it lists LITERALLY, never its id', () => {
  const rows = (title) => [{ id: '2026-09-08T10:30|staff:12', title, description: 'With Ana' }];
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.action.sections[0].rows = rows('Martes 10:30');
    notify.interactive.action.sections[0].rows[0].description = 'Con Ana';
  });
  files['appointment-from-whatsapp.en.flow.json'].steps[1].interactive.action.sections[0].rows =
    rows('Tuesday 10:30');
  assert.deepEqual(check(files).errors, []);
});

test('a translation may translate the title of a REPLY BUTTON, never the id it sends back', () => {
  const action = (title) => ({ buttons: [{ type: 'reply', reply: { id: 'confirm', title } }] });
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.type = 'button';
    notify.interactive.action = action('Confirmar');
  });
  const english = files['appointment-from-whatsapp.en.flow.json'].steps[1].interactive;
  english.type = 'button';
  english.action = action('Confirm');
  assert.deepEqual(check(files).errors, []);
});

test('the languages must offer the options that come from the SAME place — `rows` is machinery', () => {
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.action.sections[0].rows = 'steps.find_slots.other_slots';
  });
  const errors = check(files).errors;
  assertNames(errors, 'offer_slots');
  assertNames(errors, 'interactive');
});

test('the languages must send back the SAME id when a row is listed literally', () => {
  const rows = (id) => [{ id, title: 'Tuesday 10:30' }];
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.action.sections[0].rows = rows('another-slot');
  });
  files['appointment-from-whatsapp.en.flow.json'].steps[1].interactive.action.sections[0].rows =
    rows('2026-09-08T10:30|staff:12');
  assertNames(check(files).errors, 'interactive');
});

test('the languages must be the same KIND of interactive message — `type` is machinery', () => {
  const files = interactiveFamily((_ai, notify) => {
    notify.interactive.type = 'button';
  });
  assertNames(check(files).errors, 'interactive');
});

test('the languages must declare the same SHAPE of output — `type` is machinery', () => {
  const files = interactiveFamily((ai) => {
    ai.output.slots.type = 'text';
  });
  const errors = check(files).errors;
  assertNames(errors, 'find_slots');
  assertNames(errors, 'output');
});

test('the languages must declare the same output FIELDS — a name is machinery, later steps read it', () => {
  const files = interactiveFamily((ai) => {
    ai.output = { huecos: { type: 'options', describe: 'Los huecos libres' } };
  });
  assertNames(check(files).errors, 'output');
});

test('a translation that DROPS the words of a mixed key is refused, never sent empty', () => {
  const files = interactiveFamily((_ai, notify) => {
    delete notify.interactive.body;
  });
  assertNames(check(files).errors, 'interactive');
});

// The other half of the guard above: a path is dead weight the day the hub renames the key it
// hangs from, and dead weight in an allowlist is a hole — it stops masking anything and the door
// silently goes back to comparing the mixed key whole.
test('every prose PATH of a step hangs from a key of the step contract', async () => {
  const { PROSE_STEP_PATHS } = await import('../src/validate-flows.mjs');
  const { loadFlowSchema } = await import('../src/flow-schema.mjs');
  const step = loadFlowSchema().$defs.step.properties;
  const known = Object.keys(step);
  assert.ok(PROSE_STEP_PATHS.length, 'the mixed keys carry no prose path at all');
  for (const path of PROSE_STEP_PATHS) {
    const root = path.split('.')[0];
    assert.ok(known.includes(root), `\`${path}\` hangs from \`${root}\`, no key of $defs/step (${known.join(', ')})`);
  }
  // `output` is the one mixed key the schema describes field by field, so its prose is pinned
  // here too: `describe` renamed in the hub must not leave `output.*.describe` masking nothing.
  const field = step.output?.additionalProperties?.properties ?? {};
  assert.deepEqual(Object.keys(field).sort(), ['describe', 'type'], 'the output field contract moved on in the hub');
});
