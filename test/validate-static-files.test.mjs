// `static_files.folder` is a single safe segment, checked against the canonical schema. `node --test`.
//
// The case behind it: the manifest declares a folder name and the Hub resolves the backend under
// `media/modules/`. The runtime already REFUSES a traversal at install time
// (`hub/crates/runtime/tests/module_static_files.rs::install_rejects_static_files_path_traversal`,
// on `"folder": "../archive"`), but `erplora validate` said "manifest OK" for that very manifest:
// the schema carries the `pattern`, and nothing read it. That is the exact split
// `manifest-schema.mjs` exists to close — the author's door passing what the runtime then rejects,
// which surfaces on a customer's hub instead of on the author's machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkManifestKeys } from '../src/validate-manifest-keys.mjs';
import { loadManifestSchema } from '../src/manifest-schema.mjs';

const base = () => ({ id: 'demo', name: 'Demo', version: '1.0.0' });

test('a single safe segment says nothing', () => {
  const { errors } = checkManifestKeys({ ...base(), static_files: { folder: 'verifactu' } });
  assert.deepEqual(errors, [], 'what `verifactu` ships today stays valid');
});

test('a traversal folder is an ERROR, the same one the runtime raises on install', () => {
  const { errors } = checkManifestKeys({ ...base(), static_files: { folder: '../archive' } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /static_files\.folder/);
  assert.match(errors[0], /\.\.\/archive/, 'and it quotes the value, so the author sees what to fix');
});

test('an absolute path or a nested segment is refused too: it is a NAME, not a route', () => {
  for (const folder of ['/etc/passwd', 'a/b', './x', '..']) {
    const { errors } = checkManifestKeys({ ...base(), static_files: { folder } });
    assert.equal(errors.length, 1, `refused: ${folder}`);
  }
});

test('the shape rules come from the schema, they are not spelled out again here', () => {
  // module-toolkit#30/#40: `validate.mjs` used to reimplement the schema field by field and drift
  // from it. Whatever this check enforces must BE the schema's pattern, read from it.
  const { pattern, maxLength } = loadManifestSchema().properties.static_files.properties.folder;
  assert.ok(pattern, 'the schema states the pattern');
  const tooLong = 'a'.repeat(maxLength + 1);
  const { errors } = checkManifestKeys({ ...base(), static_files: { folder: tooLong } });
  assert.equal(errors.length, 1, `maxLength ${maxLength} comes from the schema, not from a literal`);
});
