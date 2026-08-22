// The module's TypeScript batteries — the half of `erplora test` that did not exist
// (module-toolkit#74).
//
// 210 `.test.ts` files across the 25 module repos, and the gate ran ZERO of them: `erplora test`
// recognised `tests/**/*.test.py|.sh` and nothing else, so every check written for a Web Component
// — which is where nearly all of the screen logic lives — was invisible. Written, passing on the
// author's machine, and breaking one merged GREEN. It is the same hole as #50 and #55, one family
// of tests further along.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  TS_TEST_GLOBS,
  discoverTsTests,
  strayTsTests,
  bareImports,
  missingPackages,
  resolveVitest,
  runTsTests,
} from '../src/run-vitest.mjs';

/** A throwaway module tree: `{ 'ui/lib/a.test.ts': '…' }` → a directory with those files. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-run-vitest-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Puts an empty package where node would look for it. `happy-dom` is in almost every fixture
 * because vitest loads it for `environment`, so a module without it is reported as unrunnable —
 * which is right, and would otherwise mask what each of these cases is actually about.
 */
function stub(dir, ...packages) {
  for (const pkg of packages) {
    mkdirSync(join(dir, 'node_modules', pkg), { recursive: true });
    writeFileSync(join(dir, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg }));
  }
}

// ── discovery ────────────────────────────────────────────────────────────────────────────────

test('finds every `ui/**/*.test.ts`, at any depth, sorted and relative', () => {
  const m = mod({
    'ui/lib/quantity.test.ts': '',
    'ui/components/erp-demo-list/erp-demo-list.test.ts': '',
    'ui/lib/quantity.ts': '',
    'ui/components/erp-demo-list/erp-demo-list.ts': '',
  });
  assert.deepEqual(discoverTsTests(m.dir), [
    'ui/components/erp-demo-list/erp-demo-list.test.ts',
    'ui/lib/quantity.test.ts',
  ]);
  m.clean();
});

test('a module with no TypeScript test is not a finding — it is just a module without them', () => {
  const m = mod({ 'ui/lib/quantity.ts': '' });
  assert.deepEqual(discoverTsTests(m.dir), []);
  assert.deepEqual(strayTsTests(m.dir), []);
  m.clean();
});

test('build output and somebody else\'s code are never tests', () => {
  // `dist/` is committed in the module repos and carries the bundled `.d.ts`/sources; a checkout
  // shared with the fleet also holds `.wt-*` worktrees, each a FULL copy of `ui/`. Reading either
  // would run the same file two or three times — and report a stray for every one of them.
  const m = mod({
    'ui/lib/a.test.ts': '',
    'dist/a.test.ts': '',
    'node_modules/pkg/b.test.ts': '',
    '.wt-something/ui/lib/a.test.ts': '',
  });
  assert.deepEqual(discoverTsTests(m.dir), ['ui/lib/a.test.ts']);
  assert.deepEqual(strayTsTests(m.dir), []);
  m.clean();
});

// ── the net the other way round: a test NOBODY would run ──────────────────────────────────────

test('a `.test.ts` outside the patterns is reported — invisible, not absent', () => {
  // The whole reason this file exists. Widening the pattern fixes the 210 files that exist today;
  // it does not stop the 211th from being born somewhere nothing looks.
  const m = mod({ 'ui/lib/a.test.ts': '', 'src/helpers.test.ts': '' });
  assert.deepEqual(strayTsTests(m.dir), ['src/helpers.test.ts']);
  m.clean();
});

test('`.spec.ts` counts too — the other spelling vitest answers to by default', () => {
  const m = mod({ 'ui/lib/a.spec.ts': '' });
  assert.deepEqual(discoverTsTests(m.dir), [], 'the gate\'s pattern is `.test.ts`');
  assert.deepEqual(strayTsTests(m.dir), ['ui/lib/a.spec.ts'], 'and it must not vanish');
  m.clean();
});

test('the globs the gate runs are the ones it reports', () => {
  assert.deepEqual(TS_TEST_GLOBS, ['ui/**/*.test.ts']);
});

// ── the environment: what the tests need in order to run at all ───────────────────────────────

test('bare imports are collected from the sources, not from package.json', () => {
  const m = mod({
    'ui/lib/a.test.ts': "import { x } from './a';\nimport { y } from '@erplora/module-sdk';\n",
    'ui/lib/a.ts': "import 'lit';\nimport '@erplora/outfitkit/ok-data-table';\nimport 'node:path';\n",
  });
  assert.deepEqual(bareImports(m.dir), ['@erplora/module-sdk', '@erplora/outfitkit', 'lit']);
  m.clean();
});

test('a package that does not resolve is NAMED, never guessed around', () => {
  const m = mod({ 'ui/lib/a.test.ts': "import '@erplora/module-sdk';\n" });
  stub(m.dir, 'happy-dom');
  assert.deepEqual(missingPackages(m.dir), ['@erplora/module-sdk']);
  m.clean();
});

// ── running them ──────────────────────────────────────────────────────────────────────────────

test('without a vitest at hand the tests are NOT RUN — named, never counted as green', () => {
  const m = mod({ 'ui/lib/a.test.ts': '' });
  const { results, errors, notRun } = runTsTests(m.dir, { vitest: null });
  assert.deepEqual(results, []);
  assert.deepEqual(errors, []);
  assert.equal(notRun.length, 1);
  assert.match(notRun[0], /vitest/);
  assert.match(notRun[0], /1/, 'says how many are not being run');
  m.clean();
});

test('with a package missing they are NOT RUN either, and the package is named', () => {
  const m = mod({ 'ui/lib/a.test.ts': "import '@erplora/module-sdk';\n" });
  stub(m.dir, 'happy-dom');
  const { errors, notRun } = runTsTests(m.dir, { vitest: '/nowhere/vitest.mjs' });
  assert.deepEqual(errors, []);
  assert.equal(notRun.length, 1);
  assert.match(notRun[0], /@erplora\/module-sdk/);
  m.clean();
});

test('a red TypeScript test FAILS the gate', () => {
  // The runner is spawned for real, with a stand-in for vitest: what is asserted here is the
  // contract — a non-zero exit is a failure of the module, with the output attached — not vitest's
  // own behaviour.
  const fake = mkdtempSync(join(tmpdir(), 'erplora-fake-vitest-'));
  const bin = join(fake, 'vitest.mjs');
  writeFileSync(bin, "console.log('FAIL ui/lib/a.test.ts');\nprocess.exit(1);\n");
  const m = mod({ 'ui/lib/a.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const { errors } = runTsTests(m.dir, { vitest: bin });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ui\/lib\/a\.test\.ts/);
  rmSync(fake, { recursive: true, force: true });
  m.clean();
});

test('a green run reports the files it ran', () => {
  const fake = mkdtempSync(join(tmpdir(), 'erplora-fake-vitest-'));
  const bin = join(fake, 'vitest.mjs');
  writeFileSync(bin, "process.exit(0);\n");
  const m = mod({ 'ui/lib/a.test.ts': '', 'ui/lib/b.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const { results, errors, notRun } = runTsTests(m.dir, { vitest: bin });
  assert.deepEqual(errors, []);
  assert.deepEqual(notRun, []);
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.file).sort(), ['ui/lib/a.test.ts', 'ui/lib/b.test.ts']);
  assert.ok(results.every((r) => r.ran));
  m.clean();
});

test('vitest is invoked with the toolkit\'s config, in the module directory', () => {
  // ONE rule, and it lives here. 23 of the 25 modules carry no `vitest.config.ts` at all, so
  // leaving the choice to vitest's defaults would run them in the `node` environment — where a
  // Web Component test cannot even mount — and the two that DO carry one could quietly narrow
  // their own `include`. The gate runs what the gate says it runs.
  const fake = mkdtempSync(join(tmpdir(), 'erplora-fake-vitest-'));
  const bin = join(fake, 'vitest.mjs');
  writeFileSync(
    bin,
    "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n",
  );
  const m = mod({ 'ui/lib/a.test.ts': '' });
  stub(m.dir, 'happy-dom');
  const { results } = runTsTests(m.dir, { vitest: bin });
  const seen = JSON.parse(results[0].output);
  assert.equal(seen.argv[0], 'run');
  assert.ok(
    seen.argv.some((a) => a === '--config'),
    `the config is passed explicitly: ${seen.argv.join(' ')}`,
  );
  rmSync(fake, { recursive: true, force: true });
  m.clean();
});

// ── the config the gate hands to vitest ───────────────────────────────────────────────────────

test('the config runs exactly what `--list` promises', async () => {
  const cfg = (await import('../src/vitest.module.config.mjs')).default;
  assert.deepEqual(cfg.test.include, TS_TEST_GLOBS, 'listing one set and running another IS the bug');
  assert.equal(cfg.test.environment, 'happy-dom', 'a Web Component cannot mount under `node`');
});

test('the config imports NOTHING — it is loaded from outside the module', async () => {
  // 🔴 Measured, not assumed: with `import { defineConfig } from 'vitest/config'` at the top, this
  // file is resolved relative to the TOOLKIT, and on a runner — where vitest lives next to the
  // module and not next to the toolkit — vitest dies with «Cannot find package 'vitest'» before
  // collecting a single test. A plain object needs no import and works from any directory.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const source = readFileSync(fileURLToPath(new URL('../src/vitest.module.config.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /^\s*(?:import|require)\b/m, source.slice(0, 200));
});

test('una ruta RELATIVA resuelve igual — el gate llama `erplora test .`', () => {
  // 🔴 Reproducido antes de arreglarlo: `createRequire` EXIGE una ruta absoluta o un file URL, así
  // que con `dir = '.'` no resolvía nada y los 210 tests salían como «no hay vitest al alcance» —
  // un aviso perfectamente redactado que mentía, en la única forma de llamar que usa el gate.
  const m = mod({ 'ui/lib/a.test.ts': '' });
  mkdirSync(join(m.dir, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(m.dir, 'node_modules', 'vitest', 'package.json'), '{"name":"vitest"}');
  writeFileSync(join(m.dir, 'node_modules', 'vitest', 'vitest.mjs'), '');
  const cwd = process.cwd();
  try {
    process.chdir(m.dir);
    // `process.cwd()` and not `m.dir`: on macOS the temp dir is reached through the `/var` symlink
    // and comes back resolved as `/private/var`.
    assert.equal(resolveVitest('.', {}), join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs'));
  } finally {
    process.chdir(cwd);
  }
  m.clean();
});

test('un paquete con `exports` cerrado SIGUE estando instalado', () => {
  // 🔴 Reproducido contra el real: `@erplora/outfitkit` declara un mapa `exports` con subrutas
  // (`./ok-data-table`) y sin `"."` ni `"./package.json"`, así que `require.resolve` lo da por
  // AUSENTE — y con él los 8 tests de `taxes`, que vitest resuelve sin problema. Preguntar por el
  // fichero es lo que hace que la respuesta sea «está instalado», no «yo sé importarlo».
  const m = mod({ 'ui/lib/a.test.ts': "import '@erplora/outfitkit/ok-data-table';\n" });
  stub(m.dir, 'happy-dom');
  const pkg = join(m.dir, 'node_modules', '@erplora', 'outfitkit');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@erplora/outfitkit', exports: { './ok-data-table': './x.js' } }),
  );
  assert.deepEqual(missingPackages(m.dir), []);
  m.clean();
});

test('el paquete se busca hacia ARRIBA, como hace node', () => {
  // En el workspace de desarrollo `vitest` y `lit` viven en la raíz, no en `modules/<id>`.
  const m = mod({ 'inner/module.json': '{}', 'inner/ui/lib/a.test.ts': "import 'lit';\n" });
  stub(m.dir, 'lit', 'happy-dom');
  assert.deepEqual(missingPackages(join(m.dir, 'inner')), []);
  m.clean();
});

test('the config carries the tsconfig a module repo does NOT ship', async () => {
  // 🔴 Reproducido en un checkout LIMPIO del módulo — que es lo que ve el runner. 22 de los 25 no
  // llevan `tsconfig.json`: sin él `@state() customerId = ''` es un error de sintaxis (96 tests de
  // `appointments` en rojo por el decorador, no por su lógica) y, una vez compila, Lit lanza «will
  // not trigger updates … set using class fields» porque el campo nativo pisa el accessor. Y los 3
  // que SÍ lo llevan hacen `extends: '../../tsconfig.json'`, una ruta que fuera del workspace de
  // desarrollo no existe: el transform muere y `flows` recoge CERO de sus 26 ficheros.
  // El toolkit ES el envoltorio que provee las deps y el tsconfig — lo dice su propio package.json.
  const cfg = (await import('../src/vitest.module.config.mjs')).default;
  const co = cfg.oxc.tsconfig.compilerOptions;
  assert.equal(co.experimentalDecorators, true, 'Lit `@state()`/`@property()` son decoradores legacy');
  assert.equal(co.useDefineForClassFields, false, 'con `true`, el campo pisa el accessor del decorador');
});

test('`happy-dom` cuenta aunque NADIE lo importe — lo pide el entorno, no el código', () => {
  // No aparece en ningún `import` de los 25 módulos: lo carga vitest por `environment`. Sin él el
  // fallo es un arranque críptico del entorno, no «falta un paquete», así que se comprueba igual.
  const m = mod({ 'ui/lib/a.test.ts': "import { it } from 'vitest';\n" });
  stub(m.dir, 'vitest');
  assert.deepEqual(missingPackages(m.dir), ['happy-dom']);
  m.clean();
});

test('un `require.resolve(…)` también es un paquete que hace falta', () => {
  // 🔴 Encontrado midiendo, no razonando: `ui/lib/ionic-fill-needs-md.test.ts` —el espejo de
  // hub#760 que llevan `inventory`, `pricing` y `staff`— lee el CSS de Ionic con
  // `require.resolve('@ionic/core/package.json')`. Es la única referencia a ese paquete en los 25
  // módulos y no es un `import`, así que un escáner que solo mire imports lo da por innecesario, y
  // los tres módulos salen en ROJO con «Cannot find module» en vez de declararse SIN CORRER.
  const m = mod({ 'ui/lib/fill.test.ts': "const c = require.resolve('@ionic/core/package.json');\n" });
  assert.ok(bareImports(m.dir).includes('@ionic/core'), bareImports(m.dir).join(','));
  m.clean();
});

test('un `import()` dinámico cuenta igual', () => {
  const m = mod({ 'ui/lib/a.test.ts': "const x = await import('@erplora/module-sdk');\n" });
  assert.ok(bareImports(m.dir).includes('@erplora/module-sdk'));
  m.clean();
});
