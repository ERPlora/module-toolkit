// Generates a module's `dist/icons.json`: resolves every icon the module uses — the manifest ones
// (`icon` + `navigation[].icon`), the ones its Web Component renders in markup
// (`<ion-icon name="…">`), AND the ones it passes as data (`icon: 'trash-outline'` in the
// `actions` of ok-data-table) — from the Iconify `ion:` set to inline SVG, written to a sidecar
// (name → "<svg>"). ADR option-b: the SOURCE `module.json` keeps only names (readable, signable);
// the SVG is baked AT BUILD time and travels in the module.zip inside `dist/`.
//
// The module is SELF-CONTAINED: it brings its own icons. The Hub shell reads the sidecar on load
// (module-loader) and (a) hands it to `<HubIcon>` for the menu, (b) registers it via `addIcons()`
// for the WC's own `<ion-icon name="…">`. The shell cannot know which icons a THIRD-PARTY module
// uses; an unregistered name means ion-icon tries to fetch the SVG over the network and fails
// silently offline — the icon renders BLANK. So when in doubt the scanner over-bakes: an extra
// baked icon costs bytes, a missed one costs a blank button in production (#22).
//
// Only `ion:` for now (the set the shell and all POS modules use). To support other sets
// (lucide/mdi/tabler…) add their `@iconify-json/<set>` and route by `set:name` prefix.
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

/** Source extensions the scanner reads — TS is the norm, plain JS modules are legal too. */
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx']);

/** Every TS/JS source under `ui/` — the module's Web Component source. */
function uiSources(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // the module may have no UI (purely declarative)
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) uiSources(path, out);
    else if (SOURCE_EXTS.has(extname(entry.name))) out.push(path);
  }
  return out;
}

// An `icon` property in an object literal (`icon: <value-expression>`), with the value expression
// captured up to the end of the property: comma, semicolon, closing brace or end of line. The key
// may be quoted (`"icon":`); the lookbehind rejects other keys that merely end in "icon"
// (`data-icon:`, `my_icon:`). A TS type annotation (`icon: string;`) matches the key but its value
// expression holds no quoted literal, so it bakes nothing.
const ICON_PROP = /(?<![\w-])['"]?icon['"]?\s*:\s*([^,;}\n]*)/g;
// A fully-quoted kebab-case icon name — the quote must close right after the name, so
// `t('ui.actionEdit')` (dots, uppercase) never matches.
const QUOTED_ICON_NAME = /['"`][a-z][a-z0-9-]*['"`]/g;

/**
 * Icon names the module's Web Component uses, read from its source:
 *
 *   <ion-icon name="cart-outline">                    → cart-outline   (rendered by the module)
 *   <ion-icon name=${open ? 'expand' : 'contract'}>   → expand, contract  (BOTH literals: the one
 *                                                       used is only known at runtime)
 *   <ok-inline-feedback icon="checkmark-circle">      → checkmark-circle  (handed to OutfitKit,
 *                                                       which ends up rendering an ion-icon)
 *   { id: 'delete', icon: 'trash-outline' }           → trash-outline  (passed as DATA, not markup:
 *                                                       ok-data-table `actions` and friends — #22)
 *   .cardIcon=${() => 'person-outline'}               → person-outline  (icon-suffixed prop binding;
 *                                                       ok-data-table's mobile auto-cards icon)
 *   icon: (r.icon as string) ?? 'cube-outline'        → cube-outline  (the literal fallback is in
 *                                                       use even if the main value is dynamic)
 *
 * A name that only exists at runtime (`name=${this.icon}`, `icon: row.icon`) is not bakeable: it is
 * left for the shell registry to resolve.
 */
function widgetIconNames(dir) {
  const names = new Set();
  for (const file of uiSources(join(dir, 'ui'))) {
    const source = readFileSync(file, 'utf8');
    for (const tag of source.match(/<(?:ion-icon|ok-[a-z-]+)[^>]*>/g) ?? []) {
      // On an ion-icon the icon goes in `name`; on an ok-*, in `icon` OR any icon-suffixed prop
      // (`.cardIcon` on ok-data-table, `empty-icon`…) — its `name` means something else.
      const attr = tag.startsWith('<ion-icon') ? '(?:name|icon)' : '(?:[a-zA-Z-]*[iI]con)';
      // Static: name="cart-outline" / icon="checkmark-circle-outline".
      for (const m of tag.matchAll(new RegExp(`(?<![:.\\w-])${attr}="([a-z][a-z0-9-]*)"`, 'g'))) names.add(m[1]);
      // Bound: only the quoted literals of the expression (the rest are variables).
      for (const m of tag.matchAll(new RegExp(`\\.?${attr}=\\$\\{[^}]*\\}`, 'g'))) {
        for (const quoted of m[0].match(QUOTED_ICON_NAME) ?? []) names.add(quoted.slice(1, -1));
      }
    }
    // Bound icon-suffixed props, scanned on the WHOLE source: the tag-bounded scan above truncates
    // at the `>` of an arrow function (`.cardIcon=${() => 'person-outline'}`, ok-data-table's
    // mobile auto-cards icon), so it never sees the literal. Any `…icon`/`…Icon` binding carries
    // icon names by convention.
    for (const m of source.matchAll(/\.?[a-zA-Z-]*[iI]con=\$\{[^}]*\}/g)) {
      for (const quoted of m[0].match(QUOTED_ICON_NAME) ?? []) names.add(quoted.slice(1, -1));
    }
    // Icons passed as data, not markup: every quoted literal in the value of an `icon:` property
    // (direct value, ternary branch or `??` fallback). This is what ok-data-table `actions` use.
    for (const m of source.matchAll(ICON_PROP)) {
      for (const quoted of m[1].match(QUOTED_ICON_NAME) ?? []) names.add(quoted.slice(1, -1));
    }
  }
  return names;
}

/**
 * Every `icon` property anywhere in the manifest whose value looks like an icon name. Not just the
 * top-level `icon` + `navigation[].icon`: the manifest also declares icons in `settings.icon` and
 * in the dashboard `widgets` blocks (ADR-0054) — a rebuild that missed those left them BLANK.
 */
function manifestIconNames(node, names = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) manifestIconNames(item, names);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'icon' && typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value)) names.add(value);
      else manifestIconNames(value, names);
    }
  }
  return names;
}

/**
 * Writes `dist/icons.json` with EVERY icon the module uses: the manifest ones (shell menu,
 * settings, dashboard widgets) + the ones its Web Component renders or passes as data.
 * @returns {{ count: number, missing: string[] }}
 */
export function generateIcons(dir, manifest) {
  const names = manifestIconNames(manifest);
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
