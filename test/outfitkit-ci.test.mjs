// `erplora build` bakes and seals the OutfitKit the module gate installs, never the checkout the
// toolkit happens to resolve — module-toolkit#423.
//
// On a laptop the toolkit's `node_modules/@erplora/outfitkit` is a link to the shared `outfitkit/`
// checkout (0.1.79 on 2026-09-30, npm at 0.1.125): every local build sealed that one, while the
// gate's screen tests ran against npm's. `build --check` could not see it either, because it
// rebuilt with the very version the bundle sealed. 21 of 27 modules shipped 0.1.79.
//
// Everything runs with a fake `npm` on PATH (it answers `view` and lays packages out on `install`)
// and a private cache, so no test touches the network or the real `~/.cache`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from '../src/build.mjs';
import { checkDistReproducible, assertDistReproducible } from '../src/dist-reproducible.mjs';
import { buildOutfitkitSpec, gateOutfitkitSpec, resolveOutfitkit } from '../src/outfitkit-ci.mjs';
import { resolvedOutfitkitVersion } from '../src/dist-reproducible.mjs';
import { resolvedSdkDir } from '../src/sdk-freshness.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const NO_SDK = { sdkDir: null };
// Where the real SDK is baked (the CLI, `--check`), the #387 door compares it with hub develop. These
// tests are about OutfitKit, so develop is pinned to the checkout's own HEAD: otherwise they go red
// whenever develop moves ahead of the shared hub checkout, for a reason that is not theirs.
const SDK_DIR = resolvedSdkDir();
const HUB_HEAD = SDK_DIR ? (spawnSync('git', ['-C', SDK_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim() : '';

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * A sandbox: a fake npm whose registry holds `published` (oldest first; the last one is `latest`),
 * a private cache, and a module whose Web Component imports `@erplora/outfitkit/define`. Each
 * published version's `define.js` carries a marker, so the bundle says which one it baked.
 */
function sandbox({ published = ['0.0.110', '0.0.125'], declared = null, offline = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-ok-ci-'));
  const bin = join(root, 'bin');
  const log = join(root, 'npm.log');
  write(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
${offline ? 'echo "npm error network ENOTFOUND" >&2; exit 1' : ''}
published=(${published.join(' ')})
if [ "$1" = view ]; then
  spec="\${2##*@}"
  if [ "$spec" = latest ]; then echo "\\"\${published[\${#published[@]}-1]}\\""; exit 0; fi
  case "$spec" in
    ^*) printf '['; sep=''; for v in "\${published[@]}"; do printf '%s"%s"' "$sep" "$v"; sep=,; done; echo ']'; exit 0 ;;
  esac
  for v in "\${published[@]}"; do [ "$v" = "$spec" ] && { echo "\\"$v\\""; exit 0; }; done
  echo "npm error 404 No match for $2" >&2; exit 1
fi
if [ "$1" = install ]; then
  prefix=""; prev=""
  for a in "$@"; do [ "$prev" = "--prefix" ] && prefix="$a"; prev="$a"; done
  want="\${@: -1}"; v="\${want##*@}"
  found=""; for p in "\${published[@]}"; do [ "$p" = "$v" ] && found=1; done
  [ -n "$found" ] || { echo "npm error 404 $want" >&2; exit 1; }
  pkg="$prefix/node_modules/@erplora/outfitkit"
  mkdir -p "$pkg/dist"
  echo "{\\"name\\":\\"@erplora/outfitkit\\",\\"version\\":\\"$v\\",\\"type\\":\\"module\\",\\"exports\\":{\\"./define\\":\\"./dist/define.js\\"}}" > "$pkg/package.json"
  echo "globalThis.__outfitkitBaked = 'npm-$v';" > "$pkg/dist/define.js"
  exit 0
fi
exit 2
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);

  const mod = join(root, 'demo');
  write(join(mod, 'module.json'), '{"id":"demo","version":"1.0.0"}\n');
  write(join(mod, 'ui/components/erp-demo/erp-demo.ts'), "import '@erplora/outfitkit/define';\nexport const demo = 1;\n");
  if (declared) write(join(mod, 'package.json'), JSON.stringify({ devDependencies: { '@erplora/outfitkit': declared } }));

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(root, 'cache') };
  const npmCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  const sealed = () => JSON.parse(readFileSync(join(mod, 'dist', 'outfitkit.json'), 'utf8')).outfitkit;
  const bundle = () => readFileSync(join(mod, 'dist', 'demo.esm.js'), 'utf8');
  return { root, mod, env, npmCalls, sealed, bundle, clean: () => rmSync(root, { recursive: true, force: true }) };
}

async function quietly(fn) {
  const { log, warn } = console;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

// The fake registry publishes 0.0.x only: no real OutfitKit is there, so neither the laptop's
// checkout nor the copy CI installs from npm (`^0.1.98`) can be what a test below sees baked.
const SANDBOX_VERSIONS = ['0.0.42', '0.0.100', '0.0.110', '0.0.125'];

test('the positive control: the toolkit on this machine resolves an OutfitKit the fake registry does not publish', () => {
  // Without this the tests below could pass by accident on a machine whose own copy IS the one
  // they expect baked and sealed.
  assert.ok(!SANDBOX_VERSIONS.includes(resolvedOutfitkitVersion()), resolvedOutfitkitVersion());
});

test('build bakes and seals npm latest for a module that declares no version (all 27 today)', async () => {
  const s = sandbox();
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    assert.equal(s.sealed(), '0.0.125', 'the seal is what the gate installs, not the local checkout');
    assert.ok(s.bundle().includes('npm-0.0.125'), 'and the bundle carries THAT OutfitKit, not the checkout');
    assert.ok(s.npmCalls().some((c) => c.startsWith('view @erplora/outfitkit@latest version')), s.npmCalls().join('\n'));
  } finally {
    s.clean();
  }
});

test('build follows the version the module declares, like the gate does; workspace:* means latest', async () => {
  const pinned = sandbox({ declared: '0.0.110' });
  const workspace = sandbox({ declared: 'workspace:*' });
  try {
    await quietly(() => build(pinned.mod, { sdk: NO_SDK, outfitkit: { env: pinned.env } }));
    assert.equal(pinned.sealed(), '0.0.110');
    assert.ok(pinned.bundle().includes('npm-0.0.110'));
    await quietly(() => build(workspace.mod, { sdk: NO_SDK, outfitkit: { env: workspace.env } }));
    assert.equal(workspace.sealed(), '0.0.125');
  } finally {
    pinned.clean();
    workspace.clean();
  }
});

test('a declared range takes the highest match, as npm install does', async () => {
  const s = sandbox({ declared: '^0.0.100' });
  try {
    const ok = resolveOutfitkit(s.mod, { env: s.env });
    assert.equal(ok.version, '0.0.125');
  } finally {
    s.clean();
  }
});

// `merge-pr.sh` (pm#547/pm#569) rebakes a module's dist/ when two branches collide only there, and
// has to keep the OutfitKit the two sides SEALED — rebaking latest would ship a version neither
// branch was tested with. So a caller can name the version, the way `--sdk <dir>` names the SDK;
// it still comes from npm, never from the toolkit's own copy.
test('build --outfitkit <version> bakes and seals THAT version from npm, over what the module declares', async () => {
  const s = sandbox({ declared: '0.0.125', published: SANDBOX_VERSIONS });
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env, version: '0.0.110' } }));
    assert.equal(s.sealed(), '0.0.110');
    assert.ok(s.bundle().includes('npm-0.0.110'), 'the bundle carries the named OutfitKit');
    for (const flag of [['--outfitkit', '0.0.100'], ['--outfitkit=0.0.42']]) {
      const cli = spawnSync(process.execPath, [join(REPO, 'bin', 'erplora.mjs'), 'build', s.mod, ...flag], {
        encoding: 'utf8',
        env: { ...s.env, ERPLORA_HUB_DEVELOP_SHA: HUB_HEAD },
      });
      const want = flag.join('=').split('=').pop();
      assert.equal(cli.status, 0, cli.stdout + cli.stderr);
      assert.equal(s.sealed(), want, `${flag.join(' ')} sealed ${s.sealed()}`);
    }
    const empty = spawnSync(process.execPath, [join(REPO, 'bin', 'erplora.mjs'), 'build', s.mod, '--outfitkit='], {
      encoding: 'utf8',
      env: s.env,
    });
    assert.equal(empty.status, 1, 'a flag with no version is an error, not «latest»');
    assert.equal(s.sealed(), '0.0.42', 'and dist/ is left as it was');
  } finally {
    s.clean();
  }
});

test('build --outfitkit with something that is not a version is refused before npm is asked', async () => {
  const s = sandbox();
  try {
    await assert.rejects(
      quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env, version: 'latest' } })),
      (e) => e.code === 'outfitkit_version_invalid',
    );
    assert.deepEqual(s.npmCalls(), []);
  } finally {
    s.clean();
  }
});

test('a version already in the cache is not installed again', async () => {
  const s = sandbox();
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    assert.equal(s.npmCalls().filter((c) => c.startsWith('install')).length, 1, s.npmCalls().join('\n'));
  } finally {
    s.clean();
  }
});

test('without npm the build STOPS before touching dist/ — it never falls back to the checkout', async () => {
  const s = sandbox({ offline: true });
  try {
    await assert.rejects(
      quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } })),
      (e) => e.code === 'outfitkit_unresolvable' && e.message.includes('@erplora/outfitkit@latest'),
    );
    assert.equal(existsSync(join(s.mod, 'dist', 'demo.esm.js')), false, 'no bundle baked with another OutfitKit');
    assert.equal(existsSync(join(s.mod, 'dist', 'outfitkit.json')), false, 'and no seal');
  } finally {
    s.clean();
  }
});

test('build --check rebuilds with the SEALED OutfitKit from npm, whatever the toolkit resolves locally', async () => {
  // Built with 0.0.110 (declared), then the declaration is dropped: the check must still rebuild
  // with the 0.0.110 the bundle seals — not latest, and not the local checkout.
  const s = sandbox({ declared: '0.0.110' });
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    assert.equal(s.sealed(), '0.0.110');
    rmSync(join(s.mod, 'package.json'));
    const result = await checkDistReproducible(s.mod, { outfitkit: { env: s.env }, developSha: HUB_HEAD || undefined, env: {} });
    assert.equal(result.status, 'reproducible', JSON.stringify(result));
  } finally {
    s.clean();
  }
});

test('build --check catches a bundle whose seal is not the OutfitKit it carries', async () => {
  // Baked with latest (0.0.125), then the seal is edited to claim 0.0.110: the rebuild with the
  // claimed version is other bytes. Comparing against the local checkout could never tell.
  const s = sandbox();
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    write(join(s.mod, 'dist', 'outfitkit.json'), '{"outfitkit":"0.0.110"}\n');
    const result = await checkDistReproducible(s.mod, { outfitkit: { env: s.env }, developSha: HUB_HEAD || undefined, env: {} });
    assert.equal(result.status, 'differs', JSON.stringify(result));
  } finally {
    s.clean();
  }
});

test('build --check says so when npm cannot give the sealed OutfitKit (unpublished or offline)', async () => {
  const s = sandbox({ published: ['0.0.125'] });
  try {
    await quietly(() => build(s.mod, { sdk: NO_SDK, outfitkit: { env: s.env } }));
    write(join(s.mod, 'dist', 'outfitkit.json'), '{"outfitkit":"0.0.42"}\n');
    const result = await checkDistReproducible(s.mod, { outfitkit: { env: s.env }, developSha: HUB_HEAD || undefined, env: {} });
    assert.equal(result.status, 'outfitkit_unavailable');
    assert.equal(result.sealed, '0.0.42');
    await assert.rejects(
      assertDistReproducible(s.mod, { outfitkit: { env: s.env }, developSha: HUB_HEAD || undefined, env: {} }),
      (e) => e.code === 'dist_outfitkit_unavailable' && e.message.includes('@erplora/outfitkit@0.0.42'),
    );
  } finally {
    s.clean();
  }
});

test('which spec each side asks npm for: build refreshes, the gate tests what ships', () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-ok-spec-'));
  try {
    const mod = join(root, 'm');
    write(join(mod, 'module.json'), '{"id":"m"}\n');
    assert.equal(buildOutfitkitSpec(mod), 'latest', 'no package.json');
    assert.equal(gateOutfitkitSpec(mod), 'latest', 'no package.json, no seal');
    write(join(mod, 'package.json'), JSON.stringify({ dependencies: { '@erplora/outfitkit': 'workspace:*' } }));
    assert.equal(buildOutfitkitSpec(mod), 'latest');
    write(join(mod, 'package.json'), JSON.stringify({ devDependencies: { '@erplora/outfitkit': '~0.0.110' } }));
    assert.equal(buildOutfitkitSpec(mod), '~0.0.110');
    assert.equal(gateOutfitkitSpec(mod), '~0.0.110', 'no seal: what the module declares');
    write(join(mod, 'dist', 'outfitkit.json'), '{"outfitkit":"0.1.79"}\n');
    assert.equal(gateOutfitkitSpec(mod), '0.1.79', 'a seal wins: the tests run against what ships');
    assert.equal(buildOutfitkitSpec(mod), '~0.0.110', 'but a rebuild never sticks to an old seal');
    write(join(mod, 'dist', 'outfitkit.json'), '{"outfitkit":"unknown"}\n');
    assert.equal(gateOutfitkitSpec(mod), '~0.0.110', 'a seal that is not a version is no seal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the gate CLI prints the spec the screen tests install', () => {
  const root = mkdtempSync(join(tmpdir(), 'erplora-ok-cli-'));
  try {
    write(join(root, 'module.json'), '{"id":"m"}\n');
    write(join(root, 'dist', 'outfitkit.json'), '{"outfitkit":"0.1.98"}\n');
    const res = spawnSync(process.execPath, [join(REPO, 'src', 'outfitkit-ci.mjs'), 'gate-spec', root], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '0.1.98');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the module gate installs the SEALED OutfitKit for the screen tests (the same one build --check rebuilds with)', () => {
  const action = readFileSync(join(REPO, '.github/actions/validate-module/action.yml'), 'utf8');
  assert.match(
    action,
    /"@erplora\/outfitkit@\$\(node "\$ERPLORA_TOOLKIT\/src\/outfitkit-ci\.mjs" gate-spec "\$mod"\)"/,
    'the vitest install asks the toolkit which OutfitKit ships',
  );
  assert.doesNotMatch(action, /ver @erplora\/outfitkit/, 'no second rule for the same package');
});
