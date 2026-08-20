// `fill` on an Ionic control only paints in `md` — brought to the module author's door. `node --test`.
//
// WHY THIS EXISTS. From Ionic's own source (`@ionic/core/dist/collection/components/input/input.js`):
//
//     const hasOutlineFill = mode === 'md' && this.fill === 'outline';
//
// The Hub shell pins `mode: 'ios'` (ADR-0143, `hub/apps/web/src/main.ts`), so `fill` on an
// `ion-input` / `ion-select` / `ion-textarea` is a SILENT no-op: no box, no border, no surface —
// a label floating on the page background. Nothing throws and nothing warns; the form simply looks
// like static text. That is what QA reported on Settings → Business (hub#760), and the Hub
// (`apps/web/src/theme/ionic-fill-needs-md.test.ts`) and the Cloud Portal
// (`saas/tests/unit/test_ionic_fill_needs_md.py`, saas#1080) each grew a source guard for it.
//
// Neither of them looks at the MODULES, which is where most of the forms a merchant actually fills
// in live: 25 separate repos of Lit Web Components. Measured over `origin/main` on 2026-08-20, 275
// of their 298 form controls declare a `fill` and NOT ONE declares `mode="md"`. The defence existed
// twice, in duplicate, and did not cover the third place.
//
// (A raw grep for `fill="outline"` returns ~322 across the same repos. The difference is
// `ion-button` / `ion-chip`, where `fill` IS honoured in ios, plus our own `.fill=${true}` property
// on `ok-data-table`. Flagging those would ask 25 repos to change markup that works.)
//
// 🔴 NOT A COPY OF THE HUB'S SCANNER. The Hub reads `.vue` files, where a tag ends at the first
// `>`. A Lit template does not: `@ionChange=${(e: any) => this.patch({ role_id: e.target.value })}`
// carries `>` and `{}` INSIDE the tag. Cutting at the first `>` truncates the tag halfway, and an
// attribute that comes after the arrow function — `mode="md"` among them — would be read as absent.
// That is a false positive, and a false positive here turns a correct module's gate red, which is
// worse than the bug being chased.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  FILL_GRANDFATHERED,
  checkIonicFill,
  controlTags,
  controlsWithDeadFill,
} from '../src/validate-ionic-fill.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-ionicfill-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── The premise: this guard has a cause, and must not outlive it ─────────────────────

test('Ionic still paints `fill` ONLY in md — the reason this check exists', () => {
  // Pinned to the dependency itself, not to a snapshot of it. The day a future Ionic starts
  // styling `fill` in `ios`, this fails and says the guard can go, instead of the guard quietly
  // surviving its cause and blocking correct code forever.
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve('@ionic/core/package.json'));
  const styles = join(core, 'dist/collection/components/input');
  const ios = readFileSync(join(styles, 'input.ios.css'), 'utf8');
  const md = readFileSync(join(styles, 'input.md.css'), 'utf8');

  assert.ok(md.includes('input-fill-outline'), '`md` is supposed to be the mode that paints the outline');
  assert.ok(
    !ios.includes('input-fill-outline') && !ios.includes('input-fill-solid'),
    '`ios` grew fill styling: `fill` is no longer a no-op there and this whole guard is dead weight — delete it',
  );
});

// ── Reading a Lit tag: where it ENDS ─────────────────────────────────────────────────

test('a tag ends at its own `>`, not at the one inside an arrow function', () => {
  const src = "html`<ion-select fill=\"outline\" @ionChange=${(e: any) => this.patch({ role_id: e.target.value ?? '' })} mode=\"md\"></ion-select>`";
  const [tag] = controlTags(src);
  assert.ok(tag, 'the control was not found at all');
  assert.match(tag.tag, /mode="md"/, 'the tag was cut at the `>` of the arrow function — everything after it went blind');
  assert.deepEqual(controlsWithDeadFill(src), [], 'it declares mode="md": there is nothing to report');
});

test('a `>` inside an attribute string does not end the tag either', () => {
  const src = 'html`<ion-input placeholder="a > b" fill="outline" mode="md"></ion-input>`';
  assert.deepEqual(controlsWithDeadFill(src), []);
});

test('a multi-line tag is one tag', () => {
  const src = [
    'html`<ion-textarea data-field=${f.id} fill="outline" label=${label} label-placement="floating"',
    '  auto-grow .value=${f.value} @ionInput=${set(f.id)}></ion-textarea>`',
  ].join('\n');
  const dead = controlsWithDeadFill(src);
  assert.equal(dead.length, 1, JSON.stringify(dead));
  assert.equal(dead[0].line, 1, 'the offender is reported at the line where the control OPENS');
});

test('the scanner reads the real markup of `customers`, `staff` and `inventory`', () => {
  // The three modules with the most controls. Verbatim from their sources: this is the shape the
  // check has to survive, not a shape invented for the test.
  const real = [
    '<ion-input fill="outline" label=${t(\'ui.colName\')} label-placement="floating" .value=${this.fName} @ionInput=${(e: any) => (this.fName = e.target.value)}></ion-input>',
    '<ion-select fill="outline" label-placement="floating" label=${t(\'ui.colRole\')} .value=${this.form.role_id} @ionChange=${(e: any) => this.patch({ role_id: e.target.value ?? \'\' })}><ion-select-option .value=${\'\'}>${t(\'ui.roleNone\')}</ion-select-option></ion-select>',
    '<ion-textarea data-field=${f.id} fill="outline" label=${label} auto-grow .value=${f.value} @ionInput=${set(f.id)}></ion-textarea>',
  ].join('\n');
  const dead = controlsWithDeadFill(real);
  assert.equal(dead.length, 3, `every one of the three is a dead fill: ${JSON.stringify(dead)}`);
  assert.deepEqual(
    dead.map((d) => d.line),
    [1, 2, 3],
  );
});

// ── What counts as an offence, and what does NOT ─────────────────────────────────────

test('PASSES: a control with `mode="md"` paints, and is left alone', () => {
  assert.deepEqual(controlsWithDeadFill('<ion-input mode="md" fill="outline"></ion-input>'), []);
  assert.deepEqual(controlsWithDeadFill("<ion-input mode='md' fill='outline'></ion-input>"), []);
  assert.deepEqual(controlsWithDeadFill("<ion-input mode=${'md'} fill=\"outline\"></ion-input>"), []);
});

test('PASSES: a control with no `fill` is not this check\'s business', () => {
  assert.deepEqual(controlsWithDeadFill('<ion-input label="Name"></ion-input>'), []);
  assert.deepEqual(controlsWithDeadFill('<ion-textarea auto-grow></ion-textarea>'), []);
});

test('PASSES: `fill` on an ion-button is REAL in ios — only form controls are affected', () => {
  // `ion-button` styles `fill="outline"`/`"clear"` in both modes. Flagging it would ask 25 repos to
  // change markup that works, which is exactly how a guard loses its credibility.
  assert.deepEqual(
    controlsWithDeadFill('<ion-button size="small" fill="outline">Cancel</ion-button><ion-chip fill="outline">x</ion-chip>'),
    [],
  );
});

test('PASSES: `.fill=${true}` on an ok-* component is a property of ours, not Ionic\'s attribute', () => {
  assert.deepEqual(controlsWithDeadFill('<ok-data-table .serverSide=${true} .fill=${true}></ok-data-table>'), []);
});

test('FAILS: `fill` bound from an expression is just as dead', () => {
  const dead = controlsWithDeadFill('<ion-input fill=${this.outlined ? "outline" : "solid"}></ion-input>');
  assert.equal(dead.length, 1);
});

test('FAILS: a self-closing control counts too', () => {
  assert.equal(controlsWithDeadFill('<ion-input fill="outline" />').length, 1);
});

test('the report quotes the offending tag so the author sees WHICH control', () => {
  const [dead] = controlsWithDeadFill('<ion-input data-field="nif" fill="outline"></ion-input>');
  assert.match(dead.tag, /data-field="nif"/);
});

// ── The whole door: a module directory ───────────────────────────────────────────────

test('checkIonicFill: reports the offenders of `ui/`, with file and line', () => {
  const m = mod({
    'ui/components/erp-demo-form/erp-demo-form.ts':
      'export const tpl = html`<ion-input fill="outline" label="NIF"></ion-input>`;\n',
  });
  const { errors } = checkIonicFill(m.dir, m.manifest);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /ui\/components\/erp-demo-form\/erp-demo-form\.ts/);
  assert.match(errors[0], /mode="md"/, 'the error has to say how to fix it');
  m.clean();
});

test('checkIonicFill: a module whose controls declare `mode="md"` says nothing', () => {
  const m = mod({
    'ui/components/erp-demo-form/erp-demo-form.ts':
      'export const tpl = html`<ion-input mode="md" fill="outline" label="NIF"></ion-input>`;\n',
  });
  assert.deepEqual(checkIonicFill(m.dir, m.manifest), { errors: [], warnings: [] });
  m.clean();
});

test('checkIonicFill: no `ui/` at all (a purely declarative module) says nothing', () => {
  const m = mod({ 'module.json': '{}' });
  assert.deepEqual(checkIonicFill(m.dir, m.manifest), { errors: [], warnings: [] });
  m.clean();
});

test('checkIonicFill: `dist/` and `node_modules/` are not source', () => {
  // The built bundle carries the same markup; reporting it would double every offence and point the
  // author at a generated file they cannot fix.
  const m = mod({
    'ui/dist/demo.esm.js': 'html`<ion-input fill="outline"></ion-input>`',
    'ui/node_modules/x/index.js': 'html`<ion-input fill="outline"></ion-input>`',
    'dist/demo.esm.js': 'html`<ion-input fill="outline"></ion-input>`',
  });
  assert.deepEqual(checkIonicFill(m.dir, m.manifest).errors, []);
  m.clean();
});

// ── Gradualness: the ratchet, not a big bang ─────────────────────────────────────────

test('a grandfathered file keeps passing with the controls it had — and NOT with one more', () => {
  // 322 controls across 25 repos cannot go red at once: the day this lands, every module repo would
  // be unable to publish anything for a reason unrelated to what it was publishing. So the pass is
  // per FILE and per COUNT: what is there today is tolerated, one more is not.
  const [id, file, allowed] = FILL_GRANDFATHERED[0];
  const control = '<ion-input fill="outline"></ion-input>';
  const asIs = mod({ [file]: Array.from({ length: allowed }, () => control).join('\n') }, id);
  assert.deepEqual(checkIonicFill(asIs.dir, asIs.manifest).errors, [], 'what is published today still passes');
  asIs.clean();

  const worse = mod({ [file]: Array.from({ length: allowed + 1 }, () => control).join('\n') }, id);
  const { errors } = checkIonicFill(worse.dir, worse.manifest);
  assert.equal(errors.length, 1, 'one more dead control in a grandfathered file is a NEW offence');
  assert.match(errors[0], new RegExp(String(allowed)), 'and the error says how many were tolerated');
  worse.clean();
});

test('the pass is per FILE, not per module: a new component inherits nothing', () => {
  const [id] = FILL_GRANDFATHERED[0];
  const m = mod({ 'ui/components/erp-brand-new/erp-brand-new.ts': '<ion-input fill="outline"></ion-input>' }, id);
  assert.equal(checkIonicFill(m.dir, m.manifest).errors.length, 1);
  m.clean();
});

test('the grandfathered list may only SHRINK', () => {
  // These two ceilings are the ratchet itself, and they come DOWN with every module the sweep
  // finishes — never up. Lowering them is the last step of a sweep PR, right after deleting the
  // entries; a PR that adds a line has to raise them, which is what makes the addition visible.
  const total = FILL_GRANDFATHERED.reduce((n, [, , count]) => n + count, 0);
  assert.ok(
    FILL_GRANDFATHERED.length <= 27 && total <= 170,
    `the list GREW (${FILL_GRANDFATHERED.length} files / ${total} controls). Nothing gets added: it is ` +
      'the sweep of ERPlora/pm that empties it, one module at a time.',
  );
  for (const entry of FILL_GRANDFATHERED) {
    assert.equal(entry.length, 3, `bad entry: ${JSON.stringify(entry)} — [moduleId, file, count]`);
    assert.ok(entry[2] > 0, `a zero allowance is not grandfathering, it is a leftover: ${entry[1]}`);
  }
});

test('a module the sweep already FIXED is out of the list, and stays out', () => {
  // The eight of the first sweep (ERPlora/pm#152). Each one declares `mode="md"` on every control of
  // its `ui/` at `origin/main` — verified module by module before the entries came out.
  //
  // Deleting the lines is only half of it: while a module keeps its allowance, a regression that
  // brings the dead `fill` back passes the gate in silence, and the sweep would have bought nothing.
  // Naming them here is what turns "we fixed it" into something that fails if it comes undone.
  const swept = ['customers', 'inventory', 'kitchen', 'pricing', 'printing', 'staff', 'tasks', 'whatsapp_inbox'];
  const listed = new Set(FILL_GRANDFATHERED.map(([id]) => id));
  for (const id of swept) {
    assert.ok(!listed.has(id), `${id} was swept clean: its grandfathering is a free pass for a regression now`);
  }
});

test('the list matches what the 25 repos really ship — otherwise it guards nothing', () => {
  // The positive control of the list itself: every entry names a module that exists. A typo in an id
  // or a path is a silent free pass, which is the one failure mode grandfathering has.
  const ids = new Set(FILL_GRANDFATHERED.map(([id]) => id));
  assert.ok(ids.size >= 14, `only ${ids.size} modules listed: the sweep that built this list missed most of them`);
  for (const [, file] of FILL_GRANDFATHERED) {
    assert.match(file, /^ui\/.*\.(ts|js)$/, `a grandfathered path outside ui/: ${file}`);
  }
});
