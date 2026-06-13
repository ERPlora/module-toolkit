// Genera `dist/icons.json` de un módulo: para cada icono que referencia el manifest
// (`icon` + `navigation[].icon`), resuelve el nombre Iconify del set `ion:` a su SVG inline y lo
// escribe en un sidecar (nombre → "<svg>"). ADR option-b: el `module.json` FUENTE guarda solo
// nombres (legible, firmable); el SVG se hornea EN BUILD y viaja en el module.zip dentro de
// `dist/`. El shell del Hub lee este sidecar (module-loader.loadMenu) y lo pasa tal cual a
// `<HubIcon :name>` — offline, sin red, sin que el shell tenga que conocer los iconos del módulo.
//
// Solo `ion:` por ahora (es el set que usa el shell y todos los módulos POS). Para soportar otros
// sets (lucide/mdi/tabler…) basta añadir su `@iconify-json/<set>` y enrutar por prefijo `set:name`.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getIconData, iconToSVG, iconToHTML, replaceIDs } from '@iconify/utils';

const require = createRequire(import.meta.url);
const ionSet = require('@iconify-json/ion/icons.json');

// Alias estilo lucide que aún arrastran algunos manifests → nombre `ion:` canónico. Red de
// seguridad; los module.json se están migrando a nombres `ion:` directos.
const ALIASES = {
  'dollar-sign': 'cash-outline',
  users: 'people-outline',
  'file-text': 'document-text-outline',
  'shopping-cart': 'cart-outline',
};

/** Nombre Iconify `ion:` → SVG inline (`<svg …>…</svg>`), o `null` si no existe en el set. */
function svgFor(name) {
  const data = getIconData(ionSet, ALIASES[name] ?? name);
  if (!data) return null;
  const { attributes, body } = iconToSVG(data);
  return iconToHTML(replaceIDs(body), attributes);
}

/**
 * Escribe `dist/icons.json` con los iconos referenciados por el manifest.
 * @returns {{ count: number, missing: string[] }}
 */
export function generateIcons(dir, manifest) {
  const names = new Set();
  if (manifest.icon) names.add(manifest.icon);
  for (const nav of manifest.navigation ?? []) if (nav.icon) names.add(nav.icon);

  const map = {};
  const missing = [];
  for (const name of names) {
    const svg = svgFor(name);
    if (svg) map[name] = svg;
    else missing.push(name);
  }

  writeFileSync(join(dir, 'dist', 'icons.json'), JSON.stringify(map) + '\n');
  return { count: Object.keys(map).length, missing };
}
