// The gate step that rebuilds a module's bundle against hub develop's SDK — module-toolkit#389.
//
// `.github/scripts/check-dist-reproducible.sh` is what `validate-module` runs. It is executed here
// for real, with a fake `npm` (records its arguments, lays the packages out in the prefix) and a
// fake toolkit whose `bin/erplora.mjs` records how it was called: no network, and every decision
// the script takes is observable. What must hold:
//   - the bundler and Lit come at the toolkit's LOCKED versions (a rebuild with another Lit differs
//     for a reason that is not the SDK);
//   - OutfitKit comes at the version the module SEALED in `dist/outfitkit.json`;
//   - everything is linked where the toolkit resolves it, and the check runs with develop's SDK;
//   - a missing SDK or an unpublished sealed OutfitKit stops the step with the reason, before any
//     check can say anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, '.github/scripts/check-dist-reproducible.sh');
const LOCK = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
const locked = (name) => LOCK.packages[`node_modules/${name}`].version;

// The packages a rebuild bakes besides the module's own code and the SDK.
const BAKED = ['esbuild', 'lit', 'lit-html', 'lit-element', '@lit/reactive-element', '@lit-labs/ssr-dom-shim'];

function write(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

/**
 * A runner in a directory: a fake `npm` on PATH, a fake toolkit with the real lock, a module
 * (sealed with `sealed`, or unsealed with null) and an SDK directory.
 */
function runner({ sealed = '0.1.70', npmFailsOn = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'erplora-dist-step-'));
  const bin = join(root, 'bin');
  write(
    join(bin, 'npm'),
    `#!/usr/bin/env bash
echo "$*" >> "${join(root, 'npm.log')}"
prefix=""; prev=""
for a in "$@"; do [ "$prev" = "--prefix" ] && prefix="$a"; prev="$a"; done
for a in "$@"; do
  case "$a" in
    --*|install) ;;
    *@*)
      name="\${a%@*}"
      ${npmFailsOn ? `[ "$a" = "${npmFailsOn}" ] && { echo "npm error 404 $a" >&2; exit 1; }` : ''}
      mkdir -p "$prefix/node_modules/$name"
      echo "{\\"name\\":\\"$name\\",\\"version\\":\\"\${a##*@}\\"}" > "$prefix/node_modules/$name/package.json" ;;
  esac
done
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);

  const toolkit = join(root, 'toolkit');
  write(join(toolkit, 'package-lock.json'), JSON.stringify(LOCK));
  write(
    join(toolkit, 'bin', 'erplora.mjs'),
    `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'cli.json'))}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(process.env.FAKE_CLI_EXIT ?? 0));\n`,
  );

  const mod = join(root, 'mod');
  write(join(mod, 'module.json'), '{"id":"demo"}\n');
  if (sealed) write(join(mod, 'dist', 'outfitkit.json'), `${JSON.stringify({ outfitkit: sealed })}\n`);

  const sdk = join(root, 'hub', 'packages', 'module-sdk');
  write(join(sdk, 'package.json'), '{"name":"@erplora/module-sdk","main":"src/index.ts"}\n');

  const temp = join(root, 'runner-temp');
  mkdirSync(temp);
  const run = (sdkArg = sdk, env = {}, shell = 'bash') =>
    spawnSync(shell, [SCRIPT, mod, sdkArg], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ERPLORA_TOOLKIT: toolkit, RUNNER_TEMP: temp, ...env },
    });
  const npmLog = () => (existsSync(join(root, 'npm.log')) ? readFileSync(join(root, 'npm.log'), 'utf8') : '');
  const cli = () => (existsSync(join(root, 'cli.json')) ? JSON.parse(readFileSync(join(root, 'cli.json'), 'utf8')) : null);
  return { root, toolkit, mod, sdk, temp, run, npmLog, cli };
}

test('installs the LOCKED bundler and Lit plus the SEALED OutfitKit, links them, and runs the check with the SDK', () => {
  const r = runner({ sealed: '0.1.70' });
  try {
    const res = r.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const log = r.npmLog();
    for (const name of BAKED) assert.ok(log.includes(` ${name}@${locked(name)}`), `${name}@${locked(name)} not installed: ${log}`);
    assert.ok(log.includes(' @erplora/outfitkit@0.1.70'), `the sealed OutfitKit is what gets installed: ${log}`);
    assert.ok(log.includes('--legacy-peer-deps'), 'the scratch install skips peer resolution (module-toolkit#171)');
    for (const name of [...BAKED, '@erplora/outfitkit']) {
      const link = join(r.toolkit, 'node_modules', name);
      assert.equal(readlinkSync(link), join(r.temp, 'erplora-bundle-deps', 'node_modules', name), `${name} not linked into the toolkit`);
    }
    assert.deepEqual(r.cli(), ['build', r.mod, '--check', '--sdk', r.sdk]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('the verdict of the check is the verdict of the step', () => {
  const r = runner();
  try {
    const res = r.run(r.sdk, { FAKE_CLI_EXIT: '1' });
    assert.equal(res.status, 1);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('without the SDK the step fails naming the wiring, and installs nothing', () => {
  const r = runner();
  try {
    const res = r.run('');
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::.*module-sdk-path/);
    assert.equal(r.npmLog(), '');
    assert.equal(r.cli(), null);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('a sealed OutfitKit that npm cannot give fails the step naming that version, before any check', () => {
  const r = runner({ sealed: '0.1.999', npmFailsOn: '@erplora/outfitkit@0.1.999' });
  try {
    const res = r.run();
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::.*@erplora\/outfitkit@0\.1\.999/);
    assert.equal(r.cli(), null);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('an unsealed bundle installs no OutfitKit and lets the check say so', () => {
  const r = runner({ sealed: null });
  try {
    const res = r.run();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(!r.npmLog().includes('@erplora/outfitkit'));
    assert.deepEqual(r.cli(), ['build', r.mod, '--check', '--sdk', r.sdk]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('an SDK path that holds no package fails the same way, and installs nothing', () => {
  const r = runner();
  try {
    const res = r.run(r.temp);
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::.*module-sdk-path/);
    assert.equal(r.npmLog(), '');
    assert.equal(r.cli(), null);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

// module-toolkit#410: the step runs on the CI's bash 5, but `npm test` runs it on whatever `bash`
// comes first on PATH — on a Mac, the 3.2 that ships as /bin/bash. `mapfile` (bash 4+) made four of
// the tests above red there and green in CI. Two locks: the script runs for real on /bin/bash
// (catches it on a Mac), and it holds none of the bash 4+ builtins (catches it on the Ubuntu CI,
// whose /bin/bash is 5 and would run anything).
test('runs on the bash 3.2 macOS ships as /bin/bash, not only on the CI bash', { skip: !existsSync('/bin/bash') && 'no /bin/bash' }, () => {
  const r = runner({ sealed: '0.1.70' });
  try {
    const res = r.run(r.sdk, {}, '/bin/bash');
    assert.equal(res.status, 0, res.stdout + res.stderr);
    for (const name of BAKED) assert.ok(r.npmLog().includes(` ${name}@${locked(name)}`), `${name} not installed under /bin/bash`);
    assert.deepEqual(r.cli(), ['build', r.mod, '--check', '--sdk', r.sdk]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test('the script uses no bash 4+ builtin or syntax that bash 3.2 lacks', () => {
  const BASH4 = [
    [/^\s*(mapfile|readarray)\b/m, 'mapfile/readarray'],
    [/\b(declare|local|typeset)\s+-[a-zA-Z]*[An]/, 'associative arrays / namerefs (declare -A / -n)'],
    [/\$\{[#!]?\w+(\[[^\]]*\])?(,,?|\^\^?)[^}]*\}/, 'case modification ${x,,} / ${x^^}'],
    [/\bcoproc\b/, 'coproc'],
    [/&>>|\|&/, '&>> / |&'],
  ];
  const body = readFileSync(SCRIPT, 'utf8');
  for (const [re, what] of BASH4) assert.doesNotMatch(body, re, `${what} needs bash 4+: macOS ships bash 3.2 as /bin/bash`);
});
