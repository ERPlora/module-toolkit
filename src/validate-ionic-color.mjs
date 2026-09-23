// `color=` on an Ionic element inside a module's shadow root paints nothing — module-toolkit#273.
//
// Ionic implements `color=` in two halves. The component adds `.ion-color .ion-color-<name>` to its
// host and paints from `--ion-color-base` (`button.ios.css`:
// `:host(.button-solid.ion-color) .button-native { background: var(--ion-color-base) }`). The VALUE
// of `--ion-color-base` comes from a GLOBAL rule in `@ionic/core/css/core.css`
// (`.ion-color-danger { --ion-color-base: … }`), and document stylesheets do not match elements
// inside a shadow tree. Every screen of a module is a Lit Web Component with its own shadow root, so
// a solid `ion-button` / `ion-badge` / `ion-chip` comes out as white text on a transparent
// background — an invisible action — and an outline button, an `ion-icon` or an `ion-note` just
// loses the colour it promised. It shipped on two primary actions (kitchen#42, cash_register#90) and
// each was fixed alone, never guarded.
//
// The fix per use: drop `color=` and set the element's custom properties from the theme tokens in
// the component's styles (`--background: var(--ion-color-danger, #c5000f)`, `--color: …`) — custom
// properties DO inherit through the shadow boundary.
//
// Same design as `validate-ionic-fill.mjs` (a ratchet per file and count, stale entries fail) and the
// same tag reader: a Lit tag does not end at the first `>`. Mirror alarm: the premise is pinned to
// the dependency in `test/validate-ionic-color.test.mjs`; the day it stops holding, delete this file.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { endOfTag } from './validate-ionic-fill.mjs';

const ION_TAG_START = /<ion-[a-z-]+(?=[\s/>])/g;

/** `color="danger"`, `color='x'`, `color=${x}` and the property binding `.color=${x}`. */
const DECLARES_COLOR = /(?:^|\s)\.?color=/;

/** Directories that are build output or somebody else's code: never source to fix. */
const NOT_SOURCE = new Set(['dist', 'node_modules', '.git', 'coverage']);

/**
 * What is ALREADY published with `color=` on an `ion-*`, as `[moduleId, file, count]` — measured over
 * `origin/main` of the 27 module repos on 2026-09-23.
 *
 * 🔴 This list may only SHRINK (a test fails the moment it grows), and an entry may not outlive its
 * file: once a file is clean, its line FAILS the module's own gate until it is deleted — so the
 * two-line PR that deletes it goes first and the module's fix merges behind it. A module with no
 * `ui/` that reuses a listed id is warned, never blocked (module-toolkit#189). The sweep that empties
 * it is ERPlora/pm#392.
 */
export const COLOR_GRANDFATHERED = [
  ['appointments', 'ui/components/erp-appointments-request-booking/erp-appointments-request-booking.ts', 1],
  ['invoice', 'ui/components/erp-invoice-list/erp-invoice-list.ts', 10],
  ['invoice', 'ui/components/erp-invoice-settings/erp-invoice-settings.ts', 3],
  ['kitchen', 'ui/components/erp-kitchen-pos-fire/erp-kitchen-pos-fire.ts', 1],
  ['printing', 'ui/components/erp-printing-settings/erp-printing-settings.ts', 1],
  ['reservations', 'ui/components/erp-reservations-availability/erp-reservations-availability.ts', 1],
  ['sales', 'ui/components/erp-pos-departments/erp-pos-departments.ts', 1],
  ['sales', 'ui/components/erp-pos-quick-notes/erp-pos-quick-notes.ts', 1],
  ['sales', 'ui/components/erp-pos-touch/erp-pos-touch.ts', 13],
  ['sales', 'ui/lib/document-modal.ts', 1],
  ['schedules', 'ui/components/erp-schedules-hours/erp-schedules-hours.ts', 1],
  ['staff', 'ui/components/erp-staff-members/erp-staff-members.ts', 1],
  ['verifactu', 'ui/components/erp-verifactu-config/erp-verifactu-config.ts', 1],
  ['verifactu', 'ui/components/erp-verifactu-records/erp-verifactu-records.ts', 3],
  ['verifactu', 'ui/components/erp-verifactu-recovery/erp-verifactu-recovery.ts', 2],
  ['whatsapp_inbox', 'ui/components/erp-whatsapp-inbox-requests/erp-whatsapp-inbox-requests.ts', 2],
  ['whatsapp_inbox', 'ui/components/erp-whatsapp-inbox-templates/erp-whatsapp-inbox-templates.ts', 1],
];

function allowanceFor(moduleId, file) {
  const entry = COLOR_GRANDFATHERED.find(([m, f]) => m === moduleId && f === file);
  return entry ? entry[2] : 0;
}

/**
 * Every `ion-*` opening tag of `source` that declares a colour through `color=`, as
 * `{ tag, index, line }`. `line` is 1-based, where the element OPENS.
 */
export function ionTagsWithDeadColor(source) {
  const found = [];
  for (const m of source.matchAll(ION_TAG_START)) {
    const end = endOfTag(source, m.index);
    if (end === -1) continue;
    const tag = attributesOnly(source.slice(m.index, end));
    if (!DECLARES_COLOR.test(tag)) continue;
    found.push({
      tag: source.slice(m.index, end).replace(/\s+/g, ' ').slice(0, 120),
      index: m.index,
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/**
 * The tag with every `${…}` expression and quoted value blanked out, so a `color:` inside an arrow
 * body or a `style="…"` cannot read as the attribute. Only the attribute NAMES stay visible.
 */
function attributesOnly(tag) {
  let out = '';
  let depth = 0;
  let quote = null;
  for (let i = 0; i < tag.length; i += 1) {
    const ch = tag[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) {
        quote = null;
        if (depth === 0) out += ch;
      }
      continue;
    }
    if (ch === '$' && tag[i + 1] === '{') {
      depth += 1;
      i += 1;
      if (depth === 1) out += '${';
      continue;
    }
    if (depth > 0) {
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) out += '}';
      }
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    out += ch;
  }
  return out;
}

/** Every shipped `.ts`/`.js` under `dir`: no build output, no vendored code, no tests. */
function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SOURCE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(entry.name) && !/\.(test|spec)\.(ts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** The whole door over the module's `ui/`. Returns `{ errors, warnings }`. */
export function checkIonicColor(dir, manifest) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };

  const deadPerFile = new Map();
  for (const abs of sourceFiles(join(dir, 'ui'))) {
    const file = relative(dir, abs).split(sep).join('/');
    let dead;
    try {
      dead = ionTagsWithDeadColor(readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push(`${file}: no se pudo leer (${e.message})`);
      continue;
    }
    deadPerFile.set(file, dead.length);
    const allowed = allowanceFor(moduleId, file);
    if (dead.length <= allowed) continue;

    const shown = dead.slice(allowed).map((d) => `L${d.line}: ${d.tag}`);
    errors.push(
      `${file}: ${dead.length} elemento(s) \`ion-*\` dan color con \`color=\`` +
        (allowed ? ` (${allowed} venían de antes y se toleran; sobran ${dead.length - allowed})` : '') +
        '. Dentro del shadow root del componente la clase global `.ion-color-*` no aplica y ' +
        '`--ion-color-base` queda vacío: un botón, badge o chip relleno sale INVISIBLE (texto blanco ' +
        'sobre fondo transparente) y el resto pierde su color. Quita `color=` y declara en el CSS del ' +
        'componente `--background` / `--background-activated` / `--background-hover` / `--color` desde ' +
        `el token (\`var(--ion-color-danger, #c5000f)\`…):\n      ${shown.join('\n      ')}`,
    );
  }

  const shipsComponents = deadPerFile.size > 0;
  for (const [m, file, allowed] of COLOR_GRANDFATHERED) {
    if (m !== moduleId) continue;
    const today = deadPerFile.get(file);
    if (today === undefined || today === 0) {
      const stale =
        `${file}: su entrada en \`COLOR_GRANDFATHERED\` (${allowed} tolerado(s)) ya no cubre nada — ` +
        (today === undefined ? 'el fichero no está en `ui/` (se borró o se renombró)' : 'el fichero ya no usa `color=`') +
        '. Mientras siga, el módulo puede volver a publicar esos botones invisibles en verde: bórrala ' +
        'de `module-toolkit/src/validate-ionic-color.mjs` (ERPlora/pm#392); ese PR va PRIMERO.';
      if (shipsComponents) errors.push(stale);
      else warnings.push(stale);
      continue;
    }
    if (today < allowed) {
      warnings.push(
        `${file}: quedan ${today} de los ${allowed} \`color=\` que tolera \`COLOR_GRANDFATHERED\`. No ` +
          'es un fallo, pero el número no se recorta para que cuadre: se termina el fichero y se borra ' +
          'la entrada entera (ERPlora/pm#392).',
      );
    }
  }
  return { errors, warnings };
}
