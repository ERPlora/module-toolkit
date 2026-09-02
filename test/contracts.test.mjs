// Tests del extractor + validador de contratos de interoperabilidad (ADR-0127).
//
// El problema que esto mata: los contratos entre módulos (queries, commands, eventos, slots,
// depends_on) están declarados en module.json pero NADIE los verificaba. Si `taxes` renombra una
// query, `sales` se entera cuando un cajero abre el TPV. Evidencia de la misma semana: `reads`
// ignorado 3 semanas (el navegador decidía el IVA de la AEAT) y `page_size` inexistente (un TPV
// vendía 50 platos de 80). Contratos rotos = error de BUILD, ruidoso y con fichero:línea — nunca
// más un silencio de runtime.
//
// Diseño (debate 2026-07-13):
//   · AST, SOLO llamadas reales al SDK (nada de barrer strings con forma `modulo.algo`: un literal
//     parecido puede vivir en un mensaje de error o en código muerto → validador frágil).
//   · Identificador literal o error: `query(variable)` falla el build (no se siguen variables).
//   · `.erplora/contracts.json` = artefacto GENERADO con la superficie consumida — mínimo,
//     ordenado, determinista (sin líneas ni timestamps). Se commitea; si está desactualizado, el
//     CI falla.
//   · `queryOptional` = la optionalidad es del MÓDULO (sin depends_on), no del contrato (el nombre
//     debe existir si el módulo es conocido).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractContracts,
  buildContracts,
  writeContractsFile,
  contractsFileIsStale,
  loadUniverse,
  crossValidate,
} from '../src/contracts.mjs';

// ── Un workspace de juguete: `alpha` (proveedor) y `beta` (consumidor) ───────────────────────
// Calca la forma real: alpha ≈ inventory/taxes (ofrece queries+commands y emite un evento);
// beta ≈ sales (depende de alpha y consume sus contratos desde la UI).

function fakeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'erplora-contracts-'));

  const alpha = join(ws, 'alpha');
  mkdirSync(join(alpha, 'ui', 'components'), { recursive: true });
  writeFileSync(
    join(alpha, 'module.json'),
    JSON.stringify({
      id: 'alpha',
      name: 'Alpha',
      version: '1.0.0',
      queries: { 'alpha.items.list': { sql: 'q.sql' }, 'alpha.items.get': { sql: 'g.sql' } },
      commands: {
        'alpha.items.create': { sql: ['c.sql'], emit: ['alpha.item.created'] },
      },
      ui: { provides_slots: [] },
    }),
  );

  const beta = join(ws, 'beta');
  mkdirSync(join(beta, 'ui', 'components'), { recursive: true });
  writeFileSync(
    join(beta, 'module.json'),
    JSON.stringify({
      id: 'beta',
      name: 'Beta',
      version: '1.0.0',
      depends_on: ['alpha'],
      queries: { 'beta.things.list': { sql: 'q.sql' } },
      commands: {
        'beta.things.create': { sql: ['c.sql'], reads: ['alpha.items.list'] },
      },
      events: { listen: { 'alpha.item.created': { command: 'beta.things.create' } } },
    }),
  );

  return { ws, alpha, beta };
}

const write = (dir, rel, code) => {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, code);
};

// ═══ EXTRACCIÓN (AST, solo llamadas al SDK) ══════════════════════════════════════════════════

test('detecta query/queryAll/queryPage/command con literal', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    const c = erplora();
    await c.query('alpha.items.get', { id });
    await c.queryAll<Item>('alpha.items.list');
    await c.queryPage('beta.things.list', { limit: 50 });
    await c.command('beta.things.create', { name: 'x' });
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.queries, ['alpha.items.get', 'alpha.items.list', 'beta.things.list']);
  assert.deepEqual(consumes.commands, ['beta.things.create']);
});

test('detecta un command dentro de un thunk (el literal viaja EN la llamada al SDK)', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    // patrón helper refactorizado: this.run(() => erplora().command('…', p))
    this.run(() => erplora().command('beta.things.create', payload));
  `);
  const { consumes, violations } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.commands, ['beta.things.create']);
  assert.equal(violations.length, 0);
});

test('reconoce createListController (el nombre va en el ARGUMENTO 1) e imports con alias', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    import { createListController as mkCtrl } from '@erplora/module-sdk';
    this.ctrl = mkCtrl(erplora(), 'alpha.items.list', () => this.requestUpdate(), { pageSize: 50 });
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.queries, ['alpha.items.list']);
});

test('reconoce on() y loadSlot()', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    this.unsub = erplora().on('alpha.item.created', () => this.reload());
    const wcs = await erplora().loadSlot('beta.detail.actions');
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.events, ['alpha.item.created']);
  assert.deepEqual(consumes.slots, ['beta.detail.actions']);
});

test('queryOptional se registra APARTE (consumo opcional, no obligatorio)', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    const extra = await erplora().queryOptional<Item[]>('alpha.items.list');
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.optional_queries, ['alpha.items.list']);
  assert.deepEqual(consumes.queries, []);
});

test('queryAllOptional is recorded as OPTIONAL, just like queryOptional (ERPlora/sales#186)', () => {
  // The pair the SDK was missing: the WHOLE set of a module that may not be installed. If the
  // extractor does not recognize it, the call shows up nowhere — and a contract nobody declares is
  // a contract nobody checks, not here, not at publish time, not at install time. That silence is
  // exactly what this gate exists to prevent.
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    const todo = await erplora().queryAllOptional<Item[]>('alpha.items.list');
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.optional_queries, ['alpha.items.list']);
  assert.deepEqual(consumes.queries, [], 'optional: it is NOT a mandatory consumption');
});

test('queryAllOptional does NOT require depends_on, and DOES require the contract to exist (sales#186)', () => {
  assert.deepEqual(
    validateBeta(`await erplora().queryAllOptional('alpha.items.list');`, (m) => { m.depends_on = []; }),
    [],
    'the optionality belongs to the MODULE: no hard dependency',
  );
  const errs = validateBeta(`await erplora().queryAllOptional('alpha.items.search');`, (m) => { m.depends_on = []; });
  assert.equal(errs.length, 1, 'known provider + non-existent query = broken contract, not optionality');
  assert.match(errs[0], /alpha\.items\.search/);
});

test('IGNORA strings normales: un literal con forma modulo.algo fuera del SDK no es contrato', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    // ni el mensaje, ni la constante muerta, ni el .join cuentan como contrato
    const DOC = 'usa alpha.items.list para listar';
    throw new Error('fallo en alpha.items.get');
    const partes = ['alpha.items', 'list'].join('.');
  `);
  const { consumes } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.queries, []);
  assert.deepEqual(consumes.commands, []);
});

test('ignora los .test.ts (los dobles mockean nombres a propósito)', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.test.ts', `
    await erplora().query('esto.no.existe');
  `);
  const { consumes, violations } = extractContracts(beta, readManifest(beta));
  assert.deepEqual(consumes.queries, []);
  assert.equal(violations.length, 0);
});

// ═══ LA REGLA DURA: literal o error ══════════════════════════════════════════════════════════

test('RECHAZA query(variable): contrato dinámico = violación con fichero y línea', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    const name = 'alpha.items.list';
    await erplora().query(name);
  `);
  const { violations } = extractContracts(beta, readManifest(beta));
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /din[áa]mico/i);
  assert.match(violations[0].file, /x\.ts$/);
  assert.equal(typeof violations[0].line, 'number');
});

test('el escape explícito silencia UNA línea: // erplora-contracts: ignore', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    // erplora-contracts: ignore
    await erplora().command(dynamicName, payload);
  `);
  const { violations } = extractContracts(beta, readManifest(beta));
  assert.equal(violations.length, 0);
});

// ═══ contracts.json: generado, estable, ordenado ═════════════════════════════════════════════

test('genera contracts.json mínimo, ordenado y determinista (sin líneas ni timestamps)', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `
    await erplora().query('beta.things.list');
    await erplora().query('alpha.items.get');
    await erplora().query('alpha.items.get'); // duplicada → una sola vez
  `);
  const manifest = readManifest(beta);
  const a = buildContracts(beta, manifest);
  const b = buildContracts(beta, manifest);
  assert.deepEqual(a, b, 'dos generaciones = byte a byte iguales');
  assert.equal(a.schema_version, 1);
  assert.equal(a.module, 'beta');
  assert.deepEqual(a.consumes.queries, ['alpha.items.get', 'beta.things.list'], 'ordenado y sin duplicados');
  for (const k of Object.keys(a)) assert.ok(!['generated_at', 'sources'].includes(k), 'sin timestamps ni líneas');
});

test('contractsFileIsStale: al día = false, desactualizado o ausente = true', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('alpha.items.get');`);
  const manifest = readManifest(beta);

  assert.equal(contractsFileIsStale(beta, manifest), true, 'sin fichero → desactualizado');
  writeContractsFile(beta, manifest);
  assert.equal(contractsFileIsStale(beta, manifest), false, 'recién generado → al día');

  write(beta, 'ui/components/x.ts', `await erplora().query('alpha.items.list');`);
  assert.equal(contractsFileIsStale(beta, manifest), true, 'el código cambió → desactualizado');
});

// ═══ VALIDACIÓN CRUZADA contra el universo del workspace ════════════════════════════════════

function validateBeta(code, mutateManifest) {
  const { ws, beta } = fakeWorkspace();
  if (code) write(beta, 'ui/components/x.ts', code);
  const manifest = readManifest(beta);
  mutateManifest?.(manifest);
  const universe = loadUniverse(ws);
  return crossValidate(manifest, buildContracts(beta, manifest), universe);
}

test('en verde: todo lo consumido existe y está en depends_on → 0 errores', () => {
  const errs = validateBeta(`
    await erplora().query('alpha.items.list');
    await erplora().command('beta.things.create', p);
    erplora().on('alpha.item.created', cb);
  `);
  assert.deepEqual(errs, []);
});

test('un evento DECLARADO por el emisor sí valida en verde (sin aplazamiento)', () => {
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `erplora().on('alpha.item.created', cb);`);
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
  assert.deepEqual(deferred.filter((d) => d.includes('alpha.item.created')), []);
});

// hub#681 / saas#1535 / sales#111 — `depends_on` admite la forma objeto `{ id, min_version }` (un
// SUELO de versión). El contrato de interoperabilidad se comprueba por ID: una dependencia declarada
// así es tan dependencia como el string plano — si no, un módulo que declara su suelo pasaba a
// «llamada a un módulo que no está en depends_on» y el gate lo tiraba.
test('la forma objeto {id, min_version} de depends_on cuenta como dependencia declarada', () => {
  const { ws, beta } = fakeWorkspace();
  const manifestPath = join(beta, 'module.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  m.depends_on = [{ id: 'alpha', min_version: '1.2.0' }];
  writeFileSync(manifestPath, JSON.stringify(m));
  write(beta, 'ui/components/x.ts', `await erplora().query('alpha.items.list');`);
  const manifest = readManifest(beta);
  const { errors } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
});

test('caza el nombre PROPIO inexistente (typo contra uno mismo)', () => {
  const errs = validateBeta(`await erplora().query('beta.thing.list');`); // singular: no existe
  assert.equal(errs.length, 1);
  assert.match(errs[0], /beta\.thing\.list/);
});

test('caza la query ajena que NO existe en el manifest del dueño', () => {
  const errs = validateBeta(`await erplora().query('alpha.items.search');`);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /alpha\.items\.search/);
});

test('exige depends_on para una llamada externa normal', () => {
  const errs = validateBeta(`await erplora().query('alpha.items.list');`, (m) => {
    m.depends_on = []; // beta deja de declarar la dependencia
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /depends_on/);
});

test('queryOptional NO exige depends_on…', () => {
  const errs = validateBeta(`await erplora().queryOptional('alpha.items.list');`, (m) => {
    m.depends_on = [];
  });
  assert.deepEqual(errs, [], 'la optionalidad es del módulo: sin dependencia dura');
});

test('…pero queryOptional SÍ exige que el contrato exista si el módulo es conocido', () => {
  const errs = validateBeta(`await erplora().queryOptional('alpha.items.search');`, (m) => {
    m.depends_on = [];
  });
  assert.equal(errs.length, 1, 'proveedor conocido + query inexistente = contrato roto, no optionalidad');
  assert.match(errs[0], /alpha\.items\.search/);
});

test('queryOptional a un módulo DESCONOCIDO no es error en build (se resuelve en instalación)', () => {
  const errs = validateBeta(`await erplora().queryOptional('gamma.stuff.list');`);
  assert.deepEqual(errs, []);
});

test('detecta reads inexistentes (declarados en el manifest, no en el TS)', () => {
  const errs = validateBeta(null, (m) => {
    m.commands['beta.things.create'].reads = ['alpha.items.export']; // no existe en alpha
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /alpha\.items\.export/);
});

test('una read PARAMETRIZADA ({query, params}, ReadDef::Parameterized del runtime) valida en verde', () => {
  // El runtime acepta reads en dos formas (manifest.rs, enum untagged): "q.name" y
  // { query, params }. El validador petaba con TypeError en la segunda (read.split).
  const errs = validateBeta(null, (m) => {
    m.commands['beta.things.create'].reads = [
      { query: 'alpha.items.list', params: { id: 'payload.thing_id' } },
    ];
  });
  assert.deepEqual(errs, []);
});

test('una read parametrizada con query INEXISTENTE es el mismo error que la forma string', () => {
  const errs = validateBeta(null, (m) => {
    m.commands['beta.things.create'].reads = [
      { query: 'alpha.items.export', params: { id: 'payload.thing_id' } },
    ];
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /alpha\.items\.export/);
});

test('detecta eventos desconocidos (listen y on) — APLAZADOS en fase 1, no error', () => {
  // Muchos eventos reales se emiten DINÁMICAMENTE desde el handler WASM (`sale.completed`,
  // `kitchen.order.fired`) y hoy NO son declarables sin provocar doble emisión (el runtime emite
  // lo declarado ADEMÁS de lo del handler, y aún no hay dedup). Hasta la fase 3 (declaración
  // obligatoria de emisiones), un evento desconocido se APLAZA con aviso: un validador que
  // error-ea en falso se ignora, y eso mata el contrato entero.
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `erplora().on('alpha.item.compleated', cb);`);
  const manifest = readManifest(beta);
  manifest.events.listen['alpha.item.destroyed'] = { command: 'beta.things.create' };
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, [], 'en fase 1 no es error');
  assert.equal(deferred.filter((d) => /compleated|destroyed/.test(d)).length, 2, 'pero queda constancia de los dos');
});

// ── module-toolkit#35: el universo de eventos son las DOS fuentes del manifest ───────────────
// `commands[].emit` es lo que emite el dispatcher declarativo; `events.emits` es EL CATÁLOGO
// COMPLETO, incluidos los que devuelve el handler WASM y que no salen de ningún command. Tras
// hub#709 el catálogo pasó de 11 eventos declarados a 179, y 32 de ellos —`sale.completed`,
// `order.fired`, los 9 de `kitchen`— viven SOLO en `events.emits`. Mirando una sola fuente, el
// validador seguía aplazando como «nadie lo declara» justo los eventos más importantes del hub.
test('el universo de eventos incluye `events.emits`, no solo `commands[].emit` (#35)', () => {
  const { ws, alpha, beta } = fakeWorkspace();
  const alphaManifest = JSON.parse(readFileSync(join(alpha, 'module.json'), 'utf8'));
  // Un evento que emite el handler WASM: declarado en el catálogo, ausente de todo command.
  alphaManifest.events = { emits: ['alpha.batch.settled'] };
  writeFileSync(join(alpha, 'module.json'), JSON.stringify(alphaManifest));

  write(beta, 'ui/components/x.ts', `erplora().on('alpha.batch.settled', cb);`);
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
  assert.deepEqual(deferred, [], 'lo declara su emisor: no hay nada que aplazar');
});

test('las dos fuentes se SUMAN: `commands[].emit` sigue contando (#35)', () => {
  // El cambio amplía lo que el validador conoce; nada de lo que antes pasaba puede volverse
  // desconocido, o el gate recién desplegado en los 25 repos empieza a mentir por el otro lado.
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `erplora().on('alpha.item.created', cb);`);
  const manifest = readManifest(beta);
  const { deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(deferred, [], 'el evento sigue saliendo de commands[].emit');
});

// ── ERPlora/hub#1076 / module-toolkit#133: `commands[].emit` gana la forma objeto ────────────
// `emit` acepta ahora el nombre plano de siempre O un objeto `{event, dedup_key}` (hub#1076): el
// universo de eventos tiene que seguir contando por el NOMBRE del evento en las dos formas, o un
// módulo que adopte `dedup_key` deja de figurar como emisor de lo que sigue emitiendo.
test('un emit en forma objeto {event, dedup_key} cuenta por su `event` (hub#1076 / module-toolkit#133)', () => {
  const { ws, alpha, beta } = fakeWorkspace();
  const alphaManifest = JSON.parse(readFileSync(join(alpha, 'module.json'), 'utf8'));
  alphaManifest.commands['alpha.items.create'].emit = [
    { event: 'alpha.item.created', dedup_key: 'sku' },
  ];
  writeFileSync(join(alpha, 'module.json'), JSON.stringify(alphaManifest));

  write(beta, 'ui/components/x.ts', `erplora().on('alpha.item.created', cb);`);
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
  assert.deepEqual(deferred, [], 'lo declara su emisor en forma objeto: no hay nada que aplazar');
});

// ── module-toolkit#37: escuchar un evento del CORE no es un typo ─────────────────────────────
// `hub.` es el namespace RESERVADO del core (ADR-0192): esos eventos los escribe el runtime en
// `_event_outbox` y no salen de ningún manifest, así que resolverlos contra lo que emiten los
// módulos del workspace es preguntarle a la fuente equivocada. El aviso decía «typo o emisión
// dinámica» de algo que es el patrón recomendado (hub#659/#664), y la fase 3 de ADR-0127 lo
// volvería un ERROR: el gate rechazaría a todo módulo que reaccione a lo que entra por WhatsApp.
test('escuchar un evento del CORE (`hub.*`) no se aplaza como typo (#37)', () => {
  const { ws, beta } = fakeWorkspace();
  const manifest = readManifest(beta);
  manifest.events.listen['hub.whatsapp.message_received'] = { command: 'beta.things.create' };
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, [], 'el core no es una dependencia declarable');
  assert.deepEqual(deferred, [], 'ni un aplazado: el namespace del core siempre está');
});

test('`on()` sobre un evento del CORE tampoco se aplaza (#37)', () => {
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `erplora().on('hub.whatsapp.message_received', cb);`);
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
  assert.deepEqual(deferred, []);
});

test('un evento de MÓDULO que nadie declara se sigue aplazando (#37 no abre la mano)', () => {
  // El carve-out es del namespace del core, no de los eventos en general: la puerta que cazaba
  // los typos de los módulos tiene que seguir cazándolos.
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `erplora().on('alpha.item.compleated', cb);`);
  const manifest = readManifest(beta);
  const { deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.equal(deferred.length, 1, 'el typo de un evento de módulo sigue quedando por escrito');
});

test('loadSlot lleva el prefijo del PROPIO módulo (el host define sus puntos de extensión)', () => {
  const errs = validateBeta(`await erplora().loadSlot('alpha.detail.actions');`);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /alpha\.detail\.actions/);
});

// El core NO es un módulo: `hub.` es su namespace reservado en el dispatcher (ADR-0192). Un módulo
// que lee la identidad del Hub (p. ej. `staff`, que vincula su ficha de profesional a un usuario)
// no puede —ni debe— declarar `depends_on: ["hub"]`: no hay nada que instalar ni que resolver en el
// topo-orden. El validador tiene que conocerlo, o el gate rechaza un módulo perfectamente correcto.
test('las queries del CORE (`hub.*`) no exigen depends_on ni existen como módulo', () => {
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('hub.users.list');`);
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, [], 'el core no es una dependencia declarable');
  assert.deepEqual(deferred, [], 'ni algo aplazado: el core siempre está');
});

test('una query del core que NO existe sí es un contrato roto', () => {
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('hub.inventado.list');`);
  const manifest = readManifest(beta);
  const { errors } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hub\.inventado\.list/);
});

test('un depends_on ausente del workspace APLAZA su chequeo (CI por-módulo), no lo inventa', () => {
  const { ws, beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('delta.rows.list');`);
  const manifest = readManifest(beta);
  manifest.depends_on = ['delta']; // delta NO está en el workspace
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, []);
  assert.equal(deferred.length, 1, 'queda constancia de lo que no se pudo comprobar');
});

// helpers de los tests
function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
}
import { crossValidateFull } from '../src/contracts.mjs';

// ═══ Integración en `erplora validate` ═══════════════════════════════════════════════════════
import { checkContracts } from '../src/contracts.mjs';

test('checkContracts: violación dinámica O contrato roto O fichero desactualizado = errores', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('alpha.items.search');`); // no existe
  const manifest = readManifest(beta);

  const r = checkContracts(beta, manifest);
  assert.ok(r.errors.some((e) => e.includes('alpha.items.search')), 'contrato roto detectado');
  assert.ok(r.errors.some((e) => e.includes('contracts.json')), 'y el fichero ni existe → desactualizado');
});

test('checkContracts en verde: código correcto + contracts.json al día = 0 errores', () => {
  const { beta } = fakeWorkspace();
  write(beta, 'ui/components/x.ts', `await erplora().query('alpha.items.list');`);
  const manifest = readManifest(beta);
  writeContractsFile(beta, manifest);
  const r = checkContracts(beta, manifest);
  assert.deepEqual(r.errors, []);
});

// ── Un `read` OPCIONAL a un módulo que no está en el workspace se APLAZA, no falla ───────────
//
// Lo que esto mata (pm#93, 2026-08-21): `sales` declaró el primer `reads` con `required: false`
// del repo — la forma DOCUMENTADA de decir «este módulo puede no estar instalado» — y el gate lo
// tumbó con «la query `modifiers.options.all` no existe». En LOCAL pasaba, porque el módulo nuevo
// estaba en el disco al lado; en CI solo se hace checkout del módulo que se valida, así que el
// universo tiene un solo elemento y el dueño nunca aparece.
//
// La asimetría estaba en el propio validador: `checkOperation` YA aplaza esto para
// `queryOptional` («para queryOptional a un módulo fuera del universo, se resuelve en la
// instalación»), pero el bloque de `reads` no tenía esa rama y trataba igual a un read opcional
// que a uno obligatorio. Es un camino que nadie había ejercitado: hasta ese día no existía ni un
// `required: false` en ningún manifest.
//
// El límite se mantiene: si el módulo SÍ está en el universo, un nombre inventado sigue siendo un
// contrato roto. Opcional es la AUSENCIA del módulo, no el typo.

function conRead(beta, read) {
  const manifestPath = join(beta, 'module.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const first = Object.keys(m.commands ?? {})[0];
  m.commands[first].reads = [read];
  writeFileSync(manifestPath, JSON.stringify(m));
  return first;
}

test('un read con required:false a un módulo AUSENTE del workspace se aplaza, no es error', () => {
  const { ws, beta } = fakeWorkspace();
  conRead(beta, { query: 'gamma.options.all', required: false }); // `gamma` no existe en el ws
  const manifest = readManifest(beta);
  const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.deepEqual(errors, [], 'un read opcional a un módulo ausente NO puede tumbar el gate');
  assert.ok(
    deferred.some((d) => d.includes('gamma.options.all')),
    'y se aplaza CON CONSTANCIA, para que no desaparezca en silencio',
  );
});

test('un read OBLIGATORIO a un módulo ausente sigue siendo error', () => {
  const { ws, beta } = fakeWorkspace();
  conRead(beta, { query: 'gamma.options.all', required: true });
  const manifest = readManifest(beta);
  const { errors } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.equal(errors.length, 1, 'sin `required: false` no hay indulto');
  assert.match(errors[0], /gamma\.options\.all/);
});

test('un read opcional a un módulo PRESENTE con nombre inventado sigue siendo error', () => {
  const { ws, beta } = fakeWorkspace();
  conRead(beta, { query: 'alpha.no.existe', required: false }); // `alpha` SÍ está en el ws
  const manifest = readManifest(beta);
  const { errors } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
  assert.equal(errors.length, 1, 'opcional es la AUSENCIA del módulo, no un typo');
  assert.match(errors[0], /alpha\.no\.existe/);
});

// ═══ The core namespace: the hand-copied list against the VENDORED kernel contract ════════════
//
// `CORE_OPERATIONS.queries` (src/contracts.mjs) is copied BY HAND from the runtime's `CORE_QUERIES`
// (`hub/crates/runtime/src/hub_users.rs`), and `test/canonical-mirrors.test.mjs` already compares
// the two — but only where there is a hub to compare against, which is CI and nowhere else. It
// skips itself otherwise, and a skip is not a denial: it stays open.
//
// So the same drift gets a second door, and this one needs no hub. `contracts/kernel/engine.snapshot`
// is VENDORED here — the hub generates it from its own code, `npm run sync-mirrors` copies it, and
// its `[core_queries]` section is the same list. Reading the copy that is already in the checkout
// turns "the mirror was resynced and the hand-copied list was not" into a red test on the very pull
// request that does the resync, on any runner, with the hub nowhere in sight.
//
// It is the exact hole this pair fell into (pm#232): mt#165 synced `engine.snapshot` for the core
// query `hub.fiscal.transmission` that hub#1453 had just added, and left `CORE_OPERATIONS` behind —
// the expensive direction of the drift, where a module consuming a REAL core query is told by the
// gate that it does not exist.
import { CORE_OPERATIONS } from '../src/contracts.mjs';
import { VENDORED_KERNEL_CONTRACT_DIR } from '../src/kernel-contract.mjs';

/** A `[section]` of a kernel snapshot → its lines, in order. Absent section = an error, never []. */
function kernelSnapshotSection(file, section) {
  const text = readFileSync(join(VENDORED_KERNEL_CONTRACT_DIR, file), 'utf8');
  // No `m` flag on purpose: with it, `$` matches at every line break and the lazy group stops at
  // the FIRST entry — which reads as a section of one and passes for a list that has just been
  // emptied. The anchor is the string, so `^` is spelled out as "start, or after a newline".
  const block = new RegExp(`(?:^|\\n)\\[${section}\\]\\n([\\s\\S]*?)(?=\\n\\[|$)`).exec(text);
  assert.ok(block, `\`[${section}]\` is no longer a section of contracts/kernel/${file} — update the reader`);
  return block[1].split('\n').filter((line) => line.trim() && !line.startsWith('#'));
}

test('the core queries the gate accepts are EXACTLY the vendored kernel contract (pm#232)', () => {
  assert.deepEqual(
    CORE_OPERATIONS.queries,
    kernelSnapshotSection('engine.snapshot', 'core_queries'),
    'contracts/kernel/engine.snapshot was resynced and CORE_OPERATIONS (src/contracts.mjs) was not: ' +
      'a module consuming that core query is about to be rejected as a typo by the gate of 27 repos',
  );
});

test('every core query on the list really passes the gate as a consumption (pm#232)', () => {
  // The list is the DOOR, not decoration: `crossValidateFull` is what a module walks through.
  // What this catches, verified by mutation: a door that stops consulting `CORE_OPERATIONS` and
  // freezes a copy of its own goes red here while the mirror above stays green. What it does NOT
  // catch — and cannot, because the list IS the definition of the namespace — is an invented name
  // added to the list and to the snapshot alike; that one is the hub's own kernel-contract test.
  // The negative half of the door is covered above: `hub.inventado.list` stays an error.
  for (const query of CORE_OPERATIONS.queries) {
    const { ws, beta } = fakeWorkspace();
    write(beta, 'ui/components/x.ts', `await erplora().query('${query}');`);
    const manifest = readManifest(beta);
    const { errors, deferred } = crossValidateFull(manifest, buildContracts(beta, manifest), loadUniverse(ws));
    assert.deepEqual(errors, [], `\`${query}\` is a core query and the gate rejects it`);
    assert.deepEqual(deferred, [], `\`${query}\` must not be deferred: the core is always there`);
  }
});
