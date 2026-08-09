// Postgres compatibility guardrails (audit pm#16; updated after ADR-0154 + hub#210; holes closed
// in module-toolkit#32 after the 24-module sweep of pm#107).
//
// The family that killed 4 P0s in Hub Cloud (sector QA 07-16): constructs one engine tolerates and
// Postgres rejects. LEXICAL scanner (no AST parser; same philosophy as validate-sql.mjs), masking
// string literals and comments. Four rules, each with its `level`:
//
//   1) `multi-statement`        ERROR — a file of a command/query `sql[]` runs as ONE prepared
//      statement; PG refuses multi-statement ("cannot insert multiple commands"). Migrations take
//      another path and are exempt. (inventory#28)
//   2) `onconflict-unqualified` ERROR — inside `ON CONFLICT … DO UPDATE SET`, a self-reference to a
//      column of the target table must be QUALIFIED (`table.col` or `excluded.col`); unqualified it
//      is ambiguous in PG and the statement does not even parse. (appointments#19, reservations#19)
//   3) `boolean-case-obsolete`  WARNING — `CASE WHEN :param THEN …` / `WHEN NOT :param`. This used
//      to be the RECOMMENDED way to wrap flags; since ADR-0154 the runtime coerces `Json::Bool`→
//      INTEGER 0/1 at a single point (hub#210), so the bind arrives as a bigint and
//      `CASE WHEN <bigint>` BREAKS in PG ("argument of WHEN must be type boolean"). Pass the param
//      DIRECTLY (`SET flag = :param`).
//   4) `null-untyped`           ERROR — `:param IS [NOT] NULL`. PG fixes a parameter's type at its
//      FIRST appearance and `IS NULL` contributes none, so the statement fails to PREPARE with
//      42P08 ("could not determine data type of parameter") as soon as the bind arrives NULL — the
//      runtime sends a JSON null as `DynNull`, OID 0, precisely so the engine infers. Comparing the
//      same bind against a column further down does NOT save it. Fix: `CAST(:param AS TEXT)`, the
//      idiom that works in both dialects (ADR-0007). (tables#20, appointments#35, tasks#14)
//
// Rules 2 and 4 are what module-toolkit#32 fixed: rule 2 only saw `col = col + 1` (missing the
// `col = COALESCE(:p, col)` shape that every settings upsert uses) and rule 4 was a warning. Three
// of the four modules broken in production passed `erplora validate` green because of it.
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

/** Masks '…' literals and comments (--, block) for the lexical analysis. */
function mask(sql) {
  let s = sql.replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(m.length - 2) + "'");
  s = s.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return s;
}

/** Top-level statements of an already masked SQL (ignores trailing empty ';'). */
function statementCount(masked) {
  return masked.split(';').map((p) => p.trim()).filter(Boolean).length;
}

function readRel(dir, rel) {
  const p = isAbsolute(rel) ? rel : join(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Entries {sql, source} of a command/query `sql` value (.sql path | inline | array). */
function sqlEntries(dir, value, label) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    if (/\.sql$/i.test(item.trim())) {
      const sql = readRel(dir, item.trim());
      if (sql != null) out.push({ sql, source: item.trim() });
    } else {
      out.push({ sql: item, source: `module.json#${label}` });
    }
  }
  return out;
}

// ── rule 2: unqualified self-reference inside ON CONFLICT … DO UPDATE SET ────────────────────
//
// Why a scanner and not a regex: the shape that shipped broken is `col = COALESCE(:col, col)`, and
// a regex that splits the assignment list on commas cuts that expression in half — which is
// literally why `reservations` published 13 ambiguous columns with `validate` in green. Everything
// here works on the MASKED sql, so parentheses/commas inside literals are already gone.

/** Index just past `SET` of the `DO UPDATE SET` that follows `ON CONFLICT` at `from`, or -1. */
function doUpdateSetEnd(masked, from) {
  const re = /\bDO\s+UPDATE\s+SET\b/gi;
  re.lastIndex = from;
  const hit = re.exec(masked);
  if (!hit) return -1;
  // Must belong to the same statement as the ON CONFLICT.
  const semicolon = masked.indexOf(';', from);
  if (semicolon >= 0 && semicolon < hit.index) return -1;
  return hit.index + hit[0].length;
}

/**
 * The assignment list of a `DO UPDATE SET` that starts at `from`: splits on depth-0 commas and
 * stops at the depth-0 `;`, `WHERE` or `RETURNING` that ends it. Returns [{lhs, rhs, at}].
 */
function setAssignments(masked, from) {
  const parts = [];
  let depth = 0;
  let start = from;
  let i = from;
  const push = (end) => {
    const raw = masked.slice(start, end);
    if (raw.trim()) parts.push({ raw, at: start });
  };
  while (i < masked.length) {
    const c = masked[i];
    if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) break; // closing paren of an enclosing expression: the list ended
      depth--;
    } else if (depth === 0) {
      if (c === ';') break;
      if (c === ',') {
        push(i);
        start = i + 1;
        i++;
        continue;
      }
      const tail = masked.slice(i);
      const stop = /^\s(?:WHERE|RETURNING)\b/i.exec(tail) || (i === from && /^(?:WHERE|RETURNING)\b/i.exec(tail));
      if (stop) break;
    }
    i++;
  }
  push(i);

  const out = [];
  for (const { raw, at } of parts) {
    const eq = firstTopLevelEq(raw);
    if (eq < 0) continue;
    const lhs = raw.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(lhs)) continue; // multi-column `(a, b) = (…)`: out of scope
    out.push({ lhs, rhs: raw.slice(eq + 1), at: at + eq + 1 });
  }
  return out;
}

/** Index of the assignment `=` (depth 0, not part of `>=`/`<=`/`!=`/`<>`), or -1. */
function firstTopLevelEq(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '=' && depth === 0) {
      const prev = s[i - 1];
      if (prev === '>' || prev === '<' || prev === '!') continue;
      if (s[i + 1] === '=') continue;
      return i;
    }
  }
  return -1;
}

/** Columns listed in the `INSERT INTO <table> (…)` that opens the statement, plus the table name. */
function insertTarget(masked) {
  const hit = /\bINSERT\s+INTO\s+([A-Za-z_][\w$]*)\s*\(/i.exec(masked);
  if (!hit) return { table: null, columns: [] };
  const open = hit.index + hit[0].length - 1;
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) {
        const cols = masked
          .slice(open + 1, i)
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter((c) => /^[a-z_]\w*$/.test(c));
        return { table: hit[1], columns: cols };
      }
    }
  }
  return { table: hit[1], columns: [] };
}

/**
 * Bare identifiers of an expression: not qualified (`t.col`), not a qualifier (`t.`), not a bind
 * (`:col`) and not a function call (`coalesce(`). Those are the ones Postgres has to resolve on its
 * own — and inside a DO UPDATE they are ambiguous between the target row and `excluded`.
 */
function bareIdentifiers(expr) {
  const out = [];
  for (const hit of expr.matchAll(/(?<![\w.:$])([A-Za-z_]\w*)\b/g)) {
    const after = expr.slice(hit.index + hit[1].length);
    if (/^\s*\(/.test(after)) continue; // function call
    if (/^\s*\./.test(after)) continue; // qualifier of something else
    out.push({ name: hit[1], at: hit.index });
  }
  return out;
}

/**
 * Chequea las reglas PG sobre queries+commands del módulo (las migraciones van por otro camino).
 * Devuelve [{rule, level, message}] con `level` ∈ {'error','warning'}.
 */
export function checkPgCompat(dir, manifest) {
  const findings = [];

  for (const coll of ['queries', 'commands']) {
    for (const [name, def] of Object.entries(manifest?.[coll] ?? {})) {
      if (!def) continue;
      const entries = sqlEntries(dir, def.sql, `${coll}.${name}`);

      for (const { sql, source } of entries) {
        const m = mask(sql);

        // 1) multi-statement — ERROR
        const n = statementCount(m);
        if (n > 1) {
          findings.push({
            rule: 'multi-statement',
            level: 'error',
            message: `${source} — ${n} sentencias en un fichero de \`sql[]\`: PG lo ejecuta como UN prepared statement y lo rechaza («cannot insert multiple commands»). Trocea en un fichero por sentencia (mismo command = misma transacción).`,
          });
        }

        // 2) ON CONFLICT … DO UPDATE SET: any unqualified column of the target table — ERROR.
        //    The target's columns are the ones being assigned (an assignment LHS IS a column of the
        //    target table) plus the INSERT column list, which covers `col = other_col`.
        const { table, columns } = insertTarget(m);
        for (const oc of m.matchAll(/\bON\s+CONFLICT\b/gi)) {
          const setAt = doUpdateSetEnd(m, oc.index);
          if (setAt < 0) continue;
          const assignments = setAssignments(m, setAt);
          const targetCols = new Set([...columns, ...assignments.map((a) => a.lhs.toLowerCase())]);
          for (const { lhs, rhs } of assignments) {
            const seen = new Set();
            for (const { name: ident } of bareIdentifiers(rhs)) {
              const lower = ident.toLowerCase();
              if (!targetCols.has(lower) || seen.has(lower)) continue;
              seen.add(lower);
              const qualified = table ? `${table}.${ident}` : `<tabla>.${ident}`;
              findings.push({
                rule: 'onconflict-unqualified',
                level: 'error',
                message: `${source} — \`${lhs} = ${rhs.trim().slice(0, 60)}\`: la columna \`${ident}\` va SIN CUALIFICAR dentro de DO UPDATE — en PG es ambigua entre la fila destino y \`excluded\`, y la sentencia NO PARSEA («column reference "${ident}" is ambiguous»). Usa \`${qualified}\` o \`excluded.${ident}\`.`,
              });
            }
          }
        }

        // 3) `CASE WHEN :param THEN` / `WHEN NOT :param` — OBSOLETE pattern (WARNING).
        //    The param is used as a raw boolean condition inside a WHEN. Post ADR-0154 the runtime
        //    coerces bool→0/1, so the bind is a bigint and `CASE WHEN <bigint>` breaks in PG.
        const seenCase = new Set();
        for (const hit of m.matchAll(/\bWHEN\s+(?:NOT\s+)?:(\w+)\b(?=\s*(?:THEN|WHEN|AND|OR|END|\)|$))/gi)) {
          const p = hit[1];
          if (seenCase.has(p)) continue;
          seenCase.add(p);
          findings.push({
            rule: 'boolean-case-obsolete',
            level: 'warning',
            message: `${source} — \`WHEN … :${p}\`: patrón OBSOLETO. Desde ADR-0154 el runtime coerciona bool→0/1 en un punto central (hub#210); el bind llega como bigint y \`CASE WHEN :${p}\` rompe en PG («argument of WHEN must be type boolean»). Pasa el param DIRECTO (\`= :${p}\`), sin envolver en CASE WHEN.`,
          });
        }

        // 4) `:param IS [NOT] NULL` — untyped bind → 42P08 at PREPARE time (ERROR since #32).
        //    Comparing the same bind against a column further down does NOT type it: Postgres fixes
        //    the type at the FIRST appearance and `IS NULL` contributes none.
        const seenNull = new Set();
        for (const hit of m.matchAll(/:(\w+)\s+IS\s+(?:NOT\s+)?NULL\b/gi)) {
          const p = hit[1];
          if (seenNull.has(p)) continue;
          seenNull.add(p);
          findings.push({
            rule: 'null-untyped',
            level: 'error',
            message: `${source} — \`:${p} IS NULL\`: PG fija el tipo de un bind en su PRIMERA aparición y \`IS NULL\` no aporta ninguno, así que en cuanto \`:${p}\` llega NULL el PREPARE muere con 42P08 («could not determine data type of parameter») y el SQL no se ejecuta en NINGÚN hub (ADR-0154: solo hay dialecto postgres). Compararlo con una columna más abajo NO lo salva. Castea el bind: \`CAST(:${p} AS TEXT) IS NULL\` (portable en los dos dialectos, ADR-0007).`,
          });
        }
      }
    }
  }
  return findings;
}
