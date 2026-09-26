// Which OutfitKit API a module USES on the components the HUB paints — module-toolkit#346.
//
// **Why the whole-package stamp was the wrong question.** `checkOutfitkitFloor` compared the stamp
// in `dist/outfitkit.json` (one version for the whole bundle) with the OutfitKit of the oldest hub
// the module accepts. But the shell only defines the `ok-*` it imports itself; the baked `define()`
// of those loses (ADR-0133), while every OTHER `ok-*` in the bundle is painted by the module's own
// copy and the hub's version does not matter for it. Measured on 2026-09-25: whatsapp_inbox 2.1.85
// baked against OutfitKit 0.1.89 to ship the full-width `ok-lightbox` (outfitkit#176) was refused,
// and the only way out on offer — declaring hub 1.1.30 — would have stopped WhatsApp installing on
// every live hub. The shell does not even import `ok-lightbox`.
//
// **What replaces it is the rule every SDK uses.** Android and iOS let you compile against the
// newest SDK and check the API you USE against the oldest one you declare (lint `NewApi`,
// `@available`). Here: the module's `ui/` is type-checked twice — once against the OutfitKit it was
// baked with, once against a hybrid where the shell's components carry the FLOOR hub's types — and
// every error only the second run has is API the hub cannot paint. That is precisely the sales#259
// incident (a function `DataTableAction.label`, 0.1.59, on hubs carrying 0.1.58), and it no longer
// drags module-only components into it.
//
// Diffing the two runs is what makes it safe to run on 27 modules: whatever type noise a module
// already has — an unresolvable `lit` on a CI runner, a sloppy cast — shows up in BOTH programs and
// cancels out, so it can neither block nor hide anything.
//
// **Attributes and events on shell components (module-toolkit#348).** `.prop=${…}` is a lit
// PROPERTY binding and the type check above covers it, but a module can also reach a shell
// component through a plain HTML attribute (`tone="x"`, `?dot=${…}`, `size=${…}`) or an event it
// listens to (`@ok-dismiss=${…}`). Neither is visible to `tsc` (a tagged template is opaque to it)
// and neither survives into the `.d.ts`: lit's `@property({ attribute: 'page-size' })` erases the
// attribute name, and OutfitKit declares no event map at all. What still carries both is the
// component's own bundle, `dist/<tag>.js`, which every OutfitKit ships — so that is read instead.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { toolkitOutfitkitDir } from './outfitkit-stamp.mjs';

/**
 * The `ok-*` the hub SHELL defines at boot — the only ones whose hub version decides how a module
 * looks. Union of the `@erplora/outfitkit/ok-*` imports of `hub/apps/web/src` across every `v1.1.x`
 * tag and `develop` (measured 2026-09-25; bundling them defines exactly these 22, nothing
 * transitive). Kept honest by `test/canonical-mirrors.test.mjs`, which the hub's CI runs against
 * its own checkout: a shell import missing here fails there.
 *
 * A tag listed here that some old hub did not define only makes the check stricter, never looser —
 * so the list may grow freely and only shrinks deliberately.
 */
export const SHELL_OUTFITKIT_COMPONENTS = [
  'ok-app-launcher',
  'ok-avatar',
  'ok-bar-list',
  'ok-chart',
  'ok-code',
  'ok-data-table',
  'ok-empty-state',
  'ok-file-manager',
  'ok-gauge',
  'ok-inline-feedback',
  'ok-json-viewer',
  'ok-kpi',
  'ok-pinpad',
  'ok-pricing-card',
  'ok-qr',
  'ok-resource-usage',
  'ok-sparkline',
  'ok-stat',
  'ok-status-pill',
  'ok-theme-picker',
  'ok-timeline',
  'ok-widget-board',
];

/**
 * The `ok-*` a built bundle defines, sorted. OutfitKit registers through its guarded `define(tag, …)`
 * helper, which esbuild may rename on a collision (`define2`), and a few places call
 * `customElements.define` directly — both are read. A bare `"ok-close"` string is not a definition.
 */
export function bakedOutfitkitComponents(code) {
  const tags = new Set();
  const re = /(?:\bdefine\d*|customElements\.define)\(\s*["'](ok-[a-z0-9-]+)["']/g;
  for (const m of String(code ?? '').matchAll(re)) tags.add(m[1]);
  return [...tags].sort();
}

/** The module's own UI sources: `ui/**` TypeScript, without tests or declarations. */
function uiSources(moduleDir) {
  const root = join(moduleDir, 'ui');
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name) && !/\.(test|spec|d)\.ts$/.test(entry.name)) out.push(path);
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * The baked package's `dist/index.d.ts`, with every re-export of a SHELL component pointed at the
 * floor package instead. Everything else keeps the baked types: a module-only component is painted
 * by the module's own copy, so its newer API is legitimate.
 */
function hybridIndex(bakedDir, floorDir, shell, outDir) {
  const source = readFileSync(join(bakedDir, 'dist', 'index.d.ts'), 'utf8');
  const rewritten = source.replace(/(['"])\.\/([^'"]+)\1/g, (_, quote, rel) => {
    const tag = /^components\/(ok-[a-z0-9-]+)\//.exec(rel)?.[1];
    const base = tag && shell.includes(tag) ? floorDir : bakedDir;
    return `${quote}${join(base, 'dist', rel).split(sep).join('/')}${quote}`;
  });
  const file = join(outDir, 'index.d.ts');
  writeFileSync(file, rewritten);
  return file;
}

/** `Ok<Pascal>`: the class OutfitKit exports for a tag (`ok-data-table` → `OkDataTable`). */
function classNameOf(tag) {
  return `Ok${tag.slice(3).split('-').map((s) => s[0].toUpperCase() + s.slice(1)).join('')}`;
}

/**
 * The instance type of each SHELL component, as the program's `@erplora/outfitkit` index exports
 * it — from the floor package in the hybrid run, from the baked one otherwise.
 */
function shellElementTypes(program, checker, indexFile, shell) {
  const types = new Map();
  const sf = program.getSourceFile(indexFile);
  const module = sf && checker.getSymbolAtLocation(sf);
  if (!module) return types;
  const exports = checker.getExportsOfModule(module);
  for (const tag of shell) {
    const exported = exports.find((e) => e.name === classNameOf(tag));
    if (!exported) continue;
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (symbol.flags & ts.SymbolFlags.Class) types.set(tag, checker.getDeclaredTypeOfSymbol(symbol));
  }
  return types;
}

/**
 * Lit property bindings `.prop=${expr}` on `ok-*` tags inside `html\`…\`` templates of a file. The
 * literal chunks between expressions are read in order to know which tag is open; the expressions
 * themselves (where `=>` lives) are never scanned.
 */
function okPropertyBindings(sf) {
  const bindings = [];
  const visit = (node) => {
    if (
      ts.isTaggedTemplateExpression(node) &&
      ts.isIdentifier(node.tag) &&
      node.tag.text === 'html' &&
      ts.isTemplateExpression(node.template)
    ) {
      let open = null;
      const { head, templateSpans } = node.template;
      templateSpans.forEach((span, i) => {
        const text = i === 0 ? head.text : templateSpans[i - 1].literal.text;
        for (const m of text.matchAll(/<(ok-[a-z0-9-]+)|>/g)) open = m[1] ?? null;
        const prop = open && /\.([A-Za-z_$][\w$]*)=$/.exec(text)?.[1];
        if (prop) bindings.push({ tag: open, prop, expr: span.expression });
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bindings;
}

/**
 * The property names `source` carries that `target` does not declare — the Android `NewApi` rule
 * for a value that reaches a component untyped (a lit binding). Walks arrays and nested objects;
 * a target with an index signature accepts anything, `any`/`unknown` targets are not judged.
 */
function unknownProperties(checker, source, target, depth = 0) {
  if (depth > 4 || !source || !target) return [];
  const parts = (t) => (t.isUnion() ? t.types : [t]);
  const out = new Set();
  for (const s of parts(source)) {
    if (checker.isArrayType(s)) {
      const element = checker.getTypeArguments(s)[0];
      for (const t of parts(target)) {
        if (!checker.isArrayType(t)) continue;
        for (const name of unknownProperties(checker, element, checker.getTypeArguments(t)[0], depth + 1)) out.add(name);
      }
      continue;
    }
    if (!(s.flags & ts.TypeFlags.Object)) continue;
    const objects = parts(target).filter(
      (t) => t.flags & ts.TypeFlags.Object && !checker.isArrayType(t) && !checker.getIndexInfosOfType(t).length,
    );
    if (!objects.length) continue;
    for (const property of checker.getPropertiesOfType(s)) {
      const known = objects.map((t) => t.getProperty(property.name)).filter(Boolean);
      if (!known.length) {
        out.add(property.name);
        continue;
      }
      const nested = checker.getTypeOfSymbol(property);
      for (const k of known) {
        for (const name of unknownProperties(checker, nested, checker.getTypeOfSymbol(k), depth + 1)) out.add(name);
      }
    }
  }
  return [...out];
}

/** `rel:line:code` → `rel:line — message` for the module's own files. */
function diagnose(moduleDir, files, indexFile, bakedDir, shell) {
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    useDefineForClassFields: false,
    types: [],
    baseUrl: moduleDir,
    paths: {
      '@erplora/outfitkit': [indexFile],
      '@erplora/outfitkit/*': [join(bakedDir, 'dist', '*')],
    },
  };
  // The index is a root too: a module that only side-effect-imports `@erplora/outfitkit/ok-*`
  // never loads it, and its lit bindings still have to be judged against the shell classes.
  const program = ts.createProgram([...files, indexFile], options);
  const checker = program.getTypeChecker();
  const elements = shellElementTypes(program, checker, indexFile, shell);
  const found = new Map();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const rel = relative(moduleDir, file).split(sep).join('/');
    const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    for (const d of diags) {
      const line = d.start === undefined ? 0 : sf.getLineAndCharacterOfPosition(d.start).line + 1;
      // Keyed WITHOUT the message on purpose: the same error prints a different type path in each
      // run (the baked index's path vs the hybrid index's path in `import(…).X`), and it must still cancel out.
      const key = `${rel}:${line}:${d.code}`;
      if (!found.has(key)) {
        found.set(key, `${rel}:${line} — ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
      }
    }
    // `tsc` never looks inside a tagged template: what a module binds to `.actions=${…}` of a shell
    // table from an untyped getter is judged here, against THIS run's declaration of the element.
    for (const { tag, prop, expr } of okPropertyBindings(sf)) {
      const element = elements.get(tag);
      if (!element) continue;
      const line = sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1;
      const where = `${rel}:${line} — <${tag} .${prop}=\${…}>`;
      const property = element.getProperty(prop);
      if (!property) {
        found.set(`${rel}:${line}:bind:${tag}.${prop}`, `${where}: '${prop}' does not exist on ${tag}`);
        continue;
      }
      const target = checker.getTypeOfSymbolAtLocation(property, expr);
      const source = checker.getTypeAtLocation(expr);
      if (!checker.isTypeAssignableTo(source, target)) {
        found.set(
          `${rel}:${line}:bind:${tag}.${prop}`,
          `${where}: '${checker.typeToString(source)}' is not assignable to '${checker.typeToString(target)}'`,
        );
      }
      for (const name of unknownProperties(checker, source, target)) {
        found.set(`${rel}:${line}:bind:${tag}.${prop}.${name}`, `${where}: carries '${name}', which ${tag} does not know`);
      }
    }
  }
  return found;
}

// --- Attributes and events on shell components — module-toolkit#348 ------------------------------
//
// A component's HTML surface (which strings work as an attribute or an event name) never reaches
// its `.d.ts`, so the only place left to read it is the bundle every OutfitKit build ships,
// `dist/<tag>.js`. This section judges a module's `html` templates against that surface with the
// same rule as the type check above: a name the BAKED bundle knows and the FLOOR bundle does not is
// new API the hub cannot paint.

/** A one-character filler that cannot occur in an HTML tag or attribute name. */
const MASK_CHAR = '\u0001';

/**
 * The literal (non-expression) text of a `html\`…\`` template, as absolute offsets into `sf.text`.
 * Every `${…}` — including its own `=>`, quotes and stray `<`/`>` — is overwritten with same-length
 * filler so the attribute tokenizer below never has to understand an expression, only skip over it,
 * exactly like `okPropertyBindings` never looks at `span.expression` either.
 */
function maskedTemplateText(sf, tpl) {
  const start = tpl.getStart(sf);
  const chars = sf.text.slice(start, tpl.getEnd()).split('');
  if (ts.isTemplateExpression(tpl)) {
    const { head, templateSpans } = tpl;
    templateSpans.forEach((span, i) => {
      // Each span's `${…}` runs from the `${` that ends the previous literal chunk (the head, or
      // the previous span's own literal) to the `}` that starts this one's.
      const from = (i === 0 ? head : templateSpans[i - 1].literal).getEnd() - 2;
      const to = span.literal.getStart(sf) + 1;
      for (let p = from; p < to; p++) chars[p - start] = MASK_CHAR;
    });
  }
  return { text: chars.join(''), start };
}

/**
 * Attribute/event uses of SHELL `ok-*` tags inside one masked template, as `{ tag, kind, name, pos }`
 * (`pos` absolute, for both the line number and telling apart two uses on the same line). A small
 * hand-rolled tokenizer, not a full HTML parser: it only needs tag boundaries and attribute names,
 * and a real parser would choke on the `\u0001` filler runs standing in for lit expressions anyway.
 */
function scanTemplateTags(sf, tpl, shell, uses) {
  const { text, start } = maskedTemplateText(sf, tpl);
  const n = text.length;
  const isNameChar = (ch) => ch !== undefined && ch !== MASK_CHAR && !/[\s"'>/=]/.test(ch);
  let i = 0;
  while (i < n) {
    if (text[i] !== '<') {
      i++;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (text[i + 1] === '/') {
      const close = text.indexOf('>', i + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    const opened = /^<([A-Za-z][A-Za-z0-9-]*)/.exec(text.slice(i));
    if (!opened) {
      i++;
      continue;
    }
    const tag = opened[1].toLowerCase();
    i += opened[0].length;
    // Attributes, until the unquoted `>` (or `/>`) that closes the tag: a `>` inside a quoted value
    // never closes it, and `${…}` was already masked so an `=>` inside it cannot fool this either.
    while (i < n) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) break;
      if (text[i] === '>') {
        i++;
        break;
      }
      if (text[i] === '/' && text[i + 1] === '>') {
        i += 2;
        break;
      }
      if (text[i] === '/') {
        i++;
        continue;
      }
      const nameStart = i;
      while (i < n && isNameChar(text[i])) i++;
      if (i === nameStart) {
        i++;
        continue;
      }
      const rawName = text.slice(nameStart, i);
      let j = i;
      while (j < n && /\s/.test(text[j])) j++;
      if (text[j] === '=') {
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] === '"' || text[j] === "'") {
          const quote = text[j];
          j++;
          while (j < n && text[j] !== quote) j++;
          j++;
        } else {
          while (j < n && !/[\s>]/.test(text[j])) j++;
        }
      }
      i = j;
      if (shell.includes(tag)) {
        const pos = start + nameStart;
        if (rawName.startsWith('.')) {
          // A lit property binding: `okPropertyBindings`/`diagnose` already judge it via the type
          // checker, against the actual declared property type — nothing to add here.
        } else if (rawName.startsWith('@')) {
          uses.push({ tag, kind: 'event', name: rawName.slice(1), pos });
        } else if (rawName.startsWith('?')) {
          uses.push({ tag, kind: 'attr', name: rawName.slice(1).toLowerCase(), pos });
        } else {
          uses.push({ tag, kind: 'attr', name: rawName.toLowerCase(), pos });
        }
      }
    }
  }
}

/** Every attribute/event use of a SHELL tag across all `html\`…\`` templates of one source file. */
function shellTagUses(sf, shell) {
  const uses = [];
  const visit = (node) => {
    if (ts.isTaggedTemplateExpression(node) && ts.isIdentifier(node.tag) && node.tag.text === 'html') {
      const tpl = node.template;
      if (ts.isNoSubstitutionTemplateLiteral(tpl) || ts.isTemplateExpression(tpl)) scanTemplateTags(sf, tpl, shell, uses);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return uses;
}

/** A string- or template-literal node's own text, or `undefined` for anything else (a variable, …). */
function staticText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

/** The identifier name a call is made through: `f(...)` → `f`, `this.emit(...)` → `emit`. */
function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) return expr.name.text;
  return undefined;
}

/**
 * What one shell component's built bundle (`dist/<tag>.js`, esbuild output) exposes: the attribute
 * name each `@property` decorator maps to (lowercased, the way an HTML parser reads it — none if
 * `attribute: false`), and the literal event names it is seen to dispatch (case-sensitive, since lit
 * and `addEventListener` both keep the case of `@event` names as written).
 */
function bundleApi(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const attributes = new Set();
  const events = new Set();
  const isDecorateCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    /^__decorate/.test(node.expression.text) &&
    node.arguments.length >= 3 &&
    ts.isArrayLiteralExpression(node.arguments[0]) &&
    staticText(node.arguments[2]) !== undefined;
  const visit = (node) => {
    if (isDecorateCall(node)) {
      const name = staticText(node.arguments[2]);
      for (const decorator of node.arguments[0].elements) {
        if (!ts.isCallExpression(decorator) || !ts.isIdentifier(decorator.expression)) continue;
        if (decorator.expression.text !== 'property') continue; // `state()`/`query(…)` give nothing
        const options = decorator.arguments[0];
        let attribute = name.toLowerCase();
        if (options && ts.isObjectLiteralExpression(options)) {
          const attrProp = options.properties.find(
            (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'attribute',
          );
          if (attrProp?.initializer.kind === ts.SyntaxKind.FalseKeyword) attribute = null;
          else if (staticText(attrProp?.initializer) !== undefined) attribute = staticText(attrProp.initializer).toLowerCase();
        }
        if (attribute) attributes.add(attribute);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /^(CustomEvent|Event)$/.test(node.expression.text)) {
      const name = staticText(node.arguments?.[0]);
      if (name !== undefined) events.add(name);
    } else if (ts.isCallExpression(node) && /^(emit|fire|dispatch)/i.test(calleeName(node.expression) ?? '')) {
      const name = staticText(node.arguments[0]);
      if (name !== undefined) events.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { attributes, events };
}

/**
 * `bundleApi` of `<dir>/dist/<tag>.js`, memoized per `(dir, tag)` for the lifetime of one
 * `checkSharedOutfitkitApi` call — the same tag is read again for every file and every use, and a
 * hub package the check ran against once during that call never changes underneath it.
 */
function cachedBundleApi(dir, tag, cache) {
  const key = `${dir}\u0000${tag}`;
  if (cache.has(key)) return cache.get(key);
  const file = join(dir, 'dist', `${tag}.js`);
  let result = null;
  if (existsSync(file)) {
    try {
      result = bundleApi(readFileSync(file, 'utf8'), file);
    } catch {
      // A bundle esbuild did not produce the expected shape: unreadable, same as missing.
      result = null;
    }
  }
  cache.set(key, result);
  return result;
}

/**
 * The module's own `ui/**` uses of shell attributes/events that the baked bundle defines and the
 * floor bundle does not — one problem string per offending use. A tag is judged only when BOTH
 * bundles exist and parse; there is no "unrelated noise cancels out" diff to fall back on here (as
 * there is for the type check), so an unreadable side means silence, not a false positive.
 */
function attributeAndEventProblems(moduleDir, files, bakedDir, floorDir, shell, cache) {
  const found = new Map();
  for (const file of files) {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(moduleDir, file).split(sep).join('/');
    for (const use of shellTagUses(sf, shell)) {
      const baked = cachedBundleApi(bakedDir, use.tag, cache);
      const floor = cachedBundleApi(floorDir, use.tag, cache);
      if (!baked || !floor) continue;
      const bakedKnown = use.kind === 'event' ? baked.events.has(use.name) : baked.attributes.has(use.name);
      if (!bakedKnown) continue;
      const floorKnown = use.kind === 'event' ? floor.events.has(use.name) : floor.attributes.has(use.name);
      if (floorKnown) continue;
      const line = sf.getLineAndCharacterOfPosition(use.pos).line + 1;
      // Keyed by the OCCURRENCE (`pos`), not the line: two uses of the same tag/name on one line
      // (a bare attribute and its `?boolean` twin, say) must not collapse into a single problem.
      const key = `${rel}:${use.pos}:${use.tag}:${use.kind}:${use.name}`;
      const message =
        use.kind === 'event'
          ? `${rel}:${line} — <${use.tag} @${use.name}>: '${use.name}' is not an event ${use.tag} dispatches on the floor hub`
          : `${rel}:${line} — <${use.tag} ${use.name}>: '${use.name}' is not an attribute of ${use.tag} on the floor hub`;
      found.set(key, message);
    }
  }
  return [...found.values()];
}

/**
 * Type-checks the module's `ui/` against the floor hub's OutfitKit for the SHELL components only.
 *
 * `bakedDir`/`floorDir` are unpacked `@erplora/outfitkit` packages (their `dist/*.d.ts` is what is
 * read). Returns `{ problems }`: one `ui/…:line — message` per error that only the floor produces.
 */
export function checkSharedOutfitkitApi({ moduleDir, bakedDir, floorDir, shell = SHELL_OUTFITKIT_COMPONENTS }) {
  const files = uiSources(moduleDir);
  if (!files.length) return { problems: [] };
  const scratch = mkdtempSync(join(tmpdir(), 'erplora-ok-api-'));
  try {
    const bakedIndex = join(bakedDir, 'dist', 'index.d.ts');
    const floorIndex = hybridIndex(bakedDir, floorDir, shell, scratch);
    const before = diagnose(moduleDir, files, bakedIndex, bakedDir, shell);
    const after = diagnose(moduleDir, files, floorIndex, bakedDir, shell);
    const problems = [...after].filter(([key]) => !before.has(key)).map(([, text]) => text);
    const bundleCache = new Map();
    problems.push(...attributeAndEventProblems(moduleDir, files, bakedDir, floorDir, shell, bundleCache));
    return { problems };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Where unpacked OutfitKit packages are kept between runs. */
export const OUTFITKIT_TYPES_CACHE_ENV = 'ERPLORA_OUTFITKIT_TYPES_CACHE';

/**
 * An unpacked `@erplora/outfitkit@<version>` with its `dist/*.d.ts`: `{ dir }` or `{ error }`.
 *
 * Order: the cache, then the registry (`npm pack`, the published bytes), and only then the
 * toolkit's own checkout if it claims that exact version — last, because a development checkout's
 * `dist/` can be stale against its own `package.json`.
 */
/** `npm pack` of the published `@erplora/outfitkit@<version>` into `work`, unpacked as `work/package`. */
function npmPack(version, work) {
  execFileSync('npm', ['pack', `@erplora/outfitkit@${version}`, '--pack-destination', work, '--silent'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');
  execFileSync('tar', ['-xzf', join(work, tarball), '-C', work], { stdio: 'pipe', timeout: 60_000 });
}

export function resolveOutfitkitTypes(version, { cacheRoot, localDir = toolkitOutfitkitDir(), pack = npmPack } = {}) {
  if (!VERSION_RE.test(String(version))) return { error: `not an OutfitKit version: ${version}` };
  const root = cacheRoot ?? process.env[OUTFITKIT_TYPES_CACHE_ENV] ?? join(homedir(), '.cache', 'erplora', 'outfitkit-types');
  const cached = join(root, version, 'package');
  if (existsSync(join(cached, 'dist', 'index.d.ts'))) return { dir: cached };
  let fetchError;
  try {
    mkdirSync(root, { recursive: true });
    const work = mkdtempSync(join(root, '.fetch-'));
    try {
      pack(version, work);
      if (!existsSync(join(work, 'package', 'dist', 'index.d.ts'))) {
        throw new Error('the published package has no dist/index.d.ts');
      }
      mkdirSync(join(root, version), { recursive: true });
      if (!existsSync(cached)) renameSync(join(work, 'package'), cached);
      return { dir: cached };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } catch (err) {
    // `err.stderr` is a Buffer, and an EMPTY one (npm timed out, `--silent`) is still truthy: read
    // it as text first so the message never degrades to "()".
    const stderr = String(err?.stderr ?? '').trim();
    fetchError = (stderr || String(err?.message ?? err)).trim().split('\n')[0];
  }
  try {
    const local = JSON.parse(readFileSync(join(localDir, 'package.json'), 'utf8'));
    if (local.version === version && existsSync(join(localDir, 'dist', 'index.d.ts'))) {
      return { dir: localDir };
    }
  } catch {
    // No usable local checkout: the registry error below is the answer.
  }
  return { error: `could not fetch @erplora/outfitkit@${version} (${fetchError})` };
}

/**
 * The default `apiCheck` of `checkOutfitkitFloor`: fetch both packages, type-check, and never
 * throw — a check that cannot run says so (`ran: false`) and the gate falls back to the old rule.
 */
export function defaultOutfitkitApiCheck({ dir, floor, baked }) {
  try {
    const floorPkg = resolveOutfitkitTypes(floor);
    if (floorPkg.error) return { ran: false, reason: floorPkg.error };
    const bakedPkg = resolveOutfitkitTypes(baked);
    if (bakedPkg.error) return { ran: false, reason: bakedPkg.error };
    const { problems } = checkSharedOutfitkitApi({ moduleDir: dir, bakedDir: bakedPkg.dir, floorDir: floorPkg.dir });
    return { ran: true, problems };
  } catch (err) {
    return { ran: false, reason: `the type check failed: ${err?.message ?? err}` };
  }
}
