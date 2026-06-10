// `erplora validate <dir>`: valida el manifest (espejo de schemas/module.schema.json) y,
// si hay bundle, que sea CSP-safe. Sin dependencias externas.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
  // La clasificación de marketplace NO debe estar en el manifest (ARQUITECTURA.md §2.4).
  for (const forbidden of ['sectors', 'business_types', 'functional_unit', 'pricing']) {
    if (forbidden in manifest) errs.push(`campo prohibido en manifest (vive en Cloud): ${forbidden}`);
  }

  if (errs.length) throw new Error('manifest inválido:\n  - ' + errs.join('\n  - '));

  const bundle = join(dir, 'dist', `${manifest.id}.esm.js`);
  if (existsSync(bundle)) assertCspSafe(readFileSync(bundle, 'utf8'), `${manifest.id} bundle`);

  console.log(`✓ validate ${manifest.id}: manifest OK${existsSync(bundle) ? ' + bundle CSP-safe' : ''}`);
}
