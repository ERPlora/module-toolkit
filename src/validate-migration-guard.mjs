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
//      `DELETE FROM`/`SET NOT NULL`, `backfill` admits no DDL, and `contract` admits the `DROP`s
//      the runtime TRANSLATES — but not `TRUNCATE`/`DELETE FROM`, which destroy rows there is no
//      translation for (ERPlora/hub#1145), and not a `DROP` that names more than one thing in one
//      statement, because the translation is one statement in, one statement out.
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
    } else if (ch === '$' && dollarTagLength(sql, i) !== null) {
      // Dollar-quoting (ERPlora/hub#1149): sin esto el `;` de dentro de un `DO $$ … $$` parte el
      // bloque y los inspectores deciden sobre trozos de algo que ya no es la sentencia que
      // Postgres va a ejecutar. El cuerpo se copia verbatim: aquí solo se decide dónde ACABA.
      const len = dollarTagLength(sql, i);
      const tag = sql.slice(i, i + len);
      current += tag;
      i += len - 1;
      while (i + 1 < sql.length) {
        if (sql.startsWith(tag, i + 1)) {
          current += tag;
          i += tag.length;
          break;
        }
        i += 1;
        current += sql[i];
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
 * Length of the `$…$` delimiter starting at `at`, or `null` when it is not one (ERPlora/hub#1149).
 *
 * A Postgres tag is `$`, an optional identifier (letter or `_` first, digits allowed after) and a
 * closing `$`. Checking it is what separates `$$`/`$body$` — which open a body — from a `$1` or a
 * lone `$` in a price, which open nothing. Mirror of `migration_guard.rs::dollar_tag_len`.
 */
export function dollarTagLength(sql, at) {
  if (sql[at] !== '$') return null;
  for (let j = at + 1; j < sql.length; j += 1) {
    const c = sql[j];
    if (c === '$') return j + 1 - at;
    const isFirst = j === at + 1;
    const ok = /[A-Za-z_]/.test(c) || (!isFirst && /[0-9]/.test(c));
    if (!ok) return null;
  }
  return null;
}

/**
 * The procedural construct the statement opens, if any (ERPlora/hub#1149).
 *
 * Only `DO` and `CREATE [OR REPLACE] FUNCTION`/`PROCEDURE`: the three shapes that carry a body this
 * door cannot read. A lone `$…$` does NOT count — `VALUES ($$hola$$)` is a perfectly readable
 * literal, and refusing it would be a false positive, which here means a module left uninstalled.
 *
 * Mirror of `migration_guard.rs::procedural_construct`.
 */
export function proceduralConstruct(statement) {
  const tokens = stripComments(statement)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^[^A-Z0-9_]+|[^A-Z0-9_]+$/g, ''));

  if (tokens[0] === 'DO') return 'DO';
  if (tokens[0] === 'CREATE') {
    let j = 1;
    while (tokens[j] === 'OR' || tokens[j] === 'REPLACE') j += 1;
    if (tokens[j] === 'FUNCTION') return 'CREATE FUNCTION';
    if (tokens[j] === 'PROCEDURE') return 'CREATE PROCEDURE';
  }
  return null;
}

/**
 * Splits the way the DEPLOYED fleet's guard splits: on every `;`, respecting string literals but
 * NOT comments. This is `migration_guard.rs::split_statements` as it exists in `v1.1.0`…`v1.1.7`
 * (`v1.1.8` already carries the fix — its file is byte for byte the one on `develop`).
 */
function legacySplitStatements(sql) {
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
 * The tables an older hub would think this file touches BECAUSE a `;` inside a comment cut a
 * statement in half — and only those (#70).
 *
 * 🔴 THE PRECISION HERE IS THE WHOLE POINT, and the first version of this check got it wrong.
 * Flagging every `;` inside a comment sounds right and is not: measured over the 123 migrations
 * published by the module repos, **82** carry one and **none** of them breaks anything. Shipping
 * that rule would have turned ~20 module repos red for a hazard they do not have — the expensive
 * direction, the one that keeps correct modules from ever publishing.
 *
 * What actually breaks is narrower. The migration is EXECUTED whole (`migrations.rs`:
 * `Plan::AsWritten => db.execute_batch(&sql)`), and Postgres understands `--` perfectly, so the
 * `;` never breaks execution. The split is used only by the GUARD, to check table scope. So the
 * file is rejected only when the half-statement left after the cut happens to read as a statement
 * touching a table that is not the module's — which is exactly how `printing/002_jobs.sql` was
 * rejected for «touching `is`», a word out of the prose «-- read); this table is …».
 *
 * Reported only when the CORRECT splitter does not see the same problem: what is wrong regardless
 * of the comment is somebody else's error message, not this one's.
 */
export function tablesInventedByCommentSplit(moduleId, sql) {
  const offending = (split) =>
    split(sql)
      .flatMap((statement) => tablesTouched(statement))
      .filter((t) => t.startsWith('hub_') || t.startsWith('_') || !t.startsWith(`${moduleId}_`));

  const correct = new Set(offending(splitStatements));
  return [...new Set(offending(legacySplitStatements).filter((t) => !correct.has(t)))];
}

/**
 * The table names the statement touches. Deliberately SIMPLE: it recognises the shapes a migration
 * really uses and, in doubt, invents nothing — what it does not recognise does not block, because a
 * false positive here leaves a module uninstalled.
 *
 * A `SET` right after an anchor is a keyword, never a table, so an `ON CONFLICT … DO UPDATE SET …`
 * upsert anchors nothing besides its `INTO` (#72). This WAS a deliberate divergence: the runtime's
 * `tables_touched` read that `SET` as a table and refused the upsert at install, so this door
 * passed what every hub rejected. ERPlora/hub#1109 fixed it there, and the two doors say the same
 * thing again — which is the only state in which a green gate means an installable module.
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
      // `SET` after an anchor is never a table: in `ON CONFLICT … DO UPDATE SET col = …` (#72) the
      // `UPDATE` of the upsert carries no table at all, and reading the keyword as one rejected
      // EVERY upsert — the canonical way to seed idempotent reference data. A table called `set`
      // cannot exist under the module contract anyway (it would have to start `<module_id>_`), so
      // skipping it can never mask a real violation.
      if (nextUpper === 'SET') break;
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

/**
 * The verb that destroys ROWS, if the statement carries one — what a `contract` may not contain
 * (ERPlora/hub#1145).
 *
 * Only `TRUNCATE` and `DELETE FROM`, and on purpose: they are what a `contract` cannot TRANSLATE.
 * `DROP TABLE`/`DROP COLUMN` are set aside as `_deprecated_*`, and `DROP CONSTRAINT` does not touch
 * a single row — one of the four published `contract` migrations is exactly that, an atomic
 * constraint swap — so putting them here would turn correct, already-published work red.
 *
 * Compares WHOLE TOKENS, not substrings: `includes('TRUNCATE')` matches a column named
 * `truncate_at`, and a false positive here keeps a correct module from publishing. For the same
 * reason `DELETE` only counts with `FROM` behind it — `ON DELETE CASCADE` is a constraint, not a
 * deletion — and it is read token by token instead of searching for the phrase `'DELETE FROM'`,
 * which a line break would split.
 */
export function rowDestroyingVerb(statement) {
  const tokens = stripComments(statement)
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.replace(/^[^A-Z0-9_]+|[^A-Z0-9_]+$/g, ''));
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'TRUNCATE') return 'TRUNCATE';
    if (tokens[i] === 'DELETE' && tokens[i + 1] === 'FROM') return 'DELETE FROM';
  }
  return null;
}

/**
 * What the statement retires, when it retires MORE THAN ONE of them at once (ERPlora/hub#1145).
 *
 * `DROP TABLE a, b;` is valid SQL, but `ALTER TABLE … RENAME TO` takes a SINGLE table, so a list
 * would have to come out as N statements. While the runtime took the first name, what got executed
 * was `ALTER TABLE a, RENAME TO _deprecated_a,` — a `syntax error at or near ","` explaining
 * nothing, with `b` left un-retired on top. The same crack on the column side: an `ALTER` carrying
 * more than one action put the comma inside the `RENAME`.
 *
 * This is the ONE piece of the rewrite half this door ports, and only its verdict, never its
 * output: whether the hub accepts the file is precisely this door's job.
 */
export function dropsMoreThanOne(statement) {
  const sql = stripComments(statement).trim();
  const upper = sql.toUpperCase();
  const withoutTrailer = sql.replace(/;\s*$/, '');
  if (upper.includes(' DROP COLUMN ')) {
    return withoutTrailer.includes(',') ? 'columna' : null;
  }
  if (upper.startsWith('DROP TABLE ')) {
    const named = withoutTrailer.slice('DROP TABLE '.length).trim();
    // `DROP TABLE t CASCADE` carries no comma and is still one table: the `CASCADE` falls away on
    // its own when renaming, because renaming drags nobody along.
    return named.includes(',') ? 'tabla' : null;
  }
  return null;
}

/**
 * The column a `contract` retires with `DROP COLUMN IF EXISTS`, or `null`.
 *
 * A COMPATIBILITY rule, like #70: it is judged with the hub the CUSTOMER runs, not the one on
 * `develop`. Every hub up to ERPlora/hub#2108 rewrites it to `RENAME COLUMN IF EXISTS c TO
 * _deprecated_c`, which Postgres rejects, so the module never updates there (module-toolkit#329).
 * The guard on the TABLE (`ALTER TABLE IF EXISTS t …`, `DROP TABLE IF EXISTS t`) survives the
 * rewrite as valid SQL and is not this rule's business. Retire the rule once the whole fleet runs a
 * hub with that fix.
 */
export function columnDropGuardedByIfExists(statement) {
  const found = /\bDROP\s+COLUMN\s+IF\s+EXISTS\s+("?[\w$]+"?)/i.exec(stripComments(statement));
  return found ? found[1] : null;
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

  // 🔴 Lo que no se puede LEER, no entra (ERPlora/hub#1149). Va lo PRIMERO y devuelve solo esto: si
  // no, el autor vería además la queja del splitter viejo sobre un bloque que de todas formas no
  // puede publicar, y lo que hay que decirle es que ahí dentro no se puede afirmar nada.
  for (const statement of splitStatements(sql)) {
    const construct = proceduralConstruct(statement);
    if (construct) {
      return [
        `${filename}: la migración contiene un \`${construct}\`, y el cuerpo de un bloque ` +
          'procedimental es opaco para esta puerta: dentro cabe un `EXECUTE` que arma la sentencia ' +
          'en tiempo de ejecución, así que no se puede afirmar ni qué tablas toca ni si destruye ' +
          'filas. Escribe la migración como sentencias SQL sueltas, que es lo que sí se puede leer',
      ];
    }
  }

  const errors = [];
  // Checked on the RAW file, before anything is split: this is not about what the SQL MEANS, it is
  // about an older hub being unable to cut the file correctly (#70).
  const invented = tablesInventedByCommentSplit(moduleId, sql);
  if (invented.length) {
    errors.push(
      `${filename}: un \`;\` dentro de un comentario parte el fichero en dos para los hubs pineados a ` +
        `\`v1.1.0\`…\`v1.1.7\`, y el trozo que queda se lee como una sentencia que toca ` +
        `${invented.map((t) => `\`${t}\``).join(', ')} — que no es del módulo. Esos hubs RECHAZAN la ` +
        'instalación entera (es como se rechazó `printing/002_jobs.sql` por «tocar `is`», una palabra ' +
        'de la prosa). `v1.1.8` ya lo parte bien, pero un módulo publicado hoy tiene que instalarse ' +
        'en los hubs que YA están ahí fuera. Quita el `;` del comentario (un `.` o un guion sirven).',
    );
  }

  for (const statement of splitStatements(sql)) {
    for (const table of tablesTouched(statement)) {
      if (table.startsWith('hub_') || table.startsWith('_')) {
        return [
          ...errors,
          `${filename}: la migración toca \`${table}\`: \`hub_*\` y \`_*\` son del sistema, no de un módulo`,
        ];
      }
      if (!table.startsWith(`${moduleId}_`)) {
        return [
          ...errors,
          `${filename}: la migración toca \`${table}\`, que no pertenece a \`${moduleId}\`. ` +
            `Una tabla de módulo empieza por \`${moduleId}_\``,
        ];
      }
    }

    if (kind === 'expand') {
      const found = destructiveVerb(statement);
      if (found) {
        return [
          ...errors,
          `${filename}: la migración se declara \`expand\` pero contiene \`${found}\`. ` +
            'Si es intencionado, declárala `contract` en el manifest ' +
            `(\`{ "file": "${filename}", "kind": "contract", "since": "<versión>" }\`); si no, sobra`,
        ];
      }
    } else if (kind === 'contract') {
      const destroyed = rowDestroyingVerb(statement);
      if (destroyed) {
        return [
          ...errors,
          `${filename}: la migración se declara \`contract\` pero contiene \`${destroyed}\`, que ` +
            'DESTRUYE FILAS sin vuelta atrás. Un `contract` retira ESTRUCTURA y el runtime la aparta ' +
            'a `_deprecated_*`; de las filas no hay nada que apartar. Si de verdad hay que ' +
            'limpiarlas, va en una migración `backfill`, que es donde el DML tiene su sitio',
        ];
      }
      const guarded = columnDropGuardedByIfExists(statement);
      if (guarded) {
        return [
          ...errors,
          `${filename}: la migración \`contract\` retira la columna \`${guarded}\` con ` +
            '`DROP COLUMN IF EXISTS`, y los hubs desplegados hoy la apartan con un ' +
            '`RENAME COLUMN IF EXISTS` que Postgres no acepta: la actualización del módulo falla en ' +
            'cada arranque (ERPlora/hub#2108). Escribe `DROP COLUMN ' +
            `${guarded}\` sin \`IF EXISTS\`: es la forma que todos los hubs traducen bien`,
        ];
      }
      const many = dropsMoreThanOne(statement);
      if (many) {
        return [
          ...errors,
          `${filename}: la migración \`contract\` retira más de una ${many} en la misma sentencia, ` +
            'y la traducción a `RENAME` es de una sentencia a una sentencia: ' +
            `\`${stripComments(statement).trim()}\`. Escribe una ${many} por sentencia`,
        ];
      }
    } else if (kind === 'backfill') {
      const found = ddlVerb(statement);
      if (found) {
        return [
          ...errors,
          `${filename}: la migración se declara \`backfill\` pero contiene \`${found}\`. ` +
            'Un backfill es DML idempotente sobre tablas propias; si cambia el esquema, es un `expand`',
        ];
      }
    }
  }
  return errors;
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
