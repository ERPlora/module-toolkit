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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

test('no floor + a bake ahead of every hub WARNS on validate and BLOCKS on publish', () => {
  // 🔴 THE RATCHET, and it is the whole reason this check is shippable — same split
  // `bundle-freshness.mjs` already makes next door. The stamp comes from the toolkit's
  // `file:../outfitkit`, the SHARED development checkout, which is ahead of the fleet by design
  // (that IS the premise of the issue). And `validate` forces a rebuild the moment `ui/**` moves
  // (`checkBundleArtifact`). So blocking here would redden the next pull request of EVERY module
  // that touches its UI — for the hub's release cadence, not for anything the author did — and a
  // gate that stops everybody gets switched off, not obeyed.
  //
  // Where it DOES block is `erplora pack`, the door to the marketplace: the act that reaches a
  // client. Build and test against whatever you like; you do not PUBLISH a screen no hub can paint.
  const newest = newestKnownHub();
  const { dir, manifest } = moduleDir({ stamp: '0.1.99' });

  const onValidate = checkOutfitkitFloor(dir, manifest);
  assert.deepEqual(onValidate.errors, [], 'a plain validate must not block on the shared checkout');
  assert.equal(onValidate.warnings.length, 1, JSON.stringify(onValidate.warnings));
  assert.match(onValidate.warnings[0], /0\.1\.99/);
  assert.match(onValidate.warnings[0], new RegExp(newest.outfitkit.replace(/\./g, '\\.')));

  const onPublish = checkOutfitkitFloor(dir, manifest, { publishing: true });
  assert.equal(onPublish.errors.length, 1, JSON.stringify(onPublish.errors));
  assert.match(onPublish.errors[0], /0\.1\.99/);
  assert.match(onPublish.errors[0], /min_erplora_version/, 'the message has to say what to declare');
});

test('the two ways out are priced, not just named', () => {
  // An escape hatch whose cost is hidden is not a choice, it is a trap: declaring the next tag
  // stops the module installing on the WHOLE live fleet until that tag ships (hub#521), and
  // rebuilding lower means moving `../outfitkit`, a checkout the author does not own.
  const { dir, manifest } = moduleDir({ stamp: '0.1.99' });
  const [blocked] = checkOutfitkitFloor(dir, manifest, { publishing: true }).errors;
  assert.match(blocked, /dejará de instalarse/, 'the cost of declaring the next tag');
  assert.match(blocked, /\.\.\/outfitkit/, 'the cost of rebuilding lower');
});

test('the block ALWAYS leaves a one-line way out, even when no hub ships the bake yet', () => {
  // A gate with no possible action is a gate somebody switches off. When not even the newest hub
  // carries what was baked there is no tag to name, so the message hands the author the NEXT one —
  // which is the true statement («this needs a hub newer than any published») and the one hub#521
  // turns into a refused install instead of a broken screen.
  const { dir, manifest } = moduleDir({ stamp: '0.1.99' });
  const [error] = checkOutfitkitFloor(dir, manifest, { publishing: true }).errors;
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

test('a stamp whose version is not a string WARNS: it never reaches the comparison', () => {
  // Mutant M-A (reviewer of #202): `typeof value === 'string' && value ? value : null` →
  // `value ?? null` stayed 17/17 green. It is not cosmetic — `{"outfitkit": 159}` then reaches
  // `compareOutfitkitVersions(159, …)`, which reads it as `[159]` and makes 159 NEWER than
  // everything, so a typo in someone else's artifact turns into a hard block. The header of
  // `readStamp` promised to cover «JSON roto o sin la clave», and only the first half was tested.
  for (const body of ['{ "outfitkit": 159 }', '{}', '{ "outfitkit": "" }', '{ "outfitkit": null }']) {
    const { dir, manifest } = moduleDir({});
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'outfitkit.json'), body);
    const { errors, warnings } = checkOutfitkitFloor(dir, manifest, { publishing: true });
    assert.deepEqual(errors, [], `${body} must not block`);
    assert.equal(warnings.length, 1, `${body}: expected one warning, got ${JSON.stringify(warnings)}`);
  }
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

test('`validate({ publishing })` BLOCKS what plain validate only warns about', async () => {
  // The publishing door is `erplora pack`, and packing needs esbuild + lit — dependencies the CI
  // gate of the module repos cannot install (ERPlora/pm#107), so driving `pack` end to end here
  // would make this suite unrunnable in the one place it has to run. What IS driven is the real
  // `validate` with the flag `pack` passes, plus the wiring assertion below. Between the two there
  // is no gap: the flag is honoured, and it is handed over.
  const { validate } = await import('../src/validate.mjs');
  const dir = validatableModule({ stamp: '0.1.99' });
  await assert.rejects(
    () => validate(dir, { publishing: true }),
    (err) => /module-toolkit#201/.test(err.message) && /0\.1\.99/.test(err.message),
    'packing a module no hub can paint has to fail',
  );
  // And the same module, without the flag, goes through.
  await validate(dir);
});

test('`erplora pack` is what turns the warning into a block: it hands over the flag', () => {
  // Mutant-proofing the seam. Dropping `{ publishing: true }` in `pack.mjs` would leave every unit
  // test green while the marketplace door stayed open — the same «correct and unreachable» shape
  // this file already guards against with its CLI tests.
  const pack = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pack.mjs'),
    'utf8',
  );
  assert.match(
    pack,
    /await validate\(dir, \{[^}]*publishing: true/,
    '`pack` must call `validate` with `publishing: true`, or nothing ever blocks a publication',
  );
});

test('`erplora validate` FAILS when the declared floor does not reach the bake', () => {
  const res = runValidate(
    validatableModule({ stamp: '0.1.58', compatibility: { min_erplora_version: '1.1.0' } }),
  );
  assert.equal(res.status, 1, `expected a red validate, got ${res.status}:\n${res.out}`);
  assert.match(res.out, /1\.1\.0/);
});

test('`erplora validate` PRINTS the warning: the only channel that asks for the table row', () => {
  // Mutant M-J (reviewer of #202): deleting the `console.warn` loop from the wiring left 17/17
  // green. That loop is the only thing that ever says «add the tag to HUB_OUTFITKIT» — and with
  // the ratchet above it is also how a module learns it is ahead of the fleet. A warning nobody
  // can see is the same defect as a check nobody calls.
  const res = runValidate(
    validatableModule({ stamp: '0.1.99', compatibility: { min_erplora_version: '9.9.9' } }),
  );
  assert.equal(res.status, 0, `a floor above the table must not block:\n${res.out}`);
  assert.match(res.out, /⚠/, `the warning never reached the terminal:\n${res.out}`);
  assert.match(res.out, /HUB_OUTFITKIT/, `the warning has to say what to do:\n${res.out}`);
});

test('`erplora validate` WARNS instead of blocking a bake ahead of the fleet', () => {
  const res = runValidate(validatableModule({ stamp: '0.1.99' }));
  assert.equal(res.status, 0, `validate must not block on the shared checkout:\n${res.out}`);
  assert.match(res.out, /⚠/, `the module has to be told, out loud:\n${res.out}`);
  assert.match(res.out, /0\.1\.99/);
});

test('`erplora validate` stays GREEN on what the fleet can paint', () => {
  const res = runValidate(validatableModule({ stamp: newestKnownHub().outfitkit }));
  assert.equal(res.status, 0, `a module the fleet CAN paint must not be blocked:\n${res.out}`);
});
