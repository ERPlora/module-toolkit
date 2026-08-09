// `erplora validate --pg` — ask POSTGRES, instead of guessing lexically (module-toolkit#32, hole 3).
//
// The lexical guardrails will always trail reality: `whatsapp_inbox.messages.ingest` compares a
// TEXT column with a `timestamptz` (`m.created_at >= erp_month_start(:now)`) and no plausible
// lexical rule can tell one identifier's type from another's. Preparing is exactly what the runtime
// does on every call, so a statement Postgres cannot PREPARE is dead code — and since ADR-0154 the
// modules only ship the `postgres` dialect, dead in every hub.
//
// The pattern comes from the three regression tests written while fixing the modules
// (`reservations/tests/settings_upsert.pg.test.py`, `appointments/…`, `tasks/…`): a scratch
// database built from the module's OWN migrations, `:name` lowered to `$n` and the `erp_*` bridge
// functions rewritten exactly like `hub/crates/db/src/lib.rs` does, then `PREPARE` on every
// declared statement. Without Docker it SKIPS — it never passes in false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { checkPrepare, pgAvailable, pgParamTypes, shimDdlTypes, translateForPostgres } from '../src/validate-prepare.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pg-real-cases');
const HAS_PG = await pgAvailable();
const needsPg = { skip: HAS_PG ? false : 'no Postgres container available (nothing was verified)' };

function mod(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-prepare-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return { dir, manifest };
}

// ── the translation has to be the runtime's, or the check tests the wrong SQL ────────────────

test('translate: `:name` → `$n` by first appearance, and a repeated name reuses its index', () => {
  const { sql, names } = translateForPostgres('SELECT :a, :b, :a FROM t WHERE x = :b');
  assert.equal(sql, 'SELECT $1, $2, $1 FROM t WHERE x = $2');
  assert.deepEqual(names, ['a', 'b']);
});

test('translate: `::` is the cast operator, never a bind', () => {
  assert.equal(translateForPostgres('SELECT x::text FROM t').sql, 'SELECT x::text FROM t');
});

test('translate: a `:name` inside a literal or a comment stays verbatim (no phantom $n)', () => {
  // The runtime emits comments untouched: a bind that only lived in one became a phantom `$n`,
  // bound but absent from the SQL the engine parses → 42P08. Same trap here.
  const { sql, names } = translateForPostgres("-- binds: :ghost\nSELECT ':ghost', :real FROM t");
  assert.match(sql, /-- binds: :ghost/);
  assert.match(sql, /':ghost'/);
  assert.deepEqual(names, ['real']);
});

test('translate: the `erp_*` bridge functions are lowered like the runtime does', () => {
  assert.equal(translateForPostgres('SELECT erp_pad(:n, 4)').sql, "SELECT lpad(($1)::text, 4, '0')");
  assert.equal(
    translateForPostgres('SELECT erp_month_start(:now)').sql,
    "SELECT date_trunc('month', ($1)::timestamptz)",
  );
  assert.equal(translateForPostgres('SELECT erp_now()').sql, 'SELECT now()');
});

test('DDL types: the portable subset is normalised like `shim_ddl_types` (INTEGER → BIGINT)', () => {
  const out = shimDdlTypes('CREATE TABLE t (id TEXT, n INTEGER, r REAL, b BLOB);');
  assert.equal(out, 'CREATE TABLE t (id TEXT, n BIGINT, r DOUBLE PRECISION, b BYTEA);');
});

// ── which binds get a type: the ones that cannot arrive NULL ─────────────────────────────────

test('param types: the runtime-injected binds are always typed, an optional one is left to infer', () => {
  const schema = {
    required: ['title'],
    properties: { title: { type: 'string' }, project_id: { type: 'string', default: null } },
  };
  const types = pgParamTypes(['hub_id', 'now', 'title', 'project_id'], schema);
  assert.deepEqual(types, ['text', 'text', 'text', null]);
  // `null` = untyped on purpose: an absent optional bind travels as OID 0 (`DynNull`) and that is
  // the exact shape that has to prepare. Typing it would hide the very bug this mode hunts.
});

// ── the real thing: PREPARE against Postgres ────────────────────────────────────────────────

test('whatsapp_inbox#24: --pg catches `TEXT >= timestamptz`, which no lexical rule can', needsPg, async () => {
  const manifest = JSON.parse(readFileSync(join(FIXTURES, 'whatsapp_inbox', 'module.json'), 'utf8'));
  const out = await checkPrepare(join(FIXTURES, 'whatsapp_inbox'), manifest);
  assert.equal(out.skipped, false);
  assert.equal(out.errors.length, 1, `expected messages.ingest to fail, got: ${JSON.stringify(out.errors)}`);
  assert.match(out.errors[0], /messages\.ingest/);
  assert.match(out.errors[0], /operator does not exist: text >= timestamp with time zone/);
});

test('a module whose SQL prepares comes back clean', needsPg, async () => {
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql':
      'CREATE TABLE demo_note (id TEXT PRIMARY KEY, hub_id TEXT, body TEXT, n INTEGER, created_at TEXT);',
    'commands/insert.sql':
      'INSERT INTO demo_note (id, hub_id, body, n, created_at) VALUES (:new_id, :hub_id, :body, 0, :now);',
    'queries/list.sql':
      'SELECT id, body FROM demo_note WHERE hub_id = :hub_id AND (CAST(:filter AS TEXT) IS NULL OR body = :filter);',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'demo.notes.add': { sql: ['commands/insert.sql'] } },
    queries: { 'demo.notes.list': { sql: 'queries/list.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.deepEqual(out.errors, []);
  assert.equal(out.prepared, 2);
});

test('the untyped-bind bug is caught end to end: `(:p IS NULL OR col = :p)` does not prepare', needsPg, async () => {
  // The same shape that killed `appointments` and `tasks`, now confirmed by the engine itself and
  // not only by the lexical rule — which is the point of having both doors.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_task (id TEXT PRIMARY KEY, project_id TEXT);',
    'queries/list.sql': 'SELECT id FROM demo_task WHERE (:project_id IS NULL OR project_id = :project_id);',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    queries: { 'demo.tasks.list': { sql: 'queries/list.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /could not determine data type of parameter/);
});

test('a table owned by ANOTHER module is a WARNING, not a failure (inventory → sales_sale_item)', needsPg, async () => {
  // A module's scratch database only carries its OWN migrations, so a legitimate cross-module read
  // shows up as `relation does not exist`. Reporting it as a failure would be the gate lying.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_stock (id TEXT PRIMARY KEY, hub_id TEXT);',
    'queries/join.sql': 'SELECT s.id FROM demo_stock s JOIN sales_sale_item i ON i.product_id = s.id WHERE s.hub_id = :hub_id;',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    queries: { 'demo.stock.sold': { sql: 'queries/join.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.deepEqual(out.errors, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /sales_sale_item/);
});

test('a missing table of the module ITSELF is an error, not an excusable foreign table', needsPg, async () => {
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_stock (id TEXT PRIMARY KEY);',
    'queries/typo.sql': 'SELECT id FROM demo_stok;',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    queries: { 'demo.stock.typo': { sql: 'queries/typo.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /demo_stok/);
});

// ── the two false-positive classes the sweep of pm#107 already knew about ────────────────────
//
// A bind whose type nobody declared is sent by the runtime with the JSON type the caller used
// (`hub/crates/db/src/lib.rs`: a number binds as i64, a string as text). Postgres, asked to deduce
// it from a scratch statement with no caller, sometimes cannot — and that is a limitation of THIS
// check, not a bug in the module. Reporting it as broken is the gate lying, so it is a warning that
// names what is missing.

test('invoice class: a bind used as both text and bigint is NOT reported as broken', needsPg, async () => {
  // `invoice._insert_invoice` does exactly this: `:year` is concatenated (`:prefix || '-' || :year`)
  // and also compared with an INTEGER column. Postgres deduces text from the first use and then
  // fails on `bigint = text`; the handler sends `json!(i64)`, so in a real hub it prepares.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_series (code TEXT, year INTEGER, n INTEGER);',
    'commands/pick.sql': "SELECT :prefix || '-' || :year AS label, n FROM demo_series WHERE year = :year;",
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'demo.series.pick': { sql: 'commands/pick.sql' } }, // no `schema`: types unknown
  });
  const out = await checkPrepare(dir, manifest);
  assert.deepEqual(out.errors, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /schema|tipo/i, 'must say WHY it could not be verified');
});

test('cash_register class: `inconsistent types deduced` for an undeclared bind is a warning', needsPg, async () => {
  // `cash_register.session.close` assigns `:closing_balance` to a BIGINT column and also subtracts
  // it from a SUM() (numeric). Untyped, Postgres deduces two types and refuses; typed, it coerces.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_session (id TEXT, closing INTEGER, diff INTEGER, amount INTEGER);',
    'commands/close.sql':
      'UPDATE demo_session SET closing = :closing_balance, ' +
      'diff = :closing_balance - COALESCE((SELECT SUM(amount) FROM demo_session), 0) WHERE id = :session_id;',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'demo.session.close': { sql: 'commands/close.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.deepEqual(out.errors, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /closing_balance|\$\d/);
});

test('but a type clash between two NON-parameters stays an ERROR (whatsapp_inbox#24)', needsPg, async () => {
  // The distinction that keeps the mode useful: in `m.created_at >= erp_month_start(:now)` the only
  // bind involved is `:now`, which the runtime always injects typed. Nothing is unknown — the SQL
  // is simply wrong, and no caller can fix it.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_msg (id TEXT, created_at TEXT, note TEXT);',
    'commands/ingest.sql':
      'INSERT INTO demo_msg (id, created_at, note) SELECT :new_id, :now, :note ' +
      'WHERE NOT EXISTS (SELECT 1 FROM demo_msg m WHERE m.created_at >= erp_month_start(:now));',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'demo.msg.ingest': { sql: 'commands/ingest.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.equal(out.errors.length, 1, `expected a hard error, got ${JSON.stringify(out)}`);
  assert.match(out.errors[0], /operator does not exist: text >= timestamp with time zone/);
});

test('reservations#19: an AMBIGUOUS column is an error even with undeclared binds on the line', needsPg, async () => {
  // The excuse only covers failures ABOUT TYPES. `column reference "slot" is ambiguous` is
  // structural: no caller, no declared type and no JSON shape can make that statement parse. If the
  // undeclared bind sitting on the same line were enough to excuse it, `--pg` would have let the
  // very upsert that `reservations` published pass — the second door would repeat the first's hole.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_settings (hub_id TEXT PRIMARY KEY, slot INTEGER);',
    'commands/upsert.sql':
      'INSERT INTO demo_settings (hub_id, slot) VALUES (:hub_id, :slot)\n' +
      'ON CONFLICT(hub_id) DO UPDATE SET slot = COALESCE(:slot, slot);',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    commands: { 'demo.settings.upsert': { sql: 'commands/upsert.sql' } },
  });
  const out = await checkPrepare(dir, manifest);
  assert.equal(out.errors.length, 1, `expected a hard error, got ${JSON.stringify(out)}`);
  assert.match(out.errors[0], /ambiguous/);
});

test('several statements in one module are attributed ONE BY ONE', needsPg, async () => {
  // The whole point of the mode is telling the author WHICH statement is dead. The statements are
  // sent to Postgres in a single session for speed, so this is what keeps the report honest.
  const { dir, manifest } = mod({
    'migrations/postgres/001.sql': 'CREATE TABLE demo_a (id TEXT PRIMARY KEY, hub_id TEXT);',
    'queries/ok.sql': 'SELECT id FROM demo_a WHERE hub_id = :hub_id;',
    'queries/broken.sql': 'SELECT id FROM demo_a WHERE id > CAST(:now AS TIMESTAMPTZ);',
    'queries/foreign.sql': 'SELECT id FROM sales_sale_item;',
    'queries/ok2.sql': 'SELECT count(*) FROM demo_a;',
  }, {
    id: 'demo',
    migrations: { postgres: ['migrations/postgres/001.sql'] },
    queries: {
      'demo.ok': { sql: 'queries/ok.sql' },
      'demo.broken': { sql: 'queries/broken.sql' },
      'demo.foreign': { sql: 'queries/foreign.sql' },
      'demo.ok2': { sql: 'queries/ok2.sql' },
    },
  });
  const out = await checkPrepare(dir, manifest);
  assert.equal(out.prepared, 2, 'the two healthy ones');
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /demo\.broken/);
  assert.match(out.errors[0], /broken\.sql/);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /demo\.foreign/);
});

test('without Docker it SKIPS and says so — it never passes in false', async () => {
  const { dir, manifest } = mod({
    'queries/q.sql': 'SELECT 1;',
  }, { id: 'demo', queries: { 'demo.q': { sql: 'queries/q.sql' } } });
  const out = await checkPrepare(dir, manifest, { container: 'erplora-container-that-does-not-exist' });
  assert.equal(out.skipped, true);
  assert.equal(out.errors.length, 0);
  assert.match(out.reason, /erplora-container-that-does-not-exist/);
});

test('`validate --pg` FAILS when it could not check anything', async () => {
  // The flag is opt-in: whoever typed it (or wrote it into a CI job) asked for this door to be
  // opened. Printing a warning and exiting 0 would turn "nobody checked" into "green", which is the
  // failure mode pm#107 is trying to get rid of.
  const moduleJson = {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    queries: { 'demo.q': { sql: 'queries/q.sql' } },
  };
  const { dir } = mod({
    'module.json': JSON.stringify(moduleJson),
    'queries/q.sql': 'SELECT 1 FROM demo_t;',
  }, null);
  writeContractsFile(dir, moduleJson);
  const previous = process.env.ERPLORA_TEST_PG_CONTAINER;
  process.env.ERPLORA_TEST_PG_CONTAINER = 'erplora-container-that-does-not-exist';
  try {
    await assert.rejects(() => validate(dir, { pg: true }), /no hay un Postgres accesible/);
  } finally {
    if (previous === undefined) delete process.env.ERPLORA_TEST_PG_CONTAINER;
    else process.env.ERPLORA_TEST_PG_CONTAINER = previous;
  }
});
