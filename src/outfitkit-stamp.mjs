// El SELLO de OutfitKit: qué versión metió `erplora build` dentro del bundle (ERPlora/hub#1024).
//
// **Por qué existe.** El bundle de un módulo es auto-contenido (build.mjs): lleva Lit y OutfitKit
// dentro, resueltos por `erploraResolvePlugin` desde los `node_modules` del TOOLKIT — es decir, el
// checkout local de quien construyó. En un hub real esa copia casi nunca manda: el shell define sus
// `ok-*` al arrancar y el `define()` horneado está guardado (`if (!customElements.get(tag))`), así
// que **pierde en silencio**. Y la imagen del hub instala `@erplora/outfitkit@latest` en CADA build.
//
// O sea: en la flota conviven dos OutfitKit repartidos elemento por elemento — el del shell para lo
// que él importa, el del módulo para lo que no— y hasta hoy **nadie comparaba esas dos versiones**.
// Un cambio de contrato rompe módulos publicados sin que ningún test lo vea, y en `pnpm dev` no
// reproduce porque ahí las dos copias son el mismo checkout.
//
// Esto no arregla la deriva: la hace **visible**. El shell lee este fichero al cargar el módulo y
// avisa cuando descarta una copia de versión distinta a la suya.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Nombre del sello dentro de `dist/`. Viaja en el module.zip como `icons.json`. */
export const OUTFITKIT_STAMP = 'outfitkit.json';

/**
 * Where the toolkit resolves its OutfitKit — the SAME copy the bundler just baked in.
 *
 * Resolved the way `erploraResolvePlugin` does (`import.meta.resolve` from the toolkit), not by
 * guessing `<toolkit>/node_modules`: installed as a dependency, npm hoists OutfitKit NEXT TO the
 * toolkit, and the guessed path then holds nothing — the seal was silently skipped
 * (module-toolkit#333). The resolved entry is walked up to the package root that names it.
 */
export function toolkitOutfitkitDir() {
  const fallback = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@erplora', 'outfitkit');
  let dir;
  try {
    dir = dirname(fileURLToPath(import.meta.resolve('@erplora/outfitkit/define')));
  } catch {
    return fallback;
  }
  for (;;) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).name === '@erplora/outfitkit') return dir;
      } catch {
        // An unreadable package.json on the way up is not OutfitKit's: keep climbing.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

/**
 * Escribe `dist/outfitkit.json` con la versión horneada. Devuelve la versión, o `null` si no se
 * pudo resolver.
 *
 * `version` (para tests) gana sobre `packageDir`, y este sobre la copia real del toolkit. Sin
 * ninguna de las tres **no se escribe nada**: un sello con `"unknown"` dentro se lee igual que uno
 * real y desarmaría el aviso del shell justo cuando hace falta. La ausencia, en cambio, es un
 * estado que el shell ya tiene que saber tratar — es lo que traen los 25 módulos publicados hoy.
 */
export function stampOutfitkit(moduleDir, { version, packageDir } = {}) {
  let resolved = version ?? null;
  if (!resolved) {
    const pkg = join(packageDir ?? toolkitOutfitkitDir(), 'package.json');
    if (!existsSync(pkg)) return null;
    try {
      resolved = JSON.parse(readFileSync(pkg, 'utf8')).version ?? null;
    } catch {
      return null;
    }
  }
  if (!resolved) return null;
  writeFileSync(
    join(moduleDir, 'dist', OUTFITKIT_STAMP),
    `${JSON.stringify({ outfitkit: resolved }, null, 2)}\n`,
    'utf8',
  );
  return resolved;
}
