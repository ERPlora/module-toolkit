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
//   5. the PREMISE of the `fill`/`mode="md"` guard — that the shell pins Ionic to `ios`
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BRIDGE_FUNCTIONS } from '../src/validate-sql.mjs';
import { VENDORED_MANIFEST_SCHEMA_PATH } from '../src/manifest-schema.mjs';
import { REFUSED_PATHS, RETIRED_FIELDS } from '../src/validate-manifest-keys.mjs';
import { CORE_OPERATIONS } from '../src/contracts.mjs';
import { GRANDFATHERED } from '../src/validate-migration-guard.mjs';
import { controlsWithDeadFill } from '../src/validate-ionic-fill.mjs';
import { hubPath } from './hub-mirror.mjs';


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
  return [...block[1].matchAll(/\(\s*"([^"]+)",\s*"([^"]+)"\s*\)/g)].map((m) => [m[1], m[2]]);
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
 * The verbs the runtime's `contract` translator sets aside instead of executing, and whether it
 * decides on the SQL or on the raw statement text.
 *
 * `fn set_aside_instead_of_dropping(statement: &str) -> String { … }` — the body up to the first
 * column-0 `}`.
 */
function contractTranslatorOfTheRuntime(rust) {
  const fn = /fn set_aside_instead_of_dropping\(statement: &str\) -> String \{([\s\S]*?)\n\}/.exec(rust);
  assert.ok(
    fn,
    'set_aside_instead_of_dropping is no longer declared like this in migration_guard.rs — update the reader',
  );
  const body = fn[1];
  return {
    // Each verb is written twice in the body (`find(…)` and `…".len()`), hence the Set.
    verbs: [...new Set([...body.matchAll(/"\s?(DROP [A-Z]+)\s?"/g)].map((m) => m[1]))].sort(),
    decidesOnStrippedSql: /strip_comments\(/.test(body),
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
});
