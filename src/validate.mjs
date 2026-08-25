// `erplora validate <dir>`: valida el manifest, el SQL portable "ERPlora SQL" (ADR-0007) y, si hay
// bundle, que sea CSP-safe. Sin dependencias externas.
//
// El manifest se comprueba por DOS vías, y la primera dejó de ser un espejo escrito a mano
// (module-toolkit#30): las claves admitidas se LEEN del schema canónico
// (`schemas/module.schema.json`, vendorizado del hub — ver `manifest-schema.mjs`), así que un
// bloque nuevo del contrato se conoce en cuanto se sincroniza el schema. Lo que sigue escrito aquí
// son las reglas de FORMATO y de negocio que el schema no expresa (códigos de taxonomía, enums de
// billing, bloques movidos de sitio por el ADR-0007).
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { validateSql } from './validate-sql.mjs';
import { checkMigrations } from './validate-migrations.mjs';
import { checkMigrationGuard } from './validate-migration-guard.mjs';
import { checkIonicFill } from './validate-ionic-fill.mjs';
import { lintSchema, collectSchemaFiles } from './validate-schemas.mjs';
import { checkContracts } from './contracts.mjs';
import { checkPgCompat } from './validate-pg.mjs';
import { checkPrepare } from './validate-prepare.mjs';
import { checkWasmArtifact } from './wasm.mjs';
import { checkNotifyChannels } from './validate-notify-channels.mjs';
import { checkHandlerPermissionCeiling } from './validate-handler-permissions.mjs';
import { checkManifestKeys } from './validate-manifest-keys.mjs';
import { checkErrorsCatalog } from './validate-errors-catalog.mjs';

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

export async function validate(moduleDir, { pg = false } = {}) {
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
 * Deliberately a lexical read of the `path = "…"` entries and not a TOML parser: the toolkit ships
 * with no dependencies, and the shape in the 21 modules that have a handler is always the same one
 * line — `erplora-guest-sdk = { path = "../../../../hub/crates/guest-sdk" }`.
 */
export function missingPathDeps(handlerDir) {
  const cargoToml = join(handlerDir, 'Cargo.toml');
  if (!existsSync(cargoToml)) return [];
  const out = [];
  const text = readFileSync(cargoToml, 'utf8');
  for (const line of text.split('\n')) {
    const clean = line.split('#')[0];
    const hit = /^\s*([A-Za-z0-9_-]+)\s*=\s*\{[^}]*\bpath\s*=\s*"([^"]+)"/.exec(clean);
    if (!hit) continue;
    const abs = resolve(handlerDir, hit[2]);
    if (!existsSync(abs)) out.push({ dep: hit[1], path: hit[2], resolved: abs });
  }
  return out;
}
