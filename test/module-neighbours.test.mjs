// The module gate brings the NEIGHBOURS a module's recipes put a floor on — module-toolkit#343.
//
// WHY THIS EXISTS. A module whose automations declare the minimum version of a neighbour they need
// (`flows/*.requires.json`, e.g. WhatsApp needs a Customers that already knows the business's
// country) checks that floor in its own battery by reading the neighbour's PUBLISHED history, from
// the checkout next to it. The gate only checked out the module itself, so on CI the battery found
// no neighbour, printed «skipped» and went GREEN: a floor too low passed CI and only a developer
// with every neighbour up to date on their own machine could catch it (whatsapp_inbox#213).
//
// The step clones every module of the deploy-key bundle next to the module, WITH HISTORY (the
// battery finds a release as the commit whose manifest first declares it — a shallow clone has no
// past). A module that declares floors and gets no bundle goes RED, never green-with-a-skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bundleIds,
  cleanup,
  floorModules,
  main,
  planClones,
} from '../src/module-neighbours.mjs';

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

/** A bare-ish "remote" per module id with TWO releases, so a shallow clone is detectable. */
function makeRemotes(root, ids) {
  for (const id of ids) {
    const dir = join(root, id);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    for (const version of ['1.0.0', '1.0.1']) {
      writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, version }, null, 2));
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', `chore(release): v${version}`);
    }
  }
}

/** A module checkout at `<parent>/<id>` with the given `flows/*.requires.json` documents. */
function makeModule(parent, id, requires = {}) {
  const dir = join(parent, id);
  mkdirSync(join(dir, 'flows'), { recursive: true });
  writeFileSync(join(dir, 'module.json'), JSON.stringify({ id, version: '2.0.0' }));
  for (const [family, modules] of Object.entries(requires)) {
    writeFileSync(join(dir, 'flows', `${family}.requires.json`), JSON.stringify({ _why: 'x', modules }));
  }
  return dir;
}

function makeKeys(root, names) {
  mkdirSync(root, { recursive: true });
  for (const n of names) writeFileSync(join(root, n), 'not-a-real-key\n');
  return root;
}

function quietIo() {
  const out = [];
  return { out, io: { log: (m) => out.push(m), error: (m) => out.push(m) } };
}

test('the floors are the union of every family, without the module itself', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nb-floors-'));
  const dir = makeModule(parent, 'whatsapp_inbox', {
    'appointment-from-whatsapp': { appointments: '1.1.77', customers: '2.3.47' },
    'reservation-from-whatsapp': { reservations: '3.0.30', customers: '2.3.47' },
    'odd-self-floor': { whatsapp_inbox: '2.0.0' },
  });
  assert.deepEqual(floorModules(dir), ['appointments', 'customers', 'reservations']);
});

test('a module without floors needs no neighbour', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nb-none-'));
  assert.deepEqual(floorModules(makeModule(parent, 'sales')), []);
});

test('an unreadable requires.json is an error, never «no floors»', () => {
  const parent = mkdtempSync(join(tmpdir(), 'nb-bad-'));
  const dir = makeModule(parent, 'whatsapp_inbox');
  writeFileSync(join(dir, 'flows', 'broken.requires.json'), '{ not json');
  assert.throws(() => floorModules(dir), /broken\.requires\.json/);
});

test('the bundle lists module ids only — the AppleDouble sidecars of a Mac tar are not modules', () => {
  const keys = makeKeys(mkdtempSync(join(tmpdir(), 'nb-keys-')), [
    'customers', '._customers', '.DS_Store', 'appointments', 'known_hosts.old',
  ]);
  assert.deepEqual(bundleIds(keys), ['appointments', 'customers']);
});

test('the plan clones the whole bundle but the module itself, and names floors it cannot reach', () => {
  assert.deepEqual(
    planClones({ self: 'whatsapp_inbox', floors: ['customers', 'staff'], bundle: ['customers', 'sales', 'whatsapp_inbox'] }),
    { clone: ['customers', 'sales'], missing: ['staff'] },
  );
});

test('a module without floors passes without a bundle and clones nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-none-'));
  const dir = makeModule(join(root, 'work'), 'sales');
  const { io } = quietIo();
  const verdict = main(['--module-dir', dir, '--keys', join(root, 'absent')], io);
  assert.equal(verdict.code, 'no_floors');
  assert.equal(verdict.exit, 0);
});

test('floors without a bundle are RED: «could not look» is never a green', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-nokeys-'));
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  const { io } = quietIo();
  const verdict = main(['--module-dir', dir, '--keys', join(root, 'absent')], io);
  assert.equal(verdict.code, 'no_keys');
  assert.equal(verdict.exit, 1);
});

test('a floor module missing from the bundle is RED and named', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-missing-'));
  makeRemotes(join(root, 'remotes'), ['customers']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0', staff: '1.0.0' } });
  const keys = makeKeys(join(root, 'keys'), ['customers']);
  const { io } = quietIo();
  const verdict = main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', `file://${join(root, 'remotes')}/%s`],
    io,
  );
  assert.equal(verdict.code, 'missing_keys');
  assert.deepEqual(verdict.missing, ['staff']);
  assert.equal(verdict.exit, 1);
  assert.equal(existsSync(join(root, 'work', 'customers')), false, 'nothing is cloned on a red plan');
});

test('the neighbours land NEXT TO the module, with their full history, and the module is untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-ok-'));
  makeRemotes(join(root, 'remotes'), ['customers', 'sales', 'whatsapp_inbox']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  const keys = makeKeys(join(root, 'keys'), ['customers', 'sales', 'whatsapp_inbox']);
  const { io } = quietIo();
  const verdict = main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', `file://${join(root, 'remotes')}/%s`],
    io,
  );
  assert.equal(verdict.code, 'ok');
  assert.equal(verdict.exit, 0);
  for (const id of ['customers', 'sales']) {
    const clone = join(root, 'work', id);
    assert.equal(JSON.parse(readFileSync(join(clone, 'module.json'), 'utf8')).id, id);
    // The battery reads releases out of the history: a shallow clone would answer «no commit
    // declares that version» and turn every floor into a skip again.
    assert.equal(git(clone, 'rev-parse', '--is-shallow-repository'), 'false');
    assert.equal(git(clone, 'rev-list', '--count', 'HEAD'), '2');
  }
  assert.equal(JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')).version, '2.0.0');
  assert.equal(existsSync(join(dir, '.git')), false, 'the module itself is never re-cloned over');
});

test('a stale neighbour left by an earlier job on the same runner is replaced, not reused', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-stale-'));
  makeRemotes(join(root, 'remotes'), ['customers']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  mkdirSync(join(root, 'work', 'customers'));
  writeFileSync(join(root, 'work', 'customers', 'module.json'), JSON.stringify({ id: 'customers', version: '0.0.1' }));
  const keys = makeKeys(join(root, 'keys'), ['customers']);
  const { io } = quietIo();
  const verdict = main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', `file://${join(root, 'remotes')}/%s`],
    io,
  );
  assert.equal(verdict.code, 'ok');
  assert.equal(JSON.parse(readFileSync(join(root, 'work', 'customers', 'module.json'), 'utf8')).version, '1.0.1');
});

test('a clone that fails is RED and named', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-fail-'));
  makeRemotes(join(root, 'remotes'), ['customers']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  const keys = makeKeys(join(root, 'keys'), ['customers', 'ghost']);
  const { io } = quietIo();
  const verdict = main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', `file://${join(root, 'remotes')}/%s`, '--attempts', '1'],
    io,
  );
  assert.equal(verdict.code, 'clone_failed');
  assert.deepEqual(verdict.failed, ['ghost']);
  assert.equal(verdict.exit, 1);
});

/**
 * Runs `fn` with a fake `ssh` first on PATH that answers like GitHub: it serves the repos under
 * `remotes` and, for a repo that is not there, prints GitHub's «ERROR: Repository not found.» and
 * fails. The clone goes through the real SSH path of the step (GIT_SSH_COMMAND with the key).
 */
function withFakeGithubSsh(root, remotes, fn) {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'ssh'),
    [
      '#!/bin/sh',
      'for last; do :; done',
      'repo=$(printf %s "$last" | sed "s/^[^ ]* //; s/\'//g")',
      `cd '${remotes}' || exit 255`,
      'if [ ! -d "$repo" ]; then echo "ERROR: Repository not found." >&2; exit 1; fi',
      'exec sh -c "$last"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('a neighbour whose repository is gone and that no recipe floors is left out, not RED — module-toolkit#470', () => {
  // invoice_series, tickets and payment_gateways were retired and their repos deleted, while the
  // MODULES_DEPLOY_KEYS bundle still carried their keys: every module with floors went red on a
  // neighbour none of its recipes needs.
  const root = mkdtempSync(join(tmpdir(), 'nb-main-gone-'));
  makeRemotes(join(root, 'remotes'), ['customers', 'sales']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  const keys = makeKeys(join(root, 'keys'), ['customers', 'sales', 'tickets']);
  const { out, io } = quietIo();
  const verdict = withFakeGithubSsh(root, join(root, 'remotes'), () => main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', 'git@github.test:%s', '--attempts', '1'],
    io,
  ));
  assert.equal(verdict.code, 'ok', out.join('\n'));
  assert.equal(verdict.exit, 0);
  assert.deepEqual(verdict.gone, ['tickets']);
  assert.ok(out.some((m) => m.includes('tickets')), 'the left-out neighbour is named in the log');
  for (const id of ['customers', 'sales']) assert.equal(existsSync(join(root, 'work', id, 'module.json')), true);
  assert.equal(existsSync(join(root, 'work', 'tickets')), false);
  const record = JSON.parse(readFileSync(join(root, 'work', '.erplora-neighbours.json'), 'utf8'));
  assert.deepEqual(record.cloned, ['customers', 'sales']);
});

test('a FLOOR neighbour whose repository is gone stays RED — the floor cannot be checked', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-main-gone-floor-'));
  makeRemotes(join(root, 'remotes'), ['customers']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0', tickets: '1.0.0' } });
  const keys = makeKeys(join(root, 'keys'), ['customers', 'tickets']);
  const { out, io } = quietIo();
  const verdict = withFakeGithubSsh(root, join(root, 'remotes'), () => main(
    ['--module-dir', dir, '--keys', keys, '--remote-template', 'git@github.test:%s', '--attempts', '1'],
    io,
  ));
  assert.equal(verdict.code, 'clone_failed', out.join('\n'));
  assert.deepEqual(verdict.failed, ['tickets']);
  assert.equal(verdict.exit, 1);
});

test('cleanup removes exactly the neighbours it cloned, and never the module', () => {
  const root = mkdtempSync(join(tmpdir(), 'nb-cleanup-'));
  makeRemotes(join(root, 'remotes'), ['customers', 'sales']);
  const dir = makeModule(join(root, 'work'), 'whatsapp_inbox', { fam: { customers: '1.0.0' } });
  mkdirSync(join(root, 'work', 'unrelated'));
  const keys = makeKeys(join(root, 'keys'), ['customers', 'sales']);
  const { io } = quietIo();
  main(['--module-dir', dir, '--keys', keys, '--remote-template', `file://${join(root, 'remotes')}/%s`], io);
  cleanup(dir, io);
  assert.equal(existsSync(join(root, 'work', 'customers')), false);
  assert.equal(existsSync(join(root, 'work', 'sales')), false);
  assert.equal(existsSync(join(dir, 'module.json')), true);
  assert.equal(existsSync(join(root, 'work', 'unrelated')), true);
});
