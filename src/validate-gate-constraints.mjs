// Publish guard for the GUARD TABLE of a module (module-toolkit#92, found in verifactu#40).
//
// ⚠️ Not `validate-row-gates.mjs`. That one is the gate over how many ROWS a command's `sql`
// affected (`min_affected_rows` / `expect_rows`). This one is the `<module>__gate` TABLE: the way a
// declarative command refuses IN SQL. An assert inserts `(gate, ok)` with `ok = 1` only when the
// invariant holds, and `ok = 0` violates a CHECK, which rolls the whole command transaction back.
//
// THE DEFECT. The pattern was copied with the CHECK written anonymous:
//
//     ok INTEGER NOT NULL CHECK (ok = 1)
//
// Postgres auto-names it `<table>_ok_check`, so EVERY gate of the module fails with the SAME
// primary message, and which gate refused travels in a separate field:
//
//     ERROR:   new row for relation "verifactu__gate" violates check constraint "verifactu__gate_ok_check"
//     DETAIL:  Failing row contains (config_save_requires_issuer, 0).
//
// DETAIL never reaches the caller. A refusal arrives as `sqlx::Error::Database` wrapping
// `PgDatabaseError`, whose `Display` writes the primary message and nothing else, and whose
// `message()` does not carry DETAIL. So any code that branches on the text to say WHY cannot ever
// match, and every refusal of the module collapses into one generic sentence — in verifactu, a hub
// with no obligado tributario was told that going live is one way: the OTHER gate's problem,
// naming nothing it could act on.
//
// THE FIX, as `verifactu` migration 012 applied it: move the gate's identity out of the ROW and
// into the CONSTRAINT NAME, which IS part of the primary message. One named constraint per gate,
// each scoped to its own gate value, so exactly one of them can be violated by any given row —
// which also removes the dependency on an evaluation order Postgres does not promise:
//
//     ALTER TABLE m__gate DROP CONSTRAINT IF EXISTS m__gate_ok_check;
//     ALTER TABLE m__gate ADD CONSTRAINT stock_is_available
//         CHECK (gate <> 'stock_is_available' OR ok = 1);
//     ALTER TABLE m__gate ADD CONSTRAINT m__gate_is_declared
//         CHECK (gate IN ('stock_is_available'));
//
// The whitelist is not decoration: with one constraint per gate, a row whose `gate` matches none of
// them violates NOTHING, so a typo in an assert would fail OPEN and the command would commit.
//
// WHY THE CHAIN AND NOT THE FILE. Migrations are append-only: `verifactu/010` still creates the
// table with the anonymous check and `012` drops it. A per-file reader would put the one module
// that did the work in red — the false positive that turns a gate into noise everyone mutes. So
// the declared migrations are replayed IN ORDER and the verdict is on the END state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationEntries } from './validate-migrations.mjs';
import { splitStatements, stripComments } from './validate-migration-guard.mjs';

/**
 * The gate tables that carry the anonymous CHECK on `origin/main` today (measured 01/09/2026 over
 * the 27 module repos: these two, plus `verifactu`, `appointments` and — since services#91 —
 * `services`, already fixed).
 *
 * A ratchet, not a permanent exemption. A hard error with no tolerance list would put green,
 * published repos in red for a rule written here today — which is how a gate gets switched off
 * instead of obeyed. They are named ONE BY ONE with the issue that retires them, they WARN on every
 * run (never silent, unlike a plain exemption), and the list can only SHRINK: a gate table added
 * from today is born in error.
 */
export const GRANDFATHERED = [
  ['reservations', 'migrations/postgres/002_gate.sql', 'ERPlora/reservations#42'],
  ['tables', 'migrations/postgres/002_gate.sql', 'ERPlora/tables#76'],
];

function grandfatheredIssue(moduleId, file) {
  const hit = GRANDFATHERED.find(([m, f]) => m === moduleId && f === file);
  return hit ? hit[2] : null;
}

/** `"public"."m__gate"` → `m__gate`. Quotes and schema are noise for every question asked here. */
function bareName(raw) {
  const parts = String(raw ?? '').split('.');
  return parts[parts.length - 1].replace(/"/g, '').trim();
}

/** A gate table is the guard table of the pattern: `<module>__gate`, and anything derived from it. */
function isGateTable(name) {
  return /__gate/i.test(name);
}

/**
 * The expression with every string literal blanked.
 *
 * Without it `CHECK (gate IN ('ok_to_close'))` reads as a constraint over the column `ok`, and the
 * whitelist that makes the fix safe would be reported as the defect it exists to complete.
 */
function withoutLiterals(expr) {
  return expr.replace(/'(?:[^']|'')*'/g, "''");
}

/** The text between the parentheses opening at `open`, respecting nesting and literals. */
function balanced(text, open) {
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
  return text.slice(open + 1);
}

/**
 * Every CHECK in a fragment, as `{ name, expr }` — `name: null` when it is anonymous.
 *
 * Lexical on purpose (the toolkit ships with no dependencies): a `CHECK (` and, immediately before
 * it, an optional `CONSTRAINT <ident>`. That is the whole grammar the pattern uses, in a
 * `CREATE TABLE` body and in an `ALTER TABLE … ADD` alike.
 */
export function checksIn(fragment) {
  const out = [];
  const re = /\bCHECK\s*\(/gi;
  let hit;
  while ((hit = re.exec(fragment)) !== null) {
    const open = hit.index + hit[0].length - 1;
    const before = fragment.slice(0, hit.index);
    const named = /\bCONSTRAINT\s+("?[A-Za-z0-9_]+"?)\s*$/i.exec(before);
    out.push({ name: named ? bareName(named[1]) : null, expr: balanced(fragment, open).trim() });
    re.lastIndex = open + 1;
  }
  return out;
}

/** What a CHECK on a gate table does: constrain `ok`, discriminate by `gate`, whitelist `gate`. */
export function classifyGateCheck(expr) {
  const bare = withoutLiterals(expr);
  return {
    constrainsOk: /\bok\b/i.test(bare),
    discriminatesByGate: /\bgate\b/i.test(bare),
    whitelistsGate: /\bgate\b\s+(?:NOT\s+)?IN\s*\(/i.test(bare),
  };
}

/** The auto-name Postgres gives the anonymous column check, which is what a DROP has to name. */
const autoName = (table) => `${table}_ok_check`;

/**
 * Replays the declared migrations and returns `{ errors, warnings }` on the END state of every
 * gate table. `files` is `[{ file, sql }]` in the order the manifest declares them.
 */
export function gateConstraintFindings(moduleId, files) {
  const errors = [];
  const warnings = [];
  /** table → { createdIn, everConstrainedOk, live: Map<name, {expr, file, anonymous}> } */
  const tables = new Map();

  const ensure = (name, file) => {
    if (!tables.has(name)) {
      tables.set(name, { table: name, createdIn: file, everConstrainedOk: false, live: new Map() });
    }
    return tables.get(name);
  };

  const addCheck = (state, { name, expr }, file) => {
    const kind = classifyGateCheck(expr);
    if (kind.constrainsOk) state.everConstrainedOk = true;
    const key = name ?? autoName(state.table);
    state.live.set(key, { expr, file, anonymous: name === null, ...kind });
  };

  for (const { file, sql } of files) {
    for (const raw of splitStatements(sql)) {
      const statement = stripComments(raw);

      const created = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_."]+)\s*\(/i.exec(statement);
      if (created) {
        const table = bareName(created[1]);
        if (!isGateTable(table)) continue;
        const state = ensure(table, file);
        const body = balanced(statement, statement.indexOf('(', created.index));
        for (const check of checksIn(body)) addCheck(state, check, file);
        continue;
      }

      const dropped = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z0-9_."]+)/i.exec(statement);
      if (dropped) {
        tables.delete(bareName(dropped[1]));
        continue;
      }

      const altered = /^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([A-Za-z0-9_."]+)\s/i.exec(statement);
      if (!altered) continue;
      const table = bareName(altered[1]);
      if (!isGateTable(table) || !tables.has(table)) continue;
      const state = tables.get(table);

      const dropRe = /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?[A-Za-z0-9_]+"?)/gi;
      let drop;
      while ((drop = dropRe.exec(statement)) !== null) state.live.delete(bareName(drop[1]));

      const tail = statement.slice(altered.index + altered[0].length);
      for (const check of checksIn(tail)) addCheck(state, check, file);
    }
  }

  for (const state of tables.values()) {
    const live = [...state.live.entries()].map(([name, info]) => ({ name, ...info }));
    const globals = live.filter((c) => c.constrainsOk && !c.discriminatesByGate);
    const perGate = live.filter((c) => c.constrainsOk && c.discriminatesByGate);
    const whitelist = live.filter((c) => c.whitelistsGate);

    if (globals.length) {
      const where = globals[0].file;
      const listed = globals
        .map((c) => (c.anonymous ? `\`CHECK (${c.expr})\` (anónima → Postgres la llama \`${c.name}\`)` : `\`${c.name}\``))
        .join(', ');
      const message =
        `${where}: la tabla guardia \`${state.table}\` rechaza con ${listed}, que NO distingue el gate. ` +
        'Cualquier rechazo del módulo sale con el MISMO mensaje primario y el nombre del gate que ' +
        'saltó viaja en el DETAIL del error, que no llega al llamante (`PgDatabaseError::Display` ' +
        'escribe solo el mensaje primario y `message()` descarta DETAIL): el código que intente decir ' +
        'POR QUÉ se rechazó no puede casar nunca. Mueve la identidad del gate de la FILA al NOMBRE de ' +
        'la constraint — una por gate, acotada a su propio valor, más la lista blanca que hace que un ' +
        `gate sin registrar falle CERRADO:\n      ALTER TABLE ${state.table} DROP CONSTRAINT IF EXISTS ${globals[0].name};` +
        `\n      ALTER TABLE ${state.table} ADD CONSTRAINT <nombre_del_gate>` +
        `\n          CHECK (gate <> '<nombre_del_gate>' OR ok = 1);` +
        `\n      ALTER TABLE ${state.table} ADD CONSTRAINT ${state.table}_is_declared` +
        `\n          CHECK (gate IN ('<nombre_del_gate>', …));` +
        '\n    Referencia: `verifactu/migrations/postgres/012_named_gate_constraints.sql` (verifactu#40).';
      const issue = grandfatheredIssue(moduleId, where);
      if (issue) warnings.push(`${message}\n    Tolerado mientras viva ${issue} — la lista solo encoge.`);
      else errors.push(message);
      continue;
    }

    // The hazard this door CREATES if it stops at the message above: it tells the author to DROP
    // the only constraint that rolls the transaction back. Half of that instruction leaves the
    // table accepting `ok = 0`, the command answers OK, and the invariant is simply gone —
    // silently, because nothing fails any more.
    if (state.everConstrainedOk && perGate.length === 0) {
      errors.push(
        `${state.createdIn}: la tabla guardia \`${state.table}\` se quedó SIN ninguna CHECK sobre \`ok\`. ` +
          'Un `ok = 0` ahora COMMITEA: el assert no revierte nada, el command responde OK y el ' +
          'invariante que guardaba desaparece sin que falle nada. Si estabas retirando la CHECK ' +
          'anónima, la migración tiene que dejar en su sitio una constraint por gate ' +
          "(`CHECK (gate <> '<gate>' OR ok = 1)`) en el MISMO fichero: entre las dos no puede haber " +
          'una ventana con la tabla desguarnecida.',
      );
      continue;
    }

    if (perGate.length && whitelist.length === 0) {
      warnings.push(
        `${state.createdIn}: \`${state.table}\` tiene ${perGate.length} constraint(s) por gate y ninguna ` +
          'lista blanca sobre `gate`. Una fila cuyo `gate` no case con ninguna no viola NADA, así que ' +
          'un gate mal escrito en un assert falla ABIERTO y el command commitea. Añade ' +
          `\`ALTER TABLE ${state.table} ADD CONSTRAINT ${state.table}_is_declared CHECK (gate IN (…));\` ` +
          'enumerando los gates declarados (verifactu#40).',
      );
    }
  }

  return { errors, warnings };
}

/**
 * The whole door: the postgres migrations the manifest declares, read from disk in that order.
 *
 * A file the manifest points at and the disk does not have is left to `checkMigrations`
 * (manifest↔disk parity), which is the check that owns it.
 */
export function checkGateConstraints(dir, manifest) {
  const moduleId = manifest?.id;
  if (!moduleId) return { errors: [], warnings: [] };

  const files = [];
  for (const entry of migrationEntries(manifest)) {
    if (typeof entry.file !== 'string' || !entry.file) continue;
    const abs = join(dir, entry.file);
    if (!existsSync(abs)) continue;
    try {
      files.push({ file: entry.file, sql: readFileSync(abs, 'utf8') });
    } catch {
      continue; // Unreadable file: `checkMigrationGuard` is the door that reports it.
    }
  }
  return gateConstraintFindings(moduleId, files);
}
