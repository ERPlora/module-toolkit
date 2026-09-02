// A module that ADDS a hub battery must declare it in the hub, in the same pull request.
// ERPlora/hub#1439, transferred here as module-toolkit#163.
//
// THE ASYMMETRY THIS CLOSES. `ERPlora/hub:scripts/ci/module-hub-batteries.txt` and the module's
// `*.hub.test.py|sh` are one pair, checked in BOTH directions — but only from the hub, and only
// against the PUBLISHED catalogue (each module's `main`). So the half that MOVES has no guard: the
// module author merges green and publishes green, and the red appears in another repository, hours
// later, in an unrelated push. inventory#77 → v1.2.44 → the hub red for 14 runs, and because that
// guard runs BEFORE `cargo test`, the crater (27 published modules against the runtime) did not run
// for a whole day. A real kernel regression would have been invisible behind a bookkeeping failure.
//
// WHY HERE AND NOT IN `release.yml`. The pair breaks when the battery reaches the module's `main`
// — that is what the hub reads as "published" — which is the MERGE, not the version bump. A gate on
// publishing would report a break that already happened; this one refuses the merge that causes it.
//
// WHY THIS NEEDS NO TOKEN. Reading a file from the private `ERPlora/hub` looks like it needs a
// credential, and on the free plan there is none to be had: organization secrets do not reach a
// private repository, and a PAT in 27 module repos is a security decision, not a CI detail. But the
// gate ALREADY has the whole hub on disk — resolving the composite action
// `ERPlora/hub/.github/actions/module-sdk@develop` makes the runner fetch that repository in full,
// which is the same door module-toolkit#61/#66 opened for the canonical mirrors. So the list is
// read from a path, not fetched over the network.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { HUB_NAME_RE, HUB_CONTENT_RE } from './run-batteries.mjs';

/** Where the reviewed list lives inside an `ERPlora/hub` checkout. */
export const HUB_LIST_PATH = 'scripts/ci/module-hub-batteries.txt';

/** Plumbing under `tests/` that is not a battery — the same names `run-batteries.mjs` excuses. */
const PLUMBING = new Set(['__init__.py', 'conftest.py']);

/** The declared pairs, comments and blank lines out. */
export function parseDeclarations(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

/**
 * Which of the files this pull request ADDS are hub batteries.
 *
 * By NAME or by CONTENT, exactly as `run-batteries.mjs` classifies them and as the hub's own guard
 * re-implements in shell. Recognising them by one exact suffix is precisely the mistake
 * module-toolkit#55 measured: 20 files in 7 modules invisible. If the two sides disagreed on what a
 * battery IS, this guard would close one asymmetry by opening another.
 *
 * @param {{path: string, content: string}[]} files paths relative to the module directory
 */
export function addedBatteries(files) {
  return files
    .filter(({ path }) => {
      const parts = path.split('/');
      if (parts[0] !== 'tests') return false;
      return !PLUMBING.has(parts[parts.length - 1]);
    })
    .filter(({ path, content }) => HUB_NAME_RE.test(path) || HUB_CONTENT_RE.test(content ?? ''))
    .map(({ path }) => path);
}

/** The batteries this module adds that the hub's list does not declare. */
export function missingDeclarations({ moduleId, batteries, declared }) {
  const known = new Set(declared);
  return batteries
    .map((battery) => ({ battery, line: `${moduleId}/${battery}` }))
    .filter(({ line }) => !known.has(line));
}

/**
 * The message. It has to name BOTH edits — the line that is missing and the file, in which repo —
 * because the author is being asked to change a repository they were not looking at. "The pair does
 * not match" sends them to read somebody else's CI to find out what to type.
 */
export function formatFailure({ moduleId, missing }) {
  const lines = missing.map(({ line }) => `      ${line}`).join('\n');
  const plural = missing.length === 1 ? 'una batería nueva' : `${missing.length} baterías nuevas`;
  return [
    `❌ Esta PR de \`${moduleId}\` añade ${plural} contra el hub, y el hub no la(s) declara.`,
    '',
    '   Son un PAR: el hub las comprueba en las DOS direcciones',
    '   (`scripts/ci/module-hub-batteries.sh`) contra el catálogo PUBLICADO. Si esto mergea sin',
    '   la otra mitad, la CI del hub se pone ROJA en otro repo, en el push de otra persona — y',
    '   como ese guard corre ANTES de `cargo test`, mientras dure NO se ejecuta el crater de los',
    '   27 módulos publicados contra el runtime (hub#1396: un día entero, 14 runs).',
    '',
    '   Faltan estas líneas EXACTAS en el repo `ERPlora/hub`, fichero',
    `   \`${HUB_LIST_PATH}\` (rama \`develop\`):`,
    '',
    lines,
    '',
    '   Las DOS ediciones van juntas: la batería aquí, la línea allí. Abre la PR en',
    '   `ERPlora/hub` y mergéala antes que esta — o saca la batería de esta PR.',
  ].join('\n');
}

/**
 * The hub checkout the gate already has on disk. The action that carries the SDK resolves to
 * `<hub>/packages/module-sdk`, so the hub root is two levels up — VERIFIED, not promised: if the
 * layout ever moves, this fails here, where it is read, instead of silently finding no list and
 * passing everything. A guard that cannot find its input must never read as "nothing to declare".
 */
export function hubRootFromSdkPath(sdkPath) {
  const root = resolve(sdkPath, '..', '..');
  if (!existsSync(join(root, HUB_LIST_PATH))) {
    throw new Error(
      `no se encuentra \`${HUB_LIST_PATH}\` bajo el checkout del hub deducido de ` +
        `\`${sdkPath}\` (${root}). El gate NO puede comprobar el par: se para en ROJO en vez de ` +
        'dar por bueno lo que no ha podido leer.',
    );
  }
  return root;
}

/** The path of `file` relative to the module, or null when it is not inside it. */
export function withinModule(moduleDir, file) {
  const rel = relative(resolve(moduleDir), resolve(file));
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? rel.split(sep).join('/') : null;
}

/**
 * The whole check, given the facts the workflow gathers.
 *
 * @returns {{ok: boolean, message: string, missing: object[]}}
 */
export function checkPairing({ moduleId, moduleDir, addedFiles, hubRoot }) {
  const files = addedFiles
    .map((abs) => ({ abs, path: withinModule(moduleDir, abs) }))
    .filter(({ path }) => path)
    .map(({ abs, path }) => ({
      path,
      content: existsSync(abs) ? readFileSync(abs, 'utf8') : '',
    }));

  const batteries = addedBatteries(files);
  if (batteries.length === 0) return { ok: true, message: '', missing: [] };

  const declared = parseDeclarations(readFileSync(join(hubRoot, HUB_LIST_PATH), 'utf8'));
  const missing = missingDeclarations({ moduleId, batteries, declared });
  if (missing.length === 0) {
    return {
      ok: true,
      message: `✅ ${batteries.length} batería(s) nueva(s) contra el hub, declarada(s) en ${HUB_LIST_PATH}.`,
      missing: [],
    };
  }
  return { ok: false, message: formatFailure({ moduleId, missing }), missing };
}

/**
 * The entry point the gate step calls. The workflow does the only thing it is better at — asking
 * git which files the pull request ADDS — and hands the list over; everything else happens here,
 * where `test/check-hub-battery-pairing.test.mjs` can exercise it.
 *
 * Exit codes: 0 = the pair is declared (or this PR adds no battery) · 1 = a declaration is
 * missing · 2 = the check could not be made. Two is NOT zero on purpose: a guard that cannot read
 * the hub must go red, never quietly report that there is nothing to declare.
 */
export function main(argv, io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;

  const args = { added: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--module-dir') { args.moduleDir = value; i += 1; }
    else if (flag === '--sdk-path') { args.sdkPath = value; i += 1; }
    else if (flag === '--added') { if (value) args.added.push(value); i += 1; }
    else { error(`opción desconocida: ${flag}`); return 2; }
  }
  if (!args.moduleDir || !args.sdkPath) {
    error('uso: check-hub-battery-pairing.mjs --module-dir <dir> --sdk-path <dir> [--added <f>]...');
    return 2;
  }

  try {
    const manifest = JSON.parse(readFileSync(join(args.moduleDir, 'module.json'), 'utf8'));
    const moduleId = manifest.id;
    if (!moduleId) {
      error(`\`module.json\` de ${args.moduleDir} no declara \`id\`: sin él no se puede formar la línea del hub.`);
      return 2;
    }
    const hubRoot = hubRootFromSdkPath(args.sdkPath);
    const verdict = checkPairing({
      moduleId,
      moduleDir: args.moduleDir,
      addedFiles: args.added,
      hubRoot,
    });
    if (verdict.ok) {
      if (verdict.message) log(verdict.message);
      return 0;
    }
    error(verdict.message);
    return 1;
  } catch (err) {
    error(`❌ no se pudo comprobar el par batería↔hub: ${err.message}`);
    return 2;
  }
}

// Executed as a script by the gate's composite action.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
