// The WORKFLOW.md lint (ERPlora/pm#621).
//
// Every component of ERPlora carries a versioned `WORKFLOW.md`: its functional spec — screens,
// flows, and which flows of OTHER components each flow touches (`Implicados:`). Workers, reviewers
// and QA read it before touching the component, and the `pm` index (`workflow-index.sh`)
// cross-checks the references between components. The index can only trust what it reads if every
// file follows ONE grammar (PROMPT-WORKFLOW.md, «Reglas de la gramática»;
// `architecture/contracts/workflow-contract.md`), so the grammar is checked here, one component at
// a time: format and internal coherence. Whether a referenced flow EXISTS in another repo and names
// this one back is the index's job — this lint never reads another component.
//
// Severity. The 27 module repos run this toolkit by `@main`, unversioned: what merges reaches all
// of them at once. So a component WITHOUT the file is a warning (the migration is open), and a file
// that is there and malformed is an error. Same split as the domain-error catalog (ADR-0398 §5).
//
// Naming. «flows» in this repository already means automations (`validate-flows.mjs`,
// `flows/*.flow.json`). This is the `workflow-doc`, everywhere.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WORKFLOW_FILE = 'WORKFLOW.md';
/** Above this, WORKFLOW.md stays as an index and the flows move to `workflow/<slug>.md`. */
export const MAX_LINES = 600;

const PREFIX_RE = /^[A-Z][A-Z0-9_]*$/;
const FLOW_ID_RE = /^([A-Z][A-Z0-9_]*)-F[0-9][0-9]+$/;
const SCOPES = ['nucleo', 'restaurante', 'peluqueria', 'transversal', 'fuera del MVP', 'congelado'];
const STATES = ['hecho', 'parcial', 'no hecho'];
const KEYS = ['Estado:', 'Actor:', 'Pantalla:', 'Pasos:', 'Entra:', 'Sale:', 'Si falla:', 'Implicados:', 'QA:'];
/** Free text with conventions: only checked to be there once and not empty. */
const NON_EMPTY_KEYS = ['Actor:', 'Pantalla:', 'QA:'];
const PENDING_LINK = 'Pendiente de enlazar:';
const FLOWS_SECTION_RE = /^## Flujos( — .+)?$/;

/** Whether `prefix` belongs to `family`: the family itself, or `<FAMILY>_<…>`. */
export function inFamily(prefix, family) {
  return prefix === family || prefix.startsWith(`${family}_`);
}

/**
 * The lines that count, with their 1-based number: CRLF tolerated, and whatever sits inside a
 * ``` or ~~~ block dropped (a fenced example is not a header nor a key).
 */
function liveLines(text) {
  const out = [];
  let fence = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '');
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
      return;
    }
    if (open) {
      fence = open[1];
      return;
    }
    out.push({ n: i + 1, line });
  });
  return { lines: out, total: text.split(/\r?\n/).length - (/\r?\n$/.test(text) ? 1 : 0) };
}

/**
 * Lints one file. `expected` is the prefix it must carry (a module's id in upper case, or the main
 * file's prefix for a part); `family` the family it must belong to; `part` marks a
 * `workflow/<slug>.md`, which holds flows and needs neither `Alcance MVP` nor `## Pantallas`.
 * Returns the messages plus what the caller needs to cross-check files: the prefix and the flows.
 */
export function lintWorkflowFile(text, { file = WORKFLOW_FILE, prefix: expected, family, part = false } = {}) {
  const errors = [];
  const warnings = [];
  const at = (n, msg) => `${file}:${n}: ${msg}`;
  const { lines, total } = liveLines(text);

  const firstSection = lines.find((l) => l.line.startsWith('## '))?.n ?? Infinity;
  let prefix = null;
  let prefixSeen = false;
  let scopeSeen = false;
  let screens = false;
  let flowsSection = false;
  let inFlows = false;
  const flows = [];
  let flow = null;

  const closeFlow = () => {
    if (!flow) return;
    // `pendiente` = every link is a `Pendiente de enlazar:` line; `ninguno` = depends on nobody.
    const links = flow.implicados?.value;
    if (links === 'pendiente' && !flow.pending.length) {
      errors.push(at(flow.implicados.n, `flow \`${flow.id}\` says \`Implicados: pendiente\` and has no \`${PENDING_LINK}\` line below`));
    }
    if (links === 'ninguno' && flow.pending.length) {
      errors.push(
        at(flow.pending[0], `flow \`${flow.id}\`: \`Implicados: ninguno\` admits no \`${PENDING_LINK}\` line (when every link is pending, the value is \`pendiente\`)`),
      );
    }
    if (flow.retired) {
      if (!flow.keys.has('Implicados:')) {
        errors.push(at(flow.n, `flow \`${flow.id}\` is [retirado] and has no \`Implicados: ninguno\` line`));
      }
    } else {
      for (const key of KEYS) {
        if (!flow.keys.has(key)) errors.push(at(flow.n, `flow \`${flow.id}\` has no \`${key}\` line (every live flow carries all nine keys)`));
      }
    }
    flow = null;
  };

  for (const { n, line } of lines) {
    if (/^#{1,3} /.test(line)) closeFlow();

    if (line.startsWith('## ')) {
      inFlows = FLOWS_SECTION_RE.test(line);
      if (inFlows) flowsSection = true;
      if (line === '## Pantallas') screens = true;
      continue;
    }

    if (line.startsWith('### ')) {
      const [, token = '', third = ''] = line.split(' ');
      const looksLikeFlow = /^[A-Z][A-Z0-9_]*-F[0-9]/.test(token);
      if (!looksLikeFlow) {
        if (inFlows) errors.push(at(n, `\`${line}\` is not a flow header (\`### <PREFIJO>-F<nn> <título>\`)`));
        continue;
      }
      const id = FLOW_ID_RE.exec(token);
      if (!id) {
        errors.push(at(n, `\`${token}\` is not a flow ID: \`<PREFIJO>-F<nn>\`, with two digits at least`));
        continue;
      }
      if (!inFlows) errors.push(at(n, `flow \`${token}\` sits outside a \`## Flujos\` section`));
      const own = prefix ?? (expected && PREFIX_RE.test(expected) ? expected : null);
      if (own && id[1] !== own) errors.push(at(n, `flow \`${token}\` does not carry the file prefix \`${own}\``));
      flow = { id: token, n, retired: third === '[retirado]', keys: new Set(), implicados: null, pending: [] };
      flows.push({ id: token, n, file });
      continue;
    }

    if (line.startsWith('Prefijo:')) {
      if (prefixSeen) {
        errors.push(at(n, '`Prefijo:` appears more than once (it goes once, before the first `## `)'));
        continue;
      }
      prefixSeen = true;
      if (n > firstSection) errors.push(at(n, '`Prefijo:` has to come before the first `## ` section'));
      const value = line.slice('Prefijo:'.length).trim();
      if (!/^Prefijo: [A-Z][A-Z0-9_]*$/.test(line)) {
        errors.push(at(n, `\`${line}\` is not a prefix: upper case, digits and \`_\` (e.g. \`Prefijo: CASH_REGISTER\`)`));
        continue;
      }
      prefix = value;
      if (expected && value !== expected) {
        errors.push(at(n, `prefix \`${value}\` is not this component's (expected \`${expected}\`)`));
      } else if (family && !inFamily(value, family)) {
        errors.push(at(n, `prefix \`${value}\` is not of the \`${family}\` family (expected \`${family}\` or \`${family}_<…>\`)`));
      }
      continue;
    }

    if (line.startsWith('Alcance MVP:')) {
      if (scopeSeen) {
        errors.push(at(n, '`Alcance MVP:` appears more than once'));
        continue;
      }
      scopeSeen = true;
      if (!SCOPES.some((s) => line === `Alcance MVP: ${s}`)) {
        errors.push(at(n, `\`${line}\` is not a scope: one of ${SCOPES.map((s) => `\`${s}\``).join(', ')}`));
      }
      continue;
    }

    if (!flow) continue;
    if (line.startsWith(PENDING_LINK)) {
      flow.pending.push(n);
      continue;
    }
    const key = KEYS.find((k) => line.startsWith(k));
    if (!key) continue;
    if (flow.keys.has(key)) {
      errors.push(at(n, `flow \`${flow.id}\` repeats \`${key}\` (each key goes once)`));
      continue;
    }
    flow.keys.add(key);
    const value = line.slice(key.length).trim();
    if (key === 'Estado:' && !STATES.some((s) => value === s || value.startsWith(`${s} `))) {
      errors.push(at(n, `\`${line}\` is not a state: it starts with \`hecho\`, \`parcial\` or \`no hecho\``));
    }
    if (NON_EMPTY_KEYS.includes(key) && !value) {
      errors.push(at(n, `flow \`${flow.id}\`: \`${key}\` is empty (free text, but never empty)`));
    }
    if (key === 'Implicados:') {
      flow.implicados = { value, n };
      if (flow.retired) {
        if (value !== 'ninguno') errors.push(at(n, `flow \`${flow.id}\` is [retirado]: its only \`Implicados\` is \`ninguno\``));
        continue;
      }
      if (value === 'ninguno' || value === 'pendiente') continue;
      const tokens = value.split(', ');
      const bad = tokens.filter((t) => !FLOW_ID_RE.test(t));
      if (!value || bad.length) {
        errors.push(
          at(n, `\`Implicados: ${value}\`: \`ninguno\`, \`pendiente\` or full flow IDs separated by \`, \` on one line` +
            (bad.length && value ? ` — not an ID: ${bad.map((t) => `\`${t}\``).join(', ')}` : '')),
        );
        continue;
      }
      const own = prefix ?? expected;
      const mine = tokens.filter((t) => own && FLOW_ID_RE.exec(t)[1] === own);
      if (mine.length) {
        errors.push(at(n, `\`Implicados\` names ${mine.map((t) => `\`${t}\``).join(', ')}, of its own prefix — it lists flows of OTHER components`));
      }
    }
  }
  closeFlow();

  if (!prefixSeen) errors.push(at(1, 'no `Prefijo:` line before the first `## ` section'));
  if (!part) {
    if (!scopeSeen) errors.push(at(1, `no \`Alcance MVP:\` line (one of ${SCOPES.map((s) => `\`${s}\``).join(', ')})`));
    if (!screens) errors.push(at(1, 'no `## Pantallas` section'));
    if (total > MAX_LINES) {
      warnings.push(at(total, `${total} lines, more than ${MAX_LINES}: keep it as the index and move the flows to \`workflow/<slug>.md\``));
    }
  }
  if (!flowsSection) errors.push(at(1, 'no `## Flujos` section (`## Flujos` or `## Flujos — <área>`)'));
  errors.push(...duplicateFlowErrors(flows));

  return { errors, warnings, prefix, flows };
}

/** Pure: lints the text of one WORKFLOW.md. `{ prefix, family }` as in `lintWorkflowFile`. */
export function lintWorkflowText(text, { prefix, family, file, part } = {}) {
  const { errors, warnings } = lintWorkflowFile(text, { prefix, family, file, part });
  return { errors, warnings };
}

/**
 * Flow IDs declared twice: an error at the second, naming the first. `acrossFilesOnly` leaves out
 * the pairs inside one file, which that file's own lint already reported.
 */
export function duplicateFlowErrors(flows, { acrossFilesOnly = false } = {}) {
  const seen = new Map();
  const errors = [];
  for (const f of flows) {
    const first = seen.get(f.id);
    if (first && acrossFilesOnly && first.file === f.file) continue;
    if (first) errors.push(`${f.file}:${f.n}: flow \`${f.id}\` is already declared at ${first.file}:${first.n} (a number is never reused)`);
    else seen.set(f.id, f);
  }
  return errors;
}

/** `workflow/*.md` next to a WORKFLOW.md, sorted. */
function partFiles(dir) {
  const root = join(dir, 'workflow');
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

/**
 * Lints the WORKFLOW.md of `dir` and its `workflow/*.md` parts: same grammar, the same prefix as
 * the main file, and no flow ID twice among them. `label` prefixes every path in the messages;
 * `duplicates: false` leaves the cross-file ID check to a caller that lints several folders.
 * Returns `{ errors, warnings, found, files, flows }`.
 */
export function lintWorkflowDir(dir, { prefix, family, label = '', duplicates = true } = {}) {
  const errors = [];
  const warnings = [];
  const flows = [];
  const files = [];
  const main = join(dir, WORKFLOW_FILE);
  const found = existsSync(main);
  let own = prefix;
  const take = (r, file) => {
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    flows.push(...r.flows);
    files.push(file);
  };
  if (found) {
    const file = `${label}${WORKFLOW_FILE}`;
    const r = lintWorkflowFile(readFileSync(main, 'utf8'), { file, prefix, family });
    take(r, file);
    own = own ?? r.prefix ?? undefined;
  }
  for (const name of partFiles(dir)) {
    const file = `${label}workflow/${name}`;
    take(lintWorkflowFile(readFileSync(join(dir, 'workflow', name), 'utf8'), { file, prefix: own, family, part: true }), file);
  }
  if (duplicates) errors.push(...duplicateFlowErrors(flows, { acrossFilesOnly: true }));
  return { errors, warnings, found, files, flows };
}

/** Folders never walked: dependencies, build output, git internals. */
const SKIPPED_DIRS = new Set(['node_modules', 'target', 'dist', '.git']);

/** Every folder under `root` (itself included) as a `/`-separated path relative to it, sorted. */
function walkDirs(root, rel = '') {
  const out = [rel];
  const entries = readdirSync(join(root, rel), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !SKIPPED_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  for (const name of entries) out.push(...walkDirs(root, rel ? `${rel}/${name}` : name));
  return out;
}

/**
 * The door for the components that are not modules (`erplora workflow-lint`): every WORKFLOW.md
 * under `root` with its parts, each prefix of `family`. With the `REC` family, the cross-component
 * journeys instead: every `*.md` of a `workflows/` folder but its README.md, each a full document.
 * A flow ID may appear once in the whole tree. Nothing to lint is a warning, like a module without
 * the file. Returns `{ errors, warnings, files, flows }`, paths relative to `root`.
 */
export function lintWorkflowTree(root, { family } = {}) {
  const errors = [];
  const warnings = [];
  const files = [];
  const flows = [];
  for (const rel of walkDirs(root)) {
    const label = rel ? `${rel}/` : '';
    if (family === 'REC') {
      if (rel.split('/').pop() !== 'workflows') continue;
      const docs = readdirSync(join(root, rel), { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md')
        .map((e) => e.name)
        .sort();
      for (const name of docs) {
        const file = `${label}${name}`;
        const r = lintWorkflowFile(readFileSync(join(root, rel, name), 'utf8'), { file, family });
        errors.push(...r.errors);
        warnings.push(...r.warnings);
        flows.push(...r.flows);
        files.push(file);
      }
      continue;
    }
    if (!existsSync(join(root, rel, WORKFLOW_FILE))) continue;
    const r = lintWorkflowDir(join(root, rel), { family, label, duplicates: false });
    errors.push(...r.errors);
    warnings.push(...r.warnings);
    flows.push(...r.flows);
    files.push(...r.files);
  }
  errors.push(...duplicateFlowErrors(flows, { acrossFilesOnly: true }));
  if (!files.length) {
    warnings.push(
      family === 'REC'
        ? 'no `workflows/*.md` journey to lint yet (ERPlora/pm#621)'
        : `no ${WORKFLOW_FILE} to lint yet — every component repo carries one at its root (ERPlora/pm#621)`,
    );
  }
  return { errors, warnings, files, flows };
}

/**
 * The module door (`erplora validate`). The prefix is the module id in upper case. No WORKFLOW.md
 * = a warning while the migration is open; a malformed one = errors.
 */
export function checkWorkflowDoc(dir, manifest) {
  const prefix = String(manifest?.id ?? '').toUpperCase() || undefined;
  const { errors, warnings, found } = lintWorkflowDir(dir, { prefix });
  if (!found) {
    warnings.unshift(
      `no ${WORKFLOW_FILE} yet — the module's functional spec (screens, flows, \`Implicados\`) that workers, ` +
        `reviewers and QA read before touching it; prefix \`${prefix}\` (ERPlora/pm#621, architecture/contracts/workflow-contract.md)`,
    );
  }
  return { errors, warnings };
}
