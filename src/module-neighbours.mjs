// Brings the published NEIGHBOURS of a module next to it, so its battery can check the version
// floors its recipes declare — module-toolkit#343.
//
// A module's `flows/*.requires.json` name the minimum release of every neighbour a recipe needs,
// and the module's battery verifies each floor by reading the neighbour's git history in the
// checkout NEXT TO the module (`<parent>/<neighbour>`). The gate used to check out the module alone,
// so on CI every floor printed «skipped» and the battery went green over a floor that was too low.
//
// Rules, each one a hole this closes:
//   - A module WITHOUT floors needs nothing: no bundle, no clone, no change for it.
//   - A module WITH floors and no deploy-key bundle is RED: «I could not look» is never a green.
//   - The whole bundle is cloned, not only the floor modules: the battery's other layers resolve
//     every operation name against the whole workspace, and half a workspace reports names as
//     missing that are not.
//   - FULL history: a release is found as the first commit whose manifest declares it; a shallow
//     clone has no past and would turn every floor back into a skip.
//   - A stale directory from an earlier job on the same runner is replaced, never reused.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Same pattern as the manifest's `id` (and the hub's materialize script). */
const MODULE_ID_RE = /^[a-z][a-z0-9_]*$/;
const DEFAULT_REMOTE = 'git@github.com:ERPlora/%s.git';
const BRANCH = 'main';
/** What was cloned, so `cleanup` removes exactly that and nothing else. */
const RECORD = '.erplora-neighbours.json';

function moduleIdOf(moduleDir) {
  const manifest = JSON.parse(readFileSync(join(moduleDir, 'module.json'), 'utf8'));
  if (!manifest.id) throw new Error(`${moduleDir}/module.json does not declare \`id\``);
  return manifest.id;
}

/** Every neighbour some `flows/*.requires.json` puts a floor on, sorted, without the module. */
export function floorModules(moduleDir) {
  const self = moduleIdOf(moduleDir);
  const flows = join(moduleDir, 'flows');
  if (!existsSync(flows)) return [];
  const ids = new Set();
  for (const name of readdirSync(flows).filter((n) => n.endsWith('.requires.json')).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(flows, name), 'utf8'));
    } catch (err) {
      throw new Error(`flows/${name} is not readable JSON (${err.message})`);
    }
    for (const id of Object.keys(doc?.modules ?? {})) if (id !== self) ids.add(id);
  }
  return [...ids].sort();
}

/** Module ids the deploy-key bundle holds a key for; `[]` when there is no bundle. */
export function bundleIds(keysDir) {
  if (!keysDir || !existsSync(keysDir)) return [];
  return readdirSync(keysDir).filter((n) => MODULE_ID_RE.test(n)).sort();
}

export function planClones({ self, floors, bundle }) {
  return {
    clone: bundle.filter((id) => id !== self),
    missing: floors.filter((id) => !bundle.includes(id)),
  };
}

function parseArgs(argv) {
  const args = { remoteTemplate: DEFAULT_REMOTE, attempts: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--module-dir') args.moduleDir = resolve(value);
    else if (flag === '--keys') args.keys = value;
    else if (flag === '--remote-template') args.remoteTemplate = value;
    else if (flag === '--attempts') args.attempts = Number(value);
    else throw new Error(`unknown argument ${flag}`);
    i += 1;
  }
  if (!args.moduleDir) throw new Error('--module-dir is required');
  return args;
}

function cloneOne({ id, dest, url, keyFile, attempts }) {
  const env = { ...process.env };
  if (keyFile && url.includes('@')) {
    // The host key is pinned per job next to the keys, never written into the runner's ~/.ssh.
    env.GIT_SSH_COMMAND = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o BatchMode=yes `
      + `-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${keyFile}.known_hosts`;
  }
  let last = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    rmSync(dest, { recursive: true, force: true });
    try {
      execFileSync('git', ['clone', '-q', '--branch', BRANCH, url, dest], { env, stdio: 'pipe' });
      return null;
    } catch (err) {
      last = String(err.stderr || err.message).trim().split('\n')[0];
    }
  }
  rmSync(dest, { recursive: true, force: true });
  return `${id}: ${last}`;
}

function versionOf(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')).version ?? '?';
  } catch {
    return '?';
  }
}

/**
 * Returns `{ code, exit, … }`. Codes: `no_floors` · `no_keys` · `missing_keys` · `clone_failed` ·
 * `ok`. Only `no_floors` and `ok` are green.
 */
export function main(argv, io = {}) {
  const log = io.log ?? ((m) => console.log(m));
  const error = io.error ?? ((m) => console.error(m));
  const args = parseArgs(argv);
  const self = moduleIdOf(args.moduleDir);
  const floors = floorModules(args.moduleDir);
  if (floors.length === 0) {
    log(`· ${self} no declara suelos de versión de vecinos (flows/*.requires.json): no hace falta traer ninguno.`);
    return { code: 'no_floors', exit: 0 };
  }
  const bundle = bundleIds(args.keys);
  if (bundle.length === 0) {
    error(
      `❌ ${self} declara suelos sobre ${floors.join(', ')} y el gate no ha recibido las claves para traer esos módulos.\n`
        + '   Sin ellos la batería no puede comprobar los suelos y saldría en verde sin mirarlos.\n'
        + '   Falta el secreto MODULES_DEPLOY_KEYS en este repo y pasarlo al gate (`secrets:` del stub) — module-toolkit#343.',
    );
    return { code: 'no_keys', exit: 1 };
  }
  const plan = planClones({ self, floors, bundle });
  if (plan.missing.length > 0) {
    error(
      `❌ el paquete MODULES_DEPLOY_KEYS no trae clave para ${plan.missing.join(', ')}, `
        + `y ${self} pone un suelo sobre ${plan.missing.length === 1 ? 'ese módulo' : 'esos módulos'} — module-toolkit#343.`,
    );
    return { code: 'missing_keys', exit: 1, missing: plan.missing };
  }

  const parent = dirname(args.moduleDir);
  const failed = [];
  const cloned = [];
  for (const id of plan.clone) {
    const dest = join(parent, id);
    if (resolve(dest) === args.moduleDir) continue;
    const why = cloneOne({
      id,
      dest,
      url: args.remoteTemplate.replace('%s', id),
      keyFile: join(resolve(args.keys), id),
      attempts: args.attempts,
    });
    if (why) failed.push({ id, why });
    else cloned.push(id);
  }
  writeFileSync(join(parent, RECORD), JSON.stringify({ module: basename(args.moduleDir), cloned }));
  if (failed.length > 0) {
    error(`❌ no se ha podido traer ${failed.length} vecino(s):\n${failed.map((f) => `   ${f.why}`).join('\n')}`);
    return { code: 'clone_failed', exit: 1, failed: failed.map((f) => f.id) };
  }
  log(`📦 ${cloned.length} vecino(s) junto a ${self}, con historia: ${cloned.map((id) => `${id}@${versionOf(join(parent, id))}`).join(', ')}`);
  return { code: 'ok', exit: 0 };
}

/** Removes the neighbours `main` recorded next to `moduleDir`, and the record. Never the module. */
export function cleanup(moduleDir, io = {}) {
  const log = io.log ?? ((m) => console.log(m));
  const dir = resolve(moduleDir);
  const parent = dirname(dir);
  const record = join(parent, RECORD);
  if (!existsSync(record)) return;
  const { cloned = [] } = JSON.parse(readFileSync(record, 'utf8'));
  for (const id of cloned) {
    const target = join(parent, id);
    if (!MODULE_ID_RE.test(id) || resolve(target) === dir) continue;
    rmSync(target, { recursive: true, force: true });
  }
  rmSync(record, { force: true });
  log(`· retirados ${cloned.length} vecino(s) de ${parent}`);
}

// Executed as a script by the gate's composite action.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'cleanup') {
      cleanup(argv[1]);
      process.exit(0);
    }
    process.exit(main(argv).exit);
  } catch (err) {
    console.error(`❌ no se han podido preparar los vecinos del módulo: ${err.message}`);
    process.exit(2);
  }
}
