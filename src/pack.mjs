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
// `flows` (module-toolkit#209): las automatizaciones que el módulo trae DE FÁBRICA — el documento
// del flujo por idioma, los permisos que pedirá y el suelo de versión que necesita. Viajan como
// `locales`: por CONVENCIÓN de carpeta, sin clave en el manifest. Es deliberado — la raíz del
// manifest es un contrato CERRADO (ADR-0286), así que una clave nueva pondría un suelo de versión
// de hub a cada módulo que la declarase y avisaría en todos los hubs anteriores; por carpeta, un
// módulo publica hoy sus plantillas y el día que aterrice ERPlora/hub#1611 aparecen solas, sin
// republicar nada. Lo que hay dentro lo juzga `validate-flows.mjs`.
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
  'flows',
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

  // 🔴 SE CONSTRUYE PRIMERO Y SE VALIDA DESPUÉS, y el orden es el arreglo (module-toolkit#201, N-0
  // de la revisión de #202). `build` reescribe `dist/` —el bundle, el sello de frescura y
  // `dist/outfitkit.json` (`build.mjs`)—, así que validar antes es juzgar un artefacto que esta
  // misma función está a punto de sustituir. Medido sobre `customers`: sello commiteado 0.1.52,
  // `pack` EXIT=0 sin un solo aviso, y el zip salía con 0.1.59 — la versión que ningún hub sabe
  // pintar, o sea justo lo que este control existe para parar. Le pasaba a 25 de los 27 módulos.
  //
  // Y no era solo el sello de OutfitKit: `validate` comprueba también que el bundle sea CSP-safe,
  // y con el orden viejo comprobaba el bundle VIEJO y empaquetaba el nuevo. Validar lo que se
  // publica —y no lo que había en el árbol— cierra la familia entera de una vez.
  //
  // `publishing: true` es lo que sube de aviso a bloqueo el caso «horneado por delante de todo hub
  // conocido». En `validate` a secas es aviso a propósito —el sello lo pone el checkout compartido
  // `../outfitkit`, no el autor—; aquí no, porque este zip va a un cliente. Es el modelo de
  // cualquier tienda: compilas con lo que quieras, la tienda comprueba al enviar.
  //
  // ⚠️ El precio del orden nuevo, pagado aquí y no dejado caer: con un manifest roto, quien fallaba
  // antes era `validate` («id inválido», «version SemVer inválida») y ahora falla `build` primero,
  // con un «no encuentro entry de WC» que no dice la verdad del problema. Así que si `build` se
  // cae, se le pregunta al validador POR QUÉ: si el módulo ya era inválido, manda su mensaje; si
  // no, el fallo es de construcción de verdad y se propaga tal cual.
  try {
    await build(dir); // deja dist/ (bundle + sellos) tal y como va a viajar en el zip
  } catch (buildError) {
    await validate(dir); // lanza el error BUENO si el módulo era inválido de partida
    throw buildError; // el módulo es válido: el fallo es del build y se cuenta como tal
  }
  await validate(dir, { publishing: true });

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
