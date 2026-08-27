// `erplora test --against-hub <imagen|digest>` — module-toolkit#110. `node --test`.
//
// WHY THIS SUITE EXISTS. A module's batteries build their own Postgres from the module's
// migrations and then assert that the SQL «binds and runs exactly as the runtime runs it». That
// sentence is an assertion of the test, not a fact about the runtime: the emulation is written by
// hand, it is not the engine, and it agrees with the engine only for as long as nobody changes the
// engine. `--against-hub` replaces the emulation with the kernel itself — the published image,
// its Postgres, its installer, its dispatcher — which is the module half of the conformance suite
// («El Hub se CIERRA como KERNEL», §5).
//
// 🔴 WHAT THIS SUITE GUARDS, and why every check below is about a FAILURE. The dangerous outcome
// of a harness that starts containers is not a red: it is a GREEN bought by something that never
// ran. Four ways that happens, one check each:
//
//   · the image reference is wrong or empty and we silently test `:latest` of something else
//     → `resolveImageRef` refuses anything it cannot name;
//   · the pull is unauthorized and the error scrolls past as noise
//     → the failure names the EXACT `docker pull` command that has to work;
//   · the runtime never becomes ready and the batteries are reported as "not run" (green)
//     → a readiness timeout is an ERROR carrying the container's own log tail;
//   · a failure leaves the containers behind, and the next run reuses a hub with the previous
//     module still installed → teardown happens on EVERY path, and it is asserted on the failing
//     one, not on the happy one.
//
// Everything here injects `exec`/`probe`: no suite of this repository may need Docker to check its
// own logic. The end-to-end proof against the REAL image is `--against-hub` itself, run by hand
// (evidence in the pull request), plus `test/fixtures/against-hub/kernel_fixture`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CHANNEL,
  HUB_IMAGE_REPO,
  hubBatteryVars,
  parseAgainstHub,
  pullDeniedByAuth,
  resolveImageRef,
  waitForReady,
  withHubRuntime,
} from '../src/against-hub.mjs';
import { discoverBatteries, runBatteries } from '../src/run-batteries.mjs';

// ── the flag ─────────────────────────────────────────────────────────────────────────

test('parseAgainstHub: ausente → no se levanta nada (module-toolkit#110)', () => {
  assert.deepEqual(parseAgainstHub(['test', 'modules/sales']), { present: false, value: null });
});

test('parseAgainstHub: `--against-hub` a secas toma el canal por defecto', () => {
  assert.deepEqual(parseAgainstHub(['test', 'modules/sales', '--against-hub']), {
    present: true,
    value: null,
  });
});

test('parseAgainstHub: acepta las DOS formas, `=valor` y valor suelto', () => {
  assert.deepEqual(parseAgainstHub(['test', '.', '--against-hub=dev']), {
    present: true,
    value: 'dev',
  });
  assert.deepEqual(parseAgainstHub(['test', '.', '--against-hub', 'dev']), {
    present: true,
    value: 'dev',
  });
});

// 🔴 The whole reason the parser is a function and not two lines in `bin/erplora.mjs`: the CLI
// splits argv into "flags" and "positionals" by a leading `--`, so the VALUE of the flag looks
// exactly like the module directory. Getting this wrong does not fail — it runs the batteries of
// a module called `dev`.
test('parseAgainstHub: el valor NO se confunde con el directorio del módulo', () => {
  const { positionals } = parseAgainstHub(['test', 'modules/sales', '--against-hub', 'dev'], {
    positionals: true,
  });
  assert.deepEqual(positionals, ['test', 'modules/sales']);
});

test('parseAgainstHub: el siguiente flag NO es el valor', () => {
  assert.deepEqual(parseAgainstHub(['test', '.', '--against-hub', '--list']), {
    present: true,
    value: null,
  });
});

// ── the image reference ──────────────────────────────────────────────────────────────

test('resolveImageRef: sin valor → el canal por defecto del contrato del kernel', () => {
  assert.equal(resolveImageRef(null), `${HUB_IMAGE_REPO}:${DEFAULT_CHANNEL}`);
  assert.equal(DEFAULT_CHANNEL, 'stable');
});

test('resolveImageRef: los dos canales publicados se escriben por su nombre', () => {
  assert.equal(resolveImageRef('stable'), `${HUB_IMAGE_REPO}:stable`);
  assert.equal(resolveImageRef('dev'), `${HUB_IMAGE_REPO}:dev`);
});

test('resolveImageRef: un digest se ancla al repo del hub, con `@` o sin él', () => {
  const d = 'sha256:2f0a5c1e9b7d4a6f8c3e1b0d9a7f5e3c1b9d7a5f3e1c9b7d5a3f1e9c7b5d3a1f';
  assert.equal(resolveImageRef(d), `${HUB_IMAGE_REPO}@${d}`);
  assert.equal(resolveImageRef(`@${d}`), `${HUB_IMAGE_REPO}@${d}`);
});

test('resolveImageRef: una referencia completa se respeta tal cual', () => {
  assert.equal(
    resolveImageRef('ghcr.io/erplora/hub:1.1.10'),
    'ghcr.io/erplora/hub:1.1.10',
  );
  assert.equal(resolveImageRef('registry.local/mirror/hub:dev'), 'registry.local/mirror/hub:dev');
});

// A silent default here is how you end up certifying a module against an image nobody chose.
test('resolveImageRef: lo que no sabe nombrar lo RECHAZA, no lo adivina', () => {
  for (const bad of ['', '   ', ':', '@', 'ghcr.io/erplora/hub:', 'a b']) {
    assert.throws(() => resolveImageRef(bad), /--against-hub/, `debería rechazar ${JSON.stringify(bad)}`);
  }
});

// ── what the battery is handed ───────────────────────────────────────────────────────

test('hubBatteryVars: la puerta genérica y la derivada del id del módulo', () => {
  const vars = hubBatteryVars('sales', {
    baseUrl: 'http://127.0.0.1:54321',
    hubId: 'local',
    image: 'ghcr.io/erplora/hub:stable',
  });
  assert.equal(vars.ERPLORA_HUB_BASE_URL, 'http://127.0.0.1:54321');
  assert.equal(vars.SALES_HUB_BASE_URL, 'http://127.0.0.1:54321');
  assert.equal(vars.ERPLORA_HUB_ID, 'local');
  assert.equal(vars.ERPLORA_HUB_IMAGE, 'ghcr.io/erplora/hub:stable');
});

// ── the readiness wait ───────────────────────────────────────────────────────────────

/** A clock and a `sleep` that advance the clock: no real time passes in this suite. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test('waitForReady: devuelve en cuanto /readyz dice UP', async () => {
  const clock = fakeClock();
  let calls = 0;
  const body = await waitForReady({
    url: 'http://127.0.0.1:1/readyz',
    probe: async () => (++calls < 3 ? { ok: false, detail: 'connection refused' } : { ok: true, detail: 'UP' }),
    intervalMs: 500,
    timeoutMs: 10_000,
    ...clock,
  });
  assert.equal(body, 'UP');
  assert.equal(calls, 3);
});

test('waitForReady: agotado el presupuesto FALLA nombrando la url y la última respuesta', async () => {
  const clock = fakeClock();
  await assert.rejects(
    waitForReady({
      url: 'http://127.0.0.1:1/readyz',
      probe: async () => ({ ok: false, detail: 'HTTP 503 database DOWN' }),
      intervalMs: 1000,
      timeoutMs: 5000,
      ...clock,
    }),
    (err) => {
      assert.match(err.message, /http:\/\/127\.0\.0\.1:1\/readyz/);
      assert.match(err.message, /HTTP 503 database DOWN/);
      assert.match(err.message, /5 ?s/);
      return true;
    },
  );
});

// ── the orchestration: what happens when it goes wrong ───────────────────────────────

/** Records every `docker …` invocation and answers from a table of prefixes. */
function fakeDocker(answers = {}) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    for (const [prefix, answer] of Object.entries(answers)) {
      if ([cmd, ...args].join(' ').startsWith(prefix)) return answer;
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

const OK_DOCKER = {
  'docker port': { code: 0, stdout: '0.0.0.0:54321\n[::]:54321\n', stderr: '' },
};

const MODULE = { id: 'demo', name: 'demo', version: '1.0.0' };

test('withHubRuntime: un pull NO AUTORIZADO falla con el comando exacto que hay que poder correr', async () => {
  const { exec, calls } = fakeDocker({
    'docker pull': {
      code: 1,
      stdout: '',
      stderr: 'Error response from daemon: denied: denied\n',
    },
  });
  await assert.rejects(
    withHubRuntime({ dir: '/tmp/demo', manifest: MODULE, image: `${HUB_IMAGE_REPO}:stable`, exec }, async () => {
      throw new Error('el cuerpo NO debería ejecutarse sin imagen');
    }),
    (err) => {
      assert.match(err.message, /docker pull ghcr\.io\/erplora\/hub:stable/);
      assert.match(err.message, /docker login ghcr\.io/);
      return true;
    },
  );
  // Nothing was started, so nothing has to be torn down — but the network must not linger either.
  assert.equal(calls.filter((c) => c.startsWith('docker run')).length, 0);
});

test('pullDeniedByAuth: distingue «no tienes permiso» de «no existe esa etiqueta»', () => {
  assert.equal(pullDeniedByAuth('denied: denied'), true);
  assert.equal(pullDeniedByAuth('unauthorized: authentication required'), true);
  assert.equal(pullDeniedByAuth('manifest unknown'), false);
});

test('withHubRuntime: si el runtime no arranca, el error trae la COLA DE LOGS del contenedor', async () => {
  const clock = fakeClock();
  const { exec } = fakeDocker({
    ...OK_DOCKER,
    'docker logs': { code: 0, stdout: 'panic: HUB_DATABASE_URL vacía\n', stderr: '' },
  });
  await assert.rejects(
    withHubRuntime(
      {
        dir: '/tmp/demo',
        manifest: MODULE,
        image: `${HUB_IMAGE_REPO}:stable`,
        exec,
        probe: async () => ({ ok: false, detail: 'connection refused' }),
        readyTimeoutMs: 3000,
        readyIntervalMs: 1000,
        ...clock,
      },
      async () => {
        throw new Error('el cuerpo NO debería ejecutarse con el runtime caído');
      },
    ),
    (err) => {
      assert.match(err.message, /panic: HUB_DATABASE_URL vacía/);
      return true;
    },
  );
});

// 🔴 Asserted on the FAILING path on purpose. Teardown after a green is the easy half; the run
// that dies is the one that leaves a hub behind with the previous module installed, and the next
// run then "passes" against state nobody put there.
test('withHubRuntime: el desmontaje ocurre TAMBIÉN cuando falla', async () => {
  const clock = fakeClock();
  const { exec, calls } = fakeDocker({ ...OK_DOCKER });
  await assert.rejects(
    withHubRuntime(
      {
        dir: '/tmp/demo',
        manifest: MODULE,
        image: `${HUB_IMAGE_REPO}:stable`,
        exec,
        probe: async () => ({ ok: true, detail: 'UP' }),
        install: async () => {},
        ...clock,
      },
      async () => {
        throw new Error('la batería explota');
      },
    ),
    /la batería explota/,
  );
  const removed = calls.filter((c) => c.startsWith('docker rm -f'));
  assert.equal(removed.length, 2, `esperaba borrar hub y postgres, hubo: ${JSON.stringify(removed)}`);
  assert.ok(
    calls.some((c) => c.startsWith('docker network rm')),
    `la red efímera se queda colgada: ${JSON.stringify(calls)}`,
  );
});

test('withHubRuntime: instala por la PUERTA REAL del runtime y entrega la url al cuerpo', async () => {
  const clock = fakeClock();
  const installs = [];
  const { exec, calls } = fakeDocker({ ...OK_DOCKER });
  let seen = null;
  await withHubRuntime(
    {
      dir: '/tmp/demo',
      manifest: MODULE,
      image: `${HUB_IMAGE_REPO}:stable`,
      exec,
      probe: async () => ({ ok: true, detail: 'UP' }),
      install: async (opts) => { installs.push(opts); },
      ...clock,
    },
    async (live) => { seen = live; },
  );
  assert.equal(seen.baseUrl, 'http://127.0.0.1:54321');
  assert.equal(seen.image, `${HUB_IMAGE_REPO}:stable`);
  assert.equal(installs.length, 1, 'el módulo tiene que instalarse una vez, por la puerta del runtime');
  assert.equal(installs[0].dir, `/erplora-staging/${MODULE.id}`);
  // The module directory is mounted INSIDE the hub's staging root: `POST /api/modules/install`
  // refuses any path outside it (hub#239), so a mount elsewhere would be rejected by the runtime.
  assert.ok(
    calls.some((c) => c.includes(`/tmp/demo:/erplora-staging/${MODULE.id}:ro`)),
    `el módulo no se monta en el staging: ${JSON.stringify(calls)}`,
  );
  // Dev mode is REQUIRED by that door and dev auth is what lets a battery talk without a session.
  const runHub = calls.find((c) => c.startsWith('docker run') && c.includes(HUB_IMAGE_REPO));
  assert.match(runHub, /HUB_DEV_MODE=1/);
  assert.match(runHub, /HUB_AUTH=dev/);
  assert.match(runHub, /HUB_MODULE_CACHE=\/erplora-staging/);
});

// ── the new battery family ───────────────────────────────────────────────────────────

/** A throwaway module: `{ relative path → contents }`. */
function mod(files, id = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-against-hub-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
    writeFileSync(join(dir, rel), body);
    chmodSync(join(dir, rel), 0o755);
  }
  return { dir, manifest: { id, name: id, version: '1.0.0' }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

test('discoverBatteries: `.hub.test.py` es su propia familia y NO se cuela en las otras', () => {
  const m = mod({
    'tests/manifest.contract.test.py': 'print("ok")\n',
    'tests/engine.pg.test.py': 'import os\nos.environ.get("DEMO_TEST_PG_CONTAINER")\n',
    'tests/totals.hub.test.py': 'print("ok")\n',
  });
  try {
    assert.deepEqual(discoverBatteries(m.dir), {
      contract: ['tests/manifest.contract.test.py'],
      postgres: ['tests/engine.pg.test.py'],
      hub: ['tests/totals.hub.test.py'],
    });
  } finally {
    m.clean();
  }
});

// Same rule the Postgres family already follows (module-toolkit#55): the name is a hint, the
// content is the fact. A battery that reads the runtime's url IS a hub battery whatever it is
// called, and misfiling it would run it with no hub at the other end.
test('discoverBatteries: el CONTENIDO manda cuando el nombre no lo dice', () => {
  const m = mod({ 'tests/round_trip.test.py': 'import os\nbase = os.environ["ERPLORA_HUB_BASE_URL"]\n' });
  try {
    assert.deepEqual(discoverBatteries(m.dir).hub, ['tests/round_trip.test.py']);
  } finally {
    m.clean();
  }
});

// The name beats the content, in both directions: whoever wrote `.pg.test.py` said what the file
// is, and a mention of the runtime's url in a comment must not silently move it to another family
// — which would run it with no Postgres and report the module as broken.
test('discoverBatteries: un nombre EXPLÍCITO gana al contenido', () => {
  const m = mod({
    'tests/engine.pg.test.py': '# ojo: no confundir con ERPLORA_HUB_BASE_URL\nprint("ok")\n',
    'tests/totals.hub.test.py': 'import os\nos.environ.get("DEMO_TEST_PG_CONTAINER")\n',
  });
  try {
    const found = discoverBatteries(m.dir);
    assert.deepEqual(found.postgres, ['tests/engine.pg.test.py']);
    assert.deepEqual(found.hub, ['tests/totals.hub.test.py']);
  } finally {
    m.clean();
  }
});

// 🔴 The green that proves nothing, in its newest disguise: a hub battery with no hub behind it
// must be reported as NOT RUN, exactly like a Postgres battery without its container.
test('runBatteries: sin `--against-hub` una batería de hub NO se corre y se DICE', () => {
  const m = mod({ 'tests/totals.hub.test.py': 'import sys\nsys.exit(0)\n' });
  try {
    const { results, errors, notRun } = runBatteries(m.dir, m.manifest, { container: null, hub: null });
    assert.deepEqual(results, []);
    assert.deepEqual(errors, []);
    assert.equal(notRun.length, 1);
    assert.match(notRun[0], /totals\.hub\.test\.py/);
    assert.match(notRun[0], /--against-hub/);
  } finally {
    m.clean();
  }
});

test('runBatteries: con un hub vivo, la batería recibe la url por el entorno', () => {
  const m = mod({
    'tests/totals.hub.test.py':
      'import os, sys\nsys.exit(0 if os.environ.get("ERPLORA_HUB_BASE_URL") == "http://127.0.0.1:54321" else 3)\n',
  });
  try {
    const { results, errors } = runBatteries(m.dir, m.manifest, {
      container: null,
      hub: { baseUrl: 'http://127.0.0.1:54321', hubId: 'local', image: 'ghcr.io/erplora/hub:stable' },
    });
    assert.deepEqual(errors, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].ran, true, results[0].output);
  } finally {
    m.clean();
  }
});
