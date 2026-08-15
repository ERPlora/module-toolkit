// The manifest schema is READ, not reimplemented (module-toolkit#30, #40). `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadManifestSchema, VENDORED_MANIFEST_SCHEMA_PATH } from '../src/manifest-schema.mjs';

test('the vendored schema travels INSIDE the package', () => {
  // Vendored on purpose: the gate of the 25 module repos runs with no checkout of the hub, so a
  // schema the validator had to go and find would leave the check switched off in the one door
  // where it matters.
  assert.ok(existsSync(VENDORED_MANIFEST_SCHEMA_PATH), 'schemas/module.schema.json ships with the package');
});

test('the schema carries the contract the validator checks against', () => {
  const schema = loadManifestSchema();
  assert.equal(schema.additionalProperties, false, 'the root of the manifest is closed');
  assert.deepEqual(schema.required, ['id', 'name', 'version']);
  assert.deepEqual(
    Object.keys(schema.properties.events.properties),
    ['listen', 'emits'],
    'the block nobody looked at, and through which `events.emit` (singular) lived for months',
  );
});

test('it is parsed once per process', () => {
  assert.equal(loadManifestSchema(), loadManifestSchema(), 'same instance: cached');
});
