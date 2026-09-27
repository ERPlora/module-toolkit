// `erplora build` refuses to bake a module SDK that is behind hub `develop` — module-toolkit#387.
//
// The hole: `build` resolves `@erplora/module-sdk` through the toolkit's `file:` link into the
// SHARED `../hub` checkout, whatever branch it was left on. On 2026-09-27 that checkout sat 12 SDK
// commits behind develop, without hub#2271, and four rebuilds (sales, pricing, kitchen ×2) shipped a
// `dist/` whose list controller filtered money amounts in cents again — one of them nearly undid
// kitchen#109, merged minutes before. Nothing said a word.
//
// No network here: every hub is a local git repository, and develop's sha is either injected or
// read from a local bare `origin`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkSdkFreshness, assertSdkFresh } from '../src/sdk-freshness.mjs';

const NO_ENV = {};

function write(root, file, body) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), body);
}

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@example.com', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const OLD_CONTROLLER = 'export const moneyFilter = (v) => v; // cents, the bug\n';
const FIXED_CONTROLLER =
  "export const moneyFilter = (v, d) => { if (d == null) throw new Error('list_money_filters_need_currency_decimals'); return v * 10 ** d; };\n";

/**
 * A hub the shape of ERPlora/hub: `packages/module-sdk` + `packages/module-types` + a runtime.
 * `base` carries the OLD list controller; `develop` moves on to `fix`, the hub#2271 of this story.
 * A branch `stale` stays at `base` — the shared checkout left behind.
 */
function hubFixture() {
  const root = mkdtempSync(join(tmpdir(), 'erplora-sdk-fresh-'));
  const hub = join(root, 'hub');
  write(hub, 'packages/module-sdk/package.json', '{"name":"@erplora/module-sdk","main":"src/index.ts"}\n');
  write(hub, 'packages/module-sdk/src/index.ts', OLD_CONTROLLER);
  write(hub, 'packages/module-types/package.json', '{"name":"@erplora/module-types"}\n');
  write(hub, 'crates/runtime/src/lib.rs', '// runtime\n');
  git(root, 'init', '-q', '-b', 'develop', 'hub');
  const base = commitAll(hub, 'base');
  git(hub, 'branch', 'stale');
  write(hub, 'packages/module-sdk/src/index.ts', FIXED_CONTROLLER);
  const fix = commitAll(hub, 'module-sdk: money filters scale by currency decimals (hub#2271)');
  return { root, hub, sdkDir: join(hub, 'packages', 'module-sdk'), base, fix };
}

test('a checkout BEHIND develop in the SDK is refused, with the command that updates it', () => {
  const f = hubFixture();
  try {
    // The local `develop` left at `base`, the commit with the fix only on origin's develop.
    git(f.hub, 'checkout', '-q', 'stale');
    git(f.hub, 'branch', '-f', 'develop', f.base);
    git(f.hub, 'checkout', '-q', 'develop');
    // The positive control: this is a really old SDK — the fix is not in what would be baked.
    assert.ok(!readFileSync(join(f.sdkDir, 'src', 'index.ts'), 'utf8').includes('currency_decimals'));

    const result = checkSdkFreshness(f.sdkDir, { developSha: f.fix, env: NO_ENV });
    assert.equal(result.status, 'behind');
    assert.equal(result.behind, 1);
    assert.equal(result.hubDir, f.hub);

    let error;
    assert.throws(() => assertSdkFresh({ sdkDir: f.sdkDir, developSha: f.fix, env: NO_ENV }), (e) => (error = e, true));
    assert.equal(error.code, 'module_sdk_behind_develop');
    assert.equal(error.fix, `git -C '${f.hub}' fetch origin develop && git -C '${f.hub}' merge --ff-only origin/develop`);
    assert.ok(error.message.includes(error.fix), 'the refusal has to PRINT the command, not only carry it');
    assert.ok(error.message.includes(f.fix.slice(0, 7)) && error.message.includes(f.base.slice(0, 7)),
      'it names both shas: what would be baked and what develop has');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('on another branch the command leaves it alone: detach onto develop, never rebase it', () => {
  // The shared `../hub` sits on SOMEONE ELSE's branch (feat/1844 on 2026-09-27): rewriting it
  // (rebase) or moving it (fast-forward) is not what a module rebuild gets to do.
  const f = hubFixture();
  try {
    for (const ownWork of [false, true]) {
      git(f.hub, 'checkout', '-q', 'stale');
      if (ownWork) {
        write(f.hub, 'crates/runtime/src/lib.rs', '// the branch own work\n');
        commitAll(f.hub, 'own work');
      }
      const head = git(f.hub, 'rev-parse', 'HEAD');
      let error;
      assert.throws(() => assertSdkFresh({ sdkDir: f.sdkDir, developSha: f.fix, env: NO_ENV }), (e) => (error = e, true));
      assert.equal(error.code, 'module_sdk_behind_develop');
      assert.equal(error.fix, `git -C '${f.hub}' fetch origin develop && git -C '${f.hub}' switch --detach origin/develop`);
      assert.ok(error.message.includes(`git -C '${f.hub}' switch stale`), 'it says how to get the branch back');
      assert.equal(git(f.hub, 'rev-parse', 'HEAD'), head, 'the check itself moves nothing');
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('a checkout ON develop builds', () => {
  const f = hubFixture();
  try {
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: f.fix, env: NO_ENV }).status, 'fresh');
    assert.equal(assertSdkFresh({ sdkDir: f.sdkDir, developSha: f.fix, env: NO_ENV }).status, 'fresh');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('behind develop only OUTSIDE the SDK builds: what is baked is identical', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', '-b', 'feature');
    write(f.hub, 'crates/runtime/src/lib.rs', '// feature work\n');
    commitAll(f.hub, 'feature work');
    git(f.hub, 'checkout', '-q', 'develop');
    write(f.hub, 'crates/runtime/src/other.rs', '// develop moves on, runtime only\n');
    const develop = commitAll(f.hub, 'runtime only');
    git(f.hub, 'checkout', '-q', 'feature');
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: develop, env: NO_ENV }).status, 'fresh');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('the same SDK bytes as develop build even without its commits (a cherry-pick, a local edit)', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', 'stale');
    git(f.hub, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'cherry-pick', '-x', f.fix);
    assert.notEqual(git(f.hub, 'rev-list', '--count', `HEAD..${f.fix}`), '0', 'develop commit is still missing');
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: f.fix, env: NO_ENV }).status, 'fresh');

    git(f.hub, 'checkout', '-q', '-f', 'stale');
    write(f.hub, 'packages/module-sdk/src/index.ts', FIXED_CONTROLLER); // uncommitted, develop's bytes
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: f.fix, env: NO_ENV }).status, 'fresh');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('AHEAD of develop in the SDK builds: it is how an SDK change is tried on a module', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', '-b', 'sdk-work');
    write(f.hub, 'packages/module-sdk/src/next.ts', 'export const next = 1;\n');
    commitAll(f.hub, 'sdk work');
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: f.fix, env: NO_ENV }).status, 'fresh');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('module-types counts as the SDK too: a checkout behind develop there is refused', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', '-b', 'types-behind', f.fix);
    git(f.hub, 'checkout', '-q', 'develop');
    write(f.hub, 'packages/module-types/index.d.ts', 'export type Row = {};\n');
    const develop = commitAll(f.hub, 'types');
    git(f.hub, 'checkout', '-q', 'types-behind');
    assert.equal(checkSdkFreshness(f.sdkDir, { developSha: develop, env: NO_ENV }).status, 'behind');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('an SDK copy that is not a hub checkout (the npm tarball vendor/) is not judged', () => {
  const plain = mkdtempSync(join(tmpdir(), 'erplora-sdk-plain-'));
  const repo = mkdtempSync(join(tmpdir(), 'erplora-sdk-vendor-'));
  try {
    write(plain, 'package.json', '{"name":"@erplora/module-sdk"}\n');
    assert.equal(checkSdkFreshness(plain, { developSha: 'a'.repeat(40), env: NO_ENV }).status, 'no_hub_checkout');

    // The toolkit's own checkout carries a copy under vendor/: a git repo, but not a hub.
    write(repo, 'vendor/@erplora/module-sdk/package.json', '{"name":"@erplora/module-sdk"}\n');
    git(repo, 'init', '-q', '-b', 'main');
    commitAll(repo, 'toolkit');
    const vendored = join(repo, 'vendor', '@erplora', 'module-sdk');
    assert.equal(checkSdkFreshness(vendored, { developSha: 'a'.repeat(40), env: NO_ENV }).status, 'no_hub_checkout');
    assert.equal(assertSdkFresh({ sdkDir: vendored, developSha: 'a'.repeat(40), env: NO_ENV }).status, 'no_hub_checkout');
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

test('when develop cannot be read the build is not blocked, but the result says why', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', 'stale');
    // No `origin`: neither ls-remote nor fetch can answer.
    const unknown = checkSdkFreshness(f.sdkDir, { env: NO_ENV });
    assert.equal(unknown.status, 'unverifiable');
    assert.equal(unknown.reason, 'develop_unreadable');
    // A sha this clone does not have, and no origin to fetch it from.
    const missing = checkSdkFreshness(f.sdkDir, { developSha: 'b'.repeat(40), env: NO_ENV });
    assert.equal(missing.status, 'unverifiable');
    assert.equal(missing.reason, 'develop_commit_missing');
    assert.equal(assertSdkFresh({ sdkDir: f.sdkDir, env: NO_ENV }).status, 'unverifiable');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('ERPLORA_HUB_DEVELOP_SHA injects develop when no option does', () => {
  const f = hubFixture();
  try {
    git(f.hub, 'checkout', '-q', 'stale');
    assert.equal(checkSdkFreshness(f.sdkDir, { env: { ERPLORA_HUB_DEVELOP_SHA: f.fix } }).status, 'behind');
    assert.equal(checkSdkFreshness(f.sdkDir, { env: { ERPLORA_HUB_DEVELOP_SHA: f.base } }).status, 'fresh');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('by default develop is read from the hub origin, and fetched when the clone lacks it', () => {
  const f = hubFixture();
  try {
    // A local bare `origin` stands in for GitHub: the real default path, without network.
    const origin = join(f.root, 'origin.git');
    git(f.root, 'clone', '-q', '--bare', f.hub, origin);
    git(f.hub, 'remote', 'add', 'origin', origin);
    git(f.hub, 'checkout', '-q', 'stale');
    assert.equal(checkSdkFreshness(f.sdkDir, { env: NO_ENV }).status, 'behind');

    // develop moves on in origin with an SDK commit this clone has never seen.
    const other = join(f.root, 'other');
    git(f.root, 'clone', '-q', '-b', 'develop', origin, other);
    write(other, 'packages/module-sdk/src/later.ts', 'export const later = 1;\n');
    const later = commitAll(other, 'later sdk fix');
    git(other, 'push', '-q', 'origin', 'develop');
    git(f.hub, 'checkout', '-q', 'develop'); // at `fix`, one SDK commit behind origin now
    const result = checkSdkFreshness(f.sdkDir, { env: NO_ENV });
    assert.equal(result.status, 'behind', 'the missing commit had to be fetched to be compared');
    assert.equal(result.develop, later);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

// --- wiring: `erplora build` ----------------------------------------------------------------

function moduleFixture() {
  const dir = join(mkdtempSync(join(tmpdir(), 'erplora-sdk-build-')), 'sdkfresh_demo');
  write(dir, 'module.json', JSON.stringify({ id: 'sdkfresh_demo', name: 'Demo', version: '1.0.0' }));
  write(dir, 'src/demo.js', 'export const demo = 1;\n');
  return dir;
}

/** Runs `fn` with console.log/warn captured. */
async function captured(fn) {
  const lines = { log: [], warn: [] };
  const { log, warn } = console;
  console.log = (...a) => lines.log.push(a.join(' '));
  console.warn = (...a) => lines.warn.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
  return lines;
}

test('erplora build stops BEFORE writing dist/ when the SDK is behind develop', async () => {
  const f = hubFixture();
  const dir = moduleFixture();
  try {
    git(f.hub, 'checkout', '-q', 'stale');
    const { build } = await import('../src/build.mjs');
    await assert.rejects(
      () => build(dir, { sdk: { sdkDir: f.sdkDir, developSha: f.fix, env: NO_ENV } }),
      (e) => e.code === 'module_sdk_behind_develop',
    );
    assert.equal(existsSync(join(dir, 'dist', 'sdkfresh_demo.esm.js')), false, 'no bundle with the old SDK');
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('erplora build builds against develop and says which SDK it baked', async () => {
  const f = hubFixture();
  const dir = moduleFixture();
  try {
    const { build } = await import('../src/build.mjs');
    const out = await captured(() => build(dir, { sdk: { sdkDir: f.sdkDir, developSha: f.fix, env: NO_ENV } }));
    assert.ok(existsSync(join(dir, 'dist', 'sdkfresh_demo.esm.js')));
    assert.ok(out.log.some((l) => l.startsWith('✓ module-sdk sdkfresh_demo:') && l.includes(f.fix.slice(0, 7))), out.log.join('\n'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('erplora build warns out loud when it cannot tell, and still builds', async () => {
  const f = hubFixture();
  const dir = moduleFixture();
  try {
    const { build } = await import('../src/build.mjs');
    const out = await captured(() => build(dir, { sdk: { sdkDir: f.sdkDir, env: NO_ENV } }));
    assert.ok(existsSync(join(dir, 'dist', 'sdkfresh_demo.esm.js')));
    assert.ok(out.warn.some((l) => l.startsWith('⚠ module-sdk sdkfresh_demo:') && l.includes('develop_unreadable')), out.warn.join('\n'));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test('erplora build with no SDK installed has nothing to judge', async () => {
  const dir = moduleFixture();
  try {
    const { build } = await import('../src/build.mjs');
    const out = await captured(() => build(dir, { sdk: { sdkDir: null } }));
    assert.ok(existsSync(join(dir, 'dist', 'sdkfresh_demo.esm.js')));
    assert.equal(out.warn.filter((l) => l.includes('module-sdk')).length, 0);
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});
