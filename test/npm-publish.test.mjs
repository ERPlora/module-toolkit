// The CLI is publishable on the public npm registry, and only from a version tag —
// module-toolkit#332.
//
// WHAT WAS BROKEN. The developers page of the SaaS tells a vendor to run
// `npm install @erplora/module-toolkit`, and npm answered E404: the manifest carried a deliberate
// `"private": true` (the guard of #25), there was no `publishConfig`, and no workflow ever ran
// `npm publish`. #277/#334 made the tarball INSTALLABLE; nothing made it PUBLISHABLE.
//
// WHAT THIS PROVES. The tarball npm would receive — built with `npm pack`, never the working tree —
// is accepted by the public registry as a public scoped package, names the repository its trusted
// publisher is bound to, ships only what the CLI runs, and leaks no host of the private fleet.
// The release path is checked too: the workflow refuses a tag that does not name the manifest's
// version (`scripts/check-release-tag.mjs`, tested in `check-release-tag.test.mjs`), and it
// authenticates by OIDC (Trusted Publishing, the same way `@erplora/outfitkit` is published), so
// there is no npm token to store or to leak.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(REPO, '.github/workflows/publish.yml');

/** Top-level entries a consumer of the CLI needs; anything else is repository furniture. */
const SHIPPED_ROOTS = ['bin/', 'src/', 'schemas/', 'contracts/', 'vendor/'];
const SHIPPED_FILES = ['package.json', 'README.md', 'LICENSE'];

/** A hub on an aura (`<slug>.<aura>.erplora.com`) is a real tenant of the private fleet. */
const FLEET_HOST = /\b[a-z0-9-]+\.[a-z0-9-]+\.erplora\.com\b/g;

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
  if (res.error) throw res.error;
  return res;
}

const scratch = mkdtempSync(join(tmpdir(), 'erplora-toolkit-publish-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

const packed = run('npm', ['pack', '--pack-destination', scratch, '--json', '--loglevel=error'], {
  cwd: REPO,
});
assert.equal(packed.status, 0, `npm pack failed:\n${packed.stderr}`);
const tarball = join(scratch, JSON.parse(packed.stdout)[0].filename);
const extracted = join(scratch, 'extracted');
run('mkdir', ['-p', extracted]);
assert.equal(run('tar', ['-xzf', tarball, '-C', extracted]).status, 0, 'could not unpack the tarball');
const PKG = join(extracted, 'package');
const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [relative(PKG, path)];
  });
}
const FILES = walk(PKG);

test('the packed manifest is a public package the npm registry accepts', () => {
  assert.equal(manifest.name, '@erplora/module-toolkit');
  assert.notEqual(manifest.private, true, 'npm refuses to publish a private package');
  assert.equal(manifest.publishConfig?.access, 'public', 'a scoped package publishes restricted by default');
  const registry = manifest.publishConfig?.registry;
  if (registry !== undefined) assert.match(registry, /^https:\/\/registry\.npmjs\.org\/?$/);
  assert.ok(manifest.license, 'a public package declares the licence it is published under');
});

test('the packed manifest names the repository its trusted publisher is bound to', () => {
  const url = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  assert.match(url ?? '', /github\.com[/:]ERPlora\/module-toolkit(\.git)?$/);
});

test('the tarball ships only what the CLI runs', () => {
  const stray = FILES.filter(
    (f) => !SHIPPED_FILES.includes(f) && !SHIPPED_ROOTS.some((root) => f.startsWith(root)),
  );
  assert.deepEqual(stray, []);
  assert.ok(FILES.includes('bin/erplora.mjs'), 'the `erplora` bin is in the tarball');
  assert.ok(FILES.includes('LICENSE'), 'the licence text travels with the package');
  // module-toolkit#359: the SDK a generated module imports is on no public registry, so it travels
  // inside the package (`prepack`), sources only.
  assert.ok(FILES.includes('vendor/@erplora/module-sdk/src/index.ts'), 'the module SDK is in the tarball');
  assert.deepEqual(FILES.filter((f) => f.startsWith('vendor/') && /\.test\./.test(f)), [], 'no SDK test ships');
  assert.match(readFileSync(join(PKG, 'bin/erplora.mjs'), 'utf8'), /^#!\/usr\/bin\/env node\n/);
});

test('the tarball names no host of the private fleet', () => {
  const leaks = [];
  for (const file of FILES) {
    const text = readFileSync(join(PKG, file), 'utf8');
    for (const [host] of text.matchAll(FLEET_HOST)) leaks.push(`${file}: ${host}`);
  }
  assert.deepEqual(leaks, []);
});

test('the publish workflow runs on version tags and authenticates by OIDC, never by token', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  assert.match(wf, /\bon:\s*\n\s+push:\s*\n\s+tags:\s*\[\s*'v\*'\s*\]/, 'triggered by a `v*` tag push');
  assert.doesNotMatch(wf, /\n\s+branches:/, 'a branch push must never publish');
  assert.match(wf, /\n\s+id-token:\s*write\b/, 'OIDC needs `id-token: write`');
  assert.doesNotMatch(wf, /^\s*registry-url:/m, 'setup-node with registry-url forces a placeholder token and skips OIDC');
  assert.doesNotMatch(wf, /\$\{\{\s*secrets\./, 'no stored credential reaches the job');
  assert.doesNotMatch(wf, /^\s*NODE_AUTH_TOKEN:/m, 'no npm token in the environment');
});

test('the publish workflow checks the tag and the tarball before publishing', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  const at = (re) => {
    const m = re.exec(wf);
    assert.ok(m, `the workflow runs ${re}`);
    return m.index;
  };
  const publish = at(/\n\s+run: npm publish --access public\b/);
  assert.ok(at(/node scripts\/check-release-tag\.mjs "\$RELEASE_TAG"/) < publish);
  assert.ok(at(/node --test test\/npm-publish\.test\.mjs test\/install-from-package\.test\.mjs/) < publish);
});

// module-toolkit#359. `npm publish` runs `prepack`, which copies the module SDK from a DECLARED hub
// and stops without one. The job checks no hub out, so it has to bring it the way CI does — the
// hub's `module-sdk` action, shared with the organization — and declare it before the tarball test.
test('the publish workflow hands the pack a hub to copy the module SDK from', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  const sdk = wf.search(/uses: ERPlora\/hub\/\.github\/actions\/module-sdk@develop/);
  const declared = wf.search(/ERPLORA_HUB_DIR=.*>> "\$GITHUB_ENV"/);
  const tarballTest = wf.search(/node --test test\/npm-publish\.test\.mjs/);
  assert.ok(sdk > 0, 'the workflow uses the hub\'s module-sdk action');
  assert.ok(declared > sdk, 'the workflow declares ERPLORA_HUB_DIR from that action');
  assert.ok(tarballTest > declared, 'the hub is declared before the tarball is packed');
});

test('the tag reaches the check through the environment, never spliced into a shell line', () => {
  // `${{ github.ref_name }}` inside `run:` is expanded BEFORE the shell sees it: a tag named
  // `v$(…)` would run as code. An env value is passed as data.
  const wf = readFileSync(WORKFLOW, 'utf8');
  assert.match(wf, /\n\s+env:\s*\n\s+RELEASE_TAG:\s*\$\{\{\s*github\.ref_name\s*\}\}\s*\n\s+run: node scripts\/check-release-tag\.mjs "\$RELEASE_TAG"/);
  const spliced = wf.split('\n').filter((line) => line.includes('${{') && !/^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{[^}]*\}\}\s*$/.test(line));
  assert.deepEqual(spliced, [], 'an expression outside an env value');
});
