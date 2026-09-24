// `class=${…}` on an Ionic element wipes the classes Ionic stamps on its host — module-toolkit#303.
//
// A Lit attribute binding on `class` — `class=${expr}`, or an interpolation inside a quoted value
// (`class="a ${expr}"`) — commits with `setAttribute('class', …)`: the WHOLE attribute, on every
// change. The property binding `.className=${…}` does the same. Stencil only re-adds the host
// classes its own render changes (`button-outline`, `button-null`…), so the ones it stamped once —
// `ion-activatable` (what Ionic's tap-click looks for to set `ion-activated`), `ion-focusable`,
// `hydrated`, `ios`/`md` — are gone after the first state change. The element still looks right; it
// just stops lighting up when tapped and loses its keyboard focus ring. It shipped on the kitchen
// URGENT toggle (kitchen#88) and the sales discount button (sales#358), each fixed alone.
//
// The fix per use: `class="static ${classMap({ on: cond })}"` — `classMap` only adds and removes
// the keys it declares and leaves Ionic's classes alone.
//
// Same ratchet as `validate-ionic-color.mjs` (per file and count, stale entries fail) and the same
// tag reader. Mirror alarm: the premise is pinned to `@ionic/core` in
// `test/validate-ionic-class.test.mjs`; the day it stops holding, delete this file.
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { endOfTag } from './validate-ionic-fill.mjs';
import { sourceFiles } from './validate-ionic-color.mjs';

const ION_TAG_START = /<ion-[a-z-]+(?=[\s/>])/g;

/**
 * What is ALREADY published with a whole-`class` binding on an `ion-*`, as `[moduleId, file, count]`
 * — measured over `origin/main` of the module repos on 2026-09-24 with this very reader.
 *
 * 🔴 This list may only SHRINK (a test fails the moment it grows), and an entry may not outlive its
 * file: once a file is clean, its line FAILS the module's own gate until it is deleted — so the
 * two-line PR that deletes it goes first and the module's fix merges behind it. A module with no
 * `ui/` that reuses a listed id is warned, never blocked (module-toolkit#189).
 */
export const CLASS_GRANDFATHERED = [
  ['customers', 'ui/components/erp-customers-pos-search/erp-customers-pos-search.ts', 1], // customers#77
  ['pricing', 'ui/components/erp-pricing-lists/erp-pricing-lists.ts', 1], // pricing#43
];

/**
 * Index just past the `}` that closes the `${` / `{` / `(` opened at `open`, skipping quoted and
 * template literals. -1 if it never closes.
 */
function closing(source, open) {
  const pairs = { '(': ')', '{': '}' };
  const start = source[open] === '$' ? open + 1 : open;
  const stack = [pairs[source[start]]];
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{') stack.push(pairs[ch]);
    else if (ch === ')' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** The attributes of an opening tag as `{ name, expressions }`: the `${…}` bodies of its value. */
function attributes(tag) {
  const out = [];
  let i = tag.search(/[\s/>]/);
  while (i !== -1 && i < tag.length) {
    while (/\s/.test(tag[i] ?? '')) i += 1;
    if (i >= tag.length || tag[i] === '>' || tag.startsWith('/>', i)) break;
    const nameEnd = tag.slice(i).search(/[\s=>]|\/>/);
    const end = nameEnd === -1 ? tag.length : i + nameEnd;
    const name = tag.slice(i, end);
    i = end;
    const expressions = [];
    if (tag[i] === '=') {
      i += 1;
      const q = tag[i];
      if (q === '"' || q === "'") {
        i += 1;
        while (i < tag.length && tag[i] !== q) {
          if (tag[i] === '$' && tag[i + 1] === '{') {
            const close = closing(tag, i);
            if (close === -1) return out;
            expressions.push(tag.slice(i + 2, close - 1));
            i = close;
          } else i += 1;
        }
        i += 1;
      } else if (q === '$' && tag[i + 1] === '{') {
        const close = closing(tag, i);
        if (close === -1) return out;
        expressions.push(tag.slice(i + 2, close - 1));
        i = close;
      } else {
        while (i < tag.length && !/[\s>]/.test(tag[i])) i += 1;
      }
    }
    if (name) out.push({ name, expressions });
    else i += 1;
  }
  return out;
}

/** `classMap(…)` and nothing else: the one binding that leaves Ionic's classes alone. */
function isClassMapAlone(expression) {
  const e = expression.trim();
  if (!e.startsWith('classMap(')) return false;
  return closing(e, 'classMap'.length) === e.length;
}

const CALL = /^(?:this\.)?([A-Za-z_$][\w$]*)\(/;

/**
 * The bodies of every function, method or arrow named `name` declared in `source` — only the
 * expression each one returns, as text. A method `toneOf(on) { return classMap({…}); }` yields
 * `classMap({…})`; an arrow `const tone = (on) => classMap({…});` yields the same. A body that does
 * anything else (two statements, a block arrow) yields '' so it can never pass.
 */
function returnedExpressions(source, name) {
  const out = [];
  const id = name.replace(/\$/g, '\\$');
  const decl = new RegExp(`\\b${id}\\s*(?:<[^>]*>)?\\(`, 'g');
  for (const m of source.matchAll(decl)) {
    const params = closing(source, m.index + m[0].length - 1);
    if (params === -1) continue;
    const rest = source.slice(params);
    const method = rest.match(/^\s*(?::\s*[^{=]+?)?\s*\{\s*return\s+/);
    if (!method) continue; // a call site, not a declaration
    const bodyAt = params + method[0].length;
    const open = source.slice(bodyAt).search(/[({]/);
    if (open < 1) { out.push(''); continue; } // no call at all, or `return (…)` / `return {…}`
    const end = closing(source, bodyAt + open);
    const tail = end === -1 ? null : source.slice(end).match(/^\s*;?\s*\}/);
    out.push(tail ? source.slice(bodyAt, end) : '');
  }
  const arrow = new RegExp(`\\b${id}\\s*=\\s*(?:async\\s*)?\\(`, 'g');
  for (const m of source.matchAll(arrow)) {
    const params = closing(source, m.index + m[0].length - 1);
    if (params === -1) continue;
    const rest = source.slice(params);
    const head = rest.match(/^\s*(?::\s*[^=]+?)?\s*=>\s*/);
    if (!head) continue;
    const bodyAt = params + head[0].length;
    const open = source.slice(bodyAt).search(/[({]/);
    if (open < 1) { out.push(''); continue; } // block body `=> { … }`, or no call at all
    const end = closing(source, bodyAt + open);
    const tail = end === -1 ? null : source.slice(end).match(/^\s*[;,)\n]/);
    out.push(tail ? source.slice(bodyAt, end) : '');
  }
  return out;
}

/**
 * `classMap(…)` alone, or a call to a helper of the SAME file whose whole body is `return
 * classMap(…)` (sales `toneOf`, after sales#358): the directive is the same, just behind a name. A
 * helper that returns anything else, or that this file does not declare, clobbers.
 */
function leavesIonicClassesAlone(expression, source) {
  if (isClassMapAlone(expression)) return true;
  const e = expression.trim();
  const call = e.match(CALL);
  if (!call || closing(e, call[0].length - 1) !== e.length) return false;
  const bodies = returnedExpressions(source, call[1]);
  return bodies.length > 0 && bodies.every(isClassMapAlone);
}

function clobbers({ name, expressions }, source) {
  if (name === '.className') return true;
  if (name !== 'class') return false;
  return expressions.some((e) => !leavesIonicClassesAlone(e, source));
}

/**
 * Every `ion-*` opening tag of `source` whose `class` is bound whole, as `{ tag, index, line }`.
 * `line` is 1-based, where the element OPENS.
 */
export function ionTagsWithClobberingClass(source) {
  const found = [];
  for (const m of source.matchAll(ION_TAG_START)) {
    const end = endOfTag(source, m.index);
    if (end === -1) continue;
    const tag = source.slice(m.index, end);
    if (!attributes(tag).some((a) => clobbers(a, source))) continue;
    found.push({
      tag: tag.replace(/\s+/g, ' ').slice(0, 120),
      index: m.index,
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/** The whole door over the module's `ui/`. Returns `{ errors, warnings }`. */
export function checkIonicClass(dir, manifest, grandfathered = CLASS_GRANDFATHERED) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };
  const allowanceFor = (file) => grandfathered.find(([m, f]) => m === moduleId && f === file)?.[2] ?? 0;

  const perFile = new Map();
  for (const abs of sourceFiles(join(dir, 'ui'))) {
    const file = relative(dir, abs).split(sep).join('/');
    let found;
    try {
      found = ionTagsWithClobberingClass(readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push(`${file}: no se pudo leer (${e.message})`);
      continue;
    }
    perFile.set(file, found.length);
    const allowed = allowanceFor(file);
    if (found.length <= allowed) continue;

    const shown = found.slice(allowed).map((d) => `L${d.line}: ${d.tag}`);
    errors.push(
      `${file}: ${found.length} elemento(s) \`ion-*\` enlazan el atributo \`class\` entero` +
        (allowed ? ` (${allowed} venían de antes y se toleran; sobran ${found.length - allowed})` : '') +
        '. Lit lo reescribe con `setAttribute` en cada cambio y borra las clases que Ionic puso en el ' +
        'host (`ion-activatable`, `ion-focusable`, `hydrated`…): el elemento deja de iluminarse al ' +
        'pulsarlo y pierde el foco de teclado. Usa `class="fija ${classMap({ clave: condición })}"` ' +
        `(\`lit/directives/class-map.js\`), que solo toca sus claves:\n      ${shown.join('\n      ')}`,
    );
  }

  const shipsComponents = perFile.size > 0;
  for (const [m, file, allowed] of grandfathered) {
    if (m !== moduleId) continue;
    const today = perFile.get(file);
    if (today === undefined || today === 0) {
      const stale =
        `${file}: su entrada en \`CLASS_GRANDFATHERED\` (${allowed} tolerado(s)) ya no cubre nada — ` +
        (today === undefined ? 'el fichero no está en `ui/` (se borró o se renombró)' : 'el fichero ya no enlaza `class` entero') +
        '. Mientras siga, el módulo puede volver a publicarlo en verde: bórrala de ' +
        '`module-toolkit/src/validate-ionic-class.mjs` (module-toolkit#303); ese PR va PRIMERO.';
      if (shipsComponents) errors.push(stale);
      else warnings.push(stale);
      continue;
    }
    if (today < allowed) {
      warnings.push(
        `${file}: quedan ${today} de los ${allowed} \`class=\${…}\` que tolera \`CLASS_GRANDFATHERED\`. No ` +
          'es un fallo, pero el número no se recorta para que cuadre: se termina el fichero y se borra ' +
          'la entrada entera (module-toolkit#303).',
      );
    }
  }
  return { errors, warnings };
}
