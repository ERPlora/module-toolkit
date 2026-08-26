// Tests for the domain-error catalog guard (ADR-0398, ERPlora/module-toolkit#101). `node --test`.
//
// A module DECLARES the domain error codes it provides in `module.json → errors`. Until this guard
// a code was born as a string literal in the Rust handler (or as `expect_rows.error`) and died
// where it was born: `appointments` renamed one and broke the hub's pre-push gate for the whole
// fleet within the hour, with nothing in between. The guard closes the three holes at build time:
//   1. a code the module EMITS (handler literal / `expect_rows.error`) and does not declare;
//   2. a declared code without its `en` + `es` text in `locales/` (the UI translates by code);
//   3. a code that was in the LAST PUBLISHED manifest (the `chore(release)` commit `release.yml`
//      writes) and is gone now without having been `deprecated` there — retiring is two releases.
// No `errors` block at all = the module has not migrated yet: a WARNING, never an error, until the
// 27 published modules carry the block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkErrorsCatalog, handlerErrorLiterals, previousReleaseManifest } from '../src/validate-errors-catalog.mjs';
import { validate } from '../src/validate.mjs';

const RUST = `
use erplora_guest_sdk::DomainError;
pub fn cancel() -> Output {
    // "appointments.commented_out" lives in a comment: not an emission
    if closed { return Output::error(DomainError::new("appointments.cannot_cancel", "closed")); }
    Output::new().with_operation(Operation::sql("appointments._cancel_row", p))
}
`;

/** Temporary module with an optional Rust handler and optional locale catalogs. */
function mod(manifest, { rust, en, es } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-errcat-'));
  writeFileSync(join(dir, 'module.json'), JSON.stringify(manifest, null, 2));
  if (rust !== undefined) {
    mkdirSync(join(dir, 'handler', 'src'), { recursive: true });
    writeFileSync(join(dir, 'handler', 'src', 'lib.rs'), rust);
  }
  mkdirSync(join(dir, 'locales'), { recursive: true });
  if (en) writeFileSync(join(dir, 'locales', 'en.json'), JSON.stringify(en));
  if (es) writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify(es));
  return dir;
}

const base = (extra) => ({ id: 'appointments', name: 'Appointments', version: '1.1.0', ...extra });
const catalog = (codes) => Object.fromEntries(codes.map((c) => [c, {}]));
const locales = (codes) => ({ errors: Object.fromEntries(codes.map((c) => [c, `text for ${c}`])) });

test('PASSES: every emitted code is declared and translated in en + es', () => {
  const codes = ['appointments.cannot_cancel', 'appointments.overlap'];
  const dir = mod(
    base({
      errors: catalog(codes),
      commands: { 'appointments.book': { permission: '', expect_rows: { op: 'min', n: 1, error: 'appointments.overlap' } } },
    }),
    { rust: RUST, en: locales(codes), es: locales(codes) },
  );
  try {
    assert.deepEqual(checkErrorsCatalog(dir, JSON.parse(readManifest(dir))), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WARNS (never errors): a module that emits codes and has no `errors` block yet', () => {
  const dir = mod(base({}), { rust: RUST });
  try {
    const out = checkErrorsCatalog(dir, JSON.parse(readManifest(dir)));
    assert.deepEqual(out.errors, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /appointments\.cannot_cancel/);
    assert.match(out.warnings[0], /errors/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SILENT: a module with no block that emits nothing (the declarative-only shape)', () => {
  const dir = mod(base({}));
  try {
    assert.deepEqual(checkErrorsCatalog(dir, JSON.parse(readManifest(dir))), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: a handler literal the catalog does not declare, naming the file and the code', () => {
  const dir = mod(base({ errors: catalog(['appointments.other']) }), {
    rust: RUST,
    en: locales(['appointments.other']),
    es: locales(['appointments.other']),
  });
  try {
    const out = checkErrorsCatalog(dir, JSON.parse(readManifest(dir)));
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /appointments\.cannot_cancel/);
    assert.match(out.errors[0], /handler\/src\/lib\.rs/);
    assert.doesNotMatch(out.errors.join('\n'), /commented_out/, 'a code inside a comment is not an emission');
    assert.doesNotMatch(out.errors.join('\n'), /_cancel_row/, 'a sub-command name is not an error code');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: an `expect_rows.error` outside the catalog, naming the command', () => {
  const dir = mod(
    base({
      errors: catalog(['appointments.other']),
      commands: { 'appointments.book': { permission: '', expect_rows: { op: 'min', n: 1, error: 'appointments.overlap' } } },
    }),
    { en: locales(['appointments.other']), es: locales(['appointments.other']) },
  );
  try {
    const out = checkErrorsCatalog(dir, JSON.parse(readManifest(dir)));
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /appointments\.book/);
    assert.match(out.errors[0], /appointments\.overlap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: a declared code with no `en` or no `es` text (the UI translates by code, ADR-0055)', () => {
  const dir = mod(base({ errors: catalog(['appointments.overlap']) }), {
    en: locales(['appointments.overlap']),
    es: { errors: {} },
  });
  try {
    const out = checkErrorsCatalog(dir, JSON.parse(readManifest(dir)));
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /appointments\.overlap/);
    assert.match(out.errors[0], /locales\/es\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('FAILS: a catalog entry outside the module namespace (the ADR-0205 ABI)', () => {
  const dir = mod(base({ errors: catalog(['sales.oops']) }), { en: locales(['sales.oops']), es: locales(['sales.oops']) });
  try {
    const out = checkErrorsCatalog(dir, JSON.parse(readManifest(dir)));
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /sales\.oops/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the previous published self: the last `chore(release)` commit ────────────────────────────

function git(dir, ...args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** A git repo whose history is: work → `chore(release): v1.0.0` (manifest A) → work (manifest B). */
function repoWithRelease(released, current) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-errcat-git-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@erplora.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'module.json'), JSON.stringify(released, null, 2));
  git(dir, 'add', 'module.json');
  git(dir, 'commit', '-q', '-m', 'feat: first');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'chore(release): v1.0.0');
  writeFileSync(join(dir, 'module.json'), JSON.stringify(current, null, 2));
  git(dir, 'add', 'module.json');
  git(dir, 'commit', '-q', '-m', 'feat: retire a code');
  return dir;
}

test('previousReleaseManifest: reads module.json at the last chore(release) commit; null without one', () => {
  const released = base({ version: '1.0.0', errors: catalog(['appointments.overlap']) });
  const dir = repoWithRelease(released, base({}));
  try {
    assert.deepEqual(previousReleaseManifest(dir), released);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const fresh = mkdtempSync(join(tmpdir(), 'erplora-errcat-nogit-'));
  try {
    assert.equal(previousReleaseManifest(fresh), null, 'no repo / no release = no previous self');
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('FAILS: a code published in the previous release is gone without having been deprecated there', () => {
  const released = base({ version: '1.0.0', errors: catalog(['appointments.overlap', 'appointments.keep']) });
  const current = base({ errors: catalog(['appointments.keep']) });
  const dir = repoWithRelease(released, current);
  mkdirSync(join(dir, 'locales'));
  writeFileSync(join(dir, 'locales', 'en.json'), JSON.stringify(locales(['appointments.keep'])));
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify(locales(['appointments.keep'])));
  try {
    const out = checkErrorsCatalog(dir, current);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /appointments\.overlap/);
    assert.match(out.errors[0], /deprecated/);
    assert.match(out.errors[0], /v1\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES: a code deprecated in the previous release may be deleted now (second of the two releases)', () => {
  const released = base({
    version: '1.0.0',
    errors: { 'appointments.overlap': { deprecated: '1.0.0' }, 'appointments.keep': {} },
  });
  const current = base({ errors: catalog(['appointments.keep']) });
  const dir = repoWithRelease(released, current);
  mkdirSync(join(dir, 'locales'));
  writeFileSync(join(dir, 'locales', 'en.json'), JSON.stringify(locales(['appointments.keep'])));
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify(locales(['appointments.keep'])));
  try {
    assert.deepEqual(checkErrorsCatalog(dir, current), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES: the previous release had no catalog at all — nothing to compare, adding is free', () => {
  const dir = repoWithRelease(base({ version: '1.0.0' }), base({ errors: catalog(['appointments.new']) }));
  mkdirSync(join(dir, 'locales'));
  writeFileSync(join(dir, 'locales', 'en.json'), JSON.stringify(locales(['appointments.new'])));
  writeFileSync(join(dir, 'locales', 'es.json'), JSON.stringify(locales(['appointments.new'])));
  try {
    assert.deepEqual(checkErrorsCatalog(dir, base({ errors: catalog(['appointments.new']) })), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The guard is worth nothing unless `erplora validate` runs it (pack → publish call validate first).
test('WIRED: `erplora validate` rejects a module whose expect_rows raises an undeclared code', async () => {
  const dir = mod(
    base({
      errors: catalog(['appointments.other']),
      commands: { 'appointments.book': { permission: '', expect_rows: { op: 'min', n: 1, error: 'appointments.overlap' } } },
    }),
    { en: locales(['appointments.other']), es: locales(['appointments.other']) },
  );
  try {
    await assert.rejects(() => validate(dir), /appointments\.overlap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readManifest(dir) {
  return readFileSync(join(dir, 'module.json'), 'utf8');
}

// ── a name the manifest declares is not an error code (module-toolkit#107) ────────────────────
//
// `<module>.<snake_case>` is at once the shape of a domain code (ADR-0205) and the shape of a
// query/command name, so a handler that reads its own data from the context by name
// (`read_rows(&context, "sales.get")`) looked, to a lexical scan, exactly like an emission. The
// `_` filter (ADR-0166) never covered it: a public query carries no underscore. Declaring the
// catalog would have forced `sales.get` INTO the error ABI, and the hub validates `Output.error`
// against that catalog — so `code: "sales.get"` would have become a legitimate domain rejection.

const READS_ITS_OWN_QUERY = `
pub fn checkout() -> Output {
    let rows = tax::read_rows(&context, "appointments.get").unwrap_or_default();
    let cat = tax::read_rows(&context, "appointments.slot_catalog");
    Output::new().with_operation(Operation::sql("appointments.book", p));
    if closed { return Output::error(DomainError::new("appointments.cannot_cancel", "closed")); }
}
`;

const withNames = (extra) =>
  base({
    queries: { 'appointments.get': { sql: 'get.sql' }, 'appointments.slot_catalog': { sql: 'slots.sql' } },
    commands: { 'appointments.book': { permission: '', sql: 'book.sql' } },
    ...extra,
  });

test('handlerErrorLiterals: a literal listed in `notCodes` is not an emitted code (#107)', () => {
  const dir = mod(withNames({}), { rust: READS_ITS_OWN_QUERY });
  try {
    const all = [...handlerErrorLiterals(dir, 'appointments').keys()].sort();
    assert.deepEqual(all, ['appointments.book', 'appointments.cannot_cancel', 'appointments.get', 'appointments.slot_catalog']);
    const codes = [
      ...handlerErrorLiterals(dir, 'appointments', {
        notCodes: ['appointments.get', 'appointments.slot_catalog', 'appointments.book'],
      }).keys(),
    ];
    assert.deepEqual(codes, ['appointments.cannot_cancel']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('WARNS only about the real codes: query and command names are not counted (#107)', () => {
  const manifest = withNames({});
  const dir = mod(manifest, { rust: READS_ITS_OWN_QUERY });
  try {
    const out = checkErrorsCatalog(dir, manifest);
    assert.deepEqual(out.errors, []);
    assert.equal(out.warnings.length, 1);
    assert.match(out.warnings[0], /emits 1 domain error code/);
    assert.match(out.warnings[0], /appointments\.cannot_cancel/);
    for (const name of ['appointments.get', 'appointments.slot_catalog', 'appointments.book']) {
      assert.doesNotMatch(out.warnings[0], new RegExp(name.replace('.', '\\.') + '(,|$)'), `${name} is a declared name, not a code`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PASSES in strict mode: the catalog declares the codes only, never the query names (#107)', () => {
  const manifest = withNames({ errors: catalog(['appointments.cannot_cancel']) });
  const dir = mod(manifest, {
    rust: READS_ITS_OWN_QUERY,
    en: locales(['appointments.cannot_cancel']),
    es: locales(['appointments.cannot_cancel']),
  });
  try {
    assert.deepEqual(checkErrorsCatalog(dir, manifest), { errors: [], warnings: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('STILL FAILS: a literal the manifest declares nowhere is an emitted code (#107 does not open a hole)', () => {
  const manifest = withNames({ errors: catalog(['appointments.cannot_cancel']) });
  const dir = mod(manifest, {
    rust: READS_ITS_OWN_QUERY + '\nlet _ = "appointments.undeclared_thing";\n',
    en: locales(['appointments.cannot_cancel']),
    es: locales(['appointments.cannot_cancel']),
  });
  try {
    const out = checkErrorsCatalog(dir, manifest);
    assert.equal(out.errors.length, 1);
    assert.match(out.errors[0], /appointments\.undeclared_thing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
