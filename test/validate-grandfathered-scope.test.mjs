// Reusing a published module id may never, by itself, turn a door of `erplora validate` RED —
// ERPlora/module-toolkit#189.
//
// Every grandfathered list in this repo is a RATCHET: it excuses what was already published and it
// may only shrink, so a line that no longer covers anything has to fail and be deleted. That half
// is right. The half that keeps being written wrong is WHOSE gate it fails: the lists are keyed by
// module id, and a module id is not private. A third party writing their first module, and every
// fixture in this repo, is free to call it `tasks`, `invoice`, `services` or `taxes` — and then
// inherits somebody else's excuses. `checkFilterOps` failed on three of them and `checkIonicFill`
// on three more, naming screens and columns that manifest never had and cannot delete: nothing the
// author could touch in their own module made it green, because the error was not about their code.
//
// The rule, and it is one line per door: the stale-line error goes to the module that can have
// FIXED it — the one that declares the query (`filter-ops`, `dead-filters`) or ships the components
// (`ionic-fill`). Any other manifest is warned, never blocked. That keeps the ratchet doing its
// job — the list still cannot outlive its filters, and the order of the two pull requests still
// holds — while it stops charging strangers.
//
// This suite is the guard for the PATTERN, not for the two doors that had it: `EVERY_LIST` is read
// off `src/` at run time, so a sixth grandfathered list cannot be born outside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFilterOps, FILTER_OPS_GRANDFATHERED } from '../src/validate-filter-ops.mjs';
import { checkDeadFilters, DEAD_FILTERS_GRANDFATHERED } from '../src/validate-dead-filters.mjs';
import { checkIonicFill, FILL_GRANDFATHERED } from '../src/validate-ionic-fill.mjs';
import { checkMigrationGuard, GRANDFATHERED as MIGRATION_GRANDFATHERED } from '../src/validate-migration-guard.mjs';
import { checkGateConstraints, GRANDFATHERED as GATE_GRANDFATHERED } from '../src/validate-gate-constraints.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every door that carries a grandfathered list, by the `<file>:<export>` it is declared as. */
const DOORS = {
  'validate-filter-ops.mjs:FILTER_OPS_GRANDFATHERED': { check: checkFilterOps, list: FILTER_OPS_GRANDFATHERED },
  'validate-dead-filters.mjs:DEAD_FILTERS_GRANDFATHERED': { check: checkDeadFilters, list: DEAD_FILTERS_GRANDFATHERED },
  'validate-ionic-fill.mjs:FILL_GRANDFATHERED': { check: checkIonicFill, list: FILL_GRANDFATHERED },
  'validate-migration-guard.mjs:GRANDFATHERED': { check: checkMigrationGuard, list: MIGRATION_GRANDFATHERED },
  'validate-gate-constraints.mjs:GRANDFATHERED': { check: checkGateConstraints, list: GATE_GRANDFATHERED },
};

/**
 * `<file>:<name>` for every grandfathered list ONE source declares: any top-level `const` whose name
 * carries `GRANDFATHERED`, exported or not. A list the file keeps to itself, or one spelled
 * `GRANDFATHERED_X` instead of `X_GRANDFATHERED`, is still a list — the census names it and the test
 * below then asks for it to be exported and judged. A narrower pattern is how a sixth is born outside.
 */
function listsIn(file, body) {
  return [...body.matchAll(/^(?:export )?const ([A-Z0-9_]*GRANDFATHERED[A-Z0-9_]*)\b/gm)].map((m) => `${file}:${m[1]}`);
}

/** `<file>:<name>` for every grandfathered list `src/` declares, read off the sources. */
function everyListInSrc() {
  const found = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.mjs')).sort()) {
    found.push(...listsIn(file, readFileSync(join(SRC, file), 'utf8')));
  }
  return found;
}

/** A module on disk that declares NOTHING but its id: no queries, no `ui/`, no migrations. */
function bare(id) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-gf-scope-'));
  const manifest = { id, name: 'Fixture', version: '1.0.0' };
  mkdirSync(join(dir, 'locales'), { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest));
  return { dir, manifest, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('every grandfathered list in `src/` is judged here — a sixth cannot be born outside', () => {
  // The positive control of the guard itself. Without it this suite protects the five doors that
  // existed the day it was written and says nothing about the next one, which is exactly how
  // `filter-ops` and `ionic-fill` inherited the defect from a list that predates both.
  assert.deepEqual(
    everyListInSrc().sort(),
    Object.keys(DOORS).sort(),
    'a grandfathered list is missing from `DOORS` (or one there no longer exists): add it with its ' +
      'check, so reusing a published id keeps being proven harmless at that door too',
  );
});

test('the census sees a list however it is spelled: unexported, or `GRANDFATHERED_X`', () => {
  // The two ways a probe found to be born outside the guard (review of module-toolkit#195): a list
  // the file keeps to itself, and the suffix spelling. Both are lists; both must reach `DOORS`.
  assert.deepEqual(listsIn('a.mjs', 'const ZZZ_GRANDFATHERED = [];\n'), ['a.mjs:ZZZ_GRANDFATHERED']);
  assert.deepEqual(listsIn('b.mjs', 'export const GRANDFATHERED_IDS = new Set();\n'), ['b.mjs:GRANDFATHERED_IDS']);
  assert.deepEqual(listsIn('c.mjs', 'export const GRANDFATHERED = [];\n'), ['c.mjs:GRANDFATHERED']);
  assert.deepEqual(listsIn('d.mjs', '  const GRANDFATHERED = 1; // not top-level\n'), []);
});

test('a manifest that declares nothing but a published id is GREEN at every door', () => {
  const seen = [];
  for (const [name, { check, list }] of Object.entries(DOORS)) {
    for (const id of [...new Set(list.map(([m]) => m))]) {
      const m = bare(id);
      try {
        const { errors } = check(m.dir, m.manifest);
        assert.deepEqual(
          errors,
          [],
          `${name}: reusing the id \`${id}\` is enough to be blocked by somebody else's excuse — ` +
            'the stale-line error belongs to the module that can have FIXED it, everyone else is ' +
            'warned (module-toolkit#189)',
        );
        seen.push(`${name}:${id}`);
      } finally {
        m.clean();
      }
    }
  }
  // The check that this test is not passing because it checked nothing: the lists are not empty,
  // so ids were really exercised. It shrinks with the sweeps and only reaches 0 when every list is
  // gone, and then this suite has no subject left.
  assert.ok(seen.length >= 20, `only ${seen.length} id/door pairs exercised — the lists cannot be that small`);
});

test('the ratchet still BITES the module the line is about: a stale line is an error there', () => {
  // The other half, so the fix above cannot be «warn on everything». Each door is given the module
  // that CAN have fixed it — it declares the query, or it ships components — with the offending
  // filter gone. That is exactly when the line has to be deleted, and it blocks.
  const [fopsId, fopsQuery] = FILTER_OPS_GRANDFATHERED[0];
  const fops = bare(fopsId);
  try {
    const { errors } = checkFilterOps(fops.dir, { id: fopsId, queries: { [fopsQuery]: { list: { filters: {} } } } });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /FILTER_OPS_GRANDFATHERED/);
  } finally {
    fops.clean();
  }

  const [fillId, fillFile] = FILL_GRANDFATHERED[0];
  const fill = bare(fillId);
  try {
    mkdirSync(join(fill.dir, 'ui', 'components', 'erp-other'), { recursive: true });
    writeFileSync(join(fill.dir, 'ui/components/erp-other/erp-other.ts'), '<ion-input mode="md" fill="outline"></ion-input>');
    const { errors } = checkIonicFill(fill.dir, fill.manifest);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], new RegExp(fillFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fill.clean();
  }
});

test('a stale line is never SILENT for the stranger either — it is warned, not swallowed', () => {
  // Downgrading to nothing would be the other way to pass the test above, and it would hide the
  // one signal that gets these lists deleted. The sweep is driven by somebody reading the warning.
  for (const [name, { check, list }] of [
    ['filter-ops', { check: checkFilterOps, list: FILTER_OPS_GRANDFATHERED }],
    ['ionic-fill', { check: checkIonicFill, list: FILL_GRANDFATHERED }],
  ]) {
    const id = list[0][0];
    const owed = list.filter(([m]) => m === id).length;
    const m = bare(id);
    try {
      const { warnings } = check(m.dir, m.manifest);
      assert.equal(warnings.length, owed, `${name}: ${JSON.stringify(warnings)}`);
      for (const w of warnings) assert.match(w, /GRANDFATHERED/, `${name}: the warning names the list to edit`);
    } finally {
      m.clean();
    }
  }
});
