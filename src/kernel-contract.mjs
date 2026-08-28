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

/** Where the six vendored files live, in this repository. */
export const VENDORED_KERNEL_CONTRACT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'contracts',
  'kernel',
);

/** The hub path the copy comes from, as segments (`hubPath(t, ...KERNEL_CONTRACT_HUB_PATH)`). */
export const KERNEL_CONTRACT_HUB_PATH = ['contracts', 'kernel'];

/**
 * The files of the contract, sorted. Not a glob on purpose: the hub adding a seventh surface has
 * to be a decision here too, and `canonical-mirrors.test.mjs` compares this list against the hub's
 * own directory so the addition cannot pass unnoticed.
 */
export const KERNEL_CONTRACT_FILES = [
  'README.md',
  'engine.snapshot',
  'guest.snapshot',
  'routes.snapshot',
  'sdk.d.ts',
  'tables.snapshot',
];
