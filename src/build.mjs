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
import { readFileSync, mkdirSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { assertCspSafe } from './validate.mjs';
import { erploraResolvePlugin } from './resolve-plugin.mjs';

// Flags clásicos de decoradores para los `@state()/@property()` de Lit (igual que Vite).
const TSCONFIG_RAW = {
  compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
};

export async function build(moduleDir) {
  const dir = resolve(process.cwd(), moduleDir);
  const manifest = JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'));
  const id = manifest.id;

  const outfile = join(dir, 'dist', `${id}.esm.js`);
  mkdirSync(join(dir, 'dist'), { recursive: true });

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

  const code = readFileSync(outfile, 'utf8');
  assertCspSafe(code, `${id} bundle`);
  console.log(`✓ build ${id}: ${outfile} (${(code.length / 1024).toFixed(1)} KB, CSP-safe)`);
  return outfile;
}

// Resuelve el/los entry(s) del WC. Prioridad: `src/*.js` (legacy) → `ui/components/**/*.ts` (Lit).
function resolveEntry(dir) {
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
    else if (extname(full) === '.ts' && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}
