// TDD (#967, ADR-0193) — `erplora sign` firma de verdad: ed25519 detached, no un SHA256.
//
// Hasta ahora `sign` solo (re)calculaba el SHA256 del zip y lo decía por pantalla: eso prueba
// **integridad de transporte**, no **autoría**. Cualquiera con acceso de escritura a la caché de
// descargas, a `HUB_MODULES_DIR` o al zip publicado podía sustituirlo por código propio
// (migraciones SQL + handlers WASM) y el hub lo ejecutaba.
//
// El formato NO se elige aquí: lo manda el verificador, que ya está desplegado
// (`hub/crates/cloud-client/src/signature.rs`, hub#239) y con el que el SaaS ya es compatible
// (`apps/public/modules/signing.py`, saas#1113). Los tres tienen que coincidir **byte a byte**:
//
//   • firma ed25519 detached de 64 bytes sobre TODOS los bytes del zip;
//   • fichero `<zip>.sig` con JSON `{ "key_id": "...", "sig_b64": "<base64 estándar>" }`;
//   • `key_id` = `mk-` + los 16 primeros hex del sha256 de la pública cruda (32 bytes),
//     idéntico a `signing._key_id` en el SaaS — si no, el mismo par de claves daría dos
//     identificadores distintos según quién firmara.
//
// Node trae ed25519 nativo (`crypto.sign(null, …)`), así que esto no añade dependencias: una
// librería de criptografía de terceros en la cadena de publicación sería justo el tipo de
// superficie que esta issue viene a cerrar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, verify, createHash } from 'node:crypto';

import { keyIdFor, signZipBytes, signatureFileFor } from '../src/signing.mjs';

/** Par ed25519 en el formato en que viaja la privada: semilla cruda de 32 bytes en base64. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return { publicKey, publicRaw: raw, seedB64: seed.toString('base64') };
}

const ZIP = Buffer.from('PK\x03\x04 contenido del module.zip');

// ── la firma ────────────────────────────────────────────────────────────────

test('la firma valida contra la clave pública', () => {
  const { publicKey, seedB64 } = keypair();

  const sig = signZipBytes(ZIP, seedB64);

  assert.ok(verify(null, ZIP, publicKey, Buffer.from(sig.sig_b64, 'base64')));
});

test('la firma es detached de 64 bytes', () => {
  const { seedB64 } = keypair();

  const sig = signZipBytes(ZIP, seedB64);

  assert.equal(Buffer.from(sig.sig_b64, 'base64').length, 64);
});

test('la firma cubre los BYTES del zip, no su hash', () => {
  // Si firmara el hash, quien conociera el hash podría reusar la firma con otro contenido.
  const { publicKey, seedB64 } = keypair();

  const sig = signZipBytes(ZIP, seedB64);

  assert.equal(verify(null, Buffer.concat([ZIP, Buffer.from('!')]), publicKey, Buffer.from(sig.sig_b64, 'base64')), false);
});

test('el JSON tiene exactamente las claves que deserializa el Hub', () => {
  const { seedB64 } = keypair();

  const sig = signZipBytes(ZIP, seedB64);

  assert.deepEqual(Object.keys(sig).sort(), ['key_id', 'sig_b64']);
});

// ── el key_id, que tiene que coincidir con el del SaaS ──────────────────────

test('el key_id se deriva de la pública igual que en el SaaS', () => {
  const { publicRaw } = keypair();

  // `signing._key_id` (saas): "mk-" + sha256(public_raw).hexdigest()[:16]
  const esperado = 'mk-' + createHash('sha256').update(publicRaw).digest('hex').slice(0, 16);

  assert.equal(keyIdFor(publicRaw), esperado);
});

test('el key_id es estable para la misma clave', () => {
  const { publicRaw } = keypair();

  assert.equal(keyIdFor(publicRaw), keyIdFor(publicRaw));
});

test('dos claves distintas dan key_id distintos', () => {
  assert.notEqual(keyIdFor(keypair().publicRaw), keyIdFor(keypair().publicRaw));
});

// ── formatos de clave aceptados ─────────────────────────────────────────────

test('acepta la semilla en hex además de en base64', () => {
  const { publicKey, seedB64 } = keypair();
  const seedHex = Buffer.from(seedB64, 'base64').toString('hex');

  const sig = signZipBytes(ZIP, seedHex);

  assert.ok(verify(null, ZIP, publicKey, Buffer.from(sig.sig_b64, 'base64')));
});

test('una clave ilegible falla con un mensaje que dice qué se esperaba', () => {
  assert.throws(() => signZipBytes(ZIP, 'esto-no-es-una-clave'), /32 bytes|base64|hex/i);
});

test('sin clave NO firma en silencio: lanza', () => {
  // Al revés que el SaaS, donde publicar no puede fallar. Aquí firmar es la ÚNICA razón de
  // ejecutar el comando: terminar con éxito sin haber firmado sería mentir por pantalla.
  assert.throws(() => signZipBytes(ZIP, ''), /clave/i);
});

// ── el fichero .sig junto al zip ────────────────────────────────────────────

test('el .sig se escribe junto al zip y es el JSON del contrato', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-sign-'));
  const zipPath = join(dir, 'inventory-v1.2.16.zip');
  writeFileSync(zipPath, ZIP);
  const { publicKey, seedB64 } = keypair();

  const out = signatureFileFor(zipPath, seedB64);

  assert.equal(out, `${zipPath}.sig`);
  assert.ok(existsSync(out));
  const sig = JSON.parse(readFileSync(out, 'utf8'));
  assert.ok(verify(null, ZIP, publicKey, Buffer.from(sig.sig_b64, 'base64')));
  rmSync(dir, { recursive: true, force: true });
});
