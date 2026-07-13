// Genera `dist/icons.json` de un módulo: resuelve cada icono que el módulo usa —los del manifest
// (`icon` + `navigation[].icon`) Y los que pinta su Web Component (`<ion-icon name="…">`)— del set
// Iconify `ion:` a su SVG inline, y los escribe en un sidecar (nombre → "<svg>"). ADR option-b: el
// `module.json` FUENTE guarda solo nombres (legible, firmable); el SVG se hornea EN BUILD y viaja
// en el module.zip dentro de `dist/`.
//
// El módulo es AUTÓNOMO: trae sus iconos. El shell del Hub lee el sidecar al cargarlo
// (module-loader) y (a) lo pasa a `<HubIcon>` para el menú, (b) lo registra con `addIcons()` para
// los `<ion-icon name="…">` del propio WC. Antes solo se horneaban los del manifest, y los del WC
// dependían de que el shell tuviera ese nombre en una lista a mano: el shell no puede saber qué
// iconos usa un módulo de TERCEROS, así que el icono salía VACÍO (offline: ion-icon intenta bajar
// el SVG por red y falla en silencio).
//
// Solo `ion:` por ahora (es el set que usa el shell y todos los módulos POS). Para soportar otros
// sets (lucide/mdi/tabler…) basta añadir su `@iconify-json/<set>` y enrutar por prefijo `set:name`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
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

/** Todos los `.ts` bajo `ui/` — el fuente del Web Component del módulo. */
function uiSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // el módulo puede no tener UI (declarativo puro)
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) uiSources(path, out);
    else if (extname(entry.name) === '.ts') out.push(path);
  }
  return out;
}

/**
 * Nombres de icono que el Web Component del módulo usa, leídos del fuente:
 *
 *   <ion-icon name="cart-outline">                    → cart-outline   (lo pinta el propio módulo)
 *   <ion-icon name=${open ? 'expand' : 'contract'}>   → expand, contract  (los DOS literales: no se
 *                                                       sabe cuál se usará en runtime)
 *   <ok-inline-feedback icon="checkmark-circle">      → checkmark-circle  (se lo pasa a OutfitKit,
 *                                                       que acaba pintando un ion-icon con él)
 *
 * Un nombre que solo existe en runtime (`name=${this.icon}`) no es horneable: se queda para que lo
 * resuelva el registro del shell.
 */
function widgetIconNames(dir) {
  const names = new Set();
  for (const file of uiSources(join(dir, 'ui'))) {
    const source = readFileSync(file, 'utf8');
    for (const tag of source.match(/<(?:ion-icon|ok-[a-z-]+)[^>]*>/g) ?? []) {
      // En un ion-icon el icono va en `name`; en un ok-*, en `icon` (su `name` es otra cosa).
      const attr = tag.startsWith('<ion-icon') ? '(?:name|icon)' : 'icon';
      // Estático: name="cart-outline" / icon="checkmark-circle-outline".
      for (const m of tag.matchAll(new RegExp(`(?<![:.\\w-])${attr}="([a-z][a-z0-9-]*)"`, 'g'))) names.add(m[1]);
      // Enlazado: solo los literales entrecomillados de la expresión (lo demás son variables).
      for (const m of tag.matchAll(new RegExp(`\\.?${attr}=\\$\\{[^}]*\\}`, 'g'))) {
        for (const quoted of m[0].match(/['"][a-z][a-z0-9-]*['"]/g) ?? []) names.add(quoted.slice(1, -1));
      }
    }
  }
  return names;
}

/**
 * Escribe `dist/icons.json` con TODOS los iconos que usa el módulo: los del manifest (menú del
 * shell) + los que pinta su Web Component.
 * @returns {{ count: number, missing: string[] }}
 */
export function generateIcons(dir, manifest) {
  const names = new Set();
  if (manifest.icon) names.add(manifest.icon);
  for (const nav of manifest.navigation ?? []) if (nav.icon) names.add(nav.icon);
  for (const name of widgetIconNames(dir)) names.add(name);

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
