// Tenancy gate over a module's declared SQL (module-toolkit#80).
//
// The runtime injects `:hub_id` as a BIND and nothing else: `system_params` (kernel contract,
// `crates/runtime/src/lib.rs`) puts `hub_id`, `current_user_id`, `now`… into the parameter map,
// and the list engine adds search/sort/pagination — never a tenancy predicate and never a column.
// Everything else is the module's SQL. So a statement that does not NAME `hub_id`:
//
//   - on an INSERT, leaves the `NOT NULL` column empty → the command fails in EVERY hub with a raw
//     sqlx error the merchant sees;
//   - on a SELECT/UPDATE/DELETE, reaches rows of other hubs wherever the database is shared.
//
// No gate we had could see it. The SQL PREPAREs perfectly, so `validate --pg` is green; `erplora
// dev` answers `ok:true` from a mock that never runs SQL; `pack`/`sign` do not read semantics. The
// hole opens the first time a customer's hub EXECUTES the statement — which is how `erplora g
// module` shipped a scaffold whose only write path was broken from birth.
//
// Why a guard and not just the fixed template: the template stops the module the scaffold writes,
// not the next one written by hand, generated with `erplora g command`, or copy-pasted from a
// module whose table has no `hub_id`. Root CLAUDE.md, "cero regresiones": when the incident is a
// PATTERN that can reappear in any new file, the fix carries the rule into the validator.
//
// The rule deliberately UNDER-covers rather than risk a false positive: it only judges tables THIS
// module declares (a table of a `depends_on` module is somebody else's contract, and guessing at it
// would block the published catalogue), and it accepts any statement that mentions `:hub_id`
// instead of trying to prove the predicate is the right one. Proving that needs a real parser; the
// cheap version already catches the whole family of holes seen in the wild, and blocks nothing that
// the 27 published modules do today (swept on `origin/main`, 01/09/2026: zero findings).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments, splitStatements } from './validate-migration-guard.mjs';
import { migrationFiles } from './validate-migrations.mjs';

/** The tenancy column every module table carries by contract (ARQUITECTURA.md §2.5). */
const HUB_COLUMN = 'hub_id';

/**
 * Splits a parenthesised body on the commas that are at depth 0, so a `NUMERIC(10, 2)` or a
 * `CHECK (a IN ('x','y'))` inside a column definition does not cut it in half.
 */
function topLevelParts(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (const ch of body) {
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The body between the outermost parentheses starting at `from`, or null when unbalanced. */
function parenBody(text, from) {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * Tables declared by this SQL that carry a `hub_id` column — the ones the rule applies to.
 *
 * Only a column DEFINITION counts: a `REFERENCES other(hub_id)` names somebody else's column, and
 * reading it as one of ours would scope a table that has no such column and reject correct SQL.
 */
export function hubScopedTables(sql) {
  const clean = stripComments(sql);
  const scoped = new Set();

  for (const statement of splitStatements(clean)) {
    const text = stripComments(statement).trim();

    const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)/i.exec(text);
    if (create) {
      const body = parenBody(text, create.index + create[0].length);
      if (body == null) continue;
      const declaresHub = topLevelParts(body).some((part) => {
        const first = part.split(/[\s(]+/)[0]?.toLowerCase();
        return first === HUB_COLUMN;
      });
      if (declaresHub) scoped.add(create[1].toLowerCase());
      continue;
    }

    const alter =
      /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(
        text,
      );
    if (alter && alter[2].toLowerCase() === HUB_COLUMN) scoped.add(alter[1].toLowerCase());
  }

  return [...scoped];
}

/** Does the statement mention the `:hub_id` bind? `::` is the cast operator, never a bind. */
function bindsHubId(statement) {
  return /(^|[^:]):hub_id\b/i.test(statement);
}

/** The scoped tables this statement names, as whole words (`demo_items_archive` is not `demo_items`). */
function scopedTablesTouched(statement, scoped) {
  return scoped.filter((t) => new RegExp(`(^|[^A-Za-z0-9_.]) ?${t}\\b`, 'i').test(` ${statement}`));
}

/**
 * INSERTs of this statement into a scoped table whose explicit column list omits `hub_id`.
 * An `INSERT INTO t VALUES …` / `INSERT INTO t SELECT …` carries no list to inspect and falls
 * through to the `:hub_id` rule instead.
 */
function insertsMissingHubColumn(statement, scoped) {
  const out = [];
  const re = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_.]*)\s*\(/gi;
  let m = re.exec(statement);
  while (m) {
    const table = m[1].toLowerCase();
    if (scoped.includes(table)) {
      const body = parenBody(statement, m.index + m[0].length - 1);
      const columns = body == null ? [] : topLevelParts(body).map((c) => c.replace(/"/g, '').toLowerCase());
      if (body != null && !columns.includes(HUB_COLUMN)) out.push(table);
    }
    m = re.exec(statement);
  }
  return out;
}

/** Every SQL fragment a `sql` field declares, as `{sql, where}`. */
function sqlEntries(value, dir, label) {
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    if (item.endsWith('.sql')) {
      const abs = join(dir, item.trim());
      if (!existsSync(abs)) continue; // file existence is another gate's job
      out.push({ sql: readFileSync(abs, 'utf8'), where: item.trim() });
    } else {
      out.push({ sql: item, where: `${label} (SQL en el manifest)` });
    }
  }
  return out;
}

/**
 * Tenancy errors in the SQL a manifest declares. Returns `{ errors, warnings }` — the shape the
 * other `erplora validate` checks use.
 */
export function checkHubScope(dir, manifest) {
  const errors = [];
  const warnings = [];

  const scoped = new Set();
  for (const rel of migrationFiles(manifest, 'postgres')) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    for (const t of hubScopedTables(readFileSync(abs, 'utf8'))) scoped.add(t);
  }
  if (scoped.size === 0) return { errors, warnings };
  const tables = [...scoped];

  for (const coll of ['queries', 'commands']) {
    const declared = manifest?.[coll];
    if (!declared || typeof declared !== 'object') continue;

    for (const [name, def] of Object.entries(declared)) {
      if (!def || def.sql == null) continue;

      for (const { sql, where } of sqlEntries(def.sql, dir, `${coll}.${name}`)) {
        for (const raw of splitStatements(sql)) {
          const statement = stripComments(raw).trim();
          if (!statement) continue;

          const touched = scopedTablesTouched(statement, tables);
          if (touched.length === 0) continue;

          const missing = insertsMissingHubColumn(statement, tables);
          if (missing.length) {
            errors.push(
              `${coll}.${name} (${where}): el INSERT en \`${missing.join('`, `')}\` no escribe la ` +
                'columna `hub_id`, y la tabla la declara `NOT NULL` → el command falla en TODOS los ' +
                'hubs con `null value in column "hub_id" … violates not-null constraint`. El runtime ' +
                'inyecta el BIND `:hub_id`, no la columna: nómbrala tú. ' +
                'Ej.: `INSERT INTO tabla (id, hub_id, …) VALUES (:id, :hub_id, …)`. ' +
                'Ojo: PREPARA bien, así que `validate --pg` no lo ve y `dev` lo enmascara.',
            );
            continue;
          }

          if (!bindsHubId(statement)) {
            errors.push(
              `${coll}.${name} (${where}): la sentencia toca \`${touched.join('`, `')}\` (tabla con ` +
                '`hub_id`) y no acota por `:hub_id` → en una BD compartida lee o escribe filas de ' +
                'OTROS hubs. Añade `WHERE hub_id = :hub_id` (el runtime inyecta el bind; el motor de ' +
                'listas aplica búsqueda/orden/paginación, nunca el filtro de tenancy).',
            );
          }
        }
      }
    }
  }

  return { errors, warnings };
}
