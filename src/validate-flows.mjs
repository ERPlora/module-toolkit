// The `flows/` package contract: the automations a module ships with (module-toolkit#209).
//
// WHAT WAS OPEN. A module writes its automations in `flows/` — the flow document, the grants it
// will ask for, and the version floor it needs — publishes, and they reached NO hub: `erplora pack`
// did not carry the folder into the zip. So the only way a customer ever saw one was a hand-written
// COPY of the template in the gallery of the `flows` module, and a copy of a document that nothing
// validates falls behind: it did three times in a single day, and one resync cost 23.2M tokens.
//
// Carrying the folder is `pack.mjs`. This file is the other half: judging what is inside it, in the
// only door that runs before publishing.
//
// WHAT IT JUDGES — the PACKAGE contract, not the automation:
//
//   · the NAME: `<family>.<lang>.flow.json`, with `<family>.grants.json` beside it and an optional
//     `<family>.requires.json`. A stray file in `flows/` is refused, because no reader would ever
//     open it — the same silence the whole issue is about;
//   · the SOURCE language: every family carries its `en` document (ADR-0055). English is the source
//     and the rest are translations, so a family without it has no original;
//   · the DOCUMENT, against the FROZEN root of `flow.schema.json` — `schema_version`, a non-empty
//     `steps`, no unknown root key, and every step with an `id` and a `kind` of the frozen
//     vocabulary. Nothing closed is typed here: it is all READ from the vendored schema
//     (`src/flow-schema.mjs`), which `test/canonical-mirrors.test.mjs` pins to the hub's;
//   · the TRIGGERS, against `$defs/trigger` of the same schema — a CLOSED object with a frozen
//     `kind` vocabulary. Machinery the hub refuses when unknown, and until the review of
//     module-toolkit#214 nothing here read it: a `kind: webhook` published green in both languages;
//   · the TRANSLATION: the languages of one family must declare the SAME steps in the SAME order,
//     each step the SAME machinery (`kind`, `command`, `tools`, `when`, `channel`… — everything but
//     its prose, `PROSE_STEP_KEYS`), and carry the SAME triggers — whole, down to the `filter` and
//     the `input`. A translation is words, never automation. When the halves drift, a Spanish hub
//     runs something different from an English one and nothing says so;
//   · and the other sign of the same check: the WORDS of a translation are not the English ones.
//     A prose leaf copied word for word (two words or more, `isWords`) is a sentence nobody
//     translated, and it reaches a Spanish customer in English (module-toolkit#227).
//
// WHAT IT DOES NOT. Whether the grants cover what the steps actually use, and whether the prompt
// orders a tool the module really has, is the SEMANTICS of the automation: that lives in the
// module's own battery (`whatsapp_inbox/tests/flow_templates.test.py`), which is where the domain
// and the neighbouring modules are. This door is about the package.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadFlowSchema } from './flow-schema.mjs';

/** `<family>.<lang>.flow.json` — the only shape a template document may be named. */
const DOCUMENT = /^([a-z][a-z0-9-]*)\.([a-z]{2})\.flow\.json$/;

/** Source language of every string ERPlora ships (ADR-0055): the rest are translations of it. */
export const SOURCE_LANGUAGE = 'en';

/**
 * The languages a template MUST carry: the English source and its Spanish (ADR-0055/0199).
 *
 * A template is user-visible text — the card the owner reads in the gallery, and the words the
 * customer reads on WhatsApp — and the standing rule is the English string AND its `es`. Shipping
 * only `en` installs green and then writes to a Spanish salon's customers in English. Found by a
 * mutant on `whatsapp_inbox`: deleting its Spanish document left this door open.
 */
export const REQUIRED_LANGUAGES = [SOURCE_LANGUAGE, 'es'];

/** The sidecars of a family, and whether every family must carry one. */
const SIDECARS = [
  { suffix: '.grants.json', key: 'grants', required: true },
  { suffix: '.requires.json', key: 'requires', required: false },
];

/**
 * The keys of a step that carry PROSE — the only thing a translation may legitimately change.
 * Everything else in a step is machinery (`kind`, `command`, `query`, `tools`, `when`, `channel`,
 * `to`, `policy`, `max_iters`…) and has to be the same in every language, or the step is another
 * automation wearing the same id: the Spanish hub calls a tool the English one never hands out.
 *
 * A policy of this door, not of the schema — `flow.schema.json` does not tell prose from
 * machinery. Every key here is a key of `$defs/step` (test-guarded, so a renamed key cannot leave a
 * stale entry), and measured on `whatsapp_inbox` before it was written: between `en` and `es` only
 * `prompt` and `vars` ever differ. `template` is here because on email it doubles as the subject.
 */
export const PROSE_STEP_KEYS = ['prompt', 'vars', 'params', 'body', 'headers', 'title', 'summary', 'template'];

/**
 * The prose that lives INSIDE a key which is not prose — the MIXED keys, judged path by path.
 *
 * `PROSE_STEP_KEYS` reads a key as one thing or the other. That held until the kernel grew two
 * keys that are both at once:
 *
 *   · `interactive` (hub#1633) — Meta's object as it travels to the phone. Its `type`, the `rows`
 *     it maps and the `id` a row sends back are machinery; its `body.text`, the button of the
 *     action and the title of a section are THE WORDS THE CUSTOMER READS. Compared whole, a
 *     Spanish salon is made to send `Tap whichever slot suits you.` — or the author moves the
 *     words out and the message goes out in English, which is the bug this door exists to stop;
 *   · `output` (hub#1639) — what an `ai` step publishes, `{<field>: {type, describe}}`. The `type`
 *     is the closed vocabulary the kernel enforces and the field NAME is what later steps read by
 *     `steps.<id>.<field>`, so both are machinery; the `describe` is the only thing the MODEL is
 *     told about the field, and a model briefed in English on a Spanish conversation answers worse.
 *
 * A path is masked out of the comparison, never dropped from it: everything the path does not name
 * keeps being compared, so `rows` pointing somewhere else is still drift. `*` matches any key
 * (the field names of `output` are the author's), `[]` any item of a list — and only of a LIST, so
 * `rows: "steps.pick.slots"`, a mapping path, is compared as the machinery it is.
 *
 * Same policy of the door as the list above, and guarded the same way: every path here hangs from
 * a key of `$defs/step`, so a key the hub renames cannot leave a path masking nothing.
 */
export const PROSE_STEP_PATHS = [
  'interactive.header.text',
  'interactive.body.text',
  'interactive.footer.text',
  'interactive.action.button',
  'interactive.action.sections[].title',
  'interactive.action.sections[].rows[].title',
  'interactive.action.sections[].rows[].description',
  'interactive.action.buttons[].reply.title',
  'output.*.describe',
];

/** `{interactive: [[header, text], …], output: [[*, describe]]}` — the paths, by the key they hang from. */
const PROSE_PATHS_BY_KEY = PROSE_STEP_PATHS.reduce((by, path) => {
  const [root, ...rest] = path.split('.').flatMap((s) => (s.endsWith('[]') ? [s.slice(0, -2), '[]'] : [s]));
  by.set(root, [...(by.get(root) ?? []), rest]);
  return by;
}, new Map());

/** What a masked-out leaf reads as: a value no document can carry, so it cannot collide with one. */
const PROSE = Symbol('prose');

/**
 * `value` with the prose the `paths` name replaced by `PROSE`, so two languages that only differ
 * in words compare equal. A path that does not fit the value it lands on (`[]` on a string, a key
 * that is not there) masks nothing: the value goes through untouched and is compared as machinery.
 */
function maskProse(value, paths) {
  if (paths.some((path) => path.length === 0)) return PROSE;
  if (Array.isArray(value)) {
    const inside = paths.filter((path) => path[0] === '[]').map((path) => path.slice(1));
    return inside.length ? value.map((item) => maskProse(item, inside)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const masked = {};
  for (const [key, inner] of Object.entries(value)) {
    const inside = paths.filter((path) => path[0] === key || path[0] === '*').map((path) => path.slice(1));
    masked[key] = inside.length ? maskProse(inner, inside) : inner;
  }
  return masked;
}

/**
 * Whether a string is WORDS a person or the model reads, and so something a translation must
 * change: with its `{{…}}` placeholders taken out, it still carries two words or more.
 *
 * The cut of module-toolkit#227. The prose keys also carry what is not prose — a mapping path
 * (`input.appointment_id`, one token with no space), a placeholder (`+{{input.from}}`), an empty
 * template — and one word may legitimately be the same in both languages (`WhatsApp`, `OK`).
 * Two words that match word for word are a copied sentence: `See slots`, `Tap whichever slot suits
 * you`. What it lets through is an untranslated ONE-word label; a door that also refused `WhatsApp`
 * would be noise, and noise is the door authors learn to route around.
 */
function isWords(text) {
  const words = text
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .split(/\s+/)
    .filter((token) => /\p{L}/u.test(token));
  return words.length >= 2;
}

/**
 * The prose leaves of `value` as `[path, text]`: every string under it when `paths` holds the empty
 * path (a whole prose key), else only the strings the `paths` of a mixed key reach. The path is
 * concrete — `interactive.action.sections[0].title` — so the finding tells the author which string.
 */
function proseLeaves(value, paths, at, out = []) {
  if (paths.some((path) => path.length === 0)) {
    if (typeof value === 'string') out.push([at, value]);
    else if (Array.isArray(value)) value.forEach((item, i) => proseLeaves(item, [[]], `${at}[${i}]`, out));
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) proseLeaves(inner, [[]], `${at}.${key}`, out);
    }
    return out;
  }
  if (Array.isArray(value)) {
    const inside = paths.filter((path) => path[0] === '[]').map((path) => path.slice(1));
    if (inside.length) value.forEach((item, i) => proseLeaves(item, inside, `${at}[${i}]`, out));
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  for (const [key, inner] of Object.entries(value)) {
    const inside = paths.filter((path) => path[0] === key || path[0] === '*').map((path) => path.slice(1));
    if (inside.length) proseLeaves(inner, inside, `${at}.${key}`, out);
  }
  return out;
}

/** Every prose leaf of a step — its prose keys whole, the prose paths of its mixed keys. */
function stepProse(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
  const leaves = [];
  for (const [key, value] of Object.entries(step)) {
    if (PROSE_STEP_KEYS.includes(key)) proseLeaves(value, [[]], key, leaves);
    else if (PROSE_PATHS_BY_KEY.has(key)) proseLeaves(value, PROSE_PATHS_BY_KEY.get(key), key, leaves);
  }
  return leaves;
}

/**
 * The prose paths of a translated step that are the English words, word for word — a sentence
 * nobody translated. The parity check masks prose on both sides, so to it a copied sentence and
 * a translated one look the same; this is the half that tells them apart (module-toolkit#227).
 */
function untranslated(here, there) {
  const english = new Map(stepProse(there));
  return stepProse(here)
    .filter(([path, text]) => english.get(path) === text && isWords(text))
    .map(([path]) => path);
}

const MODULE_ID = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+/;

/** Documentation of the folder — prose, never read as a template. */
const IS_PROSE = /\.md$/i;

/**
 * The families under `flows/`, and every entry that is not one.
 *
 * @returns {{families: Map<string, {documents: Map<string, string>, grants: string|null, requires: string|null}>, problems: string[]}}
 */
export function readFlowsFolder(dir) {
  const families = new Map();
  const problems = [];
  const flowsDir = join(dir, 'flows');
  if (!existsSync(flowsDir)) return { families, problems };

  const family = (name) => {
    if (!families.has(name)) {
      families.set(name, { documents: new Map(), grants: null, requires: null });
    }
    return families.get(name);
  };

  for (const entry of readdirSync(flowsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      problems.push(
        `flows/${name}/: the contract is FLAT — a folder here is read by nobody. Name the ` +
          'template `<family>.<lang>.flow.json` next to its `<family>.grants.json`.',
      );
      continue;
    }
    if (IS_PROSE.test(name)) continue;

    const document = DOCUMENT.exec(name);
    if (document) {
      const [, base, lang] = document;
      const languages = family(base).documents;
      languages.set(lang, name);
      continue;
    }

    const sidecar = SIDECARS.find((s) => name.endsWith(s.suffix));
    if (sidecar) {
      family(name.slice(0, -sidecar.suffix.length))[sidecar.key] = name;
      continue;
    }

    if (name.endsWith('.flow.json')) {
      problems.push(
        `flows/${name}: a template is named \`<family>.<lang>.flow.json\` (lower case, words ` +
          'joined by `-`, a two-letter language) — this one names no language, so nothing can ' +
          'tell which hub should be offered it.',
      );
    } else {
      problems.push(
        `flows/${name}: unexpected file. \`flows/\` holds templates ` +
          '(`<family>.<lang>.flow.json`), their `<family>.grants.json` / `<family>.requires.json`, ' +
          'and documentation (`*.md`). Anything else travels in the zip and is opened by nobody.',
      );
    }
  }
  return { families, problems };
}

/** Reads a JSON file of the folder, or pushes the parse error. Returns `undefined` on failure. */
function parse(dir, name, errors) {
  try {
    return JSON.parse(readFileSync(join(dir, 'flows', name), 'utf8'));
  } catch (error) {
    errors.push(`flows/${name}: not readable as JSON — ${error.message}`);
    return undefined;
  }
}

/** The step ids of a document, in order — the shape a translation must not change. */
function stepIds(document) {
  return (Array.isArray(document?.steps) ? document.steps : []).map((step, index) =>
    typeof step?.id === 'string' && step.id ? step.id : `<step ${index + 1} with no id>`,
  );
}

/** What fires the flow, as readable text: `kind` and, for an event, its name. */
function triggerSummary(document) {
  return (Array.isArray(document?.triggers) ? document.triggers : [])
    .map((trigger) => (trigger?.event ? `${trigger.kind}:${trigger.event}` : String(trigger?.kind)))
    .join(', ');
}

/** JSON with the keys of every object sorted, so two equal triggers compare equal as text. */
function canonical(value) {
  // The one thing here that is not JSON: a leaf `maskProse` took out of the comparison. Rendered
  // unquoted, so it cannot be read as the string `"prose"` a document could legitimately carry.
  if (typeof value === 'symbol') return String(value.description);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * The keys where two trigger lists differ, named and sorted. A trigger carries
 * NO prose — `kind`, `event`, `filter`, `input`, `cron`, `at` are all machinery (`$defs/trigger`) —
 * so there is nothing in it a translation may legitimately change, and naming the key is what turns
 * «they differ» into something the author can act on.
 */
function triggerDrift(here, there) {
  const list = (document) => (Array.isArray(document?.triggers) ? document.triggers : []);
  const mine = list(here);
  const theirs = list(there);
  if (mine.length !== theirs.length) return ['triggers'];
  const drifted = new Set();
  for (let i = 0; i < mine.length; i += 1) {
    const a = mine[i] ?? {};
    const b = theirs[i] ?? {};
    if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
      if (canonical(a) !== canonical(b)) drifted.add('triggers');
      continue;
    }
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (canonical(a[key]) !== canonical(b[key])) drifted.add(key);
    }
  }
  return [...drifted].sort();
}

/**
 * The machinery keys where a translated step differs from its source: every key of either step
 * except the prose ones — and, for a MIXED key (`PROSE_STEP_PATHS`), except the prose inside it.
 * Two steps that only differ in words come back empty.
 */
function stepDrift(here, there) {
  const a = here && typeof here === 'object' && !Array.isArray(here) ? here : {};
  const b = there && typeof there === 'object' && !Array.isArray(there) ? there : {};
  const drifted = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (PROSE_STEP_KEYS.includes(key)) continue;
    const paths = PROSE_PATHS_BY_KEY.get(key);
    const mine = paths ? maskProse(a[key], paths) : a[key];
    const theirs = paths ? maskProse(b[key], paths) : b[key];
    if (canonical(mine) !== canonical(theirs)) drifted.push(key);
  }
  return drifted.sort();
}

/**
 * `triggers`, against `$defs/trigger`: a CLOSED object whose `kind` is a frozen vocabulary. The hub
 * refuses a trigger it cannot read, so one that passed here and died there would be the exact
 * silence this door exists to close — and both languages carrying the same wrong trigger is what
 * the parity check, on its own, calls a perfect match.
 */
function checkTriggers(where, document, schema, errors) {
  if (!('triggers' in document)) return;
  const trigger = schema.$defs?.trigger ?? {};
  const known = Object.keys(trigger.properties ?? {});
  const kinds = trigger.properties?.kind?.enum ?? [];
  if (!Array.isArray(document.triggers)) {
    errors.push(`${where}: \`triggers\` is a list of what fires the flow (${kinds.join(', ')}).`);
    return;
  }
  document.triggers.forEach((declared, index) => {
    const at = `${where}: trigger ${index + 1}`;
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      errors.push(`${at}: a trigger is a JSON object.`);
      return;
    }
    if (trigger.additionalProperties === false) {
      for (const key of Object.keys(declared)) {
        if (!known.includes(key)) {
          errors.push(
            `${at}: unknown key \`${key}\` — a trigger is CLOSED (the contract admits: ` +
              `${known.join(', ')}). The hub refuses what it cannot read.`,
          );
        }
      }
    }
    for (const key of trigger.required ?? []) {
      if (!(key in declared)) {
        errors.push(`${at}: \`${key}\` is required — without it nothing can tell what fires the flow.`);
      }
    }
    if (typeof declared.kind === 'string' && kinds.length && !kinds.includes(declared.kind)) {
      errors.push(
        `${at}: \`${declared.kind}\` is not something the hub can fire a flow on — the vocabulary ` +
          `is FROZEN (${kinds.join(', ')}).`,
      );
    }
  });
}

/** The document itself, against the FROZEN root and step vocabulary of `flow.schema.json`. */
function checkDocument(name, document, schema, errors) {
  const where = `flows/${name}`;
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    errors.push(`${where}: a flow document is a JSON object.`);
    return;
  }

  const known = Object.keys(schema.properties);
  for (const key of Object.keys(document)) {
    if (!known.includes(key)) {
      errors.push(
        `${where}: unknown key \`${key}\` — the root of a flow document is CLOSED ` +
          `(the contract admits: ${known.join(', ')}). The hub refuses what it cannot read ` +
          'rather than running the flow half-way.',
      );
    }
  }
  for (const key of schema.required ?? []) {
    if (!(key in document)) errors.push(`${where}: \`${key}\` is required by the flow contract.`);
  }

  const version = schema.properties.schema_version?.const;
  if ('schema_version' in document && document.schema_version !== version) {
    errors.push(
      `${where}: schema_version \`${document.schema_version}\` — this hub core only knows ` +
        `\`${version}\`, and an unknown version is REFUSED, never guessed.`,
    );
  }

  checkTriggers(where, document, schema, errors);

  const minimum = schema.properties.steps?.minItems ?? 1;
  if ('steps' in document) {
    if (!Array.isArray(document.steps) || document.steps.length < minimum) {
      errors.push(`${where}: \`steps\` must be a list of at least ${minimum} — a flow with no steps does nothing.`);
      return;
    }
  } else {
    return;
  }

  const step = schema.$defs?.step ?? {};
  const kinds = step.properties?.kind?.enum ?? [];
  const seen = new Set();
  document.steps.forEach((declared, index) => {
    const at = `${where}: step ${index + 1}`;
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
      errors.push(`${at}: a step is a JSON object.`);
      return;
    }
    for (const key of step.required ?? []) {
      if (typeof declared[key] !== 'string' || !declared[key]) {
        errors.push(`${at}: \`${key}\` is required — later steps read a step by its \`id\`.`);
      }
    }
    if (typeof declared.kind === 'string' && kinds.length && !kinds.includes(declared.kind)) {
      errors.push(
        `${at}: \`${declared.kind}\` is not a step the hub can run — the vocabulary is FROZEN ` +
          `(${kinds.join(', ')}).`,
      );
    }
    if (typeof declared.id === 'string' && declared.id) {
      if (seen.has(declared.id)) {
        errors.push(`${at}: \`${declared.id}\` is declared twice — a step id is unique in the document.`);
      }
      seen.add(declared.id);
    }
  });
}

/** `<family>.grants.json`: what the automation will ask the owner to grant before it can run. */
function checkGrants(name, sidecar, errors, warnings = [], languages = REQUIRED_LANGUAGES) {
  const where = `flows/${name}`;
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    errors.push(`${where}: the grants of a template are a JSON object with a \`grants\` list.`);
    return;
  }
  for (const key of Object.keys(sidecar)) {
    if (key !== 'grants' && !key.startsWith('_')) {
      errors.push(`${where}: unknown key \`${key}\` — only \`grants\` and \`_\`-prefixed notes.`);
    }
  }
  if (!Array.isArray(sidecar.grants) || sidecar.grants.length === 0) {
    errors.push(
      `${where}: \`grants\` must list at least one grant. A template that asks for nothing ` +
        'cannot read, write or notify anything either — it would install and do nothing.',
    );
    return;
  }
  sidecar.grants.forEach((grant, index) => {
    for (const key of ['kind', 'value']) {
      if (typeof grant?.[key] !== 'string' || !grant[key]) {
        errors.push(`${where}: grant ${index + 1} has no \`${key}\` — a grant is \`{ kind, value }\`.`);
      }
    }
    checkGrantPin(where, grant, index, errors);
    checkGrantReason(where, grant, index, errors, warnings, languages);
  });
}

/**
 * The sentence that explains a grant to the owner (flows#114): `reason: { en, es }`.
 *
 * The gallery shows every grant of a recipe BEFORE it is installed, and without a sentence all it
 * can print is the internal name — fourteen `staff.schedules.list_for_member` the owner is asked
 * to authorise. Absent is a warning (the card still names the permission, once); present but
 * wrong is an error, because a reason in one language only shows a Spanish owner an English
 * sentence, or none, with nothing on the way saying so. The languages are exactly the ones the
 * family's documents ship: the reason is part of the same recipe, translated the same way.
 */
function checkGrantReason(where, grant, index, errors, warnings, languages) {
  if (!grant || typeof grant !== 'object') return;
  const label = `grant ${index + 1} (\`${grant.value}\`)`;
  if (grant.reason === undefined) {
    warnings.push(
      `${where}: ${label} has no \`reason\` — the owner will read its internal name instead of ` +
        'a sentence saying what it lets the automation do. Add `reason: { en, es }`.',
    );
    return;
  }
  const reason = grant.reason;
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) {
    errors.push(`${where}: ${label}: \`reason\` is \`{ ${languages.join(', ')} }\`, one sentence per language.`);
    return;
  }
  const wanted = [...languages].sort();
  const given = Object.keys(reason).sort();
  if (wanted.join(',') !== given.join(',')) {
    errors.push(
      `${where}: ${label}: \`reason\` is written in \`${given.join(', ') || 'nothing'}\` and the ` +
        `recipe ships \`${wanted.join(', ')}\` — the sentence travels in exactly the recipe's languages.`,
    );
  }
  for (const [lang, sentence] of Object.entries(reason)) {
    if (typeof sentence !== 'string' || !sentence.trim()) {
      errors.push(`${where}: ${label}: \`reason.${lang}\` is not a sentence.`);
    }
  }
}

/**
 * The PIN of a grant (hub#1623, widened by hub#1662): a grant may FIX part of the values it will be
 * handed, so «may cancel appointments AS THE CUSTOMER» stops being the same permission as «may
 * cancel appointments», and «may read THIS customer's diary» stops being «may read the diary». It
 * is what contains a template whose `params` a model writes from a stranger's message.
 *
 * Both rules below are the HUB's (`flows::grants::replace`), repeated here for the one reason this
 * file exists: without them the module publishes green and the owner meets the refusal at
 * `PUT …/grants`, three steps away from anyone who can fix it.
 *
 * The three lists below are the hub's, and `test/contracts.test.mjs` holds each one EXACTLY equal
 * to its section of the vendored `contracts/kernel/engine.snapshot` (`[flow_pin_kinds]`,
 * `[flow_pin_roots]`, `[flow_path_roots]`), so a resync that moves the hub turns red here (mt#234).
 *
 * 🔴 And that mirror cuts BOTH ways: while this door refused what the hub had started allowing,
 * the module could not publish at all. Measured in whatsapp_inbox#119 — the pin the kernel landed
 * for it (hub#1662) was rejected here, so the security fix could not ship.
 */
/**
 * The kinds a pin can restrict, mirroring `GrantKind::can_pin` in the hub: the ones ever HANDED
 * values to judge — a `command`'s payload (hub#1623) and a `query`'s parameters (hub#1662). A pin
 * on any other kind would put a restriction on the owner's screen that nothing applies.
 */
export const CAN_PIN = new Set(['command', 'query']);

/**
 * The roots a pin may REFERENCE, mirroring `PIN_ROOTS` in the hub. The run scope the executor
 * builds is `{ input, steps }` and nothing else (`grants.rs::run_scope`), so these two are all of
 * it. Both absences are deliberate and neither is an oversight:
 *
 * - `secret.…` would make the gate an ORACLE: «granted» exactly when a value equals the secret, and
 *   a caller that can retry reads it one guess at a time.
 * - `event.…` names something the run scope does not carry, so the pin could only ever deny — a
 *   permission that authorises nothing, which is the one thing a permission must not be.
 */
export const PIN_ROOTS = ['input', 'steps'];

/**
 * Every root the mapping language addresses, mirroring `def::PATH_ROOTS` — which in the hub is its
 * OWN list and knows nothing of `PIN_ROOTS`. `now` joined it with the run clock (hub#1694) and this
 * copy stayed at four, so a pin on `now.iso` published green and the hub refused it (mt#234).
 * `run` joined it with the call's own key, `run.idempotency_key` (hub#2675).
 * Two things ride on that:
 *
 * - It is the FULL list and not `PIN_ROOTS`: a dotted string whose root is none of these —
 *   `appointments.list`, `customer.vip` — is an ordinary LITERAL the hub stores without complaint,
 *   and refusing it here would stop a template from publishing something that works.
 * - It is written out and NOT derived from `PIN_ROOTS`. Deriving it looks tidier and is a trap:
 *   narrowing `PIN_ROOTS` would narrow this one with it, `input.…` would stop being a reference at
 *   all and the door would go quiet on exactly the value the hub still refuses. Measured — with the
 *   derived version, dropping `input` from `PIN_ROOTS` left the whole suite green.
 */
export const PATH_ROOTS = ['input', 'steps', 'event', 'secret', 'now', 'run'];

/** Is `text` a reference into the run rather than a literal? Mirrors `def::is_path` in the hub. */
function isRunPath(text) {
  const root = text.split('.')[0];
  return PATH_ROOTS.includes(root) && text.length > root.length + 1;
}

/**
 * Why the hub would refuse this fixed VALUE, or `null` if it would keep it — the mirror of
 * `grants.rs::check_pin_value`. Judged field by field, exactly as the hub iterates the pin: it asks
 * `pin_reference` of each written value and never descends, so a nested one is a literal to both.
 */
function pinValueProblem(written) {
  // A number, a bool, a structure: a literal, compared as it stands.
  if (typeof written !== 'string') return null;
  if (written.includes('{{')) {
    return (
      'a pin is a value, not text with templates in it — an UNRESOLVED `{{…}}` renders empty, so ' +
      'the pin would quietly stop matching and the containment would read as working while it ' +
      'denied everything; name the path on its own (`steps.<step>.<field>`) so its type survives'
    );
  }
  if (isRunPath(written) && !PIN_ROOTS.includes(written.split('.')[0])) {
    return (
      `\`${written}\` is not something a run carries; a pin may name ` +
      `${PIN_ROOTS.map((root) => `\`${root}.…\``).join(' or ')} and nothing else`
    );
  }
  return null;
}

function checkGrantPin(where, grant, index, errors) {
  const pin = grant?.payload;
  if (pin === undefined) return;
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) {
    errors.push(
      `${where}: grant ${index + 1} has a \`payload\` that is not an object — a pin is ` +
        '`{ "<field>": <fixed value> }`, and the hub refuses anything else ' +
        '(`flow.invalid_grant_payload`).',
    );
    return;
  }
  // An EMPTY pin fixes nothing, so it is the bare grant — and `'{}'` is what every row had before
  // hub#1623. Only a pin that actually restricts something has to name a kind that enforces it.
  if (Object.keys(pin).length > 0 && !CAN_PIN.has(grant.kind)) {
    errors.push(
      `${where}: grant ${index + 1} pins \`payload\` on a \`${grant.kind}\` grant, and only ` +
        `${[...CAN_PIN].map((k) => `\`${k}\``).join(' and ')} grants can fix values — the hub is ` +
        'handed values to judge at no other gate, so the fixed fields would restrict nothing ' +
        '(`flow.invalid_grant_payload`).',
    );
    return; // The kind is the first thing the hub refuses; it never reaches the values.
  }
  for (const [field, written] of Object.entries(pin)) {
    const problem = pinValueProblem(written);
    if (problem !== null) {
      errors.push(
        `${where}: grant ${index + 1} fixes \`${field}\` to something it cannot be: ${problem} ` +
          '(`flow.invalid_grant_payload`).',
      );
    }
  }
}

/** `<family>.requires.json`: the version floor of the modules whose operations the template uses. */
function checkRequires(name, sidecar, errors) {
  const where = `flows/${name}`;
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    errors.push(`${where}: the version floor is a JSON object with a \`modules\` map.`);
    return;
  }
  for (const key of Object.keys(sidecar)) {
    if (key !== 'modules' && !key.startsWith('_')) {
      errors.push(`${where}: unknown key \`${key}\` — only \`modules\` and \`_\`-prefixed notes.`);
    }
  }
  const modules = sidecar.modules;
  if (modules === undefined) return;
  if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) {
    errors.push(`${where}: \`modules\` is a map \`{ "<module id>": "<minimum version>" }\`.`);
    return;
  }
  for (const [id, floor] of Object.entries(modules)) {
    if (!MODULE_ID.test(id)) errors.push(`${where}: \`${id}\` is not a module id.`);
    if (typeof floor !== 'string' || !SEMVER.test(floor)) {
      errors.push(
        `${where}: \`${id}\` floors at \`${floor}\` — a floor is a SemVer version (\`1.1.69\`), ` +
          'because it is compared against the version installed on the hub.',
      );
    }
  }
}

/** Where the release workflow of a module repo lives, and the path filter that must list `flows`. */
const RELEASE_WORKFLOW = ['.github', 'workflows', 'release.yml'];
const PUBLISHES_FLOWS = /['"]?flows\/\*\*['"]?/;

/**
 * Warns when the module ships templates and its own release would never publish them.
 *
 * `release.yml` bumps the version and republishes only on the `paths:` it lists, so a merge that
 * touches ONLY a template leaves the published version where it was and the template reaches no
 * hub — the same failure this whole door exists to close, and the one already documented for
 * `locales/**`. It is a WARNING and not an error deliberately: an error would fail every open PR
 * of a module that ships templates today, and a guard that blocks work gets switched off.
 *
 * A module with no workflow at all — the scaffold, a temporary directory, what the gate unpacks —
 * says nothing: warning about something the author cannot act on is the noise that teaches people
 * to ignore the warning that matters.
 */
function checkReleasePublishesFlows(dir, warnings) {
  const workflow = join(dir, ...RELEASE_WORKFLOW);
  if (!existsSync(workflow)) return;
  let content;
  try {
    content = readFileSync(workflow, 'utf8');
  } catch {
    return;
  }
  if (PUBLISHES_FLOWS.test(content)) return;
  warnings.push(
    `${RELEASE_WORKFLOW.join('/')} does not list \`flows/**\` in its \`paths:\`, so a merge that ` +
      'touches only a template does not publish a version and the template reaches no hub — the ' +
      'same silence as an edit to `locales/**` before it was listed. Add it beside `locales/**`.',
  );
}

/**
 * Judges the `flows/` folder of a module. Returns `{ errors, warnings }` (arrays of strings); never
 * throws — the severity is `validate`'s call, as with every other check.
 */
export function checkFlows(dir, schema = loadFlowSchema()) {
  const errors = [];
  const warnings = [];
  const { families, problems } = readFlowsFolder(dir);
  errors.push(...problems);

  for (const [name, family] of families) {
    if (family.documents.size === 0) {
      const orphans = SIDECARS.map((s) => family[s.key]).filter(Boolean);
      errors.push(
        `flows/${orphans.join(', flows/')}: there is no \`${name}.${SOURCE_LANGUAGE}.flow.json\` ` +
          'beside it — a sidecar of a template that does not exist is read by nobody.',
      );
      continue;
    }
    for (const lang of REQUIRED_LANGUAGES) {
      if (family.documents.has(lang)) continue;
      errors.push(
        lang === SOURCE_LANGUAGE
          ? `flows/${name}.${lang}.flow.json is missing — English is the SOURCE language ` +
            `(ADR-0055) and the rest are translations of it, so \`${name}\` has no original.`
          : `flows/${name}.${lang}.flow.json is missing — every string ERPlora ships travels as ` +
            `English AND its \`${lang}\` (ADR-0055/0199). A template is what the owner reads in ` +
            'the gallery and what the customer reads in the message, so without it a Spanish ' +
            'business is offered — and sends — English.',
      );
    }
    for (const sidecar of SIDECARS) {
      if (sidecar.required && !family[sidecar.key]) {
        errors.push(
          `flows/${name}${sidecar.suffix} is missing — without it nobody can tell what \`${name}\` ` +
            'will ask permission for, and the owner is asked to switch on something opaque.',
        );
      }
    }

    const parsed = new Map();
    for (const [lang, file] of family.documents) {
      const document = parse(dir, file, errors);
      if (document === undefined) continue;
      checkDocument(file, document, schema, errors);
      parsed.set(lang, document);
    }

    // A translation is PROSE: same steps, same order, same trigger — other words. When the two
    // halves drift, a Spanish hub runs a different automation from an English one and nothing says
    // so, which is the same shape of bug as a gallery copy left behind (ERPlora/flows#52).
    const source = parsed.get(SOURCE_LANGUAGE);
    if (source) {
      for (const [lang, document] of parsed) {
        if (lang === SOURCE_LANGUAGE) continue;
        const here = stepIds(document);
        const there = stepIds(source);
        if (here.join(' → ') !== there.join(' → ')) {
          errors.push(
            `flows/${family.documents.get(lang)}: its steps are not the translation of ` +
              `\`${name}.${SOURCE_LANGUAGE}.flow.json\` — \`${here.join(' → ')}\` against ` +
              `\`${there.join(' → ')}\`. A translation changes the words, never the automation.`,
          );
        } else if (Array.isArray(document.steps) && Array.isArray(source.steps)) {
          // Same ids in the same order: now each step must be the same MACHINERY, other words.
          document.steps.forEach((step, index) => {
            const copied = untranslated(step, source.steps[index]);
            if (copied.length) {
              errors.push(
                `flows/${family.documents.get(lang)}: step \`${here[index]}\` is not translated — ` +
                  `\`${copied.join('`, `')}\` is the English text word for word. These words ` +
                  'live only in the template, outside the i18n catalogue of the module, so a ' +
                  `\`${lang}\` business sends them to its customers in English. Translate them.`,
              );
            }
            const drift = stepDrift(step, source.steps[index]);
            if (!drift.length) return;
            errors.push(
              `flows/${family.documents.get(lang)}: step \`${here[index]}\` is not the translation ` +
                `of the English one — it differs in \`${drift.join('`, `')}\`. A translation ` +
                `changes the prose of a step (${PROSE_STEP_KEYS.join(', ')}, and the words inside ` +
                `a mixed key: ${PROSE_STEP_PATHS.join(', ')}), never its machinery: ` +
                'otherwise a Spanish hub runs a different automation under the same name.',
            );
          });
        }
        if (typeof document.name === 'string' && document.name === source.name && isWords(document.name)) {
          errors.push(
            `flows/${family.documents.get(lang)}: its \`name\` is the English one word for word — ` +
              `it is the card a \`${lang}\` owner reads in the gallery. Translate it.`,
          );
        }
        const drift = triggerDrift(document, source);
        if (drift.length) {
          const summary =
            triggerSummary(document) === triggerSummary(source)
              ? `both are fired by \`${triggerSummary(source)}\`, but they differ in ` +
                `\`${drift.join('`, `')}\``
              : `fired by \`${triggerSummary(document)}\` while ` +
                `\`${name}.${SOURCE_LANGUAGE}.flow.json\` is fired by ` +
                `\`${triggerSummary(source)}\``;
          errors.push(
            `flows/${family.documents.get(lang)}: ${summary} — a trigger carries no prose, so the ` +
              `translation must be fired by exactly the same thing. Otherwise a Spanish hub answers ` +
              `messages the English one ignores and nothing says so.`,
          );
        }
      }
    }

    if (family.grants) {
      const sidecar = parse(dir, family.grants, errors);
      if (sidecar !== undefined) {
        checkGrants(family.grants, sidecar, errors, warnings, [...family.documents.keys()]);
      }
    }
    if (family.requires) {
      const sidecar = parse(dir, family.requires, errors);
      if (sidecar !== undefined) checkRequires(family.requires, sidecar, errors);
    }
  }

  if (families.size) checkReleasePublishesFlows(dir, warnings);

  return { errors, warnings };
}
