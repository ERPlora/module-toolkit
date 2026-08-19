// `erplora validate --pg`: ask POSTGRES whether the module's SQL can even be prepared
// (module-toolkit#32, hole 3).
//
// Why this exists. The other guardrails (validate-sql.mjs, validate-pg.mjs) are LEXICAL scanners
// and will always trail reality: the sweep of pm#107 found `whatsapp_inbox.messages.ingest`
// comparing a TEXT column with a `timestamptz` (`m.created_at >= erp_month_start(:now)`), which no
// plausible lexical rule can see — you cannot tell one identifier's type from another's without
// the schema. Preparing is EXACTLY what the runtime does on every call
// (`hub/crates/db/src/lib.rs`), so a statement Postgres cannot PREPARE is dead code; and since
// ADR-0154 modules only ship the `postgres` dialect, dead in every hub.
//
// What it does, mirroring the runtime step by step:
//   1. scratch database built with the module's OWN `migrations.postgres`, with the portable DDL
//      types normalised the way `shim_ddl_types` does (INTEGER → BIGINT, REAL → DOUBLE PRECISION…);
//   2. every declared `sql` of `queries`/`commands` translated like `translate` does: the `erp_*`
//      bridge functions lowered to their native expression, then `:name` → `$n` by first
//      appearance, with `::` left alone and comments/literals untouched;
//   3. `PREPARE` on each statement. Binds that CANNOT arrive NULL get their type (the runtime
//      injects them, or the command's schema marks them required); the ones that can are left
//      untyped on purpose — OID 0, `DynNull` — because that is the shape that breaks.
//
// Two classes are excluded on purpose, both measured during the sweep:
//   · a table owned by ANOTHER module or by the core (`inventory` → `sales_sale_item`, `taxes` →
//     `hub_settings`): the scratch database only carries this module's migrations, so it is a
//     WARNING, never a failure;
//   · a failure that hangs on the type of a bind NOBODY declared: the runtime sends whatever JSON
//     type the caller used, so Postgres deducing something else here proves nothing (`invoice`,
//     `cash_register`). Structural failures — an ambiguous column, a missing column, bad syntax —
//     are errors whatever sits on the line.
//
// If there is no Docker or no container this reports `skipped` with the reason and NOTHING is
// verified; `erplora validate --pg` turns that into a failure, because the flag is opt-in and a
// silent green is exactly what pm#107 is trying to get rid of.
//
// Transport is `docker exec … psql` on purpose: no driver dependency, and it is the same container
// the module regression tests already use (`erplora-test-pg-5433`).
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BRIDGE_FUNCTIONS } from './validate-sql.mjs';
import { migrationFiles } from './validate-migrations.mjs';

/** Container to talk to, read at CALL time so a caller (or a test) can point it elsewhere. */
export const defaultContainer = () => process.env.ERPLORA_TEST_PG_CONTAINER || 'erplora-test-pg-5433';

/**
 * Binds the runtime injects itself (`system_params`, `hub/crates/runtime/src/lib.rs`). They are
 * ALWAYS present, so sqlx always sends them typed — leaving them untyped here would invent 42P08s
 * that no hub can ever hit.
 */
const SYSTEM_PARAM_TYPES = {
  hub_id: 'text',
  current_user_id: 'text',
  now: 'text',
  new_id: 'text',
  business_tax_id: 'text',
  business_legal_name: 'text',
  business_address: 'text',
  approved_by: 'text',
  has_certificate: 'bigint',
};

/** JSON Schema type → the Postgres type the runtime's bind lands on (ADR-0007 / hub#210). */
const JSON_TYPE_TO_PG = {
  string: 'text',
  integer: 'bigint',
  number: 'double precision',
  boolean: 'bigint', // the runtime coerces Json::Bool → INTEGER 0/1 at a single point (hub#210)
};

// ── translation: the runtime's, or we would be testing a different SQL ───────────────────────

/** Balanced arguments of the `(` at `open` → { args, end } (end = index after the `)`). */
function scanArgs(sql, open) {
  let depth = 0;
  let start = open + 1;
  let inString = false;
  const args = [];
  for (let i = open; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        args.push(sql.slice(start, i));
        return { args, end: i + 1 };
      }
    } else if (c === ',' && depth === 1) {
      args.push(sql.slice(start, i));
      start = i + 1;
    }
  }
  return null; // unbalanced: leave the call alone, validate-sql already refuses that SQL
}

/** Native Postgres expression a bridge call lowers to, or null on wrong arity (mirror of
 *  `render_bridge_fn` in `hub/crates/db/src/lib.rs`). */
function renderBridgeFn(name, rawArgs) {
  const a = rawArgs.map((x) => shimBridgeFunctions(x.trim()));
  const arity = (n) => a.length === n;
  switch (name) {
    case 'erp_now':
      return rawArgs.length === 0 || (arity(1) && !a[0]) ? 'now()' : null;
    case 'erp_pad':
      return arity(2) ? `lpad((${a[0]})::text, ${a[1]}, '0')` : null;
    case 'erp_lpad':
      return arity(3) ? `lpad((${a[0]})::text, ${a[1]}, ${a[2]})` : null;
    case 'erp_dt':
      return arity(1) ? `((${a[0]})::timestamptz)` : null;
    case 'erp_date':
      return arity(1) ? `((${a[0]})::date)` : null;
    case 'erp_dateadd':
      return arity(3) ? `((${a[0]})::timestamptz + ((${a[1]}) || ' ' || ${a[2]})::interval)` : null;
    case 'erp_month_start':
      return arity(1) ? `date_trunc('month', (${a[0]})::timestamptz)` : null;
    case 'erp_dow_mon0':
      return arity(1) ? `((EXTRACT(ISODOW FROM (${a[0]})::timestamptz)::int) - 1)` : null;
    case 'erp_extract': {
      if (!arity(2)) return null;
      const part = rawArgs[0].trim().replace(/^'|'$/g, '').toLowerCase();
      if (!['hour', 'minute', 'second', 'epoch'].includes(part)) return null;
      return `(EXTRACT(${part} FROM (${a[1]})::timestamptz)::bigint)`;
    }
    case 'erp_datediff_days':
      return arity(2) ? `(EXTRACT(EPOCH FROM ((${a[0]})::timestamptz - (${a[1]})::timestamptz)) / 86400.0)` : null;
    case 'erp_timefmt':
      return arity(2) ? `(lpad((${a[0]})::text, 2, '0') || ':' || lpad((${a[1]})::text, 2, '0'))` : null;
    default:
      return null;
  }
}

/** Rewrites every `erp_*(…)` call to its native Postgres expression (recursive, string-safe). */
export function shimBridgeFunctions(sql) {
  const lower = sql.toLowerCase();
  if (!BRIDGE_FUNCTIONS.some((f) => lower.includes(f))) return sql;
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      i++;
      continue;
    }
    if (c === "'") { inString = true; out += c; i++; continue; }
    const prevIsIdent = i > 0 && /[\w]/.test(sql[i - 1]);
    if (!prevIsIdent) {
      const name = BRIDGE_FUNCTIONS.find(
        (f) => lower.startsWith(f, i) && !/[\w]/.test(sql[i + f.length] ?? ''),
      );
      if (name) {
        let p = i + name.length;
        while (p < sql.length && /\s/.test(sql[p])) p++;
        if (sql[p] === '(') {
          const call = scanArgs(sql, p);
          const repl = call && renderBridgeFn(name, call.args);
          if (repl != null) {
            out += repl;
            i = call.end;
            continue;
          }
        }
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Lowers module SQL to what Postgres actually sees: bridge functions rewritten and `:name` → `$n`
 * indexed by FIRST appearance, a repeated name reusing its index. `::` is the cast operator, and a
 * `:name` inside a literal or a comment stays verbatim — the runtime emits comments untouched, and
 * a bind that only lived in one used to become a phantom `$n` (bound but absent from the parsed
 * SQL → 42P08). Mirror of `translate` in `hub/crates/db/src/lib.rs`.
 */
export function translateForPostgres(sql) {
  const src = shimBridgeFunctions(sql);
  const names = [];
  let out = '';
  let i = 0;
  let inString = false;
  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      i++;
      continue;
    }
    if (c === "'") { inString = true; out += c; i++; continue; }
    if (src.startsWith('--', i)) {
      const j = src.indexOf('\n', i);
      const end = j < 0 ? src.length : j;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? src.length : j + 2;
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (src.startsWith('::', i)) { out += '::'; i += 2; continue; }
    if (c === ':') {
      let j = i + 1;
      while (j < src.length && /[\w]/.test(src[j])) j++;
      const name = src.slice(i + 1, j);
      if (name) {
        if (!names.includes(name)) names.push(name);
        out += `$${names.indexOf(name) + 1}`;
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return { sql: out, names };
}

/**
 * Normalises the portable DDL types to their native Postgres type, like `shim_ddl_types` does on
 * the migration path (`hub/crates/db/src/lib.rs`). `INTEGER` → `BIGINT` matters: a module's
 * counter/money column is 64-bit in a real hub, and a bind typed against `int4` infers differently.
 */
export function shimDdlTypes(sql) {
  const native = { TEXT: 'TEXT', INTEGER: 'BIGINT', REAL: 'DOUBLE PRECISION', BLOB: 'BYTEA' };
  let out = '';
  let i = 0;
  let inString = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      i++;
      continue;
    }
    if (c === "'") { inString = true; out += c; i++; continue; }
    const prevIsIdent = i > 0 && /[\w]/.test(sql[i - 1]);
    if (!prevIsIdent && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[\w]/.test(sql[j])) j++;
      const repl = native[sql.slice(i, j).toUpperCase()];
      if (repl) { out += repl; i = j; continue; }
    }
    out += c;
    i++;
  }
  return out;
}

// ── which binds get a declared type ─────────────────────────────────────────────────────────

/**
 * Postgres type per bind, positional, or `null` for "let the engine infer".
 *
 * The rule is the runtime's, not a convenience: a bind that arrives with a value travels typed from
 * sqlx, and one that arrives absent travels as `DynNull` (OID 0) so the engine infers. So a bind
 * that CANNOT be null (injected by the runtime, or `required` in the command schema without a null
 * default) is typed here, and everything else is deliberately left untyped — that untyped shape is
 * exactly the one that broke `appointments` and `tasks`, and typing it would hide the bug.
 */
export function pgParamTypes(names, schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return names.map((name) => {
    const system = SYSTEM_PARAM_TYPES[name];
    if (system) return system;
    const p = props[name];
    if (!p || !required.has(name)) return null;
    if ('default' in p && p.default === null) return null;
    const t = Array.isArray(p.type) ? p.type.find((x) => x !== 'null') : p.type;
    if (Array.isArray(p.type) && p.type.includes('null')) return null;
    return JSON_TYPE_TO_PG[t] ?? null;
  });
}

/** The `PREPARE name (types) AS` prefix. Postgres infers whatever the list does not cover, so the
 *  list is truncated at the last KNOWN type instead of guessing the tail. */
function prepareHeader(stmt, types) {
  let last = -1;
  for (let i = 0; i < types.length; i++) if (types[i]) last = i;
  if (last < 0) return `PREPARE ${stmt} AS`;
  const head = types.slice(0, last + 1).map((t) => t ?? 'unknown');
  // A gap before a known type cannot be expressed: `unknown` is Postgres's own "infer it".
  return `PREPARE ${stmt} (${head.join(', ')}) AS`;
}

// ── talking to the container ────────────────────────────────────────────────────────────────

function run(cmd, args, input) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Is there a reachable Postgres in the container? Never throws: "no" is a legitimate answer. */
export async function pgAvailable(container = defaultContainer(), exec = run) {
  const r = await exec('docker', ['exec', container, 'pg_isready', '-U', 'postgres']);
  return r.code === 0;
}

function psql(exec, container, db, sql, { stopOnError = true } = {}) {
  const args = ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', db, '-q', '-X'];
  if (stopOnError) args.push('-v', 'ON_ERROR_STOP=1');
  return exec('docker', args, sql);
}

const hasPgError = (stderr) => stderr.split('\n').some((l) => l.startsWith('ERROR:'));

const pgError = (stderr) =>
  stderr.split('\n').filter((l) => l.startsWith('ERROR:')).join(' ').trim() || stderr.trim().split('\n')[0] || '';

/**
 * A psql session that exits non-zero WITHOUT a single `ERROR:` line did not fail on SQL: the
 * transport died under it — the container was removed by another job (module-toolkit#43: two
 * slots on `ci-runner-1`), the server closed the connection, Docker itself refused. Postgres
 * never judged the module, so it must be reported as "nothing was verified", not as a defect.
 */
const transportFailure = (r) => r.code !== 0 && !hasPgError(r.stderr);

const transportReason = (container, r) => {
  const detail = r.stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^###erplora-\d+$/.test(l))
    .join(' ');
  return (
    `the psql session against container \`${container}\` died before Postgres judged the SQL ` +
    '(container removed by another job, or stopped?): NOTHING was verified — this is an ' +
    `infrastructure failure, not a module defect. Docker/psql said: ${detail || '(no output)'}`
  );
};

// Everything goes to Postgres in ONE session per module: a `docker exec` costs about a second and a
// module declares dozens of statements, which is the difference between a gate the 24 repos can run
// on every push and one nobody turns on. `\warn` writes the marker to STDERR, the same stream the
// errors come out of, so the two stay interleaved and each failure keeps its owner.
const MARK = (i) => `###erplora-${i}`;

/** Splits a psql stderr into the segment produced by each marked statement. */
function segmentsByMarker(stderr, count) {
  const segments = Array.from({ length: count }, () => '');
  let current = -1;
  for (const line of stderr.split('\n')) {
    const hit = /^###erplora-(\d+)$/.exec(line.trim());
    if (hit) {
      current = Number(hit[1]);
      continue;
    }
    if (current >= 0 && current < count) segments[current] += line + '\n';
  }
  return segments;
}

// ── the check ───────────────────────────────────────────────────────────────────────────────

function readRel(dir, rel) {
  const p = isAbsolute(rel) ? rel : join(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Statements declared by a command/query: [{ file, sql }]. Inline SQL is supported too. */
function declaredStatements(dir, value) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    if (/\.sql$/i.test(item.trim())) {
      const sql = readRel(dir, item.trim());
      if (sql != null) out.push({ file: item.trim(), sql });
    } else {
      out.push({ file: '<inline>', sql: item });
    }
  }
  return out;
}

/**
 * PREPAREs every statement the module declares against a real Postgres.
 *
 * Returns `{ skipped, reason, prepared, errors, warnings, results }`. `skipped: true` means NOTHING
 * was verified (no Docker / no container) — the caller must say so out loud rather than count it as
 * a pass.
 */
export async function checkPrepare(dir, manifest, { container = defaultContainer(), exec = run } = {}) {
  const out = { skipped: false, reason: null, prepared: 0, errors: [], warnings: [], results: [] };

  if (!(await pgAvailable(container, exec))) {
    out.skipped = true;
    out.reason =
      `no hay un Postgres accesible en el contenedor \`${container}\` (docker ausente o contenedor parado): ` +
      'NO se ha comprobado que el SQL prepare. Arranca uno (`docker run -d --name ' +
      `${container} -e POSTGRES_PASSWORD=postgres -p 5433:5432 postgres:18\`) o exporta ` +
      'ERPLORA_TEST_PG_CONTAINER.';
    return out;
  }

  const db = `erplora_validate_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const created = await exec('docker', ['exec', container, 'createdb', '-U', 'postgres', db]);
  if (created.code !== 0) {
    out.skipped = true;
    out.reason = `no se pudo crear la BD de scratch en \`${container}\`: ${created.stderr.trim()}`;
    return out;
  }

  try {
    // 1) The scratch schema: the module's own migrations, in order, in one session.
    const migrations = [];
    for (const rel of migrationFiles(manifest)) {
      const sql = readRel(dir, rel);
      if (sql == null) {
        out.errors.push(`migración declarada y ausente del disco: ${rel}`);
        continue;
      }
      migrations.push({ rel, sql: shimDdlTypes(sql) });
    }
    if (migrations.length) {
      const script = migrations.map((m, i) => `\\warn ${MARK(i)}\n${m.sql}\n`).join('\n');
      const r = await psql(exec, container, db, script);
      if (transportFailure(r)) {
        out.skipped = true;
        out.reason = transportReason(container, r);
        return out;
      }
      if (r.code !== 0) {
        const segments = segmentsByMarker(r.stderr, migrations.length);
        const failed = segments.findIndex((s) => s.includes('ERROR:'));
        const which = failed >= 0 ? migrations[failed].rel : '(desconocida)';
        out.errors.push(`la migración ${which} no aplica en Postgres: ${pgError(r.stderr)}`);
        // Everything downstream would fail for the wrong reason.
        return out;
      }
    }

    // 2) Every declared statement, prepared in a single session and reported one by one.
    const moduleId = manifest?.id ?? '';
    const statements = [];
    for (const coll of ['queries', 'commands']) {
      for (const [key, def] of Object.entries(manifest?.[coll] ?? {})) {
        if (!def) continue;
        const schema = def.schema ? safeJson(readRel(dir, def.schema)) : null;
        for (const { file, sql } of declaredStatements(dir, def.sql)) {
          const { sql: translated, names } = translateForPostgres(sql);
          statements.push({ key, file, sql: translated, names, types: pgParamTypes(names, schema) });
        }
      }
    }
    if (!statements.length) return out;

    const script = statements
      .map((s, i) => `\\warn ${MARK(i)}\n${prepareHeader(`s${i}`, s.types)} ${stripTrailingSemicolon(s.sql)};\n`)
      .join('\n');
    const r = await psql(exec, container, db, script, { stopOnError: false });
    if (transportFailure(r)) {
      out.skipped = true;
      out.reason = transportReason(container, r);
      return out;
    }
    const segments = segmentsByMarker(r.stderr, statements.length);

    statements.forEach(({ key, file, types, names }, i) => {
      const segment = segments[i] ?? '';
      if (!segment.includes('ERROR:')) {
        out.prepared++;
        out.results.push({ key, file, ok: true });
        return;
      }
      const err = pgError(segment);
      const foreign = foreignTable(err, moduleId);
      if (foreign) {
        out.warnings.push(
          `${key} [${file}] no verificado: usa la tabla \`${foreign}\`, que no es de este módulo ` +
            '(otro módulo o el core) y no existe en la BD de scratch.',
        );
        out.results.push({ key, file, ok: null, error: err });
        return;
      }
      const unknown = undeclaredBindInvolved(segment, err, types, names);
      if (unknown) {
        out.warnings.push(
          `${key} [${file}] no verificado: el fallo depende del tipo de \`:${unknown}\`, que nadie ` +
            'declara — el runtime lo manda con el tipo JSON que use el caller (número → bigint, ' +
            'texto → text), así que aquí puede fallar y en un hub preparar. Declara el `schema` del ' +
            `comando para que se compruebe de verdad. Postgres dijo: ${err}`,
        );
        out.results.push({ key, file, ok: null, error: err });
        return;
      }
      out.errors.push(`${key} [${file}] — Postgres no puede PREPARAR la sentencia: ${err}`);
      out.results.push({ key, file, ok: false, error: err });
    });
  } finally {
    await exec('docker', ['exec', container, 'dropdb', '-U', 'postgres', '--force', db]);
  }
  return out;
}

function safeJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripTrailingSemicolon(sql) {
  return sql.replace(/;\s*$/, '');
}

/**
 * Name of an UNDECLARED bind the failure hangs on, or null when the SQL is wrong on its own.
 *
 * This is the line between "the module is broken" and "this check cannot know". A bind nobody
 * declared travels with whatever JSON type the caller used (`hub/crates/db/src/lib.rs`), so
 * Postgres deducing something else here proves nothing — `invoice` concatenates `:year` and also
 * compares it with an INTEGER column (deduced text → `bigint = text`), `cash_register` assigns
 * `:closing_balance` to a BIGINT column and subtracts it from a SUM (`inconsistent types deduced`),
 * and both work in every hub. Three signals, in order of how much they actually tell us:
 *
 *   1. `could not determine data type of parameter $N` is NEVER excused: that is the runtime's own
 *      situation when the value arrives null (OID 0, `DynNull`) — the exact 42P08 that killed
 *      `appointments` and `tasks`. A declared type would only paper over it.
 *   2. an error that NAMES a parameter (`inconsistent types deduced for parameter $2`) is about
 *      that parameter: excused if nobody declared its type.
 *   3. otherwise the failure is only excusable if it is ABOUT TYPES at all (`operator does not
 *      exist`, `function … does not exist`, `column is of type X but expression is of type Y`) AND
 *      the `LINE …` Postgres echoes back touches an undeclared parameter. Anything structural —
 *      `column reference "x" is ambiguous`, `column does not exist`, a syntax error — is a hard
 *      error whatever sits on that line: no caller, no declared type and no JSON shape can make it
 *      parse. That is what keeps `reservations#19` failing here too, instead of the second door
 *      repeating the hole of the first. And it is what keeps `whatsapp_inbox#24`
 *      (`m.created_at >= erp_month_start(:now)`, with `:now` always injected typed) a hard error.
 */
const TYPE_RESOLUTION_ERROR =
  /operator does not exist|function [^(]*\([^)]*\) does not exist|is of type [^ ]+ but expression is of type|inconsistent types deduced|could not identify an? (?:equality|ordering) operator|cannot determine type/i;

export function undeclaredBindInvolved(segment, err, types, names) {
  const undeclared = new Set(names.map((n, i) => (types[i] ? null : i + 1)).filter(Boolean));
  if (!undeclared.size) return null;
  if (/could not determine data type of parameter/i.test(err)) return null;

  const named = /parameter \$(\d+)/i.exec(err);
  if (named) return undeclared.has(Number(named[1])) ? names[Number(named[1]) - 1] : null;
  if (!TYPE_RESOLUTION_ERROR.test(err)) return null;

  const lines = segment.split('\n').filter((l) => /^LINE \d+:/.test(l.trim()));
  if (!lines.length) return null;
  for (const line of lines) {
    for (const hit of line.matchAll(/\$(\d+)/g)) {
      const idx = Number(hit[1]);
      if (undeclared.has(idx)) return names[idx - 1];
    }
  }
  return null;
}

/** The table name of a `relation "x" does not exist` that this module does NOT own, or null. */
function foreignTable(err, moduleId) {
  const hit = /relation "([^"]+)" does not exist/.exec(err);
  if (!hit) return null;
  const table = hit[1];
  if (moduleId && table.startsWith(`${moduleId}_`)) return null; // its own: a real error
  return table;
}
