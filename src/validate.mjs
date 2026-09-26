// `erplora validate <dir>`: valida el manifest, el SQL portable "ERPlora SQL" (ADR-0007) y, si hay
// bundle, que sea CSP-safe.
//
// El manifest se comprueba por TRES vías, y la primera dejó de ser un espejo escrito a mano
// (module-toolkit#30): las claves admitidas se LEEN del schema canónico
// (`schemas/module.schema.json`, vendorizado del hub — ver `manifest-schema.mjs`), así que un
// bloque nuevo del contrato se conoce en cuanto se sincroniza el schema. La segunda EVALÚA ese
// mismo schema (module-toolkit#247, `validate-manifest-schema.mjs`): hasta entonces solo se leían
// los NOMBRES de las claves, así que un campo obligatorio ausente o un tipo cambiado pasaban en
// verde y el bloque no aparecía en el hub sin decir nada. Lo que sigue escrito aquí son las reglas
// de FORMATO y de negocio que el schema no expresa (códigos de taxonomía, enums de billing,
// bloques movidos de sitio por el ADR-0007).
//
// ⚠️ UNA dependencia pública además de `typescript`: `ajv`, la del evaluador de #247. El gate la
// instala en su prefijo scratch (`.github/actions/validate-module/action.yml`) igual que aquella, y
// `test/gate-wiring.test.mjs` falla si se añade una tercera sin instalarla — sin eso el gate muere
// con `ERR_MODULE_NOT_FOUND` en los 27 repos de módulo a la vez.
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { validateSql } from './validate-sql.mjs';
import { checkMigrations } from './validate-migrations.mjs';
import { checkMigrationGuard } from './validate-migration-guard.mjs';
import { checkIonicFill, checkIonicMissingFill } from './validate-ionic-fill.mjs';
import { checkIonicColor } from './validate-ionic-color.mjs';
import { checkIonicClass } from './validate-ionic-class.mjs';
import { lintSchema, collectSchemaFiles } from './validate-schemas.mjs';
import { checkContracts } from './contracts.mjs';
import { checkPgCompat } from './validate-pg.mjs';
import { checkPrepare } from './validate-prepare.mjs';
import { checkWasmArtifact } from './wasm.mjs';
import { missingPathDeps } from './run-cargo.mjs';
import { checkNotifyChannels } from './validate-notify-channels.mjs';
import { checkHandlerPermissionCeiling } from './validate-handler-permissions.mjs';
import { checkManifestKeys } from './validate-manifest-keys.mjs';
import { checkManifestSchema } from './validate-manifest-schema.mjs';
import { checkBundleArtifact } from './bundle-freshness.mjs';
import { checkErrorsCatalog } from './validate-errors-catalog.mjs';
import { checkRowGates } from './validate-row-gates.mjs';
import { checkGateConstraints } from './validate-gate-constraints.mjs';
import { checkHubScope } from './validate-hub-scope.mjs';
import { checkEmitDedupKey } from './validate-emit-dedup-key.mjs';
import { checkFilterOps } from './validate-filter-ops.mjs';
import { checkDeadFilters } from './validate-dead-filters.mjs';
import { checkBatteryMigrations } from './validate-battery-migrations.mjs';
import { checkOutfitkitFloor } from './validate-outfitkit-floor.mjs';
import { checkFlows } from './validate-flows.mjs';
import { readHubOutfitkit } from './hub-outfitkit-source.mjs';

// Validación CSP: el bundle no puede usar eval/new Function (los bloquea `script-src 'self'`).
export function assertCspSafe(code, label = 'bundle') {
  const hits = [];
  for (const _ of code.matchAll(/\beval\s*\(/g)) hits.push('eval(');
  for (const _ of code.matchAll(/new\s+Function\s*\(/g)) hits.push('new Function(');
  if (hits.length) {
    throw new Error(`${label}: ${hits.length} uso(s) que la CSP estricta bloquearía (${[...new Set(hits)].join(', ')}).`);
  }
}

/**
 * Valida el bloque **opcional** `fiscal_regime` (ADR-0259 D6, hub#555): el régimen fiscal que este
 * módulo IMPLEMENTA. Devuelve la lista de errores (vacía = correcto).
 *
 * Se valida aquí y no solo en el JSON Schema porque el schema no es la puerta que corre el autor
 * del módulo: hoy `erplora validate` **no** mira el bloque `setup` y esa es exactamente la clase de
 * hueco que hub#555 pide no repetir. Y el fallo es caro y silencioso: un `country` que no case con
 * nada se lee, aguas abajo, igual que «no hay ningún proveedor instalado» — que es lo que bloquea
 * un TPV.
 *
 * Dos comprobaciones, porque solo hay dos cosas contra las que se compara: el `country_code` del
 * hub y el registro de regímenes del core.
 */
export function checkFiscalRegime(manifest) {
  const f = manifest.fiscal_regime;
  if (f === undefined || f === null) return []; // No es proveedor fiscal: la forma de los 24 publicados.
  if (typeof f !== 'object' || Array.isArray(f)) {
    return ['fiscal_regime debe ser un objeto { country, regime }'];
  }
  const errs = [];
  const country = typeof f.country === 'string' ? f.country.trim() : '';
  if (!/^[A-Za-z]{2}$/.test(country)) {
    errs.push(
      `fiscal_regime.country inválido: ${JSON.stringify(f.country)} — se espera ISO-3166-1 alpha-2 ` +
        '(dos letras, p. ej. `ES`); es la forma contra la que se compara el país del hub',
    );
  }
  const regime = typeof f.regime === 'string' ? f.regime.trim() : '';
  if (!regime) {
    errs.push(
      'fiscal_regime.regime vacío: la clave es lo que el core cuenta como proveedor, y una vacía ' +
        'no declara nada aunque lo parezca',
    );
  }
  // El TECHO de la simplificada (hub#1010): OPCIONAL, y en CÉNTIMOS. No declararlo no dice «cero»,
  // dice «yo no muevo ese número»; el core deja la fila vigente como estaba.
  const max = f.simplified_invoice_max_cents;
  if (max !== undefined && max !== null) {
    if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
      errs.push(
        `fiscal_regime.simplified_invoice_max_cents inválido: ${JSON.stringify(max)} — se espera un ` +
          'entero de céntimos no negativo (3.000,00 € = 300000)',
      );
    } else if (max > 0 && max < 100_000) {
      // El fallo de dedo caro: escribirlo en EUROS. `3000` pasa cualquier validación de tipo y capa
      // el TPV a 30,00 €, que es una simplificada que ningún país legisla. Un techo de verdad por
      // debajo de 1.000,00 € no existe hoy en ningún régimen, así que la ambigüedad se resuelve
      // avisando en vez de dejar pasar un límite que rompería la caja en silencio.
      errs.push(
        `fiscal_regime.simplified_invoice_max_cents = ${max}: ¿está en EUROS? El campo va en ` +
          'céntimos (3.000,00 € = 300000), y un techo por debajo de 1.000,00 € no lo legisla ' +
          'ningún régimen — declarado así, el TPV bloquearía ventas legítimas',
      );
    }
  }
  return errs;
}

export async function validate(moduleDir, { pg = false, publishing = false } = {}) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));

  const errs = [];
  if (!/^[a-z][a-z0-9_]*$/.test(manifest.id ?? '')) errs.push('id inválido');
  if (!manifest.name) errs.push('name requerido');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version ?? '')) errs.push('version SemVer inválida');
  for (const nav of manifest.navigation ?? []) {
    if (!/^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(nav.component ?? '')) {
      errs.push(`navigation.component inválido: ${nav.component}`);
    }
  }
  // ADR-0007: clasificación + pricing van en el manifest dentro de `marketplace`/`billing`.
  // El toolkit valida el FORMATO; el Cloud valida la EXISTENCIA de los códigos de taxonomía en el sync.
  const codeRe = /^[a-z][a-z0-9_]*$/;
  const mk = manifest.marketplace ?? {};
  if (mk.functional_unit !== undefined && !codeRe.test(mk.functional_unit)) {
    errs.push(`marketplace.functional_unit código inválido: ${mk.functional_unit}`);
  }
  for (const key of ['sectors', 'business_types']) {
    for (const code of mk[key] ?? []) {
      if (!codeRe.test(code)) errs.push(`marketplace.${key}: código inválido: ${code}`);
    }
  }
  // ADR-0259 D6 (hub#555): el régimen fiscal que el módulo dice implementar.
  errs.push(...checkFiscalRegime(manifest));
  // hub#689: un canal de `host.notify` sin transporte se publica hoy tal cual y muere en el primer
  // envío real. La puerta barata es esta, no la producción.
  errs.push(...checkNotifyChannels(manifest));
  // La clasificación/pricing a nivel raíz queda obsoleta: va dentro de `marketplace`/`billing`.
  for (const moved of ['sectors', 'business_types', 'functional_unit', 'pricing']) {
    if (moved in manifest) errs.push(`'${moved}' a nivel raíz: muévelo a 'marketplace'/'billing' (ADR-0007)`);
  }

  const b = manifest.billing;
  if (b) {
    if (b.tier !== undefined && !['basic', 'essential', 'premium'].includes(b.tier)) errs.push(`billing.tier inválido: ${b.tier}`);
    if (b.type !== undefined && !['free', 'one_time', 'subscription'].includes(b.type)) errs.push(`billing.type inválido: ${b.type}`);
    if (b.interval !== undefined && !['month', 'year'].includes(b.interval)) errs.push(`billing.interval inválido: ${b.interval}`);
    if (b.price !== undefined && !(typeof b.price === 'number' && b.price >= 0)) errs.push('billing.price debe ser número ≥ 0');
    for (const t of b.tiers ?? []) {
      if (!codeRe.test(t.slug ?? '')) errs.push(`billing.tiers[].slug inválido: ${t.slug}`);
      if (!t.name) errs.push(`billing.tiers[${t.slug}].name requerido`);
      if (!(typeof t.price === 'number' && t.price >= 0)) errs.push(`billing.tiers[${t.slug}].price debe ser ≥ 0`);
      if (t.interval !== undefined && !['month', 'year'].includes(t.interval)) errs.push(`billing.tiers[${t.slug}].interval inválido: ${t.interval}`);
    }
  }

  // module-toolkit#30: claves que el contrato NO admite, leídas del schema canónico. Es la puerta
  // que faltaba: `whatsapp_inbox` publicó durante meses `events.emit` (singular) —el runtime no vio
  // ningún evento declarado y dejó el módulo en modo compatible— y ninguna de las tres puertas lo
  // detectó, porque ninguna sabía mirar una clave desconocida. La severidad es la del runtime
  // (hub#521): se rechaza donde cambia lo que se EJECUTA, se avisa donde cuesta una pantalla.
  const keys = checkManifestKeys(manifest);
  for (const w of keys.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  errs.push(...keys.errors);

  // module-toolkit#247: y el CONTENIDO, no solo los nombres de las claves. El schema canónico se
  // leía para saber qué claves existen y nada más, así que `required`, `type`, `minimum`, el
  // `oneOf` de un widget y el `if/then` de un record no los evaluaba nadie: un bloque escrito a
  // medias —`billing.usage` sin `used`— imprimía exactamente las mismas líneas que uno correcto, y
  // el fallo aparecía como un hueco en la pantalla de un cliente, sin error en ningún sitio.
  // Misma escala de severidad que la puerta de arriba (`REFUSED_PATHS`, hub#521).
  const schemaCheck = checkManifestSchema(manifest);
  for (const w of schemaCheck.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  errs.push(...schemaCheck.errors);

  // hub#1091: las guardas de filas afectadas. `checkManifestKeys` no las ve — lee claves
  // desconocidas, patrones y vocabularios cerrados, y lo que el schema canónico declara para esto
  // es un CONDICIONAL (`if min_affected_rows && sql.minItems 2 → then false`), que el walker no
  // evalúa. Sin esta puerta la restricción sería inerte aquí y cierta solo en el hub.
  errs.push(...checkRowGates(manifest));

  // ERPlora/hub#1076 / module-toolkit#133: `dedup_key` de la forma objeto de `emit`. El schema
  // canónico lo tipa `string` y lo exige, pero no puede llevar `minLength`/`pattern` sin divergir
  // del schema del hub (`canonical-mirrors.test.mjs`), así que un valor vacío o que nunca podría
  // nombrar un campo pasa `checkManifestKeys` en silencio.
  errs.push(...checkEmitDedupKey(manifest));

  if (errs.length) throw new Error('manifest inválido:\n  - ' + errs.join('\n  - '));

  // ADR-0007 punto 3: rechazar SQL no portable (queries/commands/migraciones de ambos
  // dialectos). Lanza si hay errores; imprime warnings (heurística de dinero).
  const { warnings } = validateSql(dir, manifest);

  // Compatibilidad Postgres (auditoría pm#16; actualizada tras ADR-0154 + hub#210 y tras el barrido
  // de pm#107 — module-toolkit#32): la familia que mató 4 P0 en Hub Cloud. Los ERRORES son SQL que
  // Postgres no puede ni preparar (multi-statement en un prepared statement, ON CONFLICT sin
  // cualificar en cualquiera de sus formas, `:param IS NULL` sin tipo → 42P08) y bloquean; el único
  // WARNING que queda es de patrón obsoleto (CASE WHEN sobre un bool ya coercionado).
  const pgCompat = checkPgCompat(dir, manifest);
  for (const w of pgCompat.filter((f) => f.level === 'warning')) {
    console.warn(`⚠ ${manifest.id}: [${w.rule}] ${w.message}`);
  }
  const pgErrors = pgCompat.filter((f) => f.level === 'error');
  if (pgErrors.length) {
    throw new Error('incompatibilidades Postgres (pm#16):\n  - ' + pgErrors.map((f) => f.message).join('\n  - '));
  }

  // Paridad manifest↔disco de migraciones (bug 2026-07-05, hubs Cloud sin migrar): todo
  // `.sql` de `migrations/<dialecto>/` debe estar referenciado, y toda referencia existir.
  const parity = checkMigrations(dir, manifest);
  for (const w of parity.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (parity.errors.length) {
    throw new Error('migraciones inconsistentes:\n  - ' + parity.errors.join('\n  - '));
  }

  // module-toolkit#209: las automatizaciones que el módulo trae de fábrica (`flows/`). Hasta ahora
  // no las miraba NADIE aquí: la única puerta era la batería del propio módulo, que carga el schema
  // de un checkout VECINO del hub y se salta sola cuando no lo hay — o sea, nunca en CI (medido en
  // whatsapp_inbox#75). Un documento con un paso que el hub no sabe ejecutar, o una traducción que
  // se quedó atrás, se publicaba en verde y moría en el hub de un cliente.
  const flows = checkFlows(dir);
  for (const w of flows.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (flows.errors.length) {
    throw new Error(
      'automatizaciones de fábrica que ningún hub podría ejecutar (module-toolkit#209):\n  - ' +
        flows.errors.join('\n  - '),
    );
  }

  // module-toolkit#51: las DOS reglas que el runtime le exige a una migración en el momento de
  // aplicarla (`migration_guard.rs`) — la tabla es del módulo, y el SQL coincide con el `kind`
  // declarado. Hasta ahora esta puerta no miraba NINGUNA de las dos: el 19/08 cuatro módulos
  // publicaron en verde y el hub rechazó su migración, lo que deja el módulo sin instalar en hubs
  // nuevos y revertido en los que ya lo tenían — y `customers` arrastró a los cuatro que dependen
  // de él. Se comprueba aquí, antes de publicar, porque es la única defensa que NO depende de qué
  // imagen corra cada hub: el arreglo del splitter (hub#1027) vive en `develop` y en ningún tag.
  const guard = checkMigrationGuard(dir, manifest);
  for (const w of guard.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (guard.errors.length) {
    throw new Error(
      'migraciones que el hub RECHAZARÍA al instalar (module-toolkit#51):\n  - ' +
        guard.errors.join('\n  - '),
    );
  }

  // module-toolkit#92 (verifactu#40): la TABLA GUARDIA. Un `CHECK (ok = 1)` anónimo hace que todos
  // los rechazos del módulo salgan con el MISMO mensaje primario — el nombre del gate que saltó va
  // en el DETAIL del error, que `PgDatabaseError` no entrega al llamante. El código que intenta
  // decir POR QUÉ se rechazó no puede casar nunca, y el usuario recibe el problema de otro gate.
  // La identidad se mueve al NOMBRE de la constraint (verifactu, migración 012).
  //
  // Se lee la CADENA de migraciones, no cada fichero: son append-only, así que el módulo que YA
  // aplicó el arreglo conserva el `CREATE TABLE` anónimo en su migración vieja y un lector por
  // fichero pondría en rojo justo al que hizo el trabajo. Trinquete: los 4 ficheros publicados con
  // el patrón avisan con su issue (`GRANDFATHERED`, solo encoge); una tabla guardia nueva es error.
  const gateConstraints = checkGateConstraints(dir, manifest);
  for (const w of gateConstraints.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (gateConstraints.errors.length) {
    throw new Error(
      'tabla guardia con rechazos INDISTINGUIBLES (module-toolkit#92):\n  - ' +
        gateConstraints.errors.join('\n  - '),
    );
  }

  // module-toolkit#80: TENANCY. El runtime inyecta `:hub_id` como BIND — nunca como columna ni como
  // predicado (`system_params`, contrato del kernel; el motor de listas aporta búsqueda/orden/
  // paginación, no el filtro). Así que un INSERT que no NOMBRE la columna deja NULL algo que la
  // tabla declara NOT NULL —el command falla en TODOS los hubs— y un SELECT/UPDATE/DELETE sin
  // `:hub_id` alcanza filas de otros hubs allí donde la BD está compartida.
  //
  // Ninguna puerta anterior podía verlo: el SQL PREPARA perfectamente (`validate --pg` VERDE), el
  // mock de `erplora dev` responde `ok:true` sin tocar SQL, y `pack`/`sign` no leen semántica. El
  // agujero se abre la primera vez que un hub de cliente EJECUTA la sentencia — que es como
  // `erplora g module` llegó a andamiar un módulo cuyo único camino de escritura nacía roto.
  //
  // ERROR, y no rompe nada: el barrido de los 30 repos de módulo (`origin/main`, 01/09/2026) da
  // CERO hallazgos — 166 tablas con `hub_id` y 911 ficheros SQL juzgados, con 30/30 mutantes
  // cazados al quitarles el filtro a mano.
  const hubScope = checkHubScope(dir, manifest);
  for (const w of hubScope.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (hubScope.errors.length) {
    throw new Error(
      'SQL sin acotar por hub — agujero de tenancy (module-toolkit#80):\n  - ' +
        hubScope.errors.join('\n  - '),
    );
  }

  // ADR-0125 / module-toolkit#183: la caja de filtro tiene que SIGNIFICAR lo que parece. Una caja de
  // texto libre invita a teclear un trozo; con `op: "eq"` el runtime exige el valor entero y la
  // lista vuelve VACÍA, sin error — la recepcionista lee «no está la clienta» y la da de alta otra
  // vez. La regla tenía guard (`modules-workspace/guards/filter-ops.test.ts`) pero
  // `modules-workspace/` no es repo ni tiene workflows: nadie lo corría y llevaba semanas rojo.
  // Aquí sí corre, en cada PR de módulo y antes de `pack`/`sign`/`publish`.
  //
  // Juzga lo que el módulo DECLARA de sí mismo —el `filterType` que pinta su componente y el tipo
  // que escribe su migración—, no el nombre de la columna: barrido sobre `origin/main` de los 27
  // repos (05/09/2026), la regla vieja «`like` fuera de la lista blanca» daba 18 hallazgos y 18
  // FALSOS POSITIVOS. Trinquete: los 40 filtros ya publicados que incumplían avisan
  // (`FILTER_OPS_GRANDFATHERED`, ERPlora/pm#244; `reservations` arregló sus 6 en reservations#46,
  // quedan 34) y la lista solo encoge — un test le fija el techo; uno nuevo es error.
  const filterOps = checkFilterOps(dir, manifest);
  for (const w of filterOps.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (filterOps.errors.length) {
    throw new Error(
      'la caja de filtro no significa lo que parece (ADR-0125, module-toolkit#183):\n  - ' +
        filterOps.errors.join('\n  - '),
    );
  }

  // module-toolkit#178: un filtro de `list.filters` sobre una columna que la PROPIA SQL clava a una
  // constante. El runtime no mete el filtro dentro de la query, la ENVUELVE
  // (`SELECT sub.* FROM ( … ) AS sub WHERE CAST(sub.col AS TEXT) = …`), así que las dos condiciones
  // se suman: `col = 1 AND col = 0` → CERO FILAS siempre, sin error y sin nada en pantalla que lo
  // explique. `checkFilterOps` no puede verlo: compara pantalla ↔ manifest, nunca la SQL.
  //
  // Solo se juzga el WHERE de PRIMER nivel y solo cuando no hay un OR de primer nivel — los dos
  // controles negativos que el catálogo trae de verdad: `tables.zones.list` clava el `= 1` en el ON
  // de un LEFT JOIN sobre OTRA tabla, y `taxes.rules.list` lo esconde tras
  // `OR :include_archived`, que es su escotilla a propósito (ERPlora/taxes#53). Trinquete: los 9
  // filtros muertos ya publicados avisan (`DEAD_FILTERS_GRANDFATHERED`, ERPlora/pm#254) y la lista
  // solo encoge; uno nuevo es error.
  const deadFilters = checkDeadFilters(dir, manifest);
  for (const w of deadFilters.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (deadFilters.errors.length) {
    throw new Error(
      'un filtro de lista que la propia SQL ya clava (module-toolkit#178):\n  - ' +
        deadFilters.errors.join('\n  - '),
    );
  }

  // module-toolkit#180: una batería que itera `migrations.postgres` como si fueran strings. La forma
  // objeto `{ file, kind, since }` es la ÚNICA manera de declarar un `contract` (hub#542), así que
  // el día que el módulo declare el primero esa batería muere con `TypeError: … 'PosixPath' and
  // 'dict'` antes de probar nada — y lo hace en el merge-ref de otra PR, sin conflicto textual
  // (ERPlora/appointments#114 contra #115). AVISA mientras el manifest sea solo strings (57 bucles
  // en 14 módulos el 05/09/2026: poner eso rojo pararía 14 módulos por un fallo que aún no tienen)
  // y RECHAZA en cuanto el módulo declara una entrada objeto: ahí la batería ya está rota.
  const batteryMigrations = checkBatteryMigrations(dir, manifest);
  for (const w of batteryMigrations.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (batteryMigrations.errors.length) {
    throw new Error(
      'una batería no puede leer las migraciones de este módulo (module-toolkit#180):\n  - ' +
        batteryMigrations.errors.join('\n  - '),
    );
  }

  // ADR-0007 en la PUERTA DE ENTRADA: un importe declarado `number` en el schema de un comando deja
  // pasar `2.20` (euros) donde el contrato exige `220` (céntimos), y el bind lo manda a una columna
  // INTEGER → 2 céntimos, en silencio. La BD ya lo rechazaba (NUMERIC), el payload no.
  const schemaErrs = [];
  for (const rel of collectSchemaFiles(dir, manifest)) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    let schema;
    try {
      schema = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (e) {
      throw new Error(`schema ilegible ${rel}: ${e.message}`);
    }
    for (const f of lintSchema(schema, rel)) schemaErrs.push(`${f.file}: ${f.detail}`);
  }
  if (schemaErrs.length) {
    throw new Error('dinero con decimales en los schemas:\n  - ' + schemaErrs.join('\n  - '));
  }

  // ADR-0398 (module-toolkit#101): the domain error codes a module provides are a DECLARED
  // surface (`errors` in the manifest). A code emitted and not declared, a declared code without
  // its `en`/`es` text, or a code retired without a `deprecated` release in between, fails here —
  // before it fails the hub's tests of every consumer. No block yet = warning (migration open).
  const errorsCatalog = checkErrorsCatalog(dir, manifest);
  for (const w of errorsCatalog.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (errorsCatalog.errors.length) {
    throw new Error('catálogo de códigos de error de dominio roto (ADR-0398):\n  - ' + errorsCatalog.errors.join('\n  - '));
  }

  // ADR-0127: los contratos consumidos (queries/commands/eventos/slots que la UI usa de otros
  // módulos) se verifican en BUILD contra los manifests del workspace. Antes, un renombrado en el
  // proveedor lo descubría un cajero al abrir el TPV.
  const contracts = checkContracts(dir, manifest);
  for (const d of contracts.deferred) console.warn(`⚠ ${manifest.id}: ${d}`);
  if (contracts.errors.length) {
    throw new Error('contratos de interoperabilidad rotos (ADR-0127):\n  - ' + contracts.errors.join('\n  - '));
  }

  // hub#760 en los MÓDULOS: `fill` en un `ion-input`/`ion-select`/`ion-textarea` solo lo pinta
  // Ionic en `md`, y el shell del hub fija `mode: 'ios'` (ADR-0143). Es un no-op SILENCIOSO — el
  // campo sale sin caja, sin borde y sin fondo, y el usuario no ve dónde escribir. El hub ya se
  // defiende en su código (`apps/web/src/theme/ionic-fill-needs-md.test.ts`) y el Cloud también
  // (saas#1080), pero ninguna de las dos puertas mira los módulos, que es donde vive la mayor
  // parte de los formularios que rellena el comerciante: el día que aterrizó, 275 de los 298
  // controles publicados declaraban `fill` y NINGUNO declaraba `mode="md"`. La defensa estaba por
  // duplicado y no cubría el tercer sitio.
  //
  // Arrancó en modo trinquete, no de golpe: lo que había está en `FILL_GRANDFATHERED` por fichero
  // Y por número, así que ningún repo se pone en rojo por algo que ya publicó, pero un control
  // nuevo sí. La lista solo puede ENCOGER, y el barrido (ERPlora/pm#152) ya la ha bajado a 170
  // controles en 14 módulos: ocho — customers, inventory, kitchen, pricing, printing, staff,
  // tasks y whatsapp_inbox — están limpios y fuera, o sea en error de verdad si recaen.
  const ionicFill = checkIonicFill(dir, manifest);
  for (const w of ionicFill.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (ionicFill.errors.length) {
    throw new Error(
      'controles Ionic con un `fill` que el hub NUNCA pinta (hub#760):\n  - ' +
        ionicFill.errors.join('\n  - '),
    );
  }

  // ERPlora/pm#479: la otra mitad del mismo defecto. Un `ion-input`/`ion-select`/`ion-textarea` que
  // NO declara `fill` se queda en `ios` (el arreglo del shell, hub#1060, solo mueve a `md` los que
  // declaran uno) y sale sin caja: así llegaron el «%» y la «Calificación» del alta de reglas de
  // impuestos (taxes#73) con la puerta de arriba en verde. Fuera quedan los que van dentro de un
  // `ion-item` (una fila de lista, que ya es la superficie). Trinquete como el de `fill`: lo
  // publicado vive en `MISSING_FILL_GRANDFATHERED` y solo encoge.
  const ionicMissingFill = checkIonicMissingFill(dir, manifest);
  for (const w of ionicMissingFill.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (ionicMissingFill.errors.length) {
    throw new Error(
      'controles Ionic SIN `fill` fuera de una fila de lista: salen sin caja en el hub (ERPlora/pm#479):\n  - ' +
        ionicMissingFill.errors.join('\n  - '),
    );
  }

  // module-toolkit#273: `color=` en un `ion-*` dentro del shadow root de un WC de módulo no pinta.
  // Ionic lee `--ion-color-base`, que solo da la clase GLOBAL `.ion-color-*` de core.css, y esa regla
  // no casa dentro de un shadow tree: un botón relleno sale INVISIBLE (texto blanco sobre fondo
  // transparente). Pasó en «Listo» de cocina (kitchen#42) y en «Cerrar caja» (cash_register#90).
  // Trinquete como el de `fill`: lo publicado vive en `COLOR_GRANDFATHERED` y solo encoge.
  const ionicColor = checkIonicColor(dir, manifest);
  for (const w of ionicColor.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (ionicColor.errors.length) {
    throw new Error(
      'elementos Ionic con un `color=` que el hub NUNCA pinta dentro del componente (module-toolkit#273):\n  - ' +
        ionicColor.errors.join('\n  - '),
    );
  }

  // module-toolkit#303: `class=${…}` (o `class="a ${…}"`, o `.className=`) sobre un `ion-*` reescribe el
  // atributo entero en cada cambio y borra las clases que Ionic estampó en el host — `ion-activatable`
  // entre ellas —: el botón deja de iluminarse al pulsarlo y pierde el foco. Pasó en el URGENTE de
  // cocina (kitchen#88) y en el descuento de sales (sales#358). Arreglo: `classMap`. Trinquete como el
  // de `color`: lo publicado vive en `CLASS_GRANDFATHERED` y solo encoge.
  const ionicClass = checkIonicClass(dir, manifest);
  for (const w of ionicClass.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (ionicClass.errors.length) {
    throw new Error(
      'elementos Ionic con el atributo `class` enlazado entero, que borra las clases de Ionic (module-toolkit#303):\n  - ' +
        ionicClass.errors.join('\n  - '),
    );
  }

  // module-toolkit#201: un módulo no puede publicar una pantalla que NINGÚN hub sabe pintar. Los
  // `ok-*` que pintan son los del shell, no los del bundle (ADR-0133), y la imagen del hub instala
  // `@erplora/outfitkit@latest` en cada build: el checkout del autor va casi siempre por delante de
  // la flota. Pasó dos veces en cuatro días (hub#1547 y sales#259) y en las dos lo descubrió el
  // cliente. La mitad que DECIDE ya existía —`compatibility.min_erplora_version`, que el hub aplica
  // desde hub#521—; esta es la que la RECLAMA.
  //
  // TRINQUETE, y el reparto importa: un suelo DECLARADO que no llega al sello es una afirmación
  // demostrablemente falsa del autor → error siempre. SIN suelo y horneado por delante de todo hub
  // conocido → aviso aquí, error con `publishing` (o sea en `erplora pack`), porque el sello lo
  // pone el checkout compartido `../outfitkit` y no el autor: bloquear en `validate` pondría rojos
  // los 27 módulos en su siguiente PR de UI, por la cadencia de release del hub. El detalle, con
  // sus medidas, en la cabecera de `validate-outfitkit-floor.mjs`.
  //
  // module-toolkit#203: la mitad de la comparación que ANTES se deducía por fecha se le pregunta al
  // hub, que desde ERPlora/hub#1588 publica su propio sello en `/outfitkit-version.json`. Es opt-in
  // (`ERPLORA_HUB_URL`) y NUNCA falla hacia rojo: sin hub, sin red o contra un hub anterior a #1588
  // devuelve `row: null` y el control vuelve a la tabla derivada, igual que antes. Lo que sí hace
  // siempre es DECIR que se ha degradado — un control que se ablanda en silencio deja de controlar
  // sin que nadie se entere.
  const hubSource = await readHubOutfitkit();
  for (const w of hubSource.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  const outfitkitFloor = checkOutfitkitFloor(dir, manifest, { publishing, source: hubSource.row });
  for (const w of outfitkitFloor.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (outfitkitFloor.errors.length) {
    throw new Error(
      'el módulo pide un OutfitKit que el hub no lleva (module-toolkit#201):\n  - ' +
        outfitkitFloor.errors.join('\n  - '),
    );
  }

  // hub#459 (paso 3): AVISO, nunca error. `commands::validate_operation` resuelve una op de handler
  // a SQL sin mirar el permiso del command destino, así que el permiso de un command con handler NO
  // es hoy el techo de lo que su cadena de ops toca — y con la elevación por PIN viva (hub#361) eso
  // es una puerta trasera al «nivel encargado» abierta desde el manifest. El gate de verdad (la
  // comprobación dentro de `validate_operation`) rompe 84 cruces en 12 módulos publicados: es una
  // migración de catálogo. Mientras llega, el autor ve el cruce aquí y realinea módulo a módulo.
  // Va ANTES de las comprobaciones del binario a propósito: solo mira manifest + source, y un aviso
  // que solo llega cuando el `dist/handler.wasm` ya está al día no acompaña a quien está editando.
  const ceiling = checkHandlerPermissionCeiling(dir, manifest);
  for (const w of ceiling.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);

  // module-toolkit#26: the BINARY about to be packed must match both the source and the manifest.
  // Two cheap checks (no `cargo`, which is why they run BEFORE the verification build below): that
  // it exports every function the manifest routes to it, and that it corresponds to the current
  // `handler/`. Without them a module published July's Tier-2 logic under August's manifest and
  // nothing failed until a real hub ran it (tables#25, pricing#17).
  const artifact = checkWasmArtifact(dir, manifest);
  for (const w of artifact.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (artifact.errors.length) {
    throw new Error('handler WASM desfasado (module-toolkit#26):\n  - ' + artifact.errors.join('\n  - '));
  }

  // module-toolkit#135: si un comando declara `handler.type === "wasm"`, el `dist/handler.wasm` debe
  // ser REPRODUCIBLE desde el source Rust presente (`handler/`). Antes `validate` solo tocaba el
  // bundle JS: un módulo pasaba `erplora validate` con un `dist/handler.wasm` cuyo source actual NO
  // compilaba (p.ej. ERPlora/services#11 `round_cents`), y el runtime ejecutaba el wasm viejo.
  //
  // Política (para no romper módulos ya publicados ni módulos sin WASM):
  //  - Sin `handler/` (módulo 100% declarativo, sin Rust distribuido) → válido, no se comprueba.
  //  - Con `handler/Cargo.toml` → se compila el source (`cargo build`); si NO compila → FAIL.
  //    Es la condición que cazaba el bug real: un source roto no puede pasar validate.
  //  - Si `cargo` no está instalado → WARN (no se puede verificar, pero no se bloquea al dev).
  const wasmResult = checkWasmHandler(dir, manifest);
  for (const w of wasmResult.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (wasmResult.errors.length) {
    throw new Error('handler WASM no compila desde el source (module-toolkit#135):\n  - ' + wasmResult.errors.join('\n  - '));
  }

  const bundle = join(dir, 'dist', `${manifest.id}.esm.js`);
  if (existsSync(bundle)) assertCspSafe(readFileSync(bundle, 'utf8'), `${manifest.id} bundle`);

  // module-toolkit#93: hasta aquí lo ÚNICO que esta puerta leía del bundle era la CSP, y el bundle
  // se publica TAL CUAL (el zip lleva `dist/` verbatim, nadie lo reconstruye aguas abajo). O sea que
  // ni la PROCEDENCIA ni la FRESCURA del artefacto que de verdad sirve el hub estaban miradas:
  //  - `verifactu@63039d3^:dist/verifactu.esm.js` llevaba 8 comentarios de esbuild con una ruta
  //    absoluta al scratchpad de otro agente — un build hecho desde un clone temporal, publicado.
  //  - una PR que toca `ui/**` sin `erplora build` publica la pantalla VIEJA bajo el manifest nuevo;
  //    el 28/08 `flows` ya estaba así: la clave `ui.tplNeedsModules` que mergeó flows#38 el 23/08 NO
  //    está en su `dist/flows.esm.js`, o sea que el arreglo no llegó a ningún hub.
  // Trinquete deliberado (ver `bundle-freshness.mjs`): con sello → error; sin sello → aviso, porque
  // ninguno de los 27 módulos publicados lo tiene todavía y poner 27 repos en rojo por un cambio
  // nuestro es como se desactiva un gate. La ruta de la máquina que compiló sí es error desde el día
  // uno: se comprobó que CERO de los 27 bundles publicados lleva ninguna.
  const bundleArtifact = checkBundleArtifact(dir, manifest);
  for (const w of bundleArtifact.warnings) console.warn(`⚠ ${manifest.id}: ${w}`);
  if (bundleArtifact.errors.length) {
    throw new Error('bundle dist/ desfasado o con rutas de otra máquina (module-toolkit#93):\n  - ' + bundleArtifact.errors.join('\n  - '));
  }

  // module-toolkit#32 (hole 3): the only door that does NOT guess — Postgres itself. Opt-in with
  // `--pg` because it needs a container; the lexical rules above always run.
  let pgNote = '';
  if (pg) {
    const prepared = await checkPrepare(dir, manifest);
    for (const w of prepared.warnings) console.warn(`⚠ ${manifest.id}: [pg-prepare] ${w}`);
    if (prepared.skipped) {
      // `--pg` is opt-in: whoever typed it asked for this door to be opened. Warning and exiting 0
      // would turn "nobody checked" into "green", which is the failure mode pm#107 is fighting.
      throw new Error(`no se pudo comprobar el SQL contra Postgres (--pg): ${prepared.reason}`);
    } else if (prepared.errors.length) {
      throw new Error(
        'Postgres no puede PREPARAR el SQL declarado (module-toolkit#32) — desde ADR-0154 solo hay ' +
          'dialecto postgres, así que esto NO existe en ningún hub:\n  - ' +
          prepared.errors.join('\n  - '),
      );
    } else {
      pgNote = ` + ${prepared.prepared} sentencia(s) PREPARAN en Postgres`;
    }
  }

  const sqlNote = warnings.length ? ` (${warnings.length} warning(s) SQL)` : '';
  // Never claim the handler was verified when it was not: on a runner with no checkout of
  // ERPlora/hub the path dependency is missing and nothing compiled (pm#107).
  const wasmNote = wasmResult.checked
    ? ' + handler WASM compila'
    : wasmResult.unverified
      ? ' + handler WASM SIN VERIFICAR'
      : '';
  console.log(
    `✓ validate ${manifest.id}: manifest OK + SQL portable${sqlNote} + contratos OK${wasmNote}${existsSync(bundle) ? ' + bundle CSP-safe' : ''}${pgNote}`,
  );
}

/// Comprueba que todo `commands[].handler` de tipo `wasm` tenga un source Rust que compila.
///
/// Devuelve `{ checked: bool, errors: string[], warnings: string[] }`:
/// - `checked: false` y sin errores → el módulo no declara WASM (o no trae `handler/`): válido.
/// - `checked: true` y sin errores → hay `handler/` y compila.
/// - `errors` no vacío → el source NO compila (fail).
/// No exige `wasm32`/`wasm-pack`: compila el crate del guest al target del host. Un source que
/// compila para el host compila para wasm32 (mismo código, solo cambia el target); si falta un
/// símbolo (el bug de `round_cents`) salta aquí igual. Así el check funciona sin toolchain wasm.
export function checkWasmHandler(dir, manifest, { runCargo = true } = {}) {
  const out = { checked: false, errors: [], warnings: [] };
  const cmds = Object.values(manifest.commands ?? {});
  const hasWasmHandler = cmds.some((c) => c?.handler?.type === 'wasm');
  if (!hasWasmHandler) return out; // módulo sin handler WASM: nada que verificar.

  const handlerDir = join(dir, 'handler');
  const cargoToml = join(handlerDir, 'Cargo.toml');
  if (!existsSync(cargoToml)) {
    // Hay handler wasm declarado pero no hay source distribuido. Es válido SOLO si hay una política
    // explícita de "wasm precompilado de terceros" — sin esa señal, avisamos (no bloqueamos, para
    // no romper módulos ya publicados sin source).
    out.warnings.push(
      'declara handler.type=wasm pero no trae handler/Cargo.toml: no se puede verificar que ' +
        'dist/handler.wasm se genere desde este commit. Si es un módulo first-party, añade handler/. ' +
        '(module-toolkit#135)',
    );
    return out;
  }

  // pm#107: 21 of the 24 modules depend on the hub's `guest-sdk` BY RELATIVE PATH
  // (`../../../../hub/crates/guest-sdk`). On a CI runner there is no checkout of ERPlora/hub there,
  // so `cargo` fails for a reason that has nothing to do with the module. Reporting that as
  // "handler/ does not compile" is a gate that LIES — it is what produced the false positives of
  // the pm#107 sweep (invoice/sales/taxes "broken" because the local hub checkout was on a branch
  // older than hub#423). So the missing checkout is detected BEFORE running cargo and said out
  // loud: not verified, and why.
  const missingPaths = missingPathDeps(handlerDir);
  if (missingPaths.length) {
    out.unverified = true;
    out.warnings.push(
      `handler/Cargo.toml depende por RUTA de ${missingPaths.map((p) => `\`${p.dep}\` → \`${p.path}\``).join(', ')}, ` +
        'que no existe aquí (es el checkout de ERPlora/hub, ausente en un runner de CI). ' +
        'El handler WASM NO se ha verificado: no se sabe si compila. Clona ERPlora/hub en esa ruta ' +
        'o consume el guest-sdk versionado (module-toolkit#32).',
    );
    return out;
  }
  if (!runCargo) return out;

  // module-toolkit#31: `validate` COMPRUEBA, no modifica. Pero la verificación de aquí abajo es un
  // `cargo build`, y cargo reescribe `handler/Cargo.lock` con lo que resuelva el checkout LOCAL del
  // hub (el guest-sdk entra por RUTA): `erplora-guest-sdk 0.0.0` → `1.0.0` tras hub#515. Ese lock
  // se cuela luego en un `git add -A` que nadie lee en review, y encima pone ROJO el gate de
  // publicación — el lock es también fuente hasheada del handler, así que invalida
  // `dist/handler.build.json` (ERPlora/inventory#46). Así que se guarda antes y se restaura después:
  // lo que valida no deja rastro.
  const lockPath = join(handlerDir, 'Cargo.lock');
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath) : null;

  let cargoOk = false;
  try {
    // `cargo build` sin features de guest: compila el crate como rlib (los tests unitarios hacen
    // lo mismo). Compila el source y sus dependencias; cualquier error de compilación salta aquí.
    const args = ['build', '--manifest-path', cargoToml, '--quiet'];
    const res =
      typeof runCargo === 'function'
        ? runCargo(args, { cwd: handlerDir })
        : spawnSync('cargo', args, { encoding: 'utf8', timeout: 300000 });
    if (res.status === 0) {
      cargoOk = true;
    } else {
      const tail = (res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-8).join('\n    ');
      out.errors.push(`handler/ no compila (module-toolkit#135):\n    ${tail || 'cargo terminó sin salida'}`);
    }
  } catch (e) {
    out.warnings.push(
      `no se pudo ejecutar \`cargo\` para verificar el handler WASM (${e.code === 'ENOENT' ? 'cargo no instalado' : e.message}). ` +
        'El dist no se ha verificado contra el source. (module-toolkit#135)',
    );
    return out;
  } finally {
    restoreCargoLock(lockPath, lockBefore);
  }

  out.checked = cargoOk;
  return out;
}

/** Devuelve `handler/Cargo.lock` a como estaba (o lo borra si no existía). module-toolkit#31. */
function restoreCargoLock(lockPath, before) {
  if (before === null) {
    if (existsSync(lockPath)) rmSync(lockPath, { force: true });
    return;
  }
  if (!existsSync(lockPath) || !readFileSync(lockPath).equals(before)) writeFileSync(lockPath, before);
}

/**
 * Path dependencies declared in `handler/Cargo.toml` whose directory is NOT on disk.
 *
 * 🔴 It MOVED to `run-cargo.mjs` (module-toolkit#146) and is re-exported here so the name keeps
 * working. Both halves of the toolkit that touch the handler crate ask the same question — this one
 * to decide whether the wasm can be verified, `runRustTests` to decide whether the handler's own
 * tests can run — and answering it twice is exactly how the gate's `ls` of two suffixes ended up
 * disagreeing with the toolkit's own discovery (#55). It cannot live HERE because `run-cargo.mjs`
 * must stay importable without `typescript`, which this module pulls in through `contracts.mjs`.
 */
export { missingPathDeps };
