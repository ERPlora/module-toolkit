// The runtime's migration guard, brought forward to the author's door (module-toolkit#51).
//
// The hub refuses a migration on install for two reasons — and until now `erplora validate` looked
// at NEITHER, so a module published GREEN and did not install. On 2026-08-19 a sweep of the 117
// published migrations with the guard of the tag the fleet runs rejected four, all published the
// day before, all green on their gate; each one left its module uninstalled on new hubs and rolled
// back where it was already installed, and `customers` dragged four dependent modules with it.
//
// The two rules, verbatim from `hub/crates/runtime/src/migration_guard.rs`:
//
//   1. **the table belongs to the module** — prefix `<module_id>_`, never `hub_*` nor `_*`;
//   2. **the SQL matches the declared `kind`** — `expand` admits no `DROP`/`TRUNCATE`/
//      `DELETE FROM`/`SET NOT NULL`, `backfill` admits no DDL, `contract` admits everything.
//
// 🔴 WHY A PORT AND NOT A CALL. The runtime is Rust and lives in a checkout the gate of the 25
// module repos does not have. But the deeper reason is that the fix cannot depend on WHICH IMAGE
// each hub runs: three of the four rejections were the hub's own bug (hub#1027 — the splitter cut
// on a `;` inside a `--` comment and read the next word as a foreign table), it is fixed in
// `develop` and in NO tag, and the fleet runs tags. Checking before publishing is the only defence
// that holds across 25 hubs on different images.
//
// 🔴 WHAT THIS IS NOT. Not a SQL parser, and it does not try to be: it is a LINT over the text,
// mirroring the runtime token for token so the two doors say the same thing. Where the runtime is
// deliberately lax (an `ON` outside a `CREATE INDEX`, a `FROM` in a `SELECT`) this is lax too — a
// false positive here does not annoy anyone, it BLOCKS a correct module, which is worse than the
// problem being solved.
//
// Mirror alarm: `test/canonical-mirrors.test.mjs` fails the moment `GRANDFATHERED` here and in the
// hub diverge.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationEntries } from './validate-migrations.mjs';

/** What a module may declare its migration does. A bare path is read as `expand`. */
export const KINDS = ['expand', 'backfill', 'contract'];

/**
 * What is ALREADY published and would not meet today's contract.
 *
 * Rewriting history is not an option: `_hub_migrations` records by FILE NAME, so touching an
 * already-applied `.sql` re-runs nothing where it is applied and does break where it is not.
 *
 * 🔴 This list may only SHRINK. A test fails the moment it grows — it is the only thing keeping
 * "grandfather it" from becoming the way to keep publishing what the contract forbids. And the pass
 * is per FILE, not per module: a new migration of the same module inherits nothing.
 */
export const GRANDFATHERED = [
  ['tables', 'migrations/postgres/007_session_history_fk.sql'], // DROP CONSTRAINT
  ['sales', 'migrations/postgres/011_sale_forgets_table.sql'], // DROP COLUMN
  ['sales', 'migrations/postgres/013_drop_legacy_cart.sql'], // DROP TABLE
  ['taxes', 'migrations/postgres/003_backfill_es_vat_baseline.sql'], // touches `_taxes_backfill_hubs`
  ['verifactu', 'migrations/postgres/006_drop_cert_columns.sql'], // DROP COLUMN
  ['verifactu', 'migrations/postgres/009_drop_auto_transmit.sql'], // DROP COLUMN
  ['pricing', 'migrations/postgres/004_price_list_item_tenant_fk.sql'], // DROP CONSTRAINT
  ['services', 'migrations/postgres/002_tax_rate_id.sql'], // DROP COLUMN
  ['services', 'migrations/postgres/004_discount_split.sql'], // DROP COLUMN
];

function isGrandfathered(moduleId, filename) {
  return GRANDFATHERED.some(([m, f]) => m === moduleId && f === filename);
}

/**
 * Drops SQL comments before anything is read.
 *
 * Without this the WORDS of a comment are read as table names. Measured against the published
 * modules: `-- … the …`, `-- … for …`, `-- … now …` produced five rejections of perfectly correct
 * migrations. A string literal is opaque and is kept: `'a--b'` is data, not a comment.
 */
export function stripComments(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
    } else if (ch === '-' && sql[i + 1] === '-') {
      i += 1;
      while (i + 1 < sql.length && sql[i + 1] !== '\n') i += 1;
      if (i + 1 < sql.length) {
        out += '\n';
        i += 1;
      }
    } else if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i - 1] === '*' && sql[i] === '/')) i += 1;
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Splits on `;` respecting literals AND comments.
 *
 * This is the bug that cost the day (hub#1027): `printing/002_jobs.sql` carries «-- read); this
 * table is …» in its header, the splitter cut mid-comment, the tail lost its `--`, and «table is»
 * read as a table `is` that «does not belong to printing» — a published, correct module that would
 * not install. The comment is KEPT inside the statement; removing it is `stripComments`'s job, at
 * inspection time.
 */
export function splitStatements(sql) {
  const out = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '-' && sql[i + 1] === '-') {
      current += ch;
      i += 1;
      current += sql[i];
      while (i + 1 < sql.length) {
        i += 1;
        current += sql[i];
        if (sql[i] === '\n') break;
      }
    } else if (ch === '/' && sql[i + 1] === '*') {
      current += ch;
      i += 1;
      current += sql[i];
      while (i + 1 < sql.length) {
        i += 1;
        current += sql[i];
        if (sql[i - 1] === '*' && sql[i] === '/') break;
      }
    } else if (ch === ';') {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * The table names the statement touches. Deliberately SIMPLE: it recognises the shapes a migration
 * really uses and, in doubt, invents nothing — what it does not recognise does not block, because a
 * false positive here leaves a module uninstalled.
 */
export function tablesTouched(statement) {
  const clean = stripComments(statement);
  const head = clean.trimStart().toUpperCase();
  // `ON` only counts in `CREATE INDEX … ON <table>`: in a JOIN it is followed by a condition
  // (`a.id = b.id`), and taking that for a table name is a false positive.
  const creatingIndex = head.startsWith('CREATE INDEX') || head.startsWith('CREATE UNIQUE INDEX');
  const selecting = head.startsWith('SELECT');

  const tokens = clean.split(/\s+/).filter(Boolean);
  const found = [];
  const seen = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const upper = tokens[i].toUpperCase();
    const isAnchor =
      upper === 'TABLE' ||
      upper === 'INTO' ||
      upper === 'UPDATE' ||
      (upper === 'ON' && creatingIndex) ||
      (upper === 'FROM' && !selecting);
    if (!isAnchor) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const nextUpper = tokens[j].toUpperCase();
      if (['IF', 'NOT', 'EXISTS', 'ONLY'].includes(nextUpper)) continue;
      const name = tokens[j].replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, '').toLowerCase();
      if (name && !seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
      break;
    }
  }
  return found;
}

/** The destructive verb in the statement, if any — what an `expand` may not contain. */
export function destructiveVerb(statement) {
  const upper = stripComments(statement).toUpperCase();
  for (const verb of ['DROP COLUMN', 'DROP TABLE', 'DROP CONSTRAINT', 'TRUNCATE', 'DELETE FROM']) {
    if (upper.includes(verb)) return verb;
  }
  // `SET NOT NULL` on an EXISTING column admits no way back either: the previous binary inserted
  // without that field and would start failing. Inside a `CREATE TABLE` it IS additive (the table
  // is new), which is why it only counts in an `ALTER`.
  if (upper.trimStart().startsWith('ALTER TABLE') && upper.includes('SET NOT NULL')) {
    return 'SET NOT NULL';
  }
  return null;
}

/** The DDL verb the statement starts with, if any — what a `backfill` may not contain. */
export function ddlVerb(statement) {
  const upper = stripComments(statement).trimStart().toUpperCase();
  for (const verb of ['CREATE ', 'ALTER ', 'DROP ', 'TRUNCATE']) {
    if (upper.startsWith(verb)) return verb.trim();
  }
  return null;
}

/**
 * Reviews ONE migration exactly as the runtime will on install. Returns the errors (empty = it
 * installs). Never throws — that is `validate`'s decision.
 *
 * The rewrite half of the runtime's guard (`DROP COLUMN x` → `RENAME COLUMN x TO _deprecated_x`) is
 * deliberately NOT ported: this door only has to say whether the hub will accept the file, and
 * rewriting SQL nobody is going to execute would only be a second place to get it wrong.
 */
export function checkMigrationSql(moduleId, filename, sql, kind = 'expand') {
  if (!KINDS.includes(kind)) {
    return [
      `${filename}: kind \`${kind}\` desconocido — el runtime solo deserializa ${KINDS.map((k) => `\`${k}\``).join(', ')}, ` +
        'y un manifest con otro valor no llega ni a instalarse',
    ];
  }
  // A grandfathered file is applied as written: it is already in the fleet's databases, and the
  // contract cannot be applied retroactively without breaking exactly what it protects.
  if (isGrandfathered(moduleId, filename)) return [];

  for (const statement of splitStatements(sql)) {
    for (const table of tablesTouched(statement)) {
      if (table.startsWith('hub_') || table.startsWith('_')) {
        return [
          `${filename}: la migración toca \`${table}\`: \`hub_*\` y \`_*\` son del sistema, no de un módulo`,
        ];
      }
      if (!table.startsWith(`${moduleId}_`)) {
        return [
          `${filename}: la migración toca \`${table}\`, que no pertenece a \`${moduleId}\`. ` +
            `Una tabla de módulo empieza por \`${moduleId}_\``,
        ];
      }
    }

    if (kind === 'expand') {
      const found = destructiveVerb(statement);
      if (found) {
        return [
          `${filename}: la migración se declara \`expand\` pero contiene \`${found}\`. ` +
            'Si es intencionado, declárala `contract` en el manifest ' +
            `(\`{ "file": "${filename}", "kind": "contract", "since": "<versión>" }\`); si no, sobra`,
        ];
      }
    } else if (kind === 'backfill') {
      const found = ddlVerb(statement);
      if (found) {
        return [
          `${filename}: la migración se declara \`backfill\` pero contiene \`${found}\`. ` +
            'Un backfill es DML idempotente sobre tablas propias; si cambia el esquema, es un `expand`',
        ];
      }
    }
  }
  return [];
}

/**
 * The whole door: every migration the manifest declares, with the `kind` it declares (a bare path =
 * `expand`). Returns `{ errors, warnings }`; a file the manifest points at and the disk does not
 * have is left to `checkMigrations` (manifest↔disk parity), which is the check that owns it.
 */
export function checkMigrationGuard(dir, manifest) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };

  for (const entry of migrationEntries(manifest)) {
    if (typeof entry.file !== 'string' || !entry.file) continue;
    const abs = join(dir, entry.file);
    if (!existsSync(abs)) continue;
    let sql;
    try {
      sql = readFileSync(abs, 'utf8');
    } catch (e) {
      errors.push(`${entry.file}: no se pudo leer (${e.message})`);
      continue;
    }
    errors.push(...checkMigrationSql(moduleId, entry.file, sql, entry.kind));
  }
  return { errors, warnings };
}
