// Paridad de migraciones manifest↔disco (gate del bug 2026-07-05: 16 manifests omitían
// `migrations.postgres` aunque el `.sql` viajaba en el zip → hubs Cloud instalaban sin migrar
// y `validate` no lo cazaba porque solo miraba los ficheros REFERENCIADOS).
//
//   - ERROR: un `.sql` de `migrations/<dialecto>/` no referenciado en `migrations.<dialecto>`;
//   - ERROR: el manifest referencia un fichero que no existe en el paquete;
//   - WARNING: un dialecto tiene migraciones y el otro ninguna — legítimo en módulos de un
//     solo producto (`backup` es solo-SQLite por diseño, ADR-0040), pero casi siempre olvido.
//
// El runtime aplica la unión manifest∪paquete (tolerante con manifests incompletos ya
// publicados); este gate mantiene el manifest como contrato COMPLETO en origen, para que la
// unión no tenga que rescatar nada.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const DIALECTS = ['sqlite', 'postgres'];

/** Devuelve `{ errors, warnings }` (arrays de strings); no lanza — eso lo decide `validate`. */
export function checkMigrations(dir, manifest) {
  const errors = [];
  const warnings = [];
  const total = {};

  for (const dialect of DIALECTS) {
    const declared = manifest.migrations?.[dialect] ?? [];
    const dialectDir = join(dir, 'migrations', dialect);
    const disk = existsSync(dialectDir)
      ? readdirSync(dialectDir)
          .filter((f) => f.endsWith('.sql'))
          .map((f) => `migrations/${dialect}/${f}`)
      : [];
    total[dialect] = new Set([...declared, ...disk]).size;

    for (const rel of declared) {
      if (!existsSync(join(dir, rel))) {
        errors.push(`migrations.${dialect}: ${rel} no existe en el paquete`);
      }
    }
    for (const rel of disk) {
      if (!declared.includes(rel)) {
        errors.push(
          `migrations.${dialect}: ${rel} está en el paquete pero NO en el manifest — añádelo (sin referencia, un hub ${dialect} instalaría sin ese esquema)`,
        );
      }
    }
  }

  const [a, b] = DIALECTS;
  if ((total[a] === 0) !== (total[b] === 0)) {
    const [have, missing] = total[a] === 0 ? [b, a] : [a, b];
    warnings.push(
      `paridad de dialectos: hay migraciones de ${have} pero ninguna de ${missing} (¿módulo de un solo producto? si no, faltan)`,
    );
  }

  return { errors, warnings };
}
