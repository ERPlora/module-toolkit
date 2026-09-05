// The domain-error catalog guard (ADR-0398, ERPlora/module-toolkit#101).
//
// A module DECLARES the domain error codes it provides in `module.json → errors` (the ADR-0205
// ABI: `<module>.<snake_case>`, raised through `Output.error` in a handler or `expect_rows.error`
// in a declarative command). Before the catalog a code was born as a string literal and retired
// in silence: `appointments` renamed one (appointments#70/#71, gate green) and the hub's pre-push
// gate went red for the whole fleet within the hour. This guard makes the surface visible at
// build time, in the three places it can go wrong:
//
//   1. EMITTED AND NOT DECLARED — a literal `"<module>.<snake_case>"` in `handler/src/**/*.rs` or an
//      `expect_rows.error` outside the catalog. The scan of the Rust source is LEXICAL on purpose
//      (the toolkit is Node; loading a Rust parser for this is the wrong trade): comments are
//      stripped the same way the permission-ceiling guard does it, and a code built at runtime is
//      invisible here — the hub's runtime is strict when the block is present and catches it.
//   2. DECLARED AND NOT TRANSLATED — the UI translates by code (ADR-0055), so every declared code
//      needs its `en` (source) and `es` text in `locales/<lang>.json → errors`.
//   3. RETIRED IN ONE STEP — a code present in the LAST PUBLISHED manifest that is gone now without
//      having been `deprecated` there. The previous self is the last `chore(release)` commit that
//      `release.yml` writes and the SaaS republishes on — no tag, no network, no credential (the
//      org is on the Free plan, where organization secrets do not reach private repos). Needs the
//      full history on disk: the gate checks out with `fetch-depth: 0`.
//
//   4. MALFORMED — the block is there and its SHAPE is wrong, on either side (module-toolkit#197,
//      #196). This used to be «the JSON Schema's job», except no door reads the schema's VALUES:
//      `validate-manifest-keys.mjs` takes the admitted KEYS from it and stops there. So a catalog
//      carrying the message TEXT where the hub expects the code's STATE passed green and then
//      failed to INSTALL (`BTreeMap<String, ErrorDecl>`, `crates/runtime/src/manifest.rs`), and a
//      locale catalog could hold a leftover nested cube nobody reads, a key of ANOTHER module's
//      namespace (or the core's) — a module putting words in another's mouth — or a value that is
//      not a text at all. The hub's SDK defends itself from the core names by shape, but it cannot
//      know WHO owns the catalog it is handed; the validator knows `manifest.id`.
//
// No `errors` block at all is the shape of the modules that have not migrated yet: emitting codes
// without a catalog is a WARNING until the 27 published modules carry the block (ADR-0398 §5). The
// old NESTED locale shape under the module's own id is the same story and stays a WARNING with a
// message that says what the contract is — it is where the last five live (customers,
// online_booking, tasks, tickets, whatsapp_inbox), each with its migration issue open.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

/** ADR-0205 shape, mirrored from `crates/runtime/src/errors.rs::valid_domain_code`. */
const SEGMENT = '[a-z][a-z0-9_]*';
const CODE_RE = new RegExp(`^${SEGMENT}\\.${SEGMENT}$`);
const MAX_CODE_LEN = 128;

/** The languages a declared code must be translated into (ADR-0055: `en` source + `es`). */
export const REQUIRED_LOCALES = ['en', 'es'];

function validDomainCode(moduleId, code) {
  return (
    typeof code === 'string' &&
    code.length <= MAX_CODE_LEN &&
    CODE_RE.test(code) &&
    code.startsWith(`${moduleId}.`)
  );
}

/**
 * The only field an entry of the catalog carries — mirror of `ERROR_FIELDS`
 * (`hub/crates/runtime/src/manifest.rs`), where the value deserializes into
 * `ErrorDecl { deprecated: Option<String> }`. Anything else there is an install the hub refuses.
 */
const ERROR_DECL_FIELDS = ['deprecated'];

/** What is wrong with one `errors.<code>` value, or `null` when it carries the contract's shape. */
function errorDeclProblem(code, decl) {
  if (decl === null || typeof decl !== 'object' || Array.isArray(decl)) {
    return (
      `errors: \`${code}\` carries ${typeof decl === 'string' ? 'the message text' : `a ${Array.isArray(decl) ? 'list' : typeof decl}`} ` +
      'as its value — the value is the code\'s STATE (an object with at most `deprecated`), never its text, which lives in ' +
      '`locales/<lang>.json → errors.<code>` (ADR-0055). The hub reads the block as a map of objects and REFUSES the install (ADR-0398)'
    );
  }
  const unknown = Object.keys(decl).filter((key) => !ERROR_DECL_FIELDS.includes(key));
  if (unknown.length) {
    return `errors: \`${code}\` declares \`${unknown.join('`, `')}\` — an entry carries only \`deprecated\` (ADR-0398)`;
  }
  if ('deprecated' in decl && typeof decl.deprecated !== 'string') {
    return `errors: \`${code}\` has a non-string \`deprecated\` — it is the module VERSION that announced the retirement, e.g. "1.2.0" (ADR-0398)`;
  }
  return null;
}

/**
 * The shape of one `locales/<lang>.json → errors` block: FLAT keys `<module>.<snake_case>` (the
 * module's own namespace) with a text as value, which is all the hub's SDK indexes.
 *
 * `migrated` (the manifest carries an `errors` catalog) only decides the severity of the OLD nested
 * shape under the module's own id: a warning while the last five modules migrate, an error once the
 * module has declared its catalog — there the cube is a leftover that reads like a translation and
 * changes nothing anyone sees. A nested cube under someone ELSE's namespace is an error either way.
 *
 * A key the manifest DECLARES is judged there and skipped here: the manifest is the authority on
 * the catalog's own codes, and a module that declares `sales.oops` should read one message about
 * it, not the same mistake again once per language.
 */
function localeCatalogProblems({ file, texts }, moduleId, { migrated, declared }) {
  const errors = [];
  const warnings = [];
  for (const [key, value] of Object.entries(texts)) {
    if (declared && Object.hasOwn(declared, key)) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if (!migrated && key === moduleId) {
        warnings.push(
          `${file}: \`errors.${key}\` is the old NESTED shape — the contract is FLAT (\`errors."${moduleId}.<snake_case>"\`), ` +
            'which is the only form the hub indexes: translating the nested one changes nothing anyone sees (ADR-0398)',
        );
        continue;
      }
      errors.push(
        `${file}: \`errors.${key}\` is a nested block — the contract is FLAT (\`errors."${moduleId}.<snake_case>"\`) and the hub ` +
          `indexes nothing else, so this ${key === moduleId ? 'leftover' : 'foreign'} cube is dead weight that reads like a translation (ADR-0398)`,
      );
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${file}: \`errors.${key}\` is not a text (${value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value}) — the UI shows this string to the person (ADR-0055)`);
      continue;
    }
    if (!CODE_RE.test(key) || key.length > MAX_CODE_LEN) {
      errors.push(`${file}: \`${key}\` is not a domain code — the hub indexes \`<module>.<snake_case>\` keys and ignores the rest (ADR-0205)`);
      continue;
    }
    if (!key.startsWith(`${moduleId}.`)) {
      errors.push(
        `${file}: \`${key}\` belongs to \`${key.slice(0, key.indexOf('.'))}\`, not to this module — a module translates its OWN codes; ` +
          'texting someone else\'s puts words in their mouth, and the SDK cannot tell whose catalog it was handed (ADR-0398)',
      );
    }
  }
  return { errors, warnings };
}

/** Every `.rs` under `handler/src`, recursively, with its path relative to the module. */
function handlerSources(dir) {
  const root = join(dir, 'handler', 'src');
  if (!existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith('.rs')) out.push({ file: relative(dir, abs), text: readFileSync(abs, 'utf8') });
    }
  };
  walk(root);
  return out;
}

/**
 * Strips Rust comments while keeping string literals intact (a `//` inside a string is not a
 * comment; a code quoted inside a comment is not an emission). Removed text becomes spaces.
 */
function stripRustComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
    } else if (c === '/' && next === '*') {
      let depth = 1;
      out += '  ';
      i += 2;
      while (i < src.length && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth += 1; out += '  '; i += 2; }
        else if (src[i] === '*' && src[i + 1] === '/') { depth -= 1; out += '  '; i += 2; }
        else { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * Domain codes the handler source names literally, per file.
 *
 * `<module>.<snake_case>` is at once the shape of a domain code (ADR-0205) and the shape of a
 * QUERY or COMMAND name, so a handler naming its own manifest entries —
 * `read_rows(&context, "sales.get")`, `Operation::sql("sales.checkout", ...)` — is not emitting
 * anything. `notCodes` carries those declared names (module-toolkit#107): counting them would have
 * pushed `sales.get` into the error ABI, and the hub validates `Output.error` against the catalog,
 * so from there `code: "sales.get"` would be a legitimate domain rejection.
 *
 * A sub-command name (`appointments._cancel_row`) is excluded by its `_` prefix, the
 * internal-command marker (ADR-0166) — it is not always listed in `commands`.
 *
 * A code that deliberately shares its name with a query is unreachable here, by design: the
 * exclusion wins (a silent false negative, which the hub runtime still catches, beats a false
 * positive that blocks the catalog of every module that reads its own data by name).
 */
export function handlerErrorLiterals(dir, moduleId, { notCodes = [] } = {}) {
  const re = new RegExp(`"(${moduleId}\\.${SEGMENT})"`, 'g');
  const notACode = new Set(notCodes);
  const found = new Map();
  for (const { file, text } of handlerSources(dir)) {
    for (const m of stripRustComments(text).matchAll(re)) {
      const code = m[1];
      if (code.slice(moduleId.length + 1).startsWith('_')) continue;
      if (notACode.has(code)) continue;
      if (!found.has(code)) found.set(code, file);
    }
  }
  return found;
}

/** The query and command names the manifest declares - same shape as a code, never a code. */
function manifestNames(manifest) {
  return [...Object.keys(manifest.queries ?? {}), ...Object.keys(manifest.commands ?? {})];
}

/** `locales/<lang>.json → errors` as a map, or `null` when the file is absent/unreadable. */
function localeErrors(dir, lang) {
  const path = join(dir, 'locales', `${lang}.json`);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed?.errors && typeof parsed.errors === 'object' ? parsed.errors : {};
  } catch {
    return null;
  }
}

/**
 * Every `locales/<lang>.json` on disk with its `errors` block, sorted by language. The shape is
 * checked wherever it is written, not only in the two languages a declared code MUST carry
 * (`REQUIRED_LOCALES`): a key of someone else's namespace is theirs in `fr.json` too.
 */
function localeCatalogs(dir) {
  const root = join(dir, 'locales');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith('.json')) continue;
    const texts = localeErrors(dir, name.slice(0, -'.json'.length));
    if (texts) out.push({ file: `locales/${name}`, texts });
  }
  return out;
}

function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? (res.stdout ?? '') : null;
}

/**
 * The manifest of the previous PUBLISHED version: `module.json` at the last `chore(release)` commit
 * (`release.yml` bumps with that exact subject and the SaaS republishes on it, so that commit IS
 * what the marketplace serves). `null` when there is no repo, no git, or no release yet — a new
 * module has no previous self and nothing to compare.
 */
export function previousReleaseManifest(dir) {
  if (git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return null;
  const sha = git(dir, ['log', '--grep=^chore(release)', '-1', '--format=%H'])?.trim();
  if (!sha) return null;
  const raw = git(dir, ['show', `${sha}:module.json`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function releaseLabel(previous) {
  return previous?.version ? `v${previous.version}` : 'the previous release';
}

/**
 * Validates the module's domain-error catalog. Returns `{ errors, warnings }`.
 *
 * The SHAPE of both sides is checked here (module-toolkit#197/#196), not left to the JSON Schema:
 * no door of the toolkit reads the schema's values, so a catalog holding the message text where
 * the hub expects `{deprecated?}` used to pass green and fail at install. A whole `errors` block
 * that is not an object is still treated as absent rather than reported twice in two vocabularies.
 */
export function checkErrorsCatalog(dir, manifest, { previous = previousReleaseManifest(dir) } = {}) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest.id;
  const declared = manifest.errors && typeof manifest.errors === 'object' ? manifest.errors : null;

  for (const catalog of localeCatalogs(dir)) {
    const found = localeCatalogProblems(catalog, moduleId, { migrated: Boolean(declared), declared });
    errors.push(...found.errors);
    warnings.push(...found.warnings);
  }

  const emitted = handlerErrorLiterals(dir, moduleId, { notCodes: manifestNames(manifest) });
  const expectRows = [];
  for (const [name, command] of Object.entries(manifest.commands ?? {})) {
    const code = command?.expect_rows?.error;
    if (typeof code === 'string') expectRows.push({ name, code });
  }

  if (!declared) {
    const codes = [...new Set([...emitted.keys(), ...expectRows.map((e) => e.code)])].sort();
    if (codes.length) {
      warnings.push(
        `emits ${codes.length} domain error code(s) without an \`errors\` catalog in module.json (ADR-0398) — ` +
          `declare them so retiring one is a visible change: ${codes.join(', ')}`,
      );
    }
    return { errors, warnings };
  }

  for (const [code, decl] of Object.entries(declared)) {
    if (!validDomainCode(moduleId, code)) {
      errors.push(`errors: \`${code}\` is not a domain code of this module (expected \`${moduleId}.<snake_case>\`, ADR-0205)`);
    }
    const problem = errorDeclProblem(code, decl);
    if (problem) errors.push(problem);
  }

  for (const [code, file] of emitted) {
    if (!(code in declared)) {
      errors.push(`${file}: raises \`${code}\`, which the \`errors\` catalog does not declare (ADR-0398)`);
    }
  }
  for (const { name, code } of expectRows) {
    if (!(code in declared)) {
      errors.push(`commands.${name}: \`expect_rows.error\` raises \`${code}\`, which the \`errors\` catalog does not declare (ADR-0398)`);
    }
  }

  for (const lang of REQUIRED_LOCALES) {
    const texts = localeErrors(dir, lang);
    for (const code of Object.keys(declared)) {
      if (!texts || typeof texts[code] !== 'string' || !texts[code].trim()) {
        errors.push(`locales/${lang}.json: no \`errors.${code}\` text — the UI translates domain errors by code (ADR-0055)`);
      }
    }
  }

  const previousCatalog = previous?.errors && typeof previous.errors === 'object' ? previous.errors : null;
  if (previousCatalog) {
    for (const [code, decl] of Object.entries(previousCatalog)) {
      if (code in declared) continue;
      if (decl && typeof decl === 'object' && decl.deprecated) continue;
      errors.push(
        `errors: \`${code}\` was published in ${releaseLabel(previous)} and is gone without having been marked ` +
          `\`deprecated\` there — retiring a code is two releases: mark it, then delete it (ADR-0398)`,
      );
    }
  }

  return { errors, warnings };
}
