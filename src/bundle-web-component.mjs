// The Web Component bundling recipe: what goes into `dist/<id>.esm.js` and how — module-toolkit#389.
//
// Shared by `erplora build` (which writes the bundle) and `erplora build --check` (which rebuilds it
// aside and compares). Its own module, and a light one, because the check runs in the gate of the
// module repos, where every package is installed by hand: `build.mjs` also generates icons and
// compiles handlers and would pull `@iconify/*` in just to load. Here it is esbuild and nothing else.
import { build as esbuild } from 'esbuild';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { erploraResolvePlugin } from './resolve-plugin.mjs';
import { normalizeBundlePaths } from './bundle-freshness.mjs';

// Classic decorator flags for Lit's `@state()/@property()` (same as Vite).
const TSCONFIG_RAW = {
  compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
};

/**
 * Bundles the module's Web Component into `outfile` — Lit, OutfitKit and the SDK inside, the paths
 * esbuild annotates made machine-independent — and returns the code. The one recipe behind both
 * `build` and `build --check`: a check that bundled any other way would be comparing against a
 * bundle nobody ships.
 *
 * @param {{sdkDir?: string}} [options] `sdkDir`: bake this `@erplora/module-sdk` instead of the
 *   toolkit's installed one.
 */
export async function bundleWebComponent(dir, id, outfile, { sdkDir } = {}) {
  const common = {
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outfile,
    minify: false,
    legalComments: 'none',
    tsconfigRaw: TSCONFIG_RAW,
    plugins: [erploraResolvePlugin({ sdkDir })],
  };

  const entry = resolveEntry(dir);
  if (entry.entryPoints) {
    await esbuild({ ...common, entryPoints: entry.entryPoints });
  } else {
    // Synthetic entry (several components): each one imported for its side effect (auto-define).
    await esbuild({
      ...common,
      stdin: { contents: entry.contents, resolveDir: entry.resolveDir, sourcefile: `${id}.entry.ts`, loader: 'ts' },
    });
  }

  // module-toolkit#93 (root cause): esbuild annotates each input's path as a comment, RELATIVE to
  // the PROCESS working dir. Building from elsewhere (the toolkit checkout, a fleet worktree) baked
  // ABSOLUTE paths into the published artefact — `verifactu` shipped 8 pointing into another
  // agent's scratchpad. Normalised, the bundle comes out the SAME from any machine, which is what
  // the provenance check downstream (and `build --check`) require.
  const code = normalizeBundlePaths(readFileSync(outfile, 'utf8'), dir);
  writeFileSync(outfile, code, 'utf8');
  return code;
}

// Resolves the WC entry(s). Priority: `src/*.js` (legacy) → `ui/components/**/*.ts` (Lit).
// Exported to pin in a test WHAT goes into the published artefact (test/build-entry.test.mjs).
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
    // Kept out of the published artefact: the tests (TDD) live next to the component but drag in
    // vitest — and with it a `new Function()` the Hub's strict CSP blocks.
    else if (extname(full) === '.ts' && !name.endsWith('.d.ts') && !/\.(test|spec)\.ts$/.test(name)) out.push(full);
  }
  return out;
}
