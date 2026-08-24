// The module's TypeScript batteries — its Web Component tests — run by the shared gate
// (module-toolkit#74).
//
// WHAT THIS SOLVES. `erplora test` discovered `tests/**/*.test.py|.sh` and stopped there, so the
// gate of the 25 module repos ran ZERO TypeScript tests: 210 `.test.ts` files under `ui/`, where
// nearly all of the screen logic lives, written and passing locally and INVISIBLE to CI. Breaking
// one merged green. It surfaced the way these things always do — a red test in `sales` that three
// merged pull requests had walked straight past — and the file it was hiding is worth naming: a
// check that compares UTC against local time, so it turns red on its own every night between
// 00:00 and 02:00 CEST. Nobody found out, because nothing ran it.
//
// This is the same shape as #50 (the batteries nobody ran) and #55 (the batteries the pattern did
// not recognise), one family of tests further along. The rules are therefore the same three:
//
//   1. discovery lives HERE, once, and `--list` reports exactly what will run — the gate does not
//      re-implement it in YAML (that is how #55 happened);
//   2. a `.test.ts` no pattern picks up FAILS the gate by name. A test nobody runs is worse than
//      no test: it buys the confidence without doing the check;
//   3. what does not run is NAMED, never counted as green. A missing package is reported as
//      «not run», exactly like a Postgres battery without its container.
//
// 🔴 (3) NO LONGER HAS AN EXCEPTION, and the history is worth keeping because the exception was
// RIGHT while it lasted. Running these needs `vitest`, `happy-dom`, `lit`, `@ionic/core`,
// `@erplora/outfitkit` — all public — AND `@erplora/module-sdk`, which is
// `ERPlora/hub/packages/module-sdk`: a PRIVATE repository, not published to npm. Without it vitest
// does not say «a package is missing», it reports a resolution error PER FILE — 6 of the 8 of
// `taxes`, 51 of the 53 of `sales` — which reads exactly like 51 broken tests. Turning that into
// an error would have put 25 repos in red over a package the module cannot supply, which is how a
// gate stops being read. So the gap was REPORTED instead: named, gate green.
//
// That was a warning with an expiry date, and it expired badly. Measured on 2026-08-24: 232 of the
// 245 `.test.ts` files across the 26 module repos — ≈3.044 tests — were NOT RUN, and the number had
// grown on its own: `flows` used to run its 26 files and fell out the day `ui/lib/hub-flows.ts`
// imported the SDK, because `missingPackages()` reads all of `ui/` and not just the tests. Nobody
// noticed, because the gate stayed green in 28 s. A warning is a pass with decoration.
//
// The SDK reaches the runner now (ERPlora/hub#1097): `ERPlora/hub` shares a composite action with
// the organization, which GitHub resolves WITHOUT a credential and which leaves the hub's checkout
// on disk — the same door module-toolkit#61/#66 opened for the canonical mirrors, and the same one
// the 26 modules already walk through to run this validator. So there is no longer a package the
// module cannot get, and therefore no longer a reason to print ✓ over a test nobody executed. The
// rule is now the one #50/#55 apply to the Python batteries, with no carve-out: a test that exists
// and does not run FAILS.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the gate runs. Deliberately the same single glob the two modules that carry their own
 * `vitest.config.ts` already declare — this widens nothing and narrows nothing, it just stops the
 * rule from living in 25 places (23 of which do not state it at all).
 */
export const TS_TEST_GLOBS = ['ui/**/*.test.ts'];

/** The config handed to vitest, so the 23 modules without one are not run under `node`. */
export const VITEST_CONFIG = join(dirname(fileURLToPath(import.meta.url)), 'vitest.module.config.mjs');

/**
 * Anything ending like a test, whatever the spelling. Wider than `TS_TEST_GLOBS` ON PURPOSE: this
 * is the net that catches the file written where nothing looks. `.spec.ts` is in because it is the
 * other name vitest answers to by default, so it is exactly the file an author would expect to be
 * picked up and that today nothing would run.
 */
const LOOKS_LIKE_A_TEST = /\.(test|spec)\.(ts|tsx|mts|cts)$/;

/** Build output, dependencies, and the `.wt-*` worktrees a shared checkout holds: never source. */
const NOT_SOURCE = new Set(['node_modules', 'dist', 'build', 'coverage', 'target', '.git']);

/** Every file under `dir`, relative and sorted, with the non-source directories pruned. */
function sourceFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs).sort()) {
      const child = join(abs, entry);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue; // a dangling symlink is not a test
      }
      if (st.isDirectory()) {
        // Dotted directories cover the fleet's `.wt-*` worktrees, each a FULL second copy of `ui/`:
        // reading them would run the same file twice and report a stray for every one of them.
        if (NOT_SOURCE.has(entry) || entry.startsWith('.')) continue;
        walk(child, rel ? `${rel}/${entry}` : entry);
      } else {
        out.push(rel ? `${rel}/${entry}` : entry);
      }
    }
  };
  if (!existsSync(dir)) return out;
  walk(dir, '');
  return out;
}

/**
 * `ui/**\/*.test.ts` → a regular expression. Only the three constructs the globs above use, and
 * nothing more: `**` crosses directory separators, `*` does not, everything else is a literal.
 * A general glob engine would be a dependency, and this file must run on a runner where
 * `npm install` is impossible.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    if (glob.startsWith('**/', i)) {
      re += '(?:[^/]+/)*';
      i += 2;
    } else if (glob[i] === '*') {
      re += '[^/]*';
    } else {
      re += glob[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

const GLOB_RES = TS_TEST_GLOBS.map(globToRegExp);

/** The TypeScript tests the gate WILL run, relative to the module dir and sorted. */
export function discoverTsTests(dir) {
  return sourceFiles(dir).filter((f) => GLOB_RES.some((re) => re.test(f)));
}

/**
 * Files that LOOK like a test and that no pattern picks up — so nothing would ever run them.
 *
 * Measured on the 25 repos the day this landed: zero. That is the point of adding it now rather
 * than after the first one appears — the alarm is installed while the house is clean, so the file
 * that trips it is the new one, and it trips on the pull request that introduces it.
 */
export function strayTsTests(dir) {
  return sourceFiles(dir).filter(
    (f) => LOOKS_LIKE_A_TEST.test(f) && !GLOB_RES.some((re) => re.test(f)),
  );
}

/**
 * Every way a file names a package: `import … from 'x'`, `import 'x'`, `export … from 'x'`, and the
 * runtime forms `import('x')` / `require('x')` / `require.resolve('x')`.
 *
 * 🔴 The last one is not decoration, it was measured: `ui/lib/ionic-fill-needs-md.test.ts` — the
 * mirror of hub#760 that `inventory`, `pricing` and `staff` carry — reaches Ionic's own CSS with
 * `require.resolve('@ionic/core/package.json')`, the ONLY reference to that package in the 25
 * modules and not an import at all. Reading only imports declares it unnecessary, and the three
 * modules go RED with «Cannot find module» instead of being reported as not run.
 */
const SPECIFIER_RES = [
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /\b(?:import|require|require\.resolve)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** `@scope/name/sub` → `@scope/name`; `lit/decorators.js` → `lit`. */
function packageOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * The npm packages the module's `ui/` actually imports, read from the SOURCES and not from
 * `package.json`. The manifest of a module repo lists `@erplora/module-sdk` as `workspace:*` — a
 * specifier that means nothing outside the development workspace — so believing it would be
 * believing a promise nobody can keep on a runner. What matters is what the code asks for.
 */
export function bareImports(dir) {
  const seen = new Set();
  for (const file of sourceFiles(join(dir, 'ui'))) {
    if (!/\.(ts|tsx|mts|cts|js|mjs)$/.test(file)) continue;
    let source;
    try {
      source = readFileSync(join(dir, 'ui', file), 'utf8');
    } catch {
      continue;
    }
    for (const re of SPECIFIER_RES) {
      for (const m of source.matchAll(re)) {
        const spec = m[1];
        if (!spec || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue;
        seen.add(packageOf(spec));
      }
    }
  }
  return [...seen].sort();
}

/**
 * Is this package INSTALLED next to the module? Answered by looking for the directory, walking up
 * the way node does — never by `require.resolve`.
 *
 * 🔴 Both halves of that were reproduced against the real tree before being written.
 *
 *   * `require.resolve` answers a different question — «can I import this?» — and gets it wrong
 *     here: `@erplora/outfitkit` declares an `exports` map of subpaths (`./ok-data-table`) with
 *     neither `"."` nor `"./package.json"`, so it throws ERR_PACKAGE_PATH_NOT_EXPORTED for a
 *     package that is right there and that vite resolves without blinking. Believing it would have
 *     reported all 210 tests as unrunnable.
 *   * the walk must start from an ABSOLUTE path: the gate calls `erplora test .`, and a relative
 *     one resolves against nothing.
 */
function resolvable(dir, pkg) {
  let current = resolve(dir);
  for (;;) {
    if (existsSync(join(current, 'node_modules', pkg, 'package.json'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Packages the RUN needs that no source imports: `environment: 'happy-dom'` is loaded by vitest
 * itself, so it appears in no `import` line of any of the 25 modules. Without it the failure is a
 * cryptic environment start-up error rather than «a package is missing».
 */
const ENVIRONMENT_PACKAGES = ['happy-dom'];

/** The packages the run needs that are NOT installed next to the module. Sorted, possibly empty. */
export function missingPackages(dir) {
  const wanted = new Set([...bareImports(dir), ...ENVIRONMENT_PACKAGES]);
  return [...wanted].sort().filter((pkg) => !resolvable(dir, pkg));
}

/**
 * The vitest the module's tests will run under, or `null`.
 *
 * Resolved FROM THE MODULE and not from the toolkit: in the development workspace vitest sits at
 * the workspace root and node's own upward walk finds it, and on a runner it is installed next to
 * the module by the gate. `ERPLORA_VITEST` overrides both, which is what lets the gate hand over
 * an installation it prepared itself — the same door `ERPLORA_PYTHON` opens for the batteries.
 */
export function resolveVitest(dir, env = process.env) {
  if (env.ERPLORA_VITEST) return env.ERPLORA_VITEST;
  try {
    const require_ = createRequire(resolve(dir, 'noop.js'));
    return join(dirname(require_.resolve('vitest/package.json')), 'vitest.mjs');
  } catch {
    return null;
  }
}

/**
 * Runs the module's TypeScript tests. Returns `{ results, errors, notRun }`; never throws — the
 * caller decides. Mirrors `runBatteries` so `bin/erplora.mjs` reports both families the same way.
 *
 * One vitest process for the whole module, not one per file: vitest collects and runs the set
 * itself, and its own reporter output is what a failure has to show.
 */
export function runTsTests(dir, { vitest = undefined, env = process.env } = {}) {
  const results = [];
  const errors = [];
  const notRun = [];

  // The alarm runs even when the module has no TypeScript test at all: a lone `src/x.test.ts` that
  // nothing collects is precisely the case an early return would hide.
  for (const stray of strayTsTests(dir)) {
    errors.push(
      `${stray}: NADIE lo va a ejecutar — no lo recoge \`${TS_TEST_GLOBS.join('`/`')}\`, que es ` +
        'lo único que corre el gate. Un test invisible es peor que no tener test: da la confianza ' +
        'sin hacer la comprobación. Muévelo a `ui/` con el nombre `<algo>.test.ts`, o bórralo si ' +
        'ya no prueba nada',
    );
  }

  const files = discoverTsTests(dir);
  if (!files.length) return { results, errors, notRun };

  const bin = vitest === undefined ? resolveVitest(dir, env) : vitest;
  if (!bin) {
    errors.push(
      `${files.length} test(s) de TypeScript que NADIE va a ejecutar: no hay \`vitest\` al alcance ` +
        'del módulo. Darlos por buenos sería el fallo que esta puerta viene a evitar. Remedio: ' +
        '`npm install -D vitest happy-dom lit @ionic/core @erplora/outfitkit` junto al módulo, o ' +
        'apunta `ERPLORA_VITEST` al binario de un vitest ya instalado — que es lo que hace el gate',
    );
    return { results, errors, notRun };
  }

  // 🔴 Checked BEFORE spawning, and this is the difference between a gate that is read and one that
  // is switched off. Without `@erplora/module-sdk` vitest does not report "the environment is
  // incomplete": it reports a resolution error per file, which looks exactly like 51 broken tests.
  const missing = missingPackages(dir);
  if (missing.length) {
    errors.push(
      `${files.length} test(s) de TypeScript que NADIE va a ejecutar: el módulo necesita ` +
        `${missing.join(', ')} y no está instalado junto a él. Un paquete que falta no convierte ` +
        'un test en aprobado — el gate lo instala en el paso `Node packages for the module\'s ' +
        'TypeScript tests`, y `@erplora/module-sdk` llega desde `ERPlora/hub` por la composite ' +
        'action `module-sdk` (ERPlora/hub#1097). Si sale aquí, ese paso no corrió o no encontró ' +
        'el paquete',
    );
    return { results, errors, notRun };
  }

  const r = spawnSync(process.execPath, [bin, 'run', '--config', VITEST_CONFIG, '--reporter=dot'], {
    cwd: dir,
    env: { ...env },
    encoding: 'utf8',
  });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0) {
    errors.push(
      `${files.length} test(s) de TypeScript en ROJO (exit ${r.status}) — ` +
        `${files.join(', ')}\n${indent(output)}`,
    );
    return { results, errors, notRun };
  }

  // 🔴 EXIT 0 IS NOT THE CONTRACT — «se ejecutaron» LO ES. The same rule `run-batteries.mjs`
  // applies to a `*.postgres.test.py` that returns clean without reaching Postgres, one layer up:
  // `--list` promised N files to the gate, and until this nothing checked that N were run. Reading
  // the count back is what stops #55 from reopening on the vitest side — a config whose `include`
  // drifts from `TS_TEST_GLOBS` would collect fewer files, and both halves would report success.
  const summary = collectedSummary(output);
  if (!summary) {
    errors.push(
      `${files.length} test(s) de TypeScript: vitest salió con 0 pero NO pude leer cuántos ` +
        'ficheros corrió (no hay línea `Test Files … (N)` en su salida). Un 0 sin constancia de ' +
        `que se ejecutara algo es el verde que no prueba nada\n${indent(output)}`,
    );
    return { results, errors, notRun };
  }
  if (summary.total < files.length) {
    errors.push(
      `vitest solo recogió ${summary.total} de los ${files.length} fichero(s) que \`--list\` ` +
        'promete al gate: los que faltan NO se han ejecutado y nadie se habría enterado. La ' +
        `\`include\` de la config y \`TS_TEST_GLOBS\` han dejado de decir lo mismo — ${files.join(', ')}\n${indent(output)}`,
    );
    return { results, errors, notRun };
  }
  if (summary.skipped) {
    // Deliberate (`describe.skip`) rather than infrastructure, so it is not a red — but it is not a
    // pass either. Zero of the 212 files skip themselves today: the first one to do it says so.
    notRun.push(
      `${summary.skipped} de ${summary.total} fichero(s) de TypeScript se SALTARON enteros ` +
        '(`describe.skip`/`it.skip`): no se cuentan como verdes. Quítales el skip o bórralos si ' +
        'ya no prueban nada',
    );
  }
  for (const file of files) results.push({ file, kind: 'typescript', ran: true, output });
  return { results, errors, notRun };
}

/**
 * How many test FILES vitest actually collected, read from the line every reporter prints last:
 *
 *   ` Test Files  26 passed (26)`              → 26 collected, none skipped
 *   ` Test Files  1 passed | 1 skipped (2)`    → 2 collected, 1 of them skipped whole
 *
 * The number in parentheses is the total; the breakdown before it is where a `skipped` shows up.
 * `null` when the line is not there at all, which is a failure of its own — see the caller.
 *
 * The line is matched COLORIZED: vitest ≥ 4.1.11 paints its reporter with ANSI escapes even
 * through a pipe when `CI` is set, and the escapes sit BETWEEN the words (`Test`, `Files`, the
 * counts), so a plain regex over the raw output sees nothing and every module PR whose vitest
 * actually ran turned red on «no pude leer cuántos ficheros corrió» while the suite had passed
 * (appointments#80/#81, 2026-08-22). Stripping the escapes first keeps one matcher for both
 * shapes — the count is the contract, not the paint.
 */
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function collectedSummary(output) {
  const plain = output.replace(ANSI_ESCAPE, '');
  const line = /^\s*Test Files\s+(.*?)\((\d+)\)\s*$/m.exec(plain);
  if (!line) return null;
  const skipped = /(\d+)\s+skipped/.exec(line[1]);
  return { total: Number(line[2]), skipped: skipped ? Number(skipped[1]) : 0 };
}

function indent(text) {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
