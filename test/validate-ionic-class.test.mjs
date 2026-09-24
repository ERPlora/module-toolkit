// `class=${…}` on an Ionic element wipes the classes Ionic stamps on its host — module-toolkit#303.
// `node --test`.
//
// WHY THIS EXISTS. A Lit attribute binding on `class` (`class=${expr}`, or `class="a ${expr}"`)
// commits with `setAttribute('class', …)`: the WHOLE attribute, on every change. Stencil only
// re-adds the host classes its own render changes (`button-outline`, `button-null`…), so the ones
// it stamped once — `ion-activatable` (what Ionic's tap-click looks for to set `ion-activated`),
// `ion-focusable`, `hydrated`, `ios`/`md` — are gone for good after the first state change. The
// element still LOOKS right, it just stops lighting up when tapped and loses its keyboard focus
// ring. It shipped on the kitchen URGENT toggle (kitchen#88) and the sales discount button
// (sales#358) and each was fixed alone. `classMap(…)` only touches the keys it declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CLASS_GRANDFATHERED,
  checkIonicClass,
  ionTagsWithClobberingClass,
} from '../src/validate-ionic-class.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-ionicclass-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const CLOBBER = "<ion-item button class=${this.sel ? 'sel' : ''}>x</ion-item>";
const FIXED = "<ion-item button class=\"row ${classMap({ sel: this.sel })}\">x</ion-item>";

// ── The premise: this guard has a cause, and must not outlive it ─────────────────────

test('Ionic stamps `ion-activatable` on the host once, and tap-click needs it to light up', () => {
  // Pinned to the dependency itself. The day Ionic stops relying on a host class it set once, this
  // fails and says the guard can go.
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve('@ionic/core/package.json'));
  const button = readFileSync(join(core, 'dist/collection/components/button/button.js'), 'utf8');
  const tapClick = readFileSync(join(core, 'dist/collection/utils/tap-click/index.js'), 'utf8');
  assert.match(button, /'ion-activatable': true/, 'ion-button no longer stamps ion-activatable on its host');
  assert.match(tapClick, /closest\('\.ion-activatable'\)/, 'tap-click no longer looks for the host class');
});

// ── Reading a Lit tag ─────────────────────────────────────────────────────────────────

test('FAILS: the single-line shape of customers pos-search', () => {
  const dead = ionTagsWithClobberingClass(`html\`${CLOBBER}\``);
  assert.equal(dead.length, 1, JSON.stringify(dead));
  assert.match(dead[0].tag, /class=\$\{/);
});

test('FAILS: the multi-line shape of pricing lists — reported where the element OPENS', () => {
  // Verbatim shape from `pricing/ui/components/erp-pricing-lists`: the one a single-line grep missed.
  const src = [
    'html`',
    '<ion-input mode="md" label-placement="floating" label=${t(\'ui.colCode\')}',
    '  data-testid="pricing-code"',
    "  class=${this.formErrorField === 'code' ? 'ion-invalid ion-touched' : ''}",
    '  .value=${this.newCode} @ionInput=${(e) => { this.newCode = e.target.value; }}></ion-input>`',
  ].join('\n');
  const dead = ionTagsWithClobberingClass(src);
  assert.equal(dead.length, 1, JSON.stringify(dead));
  assert.equal(dead[0].line, 2);
});

test('FAILS: an interpolation inside a quoted class, the property `.className`, after an arrow `>`', () => {
  const src = [
    '<ion-button class="urgent ${this.urgent ? \'on\' : \'off\'}">x</ion-button>',
    "<ion-chip class='a ${b}'></ion-chip>",
    '<ion-badge .className=${this.tone}></ion-badge>',
    '<ion-item @click=${() => this.n > 1 && this.go()} class=${c}></ion-item>',
    '<ion-button class=${classMap(a)} class2=${x}></ion-button>',
    "<ion-button class=${this.on ? classMap(a) : ''}></ion-button>",
    "<ion-button class=${classMap(a) + ' extra'}></ion-button>",
  ].join('\n');
  // The fifth one is fine (classMap alone, `class2` is not `class`): six offences.
  assert.equal(ionTagsWithClobberingClass(src).length, 6, JSON.stringify(ionTagsWithClobberingClass(src)));
});

test('PASSES: classMap, static classes, other attributes, non-Ionic tags', () => {
  const src = [
    FIXED,
    '<ion-button class=${classMap({ on: this.on })}>x</ion-button>',
    '<ion-button class="fire">x</ion-button>',
    "<ion-button class='fire'>x</ion-button>",
    '<ion-note data-class=${x} subclass=${y}></ion-note>',
    '<div class=${x}></div>',
    '<ok-status-badge class=${x}></ok-status-badge>',
    // Inside another attribute's VALUE, `class=${…}` is text, not the attribute.
    '<ion-input helper-text="write class=${x} here"></ion-input>',
    '<ion-button @click=${() => go(`?class=${c}`)}>x</ion-button>',
  ].join('\n');
  assert.deepEqual(ionTagsWithClobberingClass(src), []);
});

test('PASSES: a call to a same-file helper whose whole body is `return classMap(…)` (sales `toneOf`)', () => {
  // Verbatim shape from `sales/ui/components/erp-pos-touch` after sales#358: the directive is the
  // same `classMap`, just behind a method. A static reader that only knows the literal spelling
  // would paint the sales gate red over four icons that lose nothing.
  const src = [
    'class ErpPosTouch extends LitElement {',
    "  private toneOf(on: boolean, tone: 'primary' | 'warning' | 'success') {",
    "    return classMap({ [`tone-${tone}`]: on, 'tone-medium': !on });",
    '  }',
    '  private renderLine(l: CartLine) {',
    '    return html`<ion-icon slot="start" name="x" class="selmark ${this.toneOf(this.splitSel.has(l.line_id), \'primary\')}"></ion-icon>',
    "      <ion-icon name=${l.discount ? 'pricetag' : 'pricetag-outline'} slot=\"icon-only\" class=${this.toneOf(!!l.discount, 'warning')}></ion-icon>",
    '      <ion-icon class=${tone(true)}></ion-icon>`;',
    '  }',
    '}',
    'const tone = (on: boolean) => classMap({ on });',
    "function toneFn(on: boolean): string { return on ? 'a' : 'b'; }",
  ].join('\n');
  assert.deepEqual(ionTagsWithClobberingClass(src), []);
});

test('FAILS: a helper that returns a string, adds to classMap, or lives in another file', () => {
  const src = [
    "function toneStr(on: boolean) { return on ? 'a' : 'b'; }",
    "function toneMore(on: boolean) { return classMap({ on }) + ' x'; }",
    'function toneTwo(on: boolean) { const m = classMap({ on }); return m; }',
    'const toneArrow = (on: boolean) => `t-${on}`;',
    '<ion-button class=${toneStr(this.on)}></ion-button>',
    '<ion-button class=${toneMore(this.on)}></ion-button>',
    '<ion-button class=${toneTwo(this.on)}></ion-button>',
    '<ion-button class=${toneArrow(this.on)}></ion-button>',
    '<ion-button class=${this.importedHelper(this.on)}></ion-button>',
    '<ion-button class=${this.toneStr}></ion-button>',
  ].join('\n');
  assert.equal(ionTagsWithClobberingClass(src).length, 6, JSON.stringify(ionTagsWithClobberingClass(src)));
});

// ── The whole door: a module directory ───────────────────────────────────────────────

test('checkIonicClass: reports the offenders of `ui/`, with file, line and the fix', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`${CLOBBER}\`;\n` });
  const { errors } = checkIonicClass(m.dir, m.manifest);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /ui\/components\/erp-demo\/erp-demo\.ts/);
  assert.match(errors[0], /L1:/);
  assert.match(errors[0], /classMap/, 'the error has to say how to fix it');
  m.clean();
});

test('checkIonicClass: a clean module, one with no `ui/`, build output and tests say nothing', () => {
  const clean = mod({ 'ui/components/erp-demo/erp-demo.ts': FIXED });
  assert.deepEqual(checkIonicClass(clean.dir, clean.manifest), { errors: [], warnings: [] });
  clean.clean();
  const none = mod({ 'module.json': '{}' });
  assert.deepEqual(checkIonicClass(none.dir, none.manifest), { errors: [], warnings: [] });
  none.clean();
  const built = mod({
    'ui/dist/demo.esm.js': CLOBBER,
    'ui/node_modules/x/i.js': CLOBBER,
    'dist/demo.esm.js': CLOBBER,
    'ui/lib/guard.test.ts': `const tpl = '${CLOBBER}';`,
  });
  assert.deepEqual(checkIonicClass(built.dir, built.manifest).errors, []);
  built.clean();
});

// ── Gradualness: the ratchet ─────────────────────────────────────────────────────────

// The published list is EMPTY since pricing#43 (the last module fixed its own), so the mechanism is
// exercised on a stand-in list: it stays because a future door may need the same ratchet, and a
// ratchet nobody tests is one that silently stops holding.
const STAND_IN = [
  ['legacy', 'ui/components/erp-old/erp-old.ts', 1],
  ['legacy', 'ui/components/erp-older/erp-older.ts', 2],
];

function asPublished(id, list = STAND_IN) {
  return Object.fromEntries(
    list.filter(([m]) => m === id).map(([, f, n]) => [f, Array(n).fill(CLOBBER).join('\n')]),
  );
}

test('a grandfathered file keeps passing with what it had — and NOT with one more', () => {
  const [id, file, allowed] = STAND_IN[0];
  const asIs = mod(asPublished(id), id);
  assert.deepEqual(checkIonicClass(asIs.dir, asIs.manifest, STAND_IN), { errors: [], warnings: [] });
  asIs.clean();

  const worse = mod({ ...asPublished(id), [file]: Array(allowed + 1).fill(CLOBBER).join('\n') }, id);
  const { errors } = checkIonicClass(worse.dir, worse.manifest, STAND_IN);
  assert.equal(errors.length, 1, 'one more in a grandfathered file is a NEW offence');
  assert.match(errors[0], new RegExp(`${allowed} venían de antes`));
  worse.clean();
});

test('the pass is per FILE: a new component of a grandfathered module inherits nothing', () => {
  const [id] = STAND_IN[0];
  const m = mod({ ...asPublished(id), 'ui/components/erp-brand-new/erp-brand-new.ts': CLOBBER }, id);
  const { errors } = checkIonicClass(m.dir, m.manifest, STAND_IN);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /erp-brand-new/);
  m.clean();
});

test('FAILS: an entry that outlived its file — clean, or gone — is an open door', () => {
  const [id, file] = STAND_IN[0];
  const cleaned = mod({ ...asPublished(id), [file]: FIXED }, id);
  const stale = checkIonicClass(cleaned.dir, cleaned.manifest, STAND_IN).errors.filter((e) => e.startsWith(file));
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0], /CLASS_GRANDFATHERED/);
  assert.match(stale[0], /module-toolkit#303/);
  cleaned.clean();

  const gone = mod({ 'ui/components/erp-other/erp-other.ts': FIXED }, id);
  assert.ok(checkIonicClass(gone.dir, gone.manifest, STAND_IN).errors.some((e) => e.startsWith(file)), 'a deleted file keeps no allowance');
  gone.clean();
});

test('WARNS (does not fail): a file cleaner than its allowance but not clean yet', () => {
  const [id, file] = STAND_IN[1];
  const m = mod({ ...asPublished(id), [file]: CLOBBER }, id);
  const { errors, warnings } = checkIonicClass(m.dir, m.manifest, STAND_IN);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /1 de los 2/);
  m.clean();
});

test('a module that ships no `ui/` is warned, never blocked, for somebody else\'s allowance', () => {
  // module-toolkit#189: reusing a published id must not inherit a red gate.
  const [id] = STAND_IN[0];
  const owed = STAND_IN.filter(([m]) => m === id).length;
  const m = mod({ 'module.json': '{}' }, id);
  const { errors, warnings } = checkIonicClass(m.dir, m.manifest, STAND_IN);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, owed);
  m.clean();
});

test('an exact allowance is silent', () => {
  const m = mod(asPublished('legacy'), 'legacy');
  assert.deepEqual(checkIonicClass(m.dir, m.manifest, STAND_IN), { errors: [], warnings: [] });
  m.clean();
});

test('the grandfathered list is EMPTY and stays empty: every module fixed its own', () => {
  // The ratchet reached 0 files / 0 uses with pricing#43 (customers#77 and sales#359 before it). It
  // can only go back up by excusing a NEW clobbering `class=${…}`, and that is exactly what #303
  // forbids: a module fixes it with `classMap`, it does not get a line here.
  assert.deepEqual(CLASS_GRANDFATHERED, [], 'the list GREW. Nothing gets added: each module fixes its own.');
});

// ── Through the REAL door: the function proves nothing if `erplora validate` does not run it ──

test('`erplora validate` REJECTS a module whose component binds the whole class of an ion-*', async () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`${CLOBBER}\`;\n` });
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest));
  writeContractsFile(m.dir, m.manifest);
  try {
    await assert.rejects(() => validate(m.dir), /module-toolkit#303[\s\S]*erp-demo\.ts/);
  } finally {
    m.clean();
  }
});
