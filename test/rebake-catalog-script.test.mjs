// `scripts/rebake-catalog.sh` — the SDK change rebakes the catalog, not the next PR that walks by
// (module-toolkit#392).
//
// Every module commits its bundle with the SDK baked in, and the gate (#389) compares it with a
// rebuild against hub develop's SDK. So each SDK change on develop left EVERY module behind it: the
// next PR of each one came out red for a change that was not its own, and until that PR came the
// businesses kept the old SDK. Measured on 2026-09-29: schedules#56 and invoice#126, both red for
// hub#2328/hub#2375, neither touching the SDK.
//
// The script is run for real here, over real git repositories (a bare «origin» per module and per
// hub), with a fake gate check, a fake toolkit and a fake `gh`: no network, and every decision is
// observable in git and in the `gh` log. What must hold:
//   - a module whose bundle is already what develop gives is left alone;
//   - a stale one gets ONE branch with ONLY dist/ rebaked, and one PR against main;
//   - that PR supersedes an older rebake PR of the same module;
//   - running again for the same SDK opens nothing twice;
//   - any other red of the check, or a build that touches more than dist/, never pushes;
//   - dry run reports and pushes nothing; fleet worktrees (`.git` FILE) are not modules.
//
// And the same pass for OutfitKit (module-toolkit#424). Since #423 `build --check` rebuilds with
// the SEALED OutfitKit, so a bundle sealed with 0.1.79 is `reproducible` while `build` would bake
// npm's 0.1.125 today: 21 of 27 modules on 2026-09-30, invisible to the pass above. So:
//   - a bundle the SDK leaves alone but sealed with an older OutfitKit than build bakes today (the
//     version the module declares, else npm latest) gets its own `rebake/outfitkit-<v>` PR;
//   - every rebuild bakes THAT version (`build --outfitkit <v>`), and one that does not seal it is
//     never pushed; npm unreachable is an error, never a silent «fresh».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts/rebake-catalog.sh');

function write(file, body, mode) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  if (mode) chmodSync(file, mode);
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repository with `files` on `branch`, pushed to a bare origin; returns the clone. */
function repo(root, slug, branch, files) {
  const origin = join(root, 'origins', `${slug}.git`);
  const clone = join(root, 'src', slug);
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare', '-b', branch);
  mkdirSync(clone, { recursive: true });
  git(clone, 'init', '-q', '-b', branch);
  git(clone, 'config', 'user.email', 'test@example.com');
  git(clone, 'config', 'user.name', 'test');
  for (const [file, body] of Object.entries(files)) write(join(clone, file), body);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-q', '-m', 'initial');
  git(clone, 'remote', 'add', 'origin', origin);
  git(clone, 'push', '-q', 'origin', branch);
  return clone;
}

const seal = (v) => `{"outfitkit":"${v}"}\n`;
const SDK_SOURCE = 'export const moneyFilter = (v, d) => v * 10 ** d;\n';
const BAKED = `baked:${SDK_SOURCE}`;

function catalog() {
  const root = mkdtempSync(join(tmpdir(), 'erplora-rebake-'));
  const hub = repo(root, 'ERPlora/hub', 'develop', {
    'packages/module-sdk/package.json': '{"name":"@erplora/module-sdk"}\n',
    'packages/module-sdk/src/index.ts': SDK_SOURCE,
    'packages/module-types/package.json': '{"name":"@erplora/module-types"}\n',
    'README.md': 'hub\n',
  });
  const sdkRev = git(hub, 'log', '-1', '--format=%H', 'develop', '--', 'packages/module-sdk', 'packages/module-types').slice(0, 10);
  // The checkout the fleet shares is on another branch: the script reads develop, never the tree.
  // Committed there, so that branch's HEAD has an SDK revision of its own: the rebake branch is named
  // after DEVELOP's, or a stale checkout would name it after an older SDK and dedupe against it.
  git(hub, 'checkout', '-q', '-b', 'feature/elsewhere');
  write(join(hub, 'packages/module-sdk/src/index.ts'), 'export const moneyFilter = (v) => v; // not develop\n');
  git(hub, 'commit', '-qam', 'an SDK change that is not on develop');

  const mods = join(root, 'modules');
  const module = (id, dist, extra = {}) => {
    const clone = repo(root, `ERPlora/${id}`, 'main', {
      'module.json': `{"id":"${id}"}\n`,
      'ui/components/view.ts': 'export {};\n',
      [`dist/${id}.esm.js`]: dist,
      'dist/outfitkit.json': seal('0.1.79'),
      ...extra,
    });
    const dir = join(mods, id);
    mkdirSync(mods, { recursive: true });
    spawnSync('git', ['clone', '-q', join(root, 'origins', 'ERPlora', `${id}.git`), dir]);
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'test');
    return { clone, dir, origin: join(root, 'origins', 'ERPlora', `${id}.git`) };
  };
  const m = {
    fresh: module('fresh', BAKED),
    stale: module('stale', 'baked:old sdk\n'),
    unsealed: module('unsealed', 'baked:old sdk\n', { UNSEALED: '1\n' }),
    touchy: module('touchy', 'baked:old sdk\n', { 'ui/TOUCH': '1\n' }),
    wrong: module('wrong', 'baked:old sdk\n', { 'ui/WRONG': '1\n' }),
    // The SDK leaves these alone; only their OutfitKit seal differs from npm latest (0.1.79 below).
    oldkit: module('oldkit', BAKED, { 'dist/outfitkit.json': seal('0.1.70') }),
    // …unless the module declares that version on purpose: then that is what build bakes.
    pinned: module('pinned', BAKED, {
      'dist/outfitkit.json': seal('0.1.70'),
      'package.json': JSON.stringify({ devDependencies: { '@erplora/outfitkit': '0.1.70' } }),
    }),
    // A build that does not seal the version it was asked for.
    oldseal: module('oldseal', BAKED, { 'dist/outfitkit.json': seal('0.1.70'), 'ui/OLDSEAL': '1\n' }),
  };
  // A fleet worktree of a module sits beside the modules with a `.git` FILE: never a module.
  git(m.stale.dir, 'worktree', 'add', '-q', '--detach', join(mods, 'stale-wt-9'), 'origin/main');

  const toolkit = join(root, 'toolkit');
  // Which OutfitKit build bakes is the REAL rule of the toolkit, asked of a fake npm below.
  for (const f of ['outfitkit-ci.mjs', 'outfitkit-stamp.mjs']) {
    mkdirSync(join(toolkit, 'src'), { recursive: true });
    copyFileSync(join(REPO, 'src', f), join(toolkit, 'src', f));
  }
  // The fake toolkit bakes the SDK it is handed and seals the OutfitKit it is told; a module carrying
  // ui/TOUCH makes it write outside dist/, ui/OLDSEAL makes it seal another version.
  write(
    join(toolkit, 'bin', 'erplora.mjs'),
    `import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const [cmd, dir, ...flags] = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'build.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');
const opt = (name) => (flags.indexOf(name) >= 0 ? flags[flags.indexOf(name) + 1] : undefined);
const sdk = opt('--sdk');
const kit = opt('--outfitkit');
if (cmd !== 'build' || !sdk) process.exit(2);
const id = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')).id;
writeFileSync(join(dir, 'dist', id + '.esm.js'), 'baked:' + readFileSync(join(sdk, 'src', 'index.ts'), 'utf8'));
if (kit) writeFileSync(join(dir, 'dist', 'outfitkit.json'), existsSync(join(dir, 'ui', 'OLDSEAL')) ? ${JSON.stringify(seal('0.1.75'))} : '{"outfitkit":"' + kit + '"}\\n');
if (existsSync(join(dir, 'ui', 'TOUCH'))) writeFileSync(join(dir, 'ui', 'extra.ts'), 'export {};\\n');
if (existsSync(join(dir, 'ui', 'WRONG'))) writeFileSync(join(dir, 'dist', id + '.esm.js'), 'baked:something else');
`,
  );
  // The fake gate check: same verdict words as the real one. It leaves a scratch file in the module
  // it checks, as any tool may: only dist/ is ever committed, whatever the check leaves behind.
  const check = join(root, 'check.sh');
  write(
    check,
    `#!/usr/bin/env bash
mod=$1; sdk=$2
touch "$mod/.check-scratch"
id=$(node -p "require('$mod/module.json').id")
[ -f "$mod/UNSEALED" ] && { echo "✗ dist_unsealed: dist/$id.esm.js has no dist/outfitkit.json"; exit 1; }
if [ "$(cat "$mod/dist/$id.esm.js")" = "baked:$(cat "$sdk/src/index.ts")" ]; then
  echo "✓ dist $id: dist/$id.esm.js is exactly what a rebuild gives"; exit 0
fi
echo "✗ dist_not_reproducible: dist/$id.esm.js is not what $id's ui/ gives"; exit 1
`,
    0o755,
  );
  const bin = join(root, 'bin');
  // The registry: FAKE_NPM_PUBLISHED oldest first, the last one is latest; FAKE_NPM_OFFLINE=1 fails.
  write(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "$*" >> "${join(root, 'npm.log')}"
[ "\${FAKE_NPM_OFFLINE:-}" = 1 ] && { echo "npm error network ENOTFOUND" >&2; exit 1; }
read -r -a published <<< "\${FAKE_NPM_PUBLISHED:-0.1.70 0.1.79}"
[ "$1" = view ] || exit 2
spec="\${2##*@}"
[ "$spec" = latest ] && { echo "\\"\${published[\${#published[@]}-1]}\\""; exit 0; }
for v in "\${published[@]}"; do [ "$v" = "$spec" ] && { echo "\\"$v\\""; exit 0; }; done
echo "npm error 404 No match for $2" >&2; exit 1
`,
    0o755,
  );
  write(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${join(root, 'gh.log')}"
[ "$1" = api ] && { [ "$2" = "repos/\${FAKE_GH_ARCHIVED:-none}" ] && echo true || echo false; exit 0; }
case "$1 $2" in
  "pr create") repo=""; prev=""; for a in "$@"; do [ "$prev" = "--repo" ] && repo=$a; prev=$a; done
               echo "https://github.com/$repo/pull/77" ;;
  "pr list") printf '%s' "\${FAKE_GH_OPEN:-}" ;;
esac
`,
    0o755,
  );
  const run = (env = {}) =>
    spawnSync('bash', [SCRIPT, hub, mods], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ERPLORA_TOOLKIT: toolkit,
        REBAKE_CHECK: check,
        REBAKE_WORK: join(root, 'work'),
        ...env,
      },
    });
  const ghLog = () => (existsSync(join(root, 'gh.log')) ? readFileSync(join(root, 'gh.log'), 'utf8') : '');
  const remoteBranches = (mod) =>
    git(mod.origin, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/').split('\n').filter(Boolean);
  const builds = (id) =>
    (existsSync(join(root, 'build.log')) ? readFileSync(join(root, 'build.log'), 'utf8') : '')
      .split('\n')
      .filter((l) => l.includes(`/wt/${id}"`))
      .map((l) => JSON.parse(l));
  return { root, hub, mods, m, sdkRev, run, ghLog, remoteBranches, builds };
}

test('a stale bundle gets one branch with ONLY dist/ rebaked with develop\'s SDK, and one PR against main', () => {
  const c = catalog();
  try {
    const r = c.run({
      FAKE_GH_OPEN: `41 rebake/sdk-0123456789\n43 rebake/outfitkit-0.1.70\n77 rebake/sdk-${c.sdkRev}\n12 fix/other\n`,
    });
    const branch = `rebake/sdk-${c.sdkRev}`;
    assert.deepEqual(c.remoteBranches(c.m.stale).sort(), [branch, 'main'].sort(), r.stdout + r.stderr);
    const changed = git(c.m.stale.origin, 'diff', '--name-only', 'main', branch).split('\n');
    assert.deepEqual(changed, ['dist/stale.esm.js']);
    // Baked with develop's SDK, not with what the shared hub checkout has in its tree.
    assert.equal(git(c.m.stale.origin, 'show', `${branch}:dist/stale.esm.js`), BAKED.trim());
    const log = c.ghLog();
    assert.match(log, new RegExp(`pr create --repo ERPlora/stale --base main --head ${branch} `));
    // It supersedes the older rebake of that module — and only that one.
    // …taking its branch with it: a superseded rebake/sdk-* left on the remote is noise forever.
    assert.match(log, /pr close 41 --repo ERPlora\/stale .*--delete-branch/);
    // An open OutfitKit rebake is superseded as well: this one bakes today's OutfitKit AND the SDK.
    assert.match(log, /pr close 43 --repo ERPlora\/stale .*--delete-branch/);
    // (The fake gh answers the same open list for every repository, so only stale's closes count here.)
    assert.doesNotMatch(log, /pr close (77|12) --repo ERPlora\/stale /);
    // …because it bakes, by name, the OutfitKit build resolves today, not whatever npm says later.
    assert.deepEqual(c.builds('stale').map((a) => a.slice(a.indexOf('--outfitkit'))), [['--outfitkit', '0.1.79']]);
    assert.match(r.stdout, /^stale\topened\thttps:\/\/github.com\/ERPlora\/stale\/pull\/77$/m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('a fresh bundle is left alone, and a fleet worktree is not a module', () => {
  const c = catalog();
  try {
    const r = c.run();
    assert.deepEqual(c.remoteBranches(c.m.fresh), ['main']);
    assert.doesNotMatch(c.ghLog(), /^pr .*ERPlora\/fresh/m);
    assert.match(r.stdout, /^fresh\tfresh\b/m);
    assert.doesNotMatch(r.stdout, /stale-wt-9/);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('any other red of the check, or a build that writes outside dist/, never pushes — and the run exits 1', () => {
  const c = catalog();
  try {
    const r = c.run();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.deepEqual(c.remoteBranches(c.m.unsealed), ['main']);
    assert.deepEqual(c.remoteBranches(c.m.touchy), ['main']);
    assert.match(r.stdout, /^unsealed\terror\t.*dist_unsealed/m);
    assert.match(r.stdout, /^touchy\trefused\t.*ui\/extra\.ts/m);
    assert.doesNotMatch(c.ghLog(), /^pr .*ERPlora\/(unsealed|touchy)/m);
    // Only a stale bundle is rebuilt: any other red is reported as the check gave it, not rebuilt.
    assert.doesNotMatch(readFileSync(join(c.root, 'build.log'), 'utf8'), /\/wt\/unsealed"/);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('running again for the same SDK opens nothing twice', () => {
  const c = catalog();
  try {
    c.run();
    const before = c.ghLog().match(/pr create/g).length;
    const again = c.run();
    assert.equal(c.ghLog().match(/pr create/g).length, before);
    assert.match(again.stdout, new RegExp(`^stale\\tpending\\trebake/sdk-${c.sdkRev}`, 'm'));
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('dry run reports the stale ones and pushes nothing', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_DRY_RUN: '1' });
    assert.match(r.stdout, /^stale\tstale\b/m);
    assert.deepEqual(c.remoteBranches(c.m.stale), ['main']);
    // Reading a repository's metadata is not opening anything.
    assert.doesNotMatch(c.ghLog(), /^pr /m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('REBAKE_ONLY limits the run to the modules it names', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'fresh stale' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /unsealed|touchy/);
    assert.match(r.stdout, /^stale\topened\t/m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('an ARCHIVED module repository is skipped, not reported as an error on every run', () => {
  const c = catalog();
  try {
    const r = c.run({ FAKE_GH_ARCHIVED: 'ERPlora/unsealed', REBAKE_ONLY: 'unsealed stale' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^unsealed\tarchived\t/m);
    assert.match(r.stdout, /^stale\topened\t/m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('a rebuild the gate\'s check still rejects is never pushed', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'wrong' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^wrong\terror\tstill not reproducible after the rebuild: .*dist_not_reproducible/m);
    assert.deepEqual(c.remoteBranches(c.m.wrong), ['main']);
    assert.doesNotMatch(c.ghLog(), /^pr /m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('a bundle sealed with an older OutfitKit than build bakes today gets its own rebake/outfitkit-<v> PR', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'oldkit', FAKE_GH_OPEN: '43 rebake/outfitkit-0.1.70\n44 rebake/sdk-0123456789\n12 fix/other\n' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const branch = 'rebake/outfitkit-0.1.79';
    assert.deepEqual(c.remoteBranches(c.m.oldkit).sort(), [branch, 'main'].sort());
    assert.deepEqual(git(c.m.oldkit.origin, 'diff', '--name-only', 'main', branch).split('\n'), ['dist/outfitkit.json']);
    assert.equal(git(c.m.oldkit.origin, 'show', `${branch}:dist/outfitkit.json`), seal('0.1.79').trim());
    assert.deepEqual(c.builds('oldkit').map((a) => a.slice(a.indexOf('--outfitkit'))), [['--outfitkit', '0.1.79']]);
    const log = c.ghLog();
    assert.match(log, new RegExp(`pr create --repo ERPlora/oldkit --base main --head ${branch} `));
    assert.match(log, /pr create --repo ERPlora\/oldkit .*--title .*OutfitKit 0\.1\.79 \(llevaba la 0\.1\.70\)/);
    // The PR says which OutfitKit it leaves and which it takes.
    const body = readFileSync(join(c.root, 'work', 'pr-oldkit.md'), 'utf8');
    assert.match(body, /^- Motivo: outfitkit 0\.1\.70 → 0\.1\.79\.$/m);
    assert.match(body, /^- OutfitKit: `0\.1\.70` en `main` → `0\.1\.79` en esta rama/m);
    assert.match(log, /pr close 43 --repo ERPlora\/oldkit .*--delete-branch/);
    assert.match(log, /pr close 44 --repo ERPlora\/oldkit .*--delete-branch/);
    assert.doesNotMatch(log, /pr close 12 /);
    assert.match(r.stdout, /^oldkit\topened\thttps:\/\/github.com\/ERPlora\/oldkit\/pull\/77$/m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('the OutfitKit a module declares on purpose is fresh at that version, and an up-to-date seal is fresh', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'pinned fresh' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^pinned\tfresh\b/m);
    assert.match(r.stdout, /^fresh\tfresh\b/m);
    assert.deepEqual(c.remoteBranches(c.m.pinned), ['main']);
    assert.deepEqual(c.builds('pinned'), []);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('dry run lists the modules with an old OutfitKit, and which version each would take', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_DRY_RUN: '1', FAKE_NPM_PUBLISHED: '0.1.70 0.1.79 0.1.126' });
    assert.match(r.stdout, /^oldkit\tstale\t\S+ outfitkit 0\.1\.70 → 0\.1\.126$/m);
    // An SDK-stale bundle says it too when its OutfitKit is also behind: the rebake takes both.
    assert.match(r.stdout, /^stale\tstale\t\S+ sdk, outfitkit 0\.1\.79 → 0\.1\.126$/m);
    assert.match(r.stdout, /^fresh\tstale\t\S+ outfitkit 0\.1\.79 → 0\.1\.126$/m);
    assert.deepEqual(c.remoteBranches(c.m.oldkit), ['main']);
    assert.doesNotMatch(c.ghLog(), /^pr /m);
    assert.deepEqual(c.builds('oldkit'), []);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('running again for the same OutfitKit opens nothing twice', () => {
  const c = catalog();
  try {
    c.run({ REBAKE_ONLY: 'oldkit' });
    const again = c.run({ REBAKE_ONLY: 'oldkit' });
    assert.equal(c.ghLog().match(/pr create/g).length, 1);
    assert.match(again.stdout, /^oldkit\tpending\trebake\/outfitkit-0\.1\.79$/m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('npm unreachable is an error that pushes nothing, never a silent fresh', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'oldkit fresh', FAKE_NPM_OFFLINE: '1' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^oldkit\terror\t.*outfitkit_unresolvable/m);
    assert.match(r.stdout, /^fresh\terror\t.*outfitkit_unresolvable/m);
    assert.deepEqual(c.remoteBranches(c.m.oldkit), ['main']);
    assert.doesNotMatch(c.ghLog(), /^pr /m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('a rebuild that does not seal the OutfitKit it was asked for is never pushed', () => {
  const c = catalog();
  try {
    const r = c.run({ REBAKE_ONLY: 'oldseal' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^oldseal\terror\t.*sealed 0\.1\.75, not 0\.1\.79/m);
    assert.deepEqual(c.remoteBranches(c.m.oldseal), ['main']);
    assert.doesNotMatch(c.ghLog(), /^pr /m);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});

test('a toolkit that answers nothing about OutfitKit is an error, never read as fresh', () => {
  const c = catalog();
  try {
    // What the symlinked-TMPDIR entry guard did: exit 0 and not a word.
    write(join(c.root, 'toolkit', 'src', 'outfitkit-ci.mjs'), 'process.exit(0);\n');
    const r = c.run({ REBAKE_ONLY: 'oldkit' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^oldkit\terror\tthe toolkit did not say which OutfitKit/m);
    assert.deepEqual(c.remoteBranches(c.m.oldkit), ['main']);
  } finally {
    rmSync(c.root, { recursive: true, force: true });
  }
});
