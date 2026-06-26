// Tests del validador del bloque `capabilities` de module.json (ADR-0079). `node --test`.
// Cada regla con un caso que PASA y uno que FALLA, mensajes accionables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCapabilities } from '../src/validate.mjs';

const ok = (caps) => assert.deepEqual(validateCapabilities(caps), []);
const fails = (caps, re) => {
  const errs = validateCapabilities(caps);
  assert.ok(errs.length >= 1, 'esperaba al menos un error');
  assert.match(errs.join('\n'), re);
};

// ── bloque opcional / vacío ──────────────────────────────────────────────────────────────
test('PASA: capabilities ausente (undefined)', () => ok(undefined));
test('PASA: capabilities = {} (no pide permisos)', () => ok({}));

// ── el ejemplo completo del ADR ──────────────────────────────────────────────────────────
test('PASA: bloque completo válido', () =>
  ok({
    network: { allow: ['https://*.aeat.es'], secrets: [] },
    certificate: { purpose: 'fiscal-sign' },
    printer: {},
    notify: { channels: ['email'] },
  }));

// ── tipo del bloque ──────────────────────────────────────────────────────────────────────
test('FALLA: capabilities no es objeto (array)', () => fails([], /debe ser un objeto/));
test('FALLA: capabilities no es objeto (string)', () => fails('x', /debe ser un objeto/));

// ── capability desconocida (enum cerrado) ────────────────────────────────────────────────
test('FALLA: capability desconocida', () =>
  fails({ filesystem: {} }, /capability desconocida: filesystem/));

// ── cada capability debe ser objeto ──────────────────────────────────────────────────────
test('FALLA: network no es objeto', () => fails({ network: 'x' }, /capabilities\.network debe ser un objeto/));

// ── network.allow / network.secrets ──────────────────────────────────────────────────────
test('PASA: network sin campos', () => ok({ network: {} }));
test('FALLA: network.allow no es array de strings', () =>
  fails({ network: { allow: [1, 2] } }, /network\.allow debe ser un array de strings/));
test('FALLA: network.secrets no es array de strings', () =>
  fails({ network: { secrets: 'tok' } }, /network\.secrets debe ser un array de strings/));

// ── notify.channels ⊆ {email,sms,whatsapp} ───────────────────────────────────────────────
test('PASA: notify.channels válidos', () => ok({ notify: { channels: ['email', 'sms', 'whatsapp'] } }));
test('FALLA: notify.channels canal inválido', () =>
  fails({ notify: { channels: ['email', 'pigeon'] } }, /canal inválido: pigeon/));
test('FALLA: notify.channels no es array de strings', () =>
  fails({ notify: { channels: 'email' } }, /notify\.channels debe ser un array de strings/));

// ── certificate.purpose string ───────────────────────────────────────────────────────────
test('PASA: certificate sin purpose', () => ok({ certificate: {} }));
test('FALLA: certificate.purpose no es string', () =>
  fails({ certificate: { purpose: 42 } }, /certificate\.purpose debe ser un string/));

// ── printer no lleva campos ──────────────────────────────────────────────────────────────
test('PASA: printer vacío', () => ok({ printer: {} }));
