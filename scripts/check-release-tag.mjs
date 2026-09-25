#!/usr/bin/env node
// Refuses to publish from a tag that does not name the version in package.json
// (module-toolkit#332).
//
// npm publishes whatever `version` the manifest says, whatever the tag is called. Without this
// check, tagging `v0.2.0` on a commit whose manifest still says `0.1.0` would try to publish 0.1.0
// again (npm answers E403 only after the job already looks like a release) or publish a version
// nobody tagged. The tag is the release; the manifest has to agree with it.
//
// Usage: check-release-tag.mjs <tag> [version]   (version defaults to package.json's)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function readManifestVersion() {
  const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(readFileSync(manifest, 'utf8')).version;
}

const [tag = '', version = readManifestVersion()] = process.argv.slice(2);

const match = TAG.exec(tag);
if (!match) {
  console.error(`release_tag_malformed: «${tag}» is not a release tag (expected v<major>.<minor>.<patch>)`);
  process.exit(1);
}
if (match[1] !== version) {
  console.error(`release_tag_version_mismatch: tag ${tag} names ${match[1]}, package.json says ${version}`);
  process.exit(1);
}
console.log(`release tag ${tag} matches package.json ${version}`);
