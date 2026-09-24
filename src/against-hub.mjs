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

/** The repository the fleet publishes to. A bare channel/digest is anchored here. */
export const HUB_IMAGE_REPO = 'ghcr.io/erplora/hub';

/** `--against-hub` with no value: the channel the fleet runs in production. */
export const DEFAULT_CHANNEL = 'stable';

/** Postgres the hub is given. Pinned to the major that runs in production (ADR-0154). */
export const DEFAULT_PG_IMAGE = 'postgres:18';

/**
 * `hub_id` of the rows the runtime writes in dev mode: `context_from_headers` falls back to
 * `"local"` when a request carries no `X-Hub-Id` (`hub/crates/server/src/auth.rs`). Handed to the
 * battery so that sending the header and omitting it cannot disagree.
 */
export const DEV_HUB_ROW_ID = 'local';

/** Where the module directory is mounted inside the container (the hub's staging root, hub#239). */
export const STAGING_ROOT = '/erplora-staging';

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
export function hubBatteryVars(moduleId, { baseUrl, hubId = DEV_HUB_ROW_ID, image = '' } = {}) {
  return {
    [`${moduleId.toUpperCase()}_HUB_BASE_URL`]: baseUrl,
    ERPLORA_HUB_BASE_URL: baseUrl,
    ERPLORA_HUB_ID: hubId,
    ERPLORA_HUB_IMAGE: image,
    ERPLORA_MODULE_ID: moduleId,
  };
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
 */
export async function waitForReady({
  url,
  probe,
  timeoutMs = READY_TIMEOUT_MS,
  intervalMs = 1000,
  now = Date.now,
  sleep = realSleep,
}) {
  const start = now();
  let last = 'sin respuesta';
  for (;;) {
    const r = await probe();
    if (r.ok) return r.detail;
    last = r.detail;
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

// ── the orchestration ────────────────────────────────────────────────────────────────────────

/**
 * Starts `image` with a scratch Postgres, installs the module of `dir` through the runtime's own
 * door, and calls `body({ baseUrl, hubId, image })`. Tears EVERYTHING down afterwards, on every
 * path, and only what it created.
 *
 * `exec`, `probe` and `install` are injectable so the suite can check the failure paths without a
 * Docker daemon — the paths that matter are the ones where something did not come up. `signals`
 * (an emitter, `process` by default) and `exit` are injectable for the same reason: a SIGINT in a
 * test must not kill the test runner.
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
  const tag = `${manifest.id}-${randomBytes(4).toString('hex')}`;
  const net = `erplora-ah-${tag}`;
  const pg = `erplora-ah-pg-${tag}`;
  const hub = `erplora-ah-hub-${tag}`;
  const mountPoint = `${STAGING_ROOT}/${manifest.id}`;

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
      '-e', 'HUB_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres',
      // The staging root the installer confines `dir` to. `HUB_MODULES_DIR` is deliberately NOT
      // set: with it, the boot scan would install the module by itself and the explicit call
      // through the real door — the thing being tested — would never happen.
      '-e', `HUB_MODULE_CACHE=${STAGING_ROOT}`,
      '-v', `${dir}:${mountPoint}:ro`,
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
      throw new Error(
        `Docker no publicó el puerto ${HUB_PORT} del contenedor \`${hub}\` ` +
          `(\`docker port\` → ${(port.stdout || port.stderr).trim() || `exit ${port.code}`}; ` +
          `estado del contenedor: ${await containerState(exec, hub)})\n${await logsTail(exec, hub)}`,
      );
    }
    const baseUrl = `http://127.0.0.1:${mapped}`;
    const live = { baseUrl, hubId: DEV_HUB_ROW_ID, image, container: hub };

    try {
      await waitForReady({
        url: `${baseUrl}/readyz`,
        probe: probe ?? readyzProbe(baseUrl),
        timeoutMs: readyTimeoutMs,
        intervalMs: readyIntervalMs,
        now,
        sleep,
      });
    } catch (err) {
      throw new Error(`${err.message}\n${await logsTail(exec, hub)}`);
    }

    log(`  · instalando ${manifest.id} por \`POST /api/modules/install\``);
    try {
      await (install ?? installThroughRuntime)({ baseUrl, dir: mountPoint, hubId: DEV_HUB_ROW_ID });
    } catch (err) {
      throw new Error(`${err.message}\n${await logsTail(exec, hub)}`);
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
