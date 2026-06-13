// Validador de "ERPlora SQL" portable (ADR-0007 punto 3).
//
// Linter LÉXICO (NO parser AST), misma filosofía que el shim del runtime
// (hub/crates/db/src/lib.rs): escaneo carácter a carácter respetando literales `'...'`
// y comentarios SQL (`-- ...` y `/* ... */`), regex anclados a palabra completa. Rechaza
// las construcciones no portables del ADR-0007 con error de validación (no warning), salvo
// la heurística de dinero que es WARNING configurable (ver `MONEY_RULE`).
//
// Escanea TODO el SQL de un módulo:
//   - migraciones de AMBOS dialectos (module.json `migrations.{sqlite,postgres}` → .sql),
//   - queries/commands (`sql` puede ser string inline o ruta .sql, o array de ellas).
//
// Reporta: fichero (o "module.json#<clave>" para SQL inline) + módulo + línea + construcción
// + sugerencia.

import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────────────────
// SET PORTABLE — debe mantenerse SINCRONIZADO con el shim del runtime
// (hub/crates/db/src/lib.rs: `BRIDGE_FUNCTIONS` y `normalize_ddl_type`).
//
// REGLA VINCULANTE: este set DEBE coincidir EXACTAMENTE con `BRIDGE_FUNCTIONS` del shim del
// runtime (`hub/crates/db/src/lib.rs`). Si se añade/quita una función-puente, hay que cambiarla
// a la vez en LOS DOS sitios o el validador y el runtime se desincronizan (el validador
// aceptaría algo que el runtime no sabe reescribir, o al revés). Idealmente un único punto de
// verdad en el futuro (p.ej. un JSON compartido).
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Funciones-puente `erp_*` que el shim del runtime sabe reescribir. Set CERRADO:
 *  cualquier `erp_*` fuera de aquí es un error de validación. Espejo EXACTO de
 *  `BRIDGE_FUNCTIONS` del shim (hub/crates/db/src/lib.rs):
 *   - string/número: erp_now, erp_pad, erp_lpad
 *   - fecha/hora (fechas TEXT ISO-8601): erp_dt (normaliza a datetime comparable),
 *     erp_date (parte fecha), erp_dateadd (suma intervalo), erp_month_start (inicio de mes),
 *     erp_dow_mon0 (día de semana 0=lunes…6=domingo), erp_extract (extrae hour/minute/…),
 *     erp_datediff_days (diferencia fraccionaria en días), erp_timefmt (formatea HH:MM). */
export const BRIDGE_FUNCTIONS = [
  'erp_now',
  'erp_lpad',
  'erp_pad',
  'erp_dt',
  'erp_date',
  'erp_dateadd',
  'erp_month_start',
  'erp_dow_mon0',
  'erp_extract',
  'erp_datediff_days',
  'erp_timefmt',
];

/** Tipos del subconjunto portable admitidos en DDL (`CREATE TABLE`). Espejo de las claves
 *  de `normalize_ddl_type` del shim. Todo lo demás en posición de tipo es no portable. */
export const PORTABLE_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB'];

/** Tipos NO portables frecuentes → con sugerencia de reemplazo del subconjunto portable. */
const NON_PORTABLE_TYPES = {
  TIMESTAMPTZ: 'TEXT (fecha ISO-8601)',
  TIMESTAMP: 'TEXT (fecha ISO-8601)',
  DATETIME: 'TEXT (fecha ISO-8601)',
  DATE: 'TEXT (fecha ISO-8601)',
  TIME: 'TEXT (fecha ISO-8601)',
  NUMERIC: 'INTEGER (dinero en céntimos) o REAL',
  DECIMAL: 'INTEGER (dinero en céntimos) o REAL',
  MONEY: 'INTEGER (dinero en céntimos)',
  VARCHAR: 'TEXT',
  CHAR: 'TEXT',
  NVARCHAR: 'TEXT',
  BOOLEAN: 'INTEGER (0/1)',
  BOOL: 'INTEGER (0/1)',
  SERIAL: 'TEXT (UUID generado en Rust) — no autoincrement',
  BIGSERIAL: 'TEXT (UUID generado en Rust) — no autoincrement',
  FLOAT: 'REAL',
  DOUBLE: 'REAL',
  UUID: 'TEXT',
  JSON: 'TEXT',
  JSONB: 'TEXT',
  BYTEA: 'BLOB',
};

/** Funciones de fecha/string NO portables (SQLite-isms / PG-isms) → sugerencia. */
const NON_PORTABLE_FUNCS = {
  strftime: 'función-puente erp_* o fechas TEXT ISO-8601 comparadas como string',
  printf: 'erp_pad()/erp_lpad() para padding',
  datetime: 'fechas TEXT ISO-8601 (no datetime() de SQLite)',
  julianday: 'fechas TEXT ISO-8601',
  to_char: 'fechas TEXT ISO-8601 / formateo en la capa UI',
  json_each: 'evitar (no portable); modelar la relación en tabla',
  // (printf/strftime también los puede generar el shim, pero el AUTOR no debe escribirlos)
};

// Cómo tratar la heurística de dinero (columnas *_cents/price/amount declaradas REAL/NUMERIC).
// 'warn' (por defecto) = WARNING; 'error' = falla; 'off' = no comprobar.
// Es WARNING por defecto porque distinguir una columna "de dinero" por su nombre es heurístico
// y puede dar falsos positivos (p.ej. `weight REAL` no es dinero). NUMERIC/DECIMAL ya fallan
// por la regla de tipos; esta heurística añade el caso REAL para nombres claramente monetarios.
export const MONEY_RULE = process.env.ERPLORA_MONEY_RULE || 'warn';

// ─────────────────────────────────────────────────────────────────────────────────────────
// Tokenización léxica: aplana literales y comentarios para no producir falsos positivos.
// Devuelve una copia del SQL donde:
//   - el contenido de literales `'...'` se sustituye por espacios (preservando longitud/líneas),
//   - los comentarios `-- ...` y `/* ... */` se sustituyen por espacios,
// de modo que los offsets/líneas coinciden 1:1 con el original (para reportar la línea real).
// ─────────────────────────────────────────────────────────────────────────────────────────

function maskLiteralsAndComments(sql) {
  const out = Buffer.from(sql, 'utf8'); // trabajamos byte a byte (ASCII para tokens; resto se preserva)
  const chars = sql.split('');
  const n = chars.length;
  let i = 0;
  const blank = (k) => {
    // No pisar saltos de línea: preservar \n para que el conteo de líneas sea exacto.
    if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' ';
  };
  while (i < n) {
    const c = chars[i];
    const c2 = chars[i + 1];
    // Comentario de línea --
    if (c === '-' && c2 === '-') {
      while (i < n && chars[i] !== '\n') {
        blank(i);
        i++;
      }
      continue;
    }
    // Comentario de bloque /* ... */
    if (c === '/' && c2 === '*') {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < n && !(chars[i] === '*' && chars[i + 1] === '/')) {
        blank(i);
        i++;
      }
      if (i < n) {
        blank(i);
        blank(i + 1);
        i += 2;
      }
      continue;
    }
    // Literal de cadena '...'  (con '' como comilla escapada interna)
    if (c === "'") {
      blank(i); // la comilla de apertura
      i++;
      while (i < n) {
        if (chars[i] === "'") {
          if (chars[i + 1] === "'") {
            blank(i);
            blank(i + 1);
            i += 2;
            continue;
          }
          blank(i); // comilla de cierre
          i++;
          break;
        }
        blank(i);
        i++;
      }
      continue;
    }
    i++;
  }
  void out;
  return chars.join('');
}

/** Línea (1-based) de un offset en el texto original. */
function lineAt(sql, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < sql.length; k++) {
    if (sql[k] === '\n') line++;
  }
  return line;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reglas. Cada una recibe (masked, original) y empuja {line, kind, snippet, suggestion, level}.
// `masked` = SQL con literales/comentarios en blanco; `original` = para extraer el snippet real.
// ─────────────────────────────────────────────────────────────────────────────────────────

function snippetAt(original, offset, len = 24) {
  return original.slice(offset, offset + len).replace(/\s+/g, ' ').trim();
}

function findAll(masked, re) {
  const hits = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(masked)) !== null) {
    hits.push({ index: m.index, match: m[0], groups: m });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return hits;
}

function ruleNoPositionalPlaceholders(masked, original, findings) {
  // `?` posicional o `?n`. Fuera de literales/comentarios ya está enmascarado.
  // El estilo portable del repo es `:name` (named params; el runtime los baja a $n/?n).
  for (const h of findAll(masked, /\?/g)) {
    findings.push({
      line: lineAt(original, h.index),
      kind: 'placeholder posicional `?`',
      snippet: snippetAt(original, Math.max(0, h.index - 4), 20),
      suggestion: "usa parámetros con nombre `:name` (estilo portable del repo; el runtime los traduce a $n/?n)",
      level: 'error',
    });
  }
}

function ruleNoInsertOrReplace(masked, original, findings) {
  for (const h of findAll(masked, /\bINSERT\s+OR\s+(REPLACE|IGNORE)\b/gi)) {
    const verb = /IGNORE/i.test(h.match) ? 'IGNORE' : 'REPLACE';
    findings.push({
      line: lineAt(original, h.index),
      kind: `\`INSERT OR ${verb}\``,
      snippet: snippetAt(original, h.index, 24),
      suggestion:
        verb === 'IGNORE'
          ? 'usa `INSERT ... ON CONFLICT (...) DO NOTHING`'
          : 'usa `INSERT ... ON CONFLICT (...) DO UPDATE SET ...`',
      level: 'error',
    });
  }
}

function ruleNoAutoincrementSerial(masked, original, findings) {
  for (const h of findAll(masked, /\b(AUTOINCREMENT|BIGSERIAL|SERIAL)\b/gi)) {
    findings.push({
      line: lineAt(original, h.index),
      kind: `\`${h.match.toUpperCase()}\``,
      snippet: snippetAt(original, h.index, 24),
      suggestion: 'PK `TEXT` con UUID generado en Rust (no autoincremento del motor)',
      level: 'error',
    });
  }
}

// Conjunto de TODAS las palabras-tipo conocidas (portables + no portables), en mayúsculas, para
// la desambiguación "columna vs tipo": un token-tipo seguido de OTRO token-tipo es un NOMBRE de
// columna (`time TEXT`, `timestamp TEXT`, `date INTEGER`), no un tipo.
const ALL_TYPE_WORDS = new Set([...PORTABLE_TYPES, ...Object.keys(NON_PORTABLE_TYPES)]);

// Tipos no portables que SÍ pueden llevar args con paréntesis `T(...)` (precisión/escala/longitud).
// Para estos, `T(` sigue siendo un tipo y debe marcarse. El resto seguido de `(` es función
// (la cubre la regla de funciones), no tipo → se omite aquí para no doblar el reporte.
const TYPES_WITH_PARENS = new Set(['NUMERIC', 'DECIMAL', 'VARCHAR', 'CHAR', 'NVARCHAR', 'MONEY']);

/** Siguiente token-palabra (identificador ASCII) a partir de `from`, o null. */
function nextWord(masked, from) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked.slice(from));
  return m ? m[1] : null;
}

/**
 * Localiza los bloques de columnas de cada `CREATE TABLE … ( … )` / `ALTER TABLE … ADD … ( … )`
 * (con escaneo de paréntesis balanceados). Devuelve [{start, end}] como offsets ABSOLUTOS sobre
 * `masked` (el span INTERIOR de los paréntesis). Igual ámbito que el shim del runtime
 * (`shim_ddl_types`): los tipos sólo importan AHÍ; en DML `date`/`time`/`timestamp` son columnas.
 */
function ddlColumnBlocks(masked) {
  const blocks = [];
  const re = /\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\b|\bALTER\s+TABLE\b/gi;
  let m;
  while ((m = re.exec(masked)) !== null) {
    // Encuentra el primer `(` tras la cláusula y escanea balanceado.
    let p = m.index + m[0].length;
    while (p < masked.length && masked[p] !== '(' && masked[p] !== ';') p++;
    if (masked[p] !== '(') continue;
    let depth = 0;
    let i = p;
    for (; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) blocks.push({ start: p + 1, end: i });
  }
  return blocks;
}

function ruleNonPortableTypes(masked, original, findings) {
  // Tipos no portables como palabra completa, SÓLO dentro del bloque de columnas de un
  // CREATE/ALTER TABLE (idéntico ámbito que el shim del runtime). Fuera de DDL, `date`/`time`/
  // `timestamp` son NOMBRES de columna, no tipos → no se tocan. Heurística adicional:
  //   - si el token va seguido de `(`: sólo es tipo si admite args (NUMERIC/DECIMAL/VARCHAR…).
  //   - si el SIGUIENTE token-palabra es a su vez una palabra-tipo (`time TEXT`), entonces ESTE
  //     token es el NOMBRE de la columna, no el tipo → se omite.
  const blocks = ddlColumnBlocks(masked);
  if (!blocks.length) return;
  const names = Object.keys(NON_PORTABLE_TYPES).join('|');
  const re = new RegExp(`\\b(${names})\\b`, 'gi');
  for (const h of findAll(masked, re)) {
    if (!blocks.some((b) => h.index >= b.start && h.index < b.end)) continue; // fuera de DDL
    const t = h.match.toUpperCase();
    if (t === 'SERIAL' || t === 'BIGSERIAL') continue; // los cubre la regla de autoincremento

    const after = h.index + h.match.length;
    const nextNonSpace = (masked.slice(after).match(/^\s*(\S)/) || [])[1] || '';
    if (nextNonSpace === '(' && !TYPES_WITH_PARENS.has(t)) continue; // función, no tipo

    const nw = nextWord(masked, after);
    if (nw && ALL_TYPE_WORDS.has(nw.toUpperCase())) continue; // `time TEXT` → `time` es la columna

    findings.push({
      line: lineAt(original, h.index),
      kind: `tipo no portable \`${t}\``,
      snippet: snippetAt(original, h.index, 28),
      suggestion: `usa ${NON_PORTABLE_TYPES[t]} — subconjunto portable: ${PORTABLE_TYPES.join('/')}`,
      level: 'error',
    });
  }
}

function ruleNonPortableFunctions(masked, original, findings) {
  const names = Object.keys(NON_PORTABLE_FUNCS).join('|');
  // función NO portable: nombre + `(`, con el carácter previo no-identificador.
  const re = new RegExp(`(^|[^A-Za-z0-9_])(${names})\\s*\\(`, 'gi');
  for (const h of findAll(masked, re)) {
    const fn = h.groups[2].toLowerCase();
    const at = h.index + h.groups[1].length;
    findings.push({
      line: lineAt(original, at),
      kind: `función no portable \`${fn}(\``,
      snippet: snippetAt(original, at, 24),
      suggestion: NON_PORTABLE_FUNCS[fn],
      level: 'error',
    });
  }
}

function ruleUnknownErpFunctions(masked, original, findings) {
  // Cualquier `erp_xxx(` que NO esté en BRIDGE_FUNCTIONS debe fallar (set cerrado del shim).
  const re = /(^|[^A-Za-z0-9_])(erp_[a-z0-9_]+)\s*\(/gi;
  for (const h of findAll(masked, re)) {
    const fn = h.groups[2].toLowerCase();
    if (BRIDGE_FUNCTIONS.includes(fn)) continue;
    const at = h.index + h.groups[1].length;
    findings.push({
      line: lineAt(original, at),
      kind: `función-puente desconocida \`${fn}(\``,
      snippet: snippetAt(original, at, 24),
      suggestion: `el shim sólo soporta ${BRIDGE_FUNCTIONS.join('/')} — no inventes erp_* (set cerrado, ADR-0007)`,
      level: 'error',
    });
  }
}

function ruleMoneyAsFloat(masked, original, findings) {
  if (MONEY_RULE === 'off') return;
  // Heurística: columna cuyo nombre parece de dinero declarada REAL.
  // (NUMERIC/DECIMAL ya las atrapa la regla de tipos; aquí cubrimos el REAL "silencioso".)
  // Patrón: <nombre_dinero> ... REAL  en la misma definición de columna (hasta coma/paréntesis).
  const re = /\b([a-z_][a-z0-9_]*(?:price|amount|cost|total|cents|subtotal|tax|fee|balance|paid|due))\b\s+REAL\b/gi;
  for (const h of findAll(masked, re)) {
    findings.push({
      line: lineAt(original, h.index),
      kind: `columna de dinero \`${h.groups[1]}\` declarada REAL`,
      snippet: snippetAt(original, h.index, 32),
      suggestion: 'dinero = INTEGER en céntimos (exacto en ambos motores); REAL acumula error de redondeo',
      level: MONEY_RULE === 'error' ? 'error' : 'warning',
    });
  }
}

const RULES = [
  ruleNoPositionalPlaceholders,
  ruleNoInsertOrReplace,
  ruleNoAutoincrementSerial,
  ruleNonPortableTypes,
  ruleNonPortableFunctions,
  ruleUnknownErpFunctions,
  ruleMoneyAsFloat,
];

/**
 * Escanea UN fragmento de SQL. Devuelve un array de findings (con `level: 'error'|'warning'`).
 * `source` es la etiqueta de origen para el reporte (fichero o module.json#clave).
 */
export function lintSql(sql, source = '<sql>') {
  const masked = maskLiteralsAndComments(sql);
  const findings = [];
  for (const rule of RULES) rule(masked, sql, findings);
  for (const f of findings) f.source = source;
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// Recolección del SQL de un módulo (migraciones + queries + commands; inline o .sql).
// ─────────────────────────────────────────────────────────────────────────────────────────

function readSqlFile(dir, relPath) {
  const p = isAbsolute(relPath) ? relPath : join(dir, relPath);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

/** Normaliza un valor `sql` (string inline, ruta .sql, o array de ambos) a una lista de
 *  fragmentos {sql, source}. */
function collectSqlEntries(value, dir, label) {
  const arr = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = [];
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const looksLikePath = /\.sql$/i.test(item.trim());
    if (looksLikePath) {
      const sql = readSqlFile(dir, item.trim());
      if (sql != null) out.push({ sql, source: item.trim() });
      // si el .sql no existe lo ignoramos: la validación de manifest/existencia es otra capa
    } else {
      out.push({ sql: item, source: `module.json#${label}` });
    }
  }
  return out;
}

/**
 * Reúne TODOS los fragmentos de SQL del módulo: migraciones de ambos dialectos + queries +
 * commands. Devuelve [{sql, source}].
 */
export function collectModuleSql(dir, manifest) {
  const entries = [];

  // Migraciones: { sqlite: [...], postgres: [...] } — ambos dialectos.
  const migs = manifest.migrations || {};
  for (const dialect of ['sqlite', 'postgres']) {
    for (const rel of migs[dialect] || []) {
      const sql = readSqlFile(dir, rel);
      if (sql != null) entries.push({ sql, source: rel });
    }
  }

  // Queries y commands: cada entrada tiene `sql` (inline | ruta | array).
  for (const coll of ['queries', 'commands']) {
    const obj = manifest[coll] || {};
    for (const [name, def] of Object.entries(obj)) {
      if (!def || def.sql == null) continue;
      entries.push(...collectSqlEntries(def.sql, dir, `${coll}.${name}`));
    }
  }

  return entries;
}

/**
 * Valida el SQL portable de un módulo. Lanza Error si hay findings de nivel `error`.
 * Devuelve { errors, warnings } (arrays de findings) para que el caller los muestre.
 * Imprime los warnings (no bloquean).
 */
export function validateSql(dir, manifest, { print = true } = {}) {
  const entries = collectModuleSql(dir, manifest);
  const all = [];
  for (const { sql, source } of entries) all.push(...lintSql(sql, source));

  const errors = all.filter((f) => f.level === 'error');
  const warnings = all.filter((f) => f.level === 'warning');

  if (print && warnings.length) {
    for (const w of warnings) {
      console.warn(
        `  ⚠ [${manifest.id}] ${w.source}:${w.line} — ${w.kind}: \`${w.snippet}\` → ${w.suggestion}`,
      );
    }
  }

  if (errors.length) {
    const lines = errors.map(
      (e) => `${e.source}:${e.line} — ${e.kind}: \`${e.snippet}\` → ${e.suggestion}`,
    );
    throw new Error(
      `SQL no portable (ADR-0007) en módulo '${manifest.id}':\n  - ` + lines.join('\n  - '),
    );
  }

  return { errors, warnings };
}
