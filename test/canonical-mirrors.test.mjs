// The hub's mirrors, with an alarm on them (module-toolkit#40). `node --test`.
//
// The toolkit copies by hand three things whose authority lives in `ERPlora/hub`:
//
//   1. the set of `erp_*` bridge functions the runtime's shim knows how to rewrite
//      (`crates/db/src/lib.rs::BRIDGE_FUNCTIONS`),
//   2. the manifest schema (`schemas/module.schema.json`), carried VENDORED — byte for byte —
//      because the gate of the 25 module repos runs with no checkout of the hub,
//   3. the severity policy for unknown manifest keys (`manifest.rs::refuses_unknown_fields` and
//      `RETIRED_FIELDS`), so the author's door and the install door say the same thing,
//   4. the capabilities of the core's reserved `hub.` namespace
//      (`hub_users.rs::CORE_QUERIES`), which the contract gate rejects a module for consuming
//      when it does not know them,
//   5. the FROZEN kernel surface (`contracts/kernel/`), the five snapshots the hub generates from
//      its own code to say what it promises a published module — vendored whole, because the gate
//      of the 26 module repos has no hub in reach either. Its README is prose, not contract, and
//      is deliberately left out (module-toolkit#121),
//   6. the PREMISE of the `fill`/`mode="md"` guard — that the shell pins Ionic to `ios`
//      (`apps/web/src/main.ts`, ADR-0143). This one is the opposite of the others: it does not
//      guard a divergence, it guards the guard's own reason to exist.
//
// None of them was out of sync the day this was written, and that is exactly when the alarm goes
// on: whoever adds the twelfth bridge function in Rust has no way of learning there is a second
// place, and the symptom would be portable SQL the validator rejects — or, worse, SQL that is not
// portable and it waves through.
//
// WHERE THESE ACTUALLY RUN (module-toolkit#61). They used to skip themselves whenever the hub was
// not alongside, on the reasoning that the divergence can only be introduced by editing the hub —
// which is true, and is exactly why the skip was a hole: the toolkit's CI has no hub, so all six
// went `pass 0 · fail 0 · skipped 7` on every run and the job went green, while the ONE machine
// that edits the hub had nothing asking it to resync.
//
// So the door moved to where the change happens: the hub's own CI calls
// `.github/actions/check-canonical-mirrors` (this repository, resolved with no credential because
// its Actions are shared with the organization) and runs this file with `ERPLORA_HUB_DIR` pointing
// at the hub it just checked out. Here, with no hub declared, they still skip — honestly, saying
// so. What is no longer allowed is a hub that was DECLARED and is not there: that is an error, and
// `hub-mirror.mjs` is where the two cases are told apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_FUNCTIONS } from '../src/validate-sql.mjs';
import { VENDORED_MANIFEST_SCHEMA_PATH } from '../src/manifest-schema.mjs';
import { REFUSED_PATHS, RETIRED_FIELDS } from '../src/validate-manifest-keys.mjs';
import { CORE_OPERATIONS } from '../src/contracts.mjs';
import { GRANDFATHERED } from '../src/validate-migration-guard.mjs';
import { controlsWithDeadFill } from '../src/validate-ionic-fill.mjs';
import {
  KERNEL_CONTRACT_FILES,
  KERNEL_CONTRACT_HUB_PATH,
  KERNEL_CONTRACT_NOT_MIRRORED,
  VENDORED_KERNEL_CONTRACT_DIR,
} from '../src/kernel-contract.mjs';
import { hubPath, hubTags } from './hub-mirror.mjs';
import { HUB_OUTFITKIT } from '../src/validate-outfitkit-floor.mjs';


/** `pub const BRIDGE_FUNCTIONS: &[&str] = &["erp_now", …];` → the names, in order. */
function bridgeFunctionsOfTheShim(rust) {
  const block = /pub const BRIDGE_FUNCTIONS:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\]\s*;/.exec(rust);
  assert.ok(block, 'BRIDGE_FUNCTIONS is no longer declared like this in crates/db/src/lib.rs — update the reader');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The body of the runtime's `fn refuses_unknown_fields` → the paths where it refuses. */
function refusedPathsOfTheRuntime(rust) {
  const fn = /fn refuses_unknown_fields\([\s\S]*?matches!\(([\s\S]*?)\)\s*\n\}/.exec(rust);
  assert.ok(fn, 'refuses_unknown_fields is no longer declared like this in manifest.rs — update the reader');
  return [...fn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** The runtime's `RETIRED_FIELDS` → the (path, field) pairs. */
function retiredFieldsOfTheRuntime(rust) {
  const block = /pub const RETIRED_FIELDS:[\s\S]*?=\s*&\[([\s\S]*?)\]\s*;/.exec(rust);
  assert.ok(block, 'RETIRED_FIELDS is no longer declared like this in manifest.rs — update the reader');
  return [...block[1].matchAll(/\(\s*\n?\s*"([^"]+)",\s*\n?\s*"([^"]+)",/g)].map((m) => [m[1], m[2]]);
}

test('the toolkit bridge functions are EXACTLY the shim of the runtime (#40)', (t) => {
  const lib = hubPath(t, 'crates', 'db', 'src', 'lib.rs');
  if (!lib) return;
  assert.deepEqual(
    BRIDGE_FUNCTIONS,
    bridgeFunctionsOfTheShim(readFileSync(lib, 'utf8')),
    'validator and shim must accept the same set: adding an erp_* to the runtime means adding it ' +
      'to src/validate-sql.mjs too',
  );
});

test('the severity policy is the SAME one the runtime applies (#30, hub#521)', (t) => {
  // The author's door and the install door have to agree: a field the hub refuses on install cannot
  // pass the gate green, and one the hub tolerates cannot take down the CI of 25 repos. Both lists
  // are short and the divergence would be silent — hence the alarm.
  const rs = hubPath(t, 'crates', 'runtime', 'src', 'manifest.rs');
  if (!rs) return;
  const rust = readFileSync(rs, 'utf8');
  assert.deepEqual(REFUSED_PATHS, refusedPathsOfTheRuntime(rust), 'where an unknown key is REFUSED');
  assert.deepEqual(
    RETIRED_FIELDS.map(([p, f]) => [p, f]),
    retiredFieldsOfTheRuntime(rust),
    'which names are retired (they install, reported by name)',
  );
});

test('the vendored schema is byte for byte the hub one (#40)', (t) => {
  const canonical = hubPath(t, 'schemas', 'module.schema.json');
  if (!canonical) return;
  assert.equal(
    readFileSync(VENDORED_MANIFEST_SCHEMA_PATH, 'utf8'),
    readFileSync(canonical, 'utf8'),
    'schemas/module.schema.json moved on in the hub — resync it with `npm run sync-schema`',
  );
});

/** The runtime's `CORE_QUERIES` → the fully-qualified names, in order. */
function coreQueriesOfTheRuntime(rust) {
  const block = /const CORE_QUERIES:\s*&\[&str\]\s*=\s*\n?\s*&\[([\s\S]*?)\]\s*;/.exec(rust);
  assert.ok(block, 'CORE_QUERIES is no longer declared like this in hub_users.rs — update the reader');
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => `hub.${m[1]}`);
}

test('the core capabilities the gate accepts are EXACTLY the runtime\'s (#297)', (t) => {
  // The fourth hand-copied mirror, and the one that had already drifted the day this alarm went on:
  // `hub.setup.status` and `hub.approvals.list` had been live in the runtime for weeks while the
  // gate still called them typos. This is the expensive direction of the drift — the module that
  // consumes a real core query is told it does not exist, and the author has no way of learning
  // that the list of capabilities has a second home.
  const rs = hubPath(t, 'crates', 'runtime', 'src', 'hub_users.rs');
  if (!rs) return;
  assert.deepEqual(
    CORE_OPERATIONS.queries,
    coreQueriesOfTheRuntime(readFileSync(rs, 'utf8')),
    'the runtime gained or lost a core query — mirror it in CORE_OPERATIONS (src/contracts.mjs)',
  );
});

/** The runtime's `GRANDFATHERED` → the `(module, file)` pairs, in order. */
function grandfatheredOfTheRuntime(rust) {
  const block = /pub const GRANDFATHERED:[\s\S]*?=\s*&\[([\s\S]*?)\n\]\s*;/.exec(rust);
  assert.ok(block, 'GRANDFATHERED is no longer declared like this in migration_guard.rs — update the reader');
  // The optional trailing comma is rustfmt's: a tuple it wraps across lines gets one before the
  // closing paren, and a reader that cannot see it silently DROPS those entries — which is how
  // hub#1287's rewrap made this mirror report drift that did not exist (module-toolkit#162).
  return [...block[1].matchAll(/\(\s*"([^"]+)",\s*"([^"]+)"\s*,?\s*\)/g)].map((m) => [m[1], m[2]]);
}

test('the grandfathered migrations are EXACTLY the runtime\'s (#51)', (t) => {
  // The fifth mirror, and the one whose divergence is the most expensive in BOTH directions. Short
  // here and the gate turns 9 published modules red without anyone touching them; long here and the
  // gate waves through a file the hub will refuse on install — which is the failure that cost the
  // 19/08 (four modules published green and did not install).
  //
  // 🔴 And it may only SHRINK on both sides at once: "grandfather it" is not a way to keep
  // publishing what the contract forbids.
  const rs = hubPath(t, 'crates', 'runtime', 'src', 'migration_guard.rs');
  if (!rs) return;
  assert.deepEqual(
    GRANDFATHERED.map(([m, f]) => [m, f]),
    grandfatheredOfTheRuntime(readFileSync(rs, 'utf8')),
    'the runtime changed its grandfathered list — mirror it in src/validate-migration-guard.mjs',
  );
});

test('the shell still pins Ionic to `ios` — the premise of the `fill` guard (hub#760)', (t) => {
  // The sixth mirror, and the only one whose failure means DELETE THE CHECK rather than sync it.
  // `checkIonicFill` exists for one reason: with `mode: 'ios'` pinned, Ionic paints no `fill` on a
  // form control, so the attribute is a silent no-op and the field renders invisible. The day the
  // shell drops that pin — or moves to `md` — the guard would keep 25 repos writing `mode="md"` on
  // every input for a problem that no longer exists. A check that outlives its cause is worse than
  // no check: it teaches people that the gate asks for things that do not matter.
  //
  // The Hub carries its own copy of this same assertion (`apps/web/src/theme/
  // ionic-fill-needs-md.test.ts`), which is what makes it a MIRROR and not a duplicate: that one
  // runs where the change happens, this one runs where the 25 module repos are gated.
  const main = hubPath(t, 'apps', 'web', 'src', 'main.ts');
  if (!main) return;
  assert.match(
    readFileSync(main, 'utf8'),
    /use\(IonicVue,\s*\{[^}]*mode:\s*'ios'/,
    'the shell no longer pins `ios`: `fill` now paints on its own and src/validate-ionic-fill.mjs ' +
      'is dead weight — delete it and drop the check from validate.mjs',
  );
});

test('the guard reads the Hub\'s OWN screens the same way the Hub does (hub#760)', (t) => {
  // The positive control of the scanner, against a corpus nobody wrote for it. The Hub's `.vue`
  // views are the one place where a set of controls is known to be CLEAN — its own guard keeps them
  // that way. If this port ever reported an offence there, the two doors would be saying different
  // things about the same markup, and the module authors would be the ones paying for it.
  const views = hubPath(t, 'apps', 'web', 'src');
  if (!views) return;
  const offenders = [];
  let controls = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.vue')) {
        const src = readFileSync(full, 'utf8');
        controls += (src.match(/<ion-(?:input|select|textarea)(?=[\s/>])/g) ?? []).length;
        for (const dead of controlsWithDeadFill(src)) offenders.push(`${full}: ${dead.tag}`);
      }
    }
  };
  walk(views);
  assert.ok(controls > 30, `only ${controls} controls found in the Hub views: the scan is not reaching them`);
  assert.deepEqual(offenders, [], 'this port disagrees with the Hub\'s own guard about the Hub\'s own markup');
});

/**
 * The verbs the runtime's `contract` translator sets aside instead of executing, whether it decides
 * on the SQL or on the raw statement text, and whether the `Kind::Contract` arm still refuses what
 * it cannot translate.
 *
 * `fn set_aside_instead_of_dropping(statement: &str) -> Result<String, GuardError> { … }` — the
 * body up to the first column-0 `}`.
 */
function contractTranslatorOfTheRuntime(rust) {
  const fn =
    /fn set_aside_instead_of_dropping\(statement: &str\) -> Result<String, GuardError> \{([\s\S]*?)\n\}/.exec(
      rust,
    );
  assert.ok(
    fn,
    'set_aside_instead_of_dropping is no longer declared like this in migration_guard.rs — update the reader',
  );
  const body = fn[1];
  return {
    // Each verb is written twice in the body (`find(…)` and `…".len()`), hence the Set.
    verbs: [...new Set([...body.matchAll(/"\s?(DROP [A-Z]+)\s?"/g)].map((m) => m[1]))].sort(),
    decidesOnStrippedSql: /strip_comments\(/.test(body),
    // ERPlora/hub#1145: what the translator cannot set aside must not go through. The `check`
    // function's `Kind::Contract` arm calls this before translating.
    refusesWhatItCannotTranslate:
      /fn row_destroying_verb\(/.test(rust) &&
      /Kind::Contract => \{[\s\S]*?row_destroying_verb\(&statement\)/.test(rust),
    refusesADropOfMoreThanOne: /GuardError::DropsMoreThanOne \{/.test(body),
  };
}

test('the runtime still translates only the DROPs this door assumes it does (hub#1137)', (t) => {
  // The seventh mirror, and the one that guards an ABSENCE. `checkMigrationSql` deliberately does
  // not port the rewrite half — see its doc comment — on the reasoning that this door only has to
  // say whether the hub will ACCEPT a file, and rewriting SQL nobody here executes would be a
  // second place to get it wrong. That reasoning holds exactly while the rewrite covers what a
  // `contract` is allowed to contain. The day the runtime translates a third verb (or stops
  // translating one), a `contract` this door waves through starts meaning something else on
  // install — and there is nothing in this repository that would say so.
  //
  // `decidesOnStrippedSql` is the hub#1137 half. The translator used to match `DROP TABLE ` at the
  // START of the statement TEXT, and the splitter keeps a preceding comment INSIDE the statement
  // it precedes (hub#1027) — so a header comment above the first `DROP` made the match miss and
  // the hub ran a real, irreversible `DROP TABLE` on a customer's database. Every published
  // migration opens with a block of prose, so this door says "green" to the exact shape that broke
  // it. If the decision ever moves back onto the raw text, the module authors are the ones who pay.
  const rs = hubPath(t, 'crates', 'runtime', 'src', 'migration_guard.rs');
  if (!rs) return;
  const translator = contractTranslatorOfTheRuntime(readFileSync(rs, 'utf8'));

  assert.deepEqual(
    translator.verbs,
    ['DROP COLUMN', 'DROP TABLE'],
    'the runtime\'s `contract` translator changed which DROPs it sets aside — revisit the ' +
      '"deliberately NOT ported" note in src/validate-migration-guard.mjs before syncing anything',
  );
  assert.ok(
    translator.decidesOnStrippedSql,
    'set_aside_instead_of_dropping no longer strips comments before deciding: a header comment ' +
      'above the first `DROP` defeats the translation again and the hub runs a REAL `DROP TABLE` ' +
      'on a customer database (hub#1137)',
  );
  // The other half of the same reasoning (hub#1145): the list above is only safe while everything
  // it does NOT cover is refused. If `Kind::Contract` goes back to translating whatever arrives and
  // letting the rest through, a `TRUNCATE` runs for real on a customer's rows and this door — which
  // ports the verdict, not the rewrite — would keep saying green.
  assert.ok(
    translator.refusesWhatItCannotTranslate,
    'the runtime\'s `Kind::Contract` arm no longer calls `row_destroying_verb`: a `contract` ' +
      'carrying `TRUNCATE`/`DELETE FROM` destroys rows with no `_deprecated_*` to go back to ' +
      '(hub#1145). Resync `rowDestroyingVerb` in src/validate-migration-guard.mjs',
  );
  assert.ok(
    translator.refusesADropOfMoreThanOne,
    'set_aside_instead_of_dropping no longer refuses a `DROP` that names more than one thing: the ' +
      'translation is one statement in, one statement out, and taking the first name emitted ' +
      '`ALTER TABLE a, RENAME TO _deprecated_a,` (hub#1145). Resync `dropsMoreThanOne`',
  );
});

// ── The FROZEN kernel surface (module-toolkit#115) ─────────────────────────────────────────────
//
// The eighth mirror, and the widest: `contracts/kernel/` is the whole surface the hub promises a
// published module — its routes, the declarative engine, the WASM guest contract, the system
// tables and the `@erplora/module-sdk` types — frozen by the ADR «El Hub se CIERRA como KERNEL»
// (2026-08-27) into files the hub's own tests generate from its code.
//
// It is vendored for the same reason the manifest schema is (src/kernel-contract.mjs): the gate of
// the 26 module repos runs with no hub in reach. And it is mirrored here rather than trusted
// because the drift is SILENT in the direction that costs most — the hub freezes a new surface,
// the copy the module authors read still describes the old one, and nothing anywhere says so.
//
// Byte for byte, one test per file: a diff that names WHICH of the five moved is the whole point
// of keeping the surface in files instead of in prose.
//
// FIVE, not six: the hub's `contracts/kernel/README.md` is deliberately NOT mirrored
// (module-toolkit#121). It is prose addressed to whoever works IN the hub — `cargo` commands,
// `crates/runtime/tests/…` paths, workflow names — none of which exists or can be run here, and
// none of which a published module consumes. Mirroring it byte for byte turned every DOCUMENTATION
// edit of the hub into a red build of this repository and a two-repo lockstep for it: hub#1263 and
// hub#1265 moved neither a route, nor the engine, nor the guest, nor the tables, nor the SDK, and
// broke the mirror all the same. An alarm that fires on prose is an alarm people mute, and a muted
// alarm no longer reports the `routes.snapshot` that does matter (W21, hub#1262). It stays
// ENUMERATED, in `KERNEL_CONTRACT_NOT_MIRRORED`, so the set test below still catches a SIXTH
// frozen surface: what is not enumerated is not watched.
for (const file of KERNEL_CONTRACT_FILES) {
  test(`the vendored kernel contract \`${file}\` is byte for byte the hub one (#115)`, (t) => {
    const canonical = hubPath(t, ...KERNEL_CONTRACT_HUB_PATH, file);
    if (!canonical) return;
    const vendored = join(VENDORED_KERNEL_CONTRACT_DIR, file);
    assert.ok(
      existsSync(vendored),
      `contracts/kernel/${file} is not vendored in this repository: the hub froze a surface and ` +
        'the copy the module authors read does not carry it — `npm run sync-mirrors`',
    );
    assert.equal(
      readFileSync(vendored, 'utf8'),
      readFileSync(canonical, 'utf8'),
      `contracts/kernel/${file} moved on in the hub — resync it with \`npm run sync-mirrors\`. ` +
        'Read the diff before syncing: this file IS the promise made to every published module, ' +
        'so a change in it is a change in what the 26 repos are built against',
    );
  });
}

test('the vendored kernel contract carries EXACTLY the files the hub freezes (#115, #121)', (t) => {
  // The member tests above compare five named files; this one guards the SET. Without it the hub
  // can add a sixth snapshot — a new frozen surface, which is precisely the event worth
  // noticing — and every mirror stays green because nobody is asked about the file that is not on
  // the list. Same failure the `CANNOT_RUN_IN_CI` ghosts check exists for: what is not enumerated
  // is not watched.
  //
  // Hence the two lists rather than one (module-toolkit#121). Dropping README.md by simply not
  // naming it anywhere would have re-opened exactly that hole — an unnamed file in the hub's
  // directory is an unwatched file — so what is NOT mirrored is declared too, and the hub's
  // directory is still asserted whole against the union.
  const canonicalDir = hubPath(t, ...KERNEL_CONTRACT_HUB_PATH);
  if (!canonicalDir) return;
  assert.deepEqual(
    readdirSync(canonicalDir).sort(),
    [...KERNEL_CONTRACT_FILES, ...KERNEL_CONTRACT_NOT_MIRRORED].sort(),
    'the hub\'s contracts/kernel/ no longer holds these exact files — the hub froze (or dropped) a ' +
      'surface: add it to KERNEL_CONTRACT_FILES in src/kernel-contract.mjs and run ' +
      '`npm run sync-mirrors`, or, if it is prose rather than contract, to KERNEL_CONTRACT_NOT_MIRRORED',
  );
  assert.ok(
    existsSync(VENDORED_KERNEL_CONTRACT_DIR),
    'contracts/kernel/ is not vendored in this repository at all — `npm run sync-mirrors`',
  );
  assert.deepEqual(
    readdirSync(VENDORED_KERNEL_CONTRACT_DIR).sort(),
    [...KERNEL_CONTRACT_FILES].sort(),
    'the vendored contracts/kernel/ holds something other than the declared files',
  );
});

test('the kernel prose the hub keeps is NOT vendored here (#121)', () => {
  // Regression test for ERPlora/module-toolkit#121. The two lists have to stay DISJOINT, and the
  // not-mirrored side has to stay actually absent: leaving a stale `README.md` behind on disk while
  // the mirror stopped comparing it is the worst of the two worlds — a file in `contracts/kernel/`
  // that reads like the hub's documentation, is not, and nothing checks.
  for (const file of KERNEL_CONTRACT_NOT_MIRRORED) {
    assert.ok(
      !KERNEL_CONTRACT_FILES.includes(file),
      `${file} is declared both as mirrored and as not mirrored — the lists must be disjoint`,
    );
    assert.ok(
      !existsSync(join(VENDORED_KERNEL_CONTRACT_DIR, file)),
      `contracts/kernel/${file} is still vendored here while nothing compares it any more: a copy ` +
        'nobody checks is worse than no copy — delete it',
    );
  }
});

// ── The seventh mirror: `HUB_OUTFITKIT` (module-toolkit#201) ───────────────────────────────────
//
// The table that says which OutfitKit each hub image carries is DERIVED, not read: the hub's
// Dockerfile installs `@erplora/outfitkit@latest` with a cachebust, so the version of an image is
// only deducible from WHEN it was built. That makes the table a mirror of the hub like the six
// above — and it was the only one with nothing watching it. Two things could rot in silence:
//
//   * a row could be wrong, or simply invented. Verified in review: adding a row for a tag that
//     does not exist (`1.1.14 → 0.1.65`) left the suite 17/17 green.
//   * the fleet could publish a NEW tag and nobody add it. That one is worse than untidy: the
//     check would then say «no hub ships OutfitKit 0.1.60» about a module the fleet paints fine.
//
// The README said «keeping it up to date is part of publishing the hub», and that is memory, not
// mechanism. This is the mechanism. It reads the neighbouring hub's TAGS — refs, so no working
// tree is involved — and skips honestly when there is no hub, exactly like the other six.

test('every row of HUB_OUTFITKIT names a REAL hub tag, dated as the tag is (#201)', (t) => {
  const tags = hubTags(t, 'v1.1.*');
  if (!tags) return;
  const wrong = [];
  for (const row of HUB_OUTFITKIT) {
    const built = tags.get(`v${row.hub}`);
    if (!built) {
      wrong.push(`${row.hub}: there is no tag \`v${row.hub}\` in ERPlora/hub — invented row`);
      continue;
    }
    if (Date.parse(built) !== Date.parse(row.built_at)) {
      wrong.push(`${row.hub}: built_at says ${row.built_at}, the tag was created ${built}`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    'HUB_OUTFITKIT (module-toolkit/src/validate-outfitkit-floor.mjs) drifted from the hub tags. ' +
      'Every row is «the last @erplora/outfitkit published on npm before this tag was created», ' +
      'so a wrong date is a wrong OutfitKit and the floor check answers with it',
  );
});

test('the NEWEST hub tag is in HUB_OUTFITKIT: publishing the hub adds its row (#201)', (t) => {
  const tags = hubTags(t, 'v1.1.*');
  if (!tags) return;
  const newestTag = [...tags.keys()].sort((a, b) => Date.parse(tags.get(a)) - Date.parse(tags.get(b))).at(-1);
  assert.ok(
    HUB_OUTFITKIT.some((row) => `v${row.hub}` === newestTag),
    `ERPlora/hub published ${newestTag} and HUB_OUTFITKIT does not know it. Until the row is ` +
      'added, `erplora validate` measures modules against a fleet that no longer exists — it will ' +
      'warn that «no hub ships OutfitKit X» about screens the fleet paints perfectly. Add the row ' +
      "(the last `@erplora/outfitkit` published before that tag's creation date), or close " +
      'hub#1588 so the build publishes the version and the table stops being derived',
  );
});
