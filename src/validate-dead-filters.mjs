// A list filter over a column the query itself already answered (module-toolkit#178).
//
// The runtime does not splice a filter INTO the module's SQL — it WRAPS it
// (`hub/crates/runtime/src/queries.rs`):
//
//     SELECT sub.*, COUNT(*) OVER() AS _total
//     FROM ( <the module's query> ) AS sub
//     WHERE CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)
//
// So when the module's own WHERE already pins that column to a constant, the two conditions STACK:
// `col = 1 AND col = 0`. Nothing fails — the list simply comes back EMPTY for every value but the
// pinned one, with nothing on screen that says why (the silence of hub#1182). The user filters by
// «inactive», sees nothing, and concludes there are none.
//
// Until this file `erplora validate` gave that green, and it could not do otherwise: the manifest is
// coherent with ITSELF, and the box guard next door (`validate-filter-ops.mjs`) compares SCREEN ↔
// MANIFEST — neither of them ever looks at the SQL. That is why ERPlora/taxes#50 ended up being
// fixed by hand in three screens of one module while the same filter stayed dead in six others.
//
// WHAT IT TAKES TO BE A PIN, and why each condition is there. Swept over `origin/main` of the 27
// module repos on 2026-09-05 (`~/.erplora/fleet/logs/178/sweep.py`): 9 dead filters in 7 modules,
// every one of them `is_active`. The catalogue also carries the two shapes a naive
// `grep 'is_active = 1'` gets WRONG, and both are real:
//
//   · `tables.zones.list` — the `= 1` is in the `ON` of a LEFT JOIN over ANOTHER table (`t`), while
//     the list's base table is `z`. Only the top-level WHERE is read, so it never sees it.
//   · `taxes.rules.list`  — `AND (r.is_active = 1 OR COALESCE(:include_archived …))`. A pin behind
//     an OR is not a pin: the caller can open the door, and ERPlora/taxes#53 kept that filter ON
//     PURPOSE. So a top-level OR anywhere in the WHERE makes the whole clause unjudgeable.
//
// Everything this gate refuses, it refuses because ONE value survives the module's own WHERE, which
// is exactly when the wrapper's condition can only ever contradict it.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { migrationFiles } from './validate-migrations.mjs';
import { declaredColumnTypes } from './validate-filter-ops.mjs';

/**
 * Dead filters ALREADY PUBLISHED, measured over `origin/main` of the 27 module repos on
 * 2026-09-05. They warn instead of blocking, so that landing this gate does not put 7 modules red
 * at once — but a filter that is not on this line is an ERROR, which is the whole point: the next
 * one cannot be born.
 *
 * 🔴 THE LIST ONLY SHRINKS, and an entry may not outlive its filter. Each line is an exact
 * `module · query · column` identity, so it can only ever excuse the one filter it names; when that
 * filter is fixed the line covers nothing and `checkDeadFilters` FAILS the module's own gate on it.
 * That fixes the order: the one-line pull request that deletes the entry goes FIRST, and the
 * module's fix merges behind it (same contract as `FILTER_OPS_GRANDFATHERED`).
 *
 * The fix each of these wants is the one ERPlora/taxes#53 chose: the column is not a filter, it is a
 * decision the query already took — so the filter comes OUT of `list.filters`. Their issue is
 * ERPlora/pm#251.
 */
export const DEAD_FILTERS_GRANDFATHERED = [
  ['appointments', 'appointments.schedules.list', 'is_active'],
  ['cash_register', 'cash_register.registers.list', 'is_active'],
  ['customers', 'customers.groups.list', 'is_active'],
  ['customers', 'customers.tags.list', 'is_active'],
  ['customers', 'customers.fields.list', 'is_active'],
  ['pricing', 'pricing.price_lists.list', 'is_active'],
  ['pricing', 'pricing.rules.list', 'is_active'],
  ['reservations', 'reservations.timeslots.list', 'is_active'],
  ['staff', 'staff.roles.list', 'is_active'],
];

/** A value written in the SQL itself — no bind, no column, nothing the caller can move. */
const LITERAL = String.raw`(?:-?\d+(?:\.\d+)?|'(?:[^']|'')*'|TRUE|FALSE|NULL)`;

/** Clauses that END the WHERE. `WHERE` runs to the first one of these at depth 0, or to the end. */
const AFTER_WHERE = /\b(?:GROUP\s+BY|HAVING|ORDER\s+BY|LIMIT|OFFSET|WINDOW|FETCH|RETURNING|FOR\s+UPDATE)\b/gi;

/** Set operators: two arms means two WHEREs, and which one the wrapper sees is not for us to guess. */
const SET_OPERATOR = /\b(?:UNION|INTERSECT|EXCEPT)\b/gi;

/**
 * The same SQL with every comment and every string BODY blanked to spaces, offsets untouched.
 *
 * Structure — parentheses, keywords, the quotes themselves — survives, so the blanked copy can be
 * scanned and every offset still points at the real character in `sql`. What stops being code is
 * text: a `WHERE is_active = 1` left behind in a comment pins nothing, and `label <> 'x AND
 * is_active = 1'` is a value, not two predicates.
 */
function blankNonCode(sql) {
  const out = sql.split('');
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') blank(i++);
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (sql[i] === "'") {
      i += 1; // the opening quote stays, so a literal is still recognisable
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          blank(i++);
          blank(i++);
          continue; // '' is an escaped quote inside the body, not the end
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        blank(i++);
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Parenthesis depth at every offset of already-blanked code. */
function depths(code) {
  const out = new Int32Array(code.length);
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '(') {
      out[i] = depth;
      depth += 1;
    } else if (code[i] === ')') {
      depth -= 1;
      out[i] = depth;
    } else {
      out[i] = depth;
    }
  }
  return out;
}

/** Every match of `re` that sits at parenthesis depth 0 — i.e. in the outermost statement. */
function atTopLevel(code, depth, re) {
  const out = [];
  for (const m of code.matchAll(re)) if (depth[m.index] === 0) out.push(m);
  return out;
}

/** 1-based line of `offset`. */
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length;

/**
 * `{ code, depth, where: { from, to } | null }` — the outermost WHERE clause of this SQL, or null
 * when there is nothing a single wrapper can be reasoned about: no WHERE, more than one (a set
 * operator, or a shape this parser does not recognise), or a top-level OR.
 */
function topLevelWhere(sql) {
  const code = blankNonCode(sql);
  const depth = depths(code);
  if (atTopLevel(code, depth, SET_OPERATOR).length) return { code, depth, where: null };

  const wheres = atTopLevel(code, depth, /\bWHERE\b/gi);
  if (wheres.length !== 1) return { code, depth, where: null };

  const from = wheres[0].index + wheres[0][0].length;
  const ends = atTopLevel(code, depth, AFTER_WHERE)
    .map((m) => m.index)
    .filter((i) => i > from);
  const to = ends.length ? Math.min(...ends) : code.length;

  // A top-level OR makes the whole clause a disjunction (`AND` binds tighter), so NOTHING in it is
  // guaranteed — which is precisely the escape hatch `taxes.rules.list` uses on purpose.
  const clause = code.slice(from, to);
  for (const m of clause.matchAll(/\bOR\b/gi)) {
    if (depth[from + m.index] === 0) return { code, depth, where: null };
  }
  return { code, depth, where: { from, to } };
}

/** The conjuncts of `[from, to)` — the pieces separated by the `AND`s at depth 0. */
function conjuncts(code, depth, from, to) {
  const parts = [];
  let start = from;
  for (const m of code.slice(from, to).matchAll(/\bAND\b/gi)) {
    const at = from + m.index;
    if (depth[at] !== 0) continue;
    parts.push({ from: start, to: at });
    start = at + m[0].length;
  }
  parts.push({ from: start, to });
  return parts;
}

/** Whether this declared Postgres type is a boolean — the only domain where `<>` leaves one value. */
const isBoolean = (types) => [...(types ?? [])].some((t) => /^\s*"?bool/i.test(String(t)));

const REF = String.raw`(?:(\w+)\s*\.\s*)?"?(\w+)"?`;
const EQ = new RegExp(String.raw`^\s*${REF}\s*=\s*(${LITERAL})\s*$`, 'i');
const NEQ = new RegExp(String.raw`^\s*${REF}\s*(?:<>|!=)\s*(${LITERAL})\s*$`, 'i');
const IS_NULL = new RegExp(String.raw`^\s*${REF}\s+IS\s+NULL\s*$`, 'i');
const IS_BOOL = new RegExp(String.raw`^\s*${REF}\s+IS\s+(TRUE|FALSE)\s*$`, 'i');
const IN_LIST = new RegExp(String.raw`^\s*${REF}\s+IN\s*\(([^()]*)\)\s*$`, 'i');

/**
 * Every column the top-level WHERE of this SQL pins to ONE possible value.
 *
 * Returns `Map<'<alias>.<col>' | '<col>', { qualifier, column, predicate, line }>`. The key keeps
 * the qualifier exactly as the SQL wrote it, because that is what tells `z.is_active` (the list's
 * own table) apart from `t.is_active` (a table it joins).
 *
 * `columnTypes` (`column -> Set<declared type>`) is only consulted for `<>`: on a BOOLEAN it leaves
 * exactly one value, on anything else it kills the one value it names and the filter still works
 * for all the others — so without the type there is no proof and nothing is reported.
 */
export function pinnedColumns(sql, { columnTypes = null } = {}) {
  const pins = new Map();
  const { code, depth, where } = topLevelWhere(sql);
  if (!where) return pins;

  for (const part of conjuncts(code, depth, where.from, where.to)) {
    const text = sql.slice(part.from, part.to);
    const blanked = code.slice(part.from, part.to);
    if (/\bNOT\b/i.test(blanked)) continue; // `IS NOT NULL`, `NOT (…)` — nothing is pinned

    let m = EQ.exec(blanked) ?? IS_NULL.exec(blanked) ?? IS_BOOL.exec(blanked);
    if (!m) {
      const inList = IN_LIST.exec(blanked);
      // `IN` pins only when the list holds exactly ONE value; two literals leave a choice.
      if (inList && inList[3].split(',').filter((v) => v.trim()).length !== 1) continue;
      m = inList;
    }
    if (!m) {
      const neq = NEQ.exec(blanked);
      if (!neq) continue;
      if (!isBoolean(columnTypes?.get(neq[2].toLowerCase()))) continue;
      m = neq;
    }

    const [, qualifier, column] = m;
    // A literal is the only right-hand side that cannot move: a bind (`:status`) IS the filter
    // working, and a column reference compares two moving parts.
    const key = qualifier ? `${qualifier}.${column}` : column;
    if (pins.has(key)) continue;
    pins.set(key, {
      qualifier: qualifier ?? null,
      column,
      predicate: text.trim().replace(/\s+/g, ' '),
      line: lineOf(sql, part.from + (text.length - text.trimStart().length)),
    });
  }
  return pins;
}

const SIMPLE_OUTPUT = new RegExp(String.raw`^\s*${REF}\s*(?:AS\s+"?(\w+)"?)?\s*$`, 'i');

/**
 * What the outermost SELECT list EXPOSES: `Map<output name, { qualifier, column } | null>` plus
 * `star`, and this is the name the wrapper filters on (`sub.<output name>`).
 *
 * `null` means the output is an expression, not a column — `COUNT(t.id) AS table_count` — and no
 * constant on a column can pin it. `star` means the query returns `*`, so an output's source is its
 * own name and there is nothing to follow back.
 */
export function selectOutputs(sql) {
  const code = blankNonCode(sql);
  const depth = depths(code);
  const selects = atTopLevel(code, depth, /\bSELECT\b/gi);
  const froms = atTopLevel(code, depth, /\bFROM\b/gi);
  if (selects.length !== 1 || froms.length === 0) return { star: true, map: new Map() };

  const from = selects[0].index + selects[0][0].length;
  const to = froms.find((m) => m.index > from)?.index ?? code.length;
  const list = code.slice(from, to).replace(/^\s*(?:DISTINCT|ALL)\b/i, '');
  const offset = from + (code.slice(from, to).length - list.length);

  const map = new Map();
  let star = false;
  let start = 0;
  const pieces = [];
  for (const m of list.matchAll(/,/g)) {
    if (depth[offset + m.index] !== 0) continue;
    pieces.push({ from: start, to: m.index });
    start = m.index + 1;
  }
  pieces.push({ from: start, to: list.length });

  for (const piece of pieces) {
    const blanked = list.slice(piece.from, piece.to);
    if (/(^|\.)\s*\*\s*$/.test(blanked.trim())) {
      star = true;
      continue;
    }
    const simple = SIMPLE_OUTPUT.exec(blanked);
    if (simple) {
      const [, qualifier, column, alias] = simple;
      map.set(alias ?? column, { qualifier: qualifier ?? null, column });
      continue;
    }
    // An expression: only its alias reaches the wrapper, and it is not a column.
    const alias = /\bAS\s+"?(\w+)"?\s*$/i.exec(blanked) ?? /\s"?(\w+)"?\s*$/.exec(blanked);
    if (alias) map.set(alias[1], null);
  }
  return { star, map };
}

/**
 * Every dead filter of a module. `queries` is `[{ name, sql, filters }]`; returns
 * `{ errors, warnings }`, the shape the other `erplora validate` checks use.
 *
 * `declared` is every query name the manifest carries, `list.filters` or not — it is what tells a
 * grandfathered line that no longer covers anything (the module was FIXED, and the line has to go)
 * apart from a module that simply is not the one the line is about. Without that distinction any
 * fixture reusing a published id — `test/validate-errors-catalog.test.mjs` builds an `appointments`
 * with one command and no queries — fails on somebody else's excuse. Default: the queries given.
 */
export function deadFilterFindings(moduleId, queries, { columnTypes = null, declared = null } = {}) {
  const errors = [];
  const warnings = [];
  const found = new Map();

  for (const { name, sql, filters } of queries ?? []) {
    if (!filters || typeof filters !== 'object' || typeof sql !== 'string') continue;
    const pins = pinnedColumns(sql, { columnTypes });
    if (pins.size === 0) continue;
    const outputs = selectOutputs(sql);

    for (const column of Object.keys(filters)) {
      const source = outputs.map.has(column)
        ? outputs.map.get(column)
        : outputs.star
          ? { qualifier: null, column }
          : undefined;
      if (!source) continue; // an expression, or a column this query does not even return

      const pin = [...pins.values()].find(
        (p) =>
          p.column.toLowerCase() === source.column.toLowerCase() &&
          (p.qualifier == null || source.qualifier == null || p.qualifier === source.qualifier),
      );
      if (!pin) continue;

      const renamed =
        source.column.toLowerCase() === column.toLowerCase()
          ? ''
          : ` (la SQL la expone como \`${column}\` desde \`${source.qualifier ? `${source.qualifier}.` : ''}${source.column}\`)`;
      found.set(
        `${name}|${column}`,
        `\`${name}\` declara el filtro \`${column}\`${renamed}, pero su propia SQL ya lo clava en el ` +
          `WHERE: \`${pin.predicate}\` (línea ${pin.line}). El runtime NO mete el filtro dentro de la ` +
          'query, la envuelve — `SELECT sub.* FROM ( … ) AS sub WHERE CAST(sub.' +
          `${column} AS TEXT) = …\` —, así que las dos condiciones se suman y para cualquier valor ` +
          'distinto de la constante la lista vuelve VACÍA siempre, sin error y sin nada en pantalla ' +
          'que lo explique. O la columna deja de estar clavada en la SQL (y entonces el filtro sirve), ' +
          `o \`${column}\` sale de \`list.filters\`: es una decisión que la query ya tomó, no un filtro ` +
          '(ERPlora/module-toolkit#178).',
      );
    }
  }

  const owed = DEAD_FILTERS_GRANDFATHERED.filter(([id]) => id === moduleId);
  const excused = new Set(owed.map(([, query, column]) => `${query}|${column}`));

  for (const [key, message] of found) {
    if (excused.has(key)) {
      warnings.push(`[dead-filters] ${message} — ABUELADO en module-toolkit#178 mientras se arregla (ERPlora/pm#251).`);
    } else {
      errors.push(message);
    }
  }

  const names = declared ?? new Set((queries ?? []).map((q) => q?.name));
  for (const [, query, column] of owed) {
    if (found.has(`${query}|${column}`)) continue;
    const stale =
      `\`${query}\` → \`${column}\` ya NO es un filtro muerto, pero sigue en la lista de abuelados de ` +
      '`module-toolkit/src/validate-dead-filters.mjs` (`DEAD_FILTERS_GRANDFATHERED`): una línea que ' +
      'no cubre nada es un permiso permanente para volver a romperlo en verde. Bórrala — esa PR de ' +
      'una línea va DELANTE del arreglo del módulo.';
    // El módulo que declara la query es el que puede haberla arreglado: ahí la línea sobra y se
    // BLOQUEA, que es lo que fija el orden de las dos PRs. Si ni siquiera declara la query, no es
    // el módulo del que habla la línea (o la retiró entera): se avisa, pero no se pone rojo a un
    // tercero por una excusa ajena.
    if ([...names].includes(query)) errors.push(stale);
    else warnings.push(`[dead-filters] ${stale}`);
  }

  return { errors, warnings };
}

/** The SQL of a query, when it is one readable statement — otherwise null (nothing to judge). */
function querySql(dir, value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  if (items.length !== 1 || typeof items[0] !== 'string') return null;
  const item = items[0].trim();
  if (!/\.sql$/i.test(item)) return item;
  const path = isAbsolute(item) ? item : join(dir, item);
  if (!existsSync(path)) return null; // a missing file is `checkMigrations`/`validate`'s finding
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** `column -> Set<declared type>` over every postgres migration this manifest declares. */
function moduleColumnTypes(dir, manifest) {
  const types = new Map();
  for (const rel of migrationFiles(manifest, 'postgres')) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    let sql;
    try {
      sql = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [col, type] of declaredColumnTypes(sql)) {
      if (!types.has(col)) types.set(col, new Set());
      types.get(col).add(type);
    }
  }
  return types;
}

/** The whole door, over a module on disk. Returns `{ errors, warnings }`; never throws. */
export function checkDeadFilters(dir, manifest) {
  const moduleId = manifest?.id;
  if (!moduleId) return { errors: [], warnings: [] };

  const queries = [];
  for (const [name, spec] of Object.entries(manifest?.queries ?? {})) {
    if (!spec || typeof spec !== 'object') continue;
    const filters = (spec.list ?? {}).filters;
    if (!filters || typeof filters !== 'object') continue;
    const sql = querySql(dir, spec.sql);
    if (sql == null) continue;
    queries.push({ name, sql, filters });
  }

  return deadFilterFindings(moduleId, queries, {
    columnTypes: moduleColumnTypes(dir, manifest),
    declared: new Set(Object.keys(manifest?.queries ?? {})),
  });
}
