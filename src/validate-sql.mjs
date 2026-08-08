// Validador de "ERPlora SQL" portable (ADR-0007 punto 3).
//
// Linter LÉXICO (NO parser AST), misma filosofía que el shim del runtime
// (hub/crates/db/src/lib.rs): escaneo carácter a carácter respetando literales `'...'`
// y comentarios SQL (`-- ...` y `/* ... */`), regex anclados a palabra completa. Rechaza
// las construcciones no portables del ADR-0007 con error de validación (no warning), salvo
// la heurística de dinero que es WARNING configurable (ver `MONEY_RULE`).
//
// Escanea TODO el SQL de un módulo:
//   - migraciones (module.json `migrations.postgres` → .sql),
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
// TODO (columna del HUMANO): el ADR-0007 enumera estos sets solo con EJEMPLOS ("p.ej.
// erp_now()/erp_lpad()") y NO los cierra del todo. Aquí se replica EXACTAMENTE lo que el
// shim soporta HOY. Ampliar/cerrar este set definitivo es decisión del humano y, cuando se
// decida, hay que cambiarlo a la vez en DOS sitios: este fichero y `BRIDGE_FUNCTIONS` del
// runtime. Idealmente un único punto de verdad en el futuro (p.ej. un JSON compartido).
// ─────────────────────────────────────────────────────────────────────────────────────────

/** Funciones-puente `erp_*` que el shim del runtime sabe reescribir. Set CERRADO:
 *  cualquier `erp_*` fuera de aquí es un error de validación. Espejo de `BRIDGE_FUNCTIONS`
 *  (`hub/crates/db/src/lib.rs`).
 *
 *  Este espejo se había quedado en 3 de las 11 que el shim implementa de verdad, así que el
 *  validador rechazaba SQL PORTABLE: `erplora validate modules/sales` fallaba con «función-puente
 *  desconocida `erp_date`». Y como el SQL se valida ANTES que los schemas, ningún módulo que usara
 *  una función de fecha llegaba siquiera a que le revisaran el dinero. */
export const BRIDGE_FUNCTIONS = [
  'erp_now', 'erp_lpad', 'erp_pad', 'erp_dt', 'erp_date', 'erp_dateadd',
  'erp_month_start', 'erp_dow_mon0', 'erp_extract', 'erp_datediff_days', 'erp_timefmt',
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

// ── hub#513: aislamiento de tablas por módulo ───────────────────────────────────────────
//
// El SQL declarativo de un módulo se ejecuta TAL CUAL contra la BD del hub. Sin una guarda, un
// `command` puede llevar `UPDATE hub_user SET role='admin'` o `DELETE FROM _elevation_audit` y el
// dispatcher lo ejecuta. El permiso que se comprueba es el que el PROPIO módulo declaró para ese
// command (ADR-0263, hub#513), así que nada defiende al core.
//
// El contrato (que hoy solo se cumple por costumbre): toda tabla que un módulo crea, lee o escribe
// empieza por `<module_id>_`. Esta regla lo hace ruidoso en build, en vez de intentar cazarlo en
// runtime (no se reescribe el SQL — ADR-0007 curó un subconjunto, no un parser).
//
// Dos niveles (decididos tras MEDIR sobre los 24 módulos del catálogo, como pide la issue):
//   · ERROR (allowlist de tablas protegidas del core/sistema): `hub_*` y el set cerrado de tablas
//     de sistema del runtime (`_*` que el runtime posee). Medir mostró que `_*` a secas rompe
//     `taxes` (crea `_taxes_backfill_hubs` como TEMP legítima), así que NO se marca toda `_*`:
//     solo el set conocido de tablas del runtime. `hub_*` sí entero (0 falsos positivos en 24
//     módulos: ningún módulo crea tablas `hub_`).
//   · WARNING: una tabla que no empieza por `<module_id>_` y no es del core. La medición mostró
//     que el único cruce REAL es `inventory→sales_sale_item` (4 avisos); el resto son CTE/alias
//     (`cfg`, `slots`, `win`) que un linter léxico no puede distinguir de tablas persistidas sin
//     trackear `WITH … AS`. Por eso es WARNING (informativo), no ERROR.
const PROTECTED_TABLE_RE = /^hub_/;
const RUNTIME_SYSTEM_TABLES = new Set([
  '_scheduled_tasks',
  '_event_outbox',
  '_elevation_audit',
  '_print_queue',
  '_print_hosts',
  '_hub_certificate',
  '_hub_migrations',
  '_hub_fiscal_profile',
]);

/**
 * Extrae los identificadores en posición de tabla de un SQL enmascarado. Devuelve
 * `[{name, offset, write}]` donde `write` es `true` para cláusulas que MUTAN la tabla
 * (`INSERT INTO`, `UPDATE`, `DELETE FROM`, `CREATE/ALTER/DROP TABLE`) y `false` para lectura
 * (`FROM`, `JOIN`). La distinción importa: leer `hub_settings` es legítimo (ADR-0085 expone la
 * identidad fiscal del hub a los módulos), pero escribir en `hub_user` nunca lo es.
 *
 * No es un parser: captura el primer identificador tras la palabra clave, saltando `IF [NOT]
 * EXISTS`, `TEMPORARY`/`TEMP` y cualificación de esquema (`schema.t` → `t`). Suficiente para el
 * contrato `<module_id>_` (ADR-0263, hub#513).
 */
function tableIdentifiers(masked) {
  const out = [];
  // Cláusulas DML + DDL donde el primer identificador tras la palabra clave es (o contiene) el
  // nombre de la tabla. Exclusiones léxicas para no dar falsos positivos:
  //   · `UPDATE SET` (de `ON CONFLICT … DO UPDATE SET col=…`) — `SET` es palabra clave, no tabla.
  //   · `JOIN LATERAL` / `JOIN INNER` / etc. — esas son palabras clave del join, no tabla.
  // Grupo 1 = el verbo (para saber si es escritura); grupo 2 = nombre (posiblemente cualificado).
  const re = /\b(FROM|JOIN(?!\s+(?:LATERAL|CROSS|NATURAL|STRAIGHT_JOIN|INNER|LEFT|RIGHT|OUTER|FULL|USING|ON))|INTO|UPDATE(?!\s*SET)|TABLE)\b\s*(?:IF\s+(?:NOT\s+)?EXISTS\s*)?(?:TEMP(?:ORARY)?\s*)?(?:OR\s+REPLACE\s*)?(?:VIEW\s*)?([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)?)/gi;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const verb = m[1].toUpperCase();
    const write = verb === 'INTO' || verb === 'UPDATE' || verb === 'TABLE';
    // `schema.table` → nos quedamos con la parte de la tabla (tras el último punto).
    const qualified = m[2];
    const dot = qualified.lastIndexOf('.');
    const name = dot >= 0 ? qualified.slice(dot + 1).trim() : qualified;
    const offset = m.index + m[0].lastIndexOf(name);
    out.push({ name, offset, write });
  }
  return out;
}

/**
 * Regla de aislamiento de tablas (hub#513). `ctx.moduleId` es el prefijo esperado; sin él la regla
 * solo aplica la allowlist de tablas protegidas (no puede juzgar el prefijo de módulo).
 */
function ruleTableScope(masked, original, findings, ctx) {
  const moduleId = ctx?.moduleId;
  const prefix = moduleId ? `${moduleId}_` : null;
  for (const { name, offset, write } of tableIdentifiers(masked)) {
    const lower = name.toLowerCase();
    const isSystem = RUNTIME_SYSTEM_TABLES.has(lower);

    // 1) Tablas de sistema del runtime (`_*`): auditoría, colas, migraciones. Trazabilidad y
    //    secretos que un módulo no toca jamás, ni en lectura ni en escritura → ERROR.
    if (isSystem) {
      findings.push({
        line: lineAt(original, offset),
        kind: `tabla de sistema \`${name}\``,
        snippet: snippetAt(original, offset, 28),
        suggestion:
          'un módulo no toca las tablas internas del runtime (_elevation_audit, _print_queue…); son trazabilidad/secretos',
        level: 'error',
      });
      continue;
    }

    // 2) Tablas del core `hub_*`:
    //    · ESCRITURA (INSERT/UPDATE/DELETE/CREATE) → siempre ERROR. Un módulo no reescribe la
    //      identidad del negocio ni las cuentas de usuario.
    //    · LECTURA (FROM/JOIN) → WARNING. El runtime expone tablas de referencia del core a los
    //      módulos por diseño (ADR-0085: `hub_settings.country_code`; `hub_country` para impuestos).
    //      Es lectura tolerada; el WARNING invita a revisarla pero no rompe el build, porque la
    //      medición sobre los 24 módulos mostró que `taxes` lo hace documentado.
    if (PROTECTED_TABLE_RE.test(name)) {
      findings.push({
        line: lineAt(original, offset),
        kind: write ? `\`${name}\` (escritura en tabla del core)` : `\`${name}\` (lectura de tabla del core)`,
        snippet: snippetAt(original, offset, 28),
        suggestion: write
          ? 'un módulo no ESCRIBE en tablas del core (hub_*); la identidad del negocio la gestiona el runtime'
          : 'lectura de una tabla del core (hub_*); revísala — si es referencia legítima (hub_settings, hub_country), el WARNING es solo informativo',
        level: write ? 'error' : 'warning',
      });
      continue;
    }

    // 3) Fuera de prefijo de módulo → WARNING (informativo). La medición sobre el catálogo mostró
    //    que el único cruce real es inventory→sales_sale_item; el resto son CTE/alias que un linter
    //    léxico (sin AST) no puede distinguir de tablas persistidas. Por eso WARNING, no ERROR.
    if (prefix && !lower.startsWith(prefix.toLowerCase())) {
      findings.push({
        line: lineAt(original, offset),
        kind: `tabla \`${name}\` sin el prefijo del módulo \`${moduleId}_\``,
        snippet: snippetAt(original, offset, 28),
        suggestion:
          `las tablas de un módulo empiezan por \`${moduleId}_\` (contrato de aislamiento, ADR-0263); ` +
          `si es una CTE o un alias, ignora este aviso (un linter léxico no las distingue)`,
        level: 'warning',
      });
    }
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
  ruleTableScope,
];

/**
 * Escanea UN fragmento de SQL. Devuelve un array de findings (con `level: 'error'|'warning'`).
 * `source` es la etiqueta de origen para el reporte (fichero o module.json#clave).
 *
 * `ctx` (opcional) lleva el contexto que alguna regla necesita y que el SQL por sí solo no da:
 * hoy, `moduleId` (para la regla de aislamiento de tablas de hub#513). Sin `ctx`, esa regla solo
 * aplica la denylist dura del core (no puede juzgar el prefijo de módulo).
 */
export function lintSql(sql, source = '<sql>', ctx) {
  const masked = maskLiteralsAndComments(sql);
  const findings = [];
  for (const rule of RULES) rule(masked, sql, findings, ctx);
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

  // Migraciones: { postgres: [...] } — dialecto único (ADR-0154). SQLite quedó deprecado;
  // sus ficheros (si aún existen en transición) no se lintan.
  const migs = manifest.migrations || {};
  for (const dialect of ['postgres']) {
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
  // ctx para la regla de aislamiento de tablas (hub#513): el prefijo esperado es el id del módulo.
  const ctx = manifest?.id ? { moduleId: manifest.id } : undefined;
  const all = [];
  for (const { sql, source } of entries) all.push(...lintSql(sql, source, ctx));

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
