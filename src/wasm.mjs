// Tier-2 WASM handler: compile it on `erplora build`, and refuse to publish a stale binary
// (module-toolkit#26).
//
// The bug this closes: `erplora build` compiled the Web Component and baked the icons, but never
// touched `dist/handler.wasm`. So a module whose `handler/src/lib.rs` had changed shipped its OLD
// Tier-2 logic while the manifest, the queries and the WC were up to date — a mismatch no test in
// the module repo can see (the handler's unit tests run on the Rust source, not on the packaged
// binary) and that only shows up in a real hub. Hit twice on 2026-08-07 (tables#25, pricing#17).
//
// Two independent guards, because neither catches the other's case:
//   • EXPORTS  — every `commands[].handler.function` the manifest declares must be exported by the
//     binary. Catches a NEW function that was never compiled in (tables: `split_session`).
//   • FRESHNESS — the binary must correspond to the current `handler/`. Catches a changed BODY with
//     unchanged exports (pricing: same three functions, different arithmetic), which the export
//     check is blind to.
//
// Freshness uses the best evidence available, in this order — a publish gate that cries wolf gets
// ignored, and running the mtime-only version over the workspace flagged 4 modules of which only
// one was really stale:
//   1. STAMP (`dist/handler.build.json`, written by this build): sha256 of the handler tree + of
//      the binary. Direct, and the only layer a rebuild can always clear.
//   2. GIT: uncommitted handler changes with an untouched binary, or a handler committed after the
//      binary (the live `customers` case: handler fixed 13-jul over a binary committed 07-jun).
//   3. MTIME: last resort for a module with no history (a scaffold, an unpacked zip).
//
// Build policy: recompile when stale, fail loudly when it cannot. Recompiling is what stops anyone
// from having to remember; the loud failure is the fallback for an environment without the wasm
// toolchain, because publishing old logic in silence is the worse outcome.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';

// A fresh `git clone` writes every file at checkout time, so sources and binary end up with
// near-identical mtimes. Only a spread wider than this counts as stale (the real cases are weeks).
export const WASM_MTIME_TOLERANCE_MS = 2000;

/** Directories that are build output or VCS noise, never handler source. */
const IGNORED_DIRS = new Set(['target', 'node_modules', 'dist']);

/**
 * The wasm binaries a manifest depends on, grouped by file:
 * `[{ file: 'dist/handler.wasm', functions: ['open_session', …] }]`.
 */
export function declaredWasmHandlers(manifest) {
  const byFile = new Map();
  const operations = [...Object.values(manifest?.commands ?? {}), ...Object.values(manifest?.queries ?? {})];
  for (const op of operations) {
    const handler = op?.handler;
    if (handler?.type !== 'wasm') continue;
    const file = handler.file ?? 'dist/handler.wasm';
    if (!byFile.has(file)) byFile.set(file, new Set());
    if (handler.function) byFile.get(file).add(handler.function);
  }
  return [...byFile].map(([file, functions]) => ({ file, functions: [...functions] }));
}

/** Every source file of the handler crate (Cargo.toml/Cargo.lock + `src/**`), ignoring `target/`. */
export function collectHandlerSources(handlerDir, out = []) {
  let entries;
  try {
    entries = readdirSync(handlerDir, { withFileTypes: true });
  } catch {
    return out; // no handler/ at all
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    const path = join(handlerDir, entry.name);
    if (entry.isDirectory()) collectHandlerSources(path, out);
    else out.push(path);
  }
  return out;
}

/**
 * `Cargo.lock` is NOT evidence of what the binary contains (module-toolkit#31).
 *
 * Two reasons, and either one is enough. It is at once an INPUT of this hash and an OUTPUT of
 * cargo, so any build rewrites a file the gate is hashing. And its contents are not the module's:
 * the handler resolves the guest-sdk BY PATH into the local hub checkout, so two authors on
 * different checkouts produce different locks for the same source — `erplora-guest-sdk 0.0.0` →
 * `1.0.0` the day hub#515 bumped the hub workspace. What it cost, measured: ERPlora/inventory#46
 * went red on `stamp-sources` with the binary matching its own hash and the Tier-2 logic
 * materially unchanged (the rebuilt wasm differed by ONE byte) — a merge blocked by metadata.
 *
 * The reproducibility of the handler is a real problem and this does not solve it; it is the
 * published guest-sdk that does (module-toolkit#32). What this does is stop a file nobody edited
 * from speaking for the binary.
 */
const CARGO_LOCK = 'Cargo.lock';

const isCargoLock = (handlerDir, path) => relative(handlerDir, path) === CARGO_LOCK;

/** Newest source of the handler crate: `{ path, mtimeMs }` (`path: null` when there is none). */
function newestHandlerSource(handlerDir) {
  let newest = { path: null, mtimeMs: 0 };
  for (const path of collectHandlerSources(handlerDir)) {
    if (isCargoLock(handlerDir, path)) continue; // see CARGO_LOCK: cargo touches it, the author does not
    const { mtimeMs } = statSync(path);
    if (mtimeMs > newest.mtimeMs) newest = { path, mtimeMs };
  }
  return newest;
}

/** Sidecar `erplora build` writes next to the binary; the authoritative freshness evidence. */
export const WASM_STAMP_FILE = 'dist/handler.build.json';

/**
 * sha256 of the handler crate: relative paths + contents, order-independent. `Cargo.lock` is left
 * out (see `CARGO_LOCK`); `includeLock` reproduces the LEGACY hash, the one the stamps written
 * before module-toolkit#31 carry.
 */
export function hashHandlerSources(handlerDir, { includeLock = false } = {}) {
  const hash = createHash('sha256');
  for (const path of collectHandlerSources(handlerDir).sort()) {
    if (!includeLock && isCargoLock(handlerDir, path)) continue;
    hash.update(relative(handlerDir, path)).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

/** Provenance of the binary currently on disk: which sources produced it, and which bytes came out. */
export function wasmBuildStamp(dir, manifest, extra = {}) {
  const file = declaredWasmHandlers(manifest)[0]?.file ?? 'dist/handler.wasm';
  return {
    file,
    target: 'wasm32-unknown-unknown',
    sources_sha256: hashHandlerSources(join(dir, 'handler')),
    wasm_sha256: createHash('sha256').update(readFileSync(join(dir, file))).digest('hex'),
    built_at: new Date().toISOString(),
    ...extra,
  };
}

/** The stamp on disk, or `null` when there is none (or it is not the one for `file`). */
function readStamp(dir, file) {
  const path = join(dir, WASM_STAMP_FILE);
  if (!existsSync(path)) return null;
  try {
    const stamp = JSON.parse(readFileSync(path, 'utf8'));
    return stamp?.file === file && stamp.sources_sha256 && stamp.wasm_sha256 ? stamp : null;
  } catch {
    return null; // a corrupt stamp proves nothing: fall back to git/mtime
  }
}

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

/**
 * Staleness according to git history, which knows what mtime cannot: whether the source really
 * changed after the binary was produced. Returns `null` when git cannot answer (no repo, no git,
 * files never committed) so the caller falls back to mtimes.
 */
function gitWasmState(dir, file) {
  if (git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return null;
  const handlerDirty = git(dir, ['status', '--porcelain', '--', 'handler']);
  const wasmDirty = git(dir, ['status', '--porcelain', '--', file]);
  if (handlerDirty === null || wasmDirty === null) return null;

  // Uncommitted handler changes with an untouched binary: exactly what bit tables/pricing — the
  // source was edited, `erplora build` said nothing, and the binary stayed as it was.
  if (handlerDirty.trim() && !wasmDirty.trim()) {
    return { state: 'stale', reason: 'git-worktree', source: firstDirtyPath(handlerDirty) ?? 'handler/' };
  }
  // Both dirty: the binary WAS rebuilt in this working tree — mtimes decide whether it happened
  // after the last edit (edit → build → edit again).
  if (handlerDirty.trim() && wasmDirty.trim()) return null;
  // Only the binary is dirty: it was just rebuilt over an unchanged source.
  if (wasmDirty.trim()) return { state: 'fresh', reason: 'git-worktree' };

  // Clean tree: compare the last commit that touched each side.
  const handlerAt = Number(git(dir, ['log', '-1', '--format=%ct', '--', 'handler'])?.trim());
  const wasmAt = Number(git(dir, ['log', '-1', '--format=%ct', '--', file])?.trim());
  if (!handlerAt || !wasmAt) return null; // one of them was never committed
  if (handlerAt > wasmAt) {
    return {
      state: 'stale',
      reason: 'git-history',
      source: 'handler/',
      lagMs: (handlerAt - wasmAt) * 1000,
    };
  }
  return { state: 'fresh', reason: 'git-history' };
}

/**
 * State of one declared binary against the handler sources:
 * `missing` (not built yet) · `stale` (older than a source) · `fresh` · `undatable` (no sources).
 *
 * git answers first when it can (see `gitWasmState`); mtimes are the fallback for a module without
 * history — a scaffold, an unpacked zip, a CI checkout of the sources alone.
 */
function wasmState(dir, file) {
  const wasmPath = join(dir, file);
  const handlerDir = join(dir, 'handler');
  if (!existsSync(wasmPath)) return { state: 'missing', file, wasmPath };
  const source = newestHandlerSource(handlerDir);
  if (!source.path) return { state: 'undatable', file, wasmPath };

  // 1) The stamp: direct evidence, and the only layer a rebuild can always clear.
  const stamp = readStamp(dir, file);
  if (stamp) {
    // Either hash counts. The 21 modules with a handler carry a stamp written by the LEGACY one
    // (lock included), and rejecting them all at once would turn the publish gate red across the
    // catalog for a change of ours — with no way to update an installed module (ADR-0269). Each
    // module gains the immunity to the lock with its next build; until then it keeps validating
    // exactly as it did. Accepting both never hides a source edit: that changes both hashes.
    const sourcesMatch =
      stamp.sources_sha256 === hashHandlerSources(handlerDir) ||
      stamp.sources_sha256 === hashHandlerSources(handlerDir, { includeLock: true });
    const wasmMatches = stamp.wasm_sha256 === createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
    if (sourcesMatch && wasmMatches) return { state: 'fresh', reason: 'stamp', file, wasmPath };
    return { state: 'stale', reason: sourcesMatch ? 'stamp-wasm' : 'stamp-sources', file, wasmPath };
  }

  // 2) git history, for modules not yet built with a toolkit that stamps.
  const fromGit = gitWasmState(dir, file);
  if (fromGit) return { ...fromGit, file, wasmPath };

  const wasmMtimeMs = statSync(wasmPath).mtimeMs;
  const lagMs = source.mtimeMs - wasmMtimeMs;
  if (lagMs > WASM_MTIME_TOLERANCE_MS) {
    return { state: 'stale', reason: 'mtime', file, wasmPath, source: relative(dir, source.path), lagMs };
  }
  return { state: 'fresh', reason: 'mtime', file, wasmPath };
}

/** Human wording for how far behind a binary is (days read better than milliseconds). */
function lagLabel(lagMs) {
  const days = Math.floor(lagMs / 86400000);
  if (days >= 1) return `${days} día(s)`;
  const hours = Math.floor(lagMs / 3600000);
  return hours >= 1 ? `${hours} hora(s)` : `${Math.round(lagMs / 1000)} s`;
}

/** Why a binary is considered stale, in the terms of whatever evidence found it. */
function staleReason(info) {
  if (info.reason === 'stamp-sources') return `handler/ ha cambiado desde la compilación que anotó ${WASM_STAMP_FILE}`;
  if (info.reason === 'stamp-wasm') return `el binario no es el que dejó la compilación anotada en ${WASM_STAMP_FILE}`;
  if (info.reason === 'git-worktree') return `${info.source} tiene cambios que el binario no lleva`;
  if (info.reason === 'git-history') return `handler/ se commiteó ${lagLabel(info.lagMs)} después que el binario`;
  return `es ${lagLabel(info.lagMs)} más viejo que ${info.source}`;
}

/**
 * Cheap guard: `dist/handler.wasm` must not be older than any `handler/` source.
 * Returns `{ checked, errors, warnings }` — a stale binary is an ERROR.
 */
export function checkWasmFreshness(dir, manifest) {
  const out = { checked: false, errors: [], warnings: [] };
  const declared = declaredWasmHandlers(manifest);
  if (!declared.length) return out;

  for (const { file } of declared) {
    const info = wasmState(dir, file);
    if (info.state === 'missing') continue; // reported by checkWasmExports, no need to say it twice
    out.checked = true;
    if (info.state === 'undatable') {
      out.warnings.push(
        `${file} no trae fuentes en handler/: no se puede comprobar que corresponda al código de ` +
          'este commit (module-toolkit#26).',
      );
    } else if (info.state === 'stale') {
      out.errors.push(
        `${file} está DESFASADO: ${staleReason(info)}. El módulo publicaría la lógica Tier 2 vieja ` +
          'con el manifest nuevo — regenéralo con `erplora build <dir>` (module-toolkit#26).',
      );
    }
  }
  return out;
}

/**
 * Exports of a wasm binary: `[{ name, kind }]` (kind 0 = function).
 * Walks the section table and decodes section 7; no dependencies, no instantiation.
 */
export function readWasmExports(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) {
    throw new Error('no es un binario wasm (falta la cabecera \\0asm)');
  }
  const exports = [];
  let offset = 8;
  while (offset < buf.length) {
    const id = readVarUint(buf, offset);
    const size = readVarUint(buf, id.next);
    const end = size.next + size.value;
    if (end > buf.length) throw new Error('binario wasm truncado: una sección se sale del fichero');
    if (id.value === 7) {
      let pos = size.next;
      const count = readVarUint(buf, pos);
      pos = count.next;
      for (let i = 0; i < count.value; i++) {
        const len = readVarUint(buf, pos);
        const name = buf.toString('utf8', len.next, len.next + len.value);
        pos = len.next + len.value;
        const kind = buf[pos];
        pos = readVarUint(buf, pos + 1).next;
        exports.push({ name, kind });
      }
    }
    offset = end;
  }
  return exports;
}

/** LEB128 unsigned at `offset` → `{ value, next }`. */
function readVarUint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('binario wasm truncado: entero LEB128 incompleto');
    const byte = buf[pos++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return { value: value >>> 0, next: pos };
}

/**
 * Robust guard: every function the manifest routes to a wasm handler must be exported by the
 * binary that ships in the zip. Returns `{ checked, errors, warnings }`.
 */
export function checkWasmExports(dir, manifest) {
  const out = { checked: false, errors: [], warnings: [] };
  for (const { file, functions } of declaredWasmHandlers(manifest)) {
    const wasmPath = join(dir, file);
    if (!existsSync(wasmPath)) {
      out.errors.push(`el manifest declara handler.file ${file} pero no existe (module-toolkit#26).`);
      continue;
    }
    let exported;
    try {
      exported = new Set(readWasmExports(readFileSync(wasmPath)).filter((e) => e.kind === 0).map((e) => e.name));
    } catch (err) {
      out.warnings.push(`no se pudo leer la sección de exports de ${file}: ${err.message}`);
      continue;
    }
    out.checked = true;
    const missing = functions.filter((fn) => !exported.has(fn));
    if (missing.length) {
      out.errors.push(
        `${file} NO exporta ${missing.join(', ')} (exporta ${exported.size}: ` +
          `${[...exported].join(', ') || '—'}). El binario no corresponde al manifest: recompila el ` +
          'handler con `erplora build <dir>` (module-toolkit#26).',
      );
    }
  }
  return out;
}

/** Both guards in one report — what `erplora validate` runs before letting a module be packed. */
export function checkWasmArtifact(dir, manifest) {
  const freshness = checkWasmFreshness(dir, manifest);
  const exports = checkWasmExports(dir, manifest);
  return {
    checked: freshness.checked || exports.checked,
    errors: [...exports.errors, ...freshness.errors],
    warnings: [...exports.warnings, ...freshness.warnings],
  };
}

/** `cargo` + the `wasm32-unknown-unknown` target, or why the handler cannot be rebuilt here. */
export function resolveWasmToolchain() {
  // Look up the PATH without spawning a shell (avoids DEP0190).
  const which = (exe) => (process.env.PATH || '').split(':').some((p) => p && existsSync(join(p, exe)));
  if (!which('cargo')) return { available: false, reason: 'cargo no instalado' };
  if (which('rustup')) {
    const res = spawnSync('rustup', ['target', 'list', '--installed'], { encoding: 'utf8' });
    if (!(res.stdout || '').split('\n').includes('wasm32-unknown-unknown')) {
      return {
        available: false,
        reason: 'falta el target wasm32-unknown-unknown (rustup target add wasm32-unknown-unknown)',
      };
    }
  }
  return { available: true, cargo: 'cargo' };
}

/** Feature names declared in the `[features]` table of a Cargo.toml. */
export function cargoFeatures(cargoToml) {
  const text = readFileSync(cargoToml, 'utf8');
  const block = text.split(/^\s*\[features\]\s*$/m)[1];
  if (!block) return [];
  const body = block.split(/^\s*\[/m)[0];
  return [...body.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]);
}

/**
 * `cargo build --release --target wasm32-unknown-unknown [--features …]` of the handler crate.
 * Returns `{ status, stdout, stderr, artifact }`; `artifact` is the `.wasm` cargo left behind.
 */
export function cargoBuildWasm(cargoToml, toolchain, { features = [] } = {}) {
  const args = ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', cargoToml, '--quiet'];
  if (features.length) args.push('--features', features.join(','));
  const res = spawnSync(toolchain.cargo ?? 'cargo', args, { encoding: 'utf8', timeout: 600000 });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    artifact: res.status === 0 ? locateWasmArtifact(cargoToml) : null,
  };
}

/** Where cargo leaves the binary: `target/wasm32-unknown-unknown/release/<crate_name>.wasm`. */
export function locateWasmArtifact(cargoToml) {
  const crate = readCrateName(cargoToml).replace(/-/g, '_');
  const candidate = join(dirname(cargoToml), 'target', 'wasm32-unknown-unknown', 'release', `${crate}.wasm`);
  return existsSync(candidate) ? candidate : null;
}

/** `[package] name` of a Cargo.toml (light parsing, no TOML dependency). */
function readCrateName(cargoToml) {
  const m = readFileSync(cargoToml, 'utf8').match(/^\s*\[package\][\s\S]*?^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : 'handler';
}

/**
 * Rebuilds `dist/handler.wasm` from `handler/` when it is stale or missing, and verifies the result
 * against the manifest. Returns `{ status: 'skipped' | 'fresh' | 'built', … }`.
 *
 * THROWS (loudly, on purpose) when the binary is out of date and cannot be regenerated — no wasm
 * toolchain, a handler that does not compile, or a rebuilt binary that still lacks a declared
 * function. Publishing stale Tier-2 logic in silence is exactly what module-toolkit#26 is about.
 */
export function buildWasmHandler(dir, manifest, { toolchain, runCargo = cargoBuildWasm } = {}) {
  const declared = declaredWasmHandlers(manifest);
  if (!declared.length) return { status: 'skipped', reason: 'el módulo no declara handlers WASM' };

  const cargoToml = join(dir, 'handler', 'Cargo.toml');
  if (!existsSync(cargoToml)) {
    // Precompiled third-party wasm: nothing to rebuild here. `validate` still warns about it.
    return { status: 'skipped', reason: 'no hay handler/Cargo.toml que compilar' };
  }
  if (declared.length > 1) {
    throw new Error(
      `el manifest declara ${declared.length} binarios wasm (${declared.map((d) => d.file).join(', ')}) ` +
        'pero solo hay un crate en handler/: el toolkit no sabe cuál regenerar (module-toolkit#26).',
    );
  }

  const { file } = declared[0];
  const info = wasmState(dir, file);
  // A binary can look perfectly current and still not be the one the manifest routes to (dropping
  // an old build in place gives it a fresh mtime). The export mismatch is reason enough to rebuild.
  const mismatch = info.state === 'fresh' ? checkWasmExports(dir, manifest).errors : [];
  if (info.state === 'fresh' && !mismatch.length) return { status: 'fresh', file };

  const why =
    info.state === 'missing'
      ? `${file} no existe`
      : info.state === 'fresh'
        ? `${file} no exporta lo que el manifest declara`
        : `${file} está DESFASADO (${staleReason(info)})`;

  const chain = toolchain ?? resolveWasmToolchain();
  if (!chain.available) {
    throw new Error(
      `${why} y no se puede regenerar aquí: ${chain.reason}. El módulo publicaría lógica Tier 2 ` +
        'vieja — compila el handler en un entorno con la toolchain wasm antes de empaquetar ' +
        '(module-toolkit#26).',
    );
  }

  // `--features guest`: the Extism entry points live behind it. Without it the crate still compiles
  // but the binary exports nothing (~364 bytes of nothing), which is worse than not building at all.
  const features = cargoFeatures(cargoToml).includes('guest') ? ['guest'] : [];
  const res = runCargo(cargoToml, chain, { features });
  if (res.status !== 0) {
    const tail = (res.stderr || res.stdout || '').split('\n').filter(Boolean).slice(-8).join('\n    ');
    throw new Error(`handler/ no compila a wasm32 (module-toolkit#26):\n    ${tail || 'cargo terminó sin salida'}`);
  }
  if (!res.artifact) {
    throw new Error(
      'cargo terminó bien pero no se encuentra el .wasm en target/wasm32-unknown-unknown/release/ ' +
        '(¿el crate no es cdylib?) (module-toolkit#26).',
    );
  }

  const dest = join(dir, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(res.artifact, dest);

  // The manifest can still be lying after a successful build: a command routed to a function the
  // Rust source never grew compiles fine and fails at runtime in the hub.
  const exports = checkWasmExports(dir, manifest);
  if (exports.errors.length) {
    throw new Error('el handler recién compilado no cuadra con el manifest:\n  - ' + exports.errors.join('\n  - '));
  }

  // Provenance: which sources produced these bytes. It is what lets a later `validate` answer
  // without guessing from dates, and what a rebuild always refreshes.
  writeFileSync(join(dir, WASM_STAMP_FILE), JSON.stringify(wasmBuildStamp(dir, manifest, { features }), null, 2) + '\n');

  return { status: 'built', file, bytes: statSync(dest).size, features };
}
