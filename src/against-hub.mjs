// `erplora test <dir> --against-hub <imagen|digest>` — the module's batteries against the REAL
// kernel (module-toolkit#110).
//
// WHAT IT REPLACES. A module's batteries build a scratch Postgres from the module's own migrations
// and then check the SQL there, claiming it «binds and runs exactly as the runtime runs it». That
// is an assertion of the test, not a property of the runtime: the binding, the system params, the
// row gates, the installer and the migration guard are all re-implemented by hand in the harness,
// and they agree with the engine only until somebody changes the engine. This flag deletes the
// emulation from the loop: it starts the PUBLISHED hub image with its own Postgres, installs the
// module through the door the runtime actually exposes, and the battery talks HTTP to it. It is
// the module half of the conformance suite of «El Hub se CIERRA como KERNEL» §5 — the same shape
// as Android CTS, and the same shape as `testcontainers` everywhere else.
//
// THE BORING TOOLS ON PURPOSE. `docker` on the command line (no SDK, no driver), the image the
// fleet already deploys, an ephemeral published port, `/readyz` (the container's own HEALTHCHECK
// target, hub#538) and `POST /api/modules/install` (the runtime's development door, hub#239). The
// same transport `erplora validate --pg` already uses for its scratch Postgres.
//
// 🔴 EVERY FAILURE IS LOUD, and that is the design. A harness that starts containers fails green by
// default — the image does not pull, the runtime does not boot, the battery never runs, and «0
// errors» is what the gate sees. So: an image reference it cannot name is REFUSED instead of
// defaulted; an unauthorized pull names the exact `docker pull` that has to work; a readiness
// timeout carries the container's own log tail; and a hub battery with no hub behind it is
// reported as NOT RUN, never as passed.
//
// TEARDOWN IS UNCONDITIONAL and it runs on the failing path too: a run that dies leaving the hub
// up leaves the module INSTALLED in it, and the next run then agrees with state nobody put there.
// That includes Ctrl+C and a CI cancel: Node's default action for SIGINT/SIGTERM is to die on the
// spot, `finally` never runs, and the containers stay (measured in the review of #110). While
// containers exist the harness listens for those signals, tears down, and exits with 128+signal.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The repository the fleet publishes to. A bare channel/digest is anchored here. */
export const HUB_IMAGE_REPO = 'ghcr.io/erplora/hub';

/** `--against-hub` with no value: the channel the fleet runs in production. */
export const DEFAULT_CHANNEL = 'stable';

/** Postgres the hub is given. Pinned to the major that runs in production (ADR-0154). */
export const DEFAULT_PG_IMAGE = 'postgres:18';

/**
 * `hub_id` of the rows the runtime writes in dev mode: `context_from_headers` falls back to
 * `"local"` when a request carries no `X-Hub-Id` (`hub/crates/server/src/auth.rs`). Only the
 * FALLBACK default of `hubBatteryVars`, for a battery run with no harness behind it: `--against-hub`
 * itself hands the battery the runtime's OWN `hub_id` (module-toolkit#135) — `GET /api/hub/context`
 * answers something like `00000000-0000-0000-0000-000000000001`, and the seeds land under THAT id,
 * never under `"local"`.
 */
export const DEV_HUB_ROW_ID = 'local';

/** Where the module directory is mounted inside the container (the hub's staging root, hub#239). */
export const STAGING_ROOT = '/erplora-staging';

/**
 * Where the hub writes. One constant because TWO things read it: the hub's `HUB_DATABASE_URL`, and
 * the `ERPLORA_HUB_PSQL` session handed to the batteries — which has to open THIS database, not a
 * second guess of it (module-toolkit#405).
 */
const HUB_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/postgres';

/** Port the image listens on (`HUB_BIND=0.0.0.0:8787`, `docker/Dockerfile`). */
const HUB_PORT = 8787;

/** How long the runtime gets to answer `/readyz` UP. The image's own HEALTHCHECK allows 90 s. */
export const READY_TIMEOUT_MS = 180_000;

/** The signals that end a run early, and the conventional exit code (128 + number) for each. */
export const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

// ── the flag ─────────────────────────────────────────────────────────────────────────────────

/**
 * Reads `--against-hub` out of `argv`.
 *
 * 🔴 Why this is a function and not two lines in the CLI: `bin/erplora.mjs` splits argv into flags
 * (anything starting with `--`) and positionals, so `--against-hub dev` leaves `dev` looking
 * exactly like the module directory — and running the batteries of a module called `dev` does not
 * fail, it just tests the wrong thing. The value is consumed here, once, and the positionals come
 * back without it.
 *
 * Returns `{ present, value }`, plus `positionals` when asked for. `value` is `null` for the bare
 * flag (the default channel) and for `--against-hub --list` (the next flag is never a value).
 */
export function parseAgainstHub(argv, { positionals = false } = {}) {
  const out = { present: false, value: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--against-hub') {
      out.present = true;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.value = next;
        i++;
      }
      continue;
    }
    if (arg.startsWith('--against-hub=')) {
      out.present = true;
      out.value = arg.slice('--against-hub='.length);
      continue;
    }
    rest.push(arg);
  }
  return positionals ? { ...out, positionals: rest } : out;
}

// ── the image reference ──────────────────────────────────────────────────────────────────────

const DIGEST_RE = /^@?sha256:[0-9a-f]{64}$/;
/** `repo[:tag]` / `host/path@digest` — anything with a slash or a registry host is already full. */
const FULL_REF_RE = /^[a-z0-9][a-z0-9._-]*(?:\.[a-z0-9._-]+)*(?::\d+)?\/[a-z0-9._\-/]+(?::[\w][\w.-]*|@sha256:[0-9a-f]{64})$/;
/** A bare channel or tag: `stable`, `dev`, `1.1.10`. */
const TAG_RE = /^:?[\w][\w.-]*$/;

/**
 * Turns whatever the caller typed into ONE fully qualified image reference.
 *
 *   (nothing) → ghcr.io/erplora/hub:stable      stable  → ghcr.io/erplora/hub:stable
 *   dev       → ghcr.io/erplora/hub:dev         sha256:… → ghcr.io/erplora/hub@sha256:…
 *   ghcr.io/erplora/hub:1.1.10 → itself (a mirror or a pinned build is respected verbatim)
 *
 * Anything it cannot name is REFUSED. Defaulting here would certify the module against an image
 * nobody chose — which is the failure mode this whole file exists to remove.
 */
export function resolveImageRef(value) {
  if (value == null || value === true) return `${HUB_IMAGE_REPO}:${DEFAULT_CHANNEL}`;
  const raw = String(value).trim();
  if (!raw) {
    throw new Error(
      `--against-hub sin referencia de imagen: escribe \`--against-hub\` a secas (${DEFAULT_CHANNEL}), ` +
        '`--against-hub dev`, un digest `sha256:…` o una referencia completa `ghcr.io/erplora/hub:<tag>`',
    );
  }
  if (DIGEST_RE.test(raw)) return `${HUB_IMAGE_REPO}@${raw.replace(/^@/, '')}`;
  if (FULL_REF_RE.test(raw)) return raw;
  if (TAG_RE.test(raw)) return `${HUB_IMAGE_REPO}:${raw.replace(/^:/, '')}`;
  throw new Error(
    `--against-hub \`${raw}\`: no es un canal (\`stable\`/\`dev\`), ni un digest \`sha256:…\`, ni una ` +
      'referencia completa `<registro>/<ruta>:<tag>`. No se adivina: probar contra una imagen que ' +
      'nadie ha elegido es peor que no probar',
  );
}

// ── what the battery is handed ───────────────────────────────────────────────────────────────

/**
 * The environment a hub battery reads. Generic AND derived from the manifest id, the same shape
 * `pgContainerVars` already uses — so a battery written tomorrow needs no change here.
 */
export function hubBatteryVars(moduleId, { baseUrl, hubId = DEV_HUB_ROW_ID, image = '', psql = '' } = {}) {
  return {
    [`${moduleId.toUpperCase()}_HUB_BASE_URL`]: baseUrl,
    ERPLORA_HUB_BASE_URL: baseUrl,
    ERPLORA_HUB_ID: hubId,
    ERPLORA_HUB_IMAGE: image,
    // Always present, empty when nobody handed a session over: the battery that needs SQL reads
    // «no session here» and FAILS, instead of falling back to a guess (module-toolkit#405).
    ERPLORA_HUB_PSQL: psql,
    ERPLORA_MODULE_ID: moduleId,
  };
}

/**
 * `ERPLORA_HUB_PSQL` — a psql session on the database the hub under test WRITES TO
 * (module-toolkit#405). Before it, a battery that had to hold a transaction open in that database
 * (the voucher race of `services/tests/grant_race.hub.test.py`) guessed where it was with
 * `docker ps`: that finds the container publishing the hub's port under `--against-hub`, and
 * NOTHING in the hub's CI, whose runner boots a native `erplora-server` on a scratch database of
 * the job's service container (services#130 turned a hub release red with a module that had no
 * fault).
 *
 * The contract, shared word for word with the hub's `scripts/ci/run-module-hub-batteries.sh`
 * (its default admin command `docker exec -i <pg> psql -U <user> -v ON_ERROR_STOP=1` plus
 * `-d <scratch db>`): whitespace-separated words, no quoting, that a battery splits and runs with
 * its own psql flags appended (`-tAc <sql>`, or a script on stdin — hence `-i`).
 */
export function hubPsqlCommand({ container, user = 'postgres', database } = {}) {
  if (!container) throw new Error('hubPsqlCommand: falta el contenedor de Postgres del hub');
  if (!database) throw new Error('hubPsqlCommand: falta la base de datos del hub');
  return `docker exec -i ${container} psql -U ${user} -v ON_ERROR_STOP=1 -d ${database}`;
}

// ── the catalogue a hub battery needs ────────────────────────────────────────────────────────

/** `"taxes"` or `{ id, min_version }` (or a mix of both) → `["taxes"]`. Missing/empty → `[]`. */
function normalizeDependsOn(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
    .filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * Direct subdirectories of `parentDir` that are an actual module: they carry a `module.json` that
 * parses as JSON and whose `id` matches the directory's own name. That last check is what keeps a
 * worktree (`sales-wt-3`, id `sales`) or a stray copy out of the catalogue — the directory name and
 * the manifest disagree, so it is not treated as `sales`. Unreadable directories, missing or broken
 * `module.json`, and the module under test itself (`excludeId`) are silently left out; a `parentDir`
 * that does not exist or cannot be read yields an empty catalogue rather than an error — most
 * modules are developed with nothing next to them at all.
 */
function readSiblingCatalogue(parentDir, excludeId) {
  const catalogue = new Map();
  let entries;
  try {
    entries = readdirSync(parentDir, { withFileTypes: true });
  } catch {
    return catalogue;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryDir = join(parentDir, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(entryDir, 'module.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || parsed.id !== entry.name || parsed.id === excludeId) continue;
    catalogue.set(parsed.id, { id: parsed.id, dir: entryDir, deps: normalizeDependsOn(parsed.depends_on) });
  }
  return catalogue;
}

/**
 * Deterministic topological sort (deps before dependents) over `nodes` (`id → { id, dir, deps }`,
 * every `deps` entry already known to be a key of `nodes`). Among nodes with nothing left to wait
 * for, the alphabetically-first id goes next — so the same catalogue always produces the same
 * order, run to run and machine to machine. A `depends_on` cycle leaves nodes that never become
 * ready: that is the one case this throws, naming every id still stuck.
 */
function topoSortInstallPlan(nodes) {
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  const dependents = new Map([...nodes.keys()].map((id) => [id, []]));
  for (const [id, node] of nodes) {
    for (const depId of node.deps) {
      indegree.set(id, indegree.get(id) + 1);
      dependents.get(depId).push(id);
    }
  }
  const ready = [...nodes.keys()].filter((id) => indegree.get(id) === 0);
  const order = [];
  while (ready.length) {
    ready.sort();
    const id = ready.shift();
    order.push(nodes.get(id));
    for (const dependent of dependents.get(id)) {
      indegree.set(dependent, indegree.get(dependent) - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (order.length !== nodes.size) {
    const stuck = [...nodes.keys()].filter((id) => !order.some((installed) => installed.id === id)).sort();
    throw new Error(`ciclo de \`depends_on\` entre los módulos: ${stuck.join(', ')}`);
  }
  return order;
}

/**
 * WHY THIS EXISTS (module-toolkit#135). A hub battery tests a CHAIN, not a module in isolation:
 * the runtime REFUSES to install a module whose `depends_on` is not already installed
 * (`installer::register_module` → `missing_dependency`), so mounting only the module under test
 * would run ZERO batteries for anything that declares a dependency. And a module with NO
 * `depends_on` at all can still need neighbours at runtime and never say so in the manifest —
 * `cash_register/tests/reverse_on_void.hub.test.py` voids a real sale, so `taxes`+`sales` have to be
 * installed alongside it regardless. This mirrors what the hub's own
 * `run-module-hub-batteries.sh` already does (install the whole sibling catalogue) and what the
 * gate's `module-neighbours` action already lays out on disk (siblings next to the module under
 * test): `installPlan` turns that same layout into an install ORDER, computed once so
 * `withHubRuntime` can mount and install it before the battery ever talks to the runtime.
 *
 * Returns `{ order, skipped }`. `order` is the module under test plus every dependency it actually
 * needs (REQUIRED — missing one is a loud error, never a guess) plus every companion sibling whose
 * own dependencies are satisfiable, topologically sorted. `skipped` lists the companions left out
 * and why, so a run says what it did NOT install instead of pretending the catalogue was empty.
 */
export function installPlan({ dir, manifest }) {
  const parentDir = dirname(dir);
  const catalogue = readSiblingCatalogue(parentDir, manifest.id);
  const moduleDeps = normalizeDependsOn(manifest.depends_on);

  // Transitive closure of the manifest's OWN depends_on: every one of these has to exist, or the
  // runtime will refuse the install of whatever named it — so that refusal is raised HERE, loudly,
  // before any container is even started.
  const required = new Map();
  const requireTransitively = (depId, requiredBy) => {
    if (depId === manifest.id || required.has(depId)) return;
    const entry = catalogue.get(depId);
    if (!entry) {
      throw new Error(
        `el módulo \`${requiredBy}\` depende de \`${depId}\` y no está al lado: se buscó en ` +
          `\`${join(parentDir, depId)}\`. Coloca el módulo \`${depId}\` junto a \`${manifest.id}\` ` +
          '(mismo directorio padre) antes de correr la batería contra el hub.',
      );
    }
    required.set(depId, entry);
    for (const nested of entry.deps) requireTransitively(nested, depId);
  };
  for (const depId of moduleDeps) requireTransitively(depId, manifest.id);

  // A companion is installable when its whole `depends_on` closure resolves inside the catalogue
  // (or to the module under test). The first id that does not resolve is the reason it is skipped;
  // a companion that depends on a skipped one hits the same missing id, so it is skipped too.
  const firstMissingDep = (id, visiting) => {
    if (id === manifest.id || required.has(id)) return null;
    if (visiting.has(id)) return null; // a cycle among companions is not a MISSING dependency
    const entry = catalogue.get(id);
    if (!entry) return id;
    visiting.add(id);
    for (const depId of entry.deps) {
      const missing = firstMissingDep(depId, visiting);
      if (missing) return missing;
    }
    return null;
  };

  const skipped = [];
  const companions = [];
  for (const [id, entry] of catalogue) {
    if (required.has(id)) continue;
    const missing = firstMissingDep(id, new Set());
    if (missing) {
      skipped.push({ id, reason: `depende de \`${missing}\`, que no está en el catálogo de al lado` });
    } else {
      companions.push(entry);
    }
  }

  const nodes = new Map();
  nodes.set(manifest.id, { id: manifest.id, dir, deps: moduleDeps.filter((id) => id !== manifest.id) });
  for (const entry of required.values()) nodes.set(entry.id, entry);
  for (const entry of companions) nodes.set(entry.id, entry);

  const order = topoSortInstallPlan(nodes).map(({ id, dir: entryDir }) => ({ id, dir: entryDir }));
  return { order, skipped };
}

// ── docker, on the command line ──────────────────────────────────────────────────────────────

/** `docker …` → `{ code, stdout, stderr }`. Never throws; the caller decides what a code means. */
export function run(cmd, args, stdin = null) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdin != null) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/**
 * Does this pull failure mean «you are not allowed», as opposed to «that tag does not exist»?
 * The two need different answers from the human, and `ghcr.io/erplora/hub` is a PRIVATE package:
 * an anonymous docker is the most likely way this ever fails.
 */
export function pullDeniedByAuth(output) {
  return /\b(denied|unauthorized|authentication required|forbidden)\b/i.test(output);
}

/** `0.0.0.0:54321\n[::]:54321` → 54321. */
function hostPort(stdout) {
  const hit = /:(\d+)\s*$/m.exec(stdout.trim());
  return hit ? Number(hit[1]) : null;
}

// ── readiness ────────────────────────────────────────────────────────────────────────────────

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls `probe()` until it answers `{ ok: true }` or the budget runs out. Returns the last
 * `detail`; on timeout THROWS naming the url, the elapsed budget and the last answer — a runtime
 * that never came up must never be reported as «the batteries did not run».
 *
 * `stopped()` (optional) is asked after every failed probe: it answers `null` while the process
 * can still come up, or a description of why it never will. A process that already died is not
 * polled for the rest of the budget — measured in module-toolkit#299: a hub dead in 1 s kept the
 * run waiting the full 180 s.
 */
export async function waitForReady({
  url,
  probe,
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = 1000,
  now = Date.now,
  sleep = realSleep,
  stopped = null,
}) {
  const start = now();
  let last = 'sin respuesta';
  for (;;) {
    const r = await probe();
    if (r.ok) return r.detail;
    last = r.detail;
    const why = stopped ? await stopped() : null;
    if (why) {
      throw new Error(
        `el runtime del hub se paró antes de responder UP en ${url} ` +
          `(estado del contenedor: ${why}; última respuesta: ${last})`,
      );
    }
    if (now() - start >= timeoutMs) break;
    await sleep(intervalMs);
  }
  const elapsed = Math.round((now() - start) / 1000);
  throw new Error(
    `el runtime del hub no llegó a responder UP en ${url} tras ${elapsed} s (última respuesta: ${last})`,
  );
}

/** The real probe: `/readyz`, the same endpoint the image's HEALTHCHECK watches (hub#538). */
function readyzProbe(baseUrl) {
  return async () => {
    try {
      const res = await fetch(`${baseUrl}/readyz`, { signal: AbortSignal.timeout(5000) });
      const body = (await res.text()).slice(0, 300);
      return { ok: res.ok, detail: `HTTP ${res.status} ${body}` };
    } catch (err) {
      return { ok: false, detail: err.message };
    }
  };
}

/**
 * The real install: `POST /api/modules/install {dir}`, the runtime's own door. It runs the
 * installer, the migration guard and the manifest validation the hub applies to a marketplace
 * module — which is the entire point of installing this way instead of seeding tables by hand.
 */
async function installThroughRuntime({ baseUrl, dir, hubId }) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/modules/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-id': hubId },
      body: JSON.stringify({ dir }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new Error(`POST ${baseUrl}/api/modules/install no respondió: ${err.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* the runtime answers JSON; anything else is reported verbatim below */ }
  if (!res.ok || !body?.ok) {
    throw new Error(
      `el runtime RECHAZÓ la instalación del módulo desde \`${dir}\` (HTTP ${res.status}): ` +
        `${text.slice(0, 800)}`,
    );
  }
}

/**
 * The real hub context: `GET /api/hub/context`, the runtime's own answer for which `hub_id` a dev
 * install actually seeded (module-toolkit#135). The battery and the install both have to agree
 * with THIS id, not with whatever a header would have said, so it is read once, straight from the
 * runtime, before anything is installed.
 */
async function fetchHubContext(baseUrl) {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/hub/context`, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    throw new Error(`GET ${baseUrl}/api/hub/context no respondió: ${err.message}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch { /* the runtime answers JSON; anything else is reported verbatim below */ }
  if (!res.ok || !body) {
    throw new Error(
      `GET ${baseUrl}/api/hub/context devolvió algo inesperado (HTTP ${res.status}): ${text.slice(0, 800)}`,
    );
  }
  return body;
}

// ── the orchestration ────────────────────────────────────────────────────────────────────────

/**
 * Starts `image` with a scratch Postgres, mounts and installs the whole `installPlan` of `dir`
 * (the module under test, its required `depends_on`, and the satisfiable sibling companions)
 * through the runtime's own door, and calls `body({ baseUrl, hubId, image })`. Tears EVERYTHING
 * down afterwards, on every path, and only what it created.
 *
 * `exec`, `probe`, `install` and `hubContext` are injectable so the suite can check the failure
 * paths without a Docker daemon — the paths that matter are the ones where something did not come
 * up. `signals` (an emitter, `process` by default) and `exit` are injectable for the same reason: a
 * SIGINT in a test must not kill the test runner.
 */
export async function withHubRuntime(
  {
    dir,
    manifest,
    image,
    pgImage = process.env.ERPLORA_HUB_PG_IMAGE || DEFAULT_PG_IMAGE,
    exec = run,
    probe = null,
    install = null,
    hubContext = null,
    readyTimeoutMs = READY_TIMEOUT_MS,
    readyIntervalMs = 1000,
    now = Date.now,
    sleep = realSleep,
    log = () => {},
    signals = process,
    exit = (code) => process.exit(code),
  },
  body,
) {
  // Computed before any Docker call: a chain that cannot be resolved (a missing `depends_on`, or a
  // cycle) must fail with NO containers created, not with a hub left running for nothing.
  const plan = installPlan({ dir, manifest });

  const tag = `${manifest.id}-${randomBytes(4).toString('hex')}`;
  const net = `erplora-ah-${tag}`;
  const pg = `erplora-ah-pg-${tag}`;
  const hub = `erplora-ah-hub-${tag}`;

  const info = await exec('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.code !== 0) {
    throw new Error(
      '`--against-hub` necesita un Docker utilizable y aquí no lo hay ' +
        `(\`docker info\` salió con ${info.code}: ${(info.stderr || info.stdout).trim().slice(0, 300)})`,
    );
  }

  // Pulled BEFORE anything is created: a run that cannot get the image must leave no litter.
  const pull = await exec('docker', ['pull', '--quiet', image]);
  if (pull.code !== 0) {
    const out = `${pull.stdout}${pull.stderr}`;
    throw new Error(
      `no se pudo descargar la imagen del hub. El comando que tiene que funcionar es exactamente:\n` +
        `      docker pull ${image}\n` +
        (pullDeniedByAuth(out)
          ? '      …y ha salido DENEGADO: `ghcr.io/erplora/hub` es un paquete PRIVADO. Autentícate con ' +
            '`docker login ghcr.io -u <usuario>` usando un token con `read:packages`\n'
          : '') +
        `      salida: ${out.trim().slice(0, 600)}`,
    );
  }

  const created = { net: false, pg: false, hub: false };
  // Best-effort, idempotent, and only what this run created: another agent's containers on the
  // same machine are never touched. Shared by the normal path and the signal path — whichever
  // comes first does the work, the other awaits the same promise.
  let teardownOnce = null;
  const teardown = () => {
    teardownOnce ??= (async () => {
      if (created.hub) await exec('docker', ['rm', '-f', hub]);
      if (created.pg) await exec('docker', ['rm', '-f', pg]);
      if (created.net) await exec('docker', ['network', 'rm', net]);
    })();
    return teardownOnce;
  };
  const onSignal = (signal) => {
    log(`  · ${signal}: desmontando el runtime antes de salir`);
    teardown().then(() => exit(SIGNAL_EXIT_CODES[signal] ?? 1));
  };
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) signals.once(signal, onSignal);
  try {
    const mkNet = await exec('docker', ['network', 'create', net]);
    if (mkNet.code !== 0) {
      throw new Error(`no se pudo crear la red efímera \`${net}\`: ${(mkNet.stderr || mkNet.stdout).trim()}`);
    }
    created.net = true;

    log(`  · postgres efímero (${pgImage})`);
    // The hub joins THIS container's network namespace (below), so the hub's port is published
    // here: Docker refuses `-p` on a `--network container:…` run.
    const runPg = await exec('docker', [
      'run', '-d', '--name', pg, '--network', net,
      '-p', `127.0.0.1:0:${HUB_PORT}`,
      '-e', 'POSTGRES_PASSWORD=postgres',
      pgImage,
    ]);
    if (runPg.code !== 0) {
      throw new Error(`no arrancó el Postgres efímero (${pgImage}): ${(runPg.stderr || runPg.stdout).trim()}`);
    }
    created.pg = true;
    await waitForReady({
      url: `postgres ${pg}`,
      probe: async () => {
        const r = await exec('docker', ['exec', pg, 'pg_isready', '-U', 'postgres']);
        return { ok: r.code === 0, detail: (r.stdout || r.stderr).trim() || `exit ${r.code}` };
      },
      timeoutMs: 60_000,
      intervalMs: 1000,
      now,
      sleep,
    });

    log(`  · hub ${image}`);
    const runHub = await exec('docker', [
      // Loopback, not the pg container's name: the runtime forces `sslmode=require` on every
      // non-local Postgres host (hub#1398) and the scratch Postgres has no TLS, so a URL by name
      // kills the hub at boot with `server does not support TLS` (module-toolkit#279).
      'run', '-d', '--name', hub, '--network', `container:${pg}`,
      // Dev mode is what opens `POST /api/modules/install` at all (hub#239); dev auth is what lets
      // a battery talk to `/api/query` without a session. Both are the point of a scratch hub.
      '-e', 'HUB_AUTH=dev',
      '-e', 'HUB_DEV_MODE=1',
      '-e', `HUB_DATABASE_URL=${HUB_DATABASE_URL}`,
      // The staging root the installer confines `dir` to. `HUB_MODULES_DIR` is deliberately NOT
      // set: with it, the boot scan would install the module (and every companion mounted next to
      // it) by itself, and the explicit calls through the real door — the thing being tested —
      // would never happen.
      '-e', `HUB_MODULE_CACHE=${STAGING_ROOT}`,
      // Where the dev disk backend writes a module's `static_files` (`verifactu`). The default is
      // relative to a directory the image's user cannot write: `Permission denied` at install.
      '-e', 'HUB_MEDIA_DIR=/tmp/erplora-media',
      // One mount per entry of the install plan: the module under test, its required dependencies,
      // and the companion siblings — the batteries need the whole chain on disk, not just the one
      // directory the caller named (module-toolkit#135).
      ...plan.order.flatMap((entry) => ['-v', `${entry.dir}:${STAGING_ROOT}/${entry.id}:ro`]),
      image,
    ]);
    if (runHub.code !== 0) {
      throw new Error(`no arrancó el runtime del hub (${image}): ${(runHub.stderr || runHub.stdout).trim()}`);
    }
    created.hub = true;

    const port = await exec('docker', ['port', pg, `${HUB_PORT}/tcp`]);
    const mapped = port.code === 0 ? hostPort(port.stdout) : null;
    if (!mapped) {
      // Seen for real: the container died at boot and `docker port` answered «no public port».
      // Without its state and its own log tail the cause is invisible — same rule as readiness.
      // The port lives on the POSTGRES container (the hub shares its netns), so that is the one
      // named here; a dead hub is caught by the readiness wait below (module-toolkit#299).
      throw new Error(
        `Docker no publicó el puerto ${HUB_PORT} del contenedor \`${pg}\` ` +
          `(\`docker port\` → ${(port.stdout || port.stderr).trim() || `exit ${port.code}`}; ` +
          `estado del contenedor: ${await containerState(exec, pg)})\n${await logsTail(exec, pg)}`,
      );
    }
    const baseUrl = `http://127.0.0.1:${mapped}`;

    try {
      await waitForReady({
        url: `${baseUrl}/readyz`,
        probe: probe ?? readyzProbe(baseUrl),
        timeoutMs: readyTimeoutMs,
        intervalMs: readyIntervalMs,
        now,
        sleep,
        stopped: async () => {
          const state = await containerState(exec, hub);
          return STOPPED_RE.test(state) ? state : null;
        },
      });
    } catch (err) {
      throw new Error(`${err.message}\n${await logsTail(exec, hub)}`);
    }

    // The tenant the installer actually seeds, straight from the runtime — not a header nobody
    // sent. Read BEFORE any install: an id nobody can confirm must fail loudly instead of quietly
    // installing under a guess (module-toolkit#135).
    const context = await (hubContext ?? fetchHubContext)(baseUrl);
    const hubId = context?.hub_id;
    if (!hubId) {
      throw new Error(
        `\`GET /api/hub/context\` no devolvió un \`hub_id\` utilizable: ${JSON.stringify(context)}`,
      );
    }
    const hubDb = new URL(HUB_DATABASE_URL);
    const psql = hubPsqlCommand({
      container: pg,
      user: decodeURIComponent(hubDb.username),
      database: hubDb.pathname.slice(1),
    });
    const live = { baseUrl, hubId, image, container: hub, psql };

    for (const entry of plan.skipped) {
      log(`  · vecino ${entry.id} sin instalar: ${entry.reason}`);
    }
    for (const entry of plan.order) {
      log(`  · instalando ${entry.id} por \`POST /api/modules/install\``);
      try {
        await (install ?? installThroughRuntime)({ baseUrl, dir: `${STAGING_ROOT}/${entry.id}`, hubId });
      } catch (err) {
        throw new Error(`instalando \`${entry.id}\`: ${err.message}\n${await logsTail(exec, hub)}`);
      }
    }

    return await body(live);
  } finally {
    // Listeners stay armed UNTIL the teardown has finished: a signal that lands while the
    // containers are being removed (or one deferred by a blocking battery) still ends in a
    // complete teardown and a 128+signal exit, never in Node's default die-on-the-spot half-way.
    try {
      await teardown();
    } finally {
      for (const signal of Object.keys(SIGNAL_EXIT_CODES)) signals.off(signal, onSignal);
    }
  }
}

/**
 * States from which a container never answers again without somebody restarting it. Anything else
 * (`created`, `running`, `restarting`, or an `inspect` that could not tell) keeps the wait going:
 * the budget, not a guess, decides those.
 */
const STOPPED_RE = /^(exited|dead)\b/;

/** `running exit=0` / `exited exit=101`: whether the container is still there to answer at all. */
async function containerState(exec, container) {
  const r = await exec('docker', ['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}}', container]);
  return (r.code === 0 ? r.stdout : r.stderr).trim() || `docker inspect salió con ${r.code}`;
}

/** The container's own last lines. A boot that failed says why here and nowhere else. */
async function logsTail(exec, container) {
  const r = await exec('docker', ['logs', '--tail', '40', container]);
  const out = `${r.stdout}${r.stderr}`.trimEnd();
  return out
    ? `      últimas líneas de \`docker logs ${container}\`:\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`
    : `      \`docker logs ${container}\` no devolvió nada`;
}
