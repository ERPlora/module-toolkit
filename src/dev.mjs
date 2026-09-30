// `erplora dev [id]`: preview local tipo Hub. Boilerplate con componentes Ionic (ion-list sidebar,
// ion-card launcher, ion-header/ion-toolbar, ion-segment inferior, ion-toggle, ion-buttons) + un
// drawer derecho (inspector) con contenido Ionic. Registra TODOS los módulos del workspace en una
// página main; al pulsar uno carga su navegación en el ion-segment de abajo (igual que el Hub) y
// monta su Web Component. Inyecta `globalThis.erplora` MOCK (fixtures o sintético). CSP estricta.
//
//   erplora dev            → todos los módulos del workspace (página main de registro)
//   erplora dev <id>       → igual, pero preselecciona ese módulo
//
// Nota: el layout (sidebar/drawer) es CSS flex por robustez; los COMPONENTES son Ionic + OutfitKit.
// (ion-split-pane/ion-menu sin router no maquetan bien fuera del shell real del Hub.)
import { context as esContext } from 'esbuild';
import { readFileSync, existsSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { erploraResolvePlugin, ionicFromToolkitPlugin } from './resolve-plugin.mjs';
import { buildOutfitkitSpec, fetchOutfitkit, npmOutfitkitVersion } from './outfitkit-ci.mjs';
import { resolvedOutfitkitVersion } from './dist-reproducible.mjs';
import { declaredColumnTypes, parenBody, topLevelParts } from './validate-filter-ops.mjs';
import { querySql, selectOutputs, sourceTables } from './validate-dead-filters.mjs';
import { migrationFiles } from './validate-migrations.mjs';
import { splitStatements, stripComments } from './validate-migration-guard.mjs';
import {
  createBuildStatus,
  buildStatusPlugin,
  servesErrorOverlay,
  overlayScript,
} from './dev-build-status.mjs';

// Ionic: componentes registrados en el preview (en el Hub real los provee el shell).
const IONIC = [
  'app', 'content', 'header', 'toolbar', 'title', 'buttons', 'button', 'icon', 'input', 'textarea',
  'select', 'select-option', 'checkbox', 'toggle', 'item', 'label', 'list', 'list-header', 'note',
  'chip', 'badge', 'card', 'card-content', 'card-header', 'card-title', 'card-subtitle', 'spinner',
  'searchbar', 'segment', 'segment-button', 'footer', 'modal', 'popover', 'datetime', 'range',
  'radio', 'radio-group', 'grid', 'row', 'col', 'alert',
];

const TSCONFIG_RAW = { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } };

export function collectTs(p, out = []) {
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(p, name);
    if (statSync(full).isDirectory()) collectTs(full, out);
    // Solo producción: los tests colocados junto al componente (TDD) arrastran vitest al
    // harness y matan el preview en blanco — mismo bug que resolveEntry (build.mjs, 07-13).
    else if (
      extname(full) === '.ts' &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.spec.ts')
    ) out.push(full);
  }
  return out;
}

function loadFixtures(dir, into) {
  const fdir = join(dir, 'fixtures');
  if (!existsSync(fdir)) return;
  for (const f of readdirSync(fdir)) {
    if (!f.endsWith('.json')) continue;
    try {
      into[f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(fdir, f), 'utf8'));
    } catch {
      /* ignora json inválido */
    }
  }
}

/**
 * `column -> Set<declared type>` over the module's postgres migrations, STATEMENT by statement:
 * `declaredColumnTypes` keeps the first declaration of a column per text, and two tables of the same
 * migration declaring \`code\` as TEXT and as INTEGER must both be seen to be left out. The split is
 * `splitStatements`', which leaves a \`;\` inside a comment, a literal or a \`$$\` body alone.
 */
function declaredTypesByColumn(dir, manifest) {
  const types = new Map();
  for (const rel of migrationFiles(manifest, 'postgres')) {
    let sql;
    try {
      sql = readFileSync(join(dir, rel), 'utf8');
    } catch {
      continue; // a missing migration is validate's finding, not the preview's
    }
    for (const statement of splitStatements(sql)) {
      for (const [col, type] of declaredColumnTypes(statement)) {
        if (!types.has(col)) types.set(col, new Set());
        types.get(col).add(type);
      }
    }
  }
  return types;
}

/** The kind of value the preview invents for a declared SQL type, or null when it cannot tell. */
function columnKind(type) {
  const base = String(type).replace(/"/g, '').trim().split(/[\s(]/)[0].toUpperCase();
  if (/^(TEXT|VARCHAR|CHAR|CHARACTER|CITEXT|UUID)$/.test(base)) return 'text';
  if (/^(INTEGER|INT|INT2|INT4|INT8|SMALLINT|BIGINT|SERIAL|SMALLSERIAL|BIGSERIAL)$/.test(base)) return 'integer';
  if (/^(NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT|FLOAT4|FLOAT8)$/.test(base)) return 'decimal';
  if (/^(BOOLEAN|BOOL)$/.test(base)) return 'boolean';
  if (base === 'DATE') return 'date';
  if (/^TIMESTAMPTZ?$/.test(base)) return 'timestamp';
  return null;
}

/**
 * `query -> column -> kind` for the columns of every `list` query of the module, read from the types
 * its postgres migrations DECLARE (module-toolkit#431). The invented rows used to guess the type from
 * the column NAME, and /num/ made `tables`' TEXT table number a number: the floor plan died in the
 * preview on `(label ?? '').replace` while working in every real hub. A column no migration declares
 * (a query alias), or that two tables declare with different kinds, is left out: `synth` falls back
 * to its name for it.
 */
export function listColumnKinds(dir, manifest) {
  const types = declaredTypesByColumn(dir, manifest);
  const out = {};
  for (const [name, query] of Object.entries(manifest?.queries || {})) {
    const cfg = query && query.list;
    if (!cfg) continue;
    const kinds = {};
    for (const col of new Set([...(cfg.search || []), ...(cfg.sort || [])])) {
      if (col === 'id') continue; // synth always invents the id itself
      const declared = types.get(String(col).toLowerCase());
      if (!declared) continue;
      const found = new Set([...declared].map(columnKind));
      if (found.size === 1 && !found.has(null)) kinds[col] = [...found][0];
    }
    if (Object.keys(kinds).length) out[name] = kinds;
  }
  return out;
}

/** A quoted SQL literal, `''` escapes included. */
const SQL_LITERAL = String.raw`'(?:[^']|'')*'`;
const unquote = (literal) => literal.slice(1, -1).replace(/''/g, "'");
const sqlName = (name) => name.replace(/"/g, '').split('.').pop().toLowerCase();

/** `text` with every literal body blanked (same length), so words and parentheses inside it are not SQL. */
const blankLiterals = (text) => text.replace(new RegExp(SQL_LITERAL, 'g'), (l) => "'" + ' '.repeat(l.length - 2) + "'");

/**
 * Every `col IN ('a', 'b')` a `CHECK` in `text` imposes: `{ lists: [{ column, values }], words }`, or
 * null when `text` has no CHECK. Only a conjunct at the top level of the CHECK counts — services writes
 * `CHECK (discount_type IN (...) AND discount_percent >= 0 …)` — and a CHECK with a top-level OR imposes
 * none of its lists on every row. `words` are the names the CHECK reads at any depth: Postgres names an
 * unnamed CHECK after the one column it reads, whatever else it says.
 */
function checkLists(text) {
  const at = /\bCHECK\s*\(/i.exec(blankLiterals(text));
  const body = at && parenBody(text, at.index);
  if (body == null) return null;
  const code = blankLiterals(body);
  const words = (code.match(/"?\b[A-Za-z_]\w*\b"?/g) || []).map(sqlName);
  let depth = 0;
  const cuts = [];
  for (let i = 0; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') depth -= 1;
    else if (depth === 0 && /\w/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
      const word = /^\w+/.exec(code.slice(i))[0].toUpperCase();
      if (word === 'OR') return { lists: [], words };
      if (word === 'AND') cuts.push(i);
    }
  }
  const out = [];
  let from = 0;
  for (const cut of [...cuts, body.length]) {
    const conjunct = body.slice(from, cut).trim();
    from = cut + 3;
    const m = new RegExp(String.raw`^"?(\w+)"?\s+IN\s*\(\s*(${SQL_LITERAL}(?:\s*,\s*${SQL_LITERAL})*)\s*\)$`, 'is').exec(conjunct);
    if (m) out.push({ column: m[1].toLowerCase(), values: [...m[2].matchAll(new RegExp(SQL_LITERAL, 'g'))].map((v) => unquote(v[0])) });
  }
  return { lists: out, words };
}

/** The value of a `DEFAULT '<literal>'` that is only that literal (not `'a' || b`), or null. */
function defaultLiteral(text) {
  const m = new RegExp(String.raw`\bDEFAULT\s+(${SQL_LITERAL})(?:\s*::\s*\w+)?\s*(.*)$`, 'is').exec(text);
  if (!m || !/^(?:$|(?:NOT|NULL|CHECK|CONSTRAINT|REFERENCES|UNIQUE|PRIMARY|COLLATE)\b)/i.test(m[2])) return null;
  return unquote(m[1]);
}

/**
 * `table -> column -> { type, def, checks: Map<constraint name, values> }` over the module's postgres
 * migrations, in the order they run, so a later `ALTER` wins: `ADD COLUMN`, `ADD`/`DROP CONSTRAINT`,
 * `ALTER COLUMN SET`/`DROP DEFAULT`, `DROP COLUMN`. Unlike `declaredTypesByColumn` it is keyed by
 * TABLE: in `tables` three tables declare `status`, each with its own values (module-toolkit#440).
 * An unnamed CHECK gets the name Postgres gives it — `<table>_<column>_check` when it reads one
 * column, `<table>_check` otherwise, plus a number when taken, a CHECK with no list included — so a
 * later `DROP CONSTRAINT` finds it.
 */
function declaredValuesByTable(dir, manifest) {
  const tables = new Map();
  const table = (name) => {
    const key = sqlName(name);
    if (!tables.has(key)) tables.set(key, new Map());
    return tables.get(key);
  };
  const checkNames = new Map(); // table -> the CHECK names it holds, with a list or not
  const namesOf = (tableName) => {
    const key = sqlName(tableName);
    if (!checkNames.has(key)) checkNames.set(key, new Set());
    return checkNames.get(key);
  };
  const addCheck = (t, tableName, text, name) => {
    const check = checkLists(text);
    if (!check) return;
    const taken = namesOf(tableName);
    let key = name ? sqlName(name) : null;
    if (!key) {
      const read = new Set([...check.lists.map((l) => l.column), ...check.words.filter((w) => t.has(w))]);
      const base = `${sqlName(tableName)}${read.size === 1 ? '_' + [...read][0] : ''}_check`;
      key = base;
      for (let n = 1; taken.has(key); n += 1) key = base + n;
    }
    taken.add(key);
    for (const list of check.lists) t.get(list.column)?.checks.set(key, list.values);
  };
  const addColumn = (t, tableName, part) => {
    const [name, ...rest] = part.split(/\s+/);
    const spec = rest.join(' ');
    t.set(sqlName(name), { type: spec, def: defaultLiteral(spec), checks: new Map() });
    // An inline CHECK may constrain another column of the table: Postgres takes it, named after that one.
    addCheck(t, tableName, spec, /\bCONSTRAINT\s+"?(\w+)"?\s+CHECK\b/i.exec(spec)?.[1]);
  };

  for (const rel of migrationFiles(manifest, 'postgres')) {
    let sql;
    try {
      sql = readFileSync(join(dir, rel), 'utf8');
    } catch {
      continue; // a missing migration is validate's finding, not the preview's
    }
    for (const raw of splitStatements(sql)) {
      const statement = stripComments(raw).trim();
      const create = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(statement);
      if (create) {
        const t = table(create[1]);
        for (const part of topLevelParts(parenBody(statement, create[0].length) ?? '')) {
          const named = /^CONSTRAINT\s+"?(\w+)"?\s+(CHECK\b.*)$/is.exec(part);
          if (named) addCheck(t, create[1], named[2], named[1]);
          else if (/^CHECK\b/i.test(part)) addCheck(t, create[1], part, null);
          else if (!/^(PRIMARY|FOREIGN|UNIQUE|CONSTRAINT|EXCLUDE|LIKE)\b/i.test(part)) addColumn(t, create[1], part);
        }
        continue;
      }
      const alter = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?("?[\w.]+"?)\s+/i.exec(statement);
      if (!alter) continue;
      const t = table(alter[1]);
      for (const action of topLevelParts(statement.slice(alter[0].length))) {
        let m;
        if ((m = /^ADD\s+CONSTRAINT\s+"?(\w+)"?\s+(CHECK\b.*)$/is.exec(action))) addCheck(t, alter[1], m[2], m[1]);
        else if (/^ADD\s+CHECK\b/i.test(action)) addCheck(t, alter[1], action.replace(/^ADD\s+/i, ''), null);
        else if ((m = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(.*)$/is.exec(action))) addColumn(t, alter[1], m[1]);
        else if ((m = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(action))) {
          namesOf(alter[1]).delete(m[1].toLowerCase());
          for (const col of t.values()) col.checks.delete(m[1].toLowerCase());
        } else if ((m = /^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/i.exec(action))) t.delete(m[1].toLowerCase());
        else if ((m = /^ALTER\s+(?:COLUMN\s+)?"?(\w+)"?\s+(SET\s+DEFAULT\s+.*|DROP\s+DEFAULT\b.*)$/is.exec(action))) {
          const col = t.get(m[1].toLowerCase());
          if (col) col.def = /^SET/i.test(m[2]) ? defaultLiteral(m[2].replace(/^SET\s+/i, '')) : null;
        }
      }
    }
  }
  return tables;
}

/**
 * The values the module declares for a TEXT column: what every CHECK on it allows (their
 * intersection), its DEFAULT first; or the DEFAULT alone when no CHECK lists a value.
 */
function declaredValues(col) {
  if (columnKind(col.type) !== 'text') return null;
  const def = col.def === '' ? null : col.def;
  const [first, ...rest] = [...col.checks.values()];
  const check = first && first.filter((v) => rest.every((other) => other.includes(v)));
  if (check && check.length) return def != null && check.includes(def) ? [def, ...check.filter((v) => v !== def)] : check;
  return def != null ? [def] : null;
}

/**
 * `query -> column -> [values]` for the TEXT columns of every `list` query whose values the module
 * declares — `CHECK (col IN (...))` and a literal `DEFAULT` — read on the table the query takes the
 * column FROM (module-toolkit#440). The invented rows wrote "<Word> status" instead: `tables` drew
 * every table as «Alfa status», its unknown-status branch, and the preview never showed a free or an
 * occupied table. A column whose source cannot be told (an expression, two joined tables declaring
 * it without a qualifier, a query that is not one readable statement) or with no values is left
 * out: `synth` invents it as before. An empty DEFAULT is no value — `name TEXT DEFAULT ''` would
 * blank every name.
 */
export function listColumnValues(dir, manifest) {
  const declared = declaredValuesByTable(dir, manifest);
  const out = {};
  for (const [name, query] of Object.entries(manifest?.queries || {})) {
    const cfg = query && query.list;
    if (!cfg) continue;
    const sql = querySql(dir, query.sql);
    if (sql == null) continue;
    const sources = sourceTables(sql);
    const { star, map } = selectOutputs(sql);
    const values = {};
    for (const col of new Set([...(cfg.search || []), ...(cfg.sort || [])])) {
      if (col === 'id') continue;
      let ref = map.get(col);
      if (ref === null) continue; // an expression, not a column
      if (ref === undefined) {
        if (!star) continue;
        ref = { qualifier: null, column: col };
      }
      const from = ref.qualifier ? [sources.get(ref.qualifier.toLowerCase())].filter(Boolean) : [...new Set(sources.values())];
      const found = from.map((t) => declared.get(t)?.get(String(ref.column).toLowerCase())).filter(Boolean);
      if (found.length !== 1) continue;
      const v = declaredValues(found[0]);
      if (v) values[col] = v;
    }
    if (Object.keys(values).length) out[name] = values;
  }
  return out;
}

// Reúne los módulos a cargar. Con `single` activo, solo ese; si no, todos los del workspace.
function collectModules(rootDir, single) {
  const mods = [];
  const modDirs = [];
  const fixtures = {};
  const wcFiles = [];
  const columnKinds = {};
  const columnValues = {};
  const dirs = single
    ? [single]
    : readdirSync(rootDir)
        .map((n) => join(rootDir, n))
        .filter((d) => statSync(d).isDirectory() && existsSync(join(d, 'module.json')))
        .sort();
  for (const dir of dirs) {
    const compDir = join(dir, 'ui', 'components');
    const ts = existsSync(compDir) ? collectTs(compDir) : [];
    if (!ts.length) continue; // módulos sin UI no se montan en el preview
    const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
    mods.push(manifest);
    modDirs.push(dir);
    wcFiles.push(...ts);
    loadFixtures(dir, fixtures);
    Object.assign(columnKinds, listColumnKinds(dir, manifest));
    Object.assign(columnValues, listColumnValues(dir, manifest));
  }
  return { mods, modDirs, fixtures, wcFiles, columnKinds, columnValues };
}

// A preview that runs offline is still useful — it publishes nothing — so these two fall back to the
// local copy, loudly. `build` refuses on them instead: there, the local copy is the bug (#423).
const NPM_OUTFITKIT_FAILURES = new Set(['outfitkit_unresolvable', 'outfitkit_unavailable']);

/**
 * The OutfitKit the preview bundles: the one `erplora build` bakes (module-toolkit#426) — npm's,
 * by the rule of `buildOutfitkitSpec` and from the same per-version cache — never the toolkit's
 * own copy, which on a laptop is the shared `outfitkit/` checkout (0.1.79 while build baked 0.1.126).
 *
 * One bundle holds one OutfitKit: when the previewed modules ask for different ones it takes npm
 * `latest` and says so. Returns `{ version, prefix, source: 'npm'|'local', warnings }`; `prefix` is
 * what `erploraResolvePlugin` resolves OutfitKit from (undefined = the toolkit's copy).
 */
export function devOutfitkit(moduleDirs, { env = process.env } = {}) {
  const warnings = [];
  const specs = moduleDirs.map((dir) => ({ dir, spec: buildOutfitkitSpec(dir) }));
  const distinct = [...new Set(specs.map((s) => s.spec))];
  const spec = distinct.length === 1 ? distinct[0] : 'latest';
  if (distinct.length > 1) {
    warnings.push(
      `outfitkit_specs_differ: ${specs.map((s) => `${basename(s.dir)} asks for ${s.spec}`).join(', ')} — ` +
        'one preview bundles one OutfitKit, so this one paints with npm latest; build bakes each ' +
        "module's own (`erplora dev <module>` previews exactly that)",
    );
  }
  try {
    const version = npmOutfitkitVersion(spec, { env });
    return { version, prefix: fetchOutfitkit(version, { env }), source: 'npm', warnings };
  } catch (err) {
    if (!NPM_OUTFITKIT_FAILURES.has(err.code)) throw err;
    const version = resolvedOutfitkitVersion() ?? 'unknown';
    warnings.push(
      `${err.message} — previewing with this machine's OutfitKit ${version} instead; build bakes ` +
        "npm's, so the hub may not get what this preview shows",
    );
    return { version, prefix: undefined, source: 'local', warnings };
  }
}

/** What the preview header says it paints with. */
export function outfitkitLabel({ version, source }) {
  return `OutfitKit ${version}${source === 'local' ? ' · local' : ''}`;
}

// Exportada para test (module-toolkit#133): la fuente generada es lo que corre en el navegador, y
// la única forma honesta de probar que el preview resuelve `emit` en sus dos formas
// (ERPlora/hub#1076) es ejecutar ESTE texto, no una reimplementación en el test.
export function harnessEntry(manifests, fixtures, wcFiles, preselect, okLabel = null, columnKinds = {}, columnValues = {}) {
  const ionicImports = IONIC.map(
    (c, i) => `import { defineCustomElement as i${i} } from '@ionic/core/components/ion-${c}.js';`,
  ).join('\n');
  const ionicDefines = `[${IONIC.map((_, i) => `i${i}`).join(',')}].forEach((d) => { try { d(); } catch {} });`;
  const wcImports = wcFiles.map((f) => `import ${JSON.stringify(f)};`).join('\n');

  return `${ionicImports}
import { initialize } from '@ionic/core/components';
import '@ionic/core/css/core.css';
import '@ionic/core/css/normalize.css';
import '@ionic/core/css/structure.css';
import '@ionic/core/css/typography.css';
import '@ionic/core/css/padding.css';
import { addIcons } from 'ionicons';
import * as __ICONS from 'ionicons/icons';
// Inicializa Ionic (config global + mode) para que los componentes adopten su display/estilo.
initialize({ mode: 'md' });
${ionicDefines}
// Registra TODAS las ionicons inline (sin fetch -> CSP-safe). Por nombre camelCase y kebab-case.
{ const im = {}; for (const [k, v] of Object.entries(__ICONS)) { if (typeof v === 'string') { im[k] = v; im[k.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()] = v; } } addIcons(im); }
${wcImports}

const MODULES = ${JSON.stringify(manifests)};
const FIXTURES = ${JSON.stringify(fixtures)};
const PRESELECT = ${JSON.stringify(preselect || null)};
const OUTFITKIT_LABEL = ${JSON.stringify(okLabel)};
// \`query -> column -> kind\` the module's migrations declare (module-toolkit#431, listColumnKinds).
const COLUMN_KINDS = ${JSON.stringify(columnKinds || {})};
// \`query -> column -> [values]\` the module declares (CHECK/DEFAULT, module-toolkit#440, listColumnValues).
const COLUMN_VALUES = ${JSON.stringify(columnValues || {})};

// ── Cliente mock (transport en memoria) ─────────────────────────────────────────────────────
const listeners = new Map();
function emit(event, payload) { (listeners.get(event) || []).forEach((cb) => { try { cb(payload); } catch {} }); }
// Nombre de un entry de \`emit\`, en cualquiera de sus dos formas (ERPlora/hub#1076,
// ERPlora/module-toolkit#133): el string plano de siempre, o \`{event, dedup_key}\`.
function emitName(e) { return typeof e === 'string' ? e : e.event; }
const QByName = {};
const CByName = {};
for (const m of MODULES) { Object.assign(QByName, m.queries || {}); Object.assign(CByName, m.commands || {}); }

// module-toolkit#431: the kind the module DECLARES wins. The name is only the fallback for a column
// no migration declares (a query alias), and there /num/ no longer means "number": \`number\` is the
// TEXT table number of \`tables\` and \`number_sort\` its text sort key.
const NUMBER_NAME = /price|amount|total|cost|stock|qty|quantity|count/i;
const FLAG_NAME = /^is_|active|enabled|paid/i;
function synthValue(c, kind, i, word, first) {
  const day = '2026-01-' + String((i % 28) + 1).padStart(2, '0');
  if (kind === 'date') return day;
  if (kind === 'timestamp') return day + 'T10:00:00Z';
  if (kind === 'boolean') return i % 2 === 0;
  if (kind === 'decimal') return Math.round((i + 1) * 12.5 * 100) / 100;
  // ADR-0007: flags are 0/1 INTEGER columns, so an integer with a flag's name stays a flag.
  if (kind === 'integer') return FLAG_NAME.test(c) && !NUMBER_NAME.test(c) ? i % 2 : i + 1;
  if (/_at$/.test(c)) return day + 'T10:00:00Z'; // dates are ISO TEXT (ADR-0007)
  // A reference points at a row the preview invents too (every invented list is row-1 … row-12), three
  // children per parent: a TEXT \`zone_id\` of "Alfa zone_id" left the floor plan of every zone empty.
  if (/_id$/.test(c)) return 'row-' + ((i % 3) + 1);
  if (kind == null && NUMBER_NAME.test(c)) return Math.round((i + 1) * 12.5 * 100) / 100;
  if (kind == null && FLAG_NAME.test(c)) return i % 2;
  return word + (c === first ? '' : ' ' + c);
}
function synth(name) {
  const cfg = (QByName[name] && QByName[name].list) || {};
  const kinds = COLUMN_KINDS[name] || {};
  const values = COLUMN_VALUES[name] || {};
  const cols = [...new Set([...(cfg.search || []), ...(cfg.sort || [])])].filter((c) => c !== 'id');
  const words = ['Alfa','Bravo','Charlie','Delta','Echo','Foxtrot','Golf','Hotel','India','Juliet','Kilo','Lima'];
  return words.map((w, i) => {
    const row = { id: 'row-' + (i + 1) };
    // module-toolkit#440: a value the module declares beats any invented one — row 1 the first, row 2 the second…
    for (const c of cols) row[c] = values[c] ? values[c][i % values[c].length] : synthValue(c, kinds[c], i, w, (cfg.search || [])[0]);
    return row;
  });
}
function rowsFor(name) {
  if (FIXTURES[name]) return FIXTURES[name];
  const k = Object.keys(FIXTURES).find((x) => x === name || x.endsWith(name));
  if (k) return FIXTURES[k];
  return synth(name);
}
function applyList(rows, p, name) {
  let r = [...rows];
  const cfg = (QByName[name] && QByName[name].list) || {};
  if (p.search) {
    const s = String(p.search).toLowerCase();
    const fields = cfg.search || Object.keys(r[0] || {});
    r = r.filter((row) => fields.some((f) => String(row[f] ?? '').toLowerCase().includes(s)));
  }
  for (const [col, val] of Object.entries(p.filters || {})) {
    if (val == null || val === '') continue;
    if (typeof val === 'object' && ('from' in val || 'to' in val)) {
      if (val.from != null && val.from !== '') r = r.filter((row) => Number(row[col]) >= Number(val.from));
      if (val.to != null && val.to !== '') r = r.filter((row) => Number(row[col]) <= Number(val.to));
    } else r = r.filter((row) => String(row[col]) === String(val));
  }
  if (p.sort) {
    const dir = p.dir === 'desc' ? -1 : 1;
    r.sort((a, b) => {
      const x = a[p.sort], y = b[p.sort], n = Number(x), m = Number(y);
      if (!Number.isNaN(n) && !Number.isNaN(m)) return (n - m) * dir;
      return String(x).localeCompare(String(y)) * dir;
    });
  }
  return r;
}
globalThis.erplora = {
  async queryPage(name, params) {
    const filtered = applyList(rowsFor(name), params, name);
    const offset = params.offset || 0, limit = params.limit || 50;
    return { rows: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset };
  },
  async query(name, params) {
    const r = rowsFor(name);
    if (Array.isArray(r)) return params && params.id ? r.find((x) => x.id === params.id) || r[0] : r;
    return r;
  },
  async command(name, payload) {
    ((CByName[name] || {}).emit || []).forEach((ev) => emit(emitName(ev), payload));
    return { ok: true, id: 'new-' + Math.floor(performance.now()) };
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(cb);
    return () => { const a = listeners.get(event); const i = a.indexOf(cb); if (i >= 0) a.splice(i, 1); };
  },
  // ── Superficie del ErploraClient real que los WC consumen (paridad con el SDK) ──
  // Sin esto, cualquier componente que use i18n o dinero muere en render dentro del
  // preview (t is not a function) y la página queda vacía con el error solo en consola.
  locale: 'es',
  currency: 'EUR',
  /** i18n del módulo (ADR-0055): idioma activo con fallback a en → clave pelada. */
  t(catalog, key, params) {
    const path = key.split('.');
    const dig = (o) => path.reduce((a, k) => (a && typeof a === 'object' ? a[k] : undefined), o);
    let v = dig((catalog || {})[this.locale]) ?? dig((catalog || {}).en) ?? key;
    if (params && typeof v === 'string') for (const [k, val] of Object.entries(params)) v = v.replaceAll('{' + k + '}', String(val));
    return v;
  },
  /** Dinero (ADR-0007/0123): formatMoney recibe CÉNTIMOS y divide; formatAmount unidades. */
  formatMoney(cents, opts) {
    const cur = (opts && opts.currency) || this.currency;
    return new Intl.NumberFormat((opts && opts.locale) || 'es-ES', { style: 'currency', currency: cur }).format((Number(cents) || 0) / 100);
  },
  formatAmount(units, opts) {
    const cur = (opts && opts.currency) || this.currency;
    return new Intl.NumberFormat((opts && opts.locale) || 'es-ES', { style: 'currency', currency: cur }).format(Number(units) || 0);
  },
  /** TODAS las filas (ADR-0124): el preview no pagina fixtures. */
  async queryAll(name, params) {
    const r = rowsFor(name);
    return Array.isArray(r) ? applyList(r, params || {}, name) : [];
  },
  /** Slots cross-módulo (ADR-0043): el preview no compone módulos → vacío. */
  async loadSlot() { return []; },
};

// ── Shell (layout CSS robusto + componentes Ionic) ────────────────────────────────────────────
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v != null) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

let current = null;

window.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('app');

  const title = el('ion-title', { text: 'Inicio' });
  const view = el('ion-content', { id: 'tk-view', class: 'tk-content' });
  const seg = el('ion-segment', { id: 'tk-seg', scrollable: 'true' });
  const footer = el('ion-footer', { id: 'tk-footer', class: 'ion-no-border', style: 'display:none' },
    el('ion-toolbar', { class: 'ion-no-border' }, seg));
  seg.addEventListener('ionChange', (e) => showView(e.detail.value));

  // Sidebar: contenedor flex (layout) con ion-list/ion-item Ionic dentro.
  // module-toolkit#434: on phone and tablet the sidebar is a drawer, so picking an entry closes it.
  const sideList = el('ion-list', { lines: 'none' },
    el('ion-item', { button: 'true', detail: 'false', onclick: () => { openHome(); toggleMenu(false); } }, el('ion-label', { text: 'Inicio' })),
    el('ion-list-header', {}, el('ion-label', { text: 'Módulos' })),
    ...MODULES.map((m) =>
      el('ion-item', { button: 'true', detail: 'false', onclick: () => { openModule(m.id); toggleMenu(false); } }, el('ion-label', { text: m.name || m.id }))),
  );
  const sidebar = el('aside', { class: 'tk-sidebar' },
    el('div', { class: 'tk-brand' }, 'ERPlora · módulos', el('div', { class: 'tk-brand-sub', text: 'dev preview' }),
      // module-toolkit#426: the OutfitKit this preview paints with (the one build bakes, or the local copy).
      ...(OUTFITKIT_LABEL ? [el('div', { class: 'tk-brand-sub', text: OUTFITKIT_LABEL })] : [])),
    el('div', { class: 'tk-side-scroll' }, sideList));

  // Header Ionic con botón inspector (abre el drawer derecho).
  const inspBtn = el('ion-button', { fill: 'clear', onclick: () => toggleOverlay() }, el('ion-icon', { name: 'information-circle-outline', slot: 'icon-only' }));
  // Menu button (module-toolkit#434): only shown below the hub's split-pane breakpoint (CSS).
  const menuBtn = el('ion-button', { fill: 'clear', class: 'tk-menu-btn', 'aria-label': 'Menú', onclick: () => toggleMenu() }, el('ion-icon', { name: 'menu-outline', slot: 'icon-only' }));
  const header = el('ion-header', {}, el('ion-toolbar', {}, el('ion-buttons', { slot: 'start' }, menuBtn), title, el('ion-buttons', { slot: 'end' }, inspBtn)));
  const main = el('div', { class: 'tk-main' }, header, view, footer);

  // Drawer derecho (inspector): panel CSS con contenido Ionic (ion-header + ion-list).
  // One scrim for both drawers: the inspector (right) and, on phone and tablet, the sidebar (left).
  const scrim = el('div', { class: 'tk-scrim', onclick: () => { toggleOverlay(false); toggleMenu(false); } });
  const inspList = el('ion-list', {});
  const inspector = el('aside', { class: 'tk-overlay' },
    el('ion-header', {}, el('ion-toolbar', {},
      el('ion-title', { text: 'Inspector' }),
      el('ion-buttons', { slot: 'end' }, el('ion-button', { fill: 'clear', onclick: () => toggleOverlay(false) }, el('ion-icon', { name: 'close', slot: 'icon-only' }))))),
    el('ion-content', { class: 'ion-padding' }, inspList));

  root.appendChild(el('ion-app', {}, el('div', { class: 'tk-layout' }, sidebar, main), scrim, inspector));

  function showView(comp) {
    view.innerHTML = '';
    view.classList.add('tk-fixed'); // ion-content no scrollea en vista de módulo
    // Wrapper que llena el alto de ion-content: la tabla en modo fill hace scroll interno.
    if (comp) view.appendChild(el('div', { class: 'tk-view-fill' }, document.createElement(comp)));
  }
  window.__showView = showView;

  function openHome() {
    current = null;
    title.textContent = 'Inicio';
    footer.style.display = 'none';
    inspList.innerHTML = '';
    view.innerHTML = '';
    view.classList.remove('tk-fixed'); // el launcher sí scrollea (grid de módulos)
    const grid = el('div', { class: 'tk-grid' });
    for (const m of MODULES) {
      const navs = (m.navigation || []).length;
      const q = Object.keys(m.queries || {}).length, c = Object.keys(m.commands || {}).length;
      grid.appendChild(
        el('ion-card', { button: 'true', class: 'tk-card', onclick: () => openModule(m.id) },
          el('ion-card-header', {},
            el('ion-card-title', { text: m.name || m.id }),
            el('ion-card-subtitle', { text: \`\${navs} vista(s) · \${q} queries · \${c} commands\` })),
          el('ion-card-content', { text: m.id })),
      );
    }
    view.appendChild(el('div', { class: 'ion-padding' },
      el('h2', { class: 'tk-h2', text: 'Módulos registrados' }),
      el('p', { class: 'tk-sub', text: \`\${MODULES.length} módulo(s) en el workspace. Pulsa uno para cargarlo.\` }),
      grid));
  }
  window.__openHome = openHome;

  function openModule(id) {
    const m = MODULES.find((x) => x.id === id);
    if (!m) return;
    current = m;
    title.textContent = m.name || m.id;
    seg.innerHTML = '';
    const navs = m.navigation || [];
    navs.forEach((n) => {
      // Tab estilo IonTabs del Hub: icono (ionicon del manifest) + label.
      const kids = [];
      if (n.icon) kids.push(el('ion-icon', { name: n.icon }));
      kids.push(el('ion-label', { text: n.label || n.component }));
      seg.appendChild(el('ion-segment-button', { value: n.component }, kids));
    });
    footer.style.display = navs.length ? 'block' : 'none';
    if (navs.length) { seg.value = navs[0].component; showView(navs[0].component); }
    else view.innerHTML = '<div class="ion-padding tk-sub">Este módulo no tiene navegación de UI.</div>';
    renderInspector(m);
  }
  window.__openModule = openModule;

  function renderInspector(m) {
    inspList.innerHTML = '';
    const sec = (titleStr, items) => {
      inspList.appendChild(el('ion-list-header', {}, el('ion-label', { text: titleStr })));
      if (!items.length) inspList.appendChild(el('ion-item', {}, el('ion-label', { class: 'tk-mono', text: '—' })));
      for (const t of items) inspList.appendChild(el('ion-item', {}, el('ion-label', { class: 'tk-mono', text: t })));
    };
    sec('Queries', Object.keys(m.queries || {}));
    sec('Commands', Object.keys(m.commands || {}));
    sec('Permisos', m.permissions || []);
    sec('Eventos (emit)', [...new Set(Object.values(m.commands || {}).flatMap((c) => c.emit || []).map(emitName))]);
  }

  function toggleOverlay(force) {
    const open = force != null ? force : !document.body.classList.contains('tk-overlay-open');
    document.body.classList.toggle('tk-overlay-open', open);
  }
  function toggleMenu(force) {
    const open = force != null ? force : !document.body.classList.contains('tk-menu-open');
    document.body.classList.toggle('tk-menu-open', open);
  }
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggleOverlay(false); toggleMenu(false); } });

  // Arranque: módulo preseleccionado o página main.
  if (PRESELECT && MODULES.some((m) => m.id === PRESELECT)) openModule(PRESELECT);
  else openHome();
});
`;
}

export const INDEX_HTML = (label) => `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>erplora dev · ${label}</title>
  <link rel="stylesheet" href="/harness.css" />
  <style>
    /* Paleta Ionic por defecto (light) — sin ella ion-toggle/ion-button no tienen color (success=verde, danger=rojo…). */
    :root {
      --ion-color-primary:#3880ff; --ion-color-primary-rgb:56,128,255; --ion-color-primary-contrast:#fff; --ion-color-primary-contrast-rgb:255,255,255; --ion-color-primary-shade:#3171e0; --ion-color-primary-tint:#4c8dff;
      --ion-color-success:#2dd36f; --ion-color-success-rgb:45,211,111; --ion-color-success-contrast:#fff; --ion-color-success-contrast-rgb:255,255,255; --ion-color-success-shade:#28ba62; --ion-color-success-tint:#42d77d;
      --ion-color-warning:#ffc409; --ion-color-warning-rgb:255,196,9; --ion-color-warning-contrast:#000; --ion-color-warning-contrast-rgb:0,0,0; --ion-color-warning-shade:#e0ac08; --ion-color-warning-tint:#ffca22;
      --ion-color-danger:#eb445a; --ion-color-danger-rgb:235,68,90; --ion-color-danger-contrast:#fff; --ion-color-danger-contrast-rgb:255,255,255; --ion-color-danger-shade:#cf3c4f; --ion-color-danger-tint:#ed576b;
      --ion-color-medium:#92949c; --ion-color-medium-rgb:146,148,156; --ion-color-medium-contrast:#fff; --ion-color-medium-contrast-rgb:255,255,255; --ion-color-medium-shade:#808289; --ion-color-medium-tint:#9d9fa6;
      --ion-color-light:#f4f5f8; --ion-color-light-rgb:244,245,248; --ion-color-light-contrast:#000; --ion-color-light-contrast-rgb:0,0,0; --ion-color-light-shade:#d7d8da; --ion-color-light-tint:#f5f6f9;
      --ion-text-color:#1c1b18; --ion-text-color-rgb:28,27,24; --ion-background-color:#fff; --ion-background-color-rgb:255,255,255;
    }
    :root { --tk-bg:#faf8f2; --tk-surface:#fff; --tk-border:#e6e2d8; --tk-text:#1c1b18; --tk-muted:#6b6557; }
    html, body { margin:0; height:100%; background:var(--tk-bg); color:var(--tk-text); font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
    #app, ion-app { height:100%; display:block; }
    .tk-layout { display:flex; height:100%; }
    .tk-sidebar { width:240px; flex:0 0 240px; background:var(--tk-surface); border-right:1px solid var(--tk-border); display:flex; flex-direction:column; min-height:0; }
    .tk-brand { padding:1rem; font-weight:700; border-bottom:1px solid var(--tk-border); }
    .tk-brand-sub { font-size:11px; font-weight:500; color:var(--tk-muted); text-transform:uppercase; letter-spacing:.06em; margin-top:2px; }
    .tk-side-scroll { flex:1; overflow:auto; }
    .tk-main { flex:1; min-width:0; display:flex; flex-direction:column; }
    .tk-content { flex:1; --background:var(--tk-bg); }
    /* En vista de módulo, ion-content no scrollea: la tabla (modo fill) hace scroll interno. */
    .tk-content.tk-fixed { --overflow:hidden; }
    .tk-view-fill { height:100%; box-sizing:border-box; padding:1rem; display:flex; flex-direction:column; min-height:0; }
    .tk-view-fill > * { flex:1 1 auto; min-height:0; }
    /* Tabs inferiores = métrica de IonTabs del Hub (icono + label compactos, sin uppercase). */
    ion-footer ion-segment-button { font-size:12px; font-weight:400; letter-spacing:.03em; text-transform:none; min-height:54px; }
    ion-footer ion-segment-button ion-icon { font-size:22px; }
    .tk-h2 { margin:0 0 .25rem; font-size:1.25rem; }
    .tk-sub { color:var(--tk-muted); margin:.25rem 0 1rem; font-size:14px; }
    .tk-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(230px,1fr)); gap:.75rem; }
    .tk-card { margin:0; cursor:pointer; }
    .tk-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
    /* Drawer derecho */
    .tk-scrim { position:fixed; inset:0; background:rgba(0,0,0,.32); opacity:0; pointer-events:none; transition:.18s; z-index:50; }
    .tk-overlay { position:fixed; top:0; right:0; height:100%; width:360px; max-width:88vw; background:var(--tk-surface); border-left:1px solid var(--tk-border); box-shadow:-8px 0 24px rgba(0,0,0,.08); transform:translateX(100%); transition:.2s; z-index:51; display:flex; flex-direction:column; }
    .tk-overlay ion-content { flex:1; }
    body.tk-overlay-open .tk-scrim { opacity:1; pointer-events:auto; }
    body.tk-overlay-open .tk-overlay { transform:translateX(0); }
    /* Phone and tablet (module-toolkit#434): below the hub's split-pane breakpoint (lg, 992px) the
       sidebar folds into a drawer behind the menu button and the module takes the whole width. */
    .tk-menu-btn { display:none; }
    @media (max-width: 991.98px) {
      .tk-menu-btn { display:block; }
      /* Closed = hidden for real: no shadow bleeding in at the left edge and no Tab stops inside. */
      .tk-sidebar { position:fixed; top:0; left:0; height:100%; width:280px; max-width:85vw; transform:translateX(-100%); visibility:hidden; transition:transform .2s, visibility .2s; z-index:51; }
      body.tk-menu-open .tk-sidebar { transform:translateX(0); visibility:visible; box-shadow:8px 0 24px rgba(0,0,0,.08); }
      body.tk-menu-open .tk-scrim { opacity:1; pointer-events:auto; }
    }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/harness.js"></script>
</body>
</html>`;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.map': 'application/json' };

/**
 * Starts the preview and hands back `{ port, close }` once it listens. `port: 0` takes a free one
 * (tests); `dev` below is the CLI's wrapper that stays up until Ctrl-C.
 */
export async function startDev(moduleDir, opts = {}) {
  const port = opts.port ?? 4321;
  const argDir = moduleDir ? resolve(process.cwd(), moduleDir) : null;
  const single = argDir && existsSync(join(argDir, 'module.json')) ? argDir : null;
  const rootDir = single
    ? join(single, '..')
    : existsSync(join(process.cwd(), 'modules'))
      ? join(process.cwd(), 'modules')
      : process.cwd();

  const { mods, modDirs, fixtures, wcFiles, columnKinds, columnValues } = collectModules(rootDir, single);
  if (!mods.length) throw new Error(`No encontré módulos con UI en ${rootDir}`);
  const preselect = single ? JSON.parse(readFileSync(join(single, 'module.json'), 'utf8')).id : null;

  // Resolved once, before the watcher: a new OutfitKit on npm mid-session is picked up on restart.
  // `opts.outfitkit.env` is for tests.
  const outfitkit = devOutfitkit(modDirs, opts.outfitkit);
  for (const w of outfitkit.warnings) console.warn(`⚠ ${w}`);

  // One folder per preview, not per module id: two previews of the same module (a branch and main,
  // side by side) used to share it and serve each other's build (module-toolkit#432).
  const outDir = mkdtempSync(join(tmpdir(), `erplora-dev-${preselect || 'workspace'}-`));

  // Every rebuild has to be VISIBLE (module-toolkit#81). `logLevel: 'silent'` stays — the plugin
  // below prints a better report than esbuild's default and, crucially, also flips `status`, which
  // is what stops the server handing out the stale bundle as if nothing had happened.
  const status = createBuildStatus();
  let firstBuilt;
  const firstBuild = new Promise((r) => { firstBuilt = r; });

  const ctx = await esContext({
    stdin: { contents: harnessEntry(mods, fixtures, wcFiles, preselect, outfitkitLabel(outfitkit), columnKinds, columnValues), resolveDir: rootDir, sourcefile: 'workspace.dev.ts', loader: 'ts' },
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: outDir,
    entryNames: 'harness',
    assetNames: '[name]',
    loader: { '.css': 'css', '.svg': 'dataurl', '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl' },
    tsconfigRaw: TSCONFIG_RAW,
    plugins: [erploraResolvePlugin({ outfitkitPrefix: outfitkit.prefix }), ionicFromToolkitPlugin(), buildStatusPlugin({ status, onFirstBuild: firstBuilt })],
    logLevel: 'silent',
  });
  // ONE startup build, not two. `ctx.watch()` performs its own initial build, so the `ctx.rebuild()`
  // that used to precede it was a duplicate — harmless while everything was silent, but it made the
  // preview announce `✓ recompilado` under its own banner as soon as rebuilds became visible.
  // Waiting on the watcher's build instead keeps the guarantee the explicit rebuild was there for:
  // the server never listens before there is something to serve.
  //
  // A first build that FAILS must not kill the preview either — the plugin has already printed the
  // errors, and coming up anyway is what lets the browser show them and self-heal on the next save
  // (`vite`/`ionic serve`, `shopify app dev`). Before this, the first error exited the process while
  // every later error was swallowed in silence: two opposite treatments of the same fault.
  await ctx.watch();
  await firstBuild;

  const server = createServer(async (req, res) => {
    try {
      const p = (req.url || '/').split('?')[0];
      if (p === '/') { res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Security-Policy': CSP }); return res.end(INDEX_HTML(preselect || 'workspace')); }
      // The bundle on disk is the last one that COMPILED. While the build is broken, serving it is
      // the silent lie of module-toolkit#81 — hand out the error overlay instead, never a 200 with
      // stale code. `no-store` so a fixed build is not hidden behind a cached error page.
      if (servesErrorOverlay(status, p)) {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
        return res.end(overlayScript(status.errors));
      }
      const file = join(outDir, p.replace(/^\/+/, ''));
      if (!file.startsWith(outDir) || !existsSync(file)) { res.writeHead(404, { 'Content-Security-Policy': CSP }); return res.end('not found'); }
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP });
      res.end(data);
    } catch {
      res.writeHead(500).end('error');
    }
  });

  await new Promise((r) => server.listen(port, r));
  const { port: listening } = server.address();
  console.log(`▶ erplora dev → http://localhost:${listening}  (${mods.length} módulo(s)${preselect ? `, abre '${preselect}'` : ', página main'}; CSP estricta, watch)`);
  console.log(`   ${outfitkitLabel(outfitkit)}${outfitkit.source === 'npm' ? ' (npm: the one erplora build bakes)' : ''}`);

  const close = async () => {
    await ctx.dispose();
    await new Promise((r) => server.close(r));
    rmSync(outDir, { recursive: true, force: true });
  };
  return { port: listening, outfitkit, close };
}

export async function dev(moduleDir, opts = {}) {
  const { close } = await startDev(moduleDir, opts);
  console.log('   Ctrl-C para salir.');
  await new Promise(() => {
    const stop = async () => { await close(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
