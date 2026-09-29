// A Lit opening tag left without its `>` publishes an EMPTY element — module-toolkit#398.
// `node --test`.
//
// WHY THIS EXISTS. In a Lit template an expression that sits inside an opening tag, with no
// attribute in front of it, is an ELEMENT part. Lit binds element directives there (`ref`, `spread`)
// and silently ignores anything else: no error, no warning. So a single missing `>`
//
//     <ion-button @click=${() => void this.save()}
//       ${this.saving ? this.t('ui.saving') : this.t('ui.save')}
//     </ion-button>
//
// turns the label into an element part and the button ships with no children — a coloured square
// nobody can name. That is exactly what flows shipped from flows#116 until a QA saw it (flows#144,
// fixed locally by flows#145). The mistake is one character and can land in any module, so the gate
// rejects it in every one; on 2026-09-28 there are zero cases in the 27 modules, hence no
// grandfather list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkLitElementParts, strayElementParts } from '../src/validate-lit-element-part.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-litpart-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The exact shape `erp-flows-editor.ts` shipped before flows#145 (flows#144), `>` missing. */
const FLOWS_144 = [
  'export class ErpFlowsEditor extends LitElement {',
  '  render() {',
  '    return html`',
  '      <div class="actions">',
  '        <ion-button',
  '          size="small"',
  '          data-testid="flows-editor-save"',
  '          ?disabled=${this.saving}',
  '          @click=${() => void this.save()}',
  "          ${this.saving ? this.t('ui.saving') : this.t('ui.save')}",
  '        </ion-button>',
  '      </div>',
  '    `;',
  '  }',
  '}',
  '',
].join('\n');

/** The same component after flows#145: the `>` is back, the label is a child again. */
const FLOWS_145 = FLOWS_144.replace('@click=${() => void this.save()}\n', '@click=${() => void this.save()}\n        >\n');

// ── The positive control: the case that shipped ───────────────────────────────────────────────

test('flows#144 — the label inside an unclosed <ion-button> is reported, at the line the tag opens', () => {
  const found = strayElementParts(FLOWS_144);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.equal(found[0].tag, 'ion-button');
  assert.equal(found[0].line, 5);
  assert.match(found[0].expr, /this\.saving \? this\.t\('ui\.saving'\)/);
});

test('flows#145 — the same button with its `>` back is clean', () => {
  assert.deepEqual(strayElementParts(FLOWS_145), []);
});

test('a single-line unclosed tag is reported, whatever the element', () => {
  assert.equal(strayElementParts('html`<ion-button @click=${f} ${label}</ion-button>`').length, 1);
  assert.equal(strayElementParts('html`<span class="x" ${label}</span>`').length, 1);
  assert.equal(strayElementParts('html`<erp-card .item=${a} ${b}</erp-card>`').length, 1);
  assert.equal(strayElementParts('html`<div ${label}</div>`')[0].tag, 'div');
});

test('a bare expression right after a complete attribute binding is still reported', () => {
  assert.equal(strayElementParts('html`<ion-button fill=${f} ${label}</ion-button>`').length, 1);
});

test('a brace inside a string or a nested template of an earlier binding does not hide the stray part', () => {
  const src1 = "html`<ion-button title=${'{'} @click=${f}\n  ${label}</ion-button>`";
  const src2 = 'html`<ion-button .body=${html`<i>{</i>`} @click=${f}\n  ${label}</ion-button>`';
  assert.equal(strayElementParts(src1).length, 1, src1);
  assert.equal(strayElementParts(src2).length, 1, src2);
});

test('the reader keeps its place across what would derail a naive tokenizer, so the stray part is still found', () => {
  const stray = [
    // an escaped quote inside a string of an earlier binding
    "html`<ion-button title=${'it\\'s'} @click=${f}\n  ${label}</ion-button>`",
    // an escaped backtick inside a nested template of an earlier binding
    'html`<ion-button .body=${html`<i>\\`</i>`} @click=${f}\n  ${label}</ion-button>`',
    // a handler with nested blocks and a `>` comparison: the expression ends at its OWN `}`
    'html`<ion-button @click=${() => { if (x) { a(); } return b > c; }}\n  ${label}</ion-button>`',
    // an apostrophe in stray text is not the start of a quoted attribute value
    "html`<ion-button @click=${f}\n  It's ${label}</ion-button>`",
  ];
  for (const src of stray) assert.equal(strayElementParts(src).length, 1, src);
});

test('only an expression that IS an element directive is allowed, not one that merely calls something named like it', () => {
  assert.equal(strayElementParts('html`<a @click=${f} ${this.href(x)}</a>`').length, 1);
  assert.equal(strayElementParts('html`<div @click=${f} ${this.t(ref(x))}</div>`').length, 1);
});

test('a tag quoted in a JSDoc line starting with `*` is not read as a tag', () => {
  assert.deepEqual(strayElementParts('/**\n * e.g. <ion-button ${label}\n */\nconst t = 1;'), []);
});

// ── What Lit DOES accept there, and every binding that is not in element position ──────────────

test('the element directives Lit binds in that position are allowed', () => {
  assert.deepEqual(strayElementParts('html`<ion-input ${ref(this.inputRef)} label="x"></ion-input>`'), []);
  assert.deepEqual(strayElementParts('html`<div ${ref((el) => (this.el = el))}></div>`'), []);
  assert.deepEqual(strayElementParts('html`<div ${ ref(this.r) }></div>`'), []);
  assert.deepEqual(strayElementParts('html`<div ${spread(this.props)}></div>`'), []);
  assert.deepEqual(strayElementParts('html`<div ${animate()}></div>`'), []);
});

test('attribute, boolean, property and event bindings are not element parts', () => {
  const clean = [
    'html`<ion-button ?disabled=${this.busy}>ok</ion-button>`',
    'html`<erp-x .item=${this.item}></erp-x>`',
    'html`<ion-button @click=${() => this.go()}>go</ion-button>`',
    'html`<div title="${this.name}"></div>`',
    "html`<div class='a ${this.b} c'></div>`",
    'html`<div title = ${this.name}></div>`',
    'html`<div data-x=${this.a}\n  data-y=${this.b}\n></div>`',
  ];
  for (const src of clean) assert.deepEqual(strayElementParts(src), [], src);
});

test('an expression that continues an unquoted value or another expression is an attribute part', () => {
  assert.deepEqual(strayElementParts('html`<div data-x=row-${this.id}></div>`'), []);
  assert.deepEqual(strayElementParts('html`<div title=${this.a}${this.b}></div>`'), []);
});

test('a `>` or a `}` inside an expression does not close the tag or the expression', () => {
  const clean = [
    'html`<ion-button ?disabled=${() => a > b} @click=${f}>${label}</ion-button>`',
    "html`<div title=${'}'} data-x=${x}>${label}</div>`",
    'html`<div .cfg=${{ a: { b: 1 } }}>${label}</div>`',
    'html`<div .body=${this.open ? html`<b>${x}</b>` : nothing}>${label}</div>`',
  ];
  for (const src of clean) assert.deepEqual(strayElementParts(src), [], src);
});

test('text children and nested templates after a closed tag are not element parts', () => {
  assert.deepEqual(strayElementParts('html`<ion-button>${label}</ion-button>`'), []);
  assert.deepEqual(strayElementParts('html`<ul>${items.map((i) => html`<li>${i}</li>`)}</ul>`'), []);
});

test('TypeScript around the templates is not read as a tag', () => {
  const clean = [
    'const m: Map<string, number> = new Map();\nconst t = html`<p>${m.size}</p>`;',
    'function f(xs: Array<Row>) { return html`<p>${xs.length}</p>`; }',
    'if (a <b && c) { return `${a}`; }',
    'const p: Promise<void> = x;\nconst s = `${p}`;',
    'const n = a <b ? 1 : 2;\nconst s = `total ${n}`;',
  ];
  for (const src of clean) assert.deepEqual(strayElementParts(src), [], src);
});

test('a tag named in a COMMENT is not read as a tag (the trap of module-toolkit#367)', () => {
  const clean = [
    '// every <ion-button\nconst t = html`<ion-button>${label}</ion-button>`;',
    '/* see <ion-button ${x} */\nconst t = 1;',
    '/**\n * Wraps an <ion-item\n */\nexport const x = html`<p>${y}</p>`;',
  ];
  for (const src of clean) assert.deepEqual(strayElementParts(src), [], src);
});

// ── A comment INSIDE an expression is not code (module-toolkit#421) ───────────────────────────

/**
 * The shape that turned flows#149 red with nothing unclosed, as `erp-flows-editor.ts` has it: the
 * handler of a CLOSED `<input>` carries a comment with an apostrophe (`comment`), and so does an
 * expression of a later template (`later`). Read as code, the first apostrophe opens a «string» that
 * runs to the second, the handler «ends» hundreds of lines below and the next child expression is
 * reported as the stray part of that `<input>`.
 */
function flows149(comment, later, quote = "'") {
  return [
    'const iters = html`',
    '  <input',
    '    @change=${(e) =>',
    '      this.setDoc({',
    `        ${comment}`,
    '        max_iters: 1,',
    '      })}',
    '  />',
    '`;',
    'const taps = html`',
    '  ${this.renderValue({',
    `    ${later}`,
    '    template: true,',
    '  })}',
    '',
    `  \${taps.kind === ${quote}list${quote} ? open : nothing}`,
    '`;',
    '',
  ].join('\n');
}

const FLOWS_149 = flows149(
  "// Clamping here keeps the refusal off the owner's screen.",
  "// Meta's body.text is a string on the wire.",
);

test('flows#149 — an apostrophe in a comment of a handler does not open a string: the closed tag is clean', () => {
  assert.deepEqual(strayElementParts(FLOWS_149), []);
});

test('a quote in a comment of an expression is not code, whatever the quote and the comment', () => {
  const clean = [
    flows149("/* keeps the refusal off the owner's screen */", "/* Meta's body is a string */"),
    flows149("/**\n         * the owner's screen\n         */", "/** Meta's body */"),
    flows149('// a 2" pipe', '// a 3" pipe', '"'),
  ];
  for (const src of clean) assert.deepEqual(strayElementParts(src), [], src);
});

test('the stray part after a handler with a comment is still found, at the line its tag opens', () => {
  const stray = [
    // a quote: read as a string, it would swallow the rest of the file and the stray part with it
    "html`\n<ion-button @click=${() => {\n  // keeps the owner's place\n  f();\n}}\n  ${label}</ion-button>`",
    "html`\n<ion-button @click=${() => { /* the owner's place */ f(); }}\n  ${label}</ion-button>`",
    // a brace or a backtick: read as code, the expression would end somewhere else
    'html`\n<ion-button @click=${() => { /* { */ f(); }}\n  ${label}</ion-button>`',
    'html`\n<ion-button @click=${() => {\n  // }\n  f();\n}}\n  ${label}</ion-button>`',
    'html`\n<ion-button @click=${() => { /* a ` tick */ f(); }}\n  ${label}</ion-button>`',
  ];
  for (const src of stray) {
    assert.deepEqual(
      strayElementParts(src).map((found) => [found.tag, found.line, found.expr]),
      [['ion-button', 2, 'label']],
      src,
    );
  }
});

test('what only LOOKS like a comment is not skipped: `//` in a string or a template, and a division', () => {
  const values = ["href=${'https://erplora.com'}", 'href=${`https://${host}/x`}', '.ratio=${a / b}'];
  for (const value of values) {
    const stray = `html\`<ion-button ${value} @click=\${f}\n  \${label}</ion-button>\``;
    const clean = `html\`<ion-button ${value} @click=\${f}>\${label}</ion-button>\``;
    assert.equal(strayElementParts(stray).length, 1, stray);
    assert.deepEqual(strayElementParts(clean), [], clean);
  }
});

test('an escaped slash of a regular expression does not open a comment: `/^https?:\\/\\//` is code', () => {
  const values = ["href=${url.replace(/^https?:\\/\\//, '')}", "href=${s.replace(/\\/*$/, '')}"];
  for (const value of values) {
    const stray = `html\`<a ${value}\n  \${label}</a>\`;\nconst tail = '*/';`;
    const clean = `html\`<a ${value}>\${label}</a>\`;\nconst tail = '*/';`;
    assert.deepEqual(
      strayElementParts(stray).map((found) => [found.tag, found.expr]),
      [['a', 'label']],
      stray,
    );
    assert.deepEqual(strayElementParts(clean), [], clean);
  }
});

test('checkLitElementParts lets the closed tag of flows#149 through', () => {
  const m = mod({ 'ui/components/erp-flows-editor/erp-flows-editor.ts': FLOWS_149 });
  try {
    assert.deepEqual(checkLitElementParts(m.dir, m.manifest).errors, []);
  } finally {
    m.clean();
  }
});

// ── The module gate ────────────────────────────────────────────────────────────────────────────

test('checkLitElementParts reports the file and the line of an unclosed tag in ui/', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': FLOWS_144 });
  try {
    const { errors } = checkLitElementParts(m.dir, m.manifest);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^ui\/components\/erp-demo\/erp-demo\.ts: /);
    assert.match(errors[0], /L5: <ion-button/);
  } finally {
    m.clean();
  }
});

test('tests, build output and code outside ui/ are not gated', () => {
  const m = mod({
    'ui/components/erp-demo/erp-demo.test.ts': FLOWS_144,
    'ui/dist/erp-demo.js': FLOWS_144,
    'ui/node_modules/lib/index.js': FLOWS_144,
    'scripts/tool.ts': FLOWS_144,
    'ui/components/erp-demo/erp-demo.ts': FLOWS_145,
  });
  try {
    assert.deepEqual(checkLitElementParts(m.dir, m.manifest).errors, []);
  } finally {
    m.clean();
  }
});

// ── Through the REAL door: the function proves nothing if `erplora validate` does not run it ──

test('`erplora validate` REJECTS a module with the unclosed button of flows#144', async () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': FLOWS_144 });
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest));
  writeContractsFile(m.dir, m.manifest);
  try {
    await assert.rejects(() => validate(m.dir), /module-toolkit#398[\s\S]*erp-demo\.ts[\s\S]*L5: <ion-button/);
  } finally {
    m.clean();
  }
});

test('`erplora validate` lets the same module through once the `>` is back', async () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': FLOWS_145 });
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest));
  writeContractsFile(m.dir, m.manifest);
  try {
    await validate(m.dir);
  } finally {
    m.clean();
  }
});
