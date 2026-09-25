// A vendor installs the CLI from its PACKAGE, with no ERPlora repository next to it —
// module-toolkit#277.
//
// WHAT WAS BROKEN. The developers page of the SaaS tells a vendor to run
// `npm install @erplora/module-toolkit` and then `npx erplora …`. The package that command would
// fetch declared three dependencies as `file:` paths into sibling checkouts (`../hub/packages/*`,
// `../outfitkit`). Inside a published tarball such a path means nothing — or worse, it resolves
// against whatever happens to sit next to the vendor's project — and npm reifies it as a dangling
// link (npm 10 also reports the tree as a «damaged lockfile»). On top of that the CLI had no
// `--version`: the one command a person types to confirm an install answered with the usage text
// and exit code 2.
//
// WHAT THIS PROVES. The artifact npm would serve is built with `npm pack`, installed into a fresh
// project OUTSIDE the monorepo exactly as the developers page says, and asked for its version.
// That is the whole first step of the vendor's journey; building a module from that install still
// needs `@erplora/module-sdk` and `@erplora/outfitkit` published for it, which is tracked apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;

/** Dependency kinds npm installs for a CONSUMER of the package (devDependencies never are). */
const CONSUMER_DEP_TYPES = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** A specifier that points at the author's disk instead of at a registry. */
const LOCAL_SPEC = /^(file:|link:|workspace:|\.{0,2}\/)/;

function run(cmd, args, opts) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, ...opts });
  if (res.error) throw res.error;
  return res;
}

/** `npm pack` of this repository into `dir`; returns the tarball path. */
function pack(dir) {
  const res = run('npm', ['pack', '--pack-destination', dir, '--json', '--loglevel=error'], {
    cwd: REPO,
  });
  assert.equal(res.status, 0, `npm pack failed:\n${res.stderr}`);
  const [{ filename }] = JSON.parse(res.stdout);
  return join(dir, filename);
}

const scratch = mkdtempSync(join(tmpdir(), 'erplora-toolkit-install-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const tarball = pack(scratch);

test('the packed manifest declares only dependencies a registry can resolve', () => {
  const out = join(scratch, 'extracted');
  run('mkdir', ['-p', out]);
  const tar = run('tar', ['-xzf', tarball, '-C', out, 'package/package.json']);
  assert.equal(tar.status, 0, `could not read package.json from the tarball:\n${tar.stderr}`);
  const manifest = JSON.parse(readFileSync(join(out, 'package', 'package.json'), 'utf8'));

  const local = [];
  for (const kind of CONSUMER_DEP_TYPES) {
    for (const [name, spec] of Object.entries(manifest[kind] ?? {})) {
      if (LOCAL_SPEC.test(spec)) local.push(`${kind}.${name} = ${spec}`);
    }
  }
  assert.deepEqual(local, [], 'a published package cannot point at the author\'s disk');
});

test('installed as the developers page says, `erplora --version` answers with its version', () => {
  const project = join(scratch, 'vendor-project');
  run('mkdir', ['-p', project]);
  assert.equal(run('npm', ['init', '-y'], { cwd: project }).status, 0);

  // A cache private to this run (module-toolkit#171): never the shared `~/.npm`.
  const install = run(
    'npm',
    ['install', '--cache', join(scratch, '.npm-cache'), '--no-audit', '--no-fund', '--loglevel=error', tarball],
    { cwd: project },
  );
  assert.equal(install.status, 0, `npm install of the package failed:\n${install.stderr}`);

  const version = run('npx', ['--no-install', 'erplora', '--version'], { cwd: project });
  assert.equal(version.status, 0, `erplora --version exited ${version.status}:\n${version.stdout}${version.stderr}`);
  assert.equal(version.stdout.trim(), VERSION);
});
