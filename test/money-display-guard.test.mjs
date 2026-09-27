// The money-display guard every module imports instead of carrying its own copy (ERPlora/pm#505).
//
// Fifteen modules carried a hand-copied `ui/lib/money-display-guard.test.ts` (pm#289), and the
// reviewers found three holes in it one module at a time — so the same guard was weaker in the
// first modules than in the last. These cases pin the three fixes ONCE, here, where every module
// gets them by importing the piece:
//
//   1. the OutfitKit barrel through its five doors (import … from, side-effect import, import(),
//      export { … } from, export * from) — rv-invoice-115, rv-cash_register-105, rv-kitchen-107;
//   2. a triaged exception covers ONE occurrence of its line, not every copy — rv-inventory-117;
//   3. non-vacuity by CONTENT with a witness, not by route — rv-appointments-226, rv-pricing-53,
//      rv-combos-22 (count the CALL, a type declaration survives a greedy strip), rv-taxes-78 (the
//      witness is read from the same scan the detector reads, and stale exceptions come out of it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  stripComments,
  handFormattedMoney,
  barrelValueImports,
  outfitkitImports,
  unexpectedHits,
  checkMoneyDisplay,
} from '../src/money-display-guard.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── The detectors ─────────────────────────────────────────────────────────────────────────────

test('hand-formatted money: the positives are caught', () => {
  assert.equal(handFormattedMoney('const s = `${(total / 100).toFixed(2)} €`;').length, 1);
  assert.equal(handFormattedMoney('const s = (total / 10 ** scale).toFixed(scale) + " €";').length, 1);
  assert.equal(
    handFormattedMoney("const f = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });").length,
    1,
  );
  // The shape prettier produces: the options object on its own lines.
  assert.equal(handFormattedMoney("new Intl.NumberFormat('es-ES', {\n  style: 'currency',\n  currency: 'EUR',\n});").length, 1);
  // The same Intl path without spelling `NumberFormat` (review of verifactu#136).
  assert.equal(
    handFormattedMoney("const s = (total / 100).toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });").length,
    1,
  );
  assert.equal(handFormattedMoney("const s = (total / 100).toLocaleString(locale, {\n  style: 'currency',\n  currency,\n});").length, 1);
});

test('hand-formatted money: the shared formatter, comments and non-money Intl pass', () => {
  assert.deepEqual(handFormattedMoney('const s = erplora().formatMoney(total);'), []);
  assert.deepEqual(handFormattedMoney('// was (x / 100).toFixed(2)\nconst s = erplora().formatMoney(x);'), []);
  assert.deepEqual(handFormattedMoney('/* was (x / 100).toFixed(2) */ const s = erplora().formatMoney(x);'), []);
  assert.deepEqual(handFormattedMoney('new Intl.NumberFormat(locale, { maximumFractionDigits: 3 })'), []);
  assert.deepEqual(handFormattedMoney("const s = new Date(x).toLocaleString(locale, { hour: '2-digit' });"), []);
});

test('hand-formatted money: one hit per line, keyed by the trimmed code line', () => {
  assert.deepEqual(handFormattedMoney('  const a = x.toFixed(2);\n  const b = y.toFixed(2);'), [
    'const a = x.toFixed(2);',
    'const b = y.toFixed(2);',
  ]);
});

test('stripComments is NOT greedy: code between two block comments survives (V3)', () => {
  const src = '/** a */\nconst s = (x / 100).toFixed(2);\n/** b */\nconst t = erplora().formatMoney(x);';
  const code = stripComments(src);
  assert.match(code, /toFixed\(2\)/);
  assert.match(code, /erplora\(\)\.formatMoney\(/);
  assert.equal(handFormattedMoney(src).length, 1);
  // A URL is not a line comment.
  assert.match(stripComments("const u = 'https://erplora.com/x';"), /erplora\.com\/x/);
});

test('barrel: the five doors are caught', () => {
  assert.equal(barrelValueImports("import { formatMinor } from '@erplora/outfitkit';").length, 1);
  assert.equal(barrelValueImports("import {\n  formatMinor,\n} from '@erplora/outfitkit';").length, 1);
  assert.equal(barrelValueImports("import '@erplora/outfitkit';").length, 1);
  assert.equal(barrelValueImports("const ok = await import('@erplora/outfitkit');").length, 1);
  assert.equal(barrelValueImports('void import(\n  "@erplora/outfitkit"\n);').length, 1);
  assert.equal(barrelValueImports("export { formatMinor } from '@erplora/outfitkit';").length, 1);
  assert.equal(barrelValueImports("export * from '@erplora/outfitkit';").length, 1);
  assert.equal(barrelValueImports("export * as ok from '@erplora/outfitkit';").length, 1);
  // A mixed import still drags values in.
  assert.equal(barrelValueImports("import { type DataTableColumn, formatMinor } from '@erplora/outfitkit';").length, 1);
});

test('barrel: type-only, entry points and comments pass', () => {
  assert.deepEqual(barrelValueImports("import type { DataTableColumn } from '@erplora/outfitkit';"), []);
  assert.deepEqual(barrelValueImports("export type { OkDetailItem } from '@erplora/outfitkit';"), []);
  assert.deepEqual(barrelValueImports("import { formatMinor } from '@erplora/outfitkit/ok-money';"), []);
  assert.deepEqual(barrelValueImports("import '@erplora/outfitkit/ok-data-table';"), []);
  assert.deepEqual(barrelValueImports("const m = await import('@erplora/outfitkit/ok-money');"), []);
  assert.deepEqual(barrelValueImports("// import { formatMinor } from '@erplora/outfitkit';"), []);
  assert.deepEqual(barrelValueImports("/* import '@erplora/outfitkit'; */"), []);
});

test('barrel: a statement without semicolons does not swallow the next import', () => {
  // A statement with no quote and no `;` before the next line (`export const x = 1`) let the span
  // run on to the `from` of a type-only import of the barrel and read it as a value export. The
  // span may not cross another import/export keyword.
  const src = "export const x = 1\nimport type { T } from '@erplora/outfitkit'\n";
  assert.deepEqual(barrelValueImports(src), []);
  const bad = "export const x = 1\nimport { formatMinor } from '@erplora/outfitkit'\n";
  assert.equal(barrelValueImports(bad).length, 1);
});

test('outfitkitImports lists every OutfitKit specifier the barrel detector examined', () => {
  const src = [
    "import type { DataTableColumn } from '@erplora/outfitkit';",
    "import '@erplora/outfitkit/ok-data-table';",
    "import { formatMinor } from '@erplora/outfitkit/ok-money';",
    "import { html } from 'lit';",
  ].join('\n');
  assert.equal(outfitkitImports(src).length, 3);
  assert.deepEqual(barrelValueImports(src), []);
});

test('an exception covers ONE occurrence of its line, not every copy (X1)', () => {
  const allowed = { 'lib/a.ts: x.toFixed(d);': 'input value' };
  assert.deepEqual(unexpectedHits(['lib/a.ts: x.toFixed(d);'], allowed), []);
  assert.deepEqual(unexpectedHits(['lib/a.ts: x.toFixed(d);', 'lib/a.ts: x.toFixed(d);'], allowed), [
    'lib/a.ts: x.toFixed(d);',
  ]);
  assert.deepEqual(unexpectedHits(['lib/b.ts: x.toFixed(d);'], allowed), ['lib/b.ts: x.toFixed(d);']);
});

// ── The whole check, over a real module tree ─────────────────────────────────────────────────

const SCREEN = 'components/erp-demo-list/erp-demo-list.ts';
const OK_IMPORTS = "import type { DataTableColumn } from '@erplora/outfitkit';\nimport '@erplora/outfitkit/ok-data-table';\n";
// The comment is part of the fixture: what a comment says (an old barrel import, an old `toFixed`)
// is not code, and the tree scan must read the same stripped code as the detectors.
const GOOD_SCREEN = `${OK_IMPORTS}/* was: import { formatMinor } from '@erplora/outfitkit'; (c / 100).toFixed(2) */\n// import '@erplora/outfitkit';\nconst price = (r) => erplora().formatMoney(r.price_cents);\n`;

function mod(files) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-money-guard-'));
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id: 'demo', name: 'demo', version: '1.0.0' }));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, 'ui', rel, '..'), { recursive: true });
    writeFileSync(join(dir, 'ui', rel), body);
  }
  // Where the module's own test lives: the guard is called with its `import.meta.url`.
  mkdirSync(join(dir, 'ui', 'lib'), { recursive: true });
  const from = pathToFileURL(join(dir, 'ui', 'lib', 'money-display-guard.test.ts')).href;
  return { dir, from, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const WITNESS = { [SCREEN]: 'erplora().formatMoney(' };
const codes = (findings) => findings.map((f) => f.code).sort();

test('a clean module passes', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN });
  assert.deepEqual(checkMoneyDisplay({ from: m.from, witnesses: WITNESS }), []);
  m.clean();
});

test('`from` may be the module directory itself', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN });
  assert.deepEqual(checkMoneyDisplay({ from: m.dir, witnesses: WITNESS }), []);
  m.clean();
});

test('an amount formatted by hand in a screen turns it red, naming file and line', () => {
  const m = mod({ [SCREEN]: `${GOOD_SCREEN}const total = (r) => \`\${(r.total / 100).toFixed(2)} €\`;\n` });
  const f = checkMoneyDisplay({ from: m.from, witnesses: WITNESS });
  assert.deepEqual(codes(f), ['hand_formatted_money']);
  assert.equal(f[0].file, SCREEN);
  assert.match(f[0].detail, /toFixed\(2\)/);
  m.clean();
});

test('the detectors read the WHOLE file: a hit at the end of a long screen is red (rv-taxes-78 K1/K2)', () => {
  // A real screen runs to thousands of lines; a scan over its head only would stay green.
  const body = 'const row = (r) => erplora().formatMoney(r.amount_cents);\n'.repeat(2000);
  const money = mod({ [SCREEN]: `${GOOD_SCREEN}${body}const tail = (c) => (c / 100).toFixed(2);\n` });
  assert.deepEqual(codes(checkMoneyDisplay({ from: money.from, witnesses: WITNESS })), ['hand_formatted_money']);
  money.clean();
  const barrel = mod({ [SCREEN]: `${GOOD_SCREEN}${body}import { formatMinor } from '@erplora/outfitkit';\n` });
  assert.deepEqual(codes(checkMoneyDisplay({ from: barrel.from, witnesses: WITNESS })), ['outfitkit_barrel_import']);
  barrel.clean();
});

test('lib/ and .vue are scanned; ui/test/, *.test.ts and *.d.ts are not', () => {
  const bad = "export const eur = (c) => (c / 100).toFixed(2);\n";
  const m = mod({
    [SCREEN]: GOOD_SCREEN,
    'lib/money.ts': bad,
    'components/x/x.vue': `<script setup>\nconst s = new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' });\n</script>\n`,
    'test/doubles.ts': bad,
    'lib/money.test.ts': bad,
    'lib/money.d.ts': bad,
  });
  const f = checkMoneyDisplay({ from: m.from, witnesses: WITNESS });
  assert.deepEqual(f.map((x) => x.file).sort(), ['components/x/x.vue', 'lib/money.ts']);
  m.clean();
});

test('each of the five barrel doors turns the module red', () => {
  const doors = [
    "import { formatMinor } from '@erplora/outfitkit';",
    "import '@erplora/outfitkit';",
    "void import('@erplora/outfitkit');",
    "export { formatMinor } from '@erplora/outfitkit';",
    "export * from '@erplora/outfitkit';",
  ];
  for (const door of doors) {
    const m = mod({ [SCREEN]: `${GOOD_SCREEN}${door}\n` });
    const f = checkMoneyDisplay({ from: m.from, witnesses: WITNESS });
    assert.deepEqual(codes(f), ['outfitkit_barrel_import'], door);
    m.clean();
  }
});

test('a triaged exception lets its line through ONCE; a second copy is red', () => {
  const line = 'const v = (c / 100).toFixed(2);';
  const notDisplay = { [`lib/input.ts: ${line}`]: 'editable field value, not a screen amount' };
  const once = mod({ [SCREEN]: GOOD_SCREEN, 'lib/input.ts': `${line}\n` });
  assert.deepEqual(checkMoneyDisplay({ from: once.from, witnesses: WITNESS, notDisplay }), []);
  once.clean();
  // The allowed line copied into a new display function of the same file (rv-inventory-117).
  const twice = mod({
    [SCREEN]: GOOD_SCREEN,
    'lib/input.ts': `function toInput(c) {\n  ${line}\n}\nfunction toScreen(c) {\n  ${line}\n}\n`,
  });
  const f = checkMoneyDisplay({ from: twice.from, witnesses: WITNESS, notDisplay });
  assert.deepEqual(codes(f), ['hand_formatted_money']);
  twice.clean();
});

test('a stale exception is red: it would hide the next one', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN });
  const f = checkMoneyDisplay({
    from: m.from,
    witnesses: WITNESS,
    notDisplay: { 'lib/gone.ts: x.toFixed(2);': 'was a percentage' },
  });
  assert.deepEqual(codes(f), ['stale_exception']);
  assert.equal(f[0].detail, 'lib/gone.ts: x.toFixed(2);');
  m.clean();
});

test('without a witness the guard refuses to run: an empty scan would pass', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN });
  assert.deepEqual(codes(checkMoneyDisplay({ from: m.from })), ['witness_required']);
  assert.deepEqual(codes(checkMoneyDisplay({ from: m.from, witnesses: {} })), ['witness_required']);
  m.clean();
});

test('a witness file that the scan did not read is red', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN });
  const f = checkMoneyDisplay({ from: m.from, witnesses: { ...WITNESS, 'lib/gone.ts': 'formatMoney(' } });
  assert.deepEqual(codes(f), ['witness_file_not_scanned']);
  assert.equal(f[0].file, 'lib/gone.ts');
  m.clean();
});

test('the witness is judged by CONTENT: a call that only survives in a comment is red', () => {
  const m = mod({ [SCREEN]: `${OK_IMPORTS}// erplora().formatMoney(x)\nconst price = (r) => String(r.price_cents);\n` });
  const f = checkMoneyDisplay({ from: m.from, witnesses: WITNESS });
  assert.deepEqual(codes(f), ['witness_content_missing']);
  assert.equal(f[0].file, SCREEN);
  m.clean();
});

test('`atLeast` counts CALLS: a type declaration of the name does not stand in for them (rv-combos-22)', () => {
  const screen = `${OK_IMPORTS}interface Sdk { formatMoney(minor: number): string; }\n/** doc */\nconst a = erplora().formatMoney(1);\nconst b = erplora().formatMoney(2);\n`;
  const m = mod({ [SCREEN]: screen });
  const three = { [SCREEN]: { text: 'erplora().formatMoney(', atLeast: 3 } };
  assert.deepEqual(codes(checkMoneyDisplay({ from: m.from, witnesses: three })), ['witness_content_missing']);
  const two = { [SCREEN]: { text: 'erplora().formatMoney(', atLeast: 2 } };
  assert.deepEqual(checkMoneyDisplay({ from: m.from, witnesses: two }), []);
  m.clean();
});

test('the barrel scan must have read an OutfitKit import, or it passed on nothing', () => {
  const m = mod({ [SCREEN]: 'const price = (r) => erplora().formatMoney(r.price_cents);\n' });
  assert.deepEqual(codes(checkMoneyDisplay({ from: m.from, witnesses: WITNESS })), ['outfitkit_import_not_read']);
  m.clean();
});

test('`outfitkitImporters` names the screens that must each import OutfitKit', () => {
  const m = mod({ [SCREEN]: GOOD_SCREEN, 'components/b/b.ts': 'export const b = 1;\n' });
  const f = checkMoneyDisplay({
    from: m.from,
    witnesses: WITNESS,
    outfitkitImporters: [SCREEN, 'components/b/b.ts'],
  });
  assert.deepEqual(codes(f), ['outfitkit_import_not_read']);
  assert.equal(f[0].file, 'components/b/b.ts');
  m.clean();
});

test('a directory with no module.json above it fails loud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-money-guard-nomod-'));
  assert.throws(() => checkMoneyDisplay({ from: dir, witnesses: WITNESS }), /module\.json/);
  rmSync(dir, { recursive: true, force: true });
});

// ── How a module reaches it ──────────────────────────────────────────────────────────────────

test('the package exports it as `@erplora/module-toolkit/money-display-guard`', async () => {
  // Self-reference by package name resolves through `exports`, exactly as a module's test will.
  const viaPackage = await import('@erplora/module-toolkit/money-display-guard');
  const direct = await import('../src/money-display-guard.mjs');
  assert.equal(viaPackage.checkMoneyDisplay, direct.checkMoneyDisplay);
  // The deep paths that already worked keep working (bin, src/…): `exports` must not close them.
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['./money-display-guard'].default, './src/money-display-guard.mjs');
  assert.equal(pkg.exports['./money-display-guard'].types, './src/money-display-guard.d.mts');
  assert.equal(pkg.exports['./*'], './*');
  await import('@erplora/module-toolkit/src/run-vitest.mjs');
});

test('the type declaration names every export of the guard', async () => {
  const mod_ = await import('../src/money-display-guard.mjs');
  const dts = readFileSync(join(REPO, 'src/money-display-guard.d.mts'), 'utf8');
  for (const name of Object.keys(mod_)) assert.match(dts, new RegExp(`export (declare )?function ${name}\\b`), name);
});

test('the gate links the toolkit next to the module, so its TypeScript tests can import the guard', () => {
  const yaml = readFileSync(join(REPO, '.github/actions/validate-module/action.yml'), 'utf8');
  const code = yaml
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.match(code, /ln -sfn "\$ERPLORA_TOOLKIT" "\$mod\/node_modules\/@erplora\/module-toolkit"/);
});
