// `package-lock.json` describes the tree `package.json` asks for — module-toolkit#167.
//
// WHY THIS FILE EXISTS. `package.json` declared `typescript@^5.7.0` and the lock had no
// `node_modules/typescript` at all, so `npm ci` died in cold with `EUSAGE … Missing:
// typescript@5.9.3 from lock file`. Nothing went red for months because `ci.yml` never runs
// `npm ci`: it installs `typescript` and `@ionic/core` one by one, precisely because three
// dependencies are `file:` paths into sibling checkouts a runner does not have. A drift nobody
// executes is a drift nobody sees — the same shape as the suite CI never ran (#1097) and the
// mirrors that skipped next to the checkout they needed (#90).
//
// AND THE CAUSE, which is what makes the guard worth more than the fix: commit 5760b9f added
// `typescript` to `package.json` running **pnpm**, which wrote a `pnpm-lock.yaml` (with
// typescript@5.9.3 in it) and left `package-lock.json` — the one npm, `.npmrc` and CI actually
// read — untouched. Two lockfiles for one package manager means every install silently follows a
// different tree, so the last check below is not decoration: it is the one that stops #167 from
// happening again.
//
// WHY NOT `npm ci --dry-run` here, which is what the issue asked for: it cannot run on a runner.
// It resolves `../hub/packages/module-sdk`, `../hub/packages/module-types` and `../outfitkit`
// first, and those checkouts do not exist there — the guard would fail for the wrong reason on
// every pull request, or be switched off. This reads the two files instead, needs no network and
// no `node_modules`, and catches the drift that `npm ci` would have reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));

/** The dependency maps npm compares when it decides the lock is in sync. */
const DEP_TYPES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** The lock's own copy of `package.json`'s root block — `packages[""]`, lockfileVersion >= 2. */
const root = lock.packages?.[''];

test('the lock is a lockfileVersion npm still reads, with a root block', () => {
  assert.ok(lock.lockfileVersion >= 2, `lockfileVersion ${lock.lockfileVersion} has no packages{}`);
  assert.ok(root, 'package-lock.json has no `packages[""]` block to compare against package.json');
});

test('the lock mirrors every dependency map of package.json, range for range', () => {
  // This is the comparison `npm ci` makes before it installs anything: a name or a range that
  // differs is what "your package.json and package-lock.json are not in sync" means.
  for (const type of DEP_TYPES) {
    assert.deepEqual(
      root[type] ?? {},
      pkg[type] ?? {},
      `package-lock.json's root ${type} do not match package.json's — regenerate with ` +
        '`npm install --package-lock-only` and commit the result',
    );
  }
});

// A package a CONSUMER gets from the registry while this checkout links the sibling repository
// (module-toolkit#333: `@erplora/outfitkit` is a `dependencies` range for whoever installs the
// toolkit, and a `devDependencies` `file:` here, where the shared OutfitKit runs ahead of the
// fleet on purpose). At the root npm honours the `devDependencies` spec, so the lock carries a
// link, not a registry node — and the `file:` check below is the one that vouches for it.
function linkedInThisCheckout(name) {
  return String(pkg.devDependencies?.[name] ?? '').startsWith('file:');
}

test('every registry dependency has a resolved node in the lock', () => {
  // The half that bit #167: the root block CAN name a package and the tree still not carry it,
  // which is the `Missing: <pkg> from lock file` that `npm ci` refuses to install through.
  const missing = [];
  for (const type of DEP_TYPES) {
    for (const [name, range] of Object.entries(pkg[type] ?? {})) {
      if (range.startsWith('file:') || range.startsWith('link:')) continue;
      if (linkedInThisCheckout(name)) continue;
      const node = lock.packages[`node_modules/${name}`];
      if (!node?.version || !node.resolved) missing.push(`${name}@${range}`);
    }
  }
  assert.deepEqual(missing, [], 'named in package.json, absent from the locked tree');
});

test('the locked version satisfies the range package.json asks for', () => {
  // `^`, `~` and exact pins — every range this repository uses. Anything else is reported rather
  // than waved through, so a range this check cannot read never passes by accident.
  const wrong = [];
  for (const type of DEP_TYPES) {
    for (const [name, range] of Object.entries(pkg[type] ?? {})) {
      if (range.startsWith('file:') || range.startsWith('link:')) continue;
      if (linkedInThisCheckout(name)) continue;
      const locked = lock.packages[`node_modules/${name}`]?.version;
      if (!locked) continue; // already reported by the test above
      const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(range);
      if (!m) {
        wrong.push(`${name}: range \`${range}\` is not one this check knows how to compare`);
        continue;
      }
      const [, op, major, minor, patch] = m;
      const got = /^(\d+)\.(\d+)\.(\d+)/.exec(locked);
      if (!got) {
        wrong.push(`${name}: locked version \`${locked}\` is not a plain semver`);
        continue;
      }
      const asked = [+major, +minor, +patch];
      const have = [+got[1], +got[2], +got[3]];
      const ge = have[0] > asked[0] ||
        (have[0] === asked[0] && (have[1] > asked[1] ||
          (have[1] === asked[1] && have[2] >= asked[2])));
      const within =
        op === '^' ? have[0] === asked[0] && ge
        : op === '~' ? have[0] === asked[0] && have[1] === asked[1] && ge
        : locked === `${major}.${minor}.${patch}`;
      if (!within) wrong.push(`${name}: package.json asks ${range}, the lock pins ${locked}`);
    }
  }
  assert.deepEqual(wrong, [], 'the locked tree does not satisfy package.json');
});

test('every file: dependency is linked in the lock', () => {
  const broken = [];
  for (const type of DEP_TYPES) {
    for (const [name, range] of Object.entries(pkg[type] ?? {})) {
      if (!range.startsWith('file:')) continue;
      const node = lock.packages[`node_modules/${name}`];
      if (!node?.link) broken.push(`${name}@${range}`);
      else if (node.resolved !== range.slice('file:'.length)) {
        broken.push(`${name}: package.json points at ${range}, the lock links ${node.resolved}`);
      }
    }
  }
  assert.deepEqual(broken, [], 'sibling checkouts declared in package.json, not linked in the lock');
});

test('package-lock.json is the ONLY lockfile in the repository', () => {
  // The cause of #167, turned into a check. `.npmrc`, `ci.yml` and every install here are npm; a
  // second lockfile means whoever reaches for the other package manager updates a tree nobody
  // else reads and leaves this one stale — silently, which is how the drift survived.
  const strays = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json']
    .filter((f) => existsSync(join(REPO, f)));
  assert.deepEqual(
    strays,
    [],
    'this repository installs with npm: a second lockfile drifts from package-lock.json without ' +
      'a single check going red, which is exactly how module-toolkit#167 happened',
  );
});
