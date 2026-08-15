// The manifest schema, read from ONE source (module-toolkit#30, #40).
//
// The authority is `ERPlora/hub → schemas/module.schema.json`. What lives here is a VENDORED copy,
// byte for byte, because the gate of the 25 module repos runs on a runner with no checkout of the
// hub: a schema the validator had to go and find would switch the check off in the very door where
// it matters. The copy is not a hand-kept mirror — `npm run sync-schema` refreshes it and
// `test/canonical-mirrors.test.mjs` fails the moment the two differ.
//
// What it replaces: `validate.mjs` declared itself, in its first line, a "mirror of
// module.schema.json" and REIMPLEMENTED it field by field. A new manifest block passed the author's
// `erplora validate` and was rejected by the runtime on install — or the other way round, which is
// worse, because then the module ships and the failure surfaces on a customer's hub.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const VENDORED_MANIFEST_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'module.schema.json',
);

let cached = null;

/** The canonical manifest schema, parsed (read once per process). */
export function loadManifestSchema() {
  if (!cached) cached = JSON.parse(readFileSync(VENDORED_MANIFEST_SCHEMA_PATH, 'utf8'));
  return cached;
}
