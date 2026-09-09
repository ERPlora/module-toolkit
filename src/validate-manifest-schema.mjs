// The manifest EVALUATED against the canonical schema (module-toolkit#247).
//
// THE HOLE THIS CLOSES. `schemas/module.schema.json` — the hub's contract, vendored here and
// watched byte for byte — was read for exactly one thing: which key NAMES exist
// (`validate-manifest-keys.mjs`). Everything the schema says about the CONTENT was evaluated by
// nobody: `required`, `type`, `minimum`, the `oneOf` that makes a widget either declarative or an
// escape hatch, the `if/then` that forbids `update` on an immutable record. So a block written
// half way through — `billing.usage` without `used` — printed the very same lines, word for word,
// as a correct one, the module published, and the screen just did not appear in the hub: no error,
// no warning, nothing to look at.
//
// WHY AJV AND NOT ANOTHER HAND-WRITTEN WALKER. There are already two stand-ins in this repository
// for rules the walker cannot evaluate (`validate-row-gates.mjs`, `validate-emit-dedup-key.mjs`),
// which is the measure of how far a hand-rolled evaluator gets before it needs help. Draft 2020-12
// with `$ref`, `allOf`, `if/then`, `oneOf` + `not` and `propertyNames` is not a weekend's work, and
// a subtly wrong evaluator produces exactly the silent green this issue is about. ajv is five
// packages and 2.7 MB, and the gate installs it the same way it already installs `typescript`.
//
// SEVERITY is the runtime's line (hub#521), the same one `checkManifestKeys` draws: inside an
// operation or a guard, a field the runtime ignores leaves the module WRONG, and that is REFUSED;
// everywhere else it costs a screen, and that is REPORTED. `REFUSED_PATHS` is imported, never
// copied — one policy, one list.
//
// THE RISK HERE IS THE FALSE POSITIVE. This door blocks 27 repositories at once. Measured on
// 2026-09-09 across the 27 live manifests, full evaluation raises TWO findings, both genuine and
// both warnings (`ai_context` as a string in `reservations` and `tasks`), so the fleet stays green
// on the first pass. Two rules keep it that way, and both err towards saying less:
//
//   1. what `checkManifestKeys` already reports is NOT reported again (see `OWNED_ELSEWHERE`);
//   2. an error that comes from INSIDE a branch of an alternation is never stated on its own — a
//      failing `oneOf` branch is not a defect, it is one reading that did not apply. Those travel
//      as the REASONS of a single message about the alternation itself.
import Ajv2020 from 'ajv/dist/2020.js';
import { loadManifestSchema } from './manifest-schema.mjs';
import { REFUSED_PATHS, variants } from './validate-manifest-keys.mjs';

/**
 * Keywords `checkManifestKeys` already reports, with a better message than ajv's: it names the key,
 * suggests the one the author meant, and lists the closed vocabulary. Reporting them twice, in two
 * wordings, is how one mistake becomes two lines the author has to reconcile.
 */
const OWNED_ELSEWHERE = new Set(['additionalProperties', 'pattern', 'maxLength', 'minLength', 'enum']);

/** The keywords that state an ALTERNATION failed. Their sub-errors are branch readings, not defects. */
const ALTERNATION = new Set(['oneOf', 'anyOf', 'not', 'if']);

/**
 * An error whose `schemaPath` goes THROUGH a branch is conditional: it is what one alternative had
 * to say, not what the document does wrong. `allOf` is deliberately absent — every one of its
 * branches has to hold, so an error under it is unconditional.
 */
const INSIDE_A_BRANCH = /\/(oneOf|anyOf|not|if|then|else)\//;

/** ajv compiles a 1.400-line schema in milliseconds, but `validate` is called once per module. */
const compiled = new WeakMap();

function validatorFor(schema) {
  let validate = compiled.get(schema);
  if (!validate) {
    // `strict: false` because the schema is NOT ours to fix: it is the hub's, vendored, and
    // `canonical-mirrors.test.mjs` fails if a byte of it differs. ajv's strict mode opines about
    // how a schema is WRITTEN (an unknown keyword, a `default` inside a `$ref`), and acting on
    // those opinions here would mean editing the mirror.
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/** JSON Pointer segments, unescaped (`~1` to `/`, `~0` to `~`). */
function pointerSegments(instancePath) {
  if (!instancePath) return [];
  return instancePath
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Walks the document alongside the schema to name a node twice:
 *
 *   `display`  — the way the AUTHOR wrote it: `commands.demo.do.reads[0]`;
 *   `contract` — the way the runtime's policy is written: `commands.*`, `roles[]`.
 *
 * `parent` is the container's contract path, which is what decides severity for a value: a wrong
 * type on a command's `sql` is refused because it sits inside the command, not because `sql` is on
 * a list.
 */
function locate(segments, manifest, schema) {
  let node = schema;
  let value = manifest;
  let display = '';
  const contract = [];
  let parent = '';

  for (const seg of segments) {
    parent = contract.join('.');
    if (Array.isArray(value)) {
      // The item of an array is not a new level of the contract: it is the array's own level.
      contract[contract.length - 1] = `${contract[contract.length - 1]}[]`;
      parent = contract.slice(0, -1).join('.');
      display += `[${seg}]`;
      node = variants(node, schema).find((v) => v.items)?.items ?? {};
      value = value[Number(seg)];
      continue;
    }
    let property = null;
    let mapValue = null;
    for (const v of variants(node, schema)) {
      if (property === null && v.properties?.[seg] !== undefined) property = v.properties[seg];
      if (mapValue === null && v.additionalProperties && typeof v.additionalProperties === 'object') {
        mapValue = v.additionalProperties;
      }
    }
    // An OPEN MAP (`commands`, `queries`, `widgets`): the key is the NAME of the operation the
    // author chose, so the contract calls it `*` while the author sees the name they wrote.
    contract.push(property !== null ? seg : mapValue !== null ? '*' : seg);
    display = display ? `${display}.${seg}` : seg;
    node = property ?? mapValue ?? {};
    value = value?.[seg];
  }

  return { display: display || 'el manifest', contract: contract.join('.'), parent };
}

/**
 * Where the runtime REFUSES rather than reports. A defect one level inside a refused container is
 * refused too: a command whose `sql` is a number is as broken as a command with an unknown key, and
 * `commands.*` is the level the runtime's own list names. One level only — going all the way down
 * would refuse a typo in a widget's option, which costs a screen, not an operation.
 */
function isRefused({ contract, parent }) {
  return REFUSED_PATHS.includes(contract) || REFUSED_PATHS.includes(parent);
}

const TYPE_NAMES = {
  string: 'texto',
  number: 'un número',
  integer: 'un entero',
  boolean: 'un booleano',
  object: 'un objeto',
  array: 'una lista',
  null: 'nulo',
};

function actualType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function valueAt(segments, manifest) {
  let value = manifest;
  for (const seg of segments) value = value?.[Array.isArray(value) ? Number(seg) : seg];
  return value;
}

/**
 * What went wrong, in one clause. The keywords an author actually meets are written out; anything
 * rarer falls back to ajv's own sentence rather than to an invented one — a validator that
 * paraphrases a rule it does not know is how a wrong message becomes a wrong fix.
 */
function reason(err, manifest) {
  const p = err.params ?? {};
  switch (err.keyword) {
    case 'required':
      return `falta el campo obligatorio \`${p.missingProperty}\``;
    case 'type': {
      const declared = [].concat(p.type);
      const want = declared.map((t) => TYPE_NAMES[t] ?? `\`${t}\``).join(' o ');
      const got = actualType(valueAt(pointerSegments(err.instancePath), manifest));
      return `el contrato exige ${want} (\`${declared.join('|')}\`) y aquí hay \`${got}\``;
    }
    case 'const':
      return `el contrato solo admite \`${JSON.stringify(p.allowedValue)}\``;
    case 'minimum':
    case 'exclusiveMinimum':
    case 'maximum':
    case 'exclusiveMaximum':
      return `el valor está fuera del rango del contrato (${err.message})`;
    case 'minItems':
      return `la lista necesita al menos ${p.limit} elemento(s)`;
    case 'uniqueItems':
      return 'la lista repite un elemento y el contrato la exige sin repetidos';
    case 'false schema':
      return 'el contrato no admite este campo aquí';
    case 'not':
      return 'declara a la vez cosas que el contrato considera excluyentes';
    case 'oneOf':
    case 'anyOf':
      return 'no encaja con ninguna de las formas que admite el contrato';
    case 'if':
      return 'incumple una regla condicional del contrato';
    default:
      return err.message ?? 'no cumple el contrato';
  }
}

const TAIL =
  '. El contrato es el mismo que aplica el hub, así que esto no falla en tu máquina: o el ' +
  'instalador rechaza el módulo, o la parte que declaraste simplemente no aparece en pantalla, ' +
  'sin decírselo a nadie (module-toolkit#247).';

/**
 * Evaluates `manifest` against the canonical schema and returns `{ errors, warnings }` — lists of
 * formatted strings, the same shape `checkManifestKeys` returns.
 */
export function checkManifestSchema(manifest, schema = loadManifestSchema()) {
  const errors = [];
  const warnings = [];
  const validate = validatorFor(schema);
  if (validate(manifest)) return { errors, warnings };

  const raw = validate.errors ?? [];
  // An alternation nested INSIDE another one's branch is not a second defect: the widget's `oneOf`
  // holds a `not` in each arm, so declaring `kind` and `component` together makes ajv emit three
  // errors for one mistake. Only the OUTERMOST alternation speaks; the rest become its reasons.
  const anchors = raw.filter((e) => ALTERNATION.has(e.keyword) && !INSIDE_A_BRANCH.test(e.schemaPath ?? ''));
  const reasonsOf = new Map(anchors.map((e) => [`${e.instancePath} ${e.keyword}`, []]));

  const anchorFor = (err) => {
    let best = null;
    for (const a of anchors) {
      if (a === err) continue;
      const applies = a.instancePath === err.instancePath || err.instancePath.startsWith(`${a.instancePath}/`);
      if (!applies) continue;
      if (!best || a.instancePath.length > best.instancePath.length) best = a;
    }
    return best;
  };

  const standalone = [];
  for (const err of raw) {
    if (anchors.includes(err)) continue;
    if (ALTERNATION.has(err.keyword) || INSIDE_A_BRANCH.test(err.schemaPath ?? '')) {
      const anchor = anchorFor(err);
      // No anchor is unreachable with ajv (it always emits the parent alternation), and if a future
      // version stops doing it the error is stated on its own rather than dropped: this validator
      // exists because silence is the failure mode that costs, not noise.
      if (anchor) {
        reasonsOf.get(`${anchor.instancePath} ${anchor.keyword}`).push(err);
        continue;
      }
    }
    if (OWNED_ELSEWHERE.has(err.keyword)) continue;
    standalone.push(err);
  }

  const emit = (segments, text) => {
    const at = locate(segments, manifest, schema);
    (isRefused(at) ? errors : warnings).push(`${at.display}: ${text}${TAIL}`);
  };

  for (const err of standalone) emit(pointerSegments(err.instancePath), reason(err, manifest));

  for (const anchor of anchors) {
    const segments = pointerSegments(anchor.instancePath);
    const at = locate(segments, manifest, schema);
    // Deduplicated: the two arms of a `oneOf` that both fail with `not` say the same sentence.
    const why = [
      ...new Set(
        reasonsOf.get(`${anchor.instancePath} ${anchor.keyword}`).map((e) => {
          const inner = locate(pointerSegments(e.instancePath), manifest, schema);
          const where = inner.display === at.display ? '' : `${inner.display}: `;
          return `${where}${reason(e, manifest)}`;
        }),
      ),
    ];
    const detail = why.length ? `${reason(anchor, manifest)} — ${why.join('; ')}` : reason(anchor, manifest);
    emit(segments, detail);
  }

  return { errors, warnings };
}
