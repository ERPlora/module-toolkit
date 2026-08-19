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
//      when it does not know them.
//
// None of them was out of sync the day this was written, and that is exactly when the alarm goes
// on: whoever adds the twelfth bridge function in Rust has no way of learning there is a second
// place, and the symptom would be portable SQL the validator rejects — or, worse, SQL that is not
// portable and it waves through.
//
// These tests SKIP themselves when the hub is not alongside (the gate's runner does not have it).
// That is not a hole: the divergence can only be introduced by editing the hub, and that happens on
// a machine where the whole monorepo IS checked out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { BRIDGE_FUNCTIONS } from '../src/validate-sql.mjs';
import { VENDORED_MANIFEST_SCHEMA_PATH } from '../src/manifest-schema.mjs';
import { REFUSED_PATHS, RETIRED_FIELDS } from '../src/validate-manifest-keys.mjs';
import { CORE_OPERATIONS } from '../src/contracts.mjs';
import { GRANDFATHERED } from '../src/validate-migration-guard.mjs';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The hub checkout, when it sits alongside (or wherever `ERPLORA_HUB_DIR` says). */
const HUB = process.env.ERPLORA_HUB_DIR || join(TOOLKIT, '..', 'hub');

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
  const lib = join(HUB, 'crates', 'db', 'src', 'lib.rs');
  if (!existsSync(lib)) return t.skip('ERPlora/hub is not in this checkout');
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
  const rs = join(HUB, 'crates', 'runtime', 'src', 'manifest.rs');
  if (!existsSync(rs)) return t.skip('ERPlora/hub is not in this checkout');
  const rust = readFileSync(rs, 'utf8');
  assert.deepEqual(REFUSED_PATHS, refusedPathsOfTheRuntime(rust), 'where an unknown key is REFUSED');
  assert.deepEqual(
    RETIRED_FIELDS.map(([p, f]) => [p, f]),
    retiredFieldsOfTheRuntime(rust),
    'which names are retired (they install, reported by name)',
  );
});

test('the vendored schema is byte for byte the hub one (#40)', (t) => {
  const canonical = join(HUB, 'schemas', 'module.schema.json');
  if (!existsSync(canonical)) return t.skip('ERPlora/hub is not in this checkout');
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
  const rs = join(HUB, 'crates', 'runtime', 'src', 'hub_users.rs');
  if (!existsSync(rs)) return t.skip('ERPlora/hub is not in this checkout');
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
  const rs = join(HUB, 'crates', 'runtime', 'src', 'migration_guard.rs');
  if (!existsSync(rs)) return t.skip('ERPlora/hub is not in this checkout');
  assert.deepEqual(
    GRANDFATHERED.map(([m, f]) => [m, f]),
    grandfatheredOfTheRuntime(readFileSync(rs, 'utf8')),
    'the runtime changed its grandfathered list — mirror it in src/validate-migration-guard.mjs',
  );
});
