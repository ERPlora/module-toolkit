// Paridad de migraciones manifest↔disco, dialecto ÚNICO Postgres (ADR-0154).
//
// Postgres es el único dialecto soportado. SQLite quedó DEPRECADO: el toolkit ya no lo
// exige ni valida su paridad — solo AVISA de restos para acompañar la transición (borrar
// `migrations/sqlite/` y las claves `migrations.sqlite`/`seed.sqlite` del manifest).
//
//   - ERROR: un `.sql` de `migrations/postgres/` no referenciado en `migrations.postgres`
//     (bug 2026-07-05: manifests que omitían la referencia → hubs instalaban sin migrar);
//   - ERROR: el manifest referencia un fichero postgres que no existe en el paquete;
//   - WARNING (no bloquea, transición): quedan restos de un dialecto deprecado — un dir
//     `migrations/sqlite/` o claves `migrations.sqlite`/`seed.sqlite` en el manifest.
//
// El runtime aplica la unión manifest∪paquete (tolerante con manifests incompletos ya
// publicados); este gate mantiene el manifest postgres como contrato COMPLETO en origen.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Dialecto único soportado (ADR-0154). Antes: ['sqlite', 'postgres'].
export const DIALECTS = ['postgres'];

// Dialectos deprecados: sus restos generan WARNING (no ERROR) durante la transición a 0154.
export const DEPRECATED_DIALECTS = ['sqlite'];

/** El `kind` que se asume cuando la entrada es una ruta pelada — el 95% de los casos. */
export const DEFAULT_MIGRATION_KIND = 'expand';

/**
 * Las migraciones declaradas de un dialecto, NORMALIZADAS a `{ file, kind, since }`.
 *
 * El runtime acepta dos formas (`MigrationEntry`, hub#542): la ruta pelada —que se lee `expand`— y
 * la forma objeto `{ file, kind, since }`, que es la ÚNICA manera de declarar un `contract`, o sea
 * de hacer un `DROP` legítimo. El toolkit asumía strings en todas partes (`join(dir, rel)`,
 * `declared.includes(rel)`), así que usar la forma objeto ROMPÍA `erplora validate` — y por eso hoy
 * ningún módulo publicado la usa: en `cash_register#45` hubo que RETIRAR los `DROP` en vez de
 * declararlos. Un contrato que solo existe en el runtime no lo puede usar nadie.
 *
 * Una entrada malformada se devuelve tal cual (`file: undefined`) para que el caller la reporte:
 * tragársela aquí la convertiría en un fichero que nadie valida.
 */
export function migrationEntries(manifest, dialect = 'postgres') {
  return (manifest?.migrations?.[dialect] ?? []).map((entry) => {
    if (typeof entry === 'string') {
      return { file: entry, kind: DEFAULT_MIGRATION_KIND, since: null };
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return {
        file: typeof entry.file === 'string' ? entry.file : undefined,
        kind: entry.kind ?? DEFAULT_MIGRATION_KIND,
        since: entry.since ?? null,
      };
    }
    return { file: undefined, kind: DEFAULT_MIGRATION_KIND, since: null };
  });
}

/** Solo las rutas, para quien no necesita el `kind` (lint de SQL, PREPARE, empaquetado). */
export function migrationFiles(manifest, dialect = 'postgres') {
  return migrationEntries(manifest, dialect)
    .map((e) => e.file)
    .filter((f) => typeof f === 'string' && f);
}

/** Devuelve `{ errors, warnings }` (arrays de strings); no lanza — eso lo decide `validate`. */
export function checkMigrations(dir, manifest) {
  const errors = [];
  const warnings = [];

  for (const dialect of DIALECTS) {
    const entries = migrationEntries(manifest, dialect);
    const declared = [];
    for (const entry of entries) {
      if (typeof entry.file !== 'string' || !entry.file) {
        errors.push(
          `migrations.${dialect}: entrada sin \`file\` — una migración se declara como ruta ` +
            '("migrations/postgres/001_init.sql") o como objeto { file, kind, since }',
        );
        continue;
      }
      declared.push(entry.file);
    }
    const dialectDir = join(dir, 'migrations', dialect);
    const disk = existsSync(dialectDir)
      ? readdirSync(dialectDir)
          .filter((f) => f.endsWith('.sql'))
          .map((f) => `migrations/${dialect}/${f}`)
      : [];

    for (const rel of declared) {
      if (!existsSync(join(dir, rel))) {
        errors.push(`migrations.${dialect}: ${rel} no existe en el paquete`);
      }
    }
    for (const rel of disk) {
      if (!declared.includes(rel)) {
        errors.push(
          `migrations.${dialect}: ${rel} está en el paquete pero NO en el manifest — añádelo (sin referencia, un hub instalaría sin ese esquema)`,
        );
      }
    }
  }

  // ADR-0154: restos de dialectos deprecados. No bloquea (transición) — avisa para limpiarlos.
  for (const dialect of DEPRECATED_DIALECTS) {
    const traces = [];
    if (existsSync(join(dir, 'migrations', dialect))) traces.push(`migrations/${dialect}/`);
    if (manifest.migrations?.[dialect] !== undefined) traces.push(`migrations.${dialect}`);
    if (manifest.seed?.[dialect] !== undefined) traces.push(`seed.${dialect}`);
    if (traces.length) {
      warnings.push(
        `${dialect} migrations are deprecated (ADR-0154), remove them (${traces.join(', ')})`,
      );
    }
  }

  return { errors, warnings };
}
