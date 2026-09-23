// `color=` on an Ionic element inside a module's shadow root paints nothing — module-toolkit#273.
// `node --test`.
//
// WHY THIS EXISTS. Ionic implements `color=` in two halves. The component adds
// `.ion-color .ion-color-<name>` to its host and paints from `--ion-color-base`; the VALUE of
// `--ion-color-base` comes from a GLOBAL rule in `@ionic/core/css/core.css`:
//
//     .ion-color-danger { --ion-color-base: var(--ion-color-danger, #c5000f) !important; … }
//
// Document stylesheets do not match elements inside a shadow tree, and every screen of a module is
// a Lit Web Component with its own shadow root. The class is added, the rule never applies, and a
// solid `ion-button` / `ion-badge` / `ion-chip` resolves to a TRANSPARENT background with white
// text: an invisible action. On `fill="outline|clear"`, `ion-icon`, `ion-note`, `ion-text` the
// colour just falls back to the inherited one. It shipped twice on primary actions (kitchen#42 —
// the KDS «Ready» button; cash_register#90 — «Close session») and each time only that button was
// fixed. On 2026-09-18 there were 89 of them in 17 published modules.
//
// The fix that DOES cross the boundary: drop `color=` and set the element's custom properties from
// the theme tokens in the component's own styles (`--background: var(--ion-color-danger)`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COLOR_GRANDFATHERED,
  checkIonicColor,
  ionTagsWithDeadColor,
} from '../src/validate-ionic-color.mjs';
import { validate } from '../src/validate.mjs';
import { writeContractsFile } from '../src/contracts.mjs';

/** A throwaway module directory: `files` = { relative path → contents }. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-ioniccolor-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return { dir, manifest: { id, name: 'Demo', version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const DEAD = '<ion-button color="danger">x</ion-button>';

// ── The premise: this guard has a cause, and must not outlive it ─────────────────────

test('Ionic paints a coloured element from --ion-color-base, which only a GLOBAL class sets', () => {
  // Pinned to the dependency itself, not to a snapshot of it. The day Ionic sets the colour on the
  // host (or stops reading --ion-color-base), this fails and says the guard can go.
  const require = createRequire(import.meta.url);
  const core = dirname(require.resolve('@ionic/core/package.json'));
  const button = readFileSync(join(core, 'dist/collection/components/button/button.ios.css'), 'utf8');
  const global = readFileSync(join(core, 'css/core.css'), 'utf8');

  assert.match(
    button.replace(/\s+/g, ' '),
    /:host\(\.button-solid\.ion-color\) \.button-native \{ background: var\(--ion-color-base\)/,
    'a solid coloured button no longer takes its background from --ion-color-base',
  );
  assert.doesNotMatch(button, /--ion-color-base\s*:/, 'the button now sets --ion-color-base itself: the guard is dead weight — delete it');
  assert.match(global, /\.ion-color-danger\s*\{\s*--ion-color-base\s*:/, 'the global .ion-color-* class no longer carries the colour');
});

// ── Reading a Lit tag ─────────────────────────────────────────────────────────────────

test('FAILS: color= after an arrow function is still seen — the tag does not end at its `>`', () => {
  const dead = ionTagsWithDeadColor('<ion-button @click=${() => this.count > 1 && this.go()} color="danger">x</ion-button>');
  assert.equal(dead.length, 1, JSON.stringify(dead));
  assert.match(dead[0].tag, /color="danger"/);
});

test('FAILS: the multi-line, dynamic shape of kitchen pos-fire', () => {
  // Verbatim shape from `kitchen/ui/components/erp-kitchen-pos-fire`: the one a single-line grep missed.
  const src = [
    'html`<ion-button',
    '  size="small"',
    "  fill=${urgent ? 'solid' : 'outline'}",
    "  color=${urgent ? 'danger' : 'medium'}",
    '  @click=${() => this.toggle()}',
    '>${t(\'ui.urgent\')}</ion-button>`',
  ].join('\n');
  const dead = ionTagsWithDeadColor(src);
  assert.equal(dead.length, 1, JSON.stringify(dead));
  assert.equal(dead[0].line, 1, 'reported at the line where the element OPENS');
});

test('FAILS: the property binding `.color=${…}` and any ion-* element', () => {
  const src = [
    '<ion-badge\n  .color=${this.tone}>y</ion-badge>',
    "<ion-icon name='x' color='warning'></ion-icon>",
    '<ion-note color=${c}></ion-note>',
    '<ion-chip color="success" />',
  ].join('\n');
  assert.equal(ionTagsWithDeadColor(src).length, 4);
});

test('PASSES: what is not the attribute — style, data-*, CSS tokens, non-Ionic tags', () => {
  const src = [
    '<ion-icon style="color: var(--ion-color-warning)"></ion-icon>',
    '<ion-chip data-color="x" @click=${() => ({ a: 1 })}>z</ion-chip>',
    '<ion-button class="danger">x</ion-button>',
    '<ok-status-badge color="danger"></ok-status-badge>',
    '<div color="red"></div>',
    '<ion-button @click=${() => this.set({ color: "red" })}>x</ion-button>',
    // Inside another attribute's VALUE — a quoted string or a `${…}` — `color=` is text, not the attribute.
    '<ion-input helper-text="use color=hex for custom" placeholder=${t(\'ui.x\')}></ion-input>',
    '<ion-button @click=${() => go(`?view=list&amp; color=${c}`)}>x</ion-button>',
  ].join('\n');
  assert.deepEqual(ionTagsWithDeadColor(src), []);
});

// ── The whole door: a module directory ───────────────────────────────────────────────

test('checkIonicColor: reports the offenders of `ui/`, with file, line and the fix', () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`${DEAD}\`;\n` });
  const { errors } = checkIonicColor(m.dir, m.manifest);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /ui\/components\/erp-demo\/erp-demo\.ts/);
  assert.match(errors[0], /L1:/);
  assert.match(errors[0], /--background/, 'the error has to say how to fix it');
  m.clean();
});

test('checkIonicColor: a clean module, one with no `ui/`, and build output say nothing', () => {
  const clean = mod({ 'ui/components/erp-demo/erp-demo.ts': '<ion-button class="danger">x</ion-button>' });
  assert.deepEqual(checkIonicColor(clean.dir, clean.manifest), { errors: [], warnings: [] });
  clean.clean();
  const none = mod({ 'module.json': '{}' });
  assert.deepEqual(checkIonicColor(none.dir, none.manifest), { errors: [], warnings: [] });
  none.clean();
  const built = mod({ 'ui/dist/demo.esm.js': DEAD, 'ui/node_modules/x/i.js': DEAD, 'dist/demo.esm.js': DEAD });
  assert.deepEqual(checkIonicColor(built.dir, built.manifest).errors, []);
  built.clean();
});

test('checkIonicColor: a test file is not what ships — it may quote the offence', () => {
  // The module's own source guard (cash_register#90) carries `color="danger"` inside its fixtures.
  const m = mod({ 'ui/lib/ionic-color.test.ts': `const tpl = '${DEAD}';` });
  assert.deepEqual(checkIonicColor(m.dir, m.manifest).errors, []);
  m.clean();
});

// ── Gradualness: the ratchet ─────────────────────────────────────────────────────────

test('a grandfathered file keeps passing with what it had — and NOT with one more', () => {
  const [id, file, allowed] = COLOR_GRANDFATHERED[0];
  const byModule = Object.fromEntries(
    COLOR_GRANDFATHERED.filter(([m]) => m === id).map(([, f, n]) => [f, Array(n).fill(DEAD).join('\n')]),
  );
  const asIs = mod(byModule, id);
  assert.deepEqual(checkIonicColor(asIs.dir, asIs.manifest), { errors: [], warnings: [] }, 'what is published today still passes');
  asIs.clean();

  const worse = mod({ ...byModule, [file]: Array(allowed + 1).fill(DEAD).join('\n') }, id);
  const { errors } = checkIonicColor(worse.dir, worse.manifest);
  assert.equal(errors.length, 1, 'one more in a grandfathered file is a NEW offence');
  assert.match(errors[0], new RegExp(`${allowed} venían de antes`));
  worse.clean();
});

test('the pass is per FILE: a new component of a grandfathered module inherits nothing', () => {
  const [id] = COLOR_GRANDFATHERED[0];
  const byModule = Object.fromEntries(
    COLOR_GRANDFATHERED.filter(([m]) => m === id).map(([, f, n]) => [f, Array(n).fill(DEAD).join('\n')]),
  );
  const m = mod({ ...byModule, 'ui/components/erp-brand-new/erp-brand-new.ts': DEAD }, id);
  const { errors } = checkIonicColor(m.dir, m.manifest);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /erp-brand-new/);
  m.clean();
});

test('FAILS: an entry that outlived its file — clean, or gone — is an open door', () => {
  const [id, file] = COLOR_GRANDFATHERED[0];
  const cleaned = mod({ [file]: '<ion-button class="danger">x</ion-button>' }, id);
  const stale = checkIonicColor(cleaned.dir, cleaned.manifest).errors.filter((e) => e.startsWith(file));
  assert.equal(stale.length, 1, JSON.stringify(stale));
  assert.match(stale[0], /COLOR_GRANDFATHERED/);
  assert.match(stale[0], /pm#392/, "and where the sweep is tracked");
  cleaned.clean();

  const gone = mod({ 'ui/components/erp-other/erp-other.ts': '<ion-button>x</ion-button>' }, id);
  assert.ok(checkIonicColor(gone.dir, gone.manifest).errors.some((e) => e.startsWith(file)), 'a deleted file keeps no allowance');
  gone.clean();
});

test('WARNS (does not fail): a file cleaner than its allowance but not clean yet', () => {
  const entry = COLOR_GRANDFATHERED.find(([, , n]) => n > 1);
  assert.ok(entry, 'this test needs an entry with room to shrink');
  const [id, file] = entry;
  const byModule = Object.fromEntries(
    COLOR_GRANDFATHERED.filter(([m]) => m === id).map(([, f, n]) => [f, Array(n).fill(DEAD).join('\n')]),
  );
  const m = mod({ ...byModule, [file]: DEAD }, id);
  const { errors, warnings } = checkIonicColor(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /1 de los \d+/);
  m.clean();
});

test('a module that ships no `ui/` is warned, never blocked, for somebody else\'s allowance', () => {
  // module-toolkit#189: reusing a published id must not inherit a red gate.
  const [id] = COLOR_GRANDFATHERED[0];
  const owed = COLOR_GRANDFATHERED.filter(([m]) => m === id).length;
  const m = mod({ 'module.json': '{}' }, id);
  const { errors, warnings } = checkIonicColor(m.dir, m.manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, owed);
  m.clean();
});

test('an exact allowance is silent for EVERY module still owing', () => {
  const byModule = new Map();
  for (const [id, file, n] of COLOR_GRANDFATHERED) {
    if (!byModule.has(id)) byModule.set(id, {});
    byModule.get(id)[file] = Array(n).fill(DEAD).join('\n');
  }
  for (const [id, files] of byModule) {
    const m = mod(files, id);
    assert.deepEqual(checkIonicColor(m.dir, m.manifest), { errors: [], warnings: [] }, `${id} is at its allowance`);
    m.clean();
  }
});

test('the grandfathered list may only SHRINK, and every entry is well-formed', () => {
  // The two ceilings ARE the ratchet: they come down with every file the sweep finishes, never up.
  const total = COLOR_GRANDFATHERED.reduce((n, [, , c]) => n + c, 0);
  assert.ok(
    COLOR_GRANDFATHERED.length <= 14 && total <= 40,
    `the list GREW (${COLOR_GRANDFATHERED.length} files / ${total} uses). Nothing gets added: the sweep empties it.`,
  );
  const seen = new Set();
  for (const entry of COLOR_GRANDFATHERED) {
    assert.equal(entry.length, 3, `bad entry: ${JSON.stringify(entry)}`);
    assert.ok(entry[2] > 0, `a zero allowance is a leftover: ${entry[1]}`);
    assert.match(entry[1], /^ui\/.*\.(ts|js)$/, `a path outside ui/: ${entry[1]}`);
    assert.ok(!seen.has(`${entry[0]}:${entry[1]}`), `duplicated entry: ${entry[1]}`);
    seen.add(`${entry[0]}:${entry[1]}`);
  }
});

test('cash_register, swept by cash_register#90, is not in the list and stays out', () => {
  assert.ok(!COLOR_GRANDFATHERED.some(([id]) => id === 'cash_register'));
});

// ── Through the REAL door: the function proves nothing if `erplora validate` does not run it ──

test('`erplora validate` REJECTS a module whose component colours an ion-button with color=', async () => {
  const m = mod({ 'ui/components/erp-demo/erp-demo.ts': `export const tpl = html\`${DEAD}\`;\n` });
  writeFileSync(join(m.dir, 'module.json'), JSON.stringify(m.manifest));
  writeContractsFile(m.dir, m.manifest);
  try {
    await assert.rejects(() => validate(m.dir), /module-toolkit#273[\s\S]*erp-demo\.ts/);
  } finally {
    m.clean();
  }
});
