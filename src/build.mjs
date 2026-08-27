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
import { build as esbuild } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { assertCspSafe } from './validate.mjs';
import { erploraResolvePlugin } from './resolve-plugin.mjs';
import { generateIcons } from './icons.mjs';
import { stampOutfitkit, OUTFITKIT_STAMP } from './outfitkit-stamp.mjs';
import { bundleStampFile, checkBundleProvenance, normalizeBundlePaths, stampBundle } from './bundle-freshness.mjs';
import { buildWasmHandler } from './wasm.mjs';

// Flags clásicos de decoradores para los `@state()/@property()` de Lit (igual que Vite).
const TSCONFIG_RAW = {
  compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
};

export async function build(moduleDir, { wasm = {} } = {}) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const id = manifest.id;

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

  const common = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile,
    minify: false,
    legalComments: 'none',
    tsconfigRaw: TSCONFIG_RAW,
    plugins: [erploraResolvePlugin()],
  };

  const entry = resolveEntry(dir);
  if (entry.entryPoints) {
    await esbuild({ ...common, entryPoints: entry.entryPoints });
  } else {
    // Entry sintético (varios componentes): se importan todos por efecto secundario (auto-define).
    await esbuild({
      ...common,
      stdin: { contents: entry.contents, resolveDir: entry.resolveDir, sourcefile: `${id}.entry.ts`, loader: 'ts' },
    });
  }

  // module-toolkit#93 (causa raíz): esbuild anota la ruta de cada entrada como comentario, RELATIVA
  // al working dir del PROCESO. Construir desde otro sitio (el checkout del toolkit, un worktree de
  // la flota) horneaba rutas ABSOLUTAS en el artefacto publicado — `verifactu` publicó 8 apuntando
  // al scratchpad de otro agente. Normalizarlas hace que el bundle salga IGUAL desde cualquier
  // máquina, que es lo que la comprobación de procedencia exige aguas abajo.
  writeFileSync(outfile, normalizeBundlePaths(readFileSync(outfile, 'utf8'), dir), 'utf8');

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

  // El SELLO de OutfitKit (ERPlora/hub#1024): con qué versión se horneó este bundle. En un hub real
  // el shell define sus `ok-*` primero y el `define()` horneado —que está guardado— pierde en
  // silencio, así que el módulo corre con una OutfitKit que no es la suya y nadie lo compara. El
  // sello no arregla esa deriva: la hace visible (el shell avisa cuando descarta una copia distinta).
  const okVersion = stampOutfitkit(dir);
  console.log(
    okVersion
      ? `✓ outfitkit ${id}: dist/${OUTFITKIT_STAMP} (horneada ${okVersion})`
      : `⚠ outfitkit ${id}: sin versión resoluble — el bundle va SIN sello y el shell no podrá avisar de una deriva`,
  );
  return outfile;
}

// Resuelve el/los entry(s) del WC. Prioridad: `src/*.js` (legacy) → `ui/components/**/*.ts` (Lit).
// Exportada para fijar en un test QUÉ entra en el artefacto publicado (test/build-entry.test.mjs).
export function resolveEntry(dir) {
  const srcDir = join(dir, 'src');
  if (existsSync(srcDir)) {
    const f = readdirSync(srcDir).find((n) => n.endsWith('.js'));
    if (f) return { entryPoints: [join(srcDir, f)] };
  }

  const compDir = join(dir, 'ui', 'components');
  if (existsSync(compDir)) {
    const ts = collectTs(compDir);
    if (ts.length === 1) return { entryPoints: [ts[0]] };
    if (ts.length > 1) {
      const contents = ts.map((p) => `import ${JSON.stringify(p)};`).join('\n');
      return { contents, resolveDir: dir };
    }
  }

  throw new Error(`No encuentro entry de WC en ${dir} (ni src/*.js ni ui/components/**/*.ts)`);
}

function collectTs(p) {
  const out = [];
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const full = join(p, name);
    if (statSync(full).isDirectory()) out.push(...collectTs(full));
    // Fuera del artefacto publicado: los tests (TDD) viven junto al componente, pero arrastran
    // vitest —y con él un `new Function()`— que la CSP estricta del Hub bloquea.
    else if (extname(full) === '.ts' && !name.endsWith('.d.ts') && !/\.(test|spec)\.ts$/.test(name)) out.push(full);
  }
  return out;
}
