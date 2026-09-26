// The HUB_OUTFITKIT row a new hub tag needs, derived by a machine (module-toolkit#271).
//
// Every hub release left `the NEWEST hub tag is in HUB_OUTFITKIT` red — on the hub's pull requests,
// which run this toolkit's mirrors — until somebody wrote the row by hand: five times between
// 1.1.15 and 1.1.29, one of them with the hub blocked for three hours. The rule for the row was
// already written down and re-run by the mirror itself («the last `@erplora/outfitkit` published
// on npm before the tag was created»), so what these tests pin is the machine that applies it:
//
//   * the derivation is ONE function, shared by the script that writes the row and by the mirror
//     that approves it — two copies of a rule are how a table drifts from its own check;
//   * the script finds the tags the table lacks, writes their rows in version order and says what
//     it did, and refuses to invent a row it cannot derive;
//   * on a hub PULL REQUEST a missing row is the copy lagging behind a release, not the PR's fault:
//     it is reported, with the command that writes it, instead of failing somebody else's work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestPublishedBefore,
  hubRowFor,
  missingHubTags,
  insertHubRows,
  rowLagIsWarning,
  ROW_LAG_ENV,
} from '../src/hub-outfitkit-rows.mjs';
import { HUB_OUTFITKIT } from '../src/validate-outfitkit-floor.mjs';
import { run } from '../scripts/hub-outfitkit-rows.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const FLOOR_SRC = join(REPO, 'src/validate-outfitkit-floor.mjs');

/** The shape `npm view @erplora/outfitkit time --json` answers with. */
const NPM_TIME = {
  created: '2026-01-01T00:00:00.000Z',
  modified: '2026-09-20T00:00:00.000Z',
  '0.1.72': '2026-09-11T07:28:49.000Z',
  '0.1.73': '2026-09-16T08:18:51.000Z',
  '0.1.9': '2026-02-01T00:00:00.000Z',
};

// ── the derivation ────────────────────────────────────────────────────────────────────────────

test('the row is the LAST OutfitKit published before the tag was created (#271)', () => {
  assert.equal(latestPublishedBefore(NPM_TIME, Date.parse('2026-09-16T18:56:44Z')), '0.1.73');
  assert.equal(latestPublishedBefore(NPM_TIME, Date.parse('2026-09-15T12:52:22Z')), '0.1.72');
  // The instant of publication counts as published: the mirror has always used `<=`.
  assert.equal(latestPublishedBefore(NPM_TIME, Date.parse('2026-09-16T08:18:51Z')), '0.1.73');
  // `created`/`modified` are npm bookkeeping, never versions.
  assert.equal(latestPublishedBefore(NPM_TIME, Date.parse('2026-01-15T00:00:00Z')), null);
});

test('ordering is by DATE, not by the version string (#271)', () => {
  // `'0.1.9' > '0.1.73'` alphabetically; by date 0.1.9 is months older.
  assert.equal(latestPublishedBefore(NPM_TIME, Date.parse('2026-03-01T00:00:00Z')), '0.1.9');
});

test('a row carries the tag creation instant in UTC, whatever offset git printed (#271)', () => {
  assert.deepEqual(hubRowFor('v1.1.25', '2026-09-16T20:56:44+02:00', NPM_TIME), {
    hub: '1.1.25',
    built_at: '2026-09-16T18:56:44Z',
    outfitkit: '0.1.73',
  });
});

test('a tag created before any OutfitKit existed is REFUSED, never guessed (#271)', () => {
  assert.throws(
    () => hubRowFor('v1.1.0', '2025-12-01T00:00:00Z', NPM_TIME),
    (err) => err.code === 'no_outfitkit_before_tag',
  );
});

test('the table rows already written agree with the shared derivation where npm dates are known (#271)', () => {
  // The fixture above carries the real publication instants of 0.1.72 and 0.1.73, so every real row
  // on those two versions must come out of `hubRowFor` byte for byte. This is what makes the script
  // and the mirror one rule, not two.
  const rows = HUB_OUTFITKIT.filter((r) => r.outfitkit === '0.1.72' || r.outfitkit === '0.1.73');
  assert.ok(rows.length >= 5, 'the fixture no longer covers the table');
  for (const row of rows) {
    assert.deepEqual(hubRowFor(`v${row.hub}`, row.built_at, NPM_TIME), row);
  }
});

// ── which tags need a row ─────────────────────────────────────────────────────────────────────

test('missing tags: only releases from the table floor up, in VERSION order (#271)', () => {
  const tags = [
    ['v1.0.2', '2026-07-01T00:00:00Z'], // pre-fleet: outside the table on purpose
    ['v1.1.31', '2026-09-22T10:00:00Z'],
    ['v1.1.30', '2026-09-22T11:00:00Z'], // tagged AFTER 1.1.31: order is by version, not date
    ['v1.1.29', '2026-09-19T20:46:51Z'], // already in the table
    ['v1.1.32-rc.1', '2026-09-23T00:00:00Z'], // not a release tag
    ['v1.2.0', '2026-09-23T01:00:00Z'], // a new minor is NOT outside the table
  ];
  // A fixed table, not the real one: the real HUB_OUTFITKIT grows with every hub tag, and the day
  // v1.1.30 got its row this assertion went red on a correct table.
  const table = [{ hub: '1.1.29', built_at: '2026-09-19T20:46:51Z', outfitkit: '0.1.73' }];
  assert.deepEqual(
    missingHubTags(tags, table).map(([tag]) => tag),
    ['v1.1.30', 'v1.1.31', 'v1.2.0'],
  );
});

// ── writing the rows into the source ──────────────────────────────────────────────────────────

const TABLE_SRC = `const x = 1;
export const HUB_OUTFITKIT = [
  { hub: '1.1.8', built_at: '2026-08-19T16:52:11Z', outfitkit: '0.1.40' },
  // a comment that belongs to the row BELOW it
  { hub: '1.1.10', built_at: '2026-08-26T21:30:45Z', outfitkit: '0.1.56' },
];

export const OTHER = [
  { hub: '9.9.9' },
];
`;

test('new rows land INSIDE HUB_OUTFITKIT, in version order, above the comment of the next row (#271)', () => {
  const out = insertHubRows(TABLE_SRC, [
    { hub: '1.1.9', built_at: '2026-08-19T16:50:54Z', outfitkit: '0.1.40' },
    { hub: '1.1.11', built_at: '2026-08-29T02:21:32Z', outfitkit: '0.1.56' },
  ]);
  const lines = out.split('\n');
  const at = (hub) => lines.findIndex((l) => l.includes(`hub: '${hub}'`));
  assert.ok(at('1.1.8') < at('1.1.9'), '1.1.9 after 1.1.8');
  assert.ok(at('1.1.9') < lines.indexOf('  // a comment that belongs to the row BELOW it'), 'above the comment');
  assert.ok(at('1.1.10') < at('1.1.11'), '1.1.11 at the end');
  assert.ok(at('1.1.11') < lines.indexOf('];'), 'still inside the array');
  assert.ok(out.includes("  { hub: '9.9.9' },"), 'the other array is untouched');
  // The written row is a literal the module can import and the mirror can read.
  assert.ok(out.includes("  { hub: '1.1.11', built_at: '2026-08-29T02:21:32Z', outfitkit: '0.1.56' },"));
});

test('writing a row the table already has is refused, not duplicated (#271)', () => {
  assert.throws(
    () => insertHubRows(TABLE_SRC, [{ hub: '1.1.10', built_at: 'x', outfitkit: 'y' }]),
    (err) => err.code === 'row_already_present',
  );
});

test('a source without the table is refused instead of rewritten blind (#271)', () => {
  assert.throws(
    () => insertHubRows('export const NOPE = [];\n', [{ hub: '1.1.1', built_at: 'x', outfitkit: 'y' }]),
    (err) => err.code === 'table_not_found',
  );
});

test('the REAL source file accepts a row and still imports with it (#271)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-outfitkit-rows-'));
  // The module imports `./outfitkit-stamp.mjs` and `./validate-outfitkit-api.mjs` (which imports
  // `typescript`, #346): copy its siblings and link node_modules so the rewritten file really loads.
  copyFileSync(join(REPO, 'src/outfitkit-stamp.mjs'), join(dir, 'outfitkit-stamp.mjs'));
  copyFileSync(join(REPO, 'src/validate-outfitkit-api.mjs'), join(dir, 'validate-outfitkit-api.mjs'));
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const next = { hub: '1.1.999', built_at: '2026-12-01T00:00:00Z', outfitkit: '0.1.73' };
  writeFileSync(join(dir, 'floor.mjs'), insertHubRows(readFileSync(FLOOR_SRC, 'utf8'), [next]));
  const mod = await import(join(dir, 'floor.mjs'));
  assert.deepEqual(mod.HUB_OUTFITKIT.at(-1), next);
  assert.equal(mod.HUB_OUTFITKIT.length, HUB_OUTFITKIT.length + 1);
});

// ── the script ────────────────────────────────────────────────────────────────────────────────

function scratchTable() {
  const dir = mkdtempSync(join(tmpdir(), 'hub-outfitkit-rows-run-'));
  const file = join(dir, 'floor.mjs');
  writeFileSync(file, TABLE_SRC);
  return file;
}

test('the script WRITES the missing rows and reports them (#271)', () => {
  const file = scratchTable();
  const out = [];
  const result = run({
    write: true,
    tableFile: file,
    table: [
      { hub: '1.1.8', built_at: '2026-08-19T16:52:11Z', outfitkit: '0.1.40' },
      { hub: '1.1.10', built_at: '2026-08-26T21:30:45Z', outfitkit: '0.1.56' },
    ],
    tags: [['v1.1.8', '2026-08-19T16:52:11Z'], ['v1.1.10', '2026-08-26T21:30:45Z'], ['v1.1.30', '2026-09-22T11:00:00+02:00']],
    npmTime: NPM_TIME,
    log: (l) => out.push(l),
  });
  assert.deepEqual(result.added, [{ hub: '1.1.30', built_at: '2026-09-22T09:00:00Z', outfitkit: '0.1.73' }]);
  assert.ok(readFileSync(file, 'utf8').includes("hub: '1.1.30', built_at: '2026-09-22T09:00:00Z', outfitkit: '0.1.73'"));
  assert.ok(out.some((l) => l.includes('1.1.30')));
});

test('without --write the script only REPORTS, and leaves the file alone (#271)', () => {
  const file = scratchTable();
  const result = run({
    write: false,
    tableFile: file,
    table: [],
    tags: [['v1.1.30', '2026-09-22T11:00:00Z']],
    npmTime: NPM_TIME,
    log: () => {},
  });
  assert.equal(result.added.length, 1);
  assert.equal(readFileSync(file, 'utf8'), TABLE_SRC);
});

test('nothing missing is an explicit «up to date», not silence (#271)', () => {
  const out = [];
  const result = run({
    write: true,
    tableFile: scratchTable(),
    table: [{ hub: '1.1.8', built_at: '2026-08-19T16:52:11Z', outfitkit: '0.1.40' }],
    tags: [['v1.1.8', '2026-08-19T16:52:11Z']],
    npmTime: NPM_TIME,
    log: (l) => out.push(l),
  });
  assert.deepEqual(result.added, []);
  assert.ok(out.join('\n').includes('up to date'));
});

test('the CLI refuses to run without a hub to read tags from (#271)', () => {
  const cli = spawnSync(process.execPath, [join(REPO, 'scripts/hub-outfitkit-rows.mjs'), '--hub', join(tmpdir(), 'no-such-hub-271')], {
    encoding: 'utf8',
  });
  assert.notEqual(cli.status, 0);
  assert.match(cli.stderr, /hub_not_a_repository/);
});

// ── who a missing row blocks ──────────────────────────────────────────────────────────────────

test('a missing row WARNS only when the caller says so; the default stays red (#271)', () => {
  assert.equal(rowLagIsWarning({}), false);
  assert.equal(rowLagIsWarning({ [ROW_LAG_ENV]: 'fail' }), false);
  assert.equal(rowLagIsWarning({ [ROW_LAG_ENV]: 'warn' }), true);
});

test('the mirrors action relaxes a missing row on PULL REQUESTS only, and derives it first (#271)', () => {
  const action = readFileSync(join(REPO, '.github/actions/check-canonical-mirrors/action.yml'), 'utf8');
  // The tag job of build-hub.yml runs on `push` of a tag: that is where the row is due, and it
  // must stay red. A hub PR is somebody else's work: it gets the warning.
  assert.match(action, new RegExp(`${ROW_LAG_ENV}: \\$\\{\\{ github\\.event_name == 'pull_request' && 'warn' \\|\\| 'fail' \\}\\}`));
  const derive = action.indexOf('scripts/hub-outfitkit-rows.mjs');
  const mirrors = action.indexOf('node --test test/hub-mirror.test.mjs test/canonical-mirrors.test.mjs');
  assert.ok(derive > 0 && derive < mirrors, 'the row is derived and printed before the mirrors judge it');
});
