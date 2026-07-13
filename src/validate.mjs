// `erplora validate <dir>`: valida el manifest (espejo de schemas/module.schema.json),
// el SQL portable "ERPlora SQL" (ADR-0007) y, si hay bundle, que sea CSP-safe.
// Sin dependencias externas.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { validateSql } from './validate-sql.mjs';
import { checkMigrations } from './validate-migrations.mjs';
import { lintSchema, collectSchemaFiles } from './validate-schemas.mjs';

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

  const bundle = join(dir, 'dist', `${manifest.id}.esm.js`);
  if (existsSync(bundle)) assertCspSafe(readFileSync(bundle, 'utf8'), `${manifest.id} bundle`);

  const sqlNote = warnings.length ? ` (${warnings.length} warning(s) SQL)` : '';
  console.log(
    `✓ validate ${manifest.id}: manifest OK + SQL portable${sqlNote}${existsSync(bundle) ? ' + bundle CSP-safe' : ''}`,
  );
}
