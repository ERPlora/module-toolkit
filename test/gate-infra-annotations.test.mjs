// A failure of the RUNNER must never be readable as a failure of the MODULE — module-toolkit#138.
//
// WHY THIS FILE EXISTS. On 2026-08-25 Docker died on `ci-runner-1` and every module whose gate
// landed there went red on `validate --pg`. Two of the three ways that step can die told nobody
// what had happened:
//
//   `docker info` fails      → one annotation, no diagnostics at all: the daemon's own error was
//                              thrown away by `>/dev/null 2>&1`, so «is the disk full?» — the
//                              hypothesis in the issue, and the right one — could only be answered
//                              by opening an SSH session to the runner.
//   `docker run` fails       → NO annotation whatsoever. `set -e` killed the step and the check
//                              read «Process completed with exit code 125», which is exactly what
//                              a broken module looks like. Reproduced before the fix: 0 `::error`
//                              lines for a `no space left on device` on the image pull.
//
// So the contract this file holds is not «print something». It is: every way the gate can die
// because of the machine leaves a machine-readable marker (`ERPLORA_INFRA_FAILURE`), a title that
// says out loud it is not the module, and the diagnostics needed to act on it without an SSH
// session. Both callers — the composite action the 27 module repos use, and this repository's own
// CI — go through the same helper, and the last test here is what keeps a third caller from
// growing its own bare `docker run` again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = join(REPO, '.github/scripts/ci-infra.sh');

/** The token an automation greps for to tell «retry elsewhere» from «this module is broken». */
const MARKER = 'ERPLORA_INFRA_FAILURE';

/**
 * A fake `docker` whose behaviour is chosen by $FAKE_DOCKER. Each mode is one of the ways the
 * runner failed for real: the daemon down (25/08), the image pull hitting a full disk (the
 * hypothesis of the issue, and the shape `ci-burst` failed in on 29/08 with its `exit 127`), and a
 * container that starts and never answers.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
case "$FAKE_DOCKER" in
  daemon-down)
    echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2
    exit 1 ;;
  pull-no-space)
    [ "$1" = info ] && { echo "Server Version: 29.1.3"; exit 0; }
    [ "$1" = run ] && { echo "docker: failed to register layer: no space left on device" >&2; exit 125; }
    exit 0 ;;
  never-ready)
    [ "$1" = info ] && { echo "Server Version: 29.1.3"; exit 0; }
    [ "$1" = run ] && { echo "deadbeef"; exit 0; }
    [ "$1" = exec ] && exit 1
    [ "$1" = logs ] && { echo "FATAL: could not write to data directory"; exit 0; }
    exit 0 ;;
  healthy)
    [ "$1" = info ] && { echo "Server Version: 29.1.3"; exit 0; }
    [ "$1" = run ] && { echo "deadbeef"; exit 0; }
    exit 0 ;;
esac
`;

/**
 * Runs the helper's whole preflight (Docker + the scratch Postgres) the way a `run:` step does,
 * with `docker` stubbed. Returns what the step wrote where GitHub reads it from.
 */
function runPreflight(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'erplora-infra-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin/docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'bin/docker'), 0o755);
  const env = join(dir, 'github_env');
  const summary = join(dir, 'github_step_summary');
  writeFileSync(env, '');
  writeFileSync(summary, '');
  const driver = join(dir, 'step.sh');
  writeFileSync(
    driver,
    ['set -euo pipefail', `. "${HELPER}"`, 'erplora_require_docker', 'erplora_start_scratch_postgres'].join(
      '\n',
    ),
  );

  let status = 0;
  let out = '';
  try {
    out = execFileSync('bash', [driver], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
        FAKE_DOCKER: mode,
        PG_CONTAINER: 'erplora-test-pg-1-1',
        POSTGRES_IMAGE: 'postgres:18',
        GITHUB_ENV: env,
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_NAME: 'ci-runner-1',
        // The real wait is 60 s. A suite that takes a minute to prove one annotation is a suite
        // people stop running.
        ERPLORA_PG_WAIT_SECONDS: '2',
      },
    });
  } catch (e) {
    status = e.status;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return {
    status,
    out,
    env: readFileSync(env, 'utf8'),
    summary: readFileSync(summary, 'utf8'),
    annotations: out.split('\n').filter((l) => l.startsWith('::error')),
  };
}

// The positive control FIRST: a harness that cannot produce a green proves nothing when it
// produces a red. This is the same runner, the same helper and the same fake `docker` — only the
// machine is healthy.
test('a healthy runner starts the scratch Postgres, annotates nothing and hands the container on', () => {
  const r = runPreflight('healthy');
  assert.equal(r.status, 0, `the preflight must pass on a healthy runner, got:\n${r.out}`);
  assert.deepEqual(r.annotations, [], 'a healthy runner must not annotate anything');
  assert.match(
    r.env,
    /^ERPLORA_TEST_PG_CONTAINER=erplora-test-pg-1-1$/m,
    'the validator reads the container from GITHUB_ENV; without it, it looks for the old fixed name',
  );
});

test('no usable Docker is an INFRA failure, with the daemon error and the disk in the log', () => {
  const r = runPreflight('daemon-down');
  assert.notEqual(r.status, 0, 'the step has to fail');
  assert.equal(r.annotations.length, 1, `exactly one annotation, got:\n${r.out}`);
  const [annotation] = r.annotations;
  assert.match(annotation, /^::error title=[^:]*::/, 'the annotation carries a title a human reads');
  assert.match(annotation, new RegExp(MARKER), `${MARKER} is what an automation greps for`);
  assert.match(
    annotation.toLowerCase(),
    /module/,
    'and the title has to say out loud that the module is not what broke',
  );
  // The two facts the 25/08 investigation had to open an SSH session to get.
  assert.match(
    r.out,
    /Cannot connect to the Docker daemon/,
    "the daemon's own error must reach the log, not `>/dev/null 2>&1`",
  );
  assert.match(
    r.out,
    /Filesystem|Use%|\d+%/,
    'and the disk, which is the hypothesis the issue itself opened with',
  );
});

test('a scratch Postgres that cannot even be created is an INFRA failure, not a module failure', () => {
  // The regression this whole issue is about: before the fix this path emitted ZERO annotations
  // and the check read «Process completed with exit code 125» — indistinguishable from broken SQL.
  const r = runPreflight('pull-no-space');
  assert.notEqual(r.status, 0, 'the step has to fail');
  assert.equal(r.annotations.length, 1, `the failure must be annotated, got:\n${r.out}`);
  assert.match(r.annotations[0], new RegExp(MARKER));
  assert.match(
    r.out,
    /no space left on device/,
    "docker's own reason must be quoted: «could not create the container» alone sends nobody anywhere",
  );
});

test('a container that never answers is an INFRA failure too, and carries its logs', () => {
  const r = runPreflight('never-ready');
  assert.notEqual(r.status, 0, 'the step has to fail');
  assert.equal(r.annotations.length, 1, `the failure must be annotated, got:\n${r.out}`);
  assert.match(r.annotations[0], new RegExp(MARKER));
  assert.match(r.out, /could not write to data directory/, "the container's own logs must be dumped");
});

test('the step summary says it is the machine, so the first place a human looks already knows', () => {
  const r = runPreflight('daemon-down');
  assert.match(r.summary, new RegExp(MARKER), 'the marker belongs in the summary as well as the log');
  assert.match(r.summary, /ci-runner-1/, 'naming the runner is what turns the summary into an action');
});

// ── The mechanical guard: the pattern, not the point (CLAUDE.md, «cero regresiones») ────────────
//
// Both callers went through their own copy of these ten lines, and the copies had ALREADY drifted:
// the action said «infrastructure, not the module» and this repository's own `ci.yml` did not.
// A third copy would drift the same way, so what is asserted is that no caller talks to Docker
// behind the helper's back.
const CALLERS = ['.github/actions/validate-module/action.yml', '.github/workflows/ci.yml'];

for (const caller of CALLERS) {
  test(`${caller} routes its Docker failures through the shared helper`, () => {
    const yaml = readFileSync(join(REPO, caller), 'utf8');
    const code = yaml
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    assert.match(
      code,
      /ci-infra\.sh/,
      'it has to source .github/scripts/ci-infra.sh instead of carrying its own copy',
    );
    assert.doesNotMatch(
      code,
      /^\s*(if !\s*)?docker info\b/m,
      'a bare `docker info` is a copy of the preflight that will drift from the helper',
    );
    assert.doesNotMatch(
      code,
      /^\s*docker run\b/m,
      'a bare `docker run` is the exact line that died with no annotation (module-toolkit#138)',
    );
  });
}
