// The money-display guard, in ONE place (ERPlora/pm#505).
//
// WHAT IT GUARDS (pm#289). Money travels as an integer in the currency's minor unit (ADR-0123) and
// reaches the screen through the shell's single formatter — `erplora().formatMoney(minor)` (the
// hub's currency and scale: JPY 0 decimals, KWD 3) — or `<ok-money>` / `formatMinor` from OutfitKit.
// A `(cents / 100).toFixed(2)` — or `.toFixed(scale)`, the same float path — or a hand-built
// `Intl.NumberFormat({ currency })` / `.toLocaleString(…, { currency })` brings back what that
// contract removed: its own separators, its own rounding, and a hard `/100` that is wrong the day
// the hub is not in euros. And OutfitKit comes in by ENTRY POINT (`@erplora/outfitkit/ok-money`),
// never as a value from the barrel: the barrel re-exports every `ok-*`, so one
// `import { formatMinor } from '@erplora/outfitkit'` inlined the whole library into a module's
// bundle (216 KB → 1.1 MB, 90 components registered that no screen paints — rv-payment_gateways-36).
//
// WHY IT LIVES HERE. Fifteen modules carried a hand copy of this guard, and the reviewers found
// three holes in it one module at a time, so the copy of the first modules let through what the
// last one caught:
//
//   1. the barrel was only caught as `import … from`; a side-effect `import '@erplora/outfitkit'`,
//      a dynamic `import()`, `export { … } from` and `export * from` passed (rv-invoice-115,
//      rv-cash_register-105, rv-kitchen-107) — all five doors are caught here;
//   2. a triaged exception (`'file: exact line'`) exempted EVERY copy of that line in the file
//      (rv-inventory-117) — here each exception covers one occurrence;
//   3. the non-vacuity control only checked which FILES were scanned, so a scan over `''` or a
//      greedy comment strip stayed green (rv-appointments-226, rv-pricing-53, rv-combos-22,
//      rv-taxes-78) — here every file is read ONCE, stripped ONCE, and the witnesses, both
//      detectors and the stale-exception check all read that same code.
//
// No dependency and no test framework on purpose: a module runs it under vitest, where the toolkit
// sits OUTSIDE the module (`$ERPLORA_TOOLKIT` on the gate) and an `import 'vitest'` from here would
// resolve against the toolkit and die — the same trap `vitest.module.config.mjs` documents. So it
// returns findings and the module's own test asserts `toEqual([])`:
//
//   import { it, expect } from 'vitest';
//   import { checkMoneyDisplay } from '@erplora/module-toolkit/money-display-guard';
//
//   it('money on screen goes through the shared formatter (pm#289)', () => {
//     expect(
//       checkMoneyDisplay({
//         from: import.meta.url,
//         witnesses: { 'components/erp-combos-menus/erp-combos-menus.ts': { text: 'erplora().formatMoney(', atLeast: 3 } },
//         notDisplay: { 'lib/hub-currency.ts: <exact line>': 'editable field value, not a screen amount' },
//       }),
//     ).toEqual([]);
//   });
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Comments may talk about `toFixed(2)`; only code counts. Block comments are removed LAZILY — a
 * greedy `[\s\S]*` would eat the code between two comments and make the scan pass on nothing (V3).
 * `//` after a `:` is a URL, not a comment. Crude but enough: a false positive fails loud.
 */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

/** Every `NumberFormat(…)` / `.toLocaleString(…)` call whose arguments (up to the balancing paren,
 *  across lines) name a `currency`, collapsed to one line. */
function currencyIntlCalls(code) {
  const calls = [];
  const open = /(?:NumberFormat|\.toLocaleString)\s*\(/g;
  let m;
  while ((m = open.exec(code))) {
    let depth = 1;
    let i = open.lastIndex;
    while (i < code.length && depth > 0) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') depth--;
      i++;
    }
    const call = code.slice(m.index, i);
    if (/\bcurrency\b/.test(call)) calls.push(call.replace(/\s+/g, ' ').trim());
  }
  return calls;
}

/** The hand-formatted numbers in code that is ALREADY stripped of comments. */
function moneyHitsInCode(code) {
  const hits = [];
  for (const line of code.split('\n')) {
    if (/\.toFixed\s*\(/.test(line)) hits.push(line.trim());
  }
  return hits.concat(currencyIntlCalls(code));
}

/**
 * Each hand-formatted number: any `.toFixed(…)` (per line, trimmed — `toFixed(scale)` is the same
 * float path as `toFixed(2)`) or a `NumberFormat(…currency…)` / `.toLocaleString(…currency…)` call.
 */
export function handFormattedMoney(src) {
  return moneyHitsInCode(stripComments(src));
}

// Every door into OutfitKit, the barrel or an entry point:
//   import … from 'x' · import 'x' · export { … } from 'x' · export * from 'x'   (static)
//   import('x')                                                                 (dynamic)
// The span before `from` may not cross a quote, a `;` or another import/export keyword, so a
// statement written without semicolons does not run on into the next one.
const OUTFITKIT_DOORS =
  /\b(import|export)\s+(type\b\s*)?(?:(?:(?!\b(?:import|export)\b)[^;'"`])*?\bfrom\s*)?(['"])(@erplora\/outfitkit(?:\/[^'"]*)?)\3|\bimport\s*\(\s*(['"`])(@erplora\/outfitkit(?:\/[^'"`]*)?)\5\s*\)/g;

function outfitkitDoorsInCode(code) {
  return [...code.matchAll(OUTFITKIT_DOORS)].map((m) => ({
    text: m[0].replace(/\s+/g, ' ').trim(),
    specifier: m[4] ?? m[6],
    typeOnly: Boolean(m[2]),
  }));
}

/** Every OutfitKit import/export the barrel detector examines (entry points and barrel alike). */
export function outfitkitImports(src) {
  return outfitkitDoorsInCode(stripComments(src)).map((d) => d.text);
}

/**
 * The barrel imported as a VALUE, through any of its five doors. Type-only imports/exports are
 * erased by the compiler and stay allowed; entry points (`@erplora/outfitkit/ok-money`) are the
 * way in.
 */
export function barrelValueImports(src) {
  return barrelInCode(stripComments(src));
}

function barrelInCode(code) {
  return outfitkitDoorsInCode(code)
    .filter((d) => d.specifier === '@erplora/outfitkit' && !d.typeOnly)
    .map((d) => d.text);
}

/**
 * The hits no exception covers. Each exception covers ONE occurrence: the key is file + exact line,
 * so a copy of the allowed line in a new display function of the same file does not ride on it.
 */
export function unexpectedHits(found, allowed) {
  const left = new Map(Object.keys(allowed).map((k) => [k, 1]));
  return found.filter((k) => {
    const n = left.get(k) ?? 0;
    left.set(k, n - 1);
    return n <= 0;
  });
}

/** The directory holding `module.json`, walking up from a file URL or a path. */
export function moduleRootFrom(from) {
  let dir = resolve(String(from).startsWith('file:') ? fileURLToPath(from) : String(from));
  if (existsSync(dir) && !statSync(dir).isDirectory()) dir = dirname(dir);
  while (!existsSync(dir) || !existsSync(join(dir, 'module.json'))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`module.json not found walking up from ${from}`);
    dir = up;
  }
  return dir;
}

/** Production sources of the UI: tests, `ui/test/` doubles and type declarations reach no screen. */
function uiSources(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return n === 'test' || n === 'node_modules' ? [] : uiSources(p);
      return /\.(ts|js|vue)$/.test(n) && !/\.test\.(ts|js)$/.test(n) && !n.endsWith('.d.ts') ? [p] : [];
    });
}

function occurrences(haystack, needle) {
  return needle ? haystack.split(needle).length - 1 : 0;
}

/**
 * The whole guard over a module's `ui/`. Returns the findings — `[]` is green. Each finding is
 * `{ code, file, detail }` with `file` relative to `ui/`:
 *
 *   hand_formatted_money       an amount formatted by hand (no exception covers it)
 *   outfitkit_barrel_import    the OutfitKit barrel imported as a value
 *   stale_exception            a `notDisplay` entry the scan no longer finds (it would hide the next)
 *   witness_required           no witness declared: an empty scan would pass
 *   witness_file_not_scanned   a witness file the scan did not read
 *   witness_content_missing    the code the detector read holds fewer than `atLeast` of the text
 *   outfitkit_import_not_read  the barrel scan read no OutfitKit import (or not in a named screen)
 *
 * @param {object} opts
 * @param {string} opts.from  the module test's `import.meta.url`, or any path inside the module
 * @param {Record<string, string | { text: string, atLeast?: number }>} opts.witnesses
 *   files (relative to `ui/`) whose comment-stripped code must hold `text` — count the CALL
 *   (`erplora().formatMoney(`), not the bare name, which a type declaration also spells.
 * @param {Record<string, string>} [opts.notDisplay]  `'file: exact code line' → why it is not a
 *   screen amount`; each covers one occurrence.
 * @param {string[]} [opts.outfitkitImporters]  files that must each import OutfitKit; by default at
 *   least one scanned file must.
 */
export function checkMoneyDisplay({ from, witnesses = {}, notDisplay = {}, outfitkitImporters } = {}) {
  const uiRoot = join(moduleRootFrom(from), 'ui');
  const findings = [];
  const moneyHits = [];
  const code = new Map();
  let okImports = 0;
  const okImporters = new Set();

  for (const f of uiSources(uiRoot)) {
    const rel = f.slice(uiRoot.length + 1);
    const stripped = stripComments(readFileSync(f, 'utf8'));
    code.set(rel, stripped);
    for (const h of moneyHitsInCode(stripped)) moneyHits.push(`${rel}: ${h}`);
    for (const h of barrelInCode(stripped)) findings.push({ code: 'outfitkit_barrel_import', file: rel, detail: h });
    const doors = outfitkitDoorsInCode(stripped).length;
    okImports += doors;
    if (doors) okImporters.add(rel);
  }

  for (const k of unexpectedHits(moneyHits, notDisplay)) {
    const at = k.indexOf(': ');
    findings.push({ code: 'hand_formatted_money', file: k.slice(0, at), detail: k.slice(at + 2) });
  }
  for (const k of Object.keys(notDisplay)) {
    if (!moneyHits.includes(k)) findings.push({ code: 'stale_exception', file: k.slice(0, k.indexOf(': ')), detail: k });
  }

  const entries = Object.entries(witnesses);
  if (!entries.length) {
    findings.push({
      code: 'witness_required',
      file: '',
      detail: 'declare at least one witness: a file and the formatter call its code must still hold',
    });
  }
  for (const [file, spec] of entries) {
    const { text, atLeast = 1 } = typeof spec === 'string' ? { text: spec } : spec;
    if (!code.has(file)) {
      findings.push({ code: 'witness_file_not_scanned', file, detail: text });
      continue;
    }
    const n = occurrences(code.get(file), text);
    if (n < atLeast) findings.push({ code: 'witness_content_missing', file, detail: `${text} ×${n}, expected ≥${atLeast}` });
  }

  if (outfitkitImporters) {
    for (const file of outfitkitImporters) {
      if (!okImporters.has(file)) findings.push({ code: 'outfitkit_import_not_read', file, detail: '@erplora/outfitkit' });
    }
  } else if (!okImports) {
    findings.push({ code: 'outfitkit_import_not_read', file: '', detail: 'the scan read no OutfitKit import' });
  }

  return findings;
}
