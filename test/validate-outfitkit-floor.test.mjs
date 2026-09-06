// A module may not ship a screen no hub can paint — ERPlora/module-toolkit#201.
//
// WHAT THIS IS ABOUT. The `ok-*` a module renders with are the SHELL's, not the ones its bundle
// carries: the shell defines them at boot and the baked `define()` loses in silence
// (`src/outfitkit-stamp.mjs`, ADR-0133 §verificación 2). So the OutfitKit that decides how the
// module looks is the one inside the hub image — and the hub image installs
// `@erplora/outfitkit@latest` on every build (`hub/docker/Dockerfile`), which means the author's
// checkout is routinely NEWER than the fleet's.
//
// It has cost twice in four days: reservations 3.0.26 (hub#1547) reached for a table capability
// the fleet's hub has not got, and sales 2.16.x (sales#259) announced its per-row action with a
// chunk of source code instead of the word «Devolver» in EVERY deployed hub — `DataTableAction.label`
// only accepts a function from OutfitKit 0.1.59, and the fleet tag `v1.1.13` carries 0.1.58.
//
// The manifest already has the field that says it (`compatibility.min_erplora_version`) and the hub
// already ENFORCES it (hub#521). What was missing is the half that asks for it at the author's door.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  HUB_OUTFITKIT,
  checkOutfitkitFloor,
  compareOutfitkitVersions,
  newestKnownHub,
  oldestHubShipping,
  nextHubAfter,
  outfitkitForFloor,
} from '../src/validate-outfitkit-floor.mjs';

let fixtures = 0;

/**
 * A module directory with the given stamp (or none) and the given manifest extras.
 *
 * Each one gets its OWN parent and its OWN id on purpose. `validate` resolves the contract universe
 * by scanning the module's siblings, so fixtures sharing a parent — or an id — make each other's
 * runs lie (module-toolkit#176/#199, fixed in #200 by isolating; this is the same trap seen from
 * the test side).
 */
function moduleDir({ stamp, compatibility } = {}) {
  fixtures += 1;
  const id = `floor_fixture_${fixtures}`;
  const dir = join(mkdtempSync(join(tmpdir(), 'erplora-ok-floor-')), id);
  mkdirSync(dir, { recursive: true });
  const manifest = { id, name: 'Floor fixture', version: '1.0.0' };
  if (compatibility) manifest.compatibility = compatibility;
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  if (stamp !== undefined) {
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'outfitkit.json'), JSON.stringify({ outfitkit: stamp }));
  }
  return { dir, manifest };
}

test('the table is ordered, without repeats, and its OutfitKit never goes backwards', () => {
  assert.ok(HUB_OUTFITKIT.length >= 10, 'a table with a handful of hubs cannot resolve a floor');
  for (let i = 1; i < HUB_OUTFITKIT.length; i += 1) {
    const prev = HUB_OUTFITKIT[i - 1];
    const cur = HUB_OUTFITKIT[i];
    assert.ok(
      compareOutfitkitVersions(cur.hub, prev.hub) > 0,
      `hub tags out of order or repeated: ${prev.hub} then ${cur.hub}`,
    );
    // `oldestHubShipping` scans the table in order and returns the FIRST row good enough, so a
    // non-decreasing OutfitKit column is not decoration: it is what makes that answer the oldest.
    assert.ok(
      compareOutfitkitVersions(cur.outfitkit, prev.outfitkit) >= 0,
      `${cur.hub} would ship an OLDER OutfitKit than ${prev.hub}, and oldestHubShipping would ` +
        'then stop at the wrong row',
    );
    // NOT asserted: that `built_at` grows with the tag. It does not — `v1.1.9` was tagged 77
    // seconds BEFORE `v1.1.8` in ERPlora/hub, and pinning the world to be tidier than it is only
    // buys a red that says nothing. What IS pinned is the shape, so a row cannot be typed loosely.
    assert.match(cur.built_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }
});

test('the fleet tag v1.1.13 resolves to OutfitKit 0.1.58 — the pair sales#265 measured by hand', () => {
  // The one row the issue proved independently (tag built 2026-09-02T18:09Z, between 0.1.58 on
  // 2026-09-02T04:37Z and 0.1.59 on 2026-09-03T12:32Z). If the derivation ever stops reproducing
  // it, the whole table is derived wrong.
  const row = HUB_OUTFITKIT.find((r) => r.hub === '1.1.13');
  assert.ok(row, 'the fleet tag is not in the table');
  assert.equal(row.outfitkit, '0.1.58');
});

test('a module baked against an OutfitKit NO hub ships is rejected, floor or no floor', () => {
  const newest = newestKnownHub();
  const { dir, manifest } = moduleDir({ stamp: '0.1.99' });
  const { errors } = checkOutfitkitFloor(dir, manifest);
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /0\.1\.99/);
  assert.match(errors[0], new RegExp(newest.outfitkit.replace(/\./g, '\\.')));
  assert.match(errors[0], /min_erplora_version/, 'the message has to say what to declare');
});

test('the block ALWAYS leaves a one-line way out, even when no hub ships the bake yet', () => {
  // A gate with no possible action is a gate somebody switches off. When not even the newest hub
  // carries what was baked there is no tag to name, so the message hands the author the NEXT one —
  // which is the true statement («this needs a hub newer than any published») and the one hub#521
  // turns into a refused install instead of a broken screen.
  const { dir, manifest } = moduleDir({ stamp: '0.1.99' });
  const [error] = checkOutfitkitFloor(dir, manifest).errors;
  assert.match(error, new RegExp(nextHubAfter(newestKnownHub().hub).replace(/\./g, '\\.')));
  assert.match(error, /hub#521/, 'it has to say what declaring it buys');
});

test('nextHubAfter bumps the patch, and copes with a two-part tag', () => {
  assert.equal(nextHubAfter('1.1.13'), '1.1.14');
  assert.equal(nextHubAfter('1.2'), '1.2.1');
});

test('a declared floor is HONOURED: baking newer than the hub you claim to support is rejected', () => {
  // `1.1.0` ships 0.1.36. Baking 0.1.58 and claiming 1.1.0 promises a screen that hub cannot paint.
  const { dir, manifest } = moduleDir({
    stamp: '0.1.58',
    compatibility: { min_erplora_version: '1.1.0' },
  });
  const { errors } = checkOutfitkitFloor(dir, manifest);
  assert.equal(errors.length, 1, `expected exactly one error, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /1\.1\.0/);
  assert.match(errors[0], /0\.1\.36/, 'the message has to name the OutfitKit that floor ships');
  // And it has to say which hub DOES ship what was baked, or the author cannot act on it.
  assert.match(errors[0], new RegExp(oldestHubShipping('0.1.58').hub.replace(/\./g, '\\.')));
});

test('a declared floor that COVERS the bake passes', () => {
  const { dir, manifest } = moduleDir({
    stamp: '0.1.58',
    compatibility: { min_erplora_version: '1.1.12' },
  });
  assert.deepEqual(checkOutfitkitFloor(dir, manifest).errors, []);
});

test('the 27 modules published today stay green: a bake no newer than the fleet says nothing', () => {
  // Measured on 2026-09-06 over the committed `dist/outfitkit.json` of the module workspace: the
  // stamps run 0.1.44 … 0.1.59. This check is NOT a big bang — it fires only when the claim «runs
  // on any hub» is provably false, i.e. when not even the newest hub could paint it.
  for (const stamp of ['0.1.44', '0.1.52', '0.1.56', newestKnownHub().outfitkit]) {
    const { dir, manifest } = moduleDir({ stamp });
    assert.deepEqual(
      checkOutfitkitFloor(dir, manifest).errors,
      [],
      `${stamp} is not newer than the fleet and must not be blocked`,
    );
  }
});

test('a floor NEWER than every known hub passes with a warning, never a block', () => {
  // The escape hatch, and it is the correct one: the author who needs an unreleased hub declares
  // it, `validate` cannot check what it does not know, and hub#521 refuses the install on the old
  // hubs. Blocking here would leave no way to publish a module that legitimately needs a new core.
  const { dir, manifest } = moduleDir({
    stamp: '0.1.99',
    compatibility: { min_erplora_version: '9.9.9' },
  });
  const { errors, warnings } = checkOutfitkitFloor(dir, manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
  assert.match(warnings[0], /9\.9\.9/);
});

test('no stamp = nothing to claim: a module built before the stamp existed is not blocked', () => {
  const { dir, manifest } = moduleDir({});
  assert.deepEqual(checkOutfitkitFloor(dir, manifest), { errors: [], warnings: [] });
});

test('a stamp that cannot be read WARNS instead of blocking on somebody else artifact', () => {
  const { dir, manifest } = moduleDir({});
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'outfitkit.json'), '{ not json');
  const { errors, warnings } = checkOutfitkitFloor(dir, manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1, `expected one warning, got ${JSON.stringify(warnings)}`);
});

test('outfitkitForFloor answers with the OLDEST hub that satisfies the claim, not the newest', () => {
  // The floor is a promise about the WEAKEST hub the module accepts; resolving it to the newest
  // would make every declaration self-fulfilling and the check would never fire.
  assert.equal(outfitkitForFloor('1.1.0').hub, '1.1.0');
  assert.equal(outfitkitForFloor('1.1.0').outfitkit, '0.1.36');
  // A floor between two tags resolves UP, to the oldest tag that actually satisfies it.
  assert.equal(outfitkitForFloor('1.1.10').hub, '1.1.10');
  // A floor older than anything in the table falls back to the oldest row we know.
  assert.equal(outfitkitForFloor('0.0.1').hub, HUB_OUTFITKIT[0].hub);
  // A floor newer than everything is UNKNOWN, and says so instead of guessing.
  assert.equal(outfitkitForFloor('9.9.9'), null);
});

test('oldestHubShipping names the first hub good enough, or null when none is', () => {
  assert.equal(oldestHubShipping('0.1.36').hub, '1.1.0');
  assert.equal(oldestHubShipping('0.1.58').hub, '1.1.12');
  assert.equal(oldestHubShipping('0.1.99'), null);
});

test('compareOutfitkitVersions orders by number, not by string', () => {
  // `'0.1.9' > '0.1.58'` as strings. A string comparison here would wave through exactly the
  // release the check exists for.
  assert.ok(compareOutfitkitVersions('0.1.58', '0.1.9') > 0);
  assert.equal(compareOutfitkitVersions('1.1', '1.1.0'), 0);
  assert.ok(compareOutfitkitVersions('0.1.59-rc.1', '0.1.59') === 0, 'a prerelease tail is ignored');
});

// ── And `erplora validate` actually RUNS it ────────────────────────────────────────────────────
//
// The unit tests above prove the check is right; they do not prove anybody calls it. That is the
// exact defect this repository keeps finding in its own gates (#50, #55, #61, #74,
// `test/ci-runs-every-suite.test.mjs`): a control that is correct and unreachable buys the
// confidence without doing the check. So this drives the real CLI, end to end.

/** A module directory `erplora validate` accepts, with the stamp and manifest asked for. */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'erplora.mjs');

function erplora(command, dir) {
  const res = spawnSync(process.execPath, [CLI, command, dir], { encoding: 'utf8' });
  return { ...res, out: `${res.stdout}\n${res.stderr}` };
}

/** A module the rest of `validate` accepts, so the only thing that can redden it is this check. */
function validatableModule({ stamp, compatibility }) {
  const { dir } = moduleDir({ stamp, compatibility });
  // Written BY the toolkit, not by hand: `.erplora/contracts.json` carries a fingerprint, and a
  // hand-made one is «desactualizado» — which would redden every case here for the wrong reason.
  const contracts = erplora('contracts', dir);
  assert.equal(contracts.status, 0, `could not seed the fixture contracts:\n${contracts.out}`);
  return dir;
}

const runValidate = (dir) => erplora('validate', dir);

test('`erplora validate` FAILS on a module no hub can paint', () => {
  const res = runValidate(validatableModule({ stamp: '0.1.99' }));
  assert.equal(res.status, 1, `expected a red validate, got ${res.status}:\n${res.out}`);
  assert.match(res.out, /module-toolkit#201/);
  assert.match(res.out, /0\.1\.99/);
});

test('`erplora validate` FAILS when the declared floor does not reach the bake', () => {
  const res = runValidate(
    validatableModule({ stamp: '0.1.58', compatibility: { min_erplora_version: '1.1.0' } }),
  );
  assert.equal(res.status, 1, `expected a red validate, got ${res.status}:\n${res.out}`);
  assert.match(res.out, /1\.1\.0/);
});

test('`erplora validate` stays GREEN on what the fleet can paint', () => {
  const res = runValidate(validatableModule({ stamp: newestKnownHub().outfitkit }));
  assert.equal(res.status, 0, `a module the fleet CAN paint must not be blocked:\n${res.out}`);
});
