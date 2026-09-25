// The OutfitKit floor judges what the HUB paints, not what the module carries — module-toolkit#346.
//
// WHAT WENT WRONG. `checkOutfitkitFloor` compared the WHOLE-package stamp (`dist/outfitkit.json`)
// with the OutfitKit of the oldest hub the module accepts. But the shell only defines the `ok-*` it
// imports itself (`hub/apps/web/src/main.ts`); every other `ok-*` a module bakes is painted by the
// module's OWN copy, and the hub's version is irrelevant for it. Measured on 2026-09-25 with
// whatsapp_inbox 2.1.85 baked against OutfitKit 0.1.89 to pick up the full-width `ok-lightbox`
// (outfitkit#176): `erplora validate` refused it, and the only way out it offered —
// `min_erplora_version 1.1.30` — would have stopped WhatsApp installing on every live hub.
//
// WHAT REPLACES IT, and why it is the market's rule and not a loosening. Android and iOS let you
// COMPILE against the newest SDK; what they check is the API you USE against the oldest SDK you
// declare (lint `NewApi`, `@available`). Same here:
//
//   - `ok-*` the shell does not define → the module's copy paints them → no floor for them at all.
//   - `ok-*` the shell DOES define → the module's code must type-check against the OutfitKit TYPES
//     of the floor hub. Using `DataTableAction.hidden` (0.1.8x) or a function `label` (0.1.59, the
//     sales#259 incident) against a hub that lacks them is a type error, and that is the block.
//
// Only errors the floor INTRODUCES count (diffed against the same program on the baked types), so a
// module's unrelated type noise can neither block nor hide anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SHELL_OUTFITKIT_COMPONENTS,
  bakedOutfitkitComponents,
  checkSharedOutfitkitApi,
  resolveOutfitkitTypes,
} from '../src/validate-outfitkit-api.mjs';
import { checkOutfitkitFloor, HUB_OUTFITKIT, nextHubAfter } from '../src/validate-outfitkit-floor.mjs';

const AHEAD_OF_THE_TABLE = nextHubAfter(HUB_OUTFITKIT.at(-1).outfitkit);

/** A fake `@erplora/outfitkit` package: only the `.d.ts` the checker reads. */
function outfitkitPackage({ dataTable, lightbox }) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-ok-types-'));
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'components', 'ok-data-table'), { recursive: true });
  mkdirSync(join(dist, 'components', 'ok-lightbox'), { recursive: true });
  writeFileSync(
    join(dist, 'index.d.ts'),
    [
      "export { OkDataTable } from './components/ok-data-table/ok-data-table.js';",
      "export type { DataTableAction } from './components/ok-data-table/ok-data-table.js';",
      "export type { OkLightboxItem } from './components/ok-lightbox/ok-lightbox.js';",
      "export { OkLightbox } from './components/ok-lightbox/ok-lightbox.js';",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dist, 'components', 'ok-data-table', 'ok-data-table.d.ts'),
    `export interface DataTableAction { ${dataTable} }\nexport declare class OkDataTable { actions: DataTableAction[]; }\n`,
  );
  writeFileSync(
    join(dist, 'components', 'ok-lightbox', 'ok-lightbox.d.ts'),
    `export interface OkLightboxItem { ${lightbox} }\nexport declare class OkLightbox { items: OkLightboxItem[]; }\n`,
  );
  return root;
}

/** The floor hub's OutfitKit: a table action has a plain `label` and nothing else. */
const FLOOR = () =>
  outfitkitPackage({ dataTable: 'id: string; label: string;', lightbox: 'src: string;' });

/** What the module was baked against: `label` may be a function, `hidden` exists, lightbox zooms. */
const BAKED = () =>
  outfitkitPackage({
    dataTable: 'id: string; label: string | ((row: unknown) => string); hidden?: boolean;',
    lightbox: 'src: string; zoom?: boolean;',
  });

/** A module whose UI is the given sources (path under `ui/` → code). */
function moduleWithUi(files) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-ok-api-'));
  for (const [rel, code] of Object.entries(files)) {
    const file = join(dir, 'ui', rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, code);
  }
  return dir;
}

const IMPORTS = "import type { DataTableAction, OkLightboxItem } from '@erplora/outfitkit';\n";

test('the shell set is the 22 ok-* the hub shell defines, and it carries data-table but not lightbox', () => {
  assert.ok(SHELL_OUTFITKIT_COMPONENTS.includes('ok-data-table'));
  assert.ok(SHELL_OUTFITKIT_COMPONENTS.includes('ok-status-pill'));
  assert.ok(SHELL_OUTFITKIT_COMPONENTS.includes('ok-inline-feedback'));
  assert.ok(
    !SHELL_OUTFITKIT_COMPONENTS.includes('ok-lightbox'),
    'the shell does not import ok-lightbox: the module copy paints it (whatsapp_inbox#225)',
  );
});

test('bakedOutfitkitComponents reads the ok-* a bundle defines, including esbuild-renamed define', () => {
  const esm = [
    'function define(tag, ctor) {}',
    'define("ok-data-table", OkDataTable);',
    'define2("ok-lightbox", OkLightbox);',
    "customElements.define('ok-status-pill', X);",
    'define("erp-whatsapp-inbox-inbox", Inbox);',
    'const s = "ok-close";',
  ].join('\n');
  assert.deepEqual(bakedOutfitkitComponents(esm), ['ok-data-table', 'ok-lightbox', 'ok-status-pill']);
});

test('using only what the floor hub already has on shared components passes', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}export const a: DataTableAction[] = [{ id: 'r', label: 'Refund' }];\n`,
  });
  const result = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.deepEqual(result.problems, []);
});

test('a function label on a shell ok-data-table is refused against a floor without it (sales#259)', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}export const a: DataTableAction[] = [{ id: 'r', label: (row) => String(row) }];\n`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  // One bad line can yield more than one error: without the function type, `row` also loses its
  // contextual type and becomes an implicit `any`. What is pinned is that they are all THAT line.
  assert.ok(problems.length >= 1, JSON.stringify(problems));
  for (const p of problems) assert.match(p, /^ui\/components\/x\/x\.ts:2 — /);
  assert.ok(problems.some((p) => /not assignable to type 'string'/.test(p)), JSON.stringify(problems));
});

test('a property the floor hub does not know is refused (DataTableAction.hidden)', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}export const a: DataTableAction[] = [{ id: 'r', label: 'x', hidden: true }];\n`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /hidden/);
});

test('new API of a component the shell does NOT define is fine: the module copy paints it', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}export const l: OkLightboxItem = { src: 'a.jpg', zoom: true };\n`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.deepEqual(problems, []);
});

test('type errors the module already has, and tests, are not blamed on the floor', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}export const n: number = 'not a number';\n`,
    'components/x/x.test.ts': `${IMPORTS}export const a: DataTableAction = { id: 'r', label: 'x', hidden: true };\n`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.deepEqual(problems, []);
});

// --- Lit property bindings: the API that reaches a shell component WITHOUT a type annotation --------
//
// 11 of the 25 modules with a table bind `.actions=${this.rowActions}` from an UNTYPED getter
// (measured 2026-09-25: appointments, whatsapp_inbox, tickets, reservations…). A tagged template is
// opaque to `tsc`, so a `hidden` (0.1.8x) or a function `label` in that getter reaches a hub that
// lacks them with no type error anywhere. What the floor must judge is the TYPE OF THE EXPRESSION
// bound to the shell element's property, against the floor's declaration of that property.

/** A component class whose `render()` binds `expr` to `.actions` of a shell `ok-data-table`. */
const BOUND_TABLE = (getter) =>
  `${IMPORTS}declare const html: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
export class X {
  private get rowActions() { return ${getter}; }
  render() { return html\`<ok-data-table testid="t" .actions=\${this.rowActions}></ok-data-table>\`; }
}
`;

test('an UNTYPED lit binding that carries a property the floor ok-data-table does not know is refused', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': BOUND_TABLE("[{ id: 'r', label: 'Refund', hidden: () => true }]"),
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /^ui\/components\/x\/x\.ts:5 — /, 'the line of the binding');
  assert.match(problems[0], /ok-data-table/);
  assert.match(problems[0], /'hidden'/);
});

test('an UNTYPED lit binding whose shape the floor cannot take (function label, sales#259) is refused', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': BOUND_TABLE("[{ id: 'r', label: (row: unknown) => String(row) }]"),
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /^ui\/components\/x\/x\.ts:5 — /);
  assert.match(problems[0], /ok-data-table.*\.actions/);
});

test('a key of the module\'s own that NO OutfitKit knows is not blamed on the floor', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': BOUND_TABLE("[{ id: 'r', label: 'Refund', testid: 'refund-row' }]"),
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.deepEqual(problems, []);
});

test('an UNTYPED lit binding on a component the shell does NOT define is not judged (module copy paints it)', () => {
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `${IMPORTS}declare const html: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
export class X {
  render() { return html\`<ok-lightbox .items=\${[{ src: 'a.jpg', zoom: true }]}></ok-lightbox>\`; }
}
`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.deepEqual(problems, []);
});

test('a module that never imports the package index (side-effect imports only) is judged all the same', () => {
  // Without an `import … from '@erplora/outfitkit'` the index is not in the program by itself, and
  // the shell classes would be unknown: the binding on the table would be skipped, unjudged.
  const moduleDir = moduleWithUi({
    'components/x/x.ts': `declare const html: (s: TemplateStringsArray, ...v: unknown[]) => unknown;
export class X {
  private get rowActions() { return [{ id: 'r', label: 'Refund', hidden: () => true }]; }
  render() { return html\`<ok-data-table .actions=\${this.rowActions}></ok-data-table>\`; }
}
`,
  });
  const { problems } = checkSharedOutfitkitApi({ moduleDir, bakedDir: BAKED(), floorDir: FLOOR() });
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.match(problems[0], /'hidden'/);
});

// --- The gate itself (`checkOutfitkitFloor`) ------------------------------------------------------

let fixtures = 0;

/** A module with a stamp, a bundle defining `defines`, and an optional declared floor. */
function bakedModule({ stamp, defines, compatibility }) {
  fixtures += 1;
  const id = `ok_api_fixture_${fixtures}`;
  const dir = join(mkdtempSync(join(tmpdir(), 'erplora-ok-api-gate-')), id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const manifest = { id, name: 'OK api fixture', version: '1.0.0' };
  if (compatibility) manifest.compatibility = compatibility;
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'dist', 'outfitkit.json'), JSON.stringify({ outfitkit: stamp }));
  if (defines) {
    writeFileSync(
      join(dir, 'dist', `${id}.esm.js`),
      defines.map((tag) => `define("${tag}", class {});`).join('\n'),
    );
  }
  return { dir, manifest };
}

/** An `apiCheck` double that records its calls and answers `answer`. */
function spyCheck(answer) {
  const calls = [];
  const fn = (args) => {
    calls.push(args);
    return answer;
  };
  fn.calls = calls;
  return fn;
}

test('whatsapp_inbox#225: a bake whose only NEW component is module-only no longer blocks the floor', () => {
  // The real shape: the inbox bakes three shell components plus ok-lightbox, declares 1.1.22
  // (OutfitKit 0.1.72) and was baked against 0.1.89. The shell components still have to pass the
  // type check against the floor; with them clean, nothing blocks.
  const { dir, manifest } = bakedModule({
    stamp: '0.1.89',
    defines: ['ok-data-table', 'ok-inline-feedback', 'ok-lightbox', 'ok-status-pill'],
    compatibility: { min_erplora_version: '1.1.22' },
  });
  const apiCheck = spyCheck({ ran: true, problems: [] });
  const result = checkOutfitkitFloor(dir, manifest, { publishing: true, apiCheck });
  assert.deepEqual(result.errors, []);
  assert.equal(apiCheck.calls.length, 1);
  assert.equal(apiCheck.calls[0].floor, '0.1.72', 'judged against the declared floor hub');
  assert.equal(apiCheck.calls[0].baked, '0.1.89');
  assert.deepEqual(apiCheck.calls[0].shared, ['ok-data-table', 'ok-inline-feedback', 'ok-status-pill']);
});

test('a bundle with NO shell component is not judged against the hub at all', () => {
  const { dir, manifest } = bakedModule({
    stamp: '0.1.89',
    defines: ['ok-lightbox'],
    compatibility: { min_erplora_version: '1.1.22' },
  });
  const apiCheck = spyCheck({ ran: true, problems: ['should not be asked'] });
  const result = checkOutfitkitFloor(dir, manifest, { publishing: true, apiCheck });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(apiCheck.calls.length, 0, 'nothing the hub paints, nothing to type-check');
});

test('a shell component used beyond the floor still BLOCKS, naming the line', () => {
  const { dir, manifest } = bakedModule({
    stamp: '0.1.89',
    defines: ['ok-data-table', 'ok-lightbox'],
    compatibility: { min_erplora_version: '1.1.22' },
  });
  const problem = "ui/components/x/x.ts:7 — 'hidden' does not exist in type 'DataTableAction'";
  const apiCheck = spyCheck({ ran: true, problems: [problem] });
  const { errors } = checkOutfitkitFloor(dir, manifest, { apiCheck });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0].includes(problem), errors[0]);
  assert.match(errors[0], /ok-data-table/);
  assert.match(errors[0], /min_erplora_version/, 'the way out is still offered');
});

test('when the type check cannot run, the gate falls back to the whole-package rule and says why', () => {
  const { dir, manifest } = bakedModule({
    stamp: '0.1.89',
    defines: ['ok-data-table', 'ok-lightbox'],
    compatibility: { min_erplora_version: '1.1.22' },
  });
  const apiCheck = spyCheck({ ran: false, reason: 'npm pack @erplora/outfitkit@0.1.72 failed: offline' });
  const { errors } = checkOutfitkitFloor(dir, manifest, { apiCheck });
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /0\.1\.89/);
  assert.match(errors[0], /offline/, 'a degraded check says it degraded');
});

test('a bundle whose ok-* cannot be read keeps the whole-package rule (no esm → unchanged)', () => {
  const { dir, manifest } = bakedModule({
    stamp: '0.1.89',
    compatibility: { min_erplora_version: '1.1.22' },
  });
  const apiCheck = spyCheck({ ran: true, problems: [] });
  const { errors } = checkOutfitkitFloor(dir, manifest, { apiCheck });
  assert.equal(errors.length, 1);
  assert.equal(apiCheck.calls.length, 0);
});

test('no declared floor + publishing: clean shell usage passes, and is judged against the NEWEST hub', () => {
  const { dir, manifest } = bakedModule({
    stamp: AHEAD_OF_THE_TABLE,
    defines: ['ok-data-table', 'ok-lightbox'],
  });
  const apiCheck = spyCheck({ ran: true, problems: [] });
  const result = checkOutfitkitFloor(dir, manifest, { publishing: true, apiCheck });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(apiCheck.calls[0].floor, HUB_OUTFITKIT.at(-1).outfitkit);
});

test('no declared floor: a shell component used beyond every hub WARNS on validate and BLOCKS on pack', () => {
  const { dir, manifest } = bakedModule({
    stamp: AHEAD_OF_THE_TABLE,
    defines: ['ok-data-table'],
  });
  const apiCheck = spyCheck({ ran: true, problems: ['ui/a.ts:3 — nope'] });
  const onValidate = checkOutfitkitFloor(dir, manifest, { apiCheck });
  assert.deepEqual(onValidate.errors, []);
  assert.equal(onValidate.warnings.length, 1);
  assert.ok(onValidate.warnings[0].includes('ui/a.ts:3 — nope'));
  const onPack = checkOutfitkitFloor(dir, manifest, { publishing: true, apiCheck });
  assert.equal(onPack.errors.length, 1);
  assert.ok(onPack.errors[0].includes('ui/a.ts:3 — nope'));
});

test('resolveOutfitkitTypes serves a cached package without touching the network', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'erplora-ok-cache-'));
  const pkg = join(cacheRoot, '0.1.72', 'package');
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'dist', 'index.d.ts'), 'export {};\n');
  // A local checkout claiming the same version must NOT win over the cache.
  const localDir = mkdtempSync(join(tmpdir(), 'erplora-ok-local-'));
  mkdirSync(join(localDir, 'dist'), { recursive: true });
  writeFileSync(join(localDir, 'package.json'), JSON.stringify({ version: '0.1.72' }));
  writeFileSync(join(localDir, 'dist', 'index.d.ts'), 'export {};\n');
  assert.deepEqual(resolveOutfitkitTypes('0.1.72', { cacheRoot, localDir }), { dir: pkg });
});

test('resolveOutfitkitTypes refuses something that is not a version, before running npm', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'erplora-ok-cache-'));
  for (const bad of ['latest', '0.1', '../0.1.72', '0.1.72; rm -rf /', undefined]) {
    const got = resolveOutfitkitTypes(bad, { cacheRoot });
    assert.ok(got.error, `${bad} should be refused`);
    assert.equal(got.dir, undefined);
  }
});

test('resolveOutfitkitTypes names the npm failure even when npm left stderr EMPTY (timeout)', () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'erplora-ok-cache-'));
  const pack = () => {
    const err = new Error('spawnSync npm ETIMEDOUT');
    err.stderr = Buffer.alloc(0); // an empty Buffer is truthy: `err.stderr || err.message` printed "()"
    throw err;
  };
  const got = resolveOutfitkitTypes('0.1.72', { cacheRoot, localDir: join(cacheRoot, 'nowhere'), pack });
  assert.match(got.error, /ETIMEDOUT/, got.error);
});
