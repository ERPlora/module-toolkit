// Guardarraíles de compatibilidad Postgres (auditoría pm#16, 2026-07-17).
//
// La familia que mató 4 P0 en Hub Cloud (QA sectorial 07-16): SQLite tolera lo que
// Postgres rechaza, y como los módulos solo se ejercitaban en SQLite, la suite local
// nunca lo vio. Tres reglas léxicas (misma filosofía que validate-sql.mjs: sin parser
// AST, enmascarando literales y comentarios):
//
//   1) `multi-statement`        — un fichero de `sql[]` de command/query se ejecuta como
//      UN prepared statement; PG rechaza multi-statement («cannot insert multiple
//      commands»). Las migraciones van por otro camino y quedan exentas. (inventory#20)
//   2) `boolean-bind`           — un bind declarado `"type": "boolean"` en el schema no
//      puede ir crudo al SQL: las columnas de flags son INTEGER 0/1 por contrato (§2.5)
//      y PG no castea boolean→bigint. Debe envolverse:
//      `CASE WHEN :x THEN 1 WHEN NOT :x THEN 0 END`. (verifactu#13)
//   3) `onconflict-unqualified` — en `ON CONFLICT … DO UPDATE SET`, la auto-referencia a
//      la columna va CUALIFICADA (`tabla.col` o `excluded.col`); sin cualificar es
//      ambigua en PG (error de parseo). (appointments#19)
import { readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

/** Enmascara literales '…' y comentarios (--, bloque) para el análisis léxico. */
function mask(sql) {
  let s = sql.replace(/'(?:[^']|'')*'/g, (m) => "'" + ' '.repeat(m.length - 2) + "'");
  s = s.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length));
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return s;
}

/** Sentencias top-level de un SQL ya enmascarado (ignora ';' finales vacíos). */
function statementCount(masked) {
  return masked.split(';').map((p) => p.trim()).filter(Boolean).length;
}

/** Nombres de props `boolean` (incluye uniones ["boolean","null"]) de un JSON Schema. */
function boolProps(schema) {
  const out = new Set();
  (function walk(node, name) {
    if (!node || typeof node !== 'object') return;
    const t = node.type;
    if (t === 'boolean' || (Array.isArray(t) && t.includes('boolean'))) {
      if (name) out.add(name);
    }
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, k);
    if (node.items) walk(node.items, name);
  })(schema);
  return [...out];
}

function readRel(dir, rel) {
  const p = isAbsolute(rel) ? rel : join(dir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Entradas {sql, source} de un valor `sql` de command/query (ruta .sql | inline | array). */
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

/**
 * Chequea las tres reglas PG sobre queries+commands del módulo.
 * Devuelve [{rule, message}].
 */
export function checkPgCompat(dir, manifest) {
  const findings = [];

  for (const coll of ['queries', 'commands']) {
    for (const [name, def] of Object.entries(manifest?.[coll] ?? {})) {
      if (!def) continue;
      const entries = sqlEntries(dir, def.sql, `${coll}.${name}`);

      // Regla 2 solo aplica a SQL directo (un handler WASM convierte en el guest).
      const isWasm = !!def.handler;
      let props = [];
      if (!isWasm && def.schema) {
        try {
          props = boolProps(JSON.parse(readRel(dir, def.schema) ?? 'null'));
        } catch {
          props = []; // schema ilegible: lo reporta validate-schemas, no esta capa
        }
      }

      for (const { sql, source } of entries) {
        const m = mask(sql);

        // 1) multi-statement
        const n = statementCount(m);
        if (n > 1) {
          findings.push({
            rule: 'multi-statement',
            message: `${source} — ${n} sentencias en un fichero de \`sql[]\`: PG lo ejecuta como UN prepared statement y lo rechaza («cannot insert multiple commands»). Trocea en un fichero por sentencia (mismo command = misma transacción).`,
          });
        }

        // 2) boolean-bind crudo
        for (const p of props) {
          const re = new RegExp(`(?<![\\w]):${p}(?![\\w])`, 'g');
          let bad = false;
          for (const hit of m.matchAll(re)) {
            const before = m.slice(Math.max(0, hit.index - 24), hit.index);
            // Se admite dentro del patrón CASE WHEN :p … / WHEN NOT :p …
            if (/(?:WHEN|NOT)\s*$/i.test(before)) continue;
            bad = true;
            break;
          }
          if (bad) {
            findings.push({
              rule: 'boolean-bind',
              message: `${source} — el bind \`:${p}\` es \`boolean\` en el schema y va CRUDO al SQL: PG no castea boolean→bigint (las columnas de flags son INTEGER 0/1, §2.5). Envuélvelo: CASE WHEN :${p} THEN 1 WHEN NOT :${p} THEN 0 END.`,
            });
          }
        }

        // 3) ON CONFLICT … DO UPDATE SET col = …col… sin cualificar
        for (const oc of m.matchAll(/ON\s+CONFLICT[\s\S]{0,120}?DO\s+UPDATE\s+SET\s+([\s\S]*?)(?:WHERE|;|$)/gi)) {
          const body = oc[1];
          for (const asg of body.matchAll(/(\w+)\s*=\s*([^,]+)/g)) {
            const [, col, rhs] = asg;
            const selfRef = new RegExp(`(?<![\\w.:])${col}(?![\\w])`);
            if (selfRef.test(rhs)) {
              findings.push({
                rule: 'onconflict-unqualified',
                message: `${source} — \`${col} = ${rhs.trim().slice(0, 40)}\`: auto-referencia SIN CUALIFICAR en DO UPDATE — ambigua en PG (error de parseo). Usa \`<tabla>.${col}\` o \`excluded.${col}\`.`,
              });
            }
          }
        }
      }
    }
  }
  return findings;
}
