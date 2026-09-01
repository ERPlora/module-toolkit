#!/usr/bin/env bash
# The gate's contact surface with the MACHINE — module-toolkit#138.
#
# Sourced (never executed) by the shell steps that need Docker: the composite action the 27 module
# repos run their gate on, and this repository's own CI. Both used to carry their own copy of these
# ten lines, and the copies had already drifted — the action said «infrastructure, not the module»
# and `ci.yml` did not.
#
# WHY IT EXISTS. On 2026-08-25 Docker died on `ci-runner-1` and every module whose gate landed
# there went red on `validate --pg`. Two of the three ways that can happen said nothing useful:
#
#   `docker info` fails   → one annotation, and the daemon's own error thrown away by
#                           `>/dev/null 2>&1`. «Is the disk full?» — the right hypothesis — could
#                           only be answered by opening an SSH session to the runner.
#   `docker run` fails    → NO annotation at all. `set -e` killed the step and the check read
#                           «Process completed with exit code 125», which is what a module with
#                           broken SQL looks like. That is how a full disk gets investigated as a
#                           bug in somebody's migration (and how `ci-burst`'s `exit 127` of the
#                           29/08 was read).
#
# THE CONTRACT. Every failure caused by the runner leaves through `erplora_infra_fail`, which emits
# exactly one annotation carrying:
#
#   · `ERPLORA_INFRA_FAILURE` — a fixed token, so an automation can tell «retry elsewhere» from
#     «this module is broken» without parsing prose;
#   · a title that says out loud the module is not what broke, because the person reading the
#     checks list of a module repo has no reason to suspect the machine;
#   · and, in the step log and the job summary, the two facts the 25/08 investigation had to SSH in
#     to get: what Docker itself said, and how full the disk is.
#
# What it deliberately does NOT do is retry on another runner. A composite action cannot
# re-dispatch its own job, and an automatic retry would just as easily land on the next slot of the
# same machine — all six live on one host — turning a broken runner into a slow green instead of a
# loud red. Marking the failure is what lets a human or the fleet decide; the retry itself is
# module-toolkit#142.

# The token an automation greps for. Fixed on purpose: it is an interface, not a message.
ERPLORA_INFRA_MARKER='ERPLORA_INFRA_FAILURE'

# What the machine can say about itself, printed to the step log where there is room for it. The
# annotation stays one line; this is where the answer to «why» lives.
erplora_infra_diagnostics() {
  local path
  echo "── runner diagnostics ─────────────────────────────────────────────"
  echo "runner=${RUNNER_NAME:-?} host=$(hostname 2>/dev/null || echo '?')"
  # The disk first: it is the failure mode this repository has actually seen — 53 GB of 150 (74 %)
  # the night `ci-runner-1` stopped answering. `/var/lib/docker` is asked for by name because the
  # overlay2 store is what fills up and it is frequently a mount of its own. One `df` per path,
  # never one call with three: a single missing path makes the whole invocation non-zero, and the
  # fallback then printed the same row twice.
  df -h / 2>/dev/null | head -1 || true
  for path in / "${RUNNER_TEMP:-/tmp}" /var/lib/docker; do
    [ -d "$path" ] || continue
    df -h "$path" 2>/dev/null | tail -1 || true
  done
  echo "───────────────────────────────────────────────────────────────────"
}

# One annotation, one exit. Called with a one-line reason; the detail belongs in the log above it.
erplora_infra_fail() {
  # `local` throughout: this file is SOURCED into the caller's shell, and a helper that clobbers a
  # variable the step was already using is a bug nobody would look for here.
  local reason="$1"
  erplora_infra_diagnostics
  # `title=` is what GitHub shows as the heading of the annotation in the checks list — the only
  # line most people read before deciding whose bug this is.
  printf '::error title=Runner infrastructure, not this module::%s: %s. The module was never checked; this job can be retried on another runner.\n' \
    "$ERPLORA_INFRA_MARKER" "$reason"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      # shellcheck disable=SC2016  # the backticks are Markdown for the job summary, not a
      # command substitution: the format strings are single-quoted precisely so nothing expands.
      printf '### Infrastructure failure on `%s`\n\n' "${RUNNER_NAME:-unknown runner}"
      # shellcheck disable=SC2016
      printf '`%s`: %s\n\n' "$ERPLORA_INFRA_MARKER" "$reason"
      printf 'The module was never validated. Re-run the job — preferably on another runner.\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

# The preflight. A runner without a working daemon cannot PREPARE anything, and saying so here is
# what keeps the failure from surfacing three steps later as a Postgres that never came up.
erplora_require_docker() {
  local docker_info
  # Declared first and assigned in the `if`: `local x=$(cmd)` would report `local`'s status, not
  # the command's, and the preflight would pass on a dead daemon.
  if docker_info=$(docker info 2>&1); then
    printf '→ docker usable on %s (%s)\n' "${RUNNER_NAME:-this runner}" "$(docker --version 2>/dev/null || echo 'version unknown')"
    return 0
  fi
  printf 'docker info failed:\n%s\n' "$docker_info"
  erplora_infra_fail 'this runner has no usable Docker, so validate --pg cannot PREPARE anything'
}

# The scratch Postgres every `--pg` run prepares against.
#
# ONE container per job, never a shared name (module-toolkit#43): the six slots of `ci-runner-1`
# share a Docker state, so a fixed name meant one job's `docker rm -f` killed another's Postgres —
# which surfaced as «the migration does not apply», pinned on a module whose SQL was fine. The
# caller passes the unique name in `PG_CONTAINER`.
erplora_start_scratch_postgres() {
  local container="${PG_CONTAINER:?PG_CONTAINER must be set by the caller}"
  local image="${POSTGRES_IMAGE:-postgres:18}"
  # 60 s in CI. The knob exists so this repository's own tests can prove the timeout path in two
  # seconds instead of one minute: a suite that takes a minute to check one annotation is a suite
  # people stop running.
  local wait_seconds="${ERPLORA_PG_WAIT_SECONDS:-60}"
  local docker_run waited

  # Only OUR name is ever removed; another slot's container is never touched.
  docker rm -f "$container" >/dev/null 2>&1 || true

  if ! docker_run=$(docker run -d --name "$container" -e POSTGRES_PASSWORD=postgres "$image" 2>&1); then
    printf 'docker run failed:\n%s\n' "$docker_run"
    erplora_infra_fail "the scratch Postgres container ($container, $image) could not be created"
  fi

  # The validator reads the container from here (`defaultContainer()` in src/validate-prepare.mjs);
  # without it, it looks for the old fixed name.
  printf 'ERPLORA_TEST_PG_CONTAINER=%s\n' "$container" >> "${GITHUB_ENV:?GITHUB_ENV must be set}"

  waited=0
  while [ "$waited" -lt "$wait_seconds" ]; do
    if docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; then
      printf '→ postgres ready in %s\n' "$container"
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done

  printf 'docker logs %s:\n' "$container"
  docker logs "$container" 2>&1 | tail -20 || true
  erplora_infra_fail "the scratch Postgres ($container) never became ready in ${wait_seconds}s"
}
