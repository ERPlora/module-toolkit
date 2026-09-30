// `erplora build <dir>`: compila el Web Component (Lit) de un módulo STANDALONE — un repo que
// vive FUERA de cualquier workspace y NO declara deps — a un ESM auto-contenido
// (dist/<id>.esm.js), el artefacto que va en `ui.entry` del module.zip. Tras compilar valida CSP.
//
// La resolución de `lit` + `@erplora/*` la aporta el TOOLKIT vía `erploraResolvePlugin` (ver
// resolve-plugin.mjs): el repo del módulo queda limpio (sin node_modules ni lockfile). El bundle
// es AUTO-CONTENIDO (lit + outfitkit dentro, una sola copia) — sin import-map, sin externals
// (decisión 2026-06-07: bajo `script-src 'self'` un import-map inline viola la CSP).
//
// Mismo contrato de salida que el antiguo @erplora/module-cli (dist/<id>.esm.js) para no tocar
// module-loader/sync-modules.
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertCspSafe } from './validate.mjs';
import { generateIcons } from './icons.mjs';
import { stampOutfitkit, OUTFITKIT_STAMP } from './outfitkit-stamp.mjs';
import { bundleStampFile, checkBundleProvenance, stampBundle } from './bundle-freshness.mjs';
import { bundleWebComponent, resolveEntry } from './bundle-web-component.mjs';
import { buildWasmHandler } from './wasm.mjs';
import { assertSdkFresh } from './sdk-freshness.mjs';
import { resolveOutfitkit } from './outfitkit-ci.mjs';

// The bundling recipe is shared with `build --check` (module-toolkit#389); re-exported here, where
// callers (and test/build-entry.test.mjs) have always found it.
export { bundleWebComponent, resolveEntry };

export async function build(moduleDir, { wasm = {}, sdk = {}, outfitkit = {} } = {}) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const id = manifest.id;

  // module-toolkit#387: the SDK resolves into the shared `../hub` checkout, whatever branch it is
  // on, and the bundle is published as committed. Behind develop → THROWS with the command that
  // updates it, before anything in dist/ is rewritten. `sdk` injects the SDK dir and develop's sha
  // in tests; in production both resolve themselves.
  const sdkCheck = assertSdkFresh(sdk);
  if (sdkCheck.status === 'fresh') {
    console.log(`✓ module-sdk ${id}: ${sdkCheck.branch}@${sdkCheck.head.slice(0, 7)} up to date with hub develop (${sdkCheck.develop.slice(0, 7)})`);
  } else if (sdkCheck.status === 'unverifiable') {
    console.warn(
      `⚠ module-sdk ${id}: could not compare ${sdkCheck.hubDir} with hub develop (${sdkCheck.reason}) — ` +
        'if that checkout is behind, this bundle ships an old SDK',
    );
  }

  // module-toolkit#423: the OutfitKit the module gate installs (npm: what the module declares, or
  // `latest`), never the toolkit's local copy — a link to the shared `outfitkit/` checkout that
  // sealed 0.1.79 into 21 modules whose tests ran against 0.1.125. Resolved BEFORE dist/ is touched:
  // without npm this throws, it never falls back to the checkout. `outfitkit.env` is for tests.
  const ok = resolveOutfitkit(dir, outfitkit);

  const outfile = join(dir, 'dist', `${id}.esm.js`);
  mkdirSync(join(dir, 'dist'), { recursive: true });

  // Tier-2 handler BEFORE the Web Component (module-toolkit#26): until today `build` only touched
  // the JS bundle and the icons, so a module whose `handler/src/lib.rs` had just changed was packed
  // with the `dist/handler.wasm` of the last MANUAL compile — old logic under a new manifest, with
  // nothing failing until it reached a real hub (tables#25, pricing#17). It runs first so a handler
  // that cannot be regenerated fails before the bundle is spent: `buildWasmHandler` THROWS there.
  // `wasm` injects the toolchain/runner in tests; in production both resolve themselves.
  const handler = buildWasmHandler(dir, manifest, wasm);
  if (handler.status === 'built') {
    console.log(`✓ wasm ${id}: ${handler.file} recompilado (${(handler.bytes / 1024).toFixed(1)} KB)`);
  } else if (handler.status === 'fresh') {
    console.log(`✓ wasm ${id}: ${handler.file} al día (no se recompila)`);
  }

  await bundleWebComponent(dir, id, outfile, { sdkDir: sdk.sdkDir, outfitkitPrefix: ok.prefix });

  const code = readFileSync(outfile, 'utf8');
  assertCspSafe(code, `${id} bundle`);
  // Tras normalizar esto no debería disparar nunca; si lo hace, algo metió una ruta de esta máquina
  // en el artefacto y publicarlo es peor que fallar aquí (module-toolkit#93).
  const provenance = checkBundleProvenance(dir, manifest);
  if (provenance.errors.length) throw new Error(provenance.errors.join('\n  - '));
  console.log(`✓ build ${id}: ${outfile} (${(code.length / 1024).toFixed(1)} KB, CSP-safe)`);

  // Sidecar de iconos (ADR option-b): hornea el SVG de los nombres Iconify del manifest →
  // dist/icons.json, que viaja en el module.zip y consume el shell del Hub. Ver icons.mjs.
  const icons = generateIcons(dir, manifest);
  console.log(`✓ icons ${id}: dist/icons.json (${icons.count} iconos)${
    icons.missing.length ? ` ⚠ sin resolver en ion:: ${icons.missing.join(', ')}` : ''}`);


  // El SELLO DE FRESCURA del bundle (module-toolkit#93): qué `ui/` produjo estos bytes. Es la única
  // evidencia que un rebuild siempre puede limpiar, y la que convierte el aviso de `validate` en
  // error para este módulo a partir de ahora.
  stampBundle(dir, manifest);
  console.log(`✓ freshness ${id}: ${bundleStampFile(id)} (sello de ui/)`);

  // The OutfitKit SEAL (ERPlora/hub#1024): which version this bundle baked. In a real hub the shell
  // defines its `ok-*` first and the baked, guarded `define()` loses in silence, so the module runs
  // with an OutfitKit that is not its own; the seal makes that drift visible. Since
  // module-toolkit#423 it is also what the gate's screen tests install and `build --check` rebuilds with.
  stampOutfitkit(dir, { version: ok.version });
  console.log(`✓ outfitkit ${id}: dist/${OUTFITKIT_STAMP} (baked ${ok.version} from npm, what the module gate installs)`);
  return outfile;
}
