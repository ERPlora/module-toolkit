// Unknown manifest keys, against the canonical schema (module-toolkit#30).
//
// THE HOLE THIS CLOSES. `whatsapp_inbox` declared `events.emit` (SINGULAR) for months where the
// contract says `events.emits`. The runtime saw no declared event and left the module in compatible
// mode instead of strict. None of the three doors caught it: `validate.mjs` did not mention
// `events` on a single line, the hub's JSON Schema was loaded by no process at all, and the SaaS
// publish validator only checks id/name/version. Three hand-written validators, divergent, and not
// one of them able to notice a key that does not exist.
//
// HOW. The known keys are NOT written here: they are READ from the canonical schema
// (`schemas/module.schema.json`, vendored from the hub and verified byte for byte against it). A
// new block of the contract becomes known as soon as the schema is synced; there is no list to keep.
//
// SEVERITY follows the runtime's policy (hub#521, `crates/runtime/src/manifest.rs`), because the
// author's door and the install door have to say the same thing. Inside an operation or a guard,
// ignoring a field leaves the module WRONG — a command without the guard its author declared, a
// migration whose reach is not what it says — and that is REFUSED. Everywhere else the cost is a
// screen, a button or a checklist item, and that is REPORTED.
import { loadManifestSchema } from './manifest-schema.mjs';

/**
 * Where an unknown key is refused rather than reported. Mirror of `refuses_unknown_fields`
 * (`hub/crates/runtime/src/manifest.rs`), in its notation: `*` = any key of the map, `[]` = any
 * item of the array, the empty string = the root of the document.
 * `test/canonical-mirrors.test.mjs` fails if the two lists ever diverge.
 */
export const REFUSED_PATHS = [
  'commands.*',
  'queries.*',
  'events',
  'events.listen.*',
  'capabilities',
  'migrations',
  'seed',
  'roles[]',
  'scheduled_tasks[]',
  'records.*',
];

/**
 * RETIRED names: they sit where an unknown key would be refused, they are carried by manifests
 * already published, and they do nothing. Refusing them would be the consistent reading — and would
 * leave `inventory` and `services` unable to pass their own gate. They are reported by name,
 * pointing at the issue that decides their fate. Every entry is a debt with a number; the list is
 * not a place to park a field to make a warning go away (a test asserts a retired name is never
 * also a known one). `[path, field, explanation]` — mirror of the runtime's `RETIRED_FIELDS`.
 */
export const RETIRED_FIELDS = [
  [
    'commands.*',
    'validates',
    'lo declaran 7 commands de `inventory`/`services` y el runtime NUNCA lo implementó (hub#610): ' +
      'la validación que describe NO se ejecuta — usa `reads` + `expect_rows`',
  ],
];

/** Resolves an internal `$ref` (`#/$defs/widget`) against the root of the schema. */
function deref(node, root, seen = 0) {
  if (!node || typeof node !== 'object' || seen > 16) return null;
  if (!node.$ref) return node;
  const target = node.$ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((acc, part) => acc?.[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
  return deref(target, root, seen + 1);
}

/**
 * Every subschema that applies to the SAME document node: the node itself plus the branches of
 * `allOf`/`anyOf`/`oneOf`/`then`/`else`. They are unioned, not evaluated: nothing here decides
 * whether the document is valid, only WHICH KEYS it may carry — and a key any branch admits is not
 * unknown. Unioning is the safe direction: it never invents an unknown that is not one.
 */
function variants(node, root, out = [], seen = 0) {
  const n = deref(node, root, seen);
  if (!n || seen > 16) return out;
  out.push(n);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    for (const branch of n[key] ?? []) variants(branch, root, out, seen + 1);
  }
  for (const key of ['then', 'else']) {
    if (n[key]) variants(n[key], root, out, seen + 1);
  }
  return out;
}

/** Bounded edit distance, used only to suggest the key the author meant to write. */
function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let corner = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(prev[j] + 1, prev[j - 1] + 1, corner + (a[i - 1] === b[j - 1] ? 0 : 1));
      corner = prev[j];
      prev[j] = next;
    }
  }
  return prev[b.length];
}

/** The closest known key, when it is close enough to be worth naming. */
function didYouMean(key, known) {
  let best = null;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d <= Math.max(1, Math.floor(candidate.length / 4)) && (best === null || d < best.d)) {
      best = { candidate, d };
    }
  }
  return best?.candidate ?? null;
}

/**
 * Walks the document alongside the schema and reports the keys the contract does not admit.
 * Returns `{ errors, warnings }` (lists of formatted strings).
 */
export function checkManifestKeys(manifest, schema = loadManifestSchema()) {
  const errors = [];
  const warnings = [];
  walk(manifest, schema, '', '', { root: schema, errors, warnings });
  return { errors, warnings };
}

// A string the schema constrains (`pattern`, `maxLength`, `minLength`) is judged HERE, against the
// schema — never against a regex copied into this file, which is the drift #30/#40 removed.
//
// Why it is an error and not a warning: these shapes are the ones the RUNTIME enforces. It refuses
// a `static_files.folder` that walks out of `media/modules/` at install time
// (`module_static_files.rs`), so a manifest that passes here and fails there does not fail on the
// author's machine — it fails on a customer's hub, after publishing.
function checkScalar(value, node, displayPath, ctx) {
  if (typeof value !== 'string') return;
  for (const v of variants(node, ctx.root)) {
    if (v.type !== 'string') continue;
    if (v.pattern && !new RegExp(v.pattern).test(value)) {
      ctx.errors.push(
        `${displayPath}: valor inválido \`${value}\` — el contrato exige \`${v.pattern}\`. ` +
          'El runtime aplica esta misma forma, así que un manifest que pase aquí y no allí ' +
          'falla en el hub de un cliente, no en tu máquina.',
      );
      return;
    }
    if (v.maxLength !== undefined && value.length > v.maxLength) {
      ctx.errors.push(`${displayPath}: \`${value}\` supera el máximo de ${v.maxLength} caracteres del contrato.`);
      return;
    }
    if (v.minLength !== undefined && value.length < v.minLength) {
      ctx.errors.push(`${displayPath}: \`${value}\` no llega al mínimo de ${v.minLength} caracteres del contrato.`);
      return;
    }
  }
}

function walk(value, node, contractPath, displayPath, ctx) {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    const items = variants(node, ctx.root).find((v) => v.items)?.items;
    if (!items) return;
    value.forEach((item, i) => {
      checkScalar(item, items, `${displayPath}[${i}]`, ctx);
      walk(item, items, `${contractPath}[]`, `${displayPath}[${i}]`, ctx);
    });
    return;
  }

  // What this level admits, unioned over every branch that applies.
  const known = new Map();
  let mapValueSchema = null;
  for (const v of variants(node, ctx.root)) {
    for (const [k, sub] of Object.entries(v.properties ?? {})) if (!known.has(k)) known.set(k, sub);
    if (v.additionalProperties && typeof v.additionalProperties === 'object') {
      mapValueSchema ??= v.additionalProperties;
    }
  }

  // An OPEN MAP (`commands`, `queries`, `widgets`, `events.listen`): the key is the NAME of the
  // operation, not a field of the contract. It is not judged; the walk goes down into its value.
  if (mapValueSchema) {
    for (const [k, sub] of Object.entries(value)) {
      const inner = known.get(k) ?? mapValueSchema;
      walk(sub, inner, `${contractPath}${contractPath ? '.' : ''}*`, joinDisplay(displayPath, k), ctx);
    }
    return;
  }

  // When the schema declares no properties here, this level is free-form JSON (a scheduled task's
  // `payload`, an `ai` block): there is no contract to judge, and opining would be pure noise.
  if (known.size === 0) return;

  for (const [k, sub] of Object.entries(value)) {
    if (known.has(k)) {
      checkScalar(sub, known.get(k), joinDisplay(displayPath, k), ctx);
      walk(sub, known.get(k), contractPath ? `${contractPath}.${k}` : k, joinDisplay(displayPath, k), ctx);
      continue;
    }
    report(k, contractPath, displayPath, [...known.keys()], ctx);
  }
}

function joinDisplay(displayPath, key) {
  return displayPath ? `${displayPath}.${key}` : key;
}

function report(key, contractPath, displayPath, known, ctx) {
  const where = displayPath ? `${displayPath}.${key}` : key;
  const retired = RETIRED_FIELDS.find(([p, f]) => p === contractPath && f === key);
  if (retired) {
    ctx.warnings.push(`${where}: campo RETIRADO — ${retired[2]}`);
    return;
  }
  const suggestion = didYouMean(key, known);
  const hint = suggestion ? ` ¿querías decir \`${suggestion}\`?` : ` (el contrato admite: ${known.join(', ')})`;
  const line = `${where}: clave desconocida \`${key}\` — no está en el contrato del manifest.${hint}`;
  if (REFUSED_PATHS.includes(contractPath)) {
    ctx.errors.push(
      `${line} Aquí se rechaza porque cambia lo que se EJECUTA o quién puede ejecutarlo: ` +
        'el runtime la ignoraría en silencio y el módulo haría algo distinto de lo que dice.',
    );
  } else {
    ctx.warnings.push(line);
  }
}
