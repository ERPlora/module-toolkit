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
// WHAT STAYS OUT, and why — said out loud instead of faked:
//
//   * `cargo test` of `handler/`. The 21 modules with a handler depend on the hub's
//     `erplora-guest-sdk` BY RELATIVE PATH (`../../hub/crates/guest-sdk`), and there is no checkout
//     of ERPlora/hub on the runner. Fetching one means a token with read access to a private repo
//     living in 25 module repos, which is a security decision, not a CI detail.
//   * the vitest component tests. The `.test.ts` files DO live in the module repo, but the runner
//     does not: vitest, `happy-dom`, `@erplora/outfitkit` and `@erplora/module-sdk` are
//     devDependencies of `modules-workspace`, and the last two are `file:` paths into sibling
//     checkouts (`../outfitkit`, `../hub/packages/module-sdk`) that do not exist on a runner.
//
// Both are the same shape of gap as the wasm build the validator already refuses to fake, and they
// are reported the same way: named, not silently skipped.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Suffix → kind. A battery is recognised by its name, like the module's own README says. */
export const BATTERY_KINDS = {
  contract: '.contract.test.py',
  postgres: '.postgres.test.py',
};

/** The batteries the module carries, by kind, relative to the module dir and sorted. */
export function discoverBatteries(dir) {
  const testsDir = join(dir, 'tests');
  const files = existsSync(testsDir) ? readdirSync(testsDir).sort() : [];
  const out = {};
  for (const [kind, suffix] of Object.entries(BATTERY_KINDS)) {
    out[kind] = files.filter((f) => f.endsWith(suffix)).map((f) => `tests/${f}`);
  }
  return out;
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

/** Does this output say the battery skipped itself instead of running? */
export function looksSkipped(output) {
  return /^\s*SKIPPED:/m.test(output);
}

/**
 * Runs the module's batteries. Returns `{ results, errors, notRun }`; never throws — the caller
 * decides. `results[]` carries `{ file, kind, ran, code, output }`.
 *
 * `container` is the Postgres the gate already starts. Without it the Postgres batteries are NOT
 * run and are listed in `notRun`: reporting them as passed would be the exact lie this file exists
 * to prevent.
 */
export function runBatteries(dir, manifest, { container = null, python = 'python3' } = {}) {
  const results = [];
  const errors = [];
  const notRun = [];

  const found = discoverBatteries(dir);
  const total = Object.values(found).reduce((a, l) => a + l.length, 0);
  if (!total) return { results, errors, notRun };

  const probe = spawnSync(python, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    errors.push(
      `no hay intérprete de Python (\`${python}\`): ${total} batería(s) del módulo NO se han ` +
        'corrido. Una batería que no corre no puede salir en verde',
    );
    return { results, errors, notRun };
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
      const env = {
        ...process.env,
        ...(kind === 'postgres' ? pgContainerVars(manifest.id, container) : {}),
      };
      const r = spawnSync(python, [file], { cwd: dir, env, encoding: 'utf8' });
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
