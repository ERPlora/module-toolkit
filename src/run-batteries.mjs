// The module's OWN test batteries, run by the shared gate (module-toolkit#50).
//
// WHAT THIS SOLVES. `services`, `staff` and `schedules` ship batteries — contract checks and
// real-Postgres checks — that nobody runs in CI: `module-gate.yml` ran `erplora validate` and
// stopped there. They are written, they pass locally, and a change that breaks one merges green.
// This lives in the toolkit and not in each repo for the same reason the gate does (pm#107): fixing
// it here fixes it in the 25 repos without 25 pull requests — and because two of the pieces the
// batteries need are simply not present in a module checkout.
//
// 🔴 THE TRAP, AND THE WHOLE REASON THIS IS CODE INSTEAD OF THREE LINES OF YAML. Every
// `*.postgres.test.py` exits **0** when the Postgres container is unreachable: it prints
// «SKIPPED: the test Postgres container is not running» and returns clean. Wiring them in without
// noticing buys a row of green ticks that prove nothing — the same failure as a battery nobody
// runs, wearing a passing badge. So the contract here is NOT "exit 0": it is "it actually ran".
// A skip is reported as a FAILURE when the container was supposed to be there, and as an explicit
// "not run" when it was not.
//
// WHAT STAYED OUT, and why — said out loud instead of faked. Both entries are now CLOSED, and they
// are kept because each one was right while it lasted and the reasoning is the reusable part:
//
//   * `cargo test` of `handler/`. CLOSED by module-toolkit#146, and NOT by acquiring the credential
//     this paragraph said was needed. The 22 modules with a handler do reach the hub's
//     `erplora-guest-sdk` by relative path, and there is still no token to check ERPlora/hub out
//     from a module repo. There does not have to be: the `module-sdk` composite action already
//     leaves the whole hub on the runner's disk (that is how GitHub resolves it without a
//     credential), so what was missing was never the checkout — it was the LAYOUT. `run-cargo.mjs`
//     builds it out of symlinks in a scratch directory. 925 tests in 21 modules went from NOT RUN
//     to run; the day it landed, reintroducing ERPlora/kitchen#63 turned the gate red by name.
//   * the vitest component tests. The `.test.ts` files DO live in the module repo, but the runner
//     does not: vitest, `happy-dom`, `@erplora/outfitkit` and `@erplora/module-sdk` are
//     devDependencies of `modules-workspace`, and the last two are `file:` paths into sibling
//     checkouts (`../outfitkit`, `../hub/packages/module-sdk`) that do not exist on a runner.
//
// Both are the same shape of gap as the wasm build the validator already refuses to fake, and they
// are reported the same way: named, not silently skipped.
// 🔴 AND THE SECOND TRAP, module-toolkit#55: RECOGNISING a battery by two exact suffixes.
// The first version of this file matched `tests/*.contract.test.py` and `tests/*.postgres.test.py`
// and nothing else, in `tests/` and without recursion. A sweep on 2026-08-19 found **20 files in 7
// modules** that no name matched and therefore NOBODY ran: six `.pg.test.py` in `customers`, three
// in `reservations`, one in `pricing`, one in `tasks`, two more in `whatsapp_inbox`; four in
// `cash_register` with no family suffix at all (`auto_close.test.py`…) that DO need Postgres; and
// two bash batteries in `taxes`. Written, passing on the author's machine, invisible to the gate —
// the exact hole this file was created to close, reopened by a naming convention that nothing
// enforced. `appointments` "fixed" it by renaming its own files, which does not scale: the next
// file born with another name is invisible again.
//
// So a battery is recognised by WHAT IT IS — an executable check under `tests/` — and the family
// (does it need the Postgres container?) is decided by the name OR by the content. And anything
// left under `tests/` that will never be executed is reported by `strayTestFiles` and FAILS the
// gate, because a test nobody runs is worse than no test: it buys the confidence without the check.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { hubBatteryVars } from './against-hub.mjs';

/** A check is a battery if it is named like one. Both interpreters the modules actually use. */
export const BATTERY_RE = /\.test\.(py|sh)$/;

/**
 * The name says "I need Postgres". Both spellings are in the tree and neither is going away:
 * `.postgres.test.py` (services, staff, tables…) and `.pg.test.py` (customers, reservations,
 * pricing, tasks, whatsapp_inbox). Renaming 20 files across 7 repos to agree on one is a change
 * that breaks the day somebody types the other one.
 */
export const PG_NAME_RE = /\.(postgres|pg)\.test\.(py|sh)$/;

/**
 * The content says it even when the name does not. `cash_register/tests/auto_close.test.py` reads
 * `CASH_REGISTER_TEST_PG_CONTAINER` and builds a scratch database from the module's migrations,
 * with nothing in its name to show for it. Misfiled as a contract battery it would run WITHOUT a
 * container, skip itself, and — by the rule above — be reported as a failure. Reading the file is
 * how the classification stops depending on whoever named it.
 */
export const PG_CONTENT_RE = /TEST_PG_CONTAINER|erplora-test-pg/;

/**
 * A battery that talks to a REAL hub runtime (module-toolkit#110). It is its own family because it
 * needs something no other battery does — the published kernel image, running, with the module
 * installed in it — and because the alternative is worse than not having it: misfiled as a contract
 * battery it would run with nothing at the other end and pass, or fail, for reasons that have
 * nothing to do with the module.
 *
 * By NAME (`totals.hub.test.py`) or by CONTENT, exactly like the Postgres family and for the same
 * measured reason (module-toolkit#55): recognising a battery by one exact suffix left 20 files in
 * 7 modules invisible, and «the next file born with another name» is not a hypothesis here either.
 */
export const HUB_NAME_RE = /\.hub\.test\.(py|sh)$/;

/** The content says it even when the name does not: it reads the url of the live runtime. */
export const HUB_CONTENT_RE = /ERPLORA_HUB_BASE_URL|_HUB_BASE_URL/;

/** Directories under `tests/` that hold no checks, only leftovers. */
const IGNORED_DIRS = new Set(['__pycache__', 'node_modules', '.venv', 'venv', '.pytest_cache']);

/** Plumbing that is legitimately not a battery and must not be reported as a stray. */
const PLUMBING = new Set(['__init__.py', 'conftest.py']);

/** Every file under `tests/`, relative to the module dir, sorted, `__pycache__` and friends out. */
function testFiles(dir) {
  const root = join(dir, 'tests');
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (abs, rel) => {
    for (const entry of readdirSync(abs).sort()) {
      const child = join(abs, entry);
      if (statSync(child).isDirectory()) {
        if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
        walk(child, `${rel}/${entry}`);
      } else {
        out.push(`${rel}/${entry}`);
      }
    }
  };
  walk(root, 'tests');
  return out;
}

/**
 * Which family does this battery belong to — by its name, or by what it reads?
 *
 * An explicit NAME beats the content, always and in both directions: somebody who wrote
 * `engine.pg.test.py` said what it is, and a mention of the runtime's url in a comment must not
 * relabel it. Only when the name says nothing does the content decide — and there `hub` goes first,
 * because a battery driving the live runtime may perfectly well also name Postgres, and running it
 * against a scratch database would test the very emulation this family exists to replace.
 */
function familyOf(dir, file) {
  if (HUB_NAME_RE.test(file)) return 'hub';
  if (PG_NAME_RE.test(file)) return 'postgres';
  let source = '';
  try {
    source = readFileSync(join(dir, file), 'utf8');
  } catch {
    return 'contract';
  }
  if (HUB_CONTENT_RE.test(source)) return 'hub';
  if (PG_CONTENT_RE.test(source)) return 'postgres';
  return 'contract';
}

/** The batteries the module carries, by kind, relative to the module dir and sorted. */
export function discoverBatteries(dir) {
  const out = { contract: [], postgres: [], hub: [] };
  for (const file of testFiles(dir)) {
    if (!BATTERY_RE.test(file)) continue;
    out[familyOf(dir, file)].push(file);
  }
  return out;
}

/**
 * Executable files under `tests/` that NOTHING will run: not a battery by name, and not imported by
 * one either. This is the alarm that stops the relapse — widening the pattern fixes the 20 files
 * that exist today, it does not stop the 21st from being born with a name nobody thought of.
 *
 * A harness is not a stray: `tests/pg_harness.py` (services, staff, schedules) never runs on its
 * own, it runs INSIDE the battery that imports it. "Imported" is answered by looking for the name
 * in the batteries' own source, which is how both spellings work — `import pg_harness` and the
 * `spec_from_file_location(..., "messages_ingest.pg.test.py")` that `whatsapp_inbox` uses to borrow
 * its sibling's helpers.
 */
export function strayTestFiles(dir) {
  const files = testFiles(dir);
  const batteries = files.filter((f) => BATTERY_RE.test(f));
  const candidates = files.filter(
    (f) => !BATTERY_RE.test(f) && /\.(py|sh)$/.test(f) && !PLUMBING.has(basename(f)),
  );
  if (!candidates.length) return [];
  const sources = batteries.map((f) => {
    try {
      return readFileSync(join(dir, f), 'utf8');
    } catch {
      return '';
    }
  });
  return candidates.filter((f) => {
    const name = basename(f);
    const stem = name.replace(/\.(py|sh)$/, '');
    return !sources.some((s) => s.includes(name) || s.includes(stem));
  });
}

/**
 * The environment a Postgres battery needs to find the container.
 *
 * Each harness reads its own name — `SERVICES_TEST_PG_CONTAINER`, `STAFF_TEST_PG_CONTAINER`,
 * `SCHEDULES_TEST_PG_CONTAINER` — so the variable is DERIVED from the manifest id and a module
 * written tomorrow needs no change here. `ERPLORA_TEST_PG_CONTAINER` goes too: it is the name the
 * validator already uses, and a future harness that reads the generic one works out of the box.
 */
export function pgContainerVars(moduleId, container) {
  return {
    [`${moduleId.toUpperCase()}_TEST_PG_CONTAINER`]: container,
    ERPLORA_TEST_PG_CONTAINER: container,
  };
}

/**
 * Does this output say the battery skipped ITSELF instead of running?
 *
 * 🔴 Anchored at column 0, and that is the whole rule (module-toolkit#57). The batteries print two
 * different things with the same word, and the indentation is what tells them apart — deliberately,
 * because one is a verdict and the other is a line inside a section:
 *
 *   `SKIPPED: no Postgres in container …`        column 0 — the WHOLE battery skipped, nothing was
 *                                                 verified, and it is the only thing it printed.
 *                                                 This is the green-that-proves-nothing of #50.
 *   `  SKIPPED: cargo metadata --locked (no …)`  indented under its `·` heading — ONE sub-check of
 *                                                 a battery that ran and passed everything else.
 *
 * The first version wrote `^\s*SKIPPED:` and the `\s*` swallowed the indentation, so it read the
 * second as the first: on any checkout without `hub/` beside the module — which is EVERY CI run —
 * `staff` and `schedules` failed their gate on a `manifest.contract.test.py` whose last line reads
 * «✓ manifest.contract: all checks passed». A false red costs the same as a false green in the end:
 * it is how a gate stops being read.
 */
export function looksSkipped(output) {
  return /^SKIPPED:/m.test(output);
}

/**
 * Runs the module's batteries. Returns `{ results, errors, notRun }`; never throws — the caller
 * decides. `results[]` carries `{ file, kind, ran, code, output }`.
 *
 * `container` is the Postgres the gate already starts. Without it the Postgres batteries are NOT
 * run and are listed in `notRun`: reporting them as passed would be the exact lie this file exists
 * to prevent.
 *
 * `hub` is the LIVE runtime `erplora test --against-hub` put up (`{ baseUrl, hubId, image }`), and
 * it plays exactly the same role for the `hub` family (module-toolkit#110): without it those
 * batteries are NOT run and are named, never counted as green.
 */
export function runBatteries(
  dir,
  manifest,
  { container = null, python = 'python3', bash = 'bash', hub = null } = {},
) {
  const results = [];
  const errors = [];
  const notRun = [];

  const found = discoverBatteries(dir);
  const total = Object.values(found).reduce((a, l) => a + l.length, 0);

  // Before anything else, and ALSO when the module carries no battery at all: a lone invisible
  // check sitting in `tests/` would otherwise hide behind the early return below.
  for (const stray of strayTestFiles(dir)) {
    errors.push(
      `${stray}: está en \`tests/\` y NADIE lo va a ejecutar — no se llama \`*.test.py\`/` +
        '`*.test.sh` ni lo importa ninguna batería. Un test invisible es peor que no tener test: ' +
        'da la confianza sin hacer la comprobación. Renómbralo a `<algo>.test.py` (o ' +
        '`<algo>.pg.test.py` si necesita Postgres), o bórralo si ya no prueba nada',
    );
  }

  if (!total) return { results, errors, notRun };

  const needsPython = Object.values(found).flat().some((f) => f.endsWith('.py'));
  if (needsPython) {
    const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      errors.push(
        `no hay intérprete de Python (\`${python}\`): ${total} batería(s) del módulo NO se han ` +
          'corrido. Una batería que no corre no puede salir en verde',
      );
      return { results, errors, notRun };
    }
  }

  for (const [kind, files] of Object.entries(found)) {
    for (const file of files) {
      if (kind === 'postgres' && !container) {
        notRun.push(
          `${file}: sin Postgres al alcance no se ha corrido (necesita el contenedor del gate; ` +
            'darla por buena sería el fallo que esta puerta viene a evitar)',
        );
        continue;
      }
      if (kind === 'hub' && !hub) {
        notRun.push(
          `${file}: sin un runtime del hub al alcance no se ha corrido (necesita ` +
            '`erplora test <dir> --against-hub`, que levanta la imagen publicada del kernel e ' +
            'instala el módulo en ella). Contarla como verde sería certificar el módulo contra un ' +
            'hub que nunca arrancó',
        );
        continue;
      }
      const env = {
        ...process.env,
        ...(kind === 'postgres' ? pgContainerVars(manifest.id, container) : {}),
        ...(kind === 'hub' ? hubBatteryVars(manifest.id, hub) : {}),
      };
      // The interpreter follows the extension, never the file's own `+x` bit: a battery committed
      // without it (`taxes/tests/cashier_role.contract.test.py`) has to run just the same.
      const interpreter = file.endsWith('.sh') ? bash : python;
      const r = spawnSync(interpreter, [file], { cwd: dir, env, encoding: 'utf8' });
      const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      const ran = r.status === 0 && !looksSkipped(output);
      results.push({ file, kind, ran, code: r.status, output });

      if (r.status !== 0) {
        errors.push(`${file}: la batería FALLA (exit ${r.status})\n${indent(output)}`);
      } else if (looksSkipped(output)) {
        // Exit 0 and nothing tested: the green that proves nothing. It is only reachable when the
        // container was handed over and the harness still could not reach it — infrastructure, and
        // it has to be loud, because the alternative is a gate that certifies nothing.
        errors.push(
          `${file}: la batería se SALTÓ a sí misma aunque se le dio el contenedor ` +
            `\`${container}\` — salió con 0 sin probar nada\n${indent(output)}`,
        );
      }
    }
  }

  return { results, errors, notRun };
}

function indent(text) {
  return text
    .trimEnd()
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
