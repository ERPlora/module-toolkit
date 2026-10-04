// Tests for the WORKFLOW.md lint (ERPlora/pm#621). `node --test`.
//
// Every component of ERPlora gets a versioned `WORKFLOW.md`: its functional spec (screens, flows,
// who else each flow touches). Workers, reviewers and QA read it before touching the component, and
// the `pm` index (`workflow-index.sh`) cross-checks the references between components. That index
// can only trust what it reads if every file follows ONE grammar, so the grammar is checked here,
// per component: format and internal coherence. Whether a referenced flow exists in another repo,
// and names this one back, is the index's job, not this one's.
//
// Severity, and why: the 27 modules consume this repository by `@main`, so what merges reaches all
// of them at once. A module WITHOUT the file is a WARNING (the migration is open); a file that is
// there and malformed is an ERROR.
//
// Not to be confused with `validate-flows` — «flows» in this repository are automations
// (`flows/*.flow.json`). This guard is the `workflow-doc`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintWorkflowText, checkWorkflowDoc } from '../src/validate-workflow-doc.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** The template of PROMPT-WORKFLOW.md, filled in for the `sales` module. */
const FLOW = `### SALES-F03 Cobrar un tique
Estado: hecho
Actor: cajero
Pantalla: Vender
Pasos:
1. Con el tique abierto en Vender, la persona pulsa Cobrar.
2. Elige el método de pago e introduce el importe entregado.
3. Pulsa Confirmar cobro.
4. El tique sale como cobrado y se imprime.
Entra: las líneas del tique abierto (Vender) y el turno de caja abierto (Caja).
Sale: el tique cobrado, el movimiento de caja y el registro fiscal (sale.paid).
Si falla: ve el aviso «No se pudo cobrar» y el tique sigue abierto para reintentar.
Implicados: CASH_REGISTER-F02, INVOICE-F01, REC_RESTAURANTE-F09
QA: R-08, BD-09`;

const RETIRED = `### SALES-F07 [retirado] Cobrar con vale antiguo
Implicados: ninguno`;

function doc({ prefix = 'Prefijo: SALES', scope = 'Alcance MVP: nucleo', flows = [FLOW, RETIRED], screens = true, flowsHeading = '## Flujos', before = '' } = {}) {
  return [
    '# WORKFLOW — Ventas',
    '',
    prefix,
    scope,
    '',
    '## Para qué sirve y para quién',
    'El TPV con el que el cajero cobra en la barra o en la mesa.',
    '',
    '## Referencia adoptada',
    'Square y Toast: el cobro en dos toques.',
    '',
    '## Antes de empezar',
    'Una caja abierta y los impuestos configurados.',
    before,
    ...(screens
      ? ['## Pantallas', '', '### Vender', 'Desde el menú, Ventas → Vender. Vacía muestra «Sin productos».', '']
      : []),
    flowsHeading,
    '',
    flows.join('\n\n'),
    '',
    '## Cobertura contra la referencia',
    '| Elemento | Estado |',
    '|---|---|',
    '| Cobro dividido | no hecho |',
    '',
    '## Datos: de quién es cada dato',
    'El tique es de ventas; el cliente lo lee de Clientes.',
    '',
    '## Reglas que no se rompen',
    'Dinero en céntimos; cada fila con su hub.',
    '',
    '## Lo que NO hace, a propósito',
    'No gestiona la carta.',
    '',
    '## Dudas abiertas',
    'Ninguna.',
    '',
  ].join('\n');
}

const lint = (text, opts = { prefix: 'SALES' }) => lintWorkflowText(text, opts);

/** Line number (1-based) of the first line of `text` that starts with `needle`. */
function lineOf(text, needle) {
  return text.split('\n').findIndex((l) => l.startsWith(needle)) + 1;
}

function assertOneError(out, pattern) {
  assert.equal(out.errors.length, 1, `expected exactly one error, got:\n${out.errors.join('\n')}`);
  assert.match(out.errors[0], pattern);
}

// ── The valid document ────────────────────────────────────────────────────────

test('PASSES: the PROMPT-WORKFLOW.md template, filled in, has no errors and no warnings', () => {
  assert.deepEqual(lint(doc()), { errors: [], warnings: [] });
});

test('PASSES: an area-qualified `## Flujos — <área>` heading counts as the flows section', () => {
  assert.deepEqual(lint(doc({ flowsHeading: '## Flujos — Cobro' })), { errors: [], warnings: [] });
});

test('every error carries the file and the line number', () => {
  const text = doc({ flows: [FLOW.replace('Estado: hecho', 'Estado: casi')] });
  const out = lint(text);
  assertOneError(out, new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Estado: casi')}: `));
});

// ── Header: Prefijo and Alcance MVP ───────────────────────────────────────────

test('ERROR: no `Prefijo:` line', () => {
  assertOneError(lint(doc({ prefix: '' })), /`Prefijo:`/);
});

test('ERROR: `Prefijo:` after the first `## ` section', () => {
  const text = doc({ prefix: '' }).replace('## Referencia adoptada', 'Prefijo: SALES\n## Referencia adoptada');
  assertOneError(lint(text), /`Prefijo:`.*before the first `## `/);
});

test('ERROR: `Prefijo:` twice', () => {
  const text = doc({ prefix: 'Prefijo: SALES\nPrefijo: SALES' });
  assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Prefijo:') + 1}: .*\`Prefijo:\`.*once`));
});

test('ERROR: a `Prefijo:` that is not upper case, digits and `_`', () => {
  const out = lint(doc({ prefix: 'Prefijo: sales' }), {});
  assertOneError(out, /`Prefijo: sales`/);
});

test('ERROR: in a module, `Prefijo` has to be the module id in upper case', () => {
  const text = doc({ prefix: 'Prefijo: VENTAS' }).replaceAll('SALES-F', 'VENTAS-F');
  assertOneError(lint(text, { prefix: 'SALES' }), /`VENTAS`.*expected `SALES`/);
});

test('ERROR: no `Alcance MVP:` line', () => {
  assertOneError(lint(doc({ scope: '' })), /`Alcance MVP:`/);
});

test('ERROR: an `Alcance MVP` value outside the vocabulary', () => {
  assertOneError(lint(doc({ scope: 'Alcance MVP: core' })), /`Alcance MVP: core`.*nucleo/);
});

test('PASSES: every value of the `Alcance MVP` vocabulary', () => {
  for (const v of ['nucleo', 'restaurante', 'peluqueria', 'transversal', 'fuera del MVP', 'congelado']) {
    assert.deepEqual(lint(doc({ scope: `Alcance MVP: ${v}` })).errors, [], v);
  }
});

// ── Required sections ─────────────────────────────────────────────────────────

test('ERROR: no `## Pantallas` section', () => {
  assertOneError(lint(doc({ screens: false })), /`## Pantallas`/);
});

test('ERROR: no `## Flujos` section', () => {
  assertOneError(lint(doc({ flowsHeading: '## Procesos', flows: [] })), /`## Flujos`/);
});

// ── Flow headers ──────────────────────────────────────────────────────────────

test('ERROR: a flow ID with a single digit (`SALES-F3`)', () => {
  const text = doc({ flows: [FLOW.replace('SALES-F03', 'SALES-F3'), RETIRED] });
  assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, '### SALES-F3')}: .*\`SALES-F3\``));
});

test('ERROR: a `### ` heading inside `## Flujos` that is not a flow header', () => {
  assertOneError(lint(doc({ flows: [FLOW, '### Cobrar sin ID\nEstado: hecho'] })), /`### Cobrar sin ID`/);
});

test('ERROR: the same flow ID twice in one file', () => {
  const text = doc({ flows: [FLOW, FLOW.replace('Cobrar un tique', 'Otra cosa')] });
  const out = lint(text);
  assertOneError(out, /`SALES-F03`.*twice|`SALES-F03`.*already/);
  assert.match(out.errors[0], new RegExp(`:${lineOf(text, '### SALES-F03 Cobrar un tique')}\\b`), 'names the first one');
});

test('ERROR: a flow ID whose prefix is not the file `Prefijo`', () => {
  assertOneError(lint(doc({ flows: [FLOW.replace('SALES-F03', 'INVOICE-F03')] })), /`INVOICE-F03`.*`SALES`/);
});

// ── The nine keys of a live flow ──────────────────────────────────────────────

for (const key of ['Estado:', 'Actor:', 'Pantalla:', 'Pasos:', 'Entra:', 'Sale:', 'Si falla:', 'Implicados:', 'QA:']) {
  test(`ERROR: a live flow without \`${key}\``, () => {
    const flow = FLOW.split('\n').filter((l) => !l.startsWith(key)).join('\n');
    const text = doc({ flows: [flow] });
    assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, '### SALES-F03')}: .*\`SALES-F03\`.*\`${key}\``));
  });
}

test('ERROR: a key repeated inside one flow', () => {
  const text = doc({ flows: [FLOW.replace('Actor: cajero', 'Actor: cajero\nActor: encargado')] });
  assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Actor: encargado')}: .*\`Actor:\`.*once`));
});

test('ERROR: `Estado:` outside `hecho`, `parcial`, `no hecho`', () => {
  assertOneError(lint(doc({ flows: [FLOW.replace('Estado: hecho', 'Estado: hechos')] })), /`Estado: hechos`/);
});

test('PASSES: `parcial` and `no hecho` followed by what is missing', () => {
  for (const s of ['Estado: parcial — falta el cobro dividido', 'Estado: no hecho — sin pantalla todavía', 'Estado: no hecho']) {
    assert.deepEqual(lint(doc({ flows: [FLOW.replace('Estado: hecho', s)] })).errors, [], s);
  }
});

test('a key that is not at the start of the line does not count', () => {
  const flow = FLOW.replace('Actor: cajero', ' Actor: cajero');
  assertOneError(lint(doc({ flows: [flow] })), /`Actor:`/);
});

// ── Implicados ────────────────────────────────────────────────────────────────

for (const [label, value] of [
  ['lower case', 'payments-f01'],
  ['a space instead of the dash', 'PAYMENTS F01'],
  ['a trailing comma', 'PAYMENTS-F01,'],
  ['a comma without the space', 'PAYMENTS-F01,INVOICE-F01'],
]) {
  test(`ERROR: a malformed \`Implicados\` token (${label})`, () => {
    const text = doc({ flows: [FLOW.replace(/^Implicados: .*$/m, `Implicados: ${value}`)] });
    assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Implicados:')}: .*Implicados`));
  });
}

test('ERROR: `Implicados` naming a flow of its own prefix', () => {
  const text = doc({ flows: [FLOW.replace(/^Implicados: .*$/m, 'Implicados: CASH_REGISTER-F02, SALES-F05')] });
  assertOneError(lint(text), /`SALES-F05`.*own prefix/);
});

test('PASSES: `Implicados: ninguno`', () => {
  assert.deepEqual(lint(doc({ flows: [FLOW.replace(/^Implicados: .*$/m, 'Implicados: ninguno')] })).errors, []);
});

// ── Implicados: pendiente (every link still a `Pendiente de enlazar:` line) ────

const PENDING = 'Pendiente de enlazar: kitchen — el envío de la comanda a cocina';
const withImplicados = (value, ...below) =>
  FLOW.replace(/^Implicados: .*$/m, [`Implicados: ${value}`, ...below].join('\n'));

test('PASSES: `Implicados: pendiente` with its `Pendiente de enlazar:` lines', () => {
  assert.deepEqual(lint(doc({ flows: [withImplicados('pendiente', PENDING, PENDING.replace('kitchen', 'tables'))] })), {
    errors: [],
    warnings: [],
  });
});

test('ERROR: `Implicados: pendiente` without any `Pendiente de enlazar:` line', () => {
  const text = doc({ flows: [withImplicados('pendiente')] });
  assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Implicados: pendiente')}: .*\`SALES-F03\`.*pendiente.*Pendiente de enlazar:`));
});

test('ERROR: `Implicados: ninguno` with a `Pendiente de enlazar:` line below', () => {
  const text = doc({ flows: [withImplicados('ninguno', PENDING)] });
  assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, 'Pendiente de enlazar:')}: .*\`SALES-F03\`.*ninguno.*pendiente`));
});

test('PASSES: a list of IDs with `Pendiente de enlazar:` lines below', () => {
  assert.deepEqual(lint(doc({ flows: [withImplicados('CASH_REGISTER-F02', PENDING)] })).errors, []);
});

test('ERROR: a `[retirado]` flow with `Implicados: pendiente`', () => {
  assertOneError(lint(doc({ flows: [FLOW, `${RETIRED.replace('ninguno', 'pendiente')}\n${PENDING}`] })), /`SALES-F07`.*retirado.*ninguno/);
});

// ── Actor, Pantalla, QA: free text, but never empty ───────────────────────────

for (const key of ['Actor:', 'Pantalla:', 'QA:']) {
  test(`ERROR: an empty \`${key}\``, () => {
    const text = doc({ flows: [FLOW.replace(new RegExp(`^${key} .*$`, 'm'), key)] });
    assertOneError(lint(text), new RegExp(`^WORKFLOW\\.md:${lineOf(text, key)}: .*\`SALES-F03\`.*\`${key}\`.*empty`));
  });
}

test('PASSES: free-text values of Actor, Pantalla and QA', () => {
  const flow = FLOW.replace('Actor: cajero', 'Actor: empleado, asistente')
    .replace('Pantalla: Vender', 'Pantalla: Caja: Cierre de turno')
    .replace('QA: R-08, BD-09', 'QA: WR-03 (discrepa), qa-hub-restaurant §05');
  assert.deepEqual(lint(doc({ flows: [flow] })).errors, []);
});

test('ERROR: a `[retirado]` flow with references', () => {
  assertOneError(lint(doc({ flows: [FLOW, RETIRED.replace('ninguno', 'INVOICE-F01')] })), /`SALES-F07`.*retirado.*ninguno/);
});

test('ERROR: a `[retirado]` flow without `Implicados: ninguno`', () => {
  assertOneError(lint(doc({ flows: [FLOW, '### SALES-F07 [retirado] Cobrar con vale antiguo'] })), /`SALES-F07`.*`Implicados: ninguno`/);
});

test('PASSES: `Pendiente de enlazar:` under `Implicados` is not an error', () => {
  const flow = FLOW.replace(/^(Implicados: .*)$/m, '$1\nPendiente de enlazar: kitchen — el envío de la comanda a cocina');
  assert.deepEqual(lint(doc({ flows: [flow] })), { errors: [], warnings: [] });
});

// ── Robustness ────────────────────────────────────────────────────────────────

test('a flow header and keys inside a ``` block are ignored', () => {
  const example = ['```markdown', '### SALES-F3 ejemplo mal formado', 'Estado: inventado', 'Prefijo: OTRO', '## Pantallas', '```', ''].join('\n');
  assert.deepEqual(lint(doc({ before: example })), { errors: [], warnings: [] });
});

test('a flow header and keys inside a ~~~ block are ignored', () => {
  const example = ['~~~', '### SALES-F03 duplicado dentro de un bloque', 'Implicados: SALES-F01', '~~~', ''].join('\n');
  assert.deepEqual(lint(doc({ before: example })), { errors: [], warnings: [] });
});

test('CRLF line endings pass', () => {
  assert.deepEqual(lint(doc().replaceAll('\n', '\r\n')), { errors: [], warnings: [] });
});

test('WARNS: a WORKFLOW.md longer than 600 lines (split it into workflow/<slug>.md)', () => {
  const long = doc({ before: Array.from({ length: 600 }, (_, i) => `Paso de preparación ${i}.`).join('\n') });
  const out = lint(long);
  assert.deepEqual(out.errors, []);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /600/);
  assert.match(out.warnings[0], /workflow\/<slug>\.md/);
});

test('SILENT: 500 lines is under the size limit', () => {
  const text = doc({ before: Array.from({ length: 450 }, (_, i) => `Paso de preparación ${i}.`).join('\n') });
  assert.ok(text.split('\n').length > 450 && text.split('\n').length < 600);
  assert.deepEqual(lint(text), { errors: [], warnings: [] });
});

test('PASSES: the optional `## Fuentes contrastadas` section, present or not', () => {
  const text = `${doc()}\n## Fuentes contrastadas\nEl manual dice «Cobrar»; el código, «Pagar».\n`;
  assert.deepEqual(lint(text), { errors: [], warnings: [] });
});

// ── Family (hub, saas, gateway, cross-component journeys) ─────────────────────

test('family: the prefix is the family itself or starts with `<FAMILY>_`', () => {
  const asHub = (p) => doc({ prefix: `Prefijo: ${p}` }).replaceAll('SALES-F', `${p}-F`);
  assert.deepEqual(lint(asHub('HUB'), { family: 'HUB' }).errors, []);
  assert.deepEqual(lint(asHub('HUB_SHELL'), { family: 'HUB' }).errors, []);
  assertOneError(lint(asHub('SAAS_DEMO'), { family: 'HUB' }), /`SAAS_DEMO`.*`HUB`/);
  assertOneError(lint(asHub('HUBX'), { family: 'HUB' }), /`HUBX`.*`HUB`/);
});

// ── checkWorkflowDoc: the module folder ───────────────────────────────────────

/** Temporary module with an optional WORKFLOW.md and optional `workflow/*.md` parts. */
function mod(manifest, { workflow, parts = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wfdoc-'));
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  if (workflow !== undefined) writeFileSync(join(dir, 'WORKFLOW.md'), workflow);
  if (Object.keys(parts).length) {
    mkdirSync(join(dir, 'workflow'), { recursive: true });
    for (const [name, text] of Object.entries(parts)) writeFileSync(join(dir, 'workflow', name), text);
  }
  return dir;
}

const base = (extra) => ({ id: 'sales', name: 'Sales', version: '1.0.0', ...extra });

/** A `workflow/<slug>.md` part: same prefix, its own flows. */
const part = (flows) => ['# WORKFLOW — Ventas · Devoluciones', '', 'Prefijo: SALES', '', '## Flujos — Devoluciones', '', flows, ''].join('\n');

test('WARNS (never errors): a module without WORKFLOW.md', () => {
  const dir = mod(base());
  try {
    const out = checkWorkflowDoc(dir, base());
    assert.deepEqual(out.errors, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /WORKFLOW\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES: a module with a valid WORKFLOW.md', () => {
  const dir = mod(base(), { workflow: doc() });
  try {
    assert.deepEqual(checkWorkflowDoc(dir, base()), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERROR: the module `Prefijo` is not its id in upper case', () => {
  const dir = mod(base({ id: 'cash_register' }), { workflow: doc() });
  try {
    const out = checkWorkflowDoc(dir, base({ id: 'cash_register' }));
    assert.equal(out.errors.length, 1, out.errors.join('\n'));
    assert.match(out.errors[0], /^WORKFLOW\.md:\d+: .*`SALES`.*expected `CASH_REGISTER`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES: a WORKFLOW.md split into workflow/*.md parts', () => {
  const refund = FLOW.replace('SALES-F03 Cobrar un tique', 'SALES-F11 Devolver un tique');
  const dir = mod(base(), { workflow: doc(), parts: { 'devoluciones.md': part(refund) } });
  try {
    assert.deepEqual(checkWorkflowDoc(dir, base()), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES: an index with no flow of its own, its `## Flujos` a table pointing at the parts', () => {
  const table = ['| Flujo | Fichero |', '|---|---|', '| SALES-F03 Cobrar un tique | workflow/cobro.md |'].join('\n');
  const dir = mod(base(), { workflow: doc({ flows: [table] }), parts: { 'cobro.md': part(FLOW) } });
  try {
    assert.deepEqual(checkWorkflowDoc(dir, base()), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERROR: a workflow/x.md part without its `Prefijo:` line', () => {
  const dir = mod(base(), { workflow: doc(), parts: { 'x.md': part(FLOW.replace('SALES-F03', 'SALES-F11')).replace('Prefijo: SALES\n', '') } });
  try {
    const out = checkWorkflowDoc(dir, base());
    assert.equal(out.errors.length, 1, out.errors.join('\n'));
    assert.match(out.errors[0], /^workflow\/x\.md:\d+: .*`Prefijo:`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERROR: a workflow/x.md part without `## Flujos`', () => {
  const noFlows = part(FLOW.replace('SALES-F03', 'SALES-F11')).replace('## Flujos — Devoluciones', '## Devoluciones');
  const dir = mod(base(), { workflow: doc(), parts: { 'x.md': noFlows } });
  try {
    const out = checkWorkflowDoc(dir, base());
    assert.ok(out.errors.some((e) => /^workflow\/x\.md:\d+: .*`## Flujos`/.test(e)), out.errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERROR: a flow ID repeated between WORKFLOW.md and workflow/x.md', () => {
  const dir = mod(base(), { workflow: doc(), parts: { 'x.md': part(FLOW) } });
  try {
    const out = checkWorkflowDoc(dir, base());
    assert.equal(out.errors.length, 1, out.errors.join('\n'));
    assert.match(out.errors[0], /^workflow\/x\.md:\d+: .*`SALES-F03`.*WORKFLOW\.md:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ERROR: a workflow/x.md part with another prefix', () => {
  const other = part(FLOW.replaceAll('SALES-F', 'INVOICE-F')).replace('Prefijo: SALES', 'Prefijo: INVOICE');
  const dir = mod(base(), { workflow: doc(), parts: { 'x.md': other } });
  try {
    const out = checkWorkflowDoc(dir, base());
    assert.ok(out.errors.length >= 1);
    assert.match(out.errors[0], /^workflow\/x\.md:\d+: .*`INVOICE`.*expected `SALES`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SILENT: the 600-line limit applies to WORKFLOW.md, the parts are where the detail goes', () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    FLOW.replace('SALES-F03 Cobrar un tique', `SALES-F${String(20 + i).padStart(2, '0')} Variante ${i}`),
  ).join('\n\n');
  const dir = mod(base(), { workflow: doc(), parts: { 'variantes.md': part(many) } });
  try {
    assert.deepEqual(checkWorkflowDoc(dir, base()), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wired into `erplora validate` ─────────────────────────────────────────────

test('WIRED: `erplora validate` passes (and warns) on a module without WORKFLOW.md', async () => {
  const dir = mod(base());
  const warned = [];
  const original = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    writeContractsFile(dir, base());
    await assert.doesNotReject(() => validate(dir));
    assert.ok(warned.some((w) => /WORKFLOW\.md/.test(w)), `no WORKFLOW.md warning among:\n${warned.join('\n')}`);
  } finally {
    console.warn = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WIRED: `erplora validate` rejects a module whose WORKFLOW.md is malformed, with the lint message', async () => {
  const dir = mod(base(), { workflow: doc({ flows: [FLOW.replace('SALES-F03', 'SALES-F3')] }) });
  try {
    writeContractsFile(dir, base());
    await assert.rejects(() => validate(dir), /WORKFLOW\.md:\d+: .*`SALES-F3`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
