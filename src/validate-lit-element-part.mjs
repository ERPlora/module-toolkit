// A Lit opening tag left without its `>` publishes an EMPTY element — module-toolkit#398.
//
// In a Lit template, an expression that sits inside an opening tag with no attribute in front of it
// is an ELEMENT part. Lit binds element directives there (`ref`, `spread`) and silently ignores any
// other value — no error, no warning. So one missing `>`
//
//     <ion-button @click=${() => void this.save()}
//       ${this.saving ? this.t('ui.saving') : this.t('ui.save')}
//     </ion-button>
//
// leaves the label in element position and the button ships with no children: a coloured square
// nobody can name. It shipped on the flows editor's «Save» from flows#116 to flows#144 and no gate
// saw it. On 2026-09-28 there are zero cases in the 27 modules, so there is no grandfather list:
// every one is an error from day one.
//
// The reader is a small tokenizer, not a regex: a Lit tag does not end at the first `>`
// (`@click=${() => a > b}`), expressions nest templates and strings, and a tag NAMED in a comment is
// not a tag (the trap of module-toolkit#367).
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sourceFiles } from './validate-ionic-color.mjs';

const TAG_START = /<([a-z][a-z0-9-]*)(?=[\s/>])/g;

/** The element directives Lit binds in element position: the only legitimate `<tag ${…}>`. */
const ELEMENT_DIRECTIVE = /^\s*(?:ref|spread|animate)\s*\(/;

const WHITESPACE = /\s/;

/** Index right after the `}` that closes the expression whose body starts at `i` (after `${`). */
function skipExpression(source, i) {
  let depth = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") i = skipString(source, i + 1, ch);
    else if (ch === '`') i = skipTemplate(source, i + 1);
    else {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      i += 1;
    }
  }
  return i;
}

/** Index right after the closing quote of a string whose body starts at `i`. */
function skipString(source, i, quote) {
  while (i < source.length) {
    if (source[i] === '\\') i += 2;
    else if (source[i] === quote) return i + 1;
    else i += 1;
  }
  return i;
}

/** Index right after the closing backtick of a template literal whose body starts at `i`. */
function skipTemplate(source, i) {
  while (i < source.length) {
    if (source[i] === '\\') i += 2;
    else if (source[i] === '`') return i + 1;
    else if (source[i] === '$' && source[i + 1] === '{') i = skipExpression(source, i + 2);
    else i += 1;
  }
  return i;
}

/** Whether the `<` at `index` is quoted in a `//` or `/* … *\/` comment line rather than a template. */
function inCommentLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  const before = source.slice(lineStart, index).trimStart();
  return before.startsWith('//') || before.startsWith('/*') || before.startsWith('*');
}

/**
 * Every `${…}` of `source` that Lit would bind as an element part without being an element
 * directive — the mark of an opening tag that lost its `>` — as `{ tag, expr, index, line }`.
 * `line` is 1-based, where the element OPENS: the line the author has to go to.
 */
export function strayElementParts(source) {
  const found = [];
  for (const m of source.matchAll(TAG_START)) {
    if (inCommentLine(source, m.index)) continue;
    let lastSolid = ''; // last non-whitespace char of the tag outside a quoted value
    let quote = null; // " or ' while inside a quoted attribute value
    let i = m.index + m[0].length;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '$' && source[i + 1] === '{') {
        const end = skipExpression(source, i + 2);
        const expr = source.slice(i + 2, end - 1);
        const startsToken = WHITESPACE.test(source[i - 1]);
        if (!quote && startsToken && lastSolid !== '=' && !ELEMENT_DIRECTIVE.test(expr)) {
          found.push({
            tag: m[1],
            expr: expr.replace(/\s+/g, ' ').trim().slice(0, 80),
            index: m.index,
            line: source.slice(0, m.index).split('\n').length,
          });
        }
        if (!quote) lastSolid = '}';
        i = end;
        continue;
      }
      if (quote) {
        if (ch === quote) {
          quote = null;
          lastSolid = ch;
        }
        i += 1;
        continue;
      }
      // `>` closes the tag; a backtick means the reader left the template (or never was in one).
      if (ch === '>' || ch === '`') break;
      if ((ch === '"' || ch === "'") && lastSolid === '=') quote = ch;
      else if (!WHITESPACE.test(ch)) lastSolid = ch;
      i += 1;
    }
  }
  return found;
}

/** The whole door over the module's `ui/`. Returns `{ errors, warnings }`. */
export function checkLitElementParts(dir) {
  const errors = [];
  for (const abs of sourceFiles(join(dir, 'ui'))) {
    const file = relative(dir, abs).split(sep).join('/');
    let stray;
    try {
      stray = strayElementParts(readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push(`${file}: no se pudo leer (${e.message})`);
      continue;
    }
    if (!stray.length) continue;
    const shown = stray.map((s) => `L${s.line}: <${s.tag} … \${${s.expr}}`);
    errors.push(
      `${file}: ${stray.length} etiqueta(s) de apertura con una expresión \`\${…}\` suelta dentro, sin ` +
        'atributo delante: casi siempre falta el `>` que cierra la etiqueta. Lit la enlaza como parte de ' +
        'elemento y la IGNORA en silencio, así que el elemento sale VACÍO (un botón sin texto). Cierra la ' +
        'etiqueta con `>` antes del contenido; si de verdad es una directiva de elemento, solo valen ' +
        `\`ref(…)\`, \`spread(…)\` y \`animate(…)\`:\n      ${shown.join('\n      ')}`,
    );
  }
  return { errors, warnings: [] };
}
