// The manifest against the canonical schema, EVALUATED — module-toolkit#247. `node --test`.
//
// THE HOLE THIS CLOSES. `schemas/module.schema.json` was read for one thing only: which key NAMES
// the contract admits (`checkManifestKeys`). `required`, `type`, `minimum`, the `oneOf` of a widget
// and the `if/then` of a record were evaluated by NOBODY. So an author could declare a block half
// written — `billing.usage` without `used`, which the schema lists as required — and `erplora
// validate` printed the very same lines, word for word, as if it were right. The module published,
// and the screen simply did not appear in the hub: no error, no warning, nothing to look at.
//
// Measured on 2026-09-09 against the 27 live modules: full evaluation raises TWO findings, both
// genuine (`ai_context` declared as a string where the contract says object, in `reservations` and
// `tasks`), and both land as WARNINGS — the fleet stays green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifestSchema } from '../src/validate-manifest-schema.mjs';

const base = () => ({ id: 'demo', name: 'Demo', version: '1.0.0' });

test('a correct manifest says nothing', () => {
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    commands: { 'demo.do': { sql: ['x.sql'], permission: 'demo.write' } },
    billing: {
      type: 'subscription',
      usage: { query: 'demo.usage.get', metric: 'runs_per_month', used: 'used' },
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// ── The case the issue is written from ────────────────────────────────────────────────────────
test('a REQUIRED field left out is reported by name (#247)', () => {
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    billing: { type: 'subscription', usage: { query: 'demo.usage.get', metric: 'runs_per_month' } },
  });
  assert.deepEqual(errors, [], 'billing is Cloud-only: the runtime keeps it verbatim, so it warns');
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /billing\.usage/);
  assert.match(warnings[0], /`used`/, 'and it names the field that is missing');
});

test('a field with the WRONG TYPE is reported by name (#247)', () => {
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    billing: {
      type: 'subscription',
      usage: { query: 42, metric: 'runs_per_month', used: 'used' },
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /billing\.usage\.query/);
  assert.match(warnings[0], /string/, 'and it says which type the contract asks for');
});

// ── Severity: the runtime's line (hub#521), the same one `checkManifestKeys` draws ────────────
test('inside an OPERATION the same defect is an ERROR: it changes what runs', () => {
  const { errors } = checkManifestSchema({
    ...base(),
    commands: { 'demo.do': { sql: ['x.sql'] } }, // `permission` is required by the contract
  });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /commands\.demo\.do/);
  assert.match(errors[0], /`permission`/);
});

// The narrow case of the same hole, filed on its own (#216) and closed by this change: an author
// forgets the permission of a QUERY, publishes green, and the hub refuses the module on install
// because `QueryDef.permission` is not an `Option`. Pinned by name because it is a CLOSED issue:
// `queries.*` dropping out of `REFUSED_PATHS` would bring it back with nothing going red.
test('a QUERY without `permission` is an error that names the query (#216)', () => {
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    queries: { 'demo.list': { sql: 'queries/list.sql' } },
  });
  assert.deepEqual(warnings, [], 'the hub REFUSES the module for this: it cannot be a warning');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /queries\.demo\.list/, 'and WHICH query, the way the author wrote it');
  assert.match(errors[0], /`permission`/);
});

test('a defect one level INSIDE a refused container is an error too', () => {
  const { errors } = checkManifestSchema({
    ...base(),
    commands: { 'demo.do': { permission: 'demo.write', sql: 7 } },
  });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /commands\.demo\.do\.sql/);
});

test('at the ROOT a known key with the wrong shape WARNS: the 27 live modules stay green', () => {
  // `reservations` and `tasks` both carry `ai_context` as a string where the schema says object —
  // a block the schema itself calls «APARCADO / en diseño». Refusing there would put two green
  // repositories in red over a block nothing reads yet, which is how a gate stops being read.
  // module-toolkit#174's root rule is about a key the CORE DOES NOT READ; this is a known key.
  const { errors, warnings } = checkManifestSchema({ ...base(), ai_context: 'Module: Demo…' });
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /ai_context/);
});

// ── No double reporting: `checkManifestKeys` owns these, with better messages ─────────────────
test('an unknown key is NOT reported here: `checkManifestKeys` names it and suggests one', () => {
  const { errors, warnings } = checkManifestSchema({ ...base(), billing: { type: 'subscription', reset_day: 3 } });
  assert.deepEqual([...errors, ...warnings], [], 'one defect, one message');
});

test('a closed vocabulary and a `pattern` are NOT reported here either (#62, #30)', () => {
  const vocabulary = checkManifestSchema({ ...base(), records: { invoice: { mutable: false, reason: 'apocalyptic' } } });
  assert.deepEqual([...vocabulary.errors, ...vocabulary.warnings], []);
  const pattern = checkManifestSchema({ ...base(), id: 'Demo-Module' });
  assert.deepEqual([...pattern.errors, ...pattern.warnings], []);
});

// ── Alternations: ONE honest message, never the branch cascade ────────────────────────────────
test('a widget declaring the two exclusive ways gets ONE message, not the branch cascade', () => {
  // The contract's `oneOf`: either the declarative way (`kind` + `query`) or the escape hatch
  // (`component`), never both. ajv reports five errors for it — two `not`, the `oneOf`, and the
  // leftovers of the branch that did not match. Handing the author five lines for one mistake is
  // how a validator stops being read.
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    widgets: { revenue: { title: 'Revenue', kind: 'kpi', query: 'demo.q', component: 'demo-w' } },
  });
  const all = [...errors, ...warnings];
  assert.equal(all.length, 1, JSON.stringify(all));
  assert.match(all[0], /widgets\.revenue/);
});

test('the branch reasons are CARRIED in the message, never dropped', () => {
  // `commands.*.reads[]` is `oneOf [string, {query, params?}]`. An object without `query` matches
  // neither, and the author has to be told WHY — ajv's own branch errors are the only honest
  // answer, so they travel inside the single message instead of becoming four.
  const { errors } = checkManifestSchema({
    ...base(),
    commands: { 'demo.do': { permission: 'demo.write', sql: ['x.sql'], reads: [{ params: {} }] } },
  });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /commands\.demo\.do\.reads\[0\]/);
  assert.match(errors[0], /`query`/, 'the reason the object branch rejected it');
});

test('an array item is addressed the way the author wrote it', () => {
  const { errors } = checkManifestSchema({ ...base(), roles: [{ key: 'cashier', label: 'Cashier' }] });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /roles\[0\]/);
  assert.match(errors[0], /`extends`/);
});

// ── The guard against the reason this check did not exist ─────────────────────────────────────
test('the schema is EVALUATED, not just read for key names', () => {
  // The regression this file exists to stop: a validator that loads the schema and asks it nothing.
  // If `checkManifestSchema` ever goes back to returning nothing for a document the contract
  // rejects, this is the line that goes red.
  const { errors, warnings } = checkManifestSchema({
    ...base(),
    scheduled_tasks: [{ name: 'nightly', command: 'demo.do', cron: '0 3 * * *', payload: { whatever: 1 } }],
  });
  assert.deepEqual([...errors, ...warnings], [], 'free-form JSON stays free-form');
  const broken = checkManifestSchema({ ...base(), scheduled_tasks: [{ command: 'demo.do' }] });
  assert.ok(broken.errors.length + broken.warnings.length > 0, 'but a missing required field is seen');
});

// The one rule the canonical schema and another check BOTH carry (#247). The schema's conditional
// on `commands.*` (hub#1091) says the same thing `checkRowGates` says in
// `validate-row-gates.mjs` — but the schema can only render it as «this field is not admitted
// here», which reads as if `min_affected_rows` were banned outright, while the row-gates message
// names how many statements there are, why the guard is neutralisable and what to declare instead.
// Same severity, same exit code, strictly better wording: this check stays quiet, exactly as it
// already does for the keys `checkManifestKeys` owns.
test('the min_affected_rows rule is left to checkRowGates, which can name the statement', async () => {
  const manifest = {
    ...base(),
    commands: {
      'demo.wipe': { permission: 'demo.write', sql: ['a.sql', 'b.sql'], min_affected_rows: 1 },
    },
  };
  const { errors, warnings } = checkManifestSchema(manifest);
  assert.deepEqual(
    [...errors, ...warnings].filter((m) => m.includes('min_affected_rows')),
    [],
    'this check must not say it too — the row-gates message is the one that helps',
  );

  // And the coverage MOVED, it did not vanish: the same manifest is still refused, by the check
  // that owns the rule. Without this half, deleting the rule everywhere would pass the test above.
  const { checkRowGates } = await import('../src/validate-row-gates.mjs');
  const owner = checkRowGates(manifest);
  assert.equal(owner.length, 1, `checkRowGates must still refuse it: ${JSON.stringify(owner)}`);
  assert.match(owner[0], /min_affected_rows/);
});

test('a defect NEXT TO the row gate is still reported — the silence is the rule, not the command', () => {
  // The narrow filter proves itself here: everything else about `commands.*` keeps being checked.
  const { errors } = checkManifestSchema({
    ...base(),
    commands: {
      'demo.wipe': { permission: 'demo.write', sql: ['a.sql', 'b.sql'], min_affected_rows: 1, transaction: 'yes' },
    },
  });
  assert.equal(errors.length, 1, `expected exactly the \`transaction\` defect: ${JSON.stringify(errors)}`);
  assert.match(errors[0], /transaction/);
});
