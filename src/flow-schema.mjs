// The flow document schema, read from ONE source (module-toolkit#209).
//
// The authority is `ERPlora/hub → schemas/flow.schema.json` — and behind it the runtime itself
// (`crates/runtime/src/flows/def.rs`, kept in step by `flow_schema_matches_the_runtime.rs`). What
// lives here is a VENDORED copy, byte for byte, for the same reason the manifest schema is: the
// gate of the 27 module repos runs on a runner with no checkout of the hub.
//
// WHY IT HAD TO BE VENDORED. The only thing judging a `*.flow.json` was the module's own battery
// (`whatsapp_inbox/tests/flow_templates.test.py`), which loads this schema from a NEIGHBOURING hub
// checkout and skips itself when there is none — so on CI it never ran (measured in
// whatsapp_inbox#75). A document with an unknown step kind or a `schema_version` the hub refuses
// would publish green and die on install, in a customer's hub, with the module already out.
//
// `test/canonical-mirrors.test.mjs` fails the moment this copy and the hub's differ, and
// `npm run sync-mirrors` is what refreshes it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export const VENDORED_FLOW_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'schemas',
  'flow.schema.json',
);

let cached = null;

/** The canonical flow document schema, parsed (read once per process). */
export function loadFlowSchema() {
  if (!cached) cached = JSON.parse(readFileSync(VENDORED_FLOW_SCHEMA_PATH, 'utf8'));
  return cached;
}
