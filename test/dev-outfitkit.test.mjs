// `erplora dev` previews the module with the OutfitKit `erplora build` will bake — module-toolkit#426.
//
// Since module-toolkit#423 `build` bakes and seals the OutfitKit of npm (what the module declares,
// or `latest`), while the preview kept bundling the toolkit's own copy: on a laptop, the link to the
// shared `outfitkit/` checkout (0.1.79 on 2026-09-30, npm at 0.1.126). A component fixed in a recent
// OutfitKit looked broken in the preview and fine in the hub, or the other way round.
//
// These tests start the REAL preview server with a fake `npm` on PATH (it answers `view` and lays
// packages out on `install`) and a private cache, and read the bundle it serves: no network, no
// real `~/.cache`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDev } from '../src/dev.mjs';
import { resolvedOutfitkitVersion } from '../src/dist-reproducible.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// The fake registry publishes 0.0.x only, so neither the laptop's checkout nor the copy CI installs
// from npm can be what a test below sees baked.
const PUBLISHED = ['0.0.42', '0.0.110', '0.0.125'];
const LOCAL = resolvedOutfitkitVersion();

// esbuild writes string literals in double quotes and escapes non-ASCII (`·` → `\xB7`).
const headerSays = (harness, label) => harness.includes(JSON.stringify(label).replace(/·/g, '\\xB7'));

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

// The harness imports Ionic and ionicons from the workspace it previews (a `startproject` workspace
// installs them). Link the toolkit's copies into the sandbox; ionicons is resolved from @ionic/core,
// whose dependency it is, so this also holds on CI where only @ionic/core is linked at the top.
function linkIonic(root) {
  const req = createRequire(join(REPO, 'package.json'));
  const core = realpathSync(dirname(req.resolve('@ionic/core/package.json')));
  // ionicons exports no `./package.json`: walk up from its entry to the package root.
  let icons = realpathSync(dirname(createRequire(join(core, 'package.json')).resolve('ionicons')));
  while (!existsSync(join(icons, 'package.json')) || JSON.parse(readFileSync(join(icons, 'package.json'), 'utf8')).name !== 'ionicons') {
    icons = dirname(icons);
  }
  mkdirSync(join(root, 'node_modules', '@ionic'), { recursive: true });
  symlinkSync(core, join(root, 'node_modules', '@ionic', 'core'));
  symlinkSync(icons, join(root, 'node_modules', 'ionicons'));
}

function sandbox({ modules = { demo: null }, offline = false, installFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-dev-ok-'));
  const bin = join(root, 'bin');
  const log = join(root, 'npm.log');
  write(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
${offline ? 'echo "npm error network ENOTFOUND" >&2; exit 1' : ''}
published=(${PUBLISHED.join(' ')})
if [ "$1" = view ]; then
  spec="\${2##*@}"
  if [ "$spec" = latest ]; then echo "\\"\${published[\${#published[@]}-1]}\\""; exit 0; fi
  for v in "\${published[@]}"; do [ "$v" = "$spec" ] && { echo "\\"$v\\""; exit 0; }; done
  echo "npm error 404 No match for $2" >&2; exit 1
fi
if [ "$1" = install ]; then
${installFails ? '  echo "npm error code ENOSPC" >&2; exit 1\n' : ''}  prefix=""; prev=""
  for a in "$@"; do [ "$prev" = "--prefix" ] && prefix="$a"; prev="$a"; done
  want="\${@: -1}"; v="\${want##*@}"
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

  const ws = join(root, 'ws');
  for (const [id, declared] of Object.entries(modules)) {
    write(join(ws, id, 'module.json'), JSON.stringify({ id, name: id, version: '1.0.0' }));
    write(join(ws, id, 'ui/components', `erp-${id}`, `erp-${id}.ts`), "import '@erplora/outfitkit/define';\nexport const x = 1;\n");
    if (declared) write(join(ws, id, 'package.json'), JSON.stringify({ devDependencies: { '@erplora/outfitkit': declared } }));
  }
  linkIonic(root);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(root, 'cache') };
  const npmCalls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []);
  return { root, ws, env, npmCalls, clean: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Starts the preview on a free port, captures what it prints, and hands back the served harness.
 * With no `dir` it previews the whole workspace, which `erplora dev` finds from the current directory.
 */
async function preview(s, dir) {
  const out = { log: [], warn: [] };
  const { log, warn } = console;
  const cwd = process.cwd();
  console.log = (...a) => out.log.push(a.join(' '));
  console.warn = (...a) => out.warn.push(a.join(' '));
  let handle;
  try {
    if (!dir) process.chdir(s.ws);
    handle = await startDev(dir, { port: 0, outfitkit: { env: s.env } });
  } finally {
    process.chdir(cwd);
    console.log = log;
    console.warn = warn;
  }
  try {
    const res = await fetch(`http://localhost:${handle.port}/harness.js`);
    assert.equal(res.status, 200);
    return { ...out, harness: await res.text(), outfitkit: handle.outfitkit };
  } finally {
    await handle.close();
  }
}

test('the positive control: the toolkit on this machine resolves an OutfitKit the fake registry does not publish', () => {
  assert.ok(LOCAL, 'the toolkit resolves no OutfitKit of its own');
  assert.ok(!PUBLISHED.includes(LOCAL), LOCAL);
});

test('dev previews a module with npm latest when it declares no version — what build bakes (all 27 today)', async () => {
  const s = sandbox();
  try {
    const p = await preview(s, join(s.ws, 'demo'));
    assert.ok(p.harness.includes('npm-0.0.125'), 'the preview bundles the OutfitKit build bakes, not the local copy');
    assert.ok(s.npmCalls().some((c) => c.startsWith('view @erplora/outfitkit@latest version')), s.npmCalls().join('\n'));
    assert.equal(p.outfitkit.version, '0.0.125');
    assert.ok(headerSays(p.harness, 'OutfitKit 0.0.125'), 'the preview header names the version it paints with');
    assert.ok(p.log.some((l) => l.includes('OutfitKit 0.0.125')), p.log.join('\n'));
    assert.equal(p.warn.length, 0, p.warn.join('\n'));
  } finally {
    s.clean();
  }
});

test('dev previews the version the module declares, as build does', async () => {
  const s = sandbox({ modules: { demo: '0.0.110' } });
  try {
    const p = await preview(s, join(s.ws, 'demo'));
    assert.ok(p.harness.includes('npm-0.0.110'), 'declared 0.0.110, previewed something else');
    assert.ok(!p.harness.includes('npm-0.0.125'));
    assert.ok(headerSays(p.harness, 'OutfitKit 0.0.110'));
  } finally {
    s.clean();
  }
});

test('the whole workspace previews the version its modules agree on', async () => {
  const s = sandbox({ modules: { alpha: '0.0.110', beta: '0.0.110' } });
  try {
    const p = await preview(s, undefined);
    assert.ok(p.harness.includes('npm-0.0.110'), 'both modules declare 0.0.110');
    assert.equal(p.warn.length, 0, p.warn.join('\n'));
  } finally {
    s.clean();
  }
});

test('a workspace whose modules disagree previews npm latest and says each module builds its own', async () => {
  const s = sandbox({ modules: { alpha: '0.0.110', beta: null } });
  try {
    const p = await preview(s, undefined);
    assert.ok(p.harness.includes('npm-0.0.125'), 'one bundle, one OutfitKit: latest');
    assert.ok(p.warn.some((w) => w.includes('outfitkit_specs_differ') && w.includes('alpha')), p.warn.join('\n'));
  } finally {
    s.clean();
  }
});

test('without npm the preview still comes up with the local copy — and says so, in the terminal and in the header', async () => {
  const s = sandbox({ offline: true });
  try {
    const p = await preview(s, join(s.ws, 'demo'));
    assert.ok(!p.harness.includes('__outfitkitBaked'), 'nothing from npm could be baked');
    assert.equal(p.outfitkit.source, 'local');
    assert.equal(p.outfitkit.version, LOCAL);
    assert.ok(headerSays(p.harness, `OutfitKit ${LOCAL} · local`), 'the header names the local copy it paints with');
    assert.ok(
      p.warn.some((w) => w.includes('outfitkit_unresolvable') && w.includes(LOCAL)),
      `the terminal warns that this is not what build publishes:\n${p.warn.join('\n')}`,
    );
  } finally {
    s.clean();
  }
});

test('npm names the version but cannot install it: the preview still comes up with the local copy and says why', async () => {
  // `outfitkit_unavailable` (install) as well as `outfitkit_unresolvable` (view): a preview publishes
  // nothing, so neither stops it — but a registry that answers `view` and fails `install` must not
  // leave the preview down or silent.
  const s = sandbox({ installFails: true });
  try {
    const p = await preview(s, join(s.ws, 'demo'));
    assert.ok(s.npmCalls().some((c) => c.startsWith('install ')), s.npmCalls().join('\n'));
    assert.equal(p.outfitkit.source, 'local');
    assert.ok(headerSays(p.harness, `OutfitKit ${LOCAL} · local`));
    assert.ok(p.warn.some((w) => w.includes('outfitkit_unavailable') && w.includes(LOCAL)), p.warn.join('\n'));
  } finally {
    s.clean();
  }
});
