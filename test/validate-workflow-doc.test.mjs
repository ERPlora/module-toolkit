// Tests for the WORKFLOW.md lint (ERPlora/pm#621). `node --test`.
//
// Every component of ERPlora carries a versioned `WORKFLOW.md`: its functional spec (screens, flows,
// which flows of other components each one touches). The grammar is a CONTRACT shared by two
// validators — this lint and `workflow-index.sh` (awk, ERPlora/pm) — and lives in
// `architecture/contracts/workflow-contract.md`. Two validators agree when they emit the same SET of
// `(code, flow ID)` pairs, so that is what these tests compare.
//
// The fixtures are the contract's own: §6 (the valid example, copied verbatim into
// `test/fixtures/workflow-contract/`) must give zero findings, and every row of §7 is ONE edit on
// it with the pairs the «Niveles 1 y 2» column expects. Levels 1 and 2 are this lint's (one file,
// one component); level 3 (references across components) is the index's.
//
// Severity, and why: the 27 module repos run this toolkit by `@main`, so a module WITHOUT the file
// is a warning (the migration is open) unless `--strict`; a file that is there and malformed is an
// error. Not to be confused with `validate-flows` — «flows» in this repository are automations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintWorkflowText, checkWorkflowDoc, lintWorkflowTree } from '../src/validate-workflow-doc.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'workflow-contract');
const APPT = 'appointments/WORKFLOW.md';
const WA = 'whatsapp_inbox/WORKFLOW.md';
const WA_DETAIL = 'whatsapp_inbox/workflow/conversaciones.md';

/** A scratch copy of the §6 example. `edits`: `{ '<rel>': (text) => text | null }`, null deletes. */
function example(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-wfdoc-'));
  cpSync(FIXTURES, root, { recursive: true });
  for (const [rel, fn] of Object.entries(edits)) {
    const path = join(root, rel);
    const out = fn(readFileSync(path, 'utf8'));
    if (out === null) rmSync(path);
    else writeFileSync(path, out);
  }
  return root;
}

/** Runs the module door on one component of the example; the findings as `code|ID` pairs. */
function check(root, component) {
  const dir = join(root, component);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  return checkWorkflowDoc(dir, manifest);
}

const pairs = (findings, level) =>
  [...new Set(findings.filter((f) => f.level === level).map((f) => `${f.code}|${f.id}`))].sort();

/** Both components of the example after `edits`: the error pairs, as a sorted set. */
function errorPairs(edits) {
  const root = example(edits);
  try {
    return pairs([...check(root, 'appointments').findings, ...check(root, 'whatsapp_inbox').findings], 'error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Replaces exactly one occurrence, so a fixture that drifted fails loudly instead of passing. */
function once(from, to) {
  return (text) => {
    assert.equal(text.split(from).length, 2, `expected exactly one «${from}» in the fixture`);
    return text.replace(from, to);
  };
}

// ── §6: the valid example ─────────────────────────────────────────────────────

test('§6: the valid example gives zero findings, errors or warnings', () => {
  const root = example();
  try {
    for (const c of ['appointments', 'whatsapp_inbox']) {
      const out = check(root, c);
      assert.deepEqual(out.errors, [], c);
      assert.deepEqual(out.warnings, [], c);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('§6: the same, saved with CRLF', () => {
  const crlf = (t) => t.replaceAll('\n', '\r\n');
  assert.deepEqual(errorPairs({ [APPT]: crlf, [WA]: crlf, [WA_DETAIL]: crlf }), []);
});

// ── §7: one change each, «Niveles 1 y 2» ──────────────────────────────────────

const F01_BLOCK = (t) => t.slice(t.indexOf('### APPOINTMENTS-F01'), t.indexOf('### APPOINTMENTS-F02'));
const RETIRED_BLOCK = '### APPOINTMENTS-F02 [retirado] Aceptar solicitudes desde la pestaña Solicitudes\nImplicados: ninguno\n\n';
const COVERAGE_ROW = '| Cita con clienta, servicio, profesional y hora | hecho | APPOINTMENTS-F01 |\n';
const PENDING_F01 = 'Pendiente de enlazar: customers — reconocer a la clienta por su teléfono\n';
const PENDING_F02 = 'Pendiente de enlazar: schedules — el horario de apertura del negocio\n';
const SOURCES = '## Fuentes contrastadas\nEl manual dice que la cita se puede arrastrar a otro día; el código solo deja moverla dentro del mismo día.\n';
const SALES_FLOW = [
  '### SALES-F05 Vender', 'Estado: hecho', 'Actor: empleado', 'Pantalla: Agenda', 'Pasos:', '1. Vende.',
  'Entra: nada.', 'Sale: nada.', 'Si falla: lo ve.', 'Implicados: ninguno', 'QA: ninguno', '', '',
].join('\n');

const INVALID = [
  [1, 'one-digit ID', { [APPT]: once('### APPOINTMENTS-F01 Dar', '### APPOINTMENTS-F1 Dar') }, ['flow_header_malformed|']],
  [2, 'lower-case prefix', { [APPT]: once('Prefijo: APPOINTMENTS', 'Prefijo: appointments') }, ['prefix_malformed|']],
  [3, 'trailing comma', { [APPT]: once('Implicados: WHATSAPP_INBOX-F01\n', 'Implicados: WHATSAPP_INBOX-F01,\n') }, ['implicated_malformed|APPOINTMENTS-F01']],
  ['3b', 'trailing comma and space', { [APPT]: once('Implicados: WHATSAPP_INBOX-F01\n', 'Implicados: WHATSAPP_INBOX-F01, \n') }, ['implicated_malformed|APPOINTMENTS-F01']],
  [4, 'own prefix', { [APPT]: once('Implicados: WHATSAPP_INBOX-F01\n', 'Implicados: WHATSAPP_INBOX-F01, APPOINTMENTS-F02\n') }, ['implicated_own_prefix|APPOINTMENTS-F01']],
  [5, 'not reciprocal (level 3 only)', { [WA_DETAIL]: once('Implicados: APPOINTMENTS-F01\n', 'Implicados: pendiente\n') }, []],
  [6, 'no Implicados', { [APPT]: once('Implicados: WHATSAPP_INBOX-F01\n', '') }, ['key_missing|APPOINTMENTS-F01']],
  [7, 'Estado twice', { [APPT]: once('Estado: hecho\n', 'Estado: hecho\nEstado: hecho\n') }, ['key_repeated|APPOINTMENTS-F01']],
  [8, 'retired reference (level 3 only)', { [WA_DETAIL]: once('Implicados: APPOINTMENTS-F01\n', 'Implicados: APPOINTMENTS-F01, APPOINTMENTS-F02\n') }, []],
  [9, 'retired with references', { [APPT]: once('Implicados: ninguno', 'Implicados: WHATSAPP_INBOX-F01') }, ['retired_malformed|APPOINTMENTS-F02']],
  [10, 'separator is not `, `', { [WA_DETAIL]: once('Implicados: APPOINTMENTS-F01\n', 'Implicados: APPOINTMENTS-F01; CUSTOMERS-F01\n') }, ['implicated_malformed|WHATSAPP_INBOX-F01']],
  [11, '`parcial` without what is missing', { [WA_DETAIL]: once('Estado: parcial — falta ofrecer otro hueco cuando el pedido está ocupado', 'Estado: parcial') }, ['state_malformed|WHATSAPP_INBOX-F01']],
  [12, 'scope with an accent', { [APPT]: once('Alcance MVP: peluqueria', 'Alcance MVP: núcleo') }, ['scope_malformed|']],
  [13, 'keys out of order', {
    [APPT]: (t) => once('Entra: el servicio (servicios) y la clienta (clientes).\nSale: la cita guardada; la conversación de WhatsApp de la clienta la muestra.\n',
      'Sale: la cita guardada; la conversación de WhatsApp de la clienta la muestra.\nEntra: el servicio (servicios) y la clienta (clientes).\n')(t),
  }, ['key_out_of_order|APPOINTMENTS-F01']],
  [14, 'flow outside `## Flujos`', { [APPT]: (t) => once(COVERAGE_ROW, COVERAGE_ROW + RETIRED_BLOCK.trimEnd() + '\n')(once(RETIRED_BLOCK, '')(t)) }, ['flow_header_outside_flows|APPOINTMENTS-F02']],
  [15, 'a section missing', { [APPT]: once('## Dudas abiertas\nNinguna.\n\n', '') }, ['section_missing|']],
  [16, 'two sections swapped', {
    [APPT]: (t) => t.replace('## Reglas que no se rompen', '§TMP§').replace('## Lo que NO hace, a propósito', '## Reglas que no se rompen').replace('§TMP§', '## Lo que NO hace, a propósito'),
  }, ['section_out_of_order|']],
  [17, 'unclosed code block', { [APPT]: (t) => t.replace(/~~~\n\n## Pantallas/, '\n## Pantallas') }, ['code_block_unclosed|']],
  [18, 'a flow ID twice', { [APPT]: (t) => t.replace(F01_BLOCK(t), F01_BLOCK(t) + F01_BLOCK(t).replace('Dar una cita desde la agenda', 'Otra cita')) }, ['flow_id_repeated|APPOINTMENTS-F01']],
  [19, '`ninguno` over a pending line', { [WA_DETAIL]: once('Implicados: pendiente', 'Implicados: ninguno') }, ['pending_under_none|WHATSAPP_INBOX-F02']],
  [20, 'pending line before Implicados', { [WA_DETAIL]: (t) => once('Implicados: APPOINTMENTS-F01\n', PENDING_F01 + 'Implicados: APPOINTMENTS-F01\n')(once(PENDING_F01, '')(t)) }, ['pending_misplaced|WHATSAPP_INBOX-F01']],
  [21, 'a flow of another prefix', { [APPT]: once('## Cobertura contra la referencia', SALES_FLOW + '## Cobertura contra la referencia') }, ['flow_prefix_mismatch|SALES-F05']],
  [22, '`Prefijo` twice', { [APPT]: once('Prefijo: APPOINTMENTS\n', 'Prefijo: APPOINTMENTS\nPrefijo: APPOINTMENTS\n') }, ['prefix_repeated|']],
  [23, 'a REC_ prefix in a module', { [APPT]: once('Prefijo: APPOINTMENTS', 'Prefijo: REC_CITAS') },
    ['flow_prefix_mismatch|APPOINTMENTS-F01', 'flow_prefix_mismatch|APPOINTMENTS-F02', 'module_prefix_mismatch|', 'rec_prefix_misplaced|']],
  [24, '`pendiente` without lines', { [WA_DETAIL]: once(PENDING_F02, '') }, ['pending_without_lines|WHATSAPP_INBOX-F02']],
  [25, 'detail with another prefix', { [WA_DETAIL]: once('Prefijo: WHATSAPP_INBOX', 'Prefijo: WHATSAPP') },
    ['flow_prefix_mismatch|WHATSAPP_INBOX-F01', 'flow_prefix_mismatch|WHATSAPP_INBOX-F02', 'subfile_prefix_mismatch|']],
  [26, 'detail without `Prefijo`', { [WA_DETAIL]: once('Prefijo: WHATSAPP_INBOX\n', '') }, ['prefix_missing|']],
  [27, 'an ID in the index and in a detail', {
    [WA]: (t) => {
      const detail = readFileSync(join(FIXTURES, WA_DETAIL), 'utf8');
      const block = detail.slice(detail.indexOf('### WHATSAPP_INBOX-F02'));
      return once('\n## Cobertura contra la referencia', `\n${block}\n## Cobertura contra la referencia`)(t);
    },
  }, ['flow_id_repeated|WHATSAPP_INBOX-F02']],
  [28, '`Fuentes contrastadas` before `Dudas abiertas`', { [APPT]: (t) => once('## Dudas abiertas', SOURCES + '\n## Dudas abiertas')(once(SOURCES, '')(t)) }, ['section_out_of_order|']],
  [29, 'the index deleted', { [WA]: () => null }, ['orphan_subfile|']],
  [30, 'Vertical outside its vocabulary', { [WA_DETAIL]: once('Vertical: peluqueria', 'Vertical: salon') }, ['vertical_malformed|WHATSAPP_INBOX-F01']],
  [31, 'Vertical under Actor', { [WA_DETAIL]: (t) => once('Actor: cliente\n', 'Actor: cliente\nVertical: peluqueria\n')(once('Vertical: peluqueria\n', '')(t)) }, ['vertical_misplaced|WHATSAPP_INBOX-F01']],
  [32, 'Vertical twice', { [WA_DETAIL]: once('Vertical: peluqueria\n', 'Vertical: peluqueria\nVertical: peluqueria\n') }, ['key_repeated|WHATSAPP_INBOX-F01']],
];

for (const [n, label, edits, expected] of INVALID) {
  test(`§7 #${n} (${label}): ${expected.join(', ') || 'nothing at levels 1 and 2'}`, () => {
    assert.deepEqual(errorPairs(edits), expected);
  });
}

const STILL_VALID = [
  ['`Actor:` with no value', { [APPT]: once('Actor: responsable, empleado', 'Actor:') }],
  ['`Pantalla:` of another component', { [APPT]: once('Pantalla: Agenda', 'Pantalla: Clientes: Ficha de la clienta') }],
  ['`QA:` free text', { [APPT]: once('QA: B-02, W-01', 'QA: cualquier cosa') }],
  ['`Pantalla: asistente`', { [WA_DETAIL]: once('Pantalla: Conversaciones', 'Pantalla: asistente') }],
  ['no `Vertical:` (optional)', { [WA_DETAIL]: once('Vertical: peluqueria\n', '') }],
  ['`Vertical: salon` in a retired flow (free text)', { [APPT]: once('Implicados: ninguno\n', 'Implicados: ninguno\nVertical: salon\n') }],
  ['a coverage matrix instead of the usual table', { [APPT]: once('| Elemento | Estado | Flujo |', '| Elemento | Traer | Crear | Editar | Enviar |') }],
];

for (const [label, edits] of STILL_VALID) {
  test(`§7 still valid: ${label}`, () => {
    assert.deepEqual(errorPairs(edits), []);
  });
}

// ── The rest of the codes of §5.4, one each ───────────────────────────────────

const OTHER = [
  ['flow_title_missing (live)', { [APPT]: once('### APPOINTMENTS-F01 Dar una cita desde la agenda', '### APPOINTMENTS-F01') }, ['flow_title_missing|APPOINTMENTS-F01']],
  ['flow_title_missing (retired)', { [APPT]: once('[retirado] Aceptar solicitudes desde la pestaña Solicitudes', '[retirado]') }, ['flow_title_missing|APPOINTMENTS-F02']],
  ['flow_header_malformed (a heading in `## Flujos` that is no flow)', { [APPT]: once('### APPOINTMENTS-F02', '### Notas\n\n### APPOINTMENTS-F02') }, ['flow_header_malformed|']],
  ['prefix_after_section', { [APPT]: (t) => once('## Referencia adoptada', 'Prefijo: APPOINTMENTS\n\n## Referencia adoptada')(once('Prefijo: APPOINTMENTS\n', '')(t)) }, ['prefix_after_section|']],
  ['scope_missing', { [APPT]: once('Alcance MVP: peluqueria\n', '') }, ['scope_missing|']],
  ['scope_repeated', { [APPT]: once('Alcance MVP: peluqueria\n', 'Alcance MVP: peluqueria\nAlcance MVP: peluqueria\n') }, ['scope_repeated|']],
  ['scope_after_section', { [APPT]: (t) => once('## Referencia adoptada', 'Alcance MVP: peluqueria\n\n## Referencia adoptada')(once('Alcance MVP: peluqueria\n', '')(t)) }, ['scope_after_section|']],
  ['section_repeated', { [APPT]: once('## Dudas abiertas\nNinguna.\n', '## Dudas abiertas\nNinguna.\n\n## Dudas abiertas\nOtra.\n') }, ['section_repeated|']],
  ['`## Flujos — <área>` is not `## Flujos`', { [APPT]: once('## Flujos\n', '## Flujos — Agenda\n') }, ['flow_header_outside_flows|APPOINTMENTS-F01', 'flow_header_outside_flows|APPOINTMENTS-F02', 'section_missing|']],
  ['implicated_repeated', { [APPT]: once('Implicados: WHATSAPP_INBOX-F01\n', 'Implicados: WHATSAPP_INBOX-F01, WHATSAPP_INBOX-F01\n') }, ['implicated_repeated|APPOINTMENTS-F01']],
  ['pending_malformed (no em dash)', { [WA_DETAIL]: once(PENDING_F02, 'Pendiente de enlazar: schedules - el horario\n') }, ['pending_malformed|WHATSAPP_INBOX-F02']],
  ['retired_malformed (a pending line)', { [APPT]: once('Implicados: ninguno\n', `Implicados: ninguno\n${PENDING_F01}`) }, ['retired_malformed|APPOINTMENTS-F02']],
  ['a key indented is not a key', { [APPT]: once('Actor: responsable', ' Actor: responsable') }, ['key_missing|APPOINTMENTS-F01']],
  ['an indented fence is not a fence', { [APPT]: (t) => t.replace('~~~\n### APPOINTMENTS-F99', '  ~~~\n### APPOINTMENTS-F99') }, ['code_block_unclosed|']],
];

for (const [label, edits, expected] of OTHER) {
  test(`§5.4 ${label}`, () => {
    assert.deepEqual(errorPairs(edits), expected);
  });
}

test('`Alcance MVP: congelado`: the short card needs only `## Para qué sirve y para quién`', () => {
  const card = 'Prefijo: TASKS\nAlcance MVP: congelado\n\n## Para qué sirve y para quién\nNo se cambia.\n';
  const ok = lintWorkflowText(card, { prefix: 'TASKS' });
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  const out = lintWorkflowText(card.replace('## Para qué sirve y para quién', '## Otra cosa'), { prefix: 'TASKS' });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /^WORKFLOW\.md:\d+: section_missing: /);
});

// ── Messages ──────────────────────────────────────────────────────────────────

test('every message is `<file>:<line>: <code>: <text>`, with the real line', () => {
  const root = example({ [APPT]: once('### APPOINTMENTS-F01 Dar', '### APPOINTMENTS-F1 Dar') });
  try {
    const { errors } = check(root, 'appointments');
    const line = readFileSync(join(root, APPT), 'utf8').split('\n').indexOf('### APPOINTMENTS-F1 Dar una cita desde la agenda') + 1;
    assert.deepEqual(errors.length, 1);
    assert.match(errors[0], new RegExp(`^WORKFLOW\\.md:${line}: flow_header_malformed: \\S`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a detail file is named by its path in the module', () => {
  const root = example({ [WA_DETAIL]: once('Prefijo: WHATSAPP_INBOX\n', '') });
  try {
    assert.match(check(root, 'whatsapp_inbox').errors[0], /^workflow\/conversaciones\.md:1: prefix_missing: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('module_prefix_mismatch: the prefix is not the module id in upper case', () => {
  const root = example();
  try {
    const dir = join(root, 'appointments');
    const out = checkWorkflowDoc(dir, { id: 'citas', name: 'Citas', version: '1.0.0' });
    assert.deepEqual(pairs(out.findings, 'error'), ['module_prefix_mismatch|']);
    assert.match(out.errors[0], /module_prefix_mismatch: .*`APPOINTMENTS`.*`CITAS`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Reading the disk: what counts as «the file» ──────────────────────────────

/** 1-based line of the first line of `text` that is exactly `needle`. */
const lineOf = (text, needle) => text.split('\n').indexOf(needle) + 1;

test('§5.2: trailing spaces are normalised away (`Prefijo: X  `, `## Flujos `)', () => {
  assert.deepEqual(
    errorPairs({ [APPT]: (t) => once('## Flujos\n', '## Flujos \n')(once('Prefijo: APPOINTMENTS\n', 'Prefijo: APPOINTMENTS  \n')(t)) }),
    [],
  );
});

test('a WORKFLOW.md that is a FOLDER is no file: workflow_missing, never an exception', () => {
  const root = example({ [APPT]: () => null });
  try {
    mkdirSync(join(root, APPT));
    const out = check(root, 'appointments');
    assert.deepEqual(pairs(out.findings, 'warning'), ['workflow_missing|appointments']);
    assert.deepEqual(out.errors, []);
    const tree = lintWorkflowTree(join(root, 'appointments'), { name: 'appointments' });
    assert.deepEqual(pairs(tree.findings, 'warning'), ['workflow_missing|appointments']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the name is exact on every filesystem: a lone `workflow.md` is not WORKFLOW.md (APFS ≠ the CI)', () => {
  const root = example();
  try {
    renameSync(join(root, APPT), join(root, 'appointments', 'workflow.md'));
    const out = check(root, 'appointments');
    assert.deepEqual(pairs(out.findings, 'warning'), ['workflow_missing|appointments']);
    const tree = lintWorkflowTree(join(root, 'appointments'), { name: 'appointments' });
    assert.deepEqual(tree.files, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prefix line of module_prefix_mismatch skips a code block that holds another `Prefijo:`', () => {
  const block = '~~~\nPrefijo: OTRO\n~~~\n';
  const root = example({ [APPT]: once('Prefijo: APPOINTMENTS\n', `${block}Prefijo: APPOINTMENTS\n`) });
  try {
    const dir = join(root, 'appointments');
    const out = checkWorkflowDoc(dir, { id: 'citas', name: 'Citas', version: '1.0.0' });
    const line = lineOf(readFileSync(join(root, APPT), 'utf8'), 'Prefijo: APPOINTMENTS');
    assert.deepEqual(out.errors.map((e) => e.split(': ')[0]), [`WORKFLOW.md:${line}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prefix line of subfile_prefix_mismatch skips a code block too', () => {
  const root = example({ [WA_DETAIL]: once('Prefijo: WHATSAPP_INBOX\n', '```\nPrefijo: WHATSAPP_INBOX\n```\nPrefijo: WHATSAPP\n') });
  try {
    const mismatch = check(root, 'whatsapp_inbox').findings.find((f) => f.code === 'subfile_prefix_mismatch');
    assert.equal(mismatch.line, lineOf(readFileSync(join(root, WA_DETAIL), 'utf8'), 'Prefijo: WHATSAPP'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('symbolic links: a linked WORKFLOW.md and a linked workflow/*.md are both read', () => {
  const root = example();
  try {
    const store = join(root, 'store');
    mkdirSync(store);
    const wa = join(root, 'whatsapp_inbox');
    renameSync(join(wa, 'WORKFLOW.md'), join(store, 'index.md'));
    symlinkSync(join(store, 'index.md'), join(wa, 'WORKFLOW.md'));
    const detail = readFileSync(join(root, WA_DETAIL), 'utf8');
    writeFileSync(join(store, 'detail.md'), once('Vertical: peluqueria', 'Vertical: salon')(detail));
    rmSync(join(root, WA_DETAIL));
    symlinkSync(join(store, 'detail.md'), join(root, WA_DETAIL));
    assert.deepEqual(pairs(check(root, 'whatsapp_inbox').findings, 'error'), ['vertical_malformed|WHATSAPP_INBOX-F01']);
    const tree = lintWorkflowTree(wa, { name: 'whatsapp_inbox' });
    assert.deepEqual(tree.files, ['WORKFLOW.md', 'workflow/conversaciones.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WARNS file_too_long above 600 lines, counted the way awk reads them', () => {
  const pad = (n) => (t) => t + Array.from({ length: n }, (_, i) => `Línea ${i}.`).join('\n') + '\n';
  const lines = readFileSync(join(FIXTURES, APPT), 'utf8').split('\n').length - 1;
  for (const [extra, warned] of [[600 - lines, false], [601 - lines, true]]) {
    const root = example({ [APPT]: pad(extra) });
    try {
      const out = check(root, 'appointments');
      assert.deepEqual(out.errors, []);
      assert.deepEqual(pairs(out.findings, 'warning'), warned ? ['file_too_long|'] : [], `${lines + extra} lines`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

// ── Missing file: warning, or error with --strict ─────────────────────────────

test('a module without WORKFLOW.md: warning `workflow_missing`, never an error', () => {
  const root = example({ [APPT]: () => null });
  try {
    const out = check(root, 'appointments');
    assert.deepEqual(out.errors, []);
    assert.deepEqual(pairs(out.findings, 'warning'), ['workflow_missing|appointments']);
    assert.match(out.warnings[0], /workflow_missing: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--strict: a module without WORKFLOW.md is an error', () => {
  const root = example({ [APPT]: () => null });
  try {
    const dir = join(root, 'appointments');
    const out = checkWorkflowDoc(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')), { strict: true });
    assert.deepEqual(pairs(out.findings, 'error'), ['workflow_missing|appointments']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Wired into `erplora validate` ─────────────────────────────────────────────

test('WIRED: `erplora validate` passes (and warns) on a module without WORKFLOW.md', async () => {
  const root = example({ [APPT]: () => null });
  const dir = join(root, 'appointments');
  const warned = [];
  const original = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    writeContractsFile(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')));
    await assert.doesNotReject(() => validate(dir));
    assert.ok(warned.some((w) => /workflow_missing/.test(w)), `no workflow_missing warning among:\n${warned.join('\n')}`);
    await assert.rejects(() => validate(dir, { strict: true }), /workflow_missing/);
  } finally {
    console.warn = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test('WIRED: `erplora validate` rejects a malformed WORKFLOW.md with the lint message', async () => {
  const root = example({ [APPT]: once('### APPOINTMENTS-F01 Dar', '### APPOINTMENTS-F1 Dar') });
  const dir = join(root, 'appointments');
  try {
    writeContractsFile(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')));
    await assert.rejects(() => validate(dir), /WORKFLOW\.md:\d+: flow_header_malformed: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('WIRED: the valid example passes `erplora validate` with no workflow-doc warning', async () => {
  const root = example();
  const dir = join(root, 'whatsapp_inbox');
  const warned = [];
  const original = console.warn;
  console.warn = (msg) => warned.push(String(msg));
  try {
    writeContractsFile(dir, JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')));
    await assert.doesNotReject(() => validate(dir));
    assert.deepEqual(warned.filter((w) => /WORKFLOW|workflow\//.test(w)), []);
  } finally {
    console.warn = original;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── pm#658 (K1): WORKFLOW.md is renamed HANDBOOK.md (and workflow/ handbook/) ──
// One component at a time, in the first PR of its chain, so until the last one goes both names
// are read. HANDBOOK.md governs where both are: the old WORKFLOW.md and its workflow/*.md are NOT
// linted (their IDs would be duplicates) and each is a `legacy_workflow_file` warning — the same
// pairs `workflow-index.sh` gives. Each name keeps its own detail folder.

/** Renames a component of the example to the new names, in place. */
function toHandbook(root, component) {
  const dir = join(root, component);
  renameSync(join(dir, 'WORKFLOW.md'), join(dir, 'HANDBOOK.md'));
  try {
    renameSync(join(dir, 'workflow'), join(dir, 'handbook'));
  } catch {
    // no detail folder in this component
  }
}

test('pm#658: a component renamed to HANDBOOK.md + handbook/ gives zero findings, like before', () => {
  const root = example();
  try {
    toHandbook(root, 'appointments');
    toHandbook(root, 'whatsapp_inbox');
    for (const c of ['appointments', 'whatsapp_inbox']) assert.deepEqual(check(root, c).findings, [], c);
    const tree = lintWorkflowTree(join(root, 'whatsapp_inbox'), { name: 'whatsapp_inbox' });
    assert.deepEqual(tree.findings, []);
    assert.deepEqual(tree.files, ['HANDBOOK.md', 'handbook/conversaciones.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: the renamed files are linted — a defect in HANDBOOK.md or handbook/ is the same error', () => {
  const root = example({
    [APPT]: once('### APPOINTMENTS-F01 Dar', '### APPOINTMENTS-F1 Dar'),
    [WA_DETAIL]: once('Vertical: peluqueria', 'Vertical: salon'),
  });
  try {
    toHandbook(root, 'appointments');
    toHandbook(root, 'whatsapp_inbox');
    assert.deepEqual(pairs(check(root, 'appointments').findings, 'error'), ['flow_header_malformed|']);
    assert.match(check(root, 'appointments').errors[0], /^HANDBOOK\.md:\d+: flow_header_malformed: /);
    const wa = check(root, 'whatsapp_inbox');
    assert.deepEqual(pairs(wa.findings, 'error'), ['vertical_malformed|WHATSAPP_INBOX-F01']);
    assert.match(wa.errors[0], /^handbook\/conversaciones\.md:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: with both names HANDBOOK.md governs; the old WORKFLOW.md and workflow/ are legacy_workflow_file warnings, not linted', () => {
  const root = example();
  try {
    const wa = join(root, 'whatsapp_inbox');
    cpSync(join(wa, 'WORKFLOW.md'), join(wa, 'HANDBOOK.md'));
    cpSync(join(wa, 'workflow'), join(wa, 'handbook'), { recursive: true });
    // The leftovers are broken: were they read, they would give errors (and duplicated IDs).
    writeFileSync(join(wa, 'WORKFLOW.md'), 'Prefijo: otro\n### X-F1 roto\n');
    writeFileSync(join(wa, 'workflow', 'conversaciones.md'), 'Vertical: salon\n');
    const out = check(root, 'whatsapp_inbox');
    assert.deepEqual(out.errors, []);
    assert.deepEqual(pairs(out.findings, 'warning'), ['legacy_workflow_file|']);
    assert.deepEqual(out.findings.filter((f) => f.code === 'legacy_workflow_file').map((f) => `${f.file}:${f.line}`),
      ['WORKFLOW.md:1', 'workflow/conversaciones.md:1']);
    assert.match(out.warnings.join('\n'), /WORKFLOW\.md:1: legacy_workflow_file: .*HANDBOOK\.md/);
    const tree = lintWorkflowTree(wa, { name: 'whatsapp_inbox' });
    assert.deepEqual(tree.errors, []);
    assert.deepEqual(tree.files, ['HANDBOOK.md', 'handbook/conversaciones.md']);
    assert.deepEqual(pairs(tree.findings, 'warning'), ['legacy_workflow_file|']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: each name keeps its own detail folder — handbook/ under a WORKFLOW.md is an orphan', () => {
  const root = example();
  try {
    const wa = join(root, 'whatsapp_inbox');
    renameSync(join(wa, 'workflow'), join(wa, 'handbook'));
    const out = check(root, 'whatsapp_inbox');
    assert.deepEqual(pairs(out.findings, 'error'), ['orphan_subfile|']);
    assert.match(out.errors[0], /^handbook\/conversaciones\.md:1: orphan_subfile: .*HANDBOOK\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: no file under either name is workflow_missing, and the message names HANDBOOK.md', () => {
  const root = example({ [APPT]: () => null });
  try {
    const out = check(root, 'appointments');
    assert.deepEqual(pairs(out.findings, 'warning'), ['workflow_missing|appointments']);
    assert.match(out.warnings[0], /HANDBOOK\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: the tree walks HANDBOOK.md components, never handbook/ as a component, and keeps prefix_duplicated', () => {
  const root = example();
  try {
    toHandbook(root, 'whatsapp_inbox');
    // Make appointments claim the same prefix as the renamed whatsapp_inbox.
    const appt = join(root, APPT);
    writeFileSync(appt, readFileSync(appt, 'utf8').replace('Prefijo: APPOINTMENTS', 'Prefijo: WHATSAPP_INBOX')
      .replaceAll('APPOINTMENTS-F', 'WHATSAPP_INBOX-F'));
    const tree = lintWorkflowTree(root, { name: 'example' });
    assert.ok(tree.files.includes('whatsapp_inbox/HANDBOOK.md'), tree.files.join(', '));
    assert.ok(tree.files.includes('whatsapp_inbox/handbook/conversaciones.md'), tree.files.join(', '));
    assert.ok(!tree.findings.some((f) => f.code === 'orphan_subfile'), tree.errors.join('\n'));
    // appointments is walked first, so the duplicate is reported AT the renamed file, by its name.
    const dup = tree.findings.filter((f) => f.code === 'prefix_duplicated');
    assert.deepEqual(dup.map((f) => f.file), ['whatsapp_inbox/HANDBOOK.md']);
    assert.match(dup[0].text, /appointments\/WORKFLOW\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pm#658: a root with HANDBOOK.md is not «missing» in the tree', () => {
  const root = example();
  try {
    const wa = join(root, 'whatsapp_inbox');
    toHandbook(root, 'whatsapp_inbox');
    const tree = lintWorkflowTree(wa, { name: 'whatsapp_inbox', strict: true });
    assert.deepEqual(pairs(tree.findings, 'error'), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
