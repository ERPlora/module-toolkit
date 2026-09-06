// `erplora pack|sign|publish`: empaqueta el módulo para el marketplace (ARQUITECTURA.md §7.4, §2.2).
//  • pack    → build + module.zip + manifest.lock.json + SHA256
//  • sign    → SHA256 + FIRMA ed25519 detached (`<zip>.sig`) con la clave del marketplace
//  • publish → flujo hacia el Cloud Portal (NO automatizado: requiere auth + confirmación)
import { build } from './build.mjs';
import { validate } from './validate.mjs';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { signatureFileFor } from './signing.mjs';

// Lo que entra en el module.zip (resto se ignora: node_modules, .git, src TS, fixtures, etc.).
// El contrato: manifest + artefacto UI + SQL (Postgres) + WASM opcional + documentación.
// `locales` (ADR-0055): traducciones del módulo (`name`/`navigation` los lee el runtime del
// paquete; el bloque `ui` lo inlinea el bundler del WC en `dist`, pero se incluyen igualmente
// para que el runtime resuelva nombres/labels también en prod).
// `README.md`/`CHANGELOG.md` (ADR-0106): el SaaS los extrae del ZIP en cada sync y los guarda en
// `Module.readme`/`Module.changelog` para pintar la ficha de `/marketplace/<slug>/` desde la BD.
// Si no viajan aquí, la ficha se queda sin documentación — el ZIP es la fuente de verdad.
export const INCLUDE = [
  'module.json',
  'README.md',
  'CHANGELOG.md',
  'dist',
  'migrations',
  'queries',
  'commands',
  'schemas',
  'locales',
];

/** Rutas de `INCLUDE` presentes en `dir`, en el orden declarado. Es lo que acaba dentro del zip. */
export function packedPaths(dir) {
  return INCLUDE.filter((p) => existsSync(join(dir, p)));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export async function pack(moduleDir) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const id = manifest.id;
  const version = manifest.version;

  // `publishing: true` es lo que sube de aviso a bloqueo el caso «horneado por delante de todo
  // hub conocido» (module-toolkit#201). En `validate` a secas es aviso a propósito —el sello lo
  // pone el checkout compartido `../outfitkit`, no el autor—; aquí no, porque este zip va a un
  // cliente. Es el modelo de cualquier tienda: compilas con lo que quieras, la tienda comprueba.
  await validate(dir, { publishing: true });
  await build(dir); // asegura dist/<id>.esm.js fresco

  const present = packedPaths(dir);
  const outDir = join(dir, 'build');
  const zipPath = join(outDir, `${id}-v${version}.zip`);
  execFileSync('mkdir', ['-p', outDir]);
  execFileSync('rm', ['-f', zipPath]);

  // Zip determinista (sin extras de fecha) vía la CLI `zip`. Rutas relativas al dir del módulo.
  try {
    execFileSync('zip', ['-rqX', zipPath, ...present, '-x', '*/node_modules/*', '*/.git/*'], { cwd: dir });
  } catch (err) {
    throw new Error(`falló 'zip' (¿instalado?): ${err.message}`);
  }

  const zip = readFileSync(zipPath);
  const hash = sha256(zip);
  writeFileSync(`${zipPath}.sha256`, `${hash}  ${id}-v${version}.zip\n`);

  const lock = {
    id,
    version,
    sha256: hash,
    bytes: zip.length,
    contents: present,
    s3_path: `modules/${id}/v${version}.zip`, // ruta inmutable create-only (§2.2)
  };
  writeFileSync(join(outDir, 'manifest.lock.json'), JSON.stringify(lock, null, 2) + '\n');

  console.log(`✓ pack ${id} v${version}: ${(zip.length / 1024).toFixed(1)} KB
  zip:    ${zipPath}
  sha256: ${hash}
  lock:   ${join(outDir, 'manifest.lock.json')}`);
  return lock;
}

export async function sign(moduleDir) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const zipPath = join(dir, 'build', `${manifest.id}-v${manifest.version}.zip`);
  if (!existsSync(zipPath)) throw new Error(`no hay zip; ejecuta 'erplora pack ${manifest.id}' primero`);
  const hash = sha256(readFileSync(zipPath));
  writeFileSync(`${zipPath}.sha256`, `${hash}  ${manifest.id}-v${manifest.version}.zip\n`);

  // (#967, ADR-0193) El SHA256 se sigue escribiendo —es el contrato de integridad de ADR-0015 y
  // el Hub lo re-verifica al instalar—, pero YA NO es lo único: prueba que el zip llegó entero,
  // no de quién es. La firma ed25519 es lo que prueba autoría, y va aparte porque cubre el zip
  // completo (meterla dentro cambiaría lo firmado).
  //
  // Aquí SÍ se falla sin clave, al revés que en el SaaS: publicar no puede depender de que la
  // firma esté configurada, pero `sign` no tiene otra razón de ser. Salir con éxito sin haber
  // firmado es justo lo que hacía la versión anterior — decía «✓ sign» y no firmaba nada.
  const sigPath = signatureFileFor(zipPath);
  const { key_id: keyId } = JSON.parse(readFileSync(sigPath, 'utf8'));

  console.log(`✓ sign ${manifest.id} v${manifest.version}
  sha256: ${hash}
  firma:  ${sigPath}  (ed25519, key_id ${keyId})`);
  console.log(`  Súbelo junto al zip: el SaaS expone la firma en versions/ y el Hub la verifica
  contra su anillo (HUB_MODULE_TRUSTED_KEYS) antes de instalar.`);
}

export async function publish(moduleDir) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const lockPath = join(dir, 'build', 'manifest.lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;

  console.log(`publish ${manifest.id} v${manifest.version} — NO automatizado por seguridad.

El alta en el marketplace es una acción autenticada contra el Cloud Portal (no la hace el toolkit
sin confirmación). Flujo:

  1. erplora pack ${manifest.id}        ${lock ? `(hecho: sha256 ${lock.sha256.slice(0, 12)}…)` : '(pendiente)'}
  2. Subir el zip al Object Storage, en ruta INMUTABLE create-only:
     modules/${manifest.id}/v${manifest.version}.zip
     Reescribir una versión ya subida rompe el SHA256 de los clientes ya desplegados.
  3. Registrar/actualizar en Cloud vía API REST (repos/import o bulk), como vendor del módulo.
     El Cloud valida entitlement, guarda versión + SHA256 y publica si procede.

La clasificación (sectores/pricing/is_published) se edita en el vendor portal de Cloud, NO aquí.`);
}
