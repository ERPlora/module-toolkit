// `erplora pack` has to judge the artifact it SHIPS, not the one it is about to overwrite —
// module-toolkit#201 (N-0 of the review of #202).
//
// The hole this closes, reproduced on the real `customers` module before it was fixed:
//
//     STAMP BEFORE                          {"outfitkit": "0.1.52"}
//     node bin/erplora.mjs pack …/customers  PACK EXIT=0   (not one word about the floor)
//     STAMP AFTER                           {"outfitkit": "0.1.59"}
//     unzip -p …/customers-v*.zip dist/outfitkit.json  ->  {"outfitkit": "0.1.59"}
//
// `pack` validated first and built second, and `build` rewrites `dist/outfitkit.json`
// (`src/build.mjs:102`). So the publishing door inspected a stamp it then replaced, and the zip
// left carrying a version no hub can paint — the exact defect this whole PR is about. It hit 25 of
// the 27 modules: every one whose committed stamp was older than the local `../outfitkit`.
//
// 🔴 AND WHY A GREP WAS NOT ENOUGH. The first guard for this seam asserted that `pack.mjs` calls
// `validate` with `publishing: true`. It passed all along — the flag WAS passed. What was wrong was
// WHEN, and no assertion about the text of a file can see that. This one drives the CLI and opens
// the zip.
//
// Lives in its own suite because it packs, and packing needs esbuild + lit: declared dependencies
// of this repository, but not installable on the runner of the module repos' gate. It is named in
// `CANNOT_RUN_IN_CI` (test/ci-runs-every-suite.test.mjs) for that reason, out loud, and
// `test/validate-outfitkit-floor.test.mjs` carries the cheap order tripwire that DOES run in CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newestKnownHub } from '../src/validate-outfitkit-floor.mjs';
import { resolvedSdkDir } from '../src/sdk-freshness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'erplora.mjs');

// What `build` stamps: npm's `latest` OutfitKit since module-toolkit#423, no longer the shared
// `../outfitkit`. A fake `npm` on PATH calls a version AHEAD of every hub `latest`, and a private
// cache already holds it (the fixture bakes no `ok-*`, so its package.json is all a bake reads).
// Before #423 these two tests skipped whenever the local checkout was not ahead of the fleet —
// that is, almost always; now the situation under test is built, not waited for.
const AHEAD = '9.0.0';
const OK_ROOT = mkdtempSync(join(tmpdir(), 'erplora-packfloor-ok-'));
mkdirSync(join(OK_ROOT, 'bin'));
mkdirSync(join(OK_ROOT, 'cache', AHEAD, 'node_modules', '@erplora', 'outfitkit'), { recursive: true });
writeFileSync(
  join(OK_ROOT, 'cache', AHEAD, 'node_modules', '@erplora', 'outfitkit', 'package.json'),
  JSON.stringify({ name: '@erplora/outfitkit', version: AHEAD }),
);
writeFileSync(join(OK_ROOT, 'bin', 'npm'), `#!/usr/bin/env bash\n[ "$1" = view ] && { echo '"${AHEAD}"'; exit 0; }\nexit 1\n`);
chmodSync(join(OK_ROOT, 'bin', 'npm'), 0o755);
process.on('exit', () => rmSync(OK_ROOT, { recursive: true, force: true }));
const OK_ENV = { PATH: `${join(OK_ROOT, 'bin')}:${process.env.PATH}`, ERPLORA_OUTFITKIT_CACHE: join(OK_ROOT, 'cache') };

/**
 * A module `pack` accepts: a real Lit component, its manifest, and a STALE stamp — the shape of the
 * 25 modules the hole applied to.
 */
function packableModule({ staleStamp, compatibility }) {
  const id = 'packfloor_fixture';
  const dir = join(mkdtempSync(join(tmpdir(), 'erplora-packfloor-')), id);
  mkdirSync(join(dir, 'ui', 'components', 'erp-packfloor'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  mkdirSync(join(dir, 'locales'), { recursive: true });
  const manifest = {
    id,
    name: 'Pack floor fixture',
    version: '1.0.0',
    navigation: [{ path: '/', component: 'erp-packfloor', label: 'packfloor.title' }],
  };
  if (compatibility) manifest.compatibility = compatibility;
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  for (const lang of ['en', 'es']) {
    writeFileSync(join(dir, 'locales', `${lang}.json`), JSON.stringify({ packfloor: { title: 'Pack floor' } }));
  }
  writeFileSync(
    join(dir, 'ui', 'components', 'erp-packfloor', 'erp-packfloor.ts'),
    "import { LitElement, html } from 'lit';\n" +
      'export class ErpPackfloor extends LitElement {\n' +
      '  render() {\n' +
      '    return html`<div>packfloor</div>`;\n' +
      '  }\n' +
      '}\n' +
      "customElements.define('erp-packfloor', ErpPackfloor);\n",
  );
  writeFileSync(join(dir, 'dist', 'outfitkit.json'), JSON.stringify({ outfitkit: staleStamp }));
  execFileSync(process.execPath, [CLI, 'contracts', dir], { stdio: 'ignore' });
  return { dir, id, manifest };
}

/**
 * develop's sha for the SDK check of `build` (module-toolkit#387): the HEAD of the hub checkout the
 * SDK resolves to, so these packs judge the OutfitKit floor and not where `../hub` was left, and
 * never ask a remote.
 */
function hubHeadEnv() {
  const sdk = resolvedSdkDir();
  if (!sdk) return {};
  const head = spawnSync('git', ['-C', sdk, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return head.status === 0 ? { ERPLORA_HUB_DEVELOP_SHA: head.stdout.trim() } : {};
}

function erplora(command, dir) {
  const res = spawnSync(process.execPath, [CLI, command, dir], {
    encoding: 'utf8',
    env: { ...process.env, ...hubHeadEnv(), ...OK_ENV },
  });
  return { ...res, out: `${res.stdout}\n${res.stderr}` };
}

// A stamp older than the fleet: `validate` on it says nothing at all. It is only after `build`
// re-stamps with the shared checkout that there is anything to catch — which is the whole point.
const STALE = '0.1.36';

test('pack JUDGES the stamp it ships, not the stale one it is about to overwrite (#201 N-0)', () => {
  // The positive control: what build will stamp really is ahead of every hub the table knows.
  assert.ok(compareAhead(AHEAD, newestKnownHub().outfitkit), `${AHEAD} vs ${newestKnownHub().outfitkit}`);
  const { dir, id } = packableModule({ staleStamp: STALE });
  const res = erplora('pack', dir);

  assert.equal(res.status, 1, `pack shipped a module no hub can paint:\n${res.out}`);
  assert.match(res.out, /module-toolkit#201/, `it must say WHY:\n${res.out}`);
  assert.match(res.out, new RegExp(AHEAD.replace(/\./g, '\\.')), 'it must name the stamp it SHIPS');
  // And the zip must not exist: a blocked publication does not leave an artifact behind.
  assert.equal(
    existsSync(join(dir, 'build', `${id}-v1.0.0.zip`)),
    false,
    'pack failed and still left a zip: that zip is exactly what would reach a client',
  );
});

test('the same module, declaring the floor its bake needs, packs fine (#201 N-0)', () => {
  // The way out has to work, or the gate above is just a wall. `9.9.9` is a floor newer than the
  // table knows: the honest declaration for «this needs a hub that has not shipped yet».
  const { dir, id } = packableModule({ staleStamp: STALE, compatibility: { min_erplora_version: '9.9.9' } });
  const res = erplora('pack', dir);
  assert.equal(res.status, 0, `declaring the floor has to let the module through:\n${res.out}`);
  const zip = join(dir, 'build', `${id}-v1.0.0.zip`);
  assert.ok(existsSync(zip), 'a green pack has to produce the zip');
  // And what travels is the FRESH stamp — the one that was judged.
  const shipped = JSON.parse(execFileSync('unzip', ['-p', zip, 'dist/outfitkit.json'], { encoding: 'utf8' }));
  assert.equal(shipped.outfitkit, AHEAD, 'the zip must carry the stamp the gate looked at');
});

/** `a` strictly newer than `b`, by number. Local to this suite: it only orders two known versions. */
function compareAhead(a, b) {
  const n = (v) => v.split('.').map(Number);
  const [pa, pb] = [n(a), n(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

test('building first does NOT cost the good error message on a broken manifest (#201 N-0)', () => {
  // The price of the new order, and it is paid rather than dropped. With `validate` first, a bad
  // manifest failed with «id inválido»; with `build` first it failed with «no encuentro entry de
  // WC», which is true and useless. So a failed build asks the validator why before giving up.
  const dir = join(mkdtempSync(join(tmpdir(), 'erplora-packbroken-')), 'BadId');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id: 'Bad-Id', name: 'x', version: 'nope' }));
  const res = erplora('pack', dir);
  assert.equal(res.status, 1);
  assert.match(res.out, /id inválido/, `the manifest error is the one that helps:\n${res.out}`);
  assert.match(res.out, /version SemVer inválida/, res.out);
});
