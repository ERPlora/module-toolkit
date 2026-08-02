// `erplora validate <dir>`: valida el manifest (espejo de schemas/module.schema.json),
// el SQL portable "ERPlora SQL" (ADR-0007) y, si hay bundle, que sea CSP-safe.
// Sin dependencias externas.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { validateSql } from './validate-sql.mjs';
import { checkMigrations } from './validate-migrations.mjs';
import { lintSchema, collectSchemaFiles } from './validate-schemas.mjs';
import { checkContracts } from './contracts.mjs';
import { checkPgCompat } from './validate-pg.mjs';

// Validación CSP: el bundle no puede usar eval/new Function (los bloquea `script-src 'self'`).
export function assertCspSafe(code, label = 'bundle') {
  const hits = [];
  for (const _ of code.matchAll(/\beval\s*\(/g)) hits.push('eval(');
  for (const _ of code.matchAll(/new\s+Function\s*\(/g)) hits.push('new Function(');
  if (hits.length) {
    throw new Error(`${label}: ${hits.length} uso(s) que la CSP estricta bloquearía (${[...new Set(hits)].join(', ')}).`);
  }
}

export async function validate(moduleDir) {
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

  if (errs.length) throw new Error('manifest inválido:\n  - ' + errs.join('\n  - '));

  // ADR-0007 punto 3: rechazar SQL no portable (queries/commands/migraciones de ambos
  // dialectos). Lanza si hay errores; imprime warnings (heurística de dinero).
  const { warnings } = validateSql(dir, manifest);

  // Compatibilidad Postgres (auditoría pm#16; actualizada tras ADR-0154 + hub#210): la familia
  // que mató 4 P0 en Hub Cloud. ERRORES que rompen en PG (multi-statement en un prepared
  // statement, ON CONFLICT sin cualificar) bloquean; WARNINGS de patrón (CASE WHEN sobre bool ya
  // obsoleto por la coerción central, `:param IS NULL` sin tipo → posible 42P08) solo avisan.
  const pg = checkPgCompat(dir, manifest);
  for (const w of pg.filter((f) => f.level === 'warning')) {
    console.warn(`⚠ ${manifest.id}: [${w.rule}] ${w.message}`);
  }
  const pgErrors = pg.filter((f) => f.level === 'error');
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

  // ADR-0127: los contratos consumidos (queries/commands/eventos/slots que la UI usa de otros
  // módulos) se verifican en BUILD contra los manifests del workspace. Antes, un renombrado en el
  // proveedor lo descubría un cajero al abrir el TPV.
  const contracts = checkContracts(dir, manifest);
  for (const d of contracts.deferred) console.warn(`⚠ ${manifest.id}: ${d}`);
  if (contracts.errors.length) {
    throw new Error('contratos de interoperabilidad rotos (ADR-0127):\n  - ' + contracts.errors.join('\n  - '));
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

  const sqlNote = warnings.length ? ` (${warnings.length} warning(s) SQL)` : '';
  const wasmNote = wasmResult.checked ? ' + handler WASM compila' : '';
  console.log(
    `✓ validate ${manifest.id}: manifest OK + SQL portable${sqlNote} + contratos OK${wasmNote}${existsSync(bundle) ? ' + bundle CSP-safe' : ''}`,
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
export function checkWasmHandler(dir, manifest) {
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

  // Reusa el target compartido del workspace si existe; si no, uno del propio módulo.
  let cargoOk = false;
  try {
    // `cargo build` sin features de guest: compila el crate como rlib (los tests unitarios hacen
    // lo mismo). Compila el source y sus dependencias; cualquier error de compilación salta aquí.
    const args = ['build', '--manifest-path', cargoToml, '--quiet'];
    const res = spawnSync('cargo', args, { encoding: 'utf8', timeout: 300000 });
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
  }

  out.checked = cargoOk;
  return out;
}
