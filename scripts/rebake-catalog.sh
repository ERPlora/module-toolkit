#!/usr/bin/env bash
# Rebakes the committed bundle of every module the SDK change left behind — module-toolkit#392 —
# or that ships an older OutfitKit than `erplora build` bakes today — module-toolkit#424.
#
#   scripts/rebake-catalog.sh <hub-checkout> <modules-dir>
#
#   env ERPLORA_TOOLKIT  toolkit to build with (default: a scratch copy of this repo's origin/main,
#                        with its own `npm ci` — the gate check links packages into the toolkit's
#                        node_modules, so it never runs on a checkout somebody else is using)
#       REBAKE_CHECK     the gate's check (default: <toolkit>/.github/scripts/check-dist-reproducible.sh)
#       REBAKE_DRY_RUN=1 report which bundles are stale, push nothing
#       REBAKE_ONLY      space-separated module ids to limit the run to
#       REBAKE_WORK      scratch directory (default: a temporary one, removed at the end)
#
# WHY. A module commits its bundle with the SDK baked in, and the gate (#389) compares it with a
# rebuild against hub develop's SDK. Every SDK change on develop therefore leaves every module
# behind: the next PR of each one comes out red for a change that is not its own, and until that PR
# comes, businesses keep the old SDK. So the SDK change is what rebakes, here, for the whole
# catalog at once — the way a Renovate bump follows a dependency release.
#
# The same holds for OutfitKit (#424). Since #423 `build` bakes and seals the OutfitKit npm gives
# (what the module declares in its package.json, else latest), while the gate's check rebuilds with
# the SEALED one — so a bundle sealed with 0.1.79 is `reproducible` and the SDK pass never saw it
# (21 of 27 modules on 2026-09-30, npm at 0.1.125). The seal is compared here with what build would
# bake today (`outfitkit-ci.mjs drift`), and an older seal is rebaked like a stale SDK.
#
# WHAT IT DOES, per module checkout in <modules-dir> (a `.git` DIRECTORY: fleet worktrees carry a
# `.git` FILE and are skipped), always reading `origin/main`, never the working tree:
#   - runs the gate's own check against hub `origin/develop`'s SDK, then asks the toolkit which
#     OutfitKit build bakes today; green and sealed with that one → `fresh`;
#   - `dist_not_reproducible` (branch `rebake/sdk-<sdk-rev>`), or green but sealed with another
#     OutfitKit (branch `rebake/outfitkit-<version>`) → rebuilds in a throwaway worktree with
#     `erplora build --sdk … --outfitkit <that version>`, refuses if anything outside dist/ changed
#     or the seal is not that version, checks the result again with the gate's check, commits ONLY
#     dist/ to the branch and opens one PR against main; any older open `rebake/*` PR of that
#     module is closed as superseded (the new one bakes today's SDK AND today's OutfitKit);
#   - an archived repository → `archived`, skipped;
#   - that branch already on the remote → `pending` (the PR for this SDK exists: nothing twice);
#   - any other red of the check (unsealed, OutfitKit not installable…), or npm unable to say
#     which OutfitKit build bakes today → `error`, nothing pushed.
# Output: one `<id>\t<state>\t<detail>` line per module; a dry run's `stale` detail is
# `<main-sha> sdk`, `<main-sha> outfitkit <sealed> → <today>` or both. Exit 1 if any module ended in `error` or
# `refused`, 3 if the hub could not be read.
set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <hub-checkout> <modules-dir>" >&2
  exit 2
fi
hub=$(cd "$1" && pwd) || exit 2
mods=$(cd "$2" && pwd) || exit 2
self=$(cd "$(dirname "$0")/.." && pwd)

if [ -n "${REBAKE_WORK:-}" ]; then
  work=$REBAKE_WORK
  mkdir -p "$work"
  own_work=0
else
  work=$(mktemp -d "${TMPDIR:-/tmp}/erplora-rebake.XXXXXX")
  own_work=1
fi
work=$(cd "$work" && pwd)

# Every worktree this run adds, removed whatever happens (they belong to shared repositories).
worktrees=()
cleanup() {
  local entry
  for entry in ${worktrees[@]+"${worktrees[@]}"}; do
    git -C "${entry%%|*}" worktree remove --force "${entry#*|}" >/dev/null 2>&1 || rm -rf "${entry#*|}"
    git -C "${entry%%|*}" worktree prune >/dev/null 2>&1 || true
  done
  [ "$own_work" = 0 ] || rm -rf "$work"
}
trap cleanup EXIT

report() { # $1 = id, $2 = state, $3 = detail
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
}

# ── hub develop's SDK, as a worktree of the hub at origin/develop (the freshness door sees it fresh)
if ! git -C "$hub" fetch -q origin develop; then
  echo "✗ could not fetch develop in $hub: without hub develop's SDK there is nothing to rebake against" >&2
  exit 3
fi
sdk_rev=$(git -C "$hub" log -1 --format=%H origin/develop -- packages/module-sdk packages/module-types | cut -c1-10)
sdk_subject=$(git -C "$hub" log -1 --format=%s origin/develop -- packages/module-sdk packages/module-types)
if [ -z "$sdk_rev" ]; then
  echo "✗ hub origin/develop has no packages/module-sdk" >&2
  exit 3
fi
rm -rf "$work/hub"
if ! git -C "$hub" worktree add -q --detach "$work/hub" origin/develop; then
  echo "✗ could not check hub origin/develop out into $work/hub" >&2
  exit 3
fi
worktrees+=("$hub|$work/hub")
sdk=$work/hub/packages/module-sdk
sdk_branch=rebake/sdk-$sdk_rev
echo "SDK: hub develop@${sdk_rev:0:7} — $sdk_subject" >&2

# ── the toolkit to build with
if [ -z "${ERPLORA_TOOLKIT:-}" ]; then
  if ! git -C "$self" fetch -q origin main; then
    echo "✗ could not fetch main in $self to build with the toolkit's origin/main" >&2
    exit 3
  fi
  rm -rf "$work/toolkit"
  mkdir -p "$work/toolkit"
  git -C "$self" archive origin/main | tar -x -C "$work/toolkit"
  if ! (cd "$work/toolkit" && npm ci --no-audit --no-fund --loglevel=error >/dev/null); then
    echo "✗ npm ci failed in the scratch toolkit $work/toolkit" >&2
    exit 3
  fi
  ERPLORA_TOOLKIT=$work/toolkit
fi
toolkit=$ERPLORA_TOOLKIT
check=${REBAKE_CHECK:-$toolkit/.github/scripts/check-dist-reproducible.sh}

# owner/name of a remote URL: git@alias:Owner/name.git, https://host/Owner/name.git, /path/Owner/name.git
slug_of() {
  local p=${1%.git} name rest owner
  p=${p%/}
  name=${p##*/}
  rest=${p%/*}
  owner=${rest##*/}
  owner=${owner##*:}
  printf '%s/%s' "$owner" "$name"
}

# The gate's check on <dir>; prints its output, returns its exit code.
run_check() { # $1 = id, $2 = module dir
  local runner=$work/runner/$1
  rm -rf "$runner"
  mkdir -p "$runner"
  RUNNER_TEMP=$runner ERPLORA_TOOLKIT=$toolkit bash "$check" "$2" "$sdk" 2>&1
}

verdict_line() { # the check's last ✗/::error:: line, or its last line
  local line
  line=$(printf '%s\n' "$1" | grep -E '✗|::error::' | tail -1) || true
  [ -n "$line" ] || line=$(printf '%s\n' "$1" | tail -1)
  printf '%s' "$line"
}

rebake_one() { # $1 = module checkout, $2 = id
  local dir=$1 id=$2 slug out rc src wt outside body url n head drift sealed target branch why title sealed_now
  if ! git -C "$dir" fetch -q origin main; then
    report "$id" error "could not fetch origin main"
    return 1
  fi
  if ! git -C "$dir" cat-file -e origin/main:dist 2>/dev/null; then
    report "$id" no-dist ""
    return 0
  fi
  slug=$(slug_of "$(git -C "$dir" remote get-url origin)")
  # An archived module (invoice_series, pm#226) is read-only and out of the catalog: not an error.
  if [ "$(gh api "repos/$slug" --jq .archived 2>/dev/null)" = true ]; then
    report "$id" archived "$slug"
    return 0
  fi
  if git -C "$dir" ls-remote --exit-code --heads origin "$sdk_branch" >/dev/null 2>&1; then
    report "$id" pending "$sdk_branch"
    return 0
  fi

  src=$work/check/$id
  rm -rf "$src"
  mkdir -p "$src"
  git -C "$dir" archive origin/main | tar -x -C "$src"
  out=$(run_check "$id" "$src")
  rc=$?
  if [ "$rc" -ne 0 ]; then
    case "$out" in
      *dist_not_reproducible*) ;;
      *)
        report "$id" error "$(verdict_line "$out")"
        return 1
        ;;
    esac
  fi
  # The OutfitKit build bakes today, by the toolkit's own rule: every rebuild bakes THAT one by name.
  if ! drift=$(node "$toolkit/src/outfitkit-ci.mjs" drift "$src" 2>&1); then
    report "$id" error "$(printf '%s\n' "$drift" | tail -1)"
    return 1
  fi
  sealed=${drift%%$'\t'*}
  target=${drift#*$'\t'}
  if [ "$drift" = "${drift#*$'\t'}" ] || [ -z "$target" ]; then
    report "$id" error "the toolkit did not say which OutfitKit build bakes today (outfitkit-ci.mjs drift gave '$drift')"
    return 1
  fi
  if [ "$rc" -ne 0 ]; then
    branch=$sdk_branch
    why=sdk
    [ "$sealed" = "$target" ] || why="sdk, outfitkit $sealed → $target"
  elif [ "$sealed" != "$target" ]; then
    branch=rebake/outfitkit-$target
    why="outfitkit $sealed → $target"
    if git -C "$dir" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
      report "$id" pending "$branch"
      return 0
    fi
  else
    report "$id" fresh "$(git -C "$dir" rev-parse --short origin/main)"
    return 0
  fi
  if [ "${REBAKE_DRY_RUN:-}" = 1 ]; then
    report "$id" stale "$(git -C "$dir" rev-parse --short origin/main) $why"
    return 0
  fi

  wt=$work/wt/$id
  rm -rf "$wt"
  git -C "$dir" worktree prune >/dev/null 2>&1 || true
  if ! git -C "$dir" worktree add -q --detach "$wt" origin/main; then
    report "$id" error "could not add a worktree of origin/main"
    return 1
  fi
  worktrees+=("$dir|$wt")
  if ! (cd "$wt" && node "$toolkit/bin/erplora.mjs" build "$wt" --sdk "$sdk" --outfitkit "$target") >"$work/build-$id.log" 2>&1; then
    report "$id" error "erplora build failed: $(tail -1 "$work/build-$id.log")"
    return 1
  fi
  outside=$(git -C "$wt" status --porcelain --untracked-files=all | cut -c4- | grep -v '^dist/' | tr '\n' ' ') || true
  if [ -n "$outside" ]; then
    report "$id" refused "the rebuild changed files outside dist/: ${outside% }"
    return 1
  fi
  if [ -z "$(git -C "$wt" status --porcelain -- dist)" ]; then
    report "$id" error "the check said stale but the rebuild changed nothing in dist/"
    return 1
  fi
  sealed_now=$(node "$toolkit/src/outfitkit-ci.mjs" drift "$wt" 2>/dev/null) || sealed_now=""
  sealed_now=${sealed_now%%$'\t'*}
  if [ "$sealed_now" != "$target" ]; then
    report "$id" error "the rebuild sealed ${sealed_now:-no OutfitKit}, not $target"
    return 1
  fi
  if ! out=$(run_check "$id" "$wt"); then
    report "$id" error "still not reproducible after the rebuild: $(verdict_line "$out")"
    return 1
  fi

  if [ "$why" = sdk ] || [ "${why#sdk,}" != "$why" ]; then
    title="La pantalla publicada de $id se rehornea con la librería de módulos al día (SDK ${sdk_rev:0:7})"
  else
    title="La pantalla publicada de $id se rehornea con la OutfitKit $target (llevaba la $sealed)"
  fi
  if ! git -C "$wt" add -A -- dist \
    || ! git -C "$wt" commit -q -m "dist/ rehorneado con el SDK de hub develop@${sdk_rev:0:7} y la OutfitKit $target ($why; module-toolkit#392, #424)"; then
    report "$id" error "could not commit the rebaked dist/"
    return 1
  fi
  if ! git -C "$wt" push -q origin "HEAD:refs/heads/$branch"; then
    report "$id" error "could not push $branch"
    return 1
  fi

  body=$work/pr-$id.md
  cat >"$body" <<EOF
## Qué pasa

La pantalla publicada de \`$id\` estaba hecha con una versión anterior de las librerías comunes de los módulos (la del hub o la de componentes, OutfitKit). Quien usa la app sigue viendo el comportamiento antiguo y no recibe los arreglos ya publicados, y la próxima propuesta de cambio del módulo arrastraría ese salto sin ser suyo.

## Propuesta

Regenerar solo el paquete publicado (\`dist/\`) con las librerías al día. No cambia nada más del módulo; sus pruebas de pantalla corren en esta PR contra la OutfitKit nueva antes de publicarse.

## Detalle técnico

- Motivo: $why.
- SDK: hub \`develop@${sdk_rev:0:7}\` — $sdk_subject
- OutfitKit: \`$sealed\` en \`main\` → \`$target\` en esta rama (la que \`erplora build\` hornea hoy: la declarada en el \`package.json\` del módulo o la última de npm).
- Base: \`main@$(git -C "$dir" rev-parse --short origin/main)\`; el diff es solo \`dist/\`.
- La comprobación del gate (\`check-dist-reproducible.sh\`) da verde en esta rama.
- Abierta por \`module-toolkit/scripts/rebake-catalog.sh\` (ERPlora/module-toolkit#392, #424). Si entra antes otra PR del módulo que toque \`ui/\`, esta queda en conflicto solo en \`dist/\` y \`merge-pr.sh\` la regenera (pm#494).
EOF
  if ! url=$(gh pr create --repo "$slug" --base main --head "$branch" \
    --title "$title" \
    --body-file "$body"); then
    report "$id" error "pushed $branch but could not open its PR"
    return 1
  fi
  url=$(printf '%s\n' "$url" | tail -1)

  # An older rebake of this module is superseded by this one: its bundle is not what build gives today.
  while read -r n head; do
    case "$head" in
      rebake/sdk-* | rebake/outfitkit-*)
        [ "$head" != "$branch" ] || continue
        gh pr close "$n" --repo "$slug" --comment "Sustituida por $url (SDK de hub develop@${sdk_rev:0:7}, OutfitKit $target)." --delete-branch >/dev/null \
          || echo "⚠ $id: could not close the superseded rebake PR #$n" >&2
        ;;
    esac
  done < <(gh pr list --repo "$slug" --state open --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"' || true)

  report "$id" opened "$url"
  return 0
}

status=0
for gitdir in "$mods"/*/.git; do
  [ -d "$gitdir" ] || continue
  dir=${gitdir%/.git}
  id=${dir##*/}
  if [ -n "${REBAKE_ONLY:-}" ]; then
    case " $REBAKE_ONLY " in
      *" $id "*) ;;
      *) continue ;;
    esac
  fi
  rebake_one "$dir" "$id" || status=1
done
exit "$status"
