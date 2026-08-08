// Tests del bloque `fiscal_regime` del manifest (ADR-0259 D6, hub#555). `node --test`.
//
// Qué declara el bloque: **el régimen fiscal que este módulo IMPLEMENTA**. Solo lo declara quien
// implementa uno; un módulo de inventario no declara nada. Es lo que responde a la única pregunta
// del core: «¿hay algún módulo instalado y activo que cumpla el régimen que debe ESTE hub?».
//
// Por qué se valida AQUÍ y no solo en el schema: el propio troceo de hub#555 lo avisa — hoy
// `erplora validate` **no** valida el bloque `setup`, y la única puerta real acaba siendo el schema
// más el installer. Ese hueco no se repite. Un `country` que no case con nada se lee, aguas abajo,
// exactamente igual que «no hay proveedor instalado» — que es lo que para un TPV.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFiscalRegime } from '../src/validate.mjs';

const mod = (fiscal_regime) => ({ id: 'verifactu', name: 'VeriFactu', version: '1.5.6', fiscal_regime });

test('PASA: un proveedor declara país ISO-3166-1 α-2 y clave de régimen', () => {
  assert.deepEqual(checkFiscalRegime(mod({ country: 'ES', regime: 'verifactu' })), []);
});

test('PASA: sin bloque no hay nada que validar (los 24 módulos publicados)', () => {
  assert.deepEqual(checkFiscalRegime({ id: 'inventory', name: 'Inventory', version: '1.0.0' }), []);
});

test('FALLA: el país no es ISO-3166-1 α-2', () => {
  for (const country of ['', 'E', 'ESP', 'españa', 'E5']) {
    const errs = checkFiscalRegime(mod({ country, regime: 'verifactu' }));
    assert.equal(errs.length, 1, `${JSON.stringify(country)} tenía que rechazarse`);
    assert.match(errs[0], /ISO-3166-1/);
  }
});

test('FALLA: régimen vacío — declara nada con aspecto de declaración', () => {
  const errs = checkFiscalRegime(mod({ country: 'ES', regime: '   ' }));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /regime/);
});

test('FALLA: el bloque tiene que ser un objeto con las dos claves', () => {
  assert.equal(checkFiscalRegime(mod('verifactu')).length, 1);
  assert.equal(checkFiscalRegime(mod({ country: 'ES' })).length, 1);
  assert.equal(checkFiscalRegime(mod({ regime: 'verifactu' })).length, 1);
});
