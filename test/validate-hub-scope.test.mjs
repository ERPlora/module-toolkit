// The tenancy gate of `erplora validate` (module-toolkit#80).
//
// The runtime injects `:hub_id` as a BIND, never as a column and never as a predicate
// (`crates/runtime/src/lib.rs::system_params` — `pub` because it is kernel contract). So a module
// whose SQL does not NAME `hub_id` writes NULL into a `NOT NULL` column and reads across tenants.
// Both are invisible to every gate we had: the statement PREPAREs perfectly, so `validate --pg`
// is green, and `erplora dev` answers `ok:true` without touching SQL. The hole only opens when a
// customer's hub EXECUTES it.
//
// This is the pattern guard the point fix needs (root CLAUDE.md, "cero regresiones"): fixing the
// scaffold template stops the module the scaffold writes, not the next one an author writes by
// hand — nor `erplora g command`, nor a copy-paste from a module whose table has no `hub_id`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHubScope, hubScopedTables } from '../src/validate-hub-scope.mjs';

/** A module on disk: `files` are written verbatim, `module.json` is the manifest. */
function mod(files, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-hubscope-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
  return dir;
}

const INIT = `CREATE TABLE IF NOT EXISTS demo_items (
  id          TEXT PRIMARY KEY,
  hub_id      TEXT NOT NULL,
  name        TEXT NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0
);`;

const BASE = {
  id: 'demo',
  migrations: { postgres: ['migrations/postgres/001_init.sql'] },
};

// ── which tables the rule applies to ────────────────────────────────────────────────────────

test('hubScopedTables: a CREATE TABLE with a hub_id column is scoped', () => {
  assert.deepEqual(hubScopedTables(INIT), ['demo_items']);
});

test('hubScopedTables: a table WITHOUT hub_id is not scoped (no rule, no false positive)', () => {
  const sql = 'CREATE TABLE demo_rates (id TEXT PRIMARY KEY, rate REAL NOT NULL);';
  assert.deepEqual(hubScopedTables(sql), []);
});

test('hubScopedTables: ALTER TABLE … ADD COLUMN hub_id scopes the table too', () => {
  const sql = 'CREATE TABLE demo_old (id TEXT PRIMARY KEY);\nALTER TABLE demo_old ADD COLUMN hub_id TEXT;';
  assert.deepEqual(hubScopedTables(sql), ['demo_old']);
});

test('hubScopedTables: `hub_id` inside a COMMENT does not scope anything', () => {
  const sql = 'CREATE TABLE demo_free (\n  -- no hub_id here on purpose\n  id TEXT PRIMARY KEY\n);';
  assert.deepEqual(hubScopedTables(sql), []);
});

// ── the write hole: the exact SQL `g module` shipped ─────────────────────────────────────────

test('an INSERT into a scoped table that does not write hub_id is an ERROR', () => {
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'commands/items_create.sql':
        '-- demo.items.create — hub_id lo inyecta el runtime.\n' +
        'INSERT INTO demo_items (id, name)\nVALUES (:id, :name);\n',
    },
    { ...BASE, commands: { 'demo.items.create': { sql: ['commands/items_create.sql'] } } },
  );
  try {
    const { errors } = checkHubScope(dir, {
      ...BASE,
      commands: { 'demo.items.create': { sql: ['commands/items_create.sql'] } },
    });
    assert.equal(errors.length, 1, `esperaba 1 error, hubo: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /commands\.demo\.items\.create/);
    assert.match(errors[0], /demo_items/);
    assert.match(errors[0], /hub_id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an INSERT that DOES write hub_id passes', () => {
  const manifest = { ...BASE, commands: { 'demo.items.create': { sql: ['commands/items_create.sql'] } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'commands/items_create.sql':
        'INSERT INTO demo_items (id, hub_id, name)\nVALUES (:id, :hub_id, :name);\n',
    },
    manifest,
  );
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the read hole: a list that leaks other hubs' rows ────────────────────────────────────────

test('a SELECT over a scoped table without `:hub_id` is an ERROR', () => {
  const manifest = { ...BASE, queries: { 'demo.items.list': { sql: 'queries/items_list.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/items_list.sql': 'SELECT id, name FROM demo_items WHERE is_deleted = 0;\n',
    },
    manifest,
  );
  try {
    const { errors } = checkHubScope(dir, manifest);
    assert.equal(errors.length, 1, `esperaba 1 error, hubo: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /queries\.demo\.items\.list/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a SELECT that filters `WHERE hub_id = :hub_id` passes', () => {
  const manifest = { ...BASE, queries: { 'demo.items.list': { sql: 'queries/items_list.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/items_list.sql':
        'SELECT id, name FROM demo_items WHERE hub_id = :hub_id AND is_deleted = 0;\n',
    },
    manifest,
  );
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an UPDATE over a scoped table without `:hub_id` is an ERROR (cross-tenant write)', () => {
  const manifest = { ...BASE, commands: { 'demo.items.touch': { sql: ['commands/items_touch.sql'] } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'commands/items_touch.sql': 'UPDATE demo_items SET name = :name WHERE id = :id;\n',
    },
    manifest,
  );
  try {
    const { errors } = checkHubScope(dir, manifest);
    assert.equal(errors.length, 1, `esperaba 1 error, hubo: ${JSON.stringify(errors)}`);
    assert.match(errors[0], /commands\.demo\.items\.touch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── no false positives: the shapes real modules already publish ──────────────────────────────

test('a table of ANOTHER module (depends_on) is out of scope — this gate never guesses', () => {
  // `customers_customer` is not declared by THIS module's migrations, so the rule says nothing
  // about it. Under-covering is the deliberate trade: a false error here blocks the catalogue.
  const manifest = { ...BASE, queries: { 'demo.cust.list': { sql: 'queries/cust.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/cust.sql': 'SELECT id FROM customers_customer WHERE is_deleted = 0;\n',
    },
    manifest,
  );
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the table named only inside a COMMENT does not trigger the rule', () => {
  const manifest = { ...BASE, queries: { 'demo.other.list': { sql: 'queries/other.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/other.sql': '-- ojo: no toca demo_items\nSELECT 1 AS x;\n',
    },
    manifest,
  );
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a table whose name merely CONTAINS a scoped name is not the scoped table', () => {
  const manifest = { ...BASE, queries: { 'demo.arch.list': { sql: 'queries/arch.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/arch.sql': 'SELECT id FROM demo_items_archive WHERE is_deleted = 0;\n',
    },
    manifest,
  );
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a scoped table reached through a JOIN still has to carry `:hub_id`', () => {
  const manifest = { ...BASE, queries: { 'demo.join.list': { sql: 'queries/join.sql' } } };
  const dir = mod(
    {
      'migrations/postgres/001_init.sql': INIT,
      'queries/join.sql':
        'SELECT i.id FROM customers_customer c JOIN demo_items i ON i.id = c.id;\n',
    },
    manifest,
  );
  try {
    const { errors } = checkHubScope(dir, manifest);
    assert.equal(errors.length, 1, `esperaba 1 error, hubo: ${JSON.stringify(errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inline SQL in the manifest is judged like a file', () => {
  const manifest = {
    ...BASE,
    queries: { 'demo.inline': { sql: 'SELECT id FROM demo_items WHERE is_deleted = 0' } },
  };
  const dir = mod({ 'migrations/postgres/001_init.sql': INIT }, manifest);
  try {
    const { errors } = checkHubScope(dir, manifest);
    assert.equal(errors.length, 1, `esperaba 1 error, hubo: ${JSON.stringify(errors)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module with no migrations declares no scoped table and the gate stays silent', () => {
  const manifest = { id: 'demo', queries: { 'demo.x': { sql: 'SELECT 1' } } };
  const dir = mod({}, manifest);
  try {
    assert.deepEqual(checkHubScope(dir, manifest).errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
