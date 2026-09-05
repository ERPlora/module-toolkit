// The battery that reads `migrations.postgres` as if it were a list of strings (module-toolkit#180).
//
// A module's Postgres batteries stand their own database up by walking the manifest by hand:
//
//     for rel in MANIFEST["migrations"]["postgres"]:
//         psql(db, (MODULE_DIR / rel).read_text())
//
// That loop only knows one of the two forms the runtime accepts (`MigrationEntry`, hub#542). The
// other — `{ "file", "kind", "since" }` — is the ONLY way to declare a `contract`, i.e. a
// legitimate `DROP`. The day a module declares one, every battery still carrying the old loop dies
// before testing anything:
//
//     TypeError: unsupported operand type(s) for /: 'PosixPath' and 'dict'
//
// It has already happened twice inside ONE pull request. ERPlora/appointments#115 had to touch 15
// batteries to land its `contract` migration; while it was open, ERPlora/appointments#114 merged a
// brand new battery copied from an old one, with the old loop. Neither PR had a textual conflict,
// both read `MERGEABLE`, and #115's CI went red on the merge ref — a red no branch could reproduce
// on its own. With 27 modules the same blow is waiting for the first `contract` of each, and for
// every battery copied from an old one afterwards.
//
// WHY THE VERDICT HAS TWO LEVELS. Swept over `origin/main` of the 27 module repos on 2026-09-05
// (`~/.erplora/fleet/logs/178/loop-sweep`): 57 old-form loops in 14 modules. Turning that into a
// red gate would stop 14 modules for a bug none of them HAS yet — every one of those modules
// declares its migrations as plain strings. So:
//
//   · string-only manifest → WARNING. The loop is a landmine, not a fault; it is named and left.
//   · one object entry declared → ERROR. There is nothing published to protect: that battery is
//     already broken, and the module cannot prove otherwise.
//
// Not one of the 57 is in a module that already uses the object form, so the ERROR arm reddens
// nobody today: it is a pure ratchet over the next `contract`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { migrationEntries } from './validate-migrations.mjs';

const IGNORED_DIRS = new Set(['__pycache__', 'node_modules', '.venv', 'venv', '.pytest_cache']);

/** Tokens that prove the code already knows an entry may be an object. */
const NORMALISED = /\bisinstance\s*\(|\[\s*["']file["']\s*\]|\.\s*get\s*\(\s*["']file["']/;

/**
 * The same Python with `#` comments and triple-quoted blocks blanked to spaces, offsets untouched.
 *
 * Ordinary string literals are LEFT ALONE on purpose: the loop this file hunts for reads
 * `MANIFEST["migrations"]["postgres"]`, and blanking string bodies would erase the very words that
 * identify it. What has to go is prose — a `#` line and a docstring that keep the old shape around
 * as an example paint no loop. The scanner still tracks ordinary strings, so a `#` inside one is a
 * character and not the start of a comment.
 */
function blankProse(source) {
  const out = source.split('');
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const three = source.slice(i, i + 3);
    if (three === '"""' || three === "'''") {
      const end = source.indexOf(three, i + 3);
      const stop = end < 0 ? source.length : end + 3;
      while (i < stop) blank(i++);
      continue;
    }
    if (source[i] === '#') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = source[i];
      i += 1;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Bracket depth at every offset. */
function depths(code) {
  const out = new Int32Array(code.length);
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    if ('([{'.includes(code[i])) {
      out[i] = depth;
      depth += 1;
    } else if (')]}'.includes(code[i])) {
      depth -= 1;
      out[i] = depth;
    } else {
      out[i] = depth;
    }
  }
  return out;
}

/** `{ from, to }` of the bracket that encloses `at`, or null when `at` is at statement level. */
function enclosingBracket(code, depth, at) {
  if (depth[at] === 0) return null;
  let from = -1;
  for (let i = at; i >= 0; i -= 1) {
    if ('([{'.includes(code[i]) && depth[i] === depth[at] - 1) {
      from = i;
      break;
    }
  }
  if (from < 0) return null;
  for (let i = from + 1; i < code.length; i += 1) {
    if (')]}'.includes(code[i]) && depth[i] === depth[from]) return { from, to: i + 1 };
  }
  return null;
}

/**
 * Whether this expression is a comprehension that MAPS what it iterates — `[migration_path(e) for e
 * in …]`. What it produces is no longer the manifest's list, so nothing downstream can meet a dict.
 */
function isMapped(text) {
  const m = /^\s*[[({]([\s\S]*?)\bfor\s+(\w+)\s+in\b/.exec(text);
  return m != null && m[1].trim() !== '' && m[1].trim() !== m[2];
}

/** Whether this expression reads `migrations.postgres` off the manifest. */
const readsMigrations = (text) =>
  /\bMANIFEST\b|\bmanifest\b/.test(text) && /migrations/.test(text) && /postgres/.test(text);

/** The indentation (in characters) of the line `at` belongs to. */
function indentOf(code, at) {
  const start = code.lastIndexOf('\n', at - 1) + 1;
  return at - start;
}

/**
 * `{ text, from, to }` of the region a `for` at `at` owns: the enclosing brackets when it is a
 * comprehension, the indented block below it when it is a statement.
 */
function loopRegion(code, depth, at) {
  const bracket = enclosingBracket(code, depth, at);
  if (bracket) return { text: code.slice(bracket.from, bracket.to), from: bracket.from };

  const base = indentOf(code, at);
  const lineEnd = code.indexOf('\n', at);
  if (lineEnd < 0) return { text: code.slice(at), from: at };
  const lines = code.slice(lineEnd + 1).split('\n');
  const body = [];
  let consumed = 0;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (line.trim() && indent <= base) break;
    body.push(line);
    consumed += line.length + 1;
  }
  return { text: code.slice(at, lineEnd + 1 + consumed), from: at };
}

/** The header of a `for` at `at`: everything between `in` and the `:` (or the end of the region). */
function iterableOf(code, depth, at, region) {
  const inAt = code.slice(at).search(/\bin\b/);
  if (inAt < 0) return '';
  const from = at + inAt + 2;
  const bracket = enclosingBracket(code, depth, at);
  if (bracket) return code.slice(from, bracket.to - 1);
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === ':' && depth[i] === depth[at]) return code.slice(from, i);
    if (code[i] === '\n' && depth[i] === 0) break;
  }
  return code.slice(from, region.from + region.text.length);
}

/** Ways a battery turns the loop variable into a path — every one of them dies on a dict. */
const pathUses = (v) => [
  new RegExp(String.raw`/\s*${v}\b`),
  new RegExp(String.raw`\b${v}\s*/`),
  new RegExp(String.raw`\bopen\s*\([^)]*\b${v}\b`),
  new RegExp(String.raw`\bjoin\s*\([^)]*\b${v}\b`),
  new RegExp(String.raw`\bPath\s*\([^)]*\b${v}\b`),
];

/**
 * Every loop in this Python source that walks `migrations.postgres` and uses the entry as a PATH
 * without ever admitting it might be an object.
 *
 * Returns `[{ line, variable, snippet }]`. A loop that only PRINTS the entry, or one that maps it
 * first (`isinstance`, `entry["file"]`, a helper in a comprehension), is not a finding: what breaks
 * is the path, and only the path.
 */
export function batteryMigrationLoops(source) {
  const code = blankProse(source);
  const depth = depths(code);

  // `RELS = [ … MANIFEST["migrations"]["postgres"] … ]` and then `for rel in RELS:` — the loop is a
  // finding only when what was bound is still the RAW list. A binding that already mapped the
  // entries is the fix, wherever it was written.
  const raw = new Set();
  for (const m of code.matchAll(/^[ \t]*(\w+)\s*=\s*/gm)) {
    const rest = code.slice(m.index + m[0].length);
    const end = rest.search(/\n(?![ \t])/);
    const rhs = end < 0 ? rest : rest.slice(0, end);
    if (readsMigrations(rhs) && !NORMALISED.test(rhs) && !isMapped(rhs)) raw.add(m[1]);
  }

  const found = [];
  for (const m of code.matchAll(/\bfor\s+(\w+)\s+in\b/g)) {
    const variable = m[1];
    const region = loopRegion(code, depth, m.index);
    const iterable = iterableOf(code, depth, m.index, region);
    if (!readsMigrations(iterable) && !raw.has(iterable.trim())) continue;
    if (NORMALISED.test(iterable)) continue;

    // A comprehension that maps the element (`[migration_path(e) for e in …]`) normalises it: the
    // list it produces is not the manifest's, and what the caller iterates is already a path.
    const bracket = enclosingBracket(code, depth, m.index);
    if (bracket) {
      const element = code.slice(bracket.from + 1, m.index).trim();
      if (element && element !== variable) continue; // see `isMapped`: the element was transformed
      if (NORMALISED.test(region.text)) continue;
    }

    const body = region.text.slice(region.text.indexOf('\n') + 1);
    const scope = bracket ? region.text : body;
    if (NORMALISED.test(scope)) continue;
    if (!pathUses(variable).some((re) => re.test(scope))) continue;

    found.push({
      line: code.slice(0, m.index).split('\n').length,
      variable,
      snippet: source.slice(m.index, code.indexOf('\n', m.index) < 0 ? undefined : code.indexOf('\n', m.index)).trim(),
    });
  }
  return found;
}

/** Every `.py` under `tests/`, batteries and the helpers they share alike. */
function pythonFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pythonFiles(full));
    else if (entry.name.endsWith('.py')) out.push(full);
  }
  return out;
}

/**
 * The whole door, over a module on disk. Returns `{ errors, warnings }`; never throws.
 *
 * The level follows the manifest, not the battery: while every declared migration is a plain string
 * the loop is a landmine (WARNING); the moment one is declared as an object the same loop is a
 * battery that cannot run (ERROR).
 */
export function checkBatteryMigrations(dir, manifest) {
  const errors = [];
  const warnings = [];

  const objectEntry = (manifest?.migrations?.postgres ?? []).find(
    (e) => e && typeof e === 'object' && !Array.isArray(e),
  );
  const objectFile =
    objectEntry &&
    (migrationEntries(manifest, 'postgres').find((e) => e.kind !== 'expand' || e.since)?.file ??
      objectEntry.file);

  for (const abs of pythonFiles(join(dir, 'tests'))) {
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue; // an unreadable helper is another gate's problem
    }
    const rel = relative(dir, abs).split(sep).join('/');
    for (const { line, variable } of batteryMigrationLoops(source)) {
      const how =
        `Normalízalo — \`${variable} = e if isinstance(e, str) else e["file"]\` — o, mejor, no leas el ` +
        'manifest: `erplora test` ya publica `ERPLORA_MIGRATION_FILES` en el entorno de cada batería ' +
        'con las rutas ya resueltas, una por línea.';
      if (objectEntry) {
        errors.push(
          `${rel}:${line}: el bucle \`for ${variable} in …migrations.postgres\` usa la entrada como ` +
            `RUTA, pero este módulo ya declara \`${objectFile}\` con la forma objeto ` +
            '`{ file, kind, since }` (hub#542, la única manera de declarar un `contract`). Esta ' +
            'batería NO puede correr: muere con `TypeError: unsupported operand type(s) for /: ' +
            `'PosixPath' and 'dict'\` antes de probar nada. ${how} ` +
            '(ERPlora/module-toolkit#180)',
        );
      } else {
        warnings.push(
          `[battery-migrations] ${rel}:${line}: el bucle \`for ${variable} in …migrations.postgres\` ` +
            'usa la entrada como RUTA y solo entiende la forma string. El día que este módulo declare ' +
            'su primer `contract` —que se declara con la forma objeto `{ file, kind, since }` ' +
            "(hub#542)— esta batería morirá con `TypeError: … 'PosixPath' and 'dict'` antes de probar " +
            `nada, y lo hará en el merge-ref de otra PR. ${how} (ERPlora/module-toolkit#180)`,
        );
      }
    }
  }

  return { errors, warnings };
}
