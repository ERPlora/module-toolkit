#!/usr/bin/env node
// Writes the HUB_OUTFITKIT rows the hub published and the table lacks (module-toolkit#271).
//
//   node scripts/hub-outfitkit-rows.mjs [--hub <checkout>] [--write]
//   npm run hub-outfitkit-rows -- --write
//
// Reads the release tags of a hub checkout — only the ones `origin` recognises, because a shared
// checkout carries refs nobody pushed (#258) — and the publication dates of `@erplora/outfitkit`
// on npm, derives each missing row with `src/hub-outfitkit-rows.mjs` (the same function the mirror
// re-runs) and, with `--write`, writes them into `src/validate-outfitkit-floor.mjs`. Without
// `--write` it only reports. `--hub` defaults to the sibling `../hub` checkout.
//
// 🔴 Run it on a checkout whose tags are the real OBJECTS (`git fetch --tags` does that;
// `actions/checkout` does not — see `scripts/restore-hub-tags.sh`): an annotated tag flattened to
// its commit reads the commit's date, which is a different OutfitKit.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubRowFor, insertHubRows, missingHubTags } from '../src/hub-outfitkit-rows.mjs';

const TOOLKIT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_FILE = join(TOOLKIT, 'src/validate-outfitkit-floor.mjs');

/**
 * Derive (and with `write`, write) the missing rows. Everything it reads is injected, so the
 * decision can be tested without a hub or a network.
 *
 * @returns {{ added: Array<{hub: string, built_at: string, outfitkit: string}> }}
 */
export function run({ write, tableFile, table, tags, npmTime, log }) {
  const missing = missingHubTags(tags, table);
  if (!missing.length) {
    log('→ HUB_OUTFITKIT is up to date with the hub release tags');
    return { added: [] };
  }
  const added = missing.map(([tag, created]) => hubRowFor(tag, created, npmTime));
  for (const row of added) {
    log(`→ v${row.hub} (created ${row.built_at}) → @erplora/outfitkit ${row.outfitkit}`);
  }
  if (write) {
    writeFileSync(tableFile, insertHubRows(readFileSync(tableFile, 'utf8'), added));
    log(`→ wrote ${added.length} row(s) into ${tableFile}`);
  } else {
    log('→ not written: pass --write to add them');
  }
  return { added };
}

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** `[tag, createdIso]` for every `v*` tag of `dir` that `origin` also has. */
function publishedTags(dir) {
  const listed = spawnSync(
    'git',
    ['-C', dir, 'for-each-ref', '--format=%(refname:short)\t%(creatordate:iso-strict)', 'refs/tags/v*'],
    { encoding: 'utf8' },
  );
  if (listed.status !== 0) {
    throw fail('hub_not_a_repository', `\`${dir}\` is not a git checkout of the hub (${(listed.stderr || '').trim()})`);
  }
  const remote = spawnSync('git', ['-C', dir, 'ls-remote', '--tags', 'origin'], { encoding: 'utf8' });
  if (remote.status !== 0) {
    throw fail('origin_unreachable', `could not ask origin of \`${dir}\` which tags it has (${(remote.stderr || '').trim()})`);
  }
  const known = new Set(
    remote.stdout
      .split('\n')
      .map((line) => line.split('\t')[1])
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '')),
  );
  return listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'))
    .filter(([tag, created]) => created && known.has(tag));
}

function outfitkitPublicationTimes() {
  const npm = spawnSync('npm', ['view', '@erplora/outfitkit', 'time', '--json'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (npm.status !== 0 || !npm.stdout) {
    throw fail('npm_unreachable', `\`npm view @erplora/outfitkit time\` failed (${(npm.stderr || '').trim().split('\n')[0]})`);
  }
  return JSON.parse(npm.stdout);
}

async function main(argv) {
  const hubAt = argv.indexOf('--hub');
  const hub = resolve(hubAt >= 0 ? argv[hubAt + 1] ?? '' : join(TOOLKIT, '..', 'hub'));
  if (!existsSync(hub)) throw fail('hub_not_a_repository', `\`${hub}\` does not exist`);
  const { HUB_OUTFITKIT } = await import('../src/validate-outfitkit-floor.mjs');
  const { added } = run({
    write: argv.includes('--write'),
    tableFile: TABLE_FILE,
    table: HUB_OUTFITKIT,
    tags: publishedTags(hub),
    npmTime: outfitkitPublicationTimes(),
    log: (line) => console.log(line),
  });
  if (added.length && process.env.GITHUB_ACTIONS) {
    const literal = added
      .map((r) => `{ hub: '${r.hub}', built_at: '${r.built_at}', outfitkit: '${r.outfitkit}' }`)
      .join(' · ');
    console.log(
      `::warning title=HUB_OUTFITKIT lags behind the hub::${added.length} hub release(s) have no row in ` +
        `module-toolkit's HUB_OUTFITKIT: ${literal}. Write them with \`npm run hub-outfitkit-rows -- --write\` ` +
        'in module-toolkit (module-toolkit#271).',
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.code ? err.message : err);
    process.exit(1);
  });
}
