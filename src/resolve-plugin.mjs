// Plugin de resolución de esbuild: el toolkit ES el "envoltorio" que provee las deps de build.
// El repo de un módulo NO declara `lit`/`@erplora/*`; este plugin intercepta esos specifiers
// (incluidos los que aparecen DENTRO del dist de outfitkit, p.ej. `lit/directives/repeat.js`)
// y los fija a la ÚNICA copia instalada en `node_modules` del toolkit.
//
// Por qué un plugin y no `nodePaths`/`alias`: hace falta DEDUPLICAR `lit`. El WC del módulo
// importa `lit` y el dist de `@erplora/outfitkit` también; si esbuild los resolviese por
// separado (dos rutas reales distintas) habría DOS copias de Lit en el bundle → decoradores
// y reactive-controllers rotos. Interceptando todo `lit*` y `@erplora/*` y resolviéndolos
// SIEMPRE desde este módulo del toolkit, garantizamos una sola copia, sea cual sea el gestor
// de paquetes o el anidamiento (symlinks de `file:` incluidos).
import { fileURLToPath } from 'node:url';

// `import.meta.resolve(spec)` (Node ≥20, estable y síncrono) resuelve relativo a ESTE módulo,
// que vive en el toolkit → cae en `module-toolkit/node_modules`. Honra el "exports" map
// (subpaths de lit y de outfitkit: `/define`, `/ok-data-table`, `/directives/*`).
const PINNED = /^(lit($|\/)|@lit\/|@erplora\/(outfitkit|module-sdk|module-types)($|\/))/;

export function erploraResolvePlugin() {
  return {
    name: 'erplora-resolve',
    setup(build) {
      build.onResolve({ filter: PINNED }, (args) => {
        try {
          return { path: fileURLToPath(import.meta.resolve(args.path)) };
        } catch (err) {
          return {
            errors: [
              {
                text:
                  `No pude resolver '${args.path}' desde el toolkit. ` +
                  `¿Faltan deps? Ejecuta 'npm install' en module-toolkit. (${err.message})`,
              },
            ],
          };
        }
      });
    },
  };
}
