// A release tag publishes only when it names the version in package.json — module-toolkit#332.
//
// `npm publish` publishes whatever `version` the manifest says, whatever the tag is called; the
// publish workflow runs `scripts/check-release-tag.mjs` first so the tag and the package agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_TAG = join(REPO, 'scripts/check-release-tag.mjs');

function checkTag(...args) {
  return spawnSync(process.execPath, [CHECK_TAG, ...args], { encoding: 'utf8' });
}

test('a tag naming the manifest version is accepted, prereleases included', () => {
  assert.equal(checkTag('v1.2.3', '1.2.3').status, 0);
  assert.equal(checkTag('v1.2.3-rc.1', '1.2.3-rc.1').status, 0);
});

test('a tag naming another version is refused', () => {
  const behind = checkTag('v1.2.3', '1.2.4');
  assert.equal(behind.status, 1);
  assert.match(behind.stderr, /release_tag_version_mismatch/);
});

test('a tag that is not v<semver> is refused', () => {
  for (const tag of ['1.2.3', 'v1.2', 'release-1.2.3', 'v1.2.3.4', '']) {
    const res = checkTag(tag, '1.2.3');
    assert.equal(res.status, 1, `tag «${tag}» must be refused`);
    assert.match(res.stderr, /release_tag_malformed/);
  }
});

test('without an explicit version the tag is checked against package.json', () => {
  const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.equal(checkTag(`v${version}`).status, 0);
  const res = checkTag('v999.0.0');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /release_tag_version_mismatch/);
});
