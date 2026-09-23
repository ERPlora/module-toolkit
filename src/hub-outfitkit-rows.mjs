// The HUB_OUTFITKIT row a hub tag needs, derived instead of written by hand (module-toolkit#271).
//
// `HUB_OUTFITKIT` (./validate-outfitkit-floor.mjs) gets one row per hub release, and the rule for
// that row has always been mechanical: «the last `@erplora/outfitkit` published on npm before the
// tag was created». Until #271 a person applied it, after every release, and until they did the
// canonical mirrors went red on the hub's pull requests — five times between 1.1.15 and 1.1.29.
//
// This file is the rule, ONCE. `scripts/hub-outfitkit-rows.mjs` uses it to write the rows and
// `test/canonical-mirrors.test.mjs` uses it to re-derive the column against npm, so the script that
// writes a row and the mirror that approves it cannot disagree about what the row should say.

/** Release tags only: `v1.1.29`, never `v1.1.30-rc.1`. */
const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The oldest hub the table speaks for; `1.0.x` and older are pre-fleet on purpose. */
const TABLE_STARTS_AT = [1, 1, 0];

/**
 * Where a caller says a missing row is a WARNING rather than a failure. Set by the mirrors action
 * on the hub's pull requests (a lagging copy is not that PR's fault, hub#1296); unset everywhere
 * else, so the tag job and local runs stay red.
 */
export const ROW_LAG_ENV = 'ERPLORA_HUB_ROW_LAG';

export function rowLagIsWarning(env = process.env) {
  return env[ROW_LAG_ENV] === 'warn';
}

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

function tagParts(tag) {
  const m = RELEASE_TAG.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareParts(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const versionParts = (hub) => hub.split('.').map(Number);

/**
 * The newest version in `npmTime` (the object `npm view @erplora/outfitkit time --json` answers)
 * published at or before `whenMs`, or `null` when none was. Ordered by DATE: the registry's own
 * order of publication is the fact the rule is about.
 */
export function latestPublishedBefore(npmTime, whenMs) {
  const published = Object.entries(npmTime)
    .filter(([version]) => version !== 'created' && version !== 'modified')
    .map(([version, when]) => [version, Date.parse(when)])
    .filter(([, when]) => when <= whenMs)
    .sort((a, b) => a[1] - b[1]);
  return published.length ? published.at(-1)[0] : null;
}

/** `2026-09-16T20:56:44+02:00` → `2026-09-16T18:56:44Z`, the spelling the table uses. */
function utcSeconds(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw fail('unreadable_tag_date', `\`${iso}\` is not a date`);
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The row for `tag`, created at `createdIso`. Refuses rather than guesses. */
export function hubRowFor(tag, createdIso, npmTime) {
  if (!tagParts(tag)) throw fail('not_a_release_tag', `\`${tag}\` is not a vX.Y.Z release tag`);
  const builtAt = utcSeconds(createdIso);
  const outfitkit = latestPublishedBefore(npmTime, Date.parse(builtAt));
  if (!outfitkit) {
    throw fail(
      'no_outfitkit_before_tag',
      `no @erplora/outfitkit had been published when \`${tag}\` was created (${builtAt})`,
    );
  }
  return { hub: tag.slice(1), built_at: builtAt, outfitkit };
}

/**
 * The release tags (`[tag, createdIso]`) from the table floor up that `table` has no row for,
 * in VERSION order — `v1.1.9` was once tagged before `v1.1.8`, so creation order is not it.
 */
export function missingHubTags(tags, table) {
  const known = new Set(table.map((row) => `v${row.hub}`));
  return tags
    .filter(([tag]) => {
      const parts = tagParts(tag);
      return parts && compareParts(parts, TABLE_STARTS_AT) >= 0 && !known.has(tag);
    })
    .sort((a, b) => compareParts(tagParts(a[0]), tagParts(b[0])));
}

const ROW_LINE = /^\s*\{ hub: '(\d+\.\d+\.\d+)'/;

function rowLiteral({ hub, built_at: builtAt, outfitkit }) {
  return `  { hub: '${hub}', built_at: '${builtAt}', outfitkit: '${outfitkit}' },`;
}

/**
 * `source` (the text of validate-outfitkit-floor.mjs) with `rows` written into `HUB_OUTFITKIT`,
 * each one in version order. A row goes ABOVE the comment block of the row that follows it: in
 * that table a comment always explains the row under it.
 */
export function insertHubRows(source, rows) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^export const HUB_OUTFITKIT = \[\s*$/.test(l));
  if (start < 0) throw fail('table_not_found', 'there is no `export const HUB_OUTFITKIT = [` line');
  const end = lines.findIndex((l, i) => i > start && /^\];\s*$/.test(l));
  if (end < 0) throw fail('table_not_found', 'the `HUB_OUTFITKIT` array is never closed');

  for (const row of rows) {
    const closing = lines.findIndex((l, i) => i > start && /^\];\s*$/.test(l));
    const body = lines.slice(start + 1, closing);
    if (body.some((l) => ROW_LINE.exec(l)?.[1] === row.hub)) {
      throw fail('row_already_present', `HUB_OUTFITKIT already has a row for ${row.hub}`);
    }
    const next = body.findIndex((l) => {
      const hub = ROW_LINE.exec(l)?.[1];
      return hub && compareParts(versionParts(hub), versionParts(row.hub)) > 0;
    });
    let at = next < 0 ? closing : start + 1 + next;
    while (next >= 0 && at - 1 > start && /^\s*\/\//.test(lines[at - 1])) at -= 1;
    lines.splice(at, 0, rowLiteral(row));
  }
  return lines.join('\n');
}
