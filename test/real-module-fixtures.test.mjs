// The frozen real-module fixtures (module-toolkit#352) claim to be byte-for-byte copies of a named
// upstream commit (`ERPlora/tables@21a7fbc`, `ERPlora/inventory@d4e4263`). A README saying so is
// prose: nothing stops a hand edit that keeps the tests green while the fixture quietly stops being
// the module that reproduced tables#25 / inventory#32. CI cannot fetch the module repos to compare
// (no deploy key here — the very reason the fixtures exist), so the claim is pinned as a digest:
// changing a fixture byte means updating `provenance.json` on purpose, with the new source commit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-modules');
const SELF = new Set(['README.md', 'provenance.json']);

/** Every file under the fixture root, relative and sorted, minus the two files that describe it. */
function fixtureFiles(dir = ROOT) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...fixtureFiles(p));
    else if (!SELF.has(relative(ROOT, p))) out.push(relative(ROOT, p));
  }
  return out.sort();
}

const sha256 = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

function provenance() {
  return JSON.parse(readFileSync(join(ROOT, 'provenance.json'), 'utf8'));
}

test('every frozen real-module fixture is pinned to its source commit with a digest (#352)', () => {
  const pinned = provenance();
  assert.deepEqual(
    Object.keys(pinned).sort(),
    fixtureFiles(),
    'provenance.json must list exactly the files under test/fixtures/real-modules (minus README and itself)',
  );
  for (const [file, { source, sha256: expected }] of Object.entries(pinned)) {
    assert.match(source, /^ERPlora\/[a-z_]+@[0-9a-f]{7,40}$/, `${file}: source must be <repo>@<commit>`);
    assert.equal(
      sha256(file),
      expected,
      `${file} no longer matches ${source}: a fixture drifted from the commit it claims to freeze. ` +
        'If the change is deliberate, re-copy it from the module repo and update provenance.json with the new commit',
    );
  }
});

test('the digest pin catches a single-byte edit (control positive, #352)', () => {
  const [file, { sha256: expected }] = Object.entries(provenance())[0];
  const bytes = Buffer.from(readFileSync(join(ROOT, file)));
  bytes[0] ^= 0xff;
  const tampered = createHash('sha256').update(bytes).digest('hex');
  assert.notEqual(tampered, expected, 'a flipped byte must change the pinned digest');
});
