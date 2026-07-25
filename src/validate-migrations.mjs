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

/** Devuelve `{ errors, warnings }` (arrays de strings); no lanza — eso lo decide `validate`. */
export function checkMigrations(dir, manifest) {
  const errors = [];
  const warnings = [];

  for (const dialect of DIALECTS) {
    const declared = manifest.migrations?.[dialect] ?? [];
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
