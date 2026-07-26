// Guardarraíles de compatibilidad Postgres (auditoría pm#16; actualizados tras ADR-0154 + hub#210).
//
// La familia que mató 4 P0 en Hub Cloud (QA sectorial 07-16): construcciones que un motor tolera
// y Postgres rechaza. Escáner LÉXICO (sin parser AST; misma filosofía que validate-sql.mjs),
// enmascarando literales y comentarios. Cuatro reglas, cada una con `level`:
//
//   1) `multi-statement`        ERROR   — un fichero de `sql[]` de command/query se ejecuta como
//      UN prepared statement; PG rechaza multi-statement («cannot insert multiple commands»).
//      Las migraciones van por otro camino y quedan exentas. (inventory#28)
//   2) `onconflict-unqualified` ERROR   — en `ON CONFLICT … DO UPDATE SET`, la auto-referencia a
//      la columna va CUALIFICADA (`tabla.col` o `excluded.col`); sin cualificar es ambigua en PG
//      (error de parseo). (appointments#19)
//   3) `boolean-case-obsolete`  WARNING — `CASE WHEN :param THEN …` / `WHEN NOT :param`. Antes se
//      RECOMENDABA envolver los flags así; desde ADR-0154 el runtime coerciona `Json::Bool`→
//      INTEGER 0/1 en un punto central (hub#210), así que el bind llega como bigint 0/1 y
//      `CASE WHEN <bigint>` ROMPE en PG («argument of WHEN must be type boolean»). Pasa el param
//      DIRECTO (`SET flag = :param`). La regla vieja `boolean-bind` (que pedía justo este CASE
//      WHEN) queda DEROGADA — su patrón recomendado ya no compila. (pm#16 cerrada por obsoleta)
//   4) `null-untyped`           WARNING — `:param IS NULL`: PG no puede inferir el tipo del bind en
//      ese contexto; si el valor llega NULL da «could not determine data type of parameter»
//      (42P08). Castea el bind: `:param::text IS NULL` (o el tipo real de la columna). (tables#20)
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

        // 2) ON CONFLICT … DO UPDATE SET col = …col… sin cualificar — ERROR
        for (const oc of m.matchAll(/ON\s+CONFLICT[\s\S]{0,120}?DO\s+UPDATE\s+SET\s+([\s\S]*?)(?:WHERE|;|$)/gi)) {
          const body = oc[1];
          for (const asg of body.matchAll(/(\w+)\s*=\s*([^,]+)/g)) {
            const [, col, rhs] = asg;
            const selfRef = new RegExp(`(?<![\\w.:])${col}(?![\\w])`);
            if (selfRef.test(rhs)) {
              findings.push({
                rule: 'onconflict-unqualified',
                level: 'error',
                message: `${source} — \`${col} = ${rhs.trim().slice(0, 40)}\`: auto-referencia SIN CUALIFICAR en DO UPDATE — ambigua en PG (error de parseo). Usa \`<tabla>.${col}\` o \`excluded.${col}\`.`,
              });
            }
          }
        }

        // 3) `CASE WHEN :param THEN` / `WHEN NOT :param` — patrón OBSOLETO (WARNING).
        //    El param va como boolean-condición cruda dentro de un WHEN. Post ADR-0154 el runtime
        //    coerciona bool→0/1, así que el bind es un bigint y `CASE WHEN <bigint>` rompe en PG.
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

        // 4) `:param IS [NOT] NULL` — bind sin tipo inferible (WARNING; posible 42P08).
        const seenNull = new Set();
        for (const hit of m.matchAll(/:(\w+)\s+IS\s+(?:NOT\s+)?NULL\b/gi)) {
          const p = hit[1];
          if (seenNull.has(p)) continue;
          seenNull.add(p);
          findings.push({
            rule: 'null-untyped',
            level: 'warning',
            message: `${source} — \`:${p} IS NULL\`: PG no infiere el tipo del bind en ese contexto; si el valor llega NULL da 42P08 («could not determine data type of parameter»). Castea el bind: \`:${p}::text IS NULL\` (o el tipo real de la columna).`,
          });
        }
      }
    }
  }
  return findings;
}
