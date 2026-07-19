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

test('loadSlot lleva el prefijo del PROPIO módulo (el host define sus puntos de extensión)', () => {
  const errs = validateBeta(`await erplora().loadSlot('alpha.detail.actions');`);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /alpha\.detail\.actions/);
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
