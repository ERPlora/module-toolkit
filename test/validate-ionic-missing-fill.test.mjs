// A form control with NO `fill` at all renders with no box in the Hub — brought to the module
// author's door (ERPlora/pm#479). `node --test`.
//
// WHY THIS EXISTS. The Hub shell pins `mode: 'ios'` (ADR-0143) and repairs every `ion-input` /
// `ion-select` / `ion-textarea` that DECLARES a `fill` by moving it to `md` (hub#1060,
// `apps/web/src/lib/ionic-fill.ts`). A control that declares no `fill` is left alone: it stays in
// `ios`, and `ios` draws no box — a label and a value floating on the page. That is how the rate and
// the operation class of a new tax rule shipped (ERPlora/taxes#73), and the dead-`fill` door of
// `validate-ionic-fill.mjs` said nothing, because it only looks at controls that declare one.
//
// The exception is a control inside an `<ion-item>`: that is a LIST ROW, and the row is the surface —
// Ionic styles a bare control inside it on purpose, which is why the settings lists of `verifactu`
// look right with no `fill`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MISSING_FILL_GRANDFATHERED,
  checkIonicMissingFill,
  controlsWithoutFill,
} from '../src/validate-ionic-fill.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-ionicnofill-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * An entry whose module carries no other line, so a fixture that only writes that file does not make
 * a sibling entry look stale.
 */
function soleEntry() {
  const entry = MISSING_FILL_GRANDFATHERED.find(
    ([id]) => MISSING_FILL_GRANDFATHERED.filter(([other]) => other === id).length === 1,
  );
  assert.ok(entry, 'no module with a single grandfathered file left — pick fixtures another way');
  return entry;
}

const BARE = '<ion-input label="Name" label-placement="stacked"></ion-input>';
const BOXED = '<ion-input fill="outline" mode="md" label="Name" label-placement="stacked"></ion-input>';

// ── What counts as a control without a box, and what does NOT ───────────────────────

test('FAILS: an ion-input, ion-select or ion-textarea that declares no `fill`', () => {
  const src = [
    '<ion-input label="Rate"></ion-input>',
    '<ion-select label="Class"><ion-select-option value="a">A</ion-select-option></ion-select>',
    '<ion-textarea label="Notes"></ion-textarea>',
    '<ion-input label="Self-closing" />',
  ].join('\n');
  assert.deepEqual(
    controlsWithoutFill(src).map((c) => c.line),
    [1, 2, 3, 4],
  );
});

test('the verbatim taxes#73 controls are caught: the case that shipped', () => {
  // `erp-taxes-rules.ts` at taxes `origin/main` before taxes#73: the rate and the operation class.
  const src = [
    "<ion-input data-testid=\"taxes-rules-rate\" type=\"number\" label=${t('rules.rate')} label-placement=\"stacked\" .value=${String(this.form.rate)} @ionInput=${(e: any) => (this.form = { ...this.form, rate: Number(e.target.value) })}></ion-input>",
    "<ion-select data-testid=\"taxes-rules-operation-class\" label=${t('rules.operationClass')} label-placement=\"stacked\" .value=${this.form.operation_class} @ionChange=${(e: any) => (this.form = { ...this.form, operation_class: e.detail.value })}></ion-select>",
  ].join('\n');
  assert.equal(controlsWithoutFill(src).length, 2);
});

test('PASSES: a control that declares `fill`, however it is written', () => {
  // Whether that `fill` paints (it needs `mode="md"`) is the dead-fill door's business, not this one.
  assert.deepEqual(controlsWithoutFill(BOXED), []);
  assert.deepEqual(controlsWithoutFill('<ion-input fill="outline"></ion-input>'), []);
  assert.deepEqual(controlsWithoutFill("<ion-select fill='solid'></ion-select>"), []);
  assert.deepEqual(controlsWithoutFill('<ion-textarea fill=${this.fill}></ion-textarea>'), []);
});

test('PASSES: a `fill` written after an arrow function is still seen — the tag ends at its own `>`', () => {
  const src = '<ion-input @ionInput=${(e: any) => this.patch({ a: e.target.value })} fill="outline" mode="md"></ion-input>';
  assert.deepEqual(controlsWithoutFill(src), []);
});

test('PASSES: `fill` is looked for as an ATTRIBUTE, not as text anywhere in the tag', () => {
  // `autofill=` / `data-fill=` are not a `fill`: the control still has no box.
  assert.equal(controlsWithoutFill('<ion-input data-fill="outline" label="x"></ion-input>').length, 1);
});

test('PASSES: other ion-* elements are not form controls with a box', () => {
  assert.deepEqual(controlsWithoutFill('<ion-button>Save</ion-button>'), []);
  assert.deepEqual(controlsWithoutFill('<ion-select-option value="a">A</ion-select-option>'), []);
  assert.deepEqual(controlsWithoutFill('<ion-input-password-toggle slot="end"></ion-input-password-toggle>'), []);
  assert.deepEqual(controlsWithoutFill('<ion-searchbar></ion-searchbar>'), []);
});

// ── Prose is not markup: a control NAMED in a comment renders nothing ────────────────

test('PASSES: an `<ion-select>` named in a comment is not a control', () => {
  // Verbatim from `origin/main` on 2026-09-26: seven modules quote the tag in their doc comments
  // (`staff/ui/lib/enums.ts`, `inventory/…/erp-inventory-products.ts`…). Reporting them would put
  // those modules red for their prose.
  const src = [
    '// `in`/`out`/`sale`/`refund` in the movement TYPE column — while the `<ion-select>` two hundred',
    '/** The options of a closed domain, for an `<ion-select>` or a column filter — the same labels the',
    ' *  rejilla de productos del TPV, un `<ion-select>` de categorías fiscales, el mapa',
    '    // <ion-input label="old"></ion-input>',
  ].join('\n');
  assert.deepEqual(controlsWithoutFill(src), []);
});

test('FAILS: a real control on the line after a comment is still seen', () => {
  const src = `// the name of the guest\nhtml\`${BARE}\``;
  assert.deepEqual(
    controlsWithoutFill(src).map((c) => c.line),
    [2],
  );
});

test('checkIonicMissingFill: a test file is not UI — its fixtures quote bare controls on purpose', () => {
  // `ui/test/testids.test.ts` of 16 modules carries `'<ion-input data-testid="x"></ion-input>'` as
  // fixtures of its own guard. None of it ships to a screen.
  const m = mod({
    'ui/test/testids.test.ts': `expect(scan('${BARE}')).toEqual([]);`,
    'ui/components/erp-demo/erp-demo.test.ts': BARE,
    'ui/components/erp-demo/erp-demo.spec.js': BARE,
    'ui/components/erp-demo/erp-demo.ts': `html\`${BOXED}\``,
  });
  try {
    assert.deepEqual(checkIonicMissingFill(m.dir, m.manifest), { errors: [], warnings: [] });
  } finally {
    m.clean();
  }
});

// ── The list row: a control inside an ion-item is styled by the row ──────────────────

test('PASSES: a control inside an ion-item — the row is its surface', () => {
  assert.deepEqual(controlsWithoutFill(`<ion-list><ion-item>${BARE}</ion-item></ion-list>`), []);
  assert.deepEqual(
    controlsWithoutFill(`<ion-item lines="full">\n  <ion-label>Name</ion-label>\n  ${BARE}\n</ion-item>`),
    [],
  );
});

test('PASSES: a control rendered by a nested template that sits inside an ion-item', () => {
  const src = '<ion-item>${this.rows.map((r) => html`<ion-select .value=${r.v}></ion-select>`)}</ion-item>';
  assert.deepEqual(controlsWithoutFill(src), []);
});

test('FAILS: once the ion-item CLOSES, the next bare control is outside any row', () => {
  const src = `<ion-item>${BARE}</ion-item>\n<ion-textarea label="Notes"></ion-textarea>`;
  assert.deepEqual(
    controlsWithoutFill(src).map((c) => c.line),
    [2],
  );
});

test('FAILS: an `<ion-item>` named in a COMMENT opens no row — the bare controls after it are still seen', () => {
  // Prose is not markup for the row either: a doc comment that says «each setting is an `<ion-item>`»
  // would otherwise leave the counter one row deep and exempt every bare control below it in the file.
  const opened = ['/** Each setting is an `<ion-item>` of the list below. */', `html\`${BARE}\``].join('\n');
  assert.deepEqual(
    controlsWithoutFill(opened).map((c) => c.line),
    [2],
  );
  // …and a `</ion-item>` quoted in prose inside a real row does not close it.
  const closed = `html\`<ion-item>\n  // </ion-item> quoted inside the row\n  ${BARE}\n</ion-item>\``;
  assert.deepEqual(controlsWithoutFill(closed), []);
});

test('FAILS: ion-item-divider / ion-item-group are not a row — they do not hide a control', () => {
  assert.equal(controlsWithoutFill(`<ion-item-divider>Head</ion-item-divider>\n${BARE}`).length, 1);
  assert.equal(controlsWithoutFill(`<ion-item-group>\n${BARE}\n</ion-item-group>`).length, 1);
});

// ── The door: checkIonicMissingFill over a module's ui/ ──────────────────────────────

test('checkIonicMissingFill: reports the offender with file, line and the recipe that fixes it', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`\n${BARE}\n\`;\n` });
  try {
    const { errors, warnings } = checkIonicMissingFill(m.dir, m.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.deepEqual(warnings, []);
    assert.match(errors[0], /ui\/components\/erp-demo\/erp-demo\.ts/);
    assert.match(errors[0], /L2:/, 'the line where the control opens');
    assert.match(errors[0], /fill="outline" mode="md"/, 'the recipe the author has to apply');
    assert.match(errors[0], /pm#479/);
  } finally {
    m.clean();
  }
});

test('checkIonicMissingFill: a module whose controls all carry a box says nothing', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `html\`${BOXED}<ion-item>${BARE}</ion-item>\`` });
  try {
    assert.deepEqual(checkIonicMissingFill(m.dir, m.manifest), { errors: [], warnings: [] });
  } finally {
    m.clean();
  }
});

test('checkIonicMissingFill: no `ui/` at all (a purely declarative module) says nothing', () => {
  const m = mod({ 'module.json': '{}' });
  try {
    assert.deepEqual(checkIonicMissingFill(m.dir, m.manifest), { errors: [], warnings: [] });
  } finally {
    m.clean();
  }
});

test('checkIonicMissingFill: `dist/` and `node_modules/` are not source', () => {
  const m = mod({
    'ui/dist/bundle.js': BARE,
    'ui/node_modules/x/index.js': BARE,
  });
  try {
    assert.deepEqual(checkIonicMissingFill(m.dir, m.manifest).errors, []);
  } finally {
    m.clean();
  }
});

// ── The ratchet: what is already published is tolerated, and the list only shrinks ──

test('a grandfathered file keeps passing with the controls it had — and NOT with one more', () => {
  const [id, file, count] = soleEntry();
  const exact = mod({ [file]: Array(count).fill(BARE).join('\n') }, id);
  try {
    assert.deepEqual(checkIonicMissingFill(exact.dir, exact.manifest).errors, []);
  } finally {
    exact.clean();
  }
  const more = mod({ [file]: Array(count + 1).fill(BARE).join('\n') }, id);
  try {
    const { errors } = checkIonicMissingFill(more.dir, more.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], new RegExp(`${count} venían de antes`));
  } finally {
    more.clean();
  }
});

test('the pass is per FILE, not per module: a new component inherits nothing', () => {
  const [id, file, count] = soleEntry();
  const m = mod(
    {
      [file]: Array(count).fill(BARE).join('\n'),
      'ui/components/erp-brand-new/erp-brand-new.ts': BARE,
    },
    id,
  );
  try {
    const { errors } = checkIonicMissingFill(m.dir, m.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /erp-brand-new/);
  } finally {
    m.clean();
  }
});

test('FAILS: the file is clean but keeps its entry — the allowance covers nothing', () => {
  const [id, file] = soleEntry();
  const m = mod({ [file]: BOXED }, id);
  try {
    const { errors } = checkIonicMissingFill(m.dir, m.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /MISSING_FILL_GRANDFATHERED/, 'the error names the list to edit');
    assert.match(errors[0], /pm#479/);
  } finally {
    m.clean();
  }
});

test('FAILS: the entry points at a file that no longer exists (in a module that ships components)', () => {
  const [id, file] = soleEntry();
  const m = mod({ 'ui/components/erp-renamed/erp-renamed.ts': BOXED }, id);
  try {
    const { errors } = checkIonicMissingFill(m.dir, m.manifest);
    const stale = errors.filter((e) => e.includes(file));
    assert.equal(stale.length, 1, JSON.stringify(errors));
    assert.match(stale[0], /MISSING_FILL_GRANDFATHERED/);
  } finally {
    m.clean();
  }
});

test('WARNS (does not fail): the file is cleaner than its allowance, but not clean yet', () => {
  const [id, file, count] = MISSING_FILL_GRANDFATHERED.find(([, , c]) => c > 1);
  const m = mod({ [file]: Array(count - 1).fill(BARE).join('\n') }, id);
  try {
    const { errors, warnings } = checkIonicMissingFill(m.dir, m.manifest);
    assert.deepEqual(errors.filter((e) => e.includes(file)), []);
    assert.equal(warnings.filter((w) => w.includes(file)).length, 1, JSON.stringify(warnings));
  } finally {
    m.clean();
  }
});

test('the grandfathered list may only SHRINK', () => {
  // The two ceilings ARE the ratchet: they come down with every file a module fixes, never up. A PR
  // that adds a line has to raise them, which is what makes the addition visible in review.
  const total = MISSING_FILL_GRANDFATHERED.reduce((n, [, , count]) => n + count, 0);
  assert.ok(
    MISSING_FILL_GRANDFATHERED.length <= 5 && total <= 20,
    `the list GREW (${MISSING_FILL_GRANDFATHERED.length} files / ${total} controls). Nothing gets added: ` +
      'each module still owing empties its own line (Sale de ERPlora/pm#479).',
  );
});

test('the grandfathered list is well-formed: [moduleId, ui/ file, count > 0], no duplicates', () => {
  const seen = new Set();
  for (const entry of MISSING_FILL_GRANDFATHERED) {
    assert.equal(entry.length, 3, `bad entry: ${JSON.stringify(entry)} — [moduleId, file, count]`);
    assert.ok(entry[2] > 0, `a zero allowance is a leftover: ${entry[1]}`);
    assert.match(entry[1], /^ui\/.*\.(ts|js)$/, `a path outside ui/: ${entry[1]}`);
    const key = `${entry[0]}:${entry[1]}`;
    assert.ok(!seen.has(key), `duplicated entry: ${key}`);
    seen.add(key);
  }
});

test('taxes#73 fixed the rules form: `erp-taxes-rules.ts` is not in the list and stays out', () => {
  assert.ok(
    !MISSING_FILL_GRANDFATHERED.some(([id, file]) => id === 'taxes' && file.endsWith('erp-taxes-rules.ts')),
    'the rules form already carries its boxes: an allowance there is a free pass for the regression',
  );
});

test('printing#50 boxed the add-printer form, the paper width and the printer role: printing is not in the list and stays out', () => {
  assert.deepEqual(
    MISSING_FILL_GRANDFATHERED.filter(([id]) => id === 'printing'),
    [],
    'every control of the module carries its box: an allowance there is a free pass for the regression',
  );
});

// ── Through the REAL door: the function proves nothing if `erplora validate` does not run it ──

test('`erplora validate` REJECTS a module whose component has a control with no `fill`', async () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`${BARE}\`;\n` });
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest));
  writeContractsFile(m.dir, m.manifest);
  try {
    await assert.rejects(() => validate(m.dir), /pm#479[\s\S]*erp-demo\.ts/);
  } finally {
    m.clean();
  }
});
