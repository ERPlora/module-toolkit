// Validador de los JSON Schemas de comandos: EL DINERO ES UN ENTERO DE CÉNTIMOS (ADR-0007).
//
// El contrato ya estaba enforced en la BD (`validate-sql.mjs` rechaza NUMERIC/DECIMAL) y en la UI
// (`formatMoney` divide entre 100), pero NO en la puerta por donde entra el payload. Todos los
// schemas declaraban `"type": "number"` para los precios, así que el runtime aceptaba tan tranquilo
//
//     { "price": 2.20 }        ← euros, lo que teclea un humano
//
// donde el contrato exige `220`. Y como el bind manda el float a una columna INTEGER, el producto
// acababa costando 2 céntimos sin que nada fallara. Un módulo Tier-2 (WASM) tenía red de seguridad
// (`as_cents` redondeaba); uno Tier-0 (SQL declarativo) no tiene ninguna.
//
// Declararlo `integer` convierte esa corrupción silenciosa en un error de validación del runtime,
// que rechaza el comando ANTES de tocar la BD. Y como los módulos los escribe una IA, la regla no
// puede vivir en un comentario: falla el build.
//
// Lo que NO es dinero y por tanto SÍ puede llevar decimales:
//   · TASAS      — `tax_rate`, `discount_percent` (21 %, 12,5 %).
//   · CANTIDADES — `quantity`, `stock` (1,5 kg de tomate).
// Confundir las tres cosas es precisamente lo que rompió `pricing` (una columna «% o euros»).

/** Nombres que en el dominio de ERPlora son DINERO (columnas INTEGER de céntimos). */
const MONEY_NAMES =
  /(^|_)(price|cost|amount|total|subtotal|net|gross|tendered|change|balance|paid|due|fee|deposit|tip|cents)($|_)/;

/** Nombres que NO son dinero aunque se le parezcan: tasas, cantidades e identificadores. */
const NOT_MONEY = /(rate|percent|pct|ratio|quantity|qty|stock|count|units|_id$|_date$|_at$|horizon)/;

/**
 * DINERO aunque las regex generales digan lo contrario: una TARIFA por unidad de tiempo
 * (`hourly_rate`, céntimos/hora — así lo lista `money_backfill.rs::MONEY_COLUMNS`) es un
 * importe, no un porcentaje. `NOT_MONEY` la vetaba por contener `rate` y por ese falso
 * negativo `staff` declaró `hourly_rate: "number"` en 3 schemas sin que el build fallara.
 */
const MONEY_OVERRIDES = /(^|_)(hourly_rate|daily_rate|wage)($|_)/;

/** ¿El nombre de esta propiedad designa un importe de dinero? */
export function isMoneyField(name) {
  if (MONEY_OVERRIDES.test(name)) return true;
  return MONEY_NAMES.test(name) && !NOT_MONEY.test(name);
}

/**
 * Los schemas que el RUNTIME compila y hace cumplir: los declarados por los comandos y las queries
 * del manifest. Un `.json` suelto en `schemas/` que nadie declare no lo valida nadie, así que
 * tampoco lo revisamos aquí (la paridad manifest↔disco es otra regla).
 */
export function collectSchemaFiles(_dir, manifest) {
  const decls = [
    ...Object.values(manifest.commands ?? {}),
    ...Object.values(manifest.queries ?? {}),
  ];
  return [...new Set(decls.map((d) => d?.schema).filter(Boolean))];
}

/** Un `type` (string o array) que acepta decimales para un importe. */
function acceptsDecimals(type) {
  const types = Array.isArray(type) ? type : [type];
  // `string` también vale: un "12.99" se parsea como euros en algún sitio y vuelve el mismo bug.
  return types.includes('number') || types.includes('string');
}

/**
 * Recorre un JSON Schema y devuelve los importes de dinero que aceptan decimales.
 * Baja a `items` de los arrays y a los objetos anidados: el dinero de una venta vive en
 * `items[].price`, que es justo el comando que más dinero mueve del hub.
 */
export function lintSchema(schema, file) {
  const findings = [];

  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;

    for (const [name, spec] of Object.entries(node.properties || {})) {
      if (!spec || typeof spec !== 'object') continue;
      const full = path + name;

      if (isMoneyField(name) && acceptsDecimals(spec.type)) {
        findings.push({
          level: 'error',
          kind: 'dinero con decimales',
          file,
          detail:
            `\`${full}\` es dinero y se declara \`${JSON.stringify(spec.type)}\`: el runtime aceptaría ` +
            `2.20 (euros) donde el contrato exige 220 (céntimos), y el bind lo mandaría a una columna ` +
            `INTEGER → 2 céntimos. Declara \`"type": "integer"\` (ADR-0007). ` +
            `Si NO es dinero sino una tasa o una cantidad, renómbralo (\`*_rate\`, \`*_pct\`, \`quantity\`).`,
        });
      }

      walk(spec, full + '.');
      if (spec.items && typeof spec.items === 'object') walk(spec.items, full + '[].');
    }
  };

  walk(schema, '');
  return findings;
}
