#!/usr/bin/env bash
# The committed bundle is what hub develop's SDK builds — module-toolkit#389.
#
#   check-dist-reproducible.sh <module-dir> <module-sdk-dir>
#   env: ERPLORA_TOOLKIT (the toolkit checkout the action runs from), RUNNER_TEMP
#
# Rebuilds the module's Web Component aside with `erplora build --check` and fails when the
# committed `dist/<id>.esm.js` is not those exact bytes. What goes into the rebuild besides the
# module's code has to be what went into the committed bundle, or the comparison is noise:
#   - the SDK: `<module-sdk-dir>`, the hub develop checkout the gate already has on disk;
#   - esbuild and Lit: the versions the toolkit LOCKS (`package-lock.json`), which is what
#     `npm ci` gives whoever builds;
#   - OutfitKit: the version the module SEALED in `dist/outfitkit.json` (hub#1024). Without a
#     seal none is installed and the check itself reports the bundle as unsealed.
# Guard: test/check-dist-reproducible-script.test.mjs (run for real, with a fake npm).
set -euo pipefail

mod=$(cd "$1" && pwd)
sdk="${2:-}"
toolkit="${ERPLORA_TOOLKIT:?ERPLORA_TOOLKIT is set by the validator install step}"

# One door for «not supplied» and «supplied but empty»: either way there is no develop SDK to rebuild with.
if [ -z "$sdk" ] || [ ! -f "$sdk/package.json" ]; then
  echo "::error::module-sdk-path ('$sdk') holds no @erplora/module-sdk: without hub develop's SDK the committed bundle cannot be rebuilt to compare. It comes from ERPlora/hub/.github/actions/module-sdk in module-gate.yml (module-toolkit#389)"
  exit 1
fi

# The packages the bundle bakes, at the toolkit's locked versions: the bundler and the whole Lit
# family (the resolve plugin pins every `lit*`/`@lit/*` specifier to the toolkit's own copy).
# A read loop, not `mapfile`: `npm test` runs this on a Mac's /bin/bash 3.2 (module-toolkit#410).
baked=()
while IFS= read -r spec; do baked+=("$spec"); done < <(node -e '
  const lock = require(process.argv[1]);
  for (const [key, meta] of Object.entries(lock.packages)) {
    const m = /^node_modules\/(esbuild|lit|lit-html|lit-element|@lit\/[^/]+|@lit-labs\/[^/]+)$/.exec(key);
    if (m && meta.version) console.log(`${m[1]}@${meta.version}`);
  }
' "$toolkit/package-lock.json")

deps="${RUNNER_TEMP:?}/erplora-bundle-deps"
# Belt and braces, like the validator's own scratch install: never depend on the runner's cleanup.
rm -rf "$deps"
mkdir -p "$deps"
# `--legacy-peer-deps`: see test/npm-scratch-install-skips-peer-resolution.test.mjs (module-toolkit#171).
npm_install() {
  npm install --prefix "$deps" --cache "$deps/.npm-cache" --no-audit --no-fund --loglevel=error --legacy-peer-deps "$@"
}

sealed=$(node -e 'try { process.stdout.write(String(require(process.argv[1]).outfitkit ?? "")) } catch {}' "$mod/dist/outfitkit.json")
if [ -n "$sealed" ]; then
  # In one install with the rest, so OutfitKit's own Lit dedupes onto the locked one.
  if ! npm_install "${baked[@]}" "@erplora/outfitkit@$sealed"; then
    echo "::error::the bundle was built with @erplora/outfitkit@$sealed (dist/outfitkit.json) and npm could not install that version: no rebuild can reproduce it. Rebuild with a published OutfitKit and commit dist/ (erplora build <dir>)"
    exit 1
  fi
  baked+=("@erplora/outfitkit@$sealed")
else
  npm_install "${baked[@]}"
fi

# ESM ignores NODE_PATH: each package has to be resolvable from the toolkit itself.
for spec in "${baked[@]}"; do
  name="${spec%@*}"
  mkdir -p "$(dirname "$toolkit/node_modules/$name")"
  ln -sfn "$deps/node_modules/$name" "$toolkit/node_modules/$name"
done

node "$toolkit/bin/erplora.mjs" build "$mod" --check --sdk "$sdk"
