// The hub's FROZEN kernel surface, vendored here (module-toolkit#115).
//
// The authority is `ERPlora/hub → contracts/kernel/`, created by the ADR «El Hub se CIERRA como
// KERNEL» (2026-08-27, ERPlora/hub#1235): six files that the hub's own tests GENERATE from its code
// and compare against the committed copy, so that what the kernel promises a published module is a
// reviewable `diff` instead of a claim. It is the same shape Kotlin (`apiCheck`), .NET
// (`PublicApiAnalyzers`) and `cargo-semver-checks` use.
//
// WHY A COPY LIVES HERE. The toolkit is the door 26 module repos walk through, and their gate runs
// on a runner with no checkout of the hub. Vendoring the contract is what lets this repository — and
// anyone reading it — see the surface a module is being built against without cloning the hub. It
// is the exact reasoning of `schemas/module.schema.json` (src/manifest-schema.mjs), and it carries
// the exact same risk: a copy that silently drifts is worse than no copy. Hence the mirrors in
// `test/canonical-mirrors.test.mjs`, byte for byte, one per file plus one on the SET of files, and
// `npm run sync-mirrors` as the only sanctioned way to refresh them.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

/** Where the five vendored snapshots live, in this repository. */
export const VENDORED_KERNEL_CONTRACT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'contracts',
  'kernel',
);

/** The hub path the copy comes from, as segments (`hubPath(t, ...KERNEL_CONTRACT_HUB_PATH)`). */
export const KERNEL_CONTRACT_HUB_PATH = ['contracts', 'kernel'];

/**
 * The files of the contract that are MIRRORED here, sorted. Not a glob on purpose: the hub adding a
 * sixth surface has to be a decision here too, and `canonical-mirrors.test.mjs` compares this list
 * (together with `KERNEL_CONTRACT_NOT_MIRRORED`) against the hub's own directory, so the addition
 * cannot pass unnoticed.
 */
export const KERNEL_CONTRACT_FILES = [
  'engine.snapshot',
  'guest.snapshot',
  'routes.snapshot',
  'sdk.d.ts',
  'tables.snapshot',
];

/**
 * What the hub keeps in `contracts/kernel/` and this repository deliberately does NOT copy
 * (module-toolkit#121).
 *
 * `README.md` is prose, and prose is not contract: it is addressed to whoever works IN the hub —
 * `cargo` invocations, `crates/runtime/tests/…` paths, workflow names — none of which exists here,
 * none of which can be run here, and none of which a published module consumes. Mirroring it byte
 * for byte made every DOCUMENTATION edit of the hub a red build of this repository and a two-repo
 * lockstep for it: hub#1263 and hub#1265 moved neither a route, nor the engine, nor the guest, nor
 * the tables, nor the SDK, and broke the mirror all the same. An alarm that fires on prose is one
 * people learn to mute, and then it stops reporting the `routes.snapshot` that does matter.
 *
 * It is still ENUMERATED rather than merely dropped: an unnamed file in the hub's directory is an
 * unwatched file, and the whole reason the SET is asserted is that a surface the hub freezes must
 * not slip past for not being on a list.
 */
export const KERNEL_CONTRACT_NOT_MIRRORED = ['README.md'];
