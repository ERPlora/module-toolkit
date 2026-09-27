// A «from / to» filter over an amount that the list does not declare as money — module-toolkit#375.
//
// Money travels as an INTEGER in the minor unit (ADR-0123) and a quantity in fixed point 10⁶
// (ADR-0147); the person types the major unit, «12» for twelve euros. Since hub#2271 the SDK's list
// controller scales the edges of a range filter itself, but only for the columns the screen names:
// `createListController(client, query, onChange, { moneyFilters: ['total'], quantityFilters: [...] })`.
// A column that paints money, is filterable by range and is not named there sends «12» as 12 cents —
// «from 12» lets a 0,12 € ticket through and «to 50» hides a 1 € one. Ten lists shipped that, and
// nothing told their authors (Sale de ERPlora/hub#2271).
//
// The signal, per source file of `ui/`: a column object with `filterType: 'range'` whose own text
// paints money (`formatMoney(`, `formatMinor(`, `<ok-money`) or a quantity (`formatQuantity(`) —
// directly or through a helper of the same file (`money(v)`, `this.fmt(n)`) — and whose `key` is
// not in the `moneyFilters` / `quantityFilters` of that same file.
//
// Same ratchet as `validate-ionic-fill.mjs` (per file and count, stale entries fail): what is
// already published lives in `MONEY_FILTERS_GRANDFATHERED` and only shrinks.
import { ratchet } from './validate-ionic-fill.mjs';

const RANGE = /\bfilterType\s*:\s*(['"`])range\1/g;
const PAINTS_MONEY = /\bformat(?:Money|Minor)\s*\(|<ok-money\b/;
const PAINTS_QUANTITY = /\bformatQuantity\s*\(/;
const CALL = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const CLOSER = /^\s*[}\])`>]/;

/** What each kind is declared in, and the code its undeclared column reports. */
const KINDS = {
  money: { option: 'moneyFilters', code: 'money_range_filter_undeclared' },
  quantity: { option: 'quantityFilters', code: 'quantity_range_filter_undeclared' },
};

/**
 * What is ALREADY published with a money/quantity range that is not declared to the SDK, as
 * `[moduleId, file, count]` — measured over `origin/main` of the 27 module repos on 2026-09-27 with
 * the scanner below. Every one of them converts the edges with a LOCAL copy of the recipe
 * (`MONEY_RANGE_FILTERS` + `onFilterChange`, verifactu#137), so the person sees the right result
 * today; they are here because ten copies drift. They leave with ERPlora/pm#501.
 *
 * 🔴 It may only SHRINK (a test fails the moment it grows), the pass is per FILE and per COUNT so a
 * new component inherits nothing, and an entry that no longer covers anything FAILS the module's own
 * gate until it is deleted — the two-line PR that deletes it goes first, the module's behind it.
 */
export const MONEY_FILTERS_GRANDFATHERED = [
  ['cart_checkout', 'ui/components/erp-cart-checkout-carts/erp-cart-checkout-carts.ts', 2],
  ['cart_checkout', 'ui/components/erp-cart-checkout-orders/erp-cart-checkout-orders.ts', 1],
  ['cash_register', 'ui/components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts', 3],
  ['customers', 'ui/components/erp-customers-list/erp-customers-list.ts', 1],
  ['inventory', 'ui/components/erp-inventory-products/erp-inventory-products.ts', 2],
  ['invoice', 'ui/components/erp-invoice-list/erp-invoice-list.ts', 1],
  ['kitchen', 'ui/components/erp-kitchen-orders-active/erp-kitchen-orders-active.ts', 1],
  ['payments', 'ui/components/erp-payments-list/erp-payments-list.ts', 1],
  ['sales', 'ui/components/erp-sales-list/erp-sales-list.ts', 1],
  ['services', 'ui/components/erp-services-list/erp-services-list.ts', 1],
  ['verifactu', 'ui/components/erp-verifactu-records/erp-verifactu-records.ts', 1],
];

/** A test file is not a screen: fixtures of a module's own guards quote bad columns on purpose. */
const TEST_FILE = /\.(?:test|spec)\.(?:ts|js)$/;

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** Whether `index` sits on a comment line (`//`, `/*`, ` * `): prose, not a column. */
function onCommentLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return /^\s*(?:\/\/|\/\*|\*)/.test(source.slice(lineStart, index));
}

/** The `{ … }` object literal that encloses `index`, as `[start, end)`, or null. */
function enclosingObject(source, index) {
  let depth = 0;
  let start = -1;
  for (let i = index - 1; i >= 0; i--) {
    if (source[i] === '}') depth++;
    else if (source[i] === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start === -1) return null;
  depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return [start, i + 1];
  }
  return null;
}

/**
 * The source of the helper `name` defined in `source` — a `const`/`let`/`function` or a class method
 * — or '' if the file does not define it (an import, a global). Its end is read by indentation: the
 * lines that follow, until one comes back to the definition's own level that is not a closer.
 */
function helperBody(source, name) {
  const id = name.replace(/\$/g, '\\$');
  const definitions = [
    new RegExp(`^[ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${id}\\b[^=\\n]*=`, 'm'),
    new RegExp(`^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${id}\\s*[(<]`, 'm'),
    new RegExp(
      `^[ \\t]*(?:(?:private|protected|public|static|async|readonly|override)\\s+)*${id}\\s*(?:<[^>\\n]*>)?\\s*\\([^\\n]*\\)\\s*(?::[^\\n{]+)?\\{`,
      'm',
    ),
  ];
  const def = definitions.map((re) => re.exec(source)).find(Boolean);
  if (!def) return '';
  const lines = source.slice(def.index).split('\n');
  const indent = /^[ \t]*/.exec(lines[0])[0].length;
  const body = [lines[0]];
  for (const line of lines.slice(1)) {
    if (line.trim() && /^[ \t]*/.exec(line)[0].length <= indent && !CLOSER.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** `money`, `quantity` or null: what the column paints, looking one helper deep. */
function paints(column, source) {
  const kindOf = (text) => (PAINTS_MONEY.test(text) ? 'money' : PAINTS_QUANTITY.test(text) ? 'quantity' : null);
  const direct = kindOf(column);
  if (direct) return direct;
  for (const m of column.matchAll(CALL)) {
    const kind = kindOf(helperBody(source, m[1]));
    if (kind) return kind;
  }
  return null;
}

/** The string literals of the `[ … ]` that opens at `from`. */
function stringsOfList(source, from) {
  const end = source.indexOf(']', from);
  if (end === -1) return [];
  return [...source.slice(from, end).matchAll(/(['"`])([^'"`]+)\1/g)].map((m) => m[2]);
}

/** Every column key `source` declares in `option` — a literal list, a `const` of the file, or shorthand. */
function declared(source, option) {
  const keys = new Set();
  const resolve = (name) => {
    const re = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, '\\$')}\\b[^=\\n]*=\\s*\\[`);
    const m = re.exec(source);
    return m ? stringsOfList(source, m.index + m[0].length - 1) : [];
  };
  for (const m of source.matchAll(new RegExp(`\\b${option}\\b(\\s*:\\s*)?`, 'g'))) {
    const after = source.slice(m.index + m[0].length);
    let found = [];
    if (m[1]) {
      if (after.startsWith('[')) found = stringsOfList(source, m.index + m[0].length);
      else {
        const ident = /^[A-Za-z_$][\w$]*/.exec(after);
        if (ident) found = resolve(ident[0]);
      }
    } else if (/^\s*[,}]/.test(after)) {
      found = resolve(option);
    }
    for (const k of found) keys.add(k);
  }
  return keys;
}

/**
 * The range columns of `source` that paint money or a quantity and are not declared to the SDK, as
 * `{ key, kind, code, line }`. `line` is 1-based, where the column object opens.
 */
export function undeclaredRangeFilters(source) {
  const lists = Object.fromEntries(Object.entries(KINDS).map(([kind, { option }]) => [kind, declared(source, option)]));
  const found = [];
  for (const m of source.matchAll(RANGE)) {
    if (onCommentLine(source, m.index)) continue;
    const span = enclosingObject(source, m.index);
    if (!span) continue;
    const column = source.slice(...span);
    const key = /\bkey\s*:\s*(['"`])([^'"`]+)\1/.exec(column)?.[2];
    const kind = key && paints(column, source);
    if (!kind || lists[kind].has(key)) continue;
    found.push({ key, kind, code: KINDS[kind].code, line: lineOf(source, span[0]) });
  }
  return found;
}

/**
 * The door: every money/quantity range column of the module's `ui/` that the SDK will not scale.
 * Returns `{ errors, warnings }`; a module with no `ui/` says nothing. `list` is the grandfathered
 * list to judge against — the real one unless a test proves the ratchet on its own.
 */
export function checkMoneyFilters(dir, manifest, list = MONEY_FILTERS_GRANDFATHERED) {
  return ratchet(dir, manifest, {
    scan: undeclaredRangeFilters,
    list,
    skip: (file) => TEST_FILE.test(file),
    say: {
      over: (file, found, allowed) =>
        `${file}: ${found.length} range filter(s) over an amount the list controller does not scale` +
        (allowed ? ` (${allowed} pre-existing and tolerated; ${found.length - allowed} over)` : '') +
        '. The person types «12» for twelve euros and the query compares it with 12 cents. Name each ' +
        'column in the `moneyFilters` (money) or `quantityFilters` (quantity) of ' +
        '`createListController(…)` in this same file (hub#2271, module-toolkit#375):\n      ' +
        found
          .slice(allowed)
          .map((c) => `L${c.line}: ${c.key} — ${c.code} (${KINDS[c.kind].option})`)
          .join('\n      '),
      gone: (file, allowed) =>
        `${file}: its \`MONEY_FILTERS_GRANDFATHERED\` entry (${allowed} column(s) tolerated) points at a ` +
        'file no longer in `ui/` — deleted or renamed. Delete it from ' +
        '`module-toolkit/src/validate-money-filters.mjs` (ERPlora/pm#501).',
      clean: (file, allowed) =>
        `${file}: every money/quantity range is declared to the SDK now, but the file keeps its ` +
        `\`MONEY_FILTERS_GRANDFATHERED\` entry (${allowed} column(s) tolerated): while it stays, the ` +
        'module can drop a declaration again and this gate would pass it. Delete it from ' +
        '`module-toolkit/src/validate-money-filters.mjs` (ERPlora/pm#501): that PR goes FIRST.',
      looser: (file, today, allowed) =>
        `${file}: ${today} of the ${allowed} undeclared range column(s) tolerated by ` +
        '`MONEY_FILTERS_GRANDFATHERED` remain. Not a failure; the count is NOT trimmed to fit — the ' +
        'file is finished and then the whole entry goes (ERPlora/pm#501).',
    },
  });
}
