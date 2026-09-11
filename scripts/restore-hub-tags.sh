#!/usr/bin/env bash
# Put the hub's real tag objects back before the mirrors read them (module-toolkit#201).
#
# WHY THIS EXISTS. `HUB_OUTFITKIT` (src/validate-outfitkit-floor.mjs) dates every row with WHEN THE
# TAG WAS CREATED, because that is when the image was built and the Dockerfile resolved
# `@erplora/outfitkit@latest`. For an annotated tag that instant is the TAGGER date, and it is not
# the date of the commit the tag points at: `v1.1.4` was tagged 44 h after its commit, two OutfitKit
# releases later. Reading the commit is not a rounding error, it is a different OutfitKit.
#
# And the job that checks the table cannot read the tagger date, because the checkout destroys it.
# From the `v1.1.22` run (hub, 34596411236), with `fetch-depth: 0` and `fetch-tags: true` both set:
#
#     git -c protocol.version=2 fetch --no-tags --prune --no-recurse-submodules \
#         origin +0e438184dc73c1ddb47ff36ae7a63b8bad004025:refs/tags/v1.1.22
#      t [tag update]        0e438184dc73c1ddb47ff36ae7a63b8bad004025 -> v1.1.22
#
# `actions/checkout` resolves a tag ref to `github.sha` — the COMMIT — and forces that into
# `refs/tags/v1.1.22`, over the annotated object the runner's cached clone already had. From then on
# `%(creatordate)` quietly means "commit date" instead of "tagger date", and the mirror reports that
# the TABLE drifted when what drifted was the checkout. It blocked `v1.1.22` twice, against a table
# whose row was right.
#
# The twelve releases before it were lightweight tags, where both readings are the same instant, so
# the flattening changed nothing and nobody saw it. Every annotated tag from here on would fail the
# same way. Guards: the `#201` tests at the end of `test/hub-mirror.test.mjs`, which reproduce the
# flattening with real git and would go red if this repair stopped being called.
set -euo pipefail

dir=${1:?usage: restore-hub-tags.sh <hub-checkout>}

# A DECLARED hub that is not a repository is a legitimate source, not a fault: GitHub resolves an
# action by downloading a TARBALL — files, and not one ref. `hubTags` already skips the tag mirrors
# for that copy, so there is nothing here to put back, and failing would take the six FILE mirrors
# (which need no tags at all) down with it.
if [ ! -e "$dir/.git" ]; then
  echo "→ \`$dir\` carries no refs (an action tarball has files and no \`.git\`): no tags to restore"
  exit 0
fi

# 🔴 It RESTORES, it does not go and fetch. `--tags` would be one word shorter and wrong: the hub's
# PR workflow checks out with no tags at all, `hubTags` skips those runs honestly, and pulling the
# tags in would switch that mirror ON for every caller at once — the first release cut without its
# row would then turn every unrelated hub PR red. Only refs this checkout ALREADY has are put back.
#
# And they are intersected with what origin recognises, because a shared checkout carries refs
# nobody pushed (`v1.1.22-local-10sep-backup` was sitting in one while this was written,
# module-toolkit#258). Asking origin for a ref it never heard of fails the whole fetch.
if ! remote=$(git -C "$dir" ls-remote --tags origin 2>&1); then
  echo "🔴 could not ask \`origin\` which tags it has, so the tags of \`$dir\` cannot be restored." >&2
  echo "   git said: ${remote}" >&2
  echo "   The canonical mirrors date HUB_OUTFITKIT by each tag's CREATION, and \`actions/checkout\`" >&2
  echo "   leaves annotated tags flattened to the commit they point at. Reading them as they are" >&2
  echo "   compares the table against the wrong clock and blames the table (module-toolkit#201)." >&2
  exit 1
fi
known=$(printf '%s\n' "$remote" | awk '{print $2}' | sed 's/\^{}$//' | sort -u)

refspecs=()
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  # `+<ref>:<ref>` by NAME is the whole repair: fetching a tag by name brings the tag OBJECT, which
  # is what carries the tagger date. (The `+` is belt and braces, not the lever — measured: git
  # takes the update either way, because the tag object peels to the ref's current commit.)
  printf '%s\n' "$known" | grep -Fxq "$ref" && refspecs+=("+${ref}:${ref}")
done < <(git -C "$dir" for-each-ref --format='%(refname)' 'refs/tags/*')

if [ ${#refspecs[@]} -eq 0 ]; then
  echo "→ \`$dir\` has no tag that \`origin\` also has: nothing to restore"
  exit 0
fi

# 🔴 `--no-tags` is load-bearing, not tidiness: git AUTO-FOLLOWS tags that point into the history it
# is fetching, so without it a repair of one ref quietly drags in every other release tag that
# points at a commit already present. Measured — the test above went red on exactly that.
if ! git -C "$dir" fetch --no-tags --force --quiet origin "${refspecs[@]}"; then
  echo "🔴 could not restore the ${#refspecs[@]} tag(s) of \`$dir\` from \`origin\` (#201)." >&2
  exit 1
fi

echo "→ restored ${#refspecs[@]} tag object(s) of \`$dir\` from \`origin\`"
