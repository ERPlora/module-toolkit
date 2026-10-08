// The WORKFLOW.md lint (ERPlora/pm#621).
//
// Every component of ERPlora carries a versioned `WORKFLOW.md`: its functional spec — screens,
// flows, and which flows of OTHER components each flow touches (`Implicados:`). Workers, reviewers
// and QA read it before touching the component.
//
// THE CONTRACT. The grammar is not defined here: it is `architecture/contracts/workflow-contract.md`
// (§5), shared with the second validator, `workflow-index.sh` (awk, ERPlora/pm). Every finding
// carries one of the contract's stable codes, and two validators agree when they emit the same SET
// of `(code, flow ID)` pairs. If this file and the contract disagree, this file is wrong. Levels 1
// (one file) and 2 (one component) are implemented; of level 3 (the whole set) only
// `prefix_duplicated`, for the trees `erplora workflow-lint` walks — reciprocity across repos is
// the index's job.
//
// Severity. The 27 module repos run this toolkit by `@main`, unversioned: what merges reaches all
// of them at once. So a component WITHOUT the file is a warning (`workflow_missing`; the migration
// is open) unless `strict`, and a file that is there and malformed is an error.
//
// Name (ERPlora/pm#658). The file is being renamed `HANDBOOK.md` (its detail folder `handbook/`),
// one component per chain: both names are read, and where both are, HANDBOOK.md governs and the
// leftover WORKFLOW.md and `workflow/*.md` are a `legacy_workflow_file` warning, not linted.
//
// Naming. «flows» in this repository already means automations (`validate-flows.mjs`,
// `flows/*.flow.json`). This is the `workflow-doc`, everywhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WORKFLOW_FILE = 'WORKFLOW.md';
/** The new name of the same file (ERPlora/pm#658), with `handbook/` as its detail folder. */
export const HANDBOOK_FILE = 'HANDBOOK.md';
/**
 * The names of the main file, newest first, each with its own detail folder. Every component
 * renames its own in the first PR of its chain, so until the last one goes both are read; in a
 * folder with both, the newest governs and the older one is a `legacy_workflow_file` warning.
 */
const NAMES = [
  { file: HANDBOOK_FILE, detail: 'handbook' },
  { file: WORKFLOW_FILE, detail: 'workflow' },
];
const DETAIL_DIRS = new Set(NAMES.map((n) => n.detail));
/** Above this many lines (as awk counts them) the file should become an index + `workflow/*.md`. */
export const MAX_LINES = 600;

// §5.3, as written there.
const ID = '[A-Z][A-Z0-9_]*-F[0-9][0-9]+';
const HEADING_ANY = /^(# |## |### )/;
const PREFIX_VALID = /^Prefijo: [A-Z][A-Z0-9_]*$/;
const SCOPE_VALID = /^Alcance MVP: (nucleo|restaurante|peluqueria|transversal|fuera del MVP|congelado)$/;
const FLOW_HEADER = new RegExp(`^### ${ID}( .*)?$`);
const FLOW_TITLED = new RegExp(`^### ${ID} .`);
const RETIRED_HEADER = new RegExp(`^### ${ID} \\[retirado\\]( .*)?$`);
const RETIRED_TITLED = new RegExp(`^### ${ID} \\[retirado\\] .`);
const KEY_LINE = /^(Estado|Actor|Pantalla|Pasos|Entra|Sale|Si falla|Implicados|QA):/;
const STATE_VALID = /^Estado: (hecho|parcial — .+|no hecho — .+)$/;
const IMPLICATED_VALID = new RegExp(`^Implicados: (ninguno|pendiente|${ID}(, ${ID})*)$`);
const PENDING_LINE = 'Pendiente de enlazar:';
const PENDING_VALID = /^Pendiente de enlazar: .+ — .+$/;
const VERTICAL_LINE = 'Vertical:';
const VERTICAL_VALID = /^Vertical: (comun|peluqueria|restaurante)$/;

const KEYS = ['Estado', 'Actor', 'Pantalla', 'Pasos', 'Entra', 'Sale', 'Si falla', 'Implicados', 'QA'];
/** The eleven sections, in canonical order: the first ten are required of a main file. */
export const SECTIONS = [
  '## Para qué sirve y para quién',
  '## Referencia adoptada',
  '## Antes de empezar',
  '## Pantallas',
  '## Flujos',
  '## Cobertura contra la referencia',
  '## Datos: de quién es cada dato',
  '## Reglas que no se rompen',
  '## Lo que NO hace, a propósito',
  '## Dudas abiertas',
  '## Fuentes contrastadas',
];
const FLOWS = '## Flujos';

/** `<file>:<line>: <code>: <text>` — the one shape every message has. */
export function formatFinding(f) {
  return `${f.file}:${f.line}: ${f.code}: ${f.text}`;
}

function split(findings) {
  return {
    errors: findings.filter((f) => f.level === 'error').map(formatFinding),
    warnings: findings.filter((f) => f.level === 'warning').map(formatFinding),
    findings,
  };
}

/** Whether `prefix` belongs to `family`: the family itself, or `<FAMILY>_<…>`. */
export function inFamily(prefix, family) {
  return prefix === family || prefix.startsWith(`${family}_`);
}

const idPrefix = (id) => id.slice(0, id.indexOf('-'));

/**
 * Level 1: one file. `kind` is `principal` (WORKFLOW.md, or a journey of `architecture/workflows/`)
 * or `secondary` (`workflow/<slug>.md`); `rec` marks a journey, whose prefix must start with `REC_`
 * (and nothing else may). Returns the findings, the prefix (only when it is usable: present once
 * and well formed) and the flows its headers declare.
 */
export function lintWorkflowFile(text, { file = WORKFLOW_FILE, kind = 'principal', rec = false } = {}) {
  const findings = [];
  const add = (level, code, id, line, msg) => findings.push({ level, code, id, file, line, text: msg });
  const error = (code, id, line, msg) => add('error', code, id, line, msg);

  // §5.2: normalisation, then code blocks. `awkLines` is what awk reads: a final newline closes the
  // last record instead of opening an empty one.
  const raw = text.split('\n');
  const awkLines = text === '' ? 0 : text.endsWith('\n') ? raw.length - 1 : raw.length;
  if (awkLines > MAX_LINES) {
    add('warning', 'file_too_long', '', awkLines, `${awkLines} lines, more than ${MAX_LINES}: keep it as the index and move the flows to \`workflow/<slug>.md\``);
  }
  const lines = [];
  let fence = null;
  for (let i = 0; i < awkLines; i += 1) {
    const line = raw[i].replace(/[ \t\r]+$/, '');
    if (fence) {
      if (line.startsWith(fence.mark)) fence = null;
      continue;
    }
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fence = { mark: line.slice(0, 3), n: i + 1 };
      continue;
    }
    lines.push({ n: i + 1, line });
  }
  if (fence) {
    error('code_block_unclosed', '', fence.n, `the \`${fence.mark}\` block opened here is never closed: nothing after it can be read`);
    return { findings, prefix: null, prefixLine: 1, flows: [] };
  }

  const firstSection = lines.find((l) => l.line.startsWith('## '))?.n ?? Infinity;

  // Prefijo.
  let prefix = null;
  let prefixLine = 1;
  const prefixLines = lines.filter((l) => l.line.startsWith('Prefijo:'));
  if (!prefixLines.length) {
    error('prefix_missing', '', 1, `no \`Prefijo:\` line before the first \`## \` section`);
  } else if (prefixLines.length > 1) {
    error('prefix_repeated', '', prefixLines[1].n, `\`Prefijo:\` appears ${prefixLines.length} times; it goes once, before the first \`## \``);
  } else {
    const { n, line } = prefixLines[0];
    if (n > firstSection) error('prefix_after_section', '', n, '`Prefijo:` has to come before the first `## ` section');
    if (!PREFIX_VALID.test(line)) {
      error('prefix_malformed', '', n, `\`${line}\` is not a prefix: upper case, digits and \`_\` (e.g. \`Prefijo: CASH_REGISTER\`)`);
    } else {
      prefix = line.slice('Prefijo: '.length);
      prefixLine = n;
      if (rec && !prefix.startsWith('REC_')) {
        error('rec_prefix_misplaced', '', n, `prefix \`${prefix}\`: a journey of \`architecture/workflows/\` carries a \`REC_<SLUG>\` prefix`);
      } else if (!rec && prefix.startsWith('REC_')) {
        error('rec_prefix_misplaced', '', n, `prefix \`${prefix}\`: \`REC_\` is reserved to the journeys of \`architecture/workflows/\``);
      }
    }
  }

  // Alcance MVP.
  let scope = null;
  const scopeLines = lines.filter((l) => l.line.startsWith('Alcance MVP:'));
  if (!scopeLines.length) {
    if (kind === 'principal') error('scope_missing', '', 1, 'no `Alcance MVP:` line before the first `## ` section');
  } else if (scopeLines.length > 1) {
    error('scope_repeated', '', scopeLines[1].n, `\`Alcance MVP:\` appears ${scopeLines.length} times; it goes once`);
  } else {
    const { n, line } = scopeLines[0];
    if (n > firstSection) error('scope_after_section', '', n, '`Alcance MVP:` has to come before the first `## ` section');
    if (SCOPE_VALID.test(line)) scope = line.slice('Alcance MVP: '.length);
    else error('scope_malformed', '', n, `\`${line}\` is not a scope: nucleo, restaurante, peluqueria, transversal, fuera del MVP or congelado (no accents)`);
  }

  // Sections: exact equality, the required ones of the class, none twice, canonical order.
  const seen = new Map();
  for (const { n, line } of lines) {
    if (!SECTIONS.includes(line)) continue;
    if (seen.has(line)) error('section_repeated', '', n, `\`${line}\` appears twice`);
    else seen.set(line, n);
  }
  const required =
    kind === 'secondary' ? [FLOWS] : scope === 'congelado' ? [SECTIONS[0]] : SECTIONS.slice(0, 10);
  for (const section of required) {
    if (!seen.has(section)) error('section_missing', '', 1, `no \`${section}\` section (exact title)`);
  }
  const order = [...seen.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => SECTIONS.indexOf(s));
  const outOfOrder = order.findIndex((idx, i) => i > 0 && idx < order[i - 1]);
  if (outOfOrder !== -1) {
    const [section, n] = [...seen.entries()].sort((a, b) => a[1] - b[1])[outOfOrder];
    error('section_out_of_order', '', n, `\`${section}\` is out of the canonical order of the sections`);
  }

  // Flows.
  const flows = [];
  let inFlows = false;
  let flow = null;
  const close = () => {
    if (flow) lintFlow(flow, prefix, error);
    flow = null;
  };
  for (const { n, line } of lines) {
    if (HEADING_ANY.test(line)) {
      close();
      if (line.startsWith('## ')) {
        inFlows = line === FLOWS;
        continue;
      }
      if (!line.startsWith('### ')) continue;
      if (!FLOW_HEADER.test(line)) {
        if (inFlows) error('flow_header_malformed', '', n, `\`${line}\` in \`## Flujos\` is not a flow header (\`### <PREFIJO>-F<nn> <título>\`)`);
        continue;
      }
      const id = line.split(' ')[1];
      if (!inFlows) {
        error('flow_header_outside_flows', id, n, `flow \`${id}\` sits outside the \`## Flujos\` section`);
        continue;
      }
      const retired = RETIRED_HEADER.test(line);
      if (!(retired ? RETIRED_TITLED : FLOW_TITLED).test(line)) error('flow_title_missing', id, n, `flow \`${id}\` has no title`);
      if (prefix && idPrefix(id) !== prefix) error('flow_prefix_mismatch', id, n, `flow \`${id}\` does not carry the file prefix \`${prefix}\``);
      const first = flows.find((f) => f.id === id);
      if (first) error('flow_id_repeated', id, n, `flow \`${id}\` is already declared at line ${first.line} (a number is never reused)`);
      flows.push({ id, line: n, file, retired });
      flow = { id, n, retired, lines: [] };
      continue;
    }
    if (flow) flow.lines.push({ n, line });
  }
  close();

  return { findings, prefix, prefixLine, flows };
}

/** The rules of one flow block (§5.4), reported through `error(code, id, line, text)`. */
function lintFlow(flow, prefix, error) {
  const { id } = flow;
  const keyLines = (key) => flow.lines.filter((l) => KEY_LINE.test(l.line) && l.line.slice(0, l.line.indexOf(':')) === key);
  const pending = flow.lines.filter((l) => l.line.startsWith(PENDING_LINE));

  if (flow.retired) {
    const impl = keyLines('Implicados');
    if (impl.length !== 1 || impl[0].line !== 'Implicados: ninguno' || pending.length) {
      error('retired_malformed', id, (impl[0] ?? pending[0])?.n ?? flow.n,
        `flow \`${id}\` is [retirado]: exactly one \`Implicados: ninguno\` and no \`${PENDING_LINE}\` line`);
    }
    return;
  }

  const byKey = Object.fromEntries(KEYS.map((k) => [k, keyLines(k)]));
  for (const key of KEYS) {
    if (!byKey[key].length) error('key_missing', id, flow.n, `flow \`${id}\` has no \`${key}:\` line (every live flow carries the nine keys)`);
    else if (byKey[key].length > 1) error('key_repeated', id, byKey[key][1].n, `flow \`${id}\` repeats \`${key}:\` (each key goes once)`);
  }
  const firsts = KEYS.filter((k) => byKey[k].length).sort((a, b) => byKey[a][0].n - byKey[b][0].n);
  const present = KEYS.filter((k) => byKey[k].length);
  const wrong = firsts.findIndex((k, i) => k !== present[i]);
  if (wrong !== -1) {
    error('key_out_of_order', id, byKey[firsts[wrong]][0].n,
      `flow \`${id}\`: the keys go in the order ${KEYS.map((k) => `\`${k}:\``).join(', ')}`);
  }

  const state = byKey.Estado.length === 1 ? byKey.Estado[0] : null;
  if (state && !STATE_VALID.test(state.line)) {
    error('state_malformed', id, state.n, `\`${state.line}\` is not a state: \`hecho\`, \`parcial — <qué falta>\` or \`no hecho — <qué falta>\` (em dash)`);
  }

  const vertical = flow.lines.filter((l) => l.line.startsWith(VERTICAL_LINE));
  if (vertical.length > 1) {
    error('key_repeated', id, vertical[1].n, `flow \`${id}\` repeats \`Vertical:\` (optional, and once)`);
  } else if (vertical.length === 1) {
    const [v] = vertical;
    if (!VERTICAL_VALID.test(v.line)) error('vertical_malformed', id, v.n, `\`${v.line}\` is not a vertical: comun, peluqueria or restaurante`);
    if (state && v.n !== state.n + 1) error('vertical_misplaced', id, v.n, `flow \`${id}\`: \`Vertical:\` goes on the line right below \`Estado:\``);
  }

  const impl = byKey.Implicados.length === 1 ? byKey.Implicados[0] : null;
  if (impl) {
    if (!IMPLICATED_VALID.test(impl.line)) {
      error('implicated_malformed', id, impl.n, `\`${impl.line}\`: \`ninguno\`, \`pendiente\` or full flow IDs separated by \`, \`, on one line`);
    } else {
      const value = impl.line.slice('Implicados: '.length);
      if (value === 'ninguno') {
        if (pending.length) {
          error('pending_under_none', id, pending[0].n,
            `flow \`${id}\`: \`Implicados: ninguno\` admits no \`${PENDING_LINE}\` line (when every link is pending, the value is \`pendiente\`)`);
        }
      } else if (value === 'pendiente') {
        if (!pending.length) error('pending_without_lines', id, impl.n, `flow \`${id}\` says \`Implicados: pendiente\` and has no \`${PENDING_LINE}\` line below`);
      } else {
        const ids = value.split(', ');
        const own = prefix ? ids.filter((x) => idPrefix(x) === prefix) : [];
        if (own.length) error('implicated_own_prefix', id, impl.n, `\`Implicados\` names ${own.map((x) => `\`${x}\``).join(', ')}, of its own prefix: it lists flows of OTHER components`);
        const twice = ids.filter((x, i) => ids.indexOf(x) !== i);
        if (twice.length) error('implicated_repeated', id, impl.n, `\`Implicados\` names ${[...new Set(twice)].map((x) => `\`${x}\``).join(', ')} twice`);
      }
    }
  }

  for (const p of pending) {
    if (!PENDING_VALID.test(p.line)) error('pending_malformed', id, p.n, `\`${p.line}\`: \`${PENDING_LINE} <componente> — <qué flujo suyo>\` (em dash)`);
  }
  const after = byKey.Implicados[0]?.n ?? Infinity;
  const before = byKey.QA[0]?.n ?? Infinity;
  const misplaced = pending.find((p) => !(p.n > after && p.n < before));
  if (misplaced) error('pending_misplaced', id, misplaced.n, `flow \`${id}\`: \`${PENDING_LINE}\` lines go between \`Implicados:\` and \`QA:\``);
}

/**
 * Whether `name` is a FILE inside `dir`, by its exact name. Exact because APFS and NTFS match names
 * case-insensitively and the CI's filesystem does not: a lone `workflow.md` would be linted on a Mac
 * and be missing on the runner. A symbolic link counts as what it points to (a linked
 * `WORKFLOW.md` and a linked `workflow/*.md` are read alike); a folder, or a broken link, is no file.
 */
function isFileIn(dir, name) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.includes(name) && Boolean(statSync(join(dir, name), { throwIfNoEntry: false })?.isFile());
}

/** The `*.md` files of `dir` (links followed, `except` left out), sorted; none if it is no folder. */
function markdownFiles(dir, except = []) {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !except.includes(name) && isFileIn(dir, name))
    .sort();
}

/** `<detail>/*.md` of a folder (`workflow/` by default), sorted. */
function secondaryFiles(dir, detail = 'workflow') {
  return markdownFiles(join(dir, detail));
}

/** The name that governs `dir`: the newest of `NAMES` that is a file there, or undefined. */
function governingName(dir) {
  return NAMES.find((n) => isFileIn(dir, n.file));
}

/**
 * Level 2: the component in `dir` — its HANDBOOK.md (or WORKFLOW.md) and the `handbook/*.md` (or
 * `workflow/*.md`) beside it. With both names, HANDBOOK.md governs: the old WORKFLOW.md and its
 * `workflow/*.md` are not linted, each is a `legacy_workflow_file` warning (pm#658). `modulePrefix`
 * (a module's id in upper case) adds `module_prefix_mismatch`; `family` adds `family_mismatch`
 * (`erplora workflow-lint --family`, not part of the contract); `label` prefixes the paths.
 * Returns `{ findings, found, file, prefix, files, flows }` (`file` = the governing name).
 */
export function lintWorkflowComponent(dir, { modulePrefix, family, label = '' } = {}) {
  const findings = [];
  const files = [];
  const flows = [];
  const governing = governingName(dir);
  const found = Boolean(governing);
  let prefix = null;
  let prefixLine = 1;
  if (found) {
    const file = `${label}${governing.file}`;
    const text = readFileSync(join(dir, governing.file), 'utf8');
    const r = lintWorkflowFile(text, { file });
    findings.push(...r.findings);
    flows.push(...r.flows);
    files.push(file);
    prefix = r.prefix;
    prefixLine = r.prefixLine;
    if (prefix && modulePrefix && prefix !== modulePrefix) {
      findings.push({ level: 'error', code: 'module_prefix_mismatch', id: '', file, line: prefixLine,
        text: `prefix \`${prefix}\` is not this module's: expected \`${modulePrefix}\`, its \`id\` in upper case` });
    }
    if (prefix && family && !inFamily(prefix, family)) findings.push(familyMismatch(prefix, family, file, prefixLine));
  }
  for (const [rank, n] of NAMES.entries()) {
    // An older name beside the governing one: the leftover of the rename, warned and not read.
    if (found && rank > NAMES.indexOf(governing)) {
      const leftovers = [
        ...(isFileIn(dir, n.file) ? [n.file] : []),
        ...secondaryFiles(dir, n.detail).map((name) => `${n.detail}/${name}`),
      ];
      for (const rel of leftovers) findings.push(legacy(`${label}${rel}`, `${label}${governing.file}`));
      continue;
    }
    for (const name of secondaryFiles(dir, n.detail)) {
      const file = `${label}${n.detail}/${name}`;
      const text = readFileSync(join(dir, n.detail, name), 'utf8');
      const r = lintWorkflowFile(text, { file, kind: 'secondary' });
      findings.push(...r.findings);
      files.push(file);
      if (n !== governing) {
        findings.push({ level: 'error', code: 'orphan_subfile', id: '', file, line: 1,
          text: `no \`${n.file}\` next to its \`${n.detail}/\` folder: a detail file belongs to an index` });
      } else if (prefix && r.prefix && r.prefix !== prefix) {
        findings.push({ level: 'error', code: 'subfile_prefix_mismatch', id: '', file, line: r.prefixLine,
          text: `prefix \`${r.prefix}\` is not the one of its index \`${prefix}\` (a detail file repeats it)` });
      }
      for (const f of r.flows) {
        const first = flows.find((x) => x.id === f.id && x.file !== f.file);
        if (first) {
          findings.push({ level: 'error', code: 'flow_id_repeated', id: f.id, file, line: f.line,
            text: `flow \`${f.id}\` is already declared at ${first.file}:${first.line} (a number is never reused)` });
        }
      }
      flows.push(...r.flows);
    }
  }
  return { findings, found, file: governing?.file, prefix, prefixLine, files, flows };
}

/** The old name left beside the new one (pm#658): not read, a warning until the rename deletes it. */
function legacy(file, governing) {
  return { level: 'warning', code: 'legacy_workflow_file', id: '', file, line: 1,
    text: `not read: ${governing} is in its folder and governs; this is the leftover of the rename to ` +
      `${HANDBOOK_FILE} (ERPlora/pm#658) and is deleted` };
}

/** `--family` of `erplora workflow-lint`: a toolkit option, not a rule of the contract. */
function familyMismatch(prefix, family, file, line) {
  return { level: 'error', code: 'family_mismatch', id: '', file, line,
    text: `prefix \`${prefix}\` is not of the \`${family}\` family (expected \`${family}\` or \`${family}_<…>\`)` };
}

function missing(id, file, strict) {
  return {
    level: strict ? 'error' : 'warning',
    code: 'workflow_missing',
    id,
    file,
    line: 1,
    text:
      `no ${HANDBOOK_FILE} (nor ${WORKFLOW_FILE}, its old name) yet — the component's functional spec (screens, flows, \`Implicados\`) that workers, ` +
      'reviewers and QA read before touching it (ERPlora/pm#621, architecture/contracts/workflow-contract.md)',
  };
}

/** Pure: lints the text of one WORKFLOW.md. `prefix` = the module's (adds `module_prefix_mismatch`). */
export function lintWorkflowText(text, { prefix, family, file = WORKFLOW_FILE, rec = false } = {}) {
  const r = lintWorkflowFile(text, { file, rec });
  const findings = [...r.findings];
  const line = r.prefixLine;
  if (r.prefix && prefix && r.prefix !== prefix) {
    findings.push({ level: 'error', code: 'module_prefix_mismatch', id: '', file, line,
      text: `prefix \`${r.prefix}\` is not this module's: expected \`${prefix}\`, its \`id\` in upper case` });
  }
  if (r.prefix && family && !inFamily(r.prefix, family)) findings.push(familyMismatch(r.prefix, family, file, line));
  return split(findings);
}

/**
 * The module door (`erplora validate`): levels 1 and 2 on the module folder, the prefix being the
 * module id in upper case. No WORKFLOW.md = `workflow_missing`, a warning unless `strict`.
 * Returns `{ errors, warnings, findings }`.
 */
export function checkWorkflowDoc(dir, manifest, { strict = false } = {}) {
  const id = String(manifest?.id ?? '');
  const r = lintWorkflowComponent(dir, { modulePrefix: id ? id.toUpperCase() : undefined });
  const findings = [...r.findings];
  if (!r.found) findings.unshift(missing(id, HANDBOOK_FILE, strict));
  return split(findings);
}

/** Folders never walked: dependencies, build output, git internals. */
const SKIPPED_DIRS = new Set(['node_modules', 'target', 'dist', '.git']);

/** Every folder under `root` (itself included), `/`-separated and relative to it, sorted. */
function walkDirs(root, rel = '') {
  const out = [rel];
  const names = readdirSync(join(root, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of names) out.push(...walkDirs(root, rel ? `${rel}/${name}` : name));
  return out;
}

/**
 * The door for the components that are not modules (`erplora workflow-lint`): every component
 * folder under `root` (a WORKFLOW.md, or a `workflow/` folder of detail files) at levels 1 and 2,
 * and with the `REC` family the journeys of `root/workflows/*.md` but README.md (main files whose
 * prefix starts with `REC_`). Of level 3, `prefix_duplicated` between main files. A root without
 * its WORKFLOW.md (or, for REC, without journeys) = `workflow_missing`, an error only if `strict`.
 * `name` is how the root is called in messages. Returns `{ errors, warnings, findings, files, flows }`.
 */
export function lintWorkflowTree(root, { family, strict = false, name = '.' } = {}) {
  const findings = [];
  const files = [];
  const flows = [];
  const mains = [];
  for (const rel of walkDirs(root)) {
    if (DETAIL_DIRS.has(rel.split('/').pop())) continue;
    const dir = join(root, rel);
    if (!governingName(dir) && !NAMES.some((n) => secondaryFiles(dir, n.detail).length)) continue;
    const label = rel ? `${rel}/` : '';
    const r = lintWorkflowComponent(dir, { family, label });
    findings.push(...r.findings);
    files.push(...r.files);
    flows.push(...r.flows);
    if (r.found && r.prefix) mains.push({ prefix: r.prefix, file: `${label}${r.file}`, line: r.prefixLine });
  }
  if (family === 'REC') {
    const journeys = join(root, 'workflows');
    const docs = markdownFiles(journeys, ['README.md']);
    for (const doc of docs) {
      const file = `workflows/${doc}`;
      const text = readFileSync(join(journeys, doc), 'utf8');
      const r = lintWorkflowFile(text, { file, rec: true });
      findings.push(...r.findings);
      files.push(file);
      flows.push(...r.flows);
      if (r.prefix) {
        mains.push({ prefix: r.prefix, file, line: r.prefixLine });
        if (!inFamily(r.prefix, family)) findings.push(familyMismatch(r.prefix, family, file, r.prefixLine));
      }
    }
    if (!docs.length) findings.push(missing(name, 'workflows/', strict));
  } else if (!governingName(root)) {
    findings.push(missing(name, HANDBOOK_FILE, strict));
  }
  for (const [i, m] of mains.entries()) {
    const first = mains.slice(0, i).find((x) => x.prefix === m.prefix);
    if (first) {
      findings.push({ level: 'error', code: 'prefix_duplicated', id: '', file: m.file, line: m.line,
        text: `prefix \`${m.prefix}\` is already the one of ${first.file}: a prefix names ONE component` });
    }
  }
  return { ...split(findings), files, flows };
}
