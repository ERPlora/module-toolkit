// Tests for the handler permission-ceiling warning (ERPlora/hub#459, step 3). `node --test`.
//
// The hole: a Tier-2 handler returns `Operation`s and `commands::validate_operation` resolves them
// to SQL with three rules — the op is `kind == "sql"`, the target command exists, and it belongs to
// the SAME module. It does NOT check the target's permission. So a command a cashier may run can,
// through its handler, reach the SQL of a command reserved for a manager, and nobody is asked for
// the PIN. With the elevation of hub#361 live, "a manager approves this" is a promise the runtime
// makes and any `module.json` can quietly break.
//
// The fix that closes it (a permission check inside `validate_operation`) breaks 84 crossings in 12
// published modules, so hub#459 picks the incremental path: step 3 is `erplora validate` WARNING —
// the author sees the crossing while building, and the catalog is realigned module by module
// without 403-ing live flows. Hence: warnings, never errors. An error here would be the expensive
// fix wearing a cheap hat.
//
// What "crossing" means, precisely: the parent command's permission is the CEILING of everything
// its op chain may touch (hub#459 option 4). A crossing exists when some role holds the parent's
// permission but NOT the target's — that role reaches the target's SQL through the handler and
// could never reach it through the front door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectRustFunctions,
  rolesLosingAccess,
  checkHandlerPermissionCeiling,
} from '../src/validate-handler-permissions.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** Temporary module: `rust` is written to `handler/src/lib.rs` (omit it for a module with no source). */
function mod(manifestExtra, rust) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-handlerperm-'));
  if (rust !== undefined) {
    mkdirSync(join(dir, 'handler', 'src'), { recursive: true });
    writeFileSync(join(dir, 'handler', 'src', 'lib.rs'), rust);
  }
  const manifest = { id: 'tables', name: 'Tables', version: '1.0.0', ...manifestExtra };
  return { dir, manifest, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The real `tables` shape of hub#459: `sessions.open` (cashier-level) reaches `_insert_table`. */
const TABLES = {
  role_permissions: {
    admin: ['*'],
    manager: ['tables.add_table', 'tables.add_tablesession'],
    employee: ['tables.add_tablesession'],
  },
  commands: {
    'tables.sessions.open': {
      permission: 'tables.add_tablesession',
      handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'open_session' },
    },
    'tables._insert_table': { permission: 'tables.add_table', sql: ['commands/insert_table.sql'] },
    'tables._session_open': {
      permission: 'tables.add_tablesession',
      sql: ['commands/session_open.sql'],
    },
  },
};

// ── the pure helpers ─────────────────────────────────────────────────────────

test('collectRustFunctions: brace-matches a body past strings, chars and comments', () => {
  const fns = collectRustFunctions(`
/// Doc comment with a brace { and a "quote.
pub fn outer(input: Value) -> Result<Output, String> {
    let s = "a } inside a string literal";
    let c = '}';
    // a } inside a line comment
    /* and a } inside a block comment */
    if true { let nested = 1; }
    Ok(inner(s))
}

fn inner(s: &str) -> Output { Output::from("tables._insert_table") }
`);
  assert.deepEqual([...fns.keys()].sort(), ['inner', 'outer']);
  assert.match(fns.get('outer'), /nested = 1/);
  assert.doesNotMatch(fns.get('outer'), /fn inner/, 'the body stopped at its own closing brace');
  assert.match(fns.get('inner'), /_insert_table/);
});

test('rolesLosingAccess: the roles that hold the parent permission but not the target one', () => {
  const rp = { admin: ['*'], manager: ['a', 'b'], employee: ['a'] };
  assert.deepEqual(rolesLosingAccess(rp, 'a', 'b'), ['employee']);
  assert.deepEqual(rolesLosingAccess(rp, 'a', 'a'), [], 'same permission crosses nothing');
  assert.deepEqual(rolesLosingAccess(rp, 'b', 'a'), [], 'the target being LOOSER is not a crossing');
  assert.deepEqual(rolesLosingAccess(rp, 'a', 'zzz'), ['manager', 'employee'], 'admin holds `*`');
});

// ── the check ────────────────────────────────────────────────────────────────

test('WARNS: the hub#459 case — an employee reaches `_insert_table` through `sessions.open`', () => {
  const m = mod(
    TABLES,
    `pub fn open_session(i: Input) -> Output { open_session_pure(i) }
     fn open_session_pure(i: Input) -> Output {
        ops.push(Operation::sql("tables._insert_table", p));
        Output { operations: ops }
     }`,
  );
  const { checked, warnings } = checkHandlerPermissionCeiling(m.dir, m.manifest);
  assert.equal(checked, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tables\.sessions\.open/);
  assert.match(warnings[0], /tables\._insert_table/);
  assert.match(warnings[0], /tables\.add_tablesession/);
  assert.match(warnings[0], /tables\.add_table/);
  assert.match(warnings[0], /employee/);
  assert.doesNotMatch(warnings[0], /manager/, 'manager holds both: it is not losing anything');
  assert.match(warnings[0], /hub#459/);
  m.clean();
});

test('QUIET: a handler that only reaches a command with its own permission', () => {
  const m = mod(
    TABLES,
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("tables._session_open", p))
     }`,
  );
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest).warnings, []);
  m.clean();
});

test('QUIET: a literal that only appears in a comment is not an operation', () => {
  const m = mod(
    TABLES,
    `pub fn open_session(i: Input) -> Output {
        // Historical: this used to emit "tables._insert_table" before hub#000.
        Output::one(Operation::sql("tables._session_open", p))
     }`,
  );
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest).warnings, []);
  m.clean();
});

test('QUIET: a literal naming ANOTHER module — the runtime already blocks it, loudly', () => {
  const m = mod(
    { ...TABLES, commands: { ...TABLES.commands } },
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("sales.orders.void", p))
     }`,
  );
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest).warnings, []);
  m.clean();
});

test('QUIET: a target with no `sql[]` — not a valid op destination either (§5.3)', () => {
  const m = mod(
    {
      role_permissions: TABLES.role_permissions,
      commands: {
        'tables.sessions.open': {
          permission: 'tables.add_tablesession',
          handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'open_session' },
        },
        'tables._insert_table': { permission: 'tables.add_table' },
      },
    },
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("tables._insert_table", p))
     }`,
  );
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest).warnings, []);
  m.clean();
});

test('QUIET, and `checked: false`: a module with no handler at all', () => {
  const m = mod({ commands: { 'tables.zones.create': { permission: 'tables.add_zone', sql: ['a.sql'] } } });
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest), { checked: false, warnings: [] });
  m.clean();
});

test('QUIET, and `checked: false`: a handler declared with no Rust source shipped', () => {
  const m = mod(TABLES); // no handler/src on disk
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest), { checked: false, warnings: [] });
  m.clean();
});

test('the walk is TRANSITIVE and does not loop on recursion', () => {
  const m = mod(
    TABLES,
    `pub fn open_session(i: Input) -> Output { level_one(i) }
     fn level_one(i: Input) -> Output { if i.deep { return level_one(i); } level_two(i) }
     fn level_two(i: Input) -> Output {
        Output::one(Operation::sql("tables._insert_table", p))
     }`,
  );
  const { warnings } = checkHandlerPermissionCeiling(m.dir, m.manifest);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /tables\._insert_table/);
  m.clean();
});

test('a handler NOT reached from any entry point does not contaminate the others', () => {
  const m = mod(
    {
      ...TABLES,
      commands: {
        ...TABLES.commands,
        'tables.tables.bulk_create': {
          permission: 'tables.add_table',
          handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'bulk_create_tables' },
        },
      },
    },
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("tables._session_open", p))
     }
     pub fn bulk_create_tables(i: Input) -> Output {
        Output::one(Operation::sql("tables._insert_table", p))
     }`,
  );
  // `bulk_create` holds `add_table` itself, so reaching `_insert_table` crosses nothing; and
  // `sessions.open` never reaches it because the walk starts at its own function.
  assert.deepEqual(checkHandlerPermissionCeiling(m.dir, m.manifest).warnings, []);
  m.clean();
});

test('sources are read RECURSIVELY: the op may live in a sibling .rs file', () => {
  const m = mod(TABLES, `pub fn open_session(i: Input) -> Output { ops::build(i) }`);
  mkdirSync(join(m.dir, 'handler', 'src', 'ops'), { recursive: true });
  writeFileSync(
    join(m.dir, 'handler', 'src', 'ops', 'mod.rs'),
    `pub fn build(i: Input) -> Output { Output::one(Operation::sql("tables._insert_table", p)) }`,
  );
  const { warnings } = checkHandlerPermissionCeiling(m.dir, m.manifest);
  assert.equal(warnings.length, 1, 'the call crossed a file boundary');
  m.clean();
});

test('WARNS without naming roles when the manifest declares no role_permissions', () => {
  const m = mod(
    { commands: TABLES.commands },
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("tables._insert_table", p))
     }`,
  );
  const { warnings } = checkHandlerPermissionCeiling(m.dir, m.manifest);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /role_permissions/);
  m.clean();
});

test('one warning per crossing, and the entry point missing from the source is skipped', () => {
  const m = mod(
    {
      ...TABLES,
      commands: {
        ...TABLES.commands,
        'tables._zone_delete': { permission: 'tables.delete_zone', sql: ['commands/zone_delete.sql'] },
        'tables.zones.delete': {
          permission: 'tables.add_tablesession',
          handler: { type: 'wasm', file: 'dist/handler.wasm', function: 'not_in_the_source' },
        },
      },
    },
    `pub fn open_session(i: Input) -> Output {
        ops.push(Operation::sql("tables._insert_table", p));
        ops.push(Operation::sql("tables._zone_delete", p));
        Output { operations: ops }
     }`,
  );
  const { warnings } = checkHandlerPermissionCeiling(m.dir, m.manifest);
  assert.equal(warnings.length, 2, 'two targets crossed from one handler');
  assert.ok(warnings.some((w) => /_insert_table/.test(w)));
  assert.ok(warnings.some((w) => /_zone_delete/.test(w)));
  m.clean();
});

// The warning is worth nothing unless `erplora validate` prints it — and it must stay a WARNING:
// `pack`/`publish` run `validate`, so turning it into an error here would be the expensive fix
// (hub#459 option 1) shipped under the cheap one's name, blocking 12 published modules.
test('WIRED: `erplora validate` prints the crossing and still exits green', async () => {
  const m = mod(
    TABLES,
    `pub fn open_session(i: Input) -> Output {
        Output::one(Operation::sql("tables._insert_table", p))
     }`,
  );
  // `native` keeps the binary checks (module-toolkit#26/#135) out of the way: this warning is about
  // the manifest and the source, and needs no `dist/handler.wasm` to be true.
  m.manifest.commands['tables.sessions.open'].handler = { type: 'native', function: 'open_session' };
  m.manifest.commands['tables._insert_table'].sql = ['commands/insert_table.sql'];
  mkdirSync(join(m.dir, 'commands'), { recursive: true });
  writeFileSync(join(m.dir, 'commands', 'insert_table.sql'), 'INSERT INTO tables_table (id) VALUES (:id);\n');
  writeFileSync(join(m.dir, 'commands', 'session_open.sql'), 'INSERT INTO tables_session (id) VALUES (:id);\n');
  m.manifest.commands['tables._session_open'].sql = ['commands/session_open.sql'];
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest, null, 2));
  writeContractsFile(m.dir, m.manifest); // ADR-0127: validate requires .erplora/contracts.json

  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    await validate(m.dir); // green: a warning must not fail the gate
  } finally {
    console.warn = original;
    m.clean();
  }
  assert.ok(
    warned.some((w) => /handler-permission-ceiling/.test(w) && /tables\._insert_table/.test(w)),
    `the crossing was not printed; got: ${JSON.stringify(warned)}`,
  );
});
