// The battery that reads `migrations.postgres` as if it were a list of strings (module-toolkit#180).
//
// A module's Postgres batteries stand their own database up by walking the manifest by hand:
//
//     for rel in MANIFEST["migrations"]["postgres"]:
//         psql(db, (MODULE_DIR / rel).read_text())
//
// That loop only knows the string form. The runtime accepts two (`MigrationEntry`, hub#542), and
// the object one — `{ "file", "kind", "since" }` — is the ONLY way to declare a `contract`, i.e. a
// legitimate `DROP`. The day a module declares one, every battery with the old loop dies before
// testing anything:
//
//     TypeError: unsupported operand type(s) for /: 'PosixPath' and 'dict'
//
// It has already happened twice in one pull request: ERPlora/appointments#115 had to touch 15
// batteries to land its `contract` migration, and while it was open ERPlora/appointments#114 merged
// a BRAND NEW battery copied from an old one, with the old loop. Neither PR had a textual conflict,
// both were `MERGEABLE`, and #115's CI went red on the merge ref. Nobody saw it until review.
//
// Measured over `origin/main` of the 27 module repos on 2026-09-05
// (`~/.erplora/fleet/logs/178/loop-sweep`): 57 old-form loops in 14 modules — which is why the
// verdict is a WARNING. Not one of them is in a module that already uses the object form, so the
// ERROR arm below reddens nobody today: it is a pure ratchet over the next `contract`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryMigrationLoops, checkBatteryMigrations } from '../src/validate-battery-migrations.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The loop exactly as ERPlora/appointments#114 merged it (`recurring_activation.postgres.test.py`). */
const OLD_LOOP = `def check_against_postgres() -> None:
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for rel in MANIFEST.get("migrations", {}).get("postgres", []):
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        seed_series("r1", HUB)
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}"'])
`;

/** The same loop after ERPlora/appointments#115 normalised it. */
const NORMALISED = `def check_against_postgres() -> None:
    for entry in MANIFEST.get("migrations", {}).get("postgres", []):
        rel = entry if isinstance(entry, str) else entry["file"]
        psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
`;

// ---------------------------------------------------------------------------------------------
// 1. The detector — catch the positive, pass the good one.
// ---------------------------------------------------------------------------------------------

test('the loop that reads a migration entry as a path, unnormalised, is found', () => {
  const found = batteryMigrationLoops(OLD_LOOP);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].variable, 'rel');
  assert.equal(found[0].line, 4, 'names the line of the `for`');
});

test('the normalised loop is left alone — `isinstance` is the whole fix', () => {
  assert.deepEqual(batteryMigrationLoops(NORMALISED), []);
});

test('`entry["file"]` inside the body normalises just as well', () => {
  const src = `for entry in MANIFEST["migrations"]["postgres"]:
    psql([], db=DB, stdin=(MODULE_DIR / entry["file"]).read_text())
`;
  assert.deepEqual(batteryMigrationLoops(src), []);
});

test('a comprehension that already mapped the entries is not a finding', () => {
  const src = `rels = [e["file"] if isinstance(e, dict) else e for e in MANIFEST["migrations"]["postgres"]]
for rel in rels:
    psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
`;
  assert.deepEqual(batteryMigrationLoops(src), []);
});

test('a helper applied to the entry is a normalisation too', () => {
  const src = `rels = [migration_path(e) for e in MANIFEST["migrations"]["postgres"]]
for rel in rels:
    psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
`;
  assert.deepEqual(batteryMigrationLoops(src), []);
});

test('a loop that never uses the entry as a PATH is somebody else\'s business', () => {
  const src = `for entry in MANIFEST["migrations"]["postgres"]:
    print(entry)
`;
  assert.deepEqual(batteryMigrationLoops(src), [], 'nothing here breaks on the object form');
});

test('the path use is found however the battery spells it', () => {
  for (const use of [
    'psql([], stdin=(MODULE_DIR / rel).read_text())',
    'sql = open(rel).read()',
    'sql = open(os.path.join(MODULE_DIR, rel)).read()',
    'sql = Path(MODULE_DIR, rel).read_text()',
  ]) {
    const src = `for rel in MANIFEST["migrations"]["postgres"]:\n    ${use}\n`;
    assert.equal(batteryMigrationLoops(src).length, 1, `missed: ${use}`);
  }
});

test('a loop over ANOTHER manifest list is not this rule\'s business', () => {
  const src = `for rel in MANIFEST["seed"]["files"]:
    psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
`;
  assert.deepEqual(batteryMigrationLoops(src), []);
});

test('the loop is not read out of a comment or a docstring', () => {
  const src = `# for rel in MANIFEST["migrations"]["postgres"]:
#     psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
def f():
    """Old shape, kept as prose:
    for rel in MANIFEST["migrations"]["postgres"]:
        psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
    """
    return None
`;
  assert.deepEqual(batteryMigrationLoops(src), []);
});

test('the body ends where the loop ends — a path use AFTER it is not the loop\'s', () => {
  const src = `for rel in MANIFEST["migrations"]["postgres"]:
    print(rel)
sql = (MODULE_DIR / rel).read_text()
`;
  assert.deepEqual(batteryMigrationLoops(src), [], 'the dedented line is outside the loop');
});

test('two old loops in one battery are two findings', () => {
  assert.equal(batteryMigrationLoops(OLD_LOOP + '\n' + OLD_LOOP).length, 2);
});

// ---------------------------------------------------------------------------------------------
// 2. The verdict — WARN while the catalogue is string-only, ERROR the day it is not.
// ---------------------------------------------------------------------------------------------

/** A throwaway module dir with the given `tests/` files and migration entries. */
function moduleDir(entries, files) {
  const dir = mkdtempSync(join(tmpdir(), 'battery-migrations-'));
  mkdirSync(join(dir, 'tests'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, 'tests', name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }
  return { dir, manifest: { id: 'mymod', migrations: { postgres: entries } } };
}

test('with a string-only manifest the old loop is a WARNING, never a red gate', () => {
  const { dir, manifest } = moduleDir(['migrations/postgres/001_init.sql'], {
    'flow.postgres.test.py': OLD_LOOP,
  });
  try {
    const { errors, warnings } = checkBatteryMigrations(dir, manifest);
    assert.deepEqual(errors, [], 'nothing published may go red for a bug it does not have yet');
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /tests\/flow\.postgres\.test\.py/, 'names the file');
    assert.match(warnings[0], /:4\b/, 'and the line');
    assert.match(warnings[0], /isinstance/, 'and the shape of the fix');
    assert.match(warnings[0], /ERPLORA_MIGRATION_FILES/, 'and the list `erplora test` already hands it');
    assert.match(warnings[0], /battery-migrations/, 'tagged like every other check of this door');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the day the module declares an object entry the SAME loop is an ERROR — it is already broken', () => {
  const { dir, manifest } = moduleDir(
    [
      'migrations/postgres/001_init.sql',
      { file: 'migrations/postgres/008_retire.sql', kind: 'contract', since: '1.1.63' },
    ],
    { 'flow.postgres.test.py': OLD_LOOP },
  );
  try {
    const { errors, warnings } = checkBatteryMigrations(dir, manifest);
    assert.deepEqual(warnings, []);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /008_retire\.sql/, 'names the entry that breaks it');
    assert.match(errors[0], /TypeError/, 'and what the battery dies with');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a normalised battery is green whichever form the manifest uses', () => {
  for (const entries of [
    ['migrations/postgres/001_init.sql'],
    [{ file: 'migrations/postgres/008_retire.sql', kind: 'contract' }],
  ]) {
    const { dir, manifest } = moduleDir(entries, { 'flow.postgres.test.py': NORMALISED });
    try {
      assert.deepEqual(checkBatteryMigrations(dir, manifest), { errors: [], warnings: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('helpers under tests/ count too — a battery that imports one inherits its loop', () => {
  const { dir, manifest } = moduleDir(['migrations/postgres/001_init.sql'], {
    'harness.py': OLD_LOOP,
  });
  try {
    const { warnings } = checkBatteryMigrations(dir, manifest);
    assert.equal(warnings.length, 1, 'a shared helper is where the loop gets copied FROM');
    assert.match(warnings[0], /tests\/harness\.py/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a module with no tests/ at all is not a finding', () => {
  const { dir, manifest } = moduleDir(['migrations/postgres/001_init.sql'], {});
  try {
    assert.deepEqual(checkBatteryMigrations(dir, manifest), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
