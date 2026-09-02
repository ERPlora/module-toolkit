// The published Web Component bundle (`dist/<id>.esm.js`): does it come from THIS source, and was it
// baked on a machine whose paths it should not be carrying? (module-toolkit#93.)
//
// Why it exists. A module is published AS IS: the zip ships `dist/` verbatim, nobody rebuilds it
// downstream. So the bundle is the artifact, and until today `erplora validate` read exactly one
// thing out of it — `assertCspSafe` — which says nothing about whether it matches `ui/`.
//
// Two failures, both seen for real:
//   • PROVENANCE — `ERPlora/verifactu@63039d3^:dist/verifactu.esm.js` carried 8 esbuild comments
//     with an absolute path into another agent's scratchpad (`/private/tmp/…/scratchpad/vf40/…`).
//     Somebody built from a throwaway clone and committed the result. Harmless in itself, but it is
//     the visible fingerprint of a bundle produced somewhere nobody can reproduce.
//   • FRESHNESS — a PR that edits `ui/**` without running `erplora build` publishes the OLD screen
//     under the new manifest. Surveyed against `origin/main` of the 27 published modules on
//     2026-08-28, `flows` (3 days) and `sales` (minutes) were already in that state.
//
// It is the same silent-mismatch shape `wasm.mjs` closes for the Tier-2 binary, so the evidence is
// layered the same way — a publish gate that cries wolf gets ignored:
//   1. STAMP (`dist/<id>.build.json`, written by `erplora build`): sha256 of the `ui/` tree and of
//      the bundle. Direct, and the only layer a rebuild can always clear.
//   2. GIT: uncommitted `ui/` changes with an untouched bundle, or `ui/` committed after it. This
//      layer MUST outrank mtimes — on a fresh clone every mtime is checkout time, so mtimes alone
//      would be blind exactly where CI looks.
//   3. MTIME: last resort for a module with no history (a scaffold, an unpacked zip).
//
// SEVERITY — the ratchet, same shape as the `fill` guard (module-toolkit#63). No published module
// carries a stamp yet, and turning 27 repos red for a change of ours is how a gate gets disabled:
//   • stale according to the STAMP → ERROR. The module already built with a stamping toolkit, so
//     the author has a rebuild that clears it.
//   • stale according to GIT or MTIME with NO stamp → WARNING. Grandfathered until the module
//     rebuilds once and gains the stamp; from that build on it is an error.
//   • an absolute path in the bundle → ERROR always. Verified on 2026-08-28: zero of the 27
//     published bundles carry one, so nothing is grandfathered here.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** A fresh `git clone` writes every file at checkout time; only a wider spread counts as stale. */
export const BUNDLE_MTIME_TOLERANCE_MS = 2000;

/** Directories that are build output or VCS noise, never Web Component source. */
const IGNORED_DIRS = new Set(['dist', 'node_modules', 'target']);

/**
 * Test-support directories. `collectTs` (build.mjs) walks `ui/components/` only, and what lives in
 * `ui/test/` (shared doubles) is imported by tests alone — so, like `*.test.ts`, it cannot change a
 * byte of the artifact. Swept from a fresh clone on 2026-08-28, `sales` was flagged for exactly
 * this: `ui/test/erplora-double.ts` committed 45 min after the bundle. `ui/lib/` and `ui/guards/`
 * are real, component-imported source and stay IN.
 */
const TEST_SUPPORT_DIRS = new Set(['test', 'tests', '__tests__', '__mocks__']);

/** Where the Web Component source lives: `ui/` (Lit) and the legacy `src/` of the first modules. */
const SOURCE_ROOTS = ['ui', 'src'];

/**
 * The translation catalogue (module-toolkit#158). It is NOT a second source root: every published
 * module writes `import esLocale from '../../../locales/es.json'` in its component, so esbuild
 * INLINES the catalogue into the bundle — a merge that only touches `locales/**` changes what the
 * screen says and leaves `dist/` behind. `locales/**` is a trigger path of `release.yml`, so that
 * merge bumps the version and republishes the OLD strings.
 *
 * It is hashed SEPARATELY, into `locales_sha256`, and never folded into `sources_sha256`: the eight
 * modules that already carry a #93 stamp would all go red for a change of ours the moment the
 * meaning of that field moved. Same ratchet as #93 — a stamp with no `locales_sha256` is not held
 * to the catalogue until the module builds once more.
 */
const LOCALE_ROOTS = ['locales'];

/**
 * Files that `resolveEntry`/`collectTs` (build.mjs) deliberately keep OUT of the artifact: the
 * co-located tests, and the ambient declarations. Hashing them would flag a bundle as stale for a
 * commit that provably cannot change a single byte of it — the cry-wolf that gets a gate ignored.
 */
const NOT_IN_BUNDLE = /(\.test\.[cm]?[jt]s|\.spec\.[cm]?[jt]s|\.d\.ts)$/;

/**
 * The same exclusion expressed for git. Without it the history layer reads a commit that only
 * touched a co-located test as "the UI changed", which is how a gate earns its reputation for
 * crying wolf: swept over the 27 published modules on 2026-08-28, BOTH warnings it produced
 * (`flows`, `online_booking`) named a `.test.ts`, and both bundles were in fact current.
 */
const GIT_EXCLUDE_NOT_IN_BUNDLE = [
  ':(exclude,glob)**/*.test.*',
  ':(exclude,glob)**/*.spec.*',
  ':(exclude,glob)**/*.d.ts',
  ...[...TEST_SUPPORT_DIRS].map((d) => `:(exclude,glob)**/${d}/**`),
];

/** The published bundle of a module, relative to its directory. */
export const bundleFile = (id) => `dist/${id}.esm.js`;

/** Provenance sidecar `erplora build` writes next to the bundle. Travels inside the module zip. */
export const bundleStampFile = (id) => `dist/${id}.build.json`;

/** Every Web Component source file of the module (absolute paths), ignoring build output. */
export function collectUiSources(dir, out = []) {
  for (const root of SOURCE_ROOTS) walk(join(dir, root), out);
  return out;
}

function walk(from, out) {
  let entries;
  try {
    entries = readdirSync(from, { withFileTypes: true });
  } catch {
    return out; // that root does not exist in this module
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory() && TEST_SUPPORT_DIRS.has(entry.name)) continue;
    const path = join(from, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (!NOT_IN_BUNDLE.test(entry.name)) out.push(path);
  }
  return out;
}

/** Every translation catalogue of the module (absolute paths). Empty when it ships none. */
export function collectLocaleSources(dir, out = []) {
  for (const root of LOCALE_ROOTS) walk(join(dir, root), out);
  return out;
}

/** sha256 of a set of files: relative paths + contents, order-independent. */
function hashFiles(dir, paths) {
  const hash = createHash('sha256');
  for (const path of paths.sort()) {
    hash.update(relative(dir, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

/** sha256 of the Web Component sources: relative paths + contents, order-independent. */
export function hashUiSources(dir) {
  return hashFiles(dir, collectUiSources(dir));
}

/** sha256 of the translation catalogues esbuild inlines into the bundle (module-toolkit#158). */
export function hashLocaleSources(dir) {
  return hashFiles(dir, collectLocaleSources(dir));
}

/** Newest file that goes INTO the bundle: `{ path, mtimeMs }` (`path: null` when there is none). */
function newestUiSource(dir) {
  let newest = { path: null, mtimeMs: 0 };
  for (const path of [...collectUiSources(dir), ...collectLocaleSources(dir)]) {
    const { mtimeMs } = statSync(path);
    if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest;
}

/** Provenance of the bundle currently on disk: which sources produced it, and which bytes came out. */
export function bundleBuildStamp(dir, manifest, extra = {}) {
  const file = bundleFile(manifest.id);
  return {
    file,
    sources_sha256: hashUiSources(dir),
    // module-toolkit#158. Its own field, never folded into `sources_sha256`: moving the meaning of
    // that one would turn the eight already-stamped modules red for a change of ours.
    locales_sha256: hashLocaleSources(dir),
    bundle_sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'),
    built_at: new Date().toISOString(),
    ...extra,
  };
}

/**
 * Writes `dist/<id>.build.json` for the bundle on disk and returns its path, or `null` when there is
 * no bundle to stamp. Called by `erplora build` right after the artifact is written.
 */
export function stampBundle(dir, manifest, extra = {}) {
  const path = join(dir, bundleStampFile(manifest.id));
  if (!existsSync(join(dir, bundleFile(manifest.id)))) return null;
  writeFileSync(path, `${JSON.stringify(bundleBuildStamp(dir, manifest, extra), null, 2)}\n`, 'utf8');
  return path;
}

/** The stamp on disk, or `null` when there is none, it is corrupt, or it is not the one for `file`. */
function readStamp(dir, id, file) {
  const path = join(dir, bundleStampFile(id));
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, 'utf8'));
    return stamp?.file === file && stamp.sources_sha256 && stamp.bundle_sha256 ? stamp : null;
  } catch {
    return null; // a corrupt stamp proves nothing: fall back to git/mtime
  }
}

// --- provenance -------------------------------------------------------------------------------

/**
 * Paths that betray WHERE the bundle was baked. esbuild annotates each input with its path relative
 * to the working directory of the process, so a build launched from somewhere else than the module
 * bakes the builder's filesystem into the artifact — and the artifact is published verbatim.
 *
 * Two rules, because the real case needed both:
 *
 *  • ABSOLUTE — anchored on purpose. `../../../../Users/x/…` is what esbuild prints for a build run
 *    far from the module: ugly, but the same string on every machine, so flagging it would fire on
 *    perfectly reproducible bundles.
 *  • TEMPORARY — NOT anchored, because the real one was relative: `verifactu@63039d3^` shipped
 *    `../../../../../../private/tmp/claude-501/…/scratchpad/vf40/ui/components/…`. A path that walks
 *    into a temp dir or a scratchpad points at a tree that no longer exists on any machine; whether
 *    it is spelled absolute or relative changes nothing about that.
 *
 * Both were checked against `origin/main` of the 27 published modules on 2026-08-28: zero hits, so
 * nothing is grandfathered here.
 */
const ABSOLUTE_BUILD_PATH = /(?<![\w.\-\\/])(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\{1,2})[\w.\-\\/]*/g;
const SCRATCH_BUILD_PATH =
  /(?:\/private\/(?:tmp|var)\/|\/var\/folders\/|\/tmp\/|\/scratchpad\/|\\Temp\\)[\w.\-\\/]*/g;

/** How many offending paths to print before summarising: enough to see the pattern, not a dump. */
const MAX_REPORTED_PATHS = 5;

/**
 * The bundle must not carry absolute paths of the machine that built it.
 * Returns `{ checked, errors, warnings }` — an absolute path is an ERROR.
 */
export function checkBundleProvenance(dir, manifest) {
  const out = { checked: false, errors: [], warnings: [] };
  const file = bundleFile(manifest.id);
  const path = join(dir, file);
  if (!existsSync(path)) return out;
  out.checked = true;

  const code = readFileSync(path, 'utf8');
  const hits = [...new Set([...(code.match(ABSOLUTE_BUILD_PATH) ?? []), ...(code.match(SCRATCH_BUILD_PATH) ?? [])])];
  if (!hits.length) return out;

  const shown = hits.slice(0, MAX_REPORTED_PATHS).join(', ');
  const rest = hits.length > MAX_REPORTED_PATHS ? ` (y ${hits.length - MAX_REPORTED_PATHS} más)` : '';
  out.errors.push(
    `${file} lleva ${hits.length} ruta(s) de la máquina que lo compiló (absolutas o hacia un ` +
      `directorio temporal): ${shown}${rest}. ` +
      'El bundle se publica tal cual, así que eso viaja a todos los hubs y delata un build hecho ' +
      'desde un clone temporal que nadie puede reproducir — reconstrúyelo con `erplora build <dir>` ' +
      '(module-toolkit#93).',
  );
  return out;
}

/**
 * A machine-independent name for a file that went into the bundle.
 *
 * Three buckets, in order, and every one of them is stable across machines:
 *   1. inside the module → its path relative to the module (`ui/components/erp-x.ts`);
 *   2. inside some package → `<package name>/<path inside it>` (`lit-html/lit-html.js`,
 *      `@erplora/outfitkit/dist/define.js`). The nearest ancestor with a `package.json` names it,
 *      which works the same for a plain `node_modules`, a pnpm store and a monorepo sibling;
 *   3. neither → the file name, which leaks nothing.
 */
export function stableSourcePath(abs, moduleDir, cache = new Map()) {
  const inside = relative(moduleDir, abs);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return inside.split(sep).join('/');

  let dir = dirname(abs);
  for (;;) {
    if (!cache.has(dir)) {
      const pkg = join(dir, 'package.json');
      let name = null;
      if (existsSync(pkg)) {
        try {
          name = JSON.parse(readFileSync(pkg, 'utf8')).name ?? null;
        } catch {
          name = null; // an unreadable package.json is not evidence of anything
        }
      }
      cache.set(dir, name);
    }
    const name = cache.get(dir);
    if (name) return [name, ...relative(dir, abs).split(sep)].join('/');
    const parent = dirname(dir);
    if (parent === dir) return abs.split(/[\\/]/).pop();
    dir = parent;
  }
}

/**
 * Rewrites the `// <path>` annotations esbuild leaves before each input so the bundle reads the same
 * whatever directory it was built from (module-toolkit#93).
 *
 * Only lines that resolve to a file that EXISTS are touched: a comment in someone's source that
 * happens to look like a path is left exactly as it was.
 */
export function normalizeBundlePaths(code, moduleDir, { cwd = process.cwd() } = {}) {
  const cache = new Map();
  return code.replace(/^\/\/ (\S[^\n]*)$/gm, (line, raw) => {
    const abs = resolve(cwd, raw);
    if (!existsSync(abs)) return line;
    return `// ${stableSourcePath(abs, moduleDir, cache)}`;
  });
}

// --- freshness --------------------------------------------------------------------------------

/** `git -C dir …`, or `null` when git is unavailable or the command fails. */
function git(dir, args) {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return res.status === 0 ? (res.stdout ?? '') : null;
}

/** First path in a `git status --porcelain` output, without the two-letter status prefix. */
function firstDirtyPath(porcelain) {
  const line = porcelain.split('\n').find(Boolean);
  return line ? line.slice(3).trim().replace(/^"|"$/g, '') : null;
}

/** Newest of several `git log -1 --format=%ct` answers, or 0 when none of them committed. */
function newestCommit(dir, paths) {
  let newest = 0;
  for (const p of paths) {
    const at = Number(git(dir, ['log', '-1', '--format=%ct', '--', p, ...GIT_EXCLUDE_NOT_IN_BUNDLE])?.trim());
    if (at > newest) newest = at;
  }
  return newest;
}

/** File touched by the newest commit over the UI roots, or `null` when git cannot name one. */
function lastCommittedUiFile(dir, roots) {
  const out = git(dir, ['log', '-1', '--format=', '--name-only', '--', ...roots, ...GIT_EXCLUDE_NOT_IN_BUNDLE]);
  const first = (out ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  return first ?? null;
}

/**
 * Staleness according to git history, which knows what mtime cannot: whether the source really
 * changed after the bundle was produced. Returns `null` when git cannot answer (no repo, no git,
 * files never committed) so the caller falls back to mtimes.
 */
function gitBundleState(dir, file) {
  if (git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return null;
  // `locales/` is in here for the same reason it is in the stamp (module-toolkit#158): esbuild
  // inlines the catalogue, so a commit that only touches it leaves the bundle behind.
  const roots = [...SOURCE_ROOTS, ...LOCALE_ROOTS].filter((r) => existsSync(join(dir, r)));
  const uiDirty = git(dir, ['status', '--porcelain', '--', ...roots, ...GIT_EXCLUDE_NOT_IN_BUNDLE]);
  const bundleDirty = git(dir, ['status', '--porcelain', '--', file]);
  if (uiDirty === null || bundleDirty === null) return null;

  // Uncommitted UI changes with an untouched bundle: the source was edited and nobody rebuilt.
  if (uiDirty.trim() && !bundleDirty.trim()) {
    return { state: 'stale', reason: 'git-worktree', source: firstDirtyPath(uiDirty) ?? 'ui/' };
  }
  // Both dirty: the bundle WAS rebuilt here — mtimes decide whether it happened after the last edit.
  if (uiDirty.trim() && bundleDirty.trim()) return null;
  // Only the bundle is dirty: it was just rebuilt over an unchanged source.
  if (bundleDirty.trim()) return { state: 'fresh', reason: 'git-worktree' };

  // Clean tree: compare the last commit that touched each side.
  const uiAt = newestCommit(dir, roots);
  const bundleAt = newestCommit(dir, [file]);
  if (!uiAt || !bundleAt) return null; // one of them was never committed
  if (uiAt > bundleAt) {
    return {
      state: 'stale',
      reason: 'git-history',
      // Naming the actual file is what makes the message actionable: "ui/ changed" sends the author
      // looking, "ui/components/erp-flows-list.ts changed" is already the answer.
      source: lastCommittedUiFile(dir, roots),
      lagMs: (uiAt - bundleAt) * 1000,
    };
  }
  return { state: 'fresh', reason: 'git-history' };
}

/**
 * State of the bundle against the Web Component sources:
 * `missing` · `stale` · `fresh` · `undatable` (the module ships no UI source).
 */
function bundleState(dir, manifest) {
  const file = bundleFile(manifest.id);
  const path = join(dir, file);
  if (!existsSync(path)) return { state: 'missing', file };
  const source = newestUiSource(dir);
  if (!source.path) return { state: 'undatable', file };

  // 1) The stamp: direct evidence, and the only layer a rebuild can always clear.
  const stamp = readStamp(dir, manifest.id, file);
  if (stamp) {
    const sourcesMatch = stamp.sources_sha256 === hashUiSources(dir);
    // RATCHET (module-toolkit#158): a stamp written before the catalogue was hashed says nothing
    // about it, so it is not held to it. `undefined` is "not stamped for locales", never "matches".
    const localesMatch =
      stamp.locales_sha256 === undefined || stamp.locales_sha256 === hashLocaleSources(dir);
    const bundleMatches =
      stamp.bundle_sha256 === createHash('sha256').update(readFileSync(path)).digest('hex');
    if (sourcesMatch && localesMatch && bundleMatches) return { state: 'fresh', reason: 'stamp', file };
    let reason = 'stamp-bundle';
    if (!sourcesMatch) reason = 'stamp-sources';
    else if (!localesMatch) reason = 'stamp-locales';
    return { state: 'stale', reason, file, source: relative(dir, source.path) };
  }

  // 2) git history, for modules not yet built with a toolkit that stamps.
  const fromGit = gitBundleState(dir, file);
  if (fromGit) return { ...fromGit, file, source: fromGit.source || relative(dir, source.path) };

  // 3) mtimes, for a module with no history at all (a scaffold, an unpacked zip).
  const lagMs = source.mtimeMs - statSync(path).mtimeMs;
  if (lagMs > BUNDLE_MTIME_TOLERANCE_MS) {
    return { state: 'stale', reason: 'mtime', file, source: relative(dir, source.path), lagMs };
  }
  return { state: 'fresh', reason: 'mtime', file };
}

/** Human wording for how far behind a bundle is (days read better than milliseconds). */
function lagLabel(lagMs) {
  const days = Math.floor(lagMs / 86400000);
  if (days >= 1) return `${days} día(s)`;
  const hours = Math.floor(lagMs / 3600000);
  return hours >= 1 ? `${hours} hora(s)` : `${Math.round(lagMs / 1000)} s`;
}

/** Why the bundle is considered stale, in the terms of whatever evidence found it. */
function staleReason(id, info) {
  const stamp = bundleStampFile(id);
  if (info.reason === 'stamp-sources') return `${info.source} ha cambiado desde el build que anotó ${stamp}`;
  if (info.reason === 'stamp-locales')
    return `locales/ ha cambiado desde el build que anotó ${stamp} — el catálogo va INLINE en el bundle`;
  if (info.reason === 'stamp-bundle') return `el bundle no es el que dejó el build anotado en ${stamp}`;
  if (info.reason === 'git-worktree') return `${info.source} tiene cambios que el bundle no lleva`;
  if (info.reason === 'git-history') return `${info.source} se commiteó ${lagLabel(info.lagMs)} después que el bundle`;
  return `es ${lagLabel(info.lagMs)} más viejo que ${info.source}`;
}

/**
 * `dist/<id>.esm.js` must correspond to the current `ui/`.
 * Returns `{ checked, errors, warnings }`; see the ratchet at the top of the file for the severity.
 */
export function checkBundleFreshness(dir, manifest) {
  const out = { checked: false, errors: [], warnings: [] };
  const info = bundleState(dir, manifest);
  if (info.state === 'missing') return out; // a module can legitimately ship no Web Component
  out.checked = true;

  if (info.state === 'undatable') {
    out.warnings.push(
      `${info.file} no trae fuentes en ui/: no se puede comprobar que corresponda al código de este ` +
        'commit (module-toolkit#93).',
    );
    return out;
  }
  if (info.state !== 'stale') return out;

  const message =
    `${info.file} está DESFASADO: ${staleReason(manifest.id, info)}. El módulo se publica con el dist ` +
    `TAL CUAL, así que los hubs servirían la pantalla vieja — regenéralo con \`erplora build <dir>\` ` +
    '(module-toolkit#93).';

  // Ratchet: only a module that already built with a stamping toolkit can be held to an error.
  if (info.reason?.startsWith('stamp-')) out.errors.push(message);
  else out.warnings.push(`${message} Hoy es AVISO porque el módulo aún no tiene sello; en cuanto lo construyas una vez, será error.`);
  return out;
}

/** Both guards in one report — what `erplora validate` runs before letting a module be packed. */
export function checkBundleArtifact(dir, manifest) {
  const provenance = checkBundleProvenance(dir, manifest);
  const freshness = checkBundleFreshness(dir, manifest);
  return {
    checked: provenance.checked || freshness.checked,
    errors: [...provenance.errors, ...freshness.errors],
    warnings: [...provenance.warnings, ...freshness.warnings],
  };
}
