// Firma ed25519 del `module.zip` (#967, ADR-0193) — el lado CLI.
//
// `erplora sign` solo (re)calculaba un SHA256 y lo decía por pantalla. Eso prueba **integridad
// de transporte**, no **autoría**: cualquiera con acceso de escritura al zip publicado, a la
// caché de descargas o a `HUB_MODULES_DIR` podía sustituirlo por código propio —migraciones SQL
// y handlers WASM— y el hub lo ejecutaba.
//
// **El formato no se decide aquí.** Lo manda el verificador, que ya está desplegado
// (`hub/crates/cloud-client/src/signature.rs`, hub#239), y con el que el SaaS ya es compatible
// (`apps/public/modules/signing.py`, saas#1113). Los tres tienen que coincidir byte a byte:
//
//   • ed25519 detached, 64 bytes, sobre TODOS los bytes del zip;
//   • JSON `{ "key_id": "...", "sig_b64": "<base64 estándar>" }`;
//   • `key_id` = `mk-` + los 16 primeros hex del sha256 de la pública cruda.
//
// Ese `key_id` se calcula igual que en el SaaS a propósito: si cada firmante derivara el suyo,
// el mismo par de claves tendría dos identidades según quién hubiera firmado, y la traza de
// «con qué clave se firmó esto» dejaría de servir.
//
// **Sin dependencias**: Node trae ed25519 nativo. Meter una librería de criptografía de terceros
// en la cadena de publicación sería añadir justo la superficie que esta issue viene a cerrar.
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** Variable de entorno con la semilla privada (32 bytes en base64 o hex). */
export const KEY_ENV = 'MODULE_SIGNING_KEY';

const SEED_LEN = 32;

// Cabecera PKCS#8 de una privada ed25519 (RFC 8410). Node no importa la semilla cruda, así que
// se le antepone para construir el DER que sí acepta. Son bytes fijos del ASN.1, no un truco.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** `mk-` + sha256(pública cruda)[:16]. Idéntico a `signing._key_id` del SaaS. */
export function keyIdFor(publicRaw) {
  return 'mk-' + createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);
}

function decodeSeed(encoded) {
  const raw = (encoded || '').trim();
  if (!raw) {
    throw new Error(
      `falta la clave privada de firma: pon ${KEY_ENV} (semilla ed25519 de 32 bytes en base64 o hex)`,
    );
  }

  for (const enc of ['hex', 'base64']) {
    // `Buffer.from` no valida: para descartar una cadena que no es de ese formato hay que
    // comprobar que el round-trip devuelve lo mismo.
    const buf = Buffer.from(raw, enc);
    if (buf.length === SEED_LEN && buf.toString(enc).toLowerCase() === raw.toLowerCase()) return buf;
  }

  throw new Error(
    `${KEY_ENV} no es una semilla ed25519 válida: se esperan 32 bytes en base64 o hex`,
  );
}

function privateKeyFrom(encodedSeed) {
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, decodeSeed(encodedSeed)]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * Firma los bytes del zip. Devuelve el objeto que deserializa `cloud_client::ModuleSignature`.
 *
 * Lanza si no hay clave o si es ilegible — al revés que el SaaS, donde publicar no puede fallar
 * por esto. Aquí firmar es la ÚNICA razón de ejecutar el comando: terminar con éxito sin haber
 * firmado sería mentir por pantalla, que es exactamente lo que hacía la versión anterior.
 */
export function signZipBytes(zipBytes, encodedSeed = process.env[KEY_ENV]) {
  const privateKey = privateKeyFrom(encodedSeed);
  // La pública se deriva de la privada (no se pide aparte): así el `key_id` no puede acabar
  // describiendo una clave distinta de la que firma.
  const publicRaw = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32);
  const signature = cryptoSign(null, zipBytes, privateKey);
  return { key_id: keyIdFor(publicRaw), sig_b64: signature.toString('base64') };
}

/**
 * Firma el zip de `zipPath` y escribe `<zipPath>.sig`. Devuelve la ruta del `.sig`.
 *
 * Fichero aparte y no dentro del zip: la firma cubre el zip **entero**, así que meterla dentro
 * cambiaría lo firmado. Es la misma razón por la que la firma es *detached*.
 */
export function signatureFileFor(zipPath, encodedSeed = process.env[KEY_ENV]) {
  const signature = signZipBytes(readFileSync(zipPath), encodedSeed);
  const out = `${zipPath}.sig`;
  writeFileSync(out, JSON.stringify(signature, null, 2) + '\n');
  return out;
}
