// Tests del validador de JSON Schemas de comandos (ADR-0007: dinero = INTEGER en céntimos).
//
// El contrato «dinero = céntimos» estaba enforced en la BD (`validate-sql.mjs` rechaza NUMERIC) y
// en la UI (formatMoney divide entre 100), pero NO en el sitio por donde entra el payload: el JSON
// Schema del comando. Todos declaraban `"type": "number"`, así que el runtime aceptaba `2.20` donde
// el contrato exige `220` — y como el bind manda el float a una columna INTEGER, el producto se
// guardaba a 2 céntimos sin que nada se quejara.
//
// Un módulo Tier-2 (WASM) tenía red (`as_cents` redondeaba), pero uno Tier-0 (SQL declarativo) no
// tiene ninguna. Y los módulos los escribe una IA: la convención en un comentario no basta, tiene
// que fallar el build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSchema, isMoneyField, collectSchemaFiles } from '../src/validate-schemas.mjs';

const errors = (schema) => lintSchema(schema, 'x.json').filter((f) => f.level === 'error');

// ── qué schemas se revisan: los que el RUNTIME compila (los declarados en el manifest) ───
test('recoge los schemas declarados por comandos y queries del manifest', () => {
  const manifest = {
    commands: {
      'sales.complete_sale': { schema: 'schemas/complete_sale.json' },
      'sales.void': { sql: ['commands/void.sql'] }, // sin schema → no aporta
    },
    queries: {
      'sales.list': { list: {} },
      'sales.get': { schema: 'schemas/sale_get.json' },
    },
  };
  assert.deepEqual(collectSchemaFiles('.', manifest).sort(), [
    'schemas/complete_sale.json',
    'schemas/sale_get.json',
  ]);
});

test('un manifest sin comandos ni queries no revienta', () => {
  assert.deepEqual(collectSchemaFiles('.', {}), []);
});

// ── qué cuenta como DINERO (y qué no) ───────────────────────────────────────────────────
test('reconoce los nombres de dinero del dominio', () => {
  for (const n of ['price', 'unit_price', 'cost', 'unit_cost', 'amount', 'total', 'subtotal',
                   'base_amount', 'tax_amount', 'amount_tendered', 'service_price', 'amount_cents']) {
    assert.equal(isMoneyField(n), true, `${n} es dinero`);
  }
});
test('NO confunde tasas, cantidades ni identificadores con dinero', () => {
  // El bug de ERPlora fue exactamente este: meter en el mismo saco lo que es dinero (céntimos
  // enteros) y lo que NO lo es (una tasa % lleva decimales; una cantidad puede ser 1,5 kg).
  for (const n of ['tax_rate', 'discount_percent', 'commission_rate', 'rate_pct',
                   'quantity', 'qty', 'stock', 'price_list_id', 'due_date']) {
    assert.equal(isMoneyField(n), false, `${n} NO es dinero`);
  }
});

// ── la regla ────────────────────────────────────────────────────────────────────────────
test('PASA: dinero declarado integer', () => {
  const s = { type: 'object', properties: { price: { type: 'integer', minimum: 0 } } };
  assert.equal(errors(s).length, 0);
});

test('FALLA: dinero declarado number (acepta 2.20 → 2 céntimos)', () => {
  const s = { type: 'object', properties: { price: { type: 'number' } } };
  const e = errors(s);
  assert.equal(e.length, 1);
  assert.match(e[0].kind, /dinero/i);
  assert.match(e[0].detail, /price/);
});

test('FALLA: dinero declarado como number|string', () => {
  const s = { type: 'object', properties: { amount: { type: ['number', 'string'] } } };
  assert.equal(errors(s).length, 1);
});

test('PASA: dinero nullable declarado integer|null', () => {
  const s = { type: 'object', properties: { unit_cost: { type: ['integer', 'null'] } } };
  assert.equal(errors(s).length, 0);
});

test('PASA: una TASA sí puede llevar decimales', () => {
  const s = { type: 'object', properties: { tax_rate: { type: 'number' } } };
  assert.equal(errors(s).length, 0);
});

test('PASA: una CANTIDAD sí puede llevar decimales (1,5 kg)', () => {
  const s = { type: 'object', properties: { quantity: { type: 'number' } } };
  assert.equal(errors(s).length, 0);
});

// ── recursión: el dinero de una venta va DENTRO de items[] ───────────────────────────────
test('FALLA: dinero dentro de items[] de un array', () => {
  // `sales.complete_sale` es exactamente esta forma: el precio va en `items[].price`. Si la regla
  // no baja al array, el comando que más dinero mueve del hub se queda sin validar.
  const s = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: 'object', properties: { price: { type: 'number' } } },
      },
    },
  };
  const e = errors(s);
  assert.equal(e.length, 1);
  assert.match(e[0].detail, /items\[\]\.price/);
});

test('FALLA: dinero en un objeto anidado', () => {
  const s = {
    type: 'object',
    properties: {
      payment: { type: 'object', properties: { amount: { type: 'number' } } },
    },
  };
  assert.match(errors(s)[0].detail, /payment\.amount/);
});

test('PASA: un schema sin dinero no dice nada', () => {
  const s = { type: 'object', properties: { name: { type: 'string' }, is_active: { type: 'integer' } } };
  assert.equal(errors(s).length, 0);
});
