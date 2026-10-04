// `erplora workflow-lint <dir> [--family HUB|SAAS|VFGW|REC]` (ERPlora/pm#621).
//
// The same WORKFLOW.md lint `erplora validate` runs on a module, for the components that are NOT
// modules and have no `module.json`: the hub, the SaaS, the fiscal gateway, and the
// cross-component journeys of `architecture/workflows/`. It walks every WORKFLOW.md under <dir>
// (skipping node_modules, target, dist, .git), checks the prefix belongs to the family, and exits
// 1 on any error. These tests spawn the real bin, the way their CI will.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writeContractsFile } from '../src/contracts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'erplora.mjs');

/** A minimal valid document for `prefix`: the ten sections of the contract, in order. */
function doc(prefix, { scope = 'transversal', flowId = `${prefix}-F01` } = {}) {
  return [
    `# WORKFLOW — ${prefix}`,
    '',
    `Prefijo: ${prefix}`,
    `Alcance MVP: ${scope}`,
    '',
    '## Para qué sirve y para quién',
    '## Referencia adoptada',
    '## Antes de empezar',
    '## Pantallas',
    '## Flujos',
    `### ${flowId} Hacer algo`,
    'Estado: hecho',
    'Actor: responsable',
    'Pantalla: ninguna',
    'Pasos:',
    '1. Empieza.',
    'Entra: nada.',
    'Sale: nada.',
    'Si falla: lo ve en pantalla.',
    'Implicados: ninguno',
    'QA: ninguno',
    '',
    '## Cobertura contra la referencia',
    '## Datos: de quién es cada dato',
    '## Reglas que no se rompen',
    '## Lo que NO hace, a propósito',
    '## Dudas abiertas',
    '',
  ].join('\n');
}

/** A temporary tree: `{ 'apps/web/WORKFLOW.md': text, … }`. */
function tree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-wflint-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

function run(dir, ...args) {
  const res = spawnSync(process.execPath, [BIN, 'workflow-lint', dir, ...args], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

test('PASSES: every WORKFLOW.md of the tree belongs to the family', () => {
  const dir = tree({ 'WORKFLOW.md': doc('HUB'), 'apps/web/WORKFLOW.md': doc('HUB_SHELL') });
  try {
    const { status, out } = run(dir, '--family', 'HUB');
    assert.equal(status, 0, out);
    assert.match(out, /WORKFLOW\.md/);
    assert.match(out, /apps\/web\/WORKFLOW\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: a WORKFLOW.md whose prefix is of another family', () => {
  const dir = tree({ 'WORKFLOW.md': doc('HUB'), 'apps/billing/WORKFLOW.md': doc('SAAS_BILLING') });
  try {
    const { status, out } = run(dir, '--family=HUB');
    assert.equal(status, 1, out);
    assert.match(out, /apps\/billing\/WORKFLOW\.md:3: family_mismatch: .*`SAAS_BILLING`.*`HUB`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: a malformed WORKFLOW.md, naming the file and the line', () => {
  const dir = tree({ 'WORKFLOW.md': doc('SAAS', { flowId: 'SAAS-F1' }) });
  try {
    const { status, out } = run(dir, '--family', 'SAAS');
    assert.equal(status, 1, out);
    assert.match(out, /WORKFLOW\.md:11: flow_header_malformed: .*SAAS-F1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--family REC: validates the *.md of the root workflows/ folder, README.md aside', () => {
  const ok = tree({
    'workflows/wa-cita.md': doc('REC_WA_CITA'),
    'workflows/README.md': '# Recorridos\n\nÍndice, sin gramática.\n',
  });
  const bad = tree({ 'workflows/wa-mesa.md': doc('HUB') });
  try {
    const good = run(ok, '--family', 'REC');
    assert.equal(good.status, 0, good.out);
    assert.match(good.out, /workflows\/wa-cita\.md/);
    assert.doesNotMatch(good.out, /README\.md:/);
    const wrong = run(bad, '--family', 'REC');
    assert.equal(wrong.status, 1, wrong.out);
    assert.match(wrong.out, /workflows\/wa-mesa\.md:3: rec_prefix_misplaced: /);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('skips node_modules, target, dist and .git', () => {
  const broken = 'not a workflow at all\n';
  const dir = tree({
    'WORKFLOW.md': doc('HUB'),
    'node_modules/pkg/WORKFLOW.md': broken,
    'target/debug/WORKFLOW.md': broken,
    'dist/WORKFLOW.md': broken,
    '.git/WORKFLOW.md': broken,
  });
  try {
    const { status, out } = run(dir, '--family', 'HUB');
    assert.equal(status, 0, out);
    assert.doesNotMatch(out, /node_modules|target|dist|\.git\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two WORKFLOW.md of the tree with the same prefix: prefix_duplicated (level 3, same code as the index)', () => {
  const dir = tree({ 'WORKFLOW.md': doc('HUB'), 'crates/x/WORKFLOW.md': doc('HUB') });
  try {
    const { status, out } = run(dir, '--family', 'HUB');
    assert.equal(status, 1, out);
    assert.match(out, /crates\/x\/WORKFLOW\.md:3: prefix_duplicated: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a REC_ prefix outside architecture/workflows: rec_prefix_misplaced', () => {
  const dir = tree({ 'WORKFLOW.md': doc('REC_CITAS') });
  try {
    const { status, out } = run(dir);
    assert.equal(status, 1, out);
    assert.match(out, /WORKFLOW\.md:3: rec_prefix_misplaced: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a workflow/*.md with no WORKFLOW.md next to its folder: orphan_subfile', () => {
  const detail = ['Prefijo: HUB_SHELL', '', '## Flujos', ''].join('\n');
  const dir = tree({ 'WORKFLOW.md': doc('HUB'), 'apps/web/workflow/caja.md': detail });
  try {
    const { status, out } = run(dir, '--family', 'HUB');
    assert.equal(status, 1, out);
    assert.match(out, /apps\/web\/workflow\/caja\.md:1: orphan_subfile: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree with no WORKFLOW.md at its root: warning workflow_missing (the migration is open)', () => {
  const dir = tree({ 'README.md': '# nada\n' });
  try {
    const { status, out } = run(dir, '--family', 'HUB');
    assert.equal(status, 0, out);
    assert.match(out, /⚠ .*workflow_missing: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--strict: the same missing WORKFLOW.md is an error', () => {
  const dir = tree({ 'README.md': '# nada\n' });
  try {
    const { status, out } = run(dir, '--family', 'HUB', '--strict');
    assert.equal(status, 1, out);
    assert.match(out, /workflow_missing: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid --family is refused before reading anything', () => {
  const dir = tree({ 'WORKFLOW.md': doc('HUB') });
  try {
    const { status, out } = run(dir, '--family', 'hub');
    assert.equal(status, 2, out);
    assert.match(out, /--family/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The CI of hub, saas, verifactu-gateway and architecture runs this out of a bare checkout of the
// toolkit, through `.github/actions/workflow-doc`. The lint is Node builtins only, so it must not
// need ANY installed package — not even the two `validate` needs (`typescript`, `ajv`).
test('workflow-lint runs from a bare checkout with no node_modules at all', () => {
  const bare = mkdtempSync(join(tmpdir(), 'erplora-toolkit-nodeps-'));
  const dir = tree({ 'WORKFLOW.md': doc('VFGW') });
  try {
    for (const part of ['bin', 'src']) cpSync(join(ROOT, part), join(bare, part), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(bare, 'package.json'));
    const res = spawnSync(process.execPath, [join(bare, 'bin', 'erplora.mjs'), 'workflow-lint', dir, '--family', 'VFGW'], {
      encoding: 'utf8',
      cwd: bare,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    assert.doesNotMatch(out, /ERR_MODULE_NOT_FOUND/, out);
    assert.equal(res.status, 0, out);
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the workflow-doc action runs this subcommand with its inputs, installing nothing', () => {
  const action = readFileSync(join(ROOT, '.github/actions/workflow-doc/action.yml'), 'utf8');
  assert.match(action, /^\s{2}path:/m, 'the folder to walk is an input');
  assert.match(action, /^\s{2}family:/m, 'the family is an input');
  assert.match(action, /^\s{2}strict:/m, 'strict mode is an input, off by default');
  assert.match(action, /--strict/);
  const strictInput = /^ {2}strict:\n((?: {4}.*\n| {6}.*\n)+)/m.exec(action);
  assert.ok(strictInput, 'the `strict` input block');
  assert.match(strictInput[1], /^ {4}default: 'false'$/m, 'strict mode stays OFF unless a caller asks: the migration is open');
  assert.match(action, /^ {4}- name: [\x00-\x7F]+$/m, 'the step name is English');
  assert.match(action, /node "\$toolkit\/bin\/erplora\.mjs" workflow-lint "\$WORKFLOW_PATH"/);
  assert.match(action, /--family "\$WORKFLOW_FAMILY"/);
  assert.match(action, /WORKFLOW_PATH: \$\{\{ inputs\.path \}\}/);
  assert.match(action, /WORKFLOW_FAMILY: \$\{\{ inputs\.family \}\}/);
  assert.doesNotMatch(action, /npm (install|ci)\b/, 'the lint is builtins only: nothing to install');
});

/** A module that passes `erplora validate` and has no WORKFLOW.md. */
function moduleWithoutWorkflow() {
  const dir = tree({});
  const manifest = { id: 'demo', name: 'Demo', version: '1.0.0' };
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
  writeContractsFile(dir, manifest);
  return dir;
}

function cli(...args) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

test('`erplora validate <dir> --strict`: a module without WORKFLOW.md exits 1 (and 0 without the flag)', () => {
  const dir = moduleWithoutWorkflow();
  try {
    const plain = cli('validate', dir);
    assert.equal(plain.status, 0, plain.out);
    assert.match(plain.out, /workflow_missing/);
    const strict = cli('validate', dir, '--strict');
    assert.equal(strict.status, 1, strict.out);
    assert.match(strict.out, /workflow_missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('`--family` belongs to workflow-lint only: `validate <dir> --family hub` is not refused', () => {
  const dir = moduleWithoutWorkflow();
  try {
    const res = cli('validate', dir, '--family', 'hub');
    assert.equal(res.status, 0, res.out);
    assert.doesNotMatch(res.out, /--family/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the new CLI texts are English', () => {
  const ok = tree({ 'WORKFLOW.md': doc('HUB') });
  const bad = tree({ 'WORKFLOW.md': doc('HUB', { flowId: 'HUB-F1' }) });
  try {
    assert.match(run(ok, '--family', 'HUB').out, /✓ workflow-lint HUB: 1 file\(s\), 1 flow\(s\)/);
    assert.match(run(bad, '--family', 'HUB').out, /✗ WORKFLOW\.md missing or malformed \(ERPlora\/pm#621\):/);
    assert.match(cli('workflow-lint', join(ok, 'nope')).out, /✗ the folder .*nope does not exist/);
    assert.match(cli('workflow-lint').out, /✗ workflow-lint needs the folder to walk/);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('`erplora validate` names a malformed or missing WORKFLOW.md in English', () => {
  const dir = moduleWithoutWorkflow();
  try {
    assert.match(cli('validate', dir, '--strict').out, /✗ WORKFLOW\.md missing or malformed \(ERPlora\/pm#621\):/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the usage text lists workflow-lint', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.match(res.stdout, /workflow-lint <dir> \[--family HUB\|SAAS\|VFGW\|REC\] \[--strict\]/);
  assert.match(res.stdout, /validate <dir> \[--pg\] \[--strict\]/);
  assert.match(res.stdout, /with --strict, a module without WORKFLOW\.md is an error/);
  assert.match(res.stdout, /lints the grammar of every WORKFLOW\.md under <dir>/);
});
