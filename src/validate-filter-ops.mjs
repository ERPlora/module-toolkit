// ADR-0125 at the one door that runs on every module PR (module-toolkit#183).
//
// A column header carries a PROMISE. A free-text box says «type a piece of it»; a dropdown says
// «choose one of these». The manifest decides what actually happens — `op: "like"` narrows by
// fragment (`CAST(col AS TEXT) LIKE '%' || … || '%'`), `op: "eq"` demands the whole value. When the
// two disagree nobody gets an error: the list simply comes back EMPTY. The receptionist reads «the
// customer is not here» and creates her a second time. A filter that lies is worse than no filter,
// because the user trusts it.
//
// That rule had a guard — `modules-workspace/guards/filter-ops.test.ts` — but `modules-workspace/`
// is not a git repo and ships no workflows, so nothing ever ran it; it sat RED on `main` for weeks
// while five more columns moved underneath it. This is the same rule at the door that DOES run: a
// module cannot be packed, signed or published without passing `erplora validate`.
//
// WHAT CHANGED, AND WHY IT IS NOT A STRAIGHT PORT. The old guard judged a column by its NAME against
// a hand-kept whitelist of «free text». Swept over `origin/main` of the 27 module repos on
// 2026-09-05 (579 declared filters, `~/.erplora/fleet/logs/183/sweep.py`):
//
//   · «`like` on a column OUTSIDE the whitelist» → 18 findings and 18 FALSE POSITIVES. Every single
//     one is a column the module's own component paints as `filterType: 'text'` — `slug`,
//     `reference`, `key`, `region_code`, `display_description`, `order_number`, `printer_name`…
//     Five of them are not even in the widened whitelist that was proposed. Blocking those means
//     blocking a published module for doing exactly what ADR-0125 asks, so that direction does NOT
//     come across. A name is not evidence.
//   · «the painted `filterType` disagrees with the manifest `op`» → 41 findings across 12 modules,
//     and they ARE the ADR-0125 bug.
//
// So this gate trusts what the module DECLARES about itself, in this order:
//
//   1. the `filterType` its own Web Component paints  ← the promise made to the user
//   2. the column type its own migration writes       ← what the database can actually answer
//   3. the ADR-0125 name whitelist, `eq` direction only, and only where no screen paints the column
//
// Rule 3 is the last-resort net (349 of the 579 filters are painted by no screen). It never fires in
// the `like` direction, for the reason measured above.
//
// RULE 4 LOOKS THE OTHER WAY (module-toolkit#382). Rules 1-3 walk `list.filters`, so a box a screen
// OFFERS (`filterable: true`) over a column the manifest never declared was never looked at — and
// the kernel answers it with `422 unknown_filter`: the person types in the box and the list fails.
// Swept on 2026-09-28 over the 27 modules: 49 list screens, 204 offered boxes, 0 refused — two of
// them only once the screen's own rename is read (`created_at → erp_date`, `zone → zone_id`).
// Those 49 left out every file that drives TWO lists (module-toolkit#407): its columns could not be
// tied to one query without guessing. Each `ok-data-table` now names its own list, and swept again
// on 2026-09-29 the four such files (pricing, reservations, schedules, cash_register) add 24 offered
// boxes judged each against ITS list (9 + 7 + 8 + 0), 0 refused, 0 left unreviewed; the 49
// single-list screens read exactly as before, and no table of the catalogue sets `inlineFilters`.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { migrationFiles } from './validate-migrations.mjs';

/** What the manifest must declare for each kind of box a table paints, and why. */
const EXPECTED_OP = { text: 'like', select: 'eq', range: 'range', daterange: 'range' };

const WHY = {
  text: 'una caja de texto libre invita a teclear un FRAGMENTO; con `eq` cualquier cosa que no sea el valor entero deja la lista vacía, sin error',
  select: 'un dominio cerrado se ELIGE, así que la coincidencia es exacta; `like` casaría el valor dentro de otro (pedir «activo» devolvería también «inactivo»)',
  range: 'dos extremos necesitan el operador que toma dos extremos',
  daterange: 'dos extremos necesitan el operador que toma dos extremos',
};

/**
 * Columns of FREE TEXT — what a human types by hand and looks for in pieces (ADR-0125).
 *
 * Deliberately short and only used in the `eq` direction: it is a heuristic over a NAME, and the
 * measurement above is what a heuristic over a name costs when it is allowed to reject.
 */
const FREE_TEXT = new Set([
  'name', 'name_es', 'first_name', 'last_name', 'full_name', 'company_name', 'customer_name',
  'guest_name', 'staff_name', 'service_name', 'product_name', 'beneficiary_name', 'issuer_name',
  'author_name', 'alias', 'title',
  'email', 'customer_email', 'guest_email', 'contact_email', 'phone', 'customer_phone',
  'contact_phone',
  'notes', 'note', 'comment', 'comment_text', 'description', 'reason', 'concept', 'body',
  'content', 'message', 'subject',
  'sku',
]);

/** Postgres types a substring match can be asked of without lying about what it compares. */
const TEXTUAL = /^\s*"?(text|varchar|character\s+varying|character|char|citext|json|jsonb)\b/i;

const NOT_SOURCE = new Set(['dist', 'node_modules', '.git', 'coverage']);

/**
 * Filters ALREADY PUBLISHED with a box that lies, measured over `origin/main` of the 27 module
 * repos on 2026-09-05. They warn instead of blocking, so that landing this gate does not put 13
 * modules red at once — but a filter that is not on this line is an ERROR, which is the whole point:
 * the next one cannot be born.
 *
 * 🔴 THE LIST ONLY SHRINKS, and an entry may not outlive its filter. Each line is an exact
 * `module · query · column` identity, so it can only ever excuse the one filter it names; when that
 * filter is fixed the line covers nothing, and `checkFilterOps` FAILS the module's own gate on it.
 * That fixes the order of the sweep: the one-line pull request that deletes the entry goes FIRST,
 * and the module's fix merges behind it (same contract as `FILL_GRANDFATHERED`).
 *
 * It fails the module that DECLARES the query — the only one that can have fixed it. A manifest
 * that does not even declare it is not the one the line talks about (a fixture built on a published
 * id, or a query retired whole): it is WARNED, never blocked for somebody else's excuse
 * (module-toolkit#189, same split as `DEAD_FILTERS_GRANDFATHERED` in module-toolkit#178).
 *
 * WHERE THE SWEEP IS — 40 lying boxes in 13 modules were measured; `reservations` fixed its six the
 * same day (ERPlora/reservations#46, merged 2026-09-05), so 34 in 12 modules are excused here: 26 are
 * a text box the manifest filters with the wrong operator, 7 are a text box over a column that is a
 * NUMBER (`difference`, `duration_minutes`, `fiscal_year`, `current_sequence`, `sequence_number`,
 * `priority`, `attempts`) — which no operator can answer well, so those want `filterType: 'range'` —
 * and 1 is a free-text column no screen paints (`inventory.products.low_stock → sku`). With them
 * excused the whole published catalogue is GREEN: 27 modules, 0 errors, 34 warnings. Their fixes
 * are ERPlora/pm#244.
 *
 * The ceiling that keeps this list from GROWING is `test/validate-filter-ops.test.mjs` («may only
 * SHRINK»): a line added here has to raise that number, which is what makes the addition visible.
 */
export const FILTER_OPS_GRANDFATHERED = [
  // cart_checkout — 3
  ['cart_checkout', 'cart_checkout.carts.list', 'session_token'],
  ['cart_checkout', 'cart_checkout.orders.list', 'order_number'],
  ['cart_checkout', 'cart_checkout.orders.list', 'payment_method'],
  // cash_register — 1 (`difference` became a money range in ERPlora/cash_register#107)
  ['cash_register', 'cash_register.sessions.list', 'session_number'],
  // inventory — 1
  ['inventory', 'inventory.products.low_stock', 'sku'],
  // invoice — 1
  ['invoice', 'invoice.list', 'number'],
  // invoice_series — 3
  ['invoice_series', 'invoice_series.series.list', 'code'],
  ['invoice_series', 'invoice_series.series.list', 'fiscal_year'],
  ['invoice_series', 'invoice_series.series.list', 'current_sequence'],
  // online_booking — 2
  ['online_booking', 'online_booking.bookings.list', 'booking_reference'],
  ['online_booking', 'online_booking.bookings.list', 'booking_time'],
  // payment_gateways — 2
  ['payment_gateways', 'payment_gateways.gateways.list', 'code'],
  ['payment_gateways', 'payment_gateways.transactions.list', 'reference'],
  // services — 1
  ['services', 'services.services.list', 'duration_minutes'],
  // tasks — 3
  ['tasks', 'tasks.tasks.list', 'task_number'],
  ['tasks', 'tasks.projects.list', 'code'],
  ['tasks', 'tasks.projects.list', 'color'],
  // tickets — 1
  ['tickets', 'tickets.tickets.list', 'ticket_number'],
  // verifactu — 10 (`event_type` became a select of named types in ERPlora/verifactu#134)
  ['verifactu', 'verifactu.records.list', 'sequence_number'],
  ['verifactu', 'verifactu.records.list', 'invoice_number'],
  ['verifactu', 'verifactu.records.list', 'invoice_type'],
  ['verifactu', 'verifactu.contingency.list', 'record_id'],
  ['verifactu', 'verifactu.contingency.list', 'priority'],
  ['verifactu', 'verifactu.contingency.list', 'attempts'],
  ['verifactu', 'verifactu.contingency.list', 'last_error'],
  ['verifactu', 'verifactu.contingency.list', 'status'],
  ['verifactu', 'verifactu.aeat.records.list', 'invoice_number'],
  ['verifactu', 'verifactu.aeat.records.list', 'estado'],
  // whatsapp_inbox — 2 (the requests screen was retired in whatsapp_inbox#193)
  ['whatsapp_inbox', 'whatsapp_inbox.conversations.list', 'contact_name'],
  ['whatsapp_inbox', 'whatsapp_inbox.templates.list', 'language'],
];

/**
 * Every list screen a component source declares, as `{ query, columns }`, where each column is
 * `{ key, filterTypes, filterable, sentAs }` — EVERY box that column can paint, in source order,
 * without repeats; whether the table actually offers a filter control for it; and the name its value
 * reaches the list under (`sentAs`, see `filterRoutes`).
 *
 * `createListController(erplora(), '<query>', …)` is the one way a screen binds itself to a
 * paginated list, so a table written tomorrow cannot be born outside this gate without anybody
 * remembering to register it.
 *
 * 🔴 `filterTypes` is a LIST, and that is the whole of module-toolkit#187. It used to be one value,
 * read with `exec`, which returns the FIRST match — so a column written as
 *
 *     { key: 'payment_method_name', …,
 *       ...(this.payMethods.length ? { filterType: 'select', … } : { filterType: 'text' }) }
 *
 * read as a dropdown, the dropdown agreed with the manifest, and the gate approved the screen
 * without ever seeing the text box — which is the branch the user gets on the day the catalogue
 * fails to load, and the one that can never match. Worse than the miss: passing meant the filter
 * did not enter `FILTER_OPS_GRANDFATHERED` either, so nobody looked at it again.
 *
 * The two readings the source needs, and why neither is optional:
 *
 *   · a column's chunk ends with ITS object (`enclosingObject`), not at the next `key: '`. Cutting
 *     on the next key hands the LAST column of the array everything written below it (taxes#54).
 *   · comments and string bodies are not code (`blankNonCode`), so a `filterType` left in a comment
 *     paints nothing.
 *
 * `inline` says how the screen's table draws its boxes (see `INLINE_KINDS`): `true` with
 * `inlineFilters`, `false` without, `null` when the tag binds it to an expression decided at runtime.
 *
 * A file that drives MORE THAN ONE list (module-toolkit#407) hands each `ok-data-table` ITS columns:
 * the table names them in `.columns=${…}` and its list in the controller its `@filterChange` feeds
 * (see `dataTables`). A table that cannot be read that way is not guessed — a guess here rejects
 * correct code — but it is not silent either: its boxes come back under `query: null`, which the
 * caller reports as a screen nobody reviewed.
 */
export function listScreens(source) {
  const code = blankNonCode(source);
  const controllers = listControllers(source, code);
  if (controllers.length === 0) return [];
  const tables = dataTables(source, code, controllers);

  if (controllers.length === 1) {
    const [{ query, name }] = controllers;
    const columns = readColumns(source, code, filterRoutes(source, code)).map(({ column }) => column);
    return [{ query, columns, inline: inlineOf(tables.filter((t) => t.controller === name)) }];
  }

  const screens = new Map();
  for (const { query } of controllers) {
    if (!screens.has(query)) screens.set(query, { query, columns: [], tables: [] });
  }
  const covered = []; // every span a recognised table reads its columns from
  const unread = [];
  let unreadable = false;
  for (const table of tables) {
    if (table.span) covered.push(table.span);
    if (table.controller === undefined) continue; // a client-side table: it drives no list
    const columns = table.span ? spanColumns(source, table.span, table.routes) : null;
    if (table.controller === null || columns == null) {
      if (columns == null) unreadable = true;
      else unread.push(...columns);
      continue;
    }
    const screen = screens.get(controllers.find((c) => c.name === table.controller).query);
    screen.columns.push(...columns);
    screen.tables.push(table);
  }
  // Columns no table claims: with a table that could not be read — or no table at all — they may be
  // exactly the boxes it offers.
  if (unreadable || tables.every((t) => t.controller === undefined)) {
    for (const { at, column } of readColumns(source, code, new Map())) {
      if (!covered.some((s) => at >= s.from && at < s.to)) unread.push(column);
    }
  }
  const out = [...screens.values()].map(({ query, columns, tables: own }) => ({
    query,
    columns,
    inline: inlineOf(own),
  }));
  const boxes = unread.filter((c) => c.filterable || c.filterTypes.length);
  if (boxes.length) out.push({ query: null, columns: boxes, inline: false });
  return out;
}

/**
 * Every `createListController(erplora(), '<query>', …)` of the source, as `{ query, name }`, where
 * `name` is what it is assigned to (`this.rulesCtrl = …`, `const ctl = …`), or null.
 */
function listControllers(source, code) {
  const out = [];
  for (const m of code.matchAll(/createListController[^(]*\(\s*erplora\(\)\s*,\s*'/g)) {
    const query = readString(source, m.index + m[0].length - 1);
    if (query == null) continue;
    const before = code.slice(Math.max(0, m.index - 300), m.index);
    const assigned = /(?:\bthis\s*\.\s*)?([A-Za-z_$][\w$]*)\s*!?\s*(?::[^=;]*)?=\s*$/.exec(before);
    out.push({ query, name: assigned ? assigned[1] : null });
  }
  return out;
}

/**
 * The column literals between `from` and `to`, as `{ at, column }` — `at` being where the column's
 * `key:` sits — with `column` in the shape `listScreens` documents.
 */
function readColumns(source, code, routes, from = 0, to = code.length) {
  const out = [];
  const scope = code.slice(from, to);
  for (const m of scope.matchAll(/\bkey\s*:\s*'/g)) {
    const at = from + m.index;
    const key = readString(source, at + m[0].length - 1);
    if (key == null) continue;
    const body = enclosingObject(code, at);
    if (body == null) continue; // a `key:` outside any object literal declares no column
    const chunk = code.slice(body.from, body.to);
    const filterTypes = [];
    for (const f of chunk.matchAll(/\bfilterType\s*:\s*'/g)) {
      const value = readString(source, body.from + f.index + f[0].length - 1);
      if (value != null && !filterTypes.includes(value)) filterTypes.push(value);
    }
    // `ok-data-table` draws a filter control ONLY for `filterable: true` (a missing `filterType`
    // makes it a text box). Swept over the 27 modules on 2026-09-28 the flag is only ever written
    // as the literal, so that is what counts as an offered box (module-toolkit#382).
    const filterable = /\bfilterable\s*:\s*true\b/.test(chunk);
    const sentAs = routes.has(key) ? routes.get(key) : key;
    out.push({ at, column: { key, filterTypes, filterable, sentAs } });
  }
  return out;
}

/** The columns written in `source[span.from, span.to)`, read on their own. */
function spanColumns(source, span, routes) {
  const text = source.slice(span.from, span.to);
  return readColumns(text, blankNonCode(text), routes).map(({ column }) => column);
}

/** One screen's `inline` out of the tables that show its list: `null` when they disagree. */
function inlineOf(tables) {
  if (tables.length === 0) return false;
  const [first] = tables.map((t) => t.inline);
  return tables.every((t) => t.inline === first) ? first : null;
}

/**
 * Every `<ok-data-table …>` the source writes, as `{ controller, span, routes, inline }`:
 *
 *   · `controller` — the ONE list controller its `@filterChange` hands the box to (followed into
 *     the method it calls, one level), or, with no handler, the one its tag reads anywhere. `null`
 *     when that is none or several and the table filters on the server; `undefined` for a table
 *     that filters its own rows in memory (not `serverSide`), which drives no list at all.
 *   · `span` — where its `.columns=${…}` are written: an inline array, or the getter, method or
 *     field it names. `null` when the expression is anything else (a call with arguments…).
 *   · `routes` — the renames of ITS handler (`filterRoutes`), not the file's: two tables of one
 *     file may send the same column under different names.
 *   · `inline` — `inlineFilters`, as `listScreens` documents it.
 *
 * A tag inside a comment is not a table. Offsets are the source's.
 */
function dataTables(source, code, controllers) {
  const text = blankNonCode(source, { strings: false });
  const names = controllers.map((c) => c.name).filter(Boolean);
  const mentions = (blanked, name, member) =>
    new RegExp(String.raw`(?:${member ? String.raw`\bthis\s*\??\.\s*|` : ''}(?<![\w$.]))${name.replace(/\$/g, '\\$')}(?![\w$])`).test(
      blanked,
    );
  // `const ctrl = this.movements;` — a local alias of a controller. One file may reuse the same
  // alias for two lists (cash_register), so the declaration that counts is the last one before `at`.
  const aliases = [];
  for (const a of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*this\s*\.\s*([A-Za-z_$][\w$]*)\s*[;\n]/g)) {
    if (names.includes(a[2])) aliases.push({ alias: a[1], name: a[2], at: a.index });
  }
  const refsIn = (expr, at) => {
    const blanked = blankNonCode(expr);
    const found = new Set(names.filter((n) => mentions(blanked, n, true)));
    const inForce = new Map();
    for (const a of aliases) if (a.at < at) inForce.set(a.alias, a.name);
    for (const [alias, name] of inForce) if (mentions(blanked, alias, false)) found.add(name);
    return [...found];
  };

  const out = [];
  for (const m of text.matchAll(/<ok-data-table\b/g)) {
    const attrs = tagAttributes(text, m.index + m[0].length);
    if (attrs == null) continue;
    const attr = (name) => attrs.find((a) => a.name === name);

    let refs;
    let routeText = '';
    const handler = attr('@filterChange');
    if (handler?.expr != null) {
      routeText = handler.expr;
      refs = new Set(refsIn(handler.expr, m.index));
      for (const c of blankNonCode(handler.expr).matchAll(/\bthis\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) {
        if (names.includes(c[1])) continue;
        const body = memberSpan(source, code, c[1]);
        if (body == null) continue;
        const bodyText = source.slice(body.from, body.to);
        routeText += `\n${bodyText}`;
        for (const r of refsIn(bodyText, body.from)) refs.add(r);
      }
    } else {
      refs = new Set(attrs.flatMap((a) => (a.expr == null ? [] : refsIn(a.expr, m.index))));
    }
    const serverSide = booleanAttr(attrs, 'serverside');
    let controller;
    if (refs.size === 1) [controller] = refs;
    else controller = refs.size === 0 && serverSide === false ? undefined : null;

    const columns = attr('.columns');
    out.push({
      controller,
      span: columns?.expr == null ? null : columnsSpan(source, code, columns),
      routes: routeText ? filterRoutes(routeText, blankNonCode(routeText)) : new Map(),
      inline: booleanAttr(attrs, 'inlinefilters'),
    });
  }
  return out;
}

/** Where the columns a `.columns=${expr}` binding hands the table are written, or null. */
function columnsSpan(source, code, { expr, at }) {
  const trimmed = expr.trim();
  if (trimmed.startsWith('[')) {
    const from = at + expr.indexOf('[');
    return { from, to: at + expr.length };
  }
  const named = /^(?:this\s*\??\.\s*)?([A-Za-z_$][\w$]*)\s*(\(\s*\))?$/.exec(trimmed);
  return named ? memberSpan(source, code, named[1]) : null;
}

/**
 * `{ from, to }` of the ONE definition of `name` in the source — a getter or method body, or the
 * value of a field, `const` or `this.name =` assignment — or null when there is none or more than
 * one. Read over the blanked `code`, so a name in a comment or a string defines nothing.
 */
function memberSpan(source, code, name) {
  const found = [];
  const escaped = name.replace(/\$/g, '\\$');
  for (const m of code.matchAll(new RegExp(String.raw`\bget\s+${escaped}\s*\(\s*\)`, 'g'))) {
    const open = code.indexOf('{', m.index + m[0].length);
    const body = open < 0 ? null : blockAt(code, open);
    if (body) found.push(body);
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.]|\bget\s+)${escaped}\s*\(`, 'g'))) {
    const close = closingParen(code, m.index + m[0].length - 1);
    if (close < 0) continue;
    const head = /^\s*(?::[^{;=]*)?\{/.exec(code.slice(close + 1));
    if (!head) continue; // a call, not a definition
    const body = blockAt(code, close + head[0].length);
    if (body) found.push(body);
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$])${escaped}\s*[!?]?\s*(?::[^=;{}]*)?=(?![=>])`, 'g'))) {
    const before = code.slice(0, m.index).trimEnd();
    if (before.endsWith('.') && !/\bthis\s*\??\.$/.test(before)) continue; // `other.name =`
    const from = m.index + m[0].length;
    found.push({ from, to: statementEnd(code, from) });
  }
  return found.length === 1 ? found[0] : null;
}

/** Index of the `)` that closes the `(` at `open`, over blanked code, or -1. */
function closingParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Where the value that starts at `from` ends: `;`, a closing brace, or the end of a finished line. */
function statementEnd(code, from) {
  let depth = 0;
  let last = '';
  for (let i = from; i < code.length; i += 1) {
    const ch = code[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (ch === ';' || (ch === '\n' && last && !/[=>,(:?+\-*/&|]/.test(last)))) {
      return i;
    }
    if (!/\s/.test(ch)) last = ch;
  }
  return code.length;
}

/**
 * The attributes of the tag whose name ends at `from`, as `{ name, expr, at }` (`expr` is the text of
 * a `${…}` binding and `at` where it starts, or null for a plain value), or null when the tag never
 * closes. Read over source whose comments are blanked and whose strings are not.
 */
function tagAttributes(text, from) {
  const attrs = [];
  let i = from;
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] === '>') return attrs;
    if (text[i] === '/' && text[i + 1] === '>') return attrs;
    const name = /^[^\s=>/]+/.exec(text.slice(i, i + 200));
    if (!name) {
      i += 1;
      continue;
    }
    i += name[0].length;
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text[j] !== '=') {
      attrs.push({ name: name[0], expr: null, at: -1 });
      continue;
    }
    j += 1;
    while (j < text.length && /\s/.test(text[j])) j += 1;
    if (text.startsWith('${', j)) {
      const end = expressionEnd(text, j + 2);
      attrs.push({ name: name[0], expr: text.slice(j + 2, end), at: j + 2 });
      i = end + 1;
    } else if (text[j] === '"' || text[j] === "'") {
      const end = literalEnd(text, j);
      const raw = text.slice(j + 1, end - 1);
      const bound = /^\$\{([\s\S]*)\}$/.exec(raw);
      attrs.push({ name: name[0], expr: bound ? bound[1] : null, at: bound ? j + 3 : -1 });
      i = end;
    } else {
      while (j < text.length && !/[\s>]/.test(text[j])) j += 1;
      attrs.push({ name: name[0], expr: null, at: -1 });
      i = j;
    }
  }
  return null;
}

/**
 * A boolean property of the tag, by its lower-case name: `true`/`false` when it is written as a
 * literal (`.inlineFilters=${true}`, or the bare attribute, which is `true` by being there), `false`
 * when it is absent, `null` when it is bound to an expression decided at runtime.
 */
function booleanAttr(attrs, lower) {
  const a = attrs.find((x) => x.name.replace(/^[.?]/, '').toLowerCase() === lower);
  if (!a) return false;
  if (!/^[.?]/.test(a.name)) return true;
  const value = (a.expr ?? '').trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

/**
 * `column -> name on the wire | null` for every column the screen's own `filterChange` handler
 * treats by name, instead of handing `detail.col` straight to `setFilter`.
 *
 * Swept over the 27 modules on 2026-09-28 (module-toolkit#382), a handler that looks at the column
 * name does one of two things:
 *
 *   · it RENAMES it — `e.detail.col === 'created_at' ? 'erp_date' : e.detail.col` (sales),
 *     `detail.col === 'zone' ? 'zone_id' : detail.col` (tables). The list receives `erp_date`, so
 *     that is the name the list has to accept, not the column's.
 *   · it takes it BY HAND — `if (e.detail.col === 'is_active') return this.applyStatusFilter(…)`
 *     (inventory). What reaches the wire cannot be read from here: `null`, and the column is not
 *     judged. Missing a lie is the safe direction; accusing a working screen is not.
 *
 * A column compared in both ways, or renamed to two names, is `null` as well. A ternary is a rename
 * only when it hands the column back (`? 'target' : …col`); anything else that compares the name —
 * `col === 'total' ? 'end' : 'start'` to align a cell, `col !== 'zone'` — is `null` too: judging
 * the box under `end` would refuse a list that declares `total` correctly. The comparison is read
 * with the name on either side (`'key' === …col`).
 */
function filterRoutes(source, code) {
  const routes = new Map();
  const note = (key, target) => {
    if (key == null) return;
    if (!routes.has(key)) routes.set(key, target);
    else if (routes.get(key) !== target) routes.set(key, null);
  };
  const quoted = (at) => readString(source, at);
  const COL = String.raw`(?:[\w$]+\s*\??\.\s*)*col\b`;
  /** What `…` after the comparison makes of the column: its new name, or `null` when unreadable. */
  const target = (after, negated) => {
    if (negated) return null;
    const ternary = /^\s*\?\s*'/.exec(code.slice(after));
    if (!ternary) return null;
    const open = after + ternary[0].length - 1;
    const renamed = quoted(open);
    if (renamed == null) return null;
    const handsBack = new RegExp(String.raw`^\s*:\s*${COL}`).test(code.slice(open + renamed.length + 2));
    return handsBack ? renamed : null;
  };
  // `…col === 'key'` / `…col !== 'key'`.
  for (const m of code.matchAll(/\bcol\s*(!|=)==?\s*'/g)) {
    const open = m.index + m[0].length - 1;
    const key = quoted(open);
    if (key != null) note(key, target(open + key.length + 2, m[1] === '!'));
  }
  // `'key' === …col` / `'key' !== …col`.
  for (const m of code.matchAll(new RegExp(String.raw`'[^'\n]*'\s*(!|=)==?\s*${COL}`, 'g'))) {
    note(quoted(m.index), target(m.index + m[0].length, m[1] === '!'));
  }
  return routes;
}

/**
 * The same source with every comment and every string BODY blanked to spaces, offsets untouched.
 *
 * Structure — braces, `key:`, the quotes themselves — survives, so the blanked copy can be scanned
 * and every offset still points at the real character in `source`. What stops being code is prose:
 * a `filterType: 'select'` left behind in a comment used to paint a box (taxes#54).
 *
 * A template literal is blanked whole, `${…}` included — and it ends at ITS closing backtick, not at
 * the first one of a template nested in an interpolation (`.cardTitle=${(r) => `${r.day}`}`), which
 * used to turn the rest of the markup into «code». A column declared inside an interpolation would be
 * missed, which no component does — and missing it is the safe direction anyway: this gate only ever
 * ACCUSES a column it can see painted.
 *
 * With `strings: false` only the comments go: that is the copy the `ok-data-table` tags — markup
 * inside a template literal — are read from (`dataTables`).
 */
function blankNonCode(source, { strings = true } = {}) {
  const out = source.split('');
  const blank = (i) => {
    if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') blank(i++);
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      while (i < stop) blank(i++);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = literalEnd(source, i);
      // the quotes stay, so `key: '` is still findable
      if (strings) for (let k = i + 1; k < end - 1; k += 1) blank(k);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Index just past the string or template literal whose opening quote is at `i`. */
function literalEnd(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    if (quote === '`' && ch === '$' && text[j + 1] === '{') {
      j = expressionEnd(text, j + 2) + 1;
      continue;
    }
    j += 1;
  }
  return text.length;
}

/** Index of the `}` that closes a `${` whose expression starts at `i` (or the end of the text). */
function expressionEnd(text, i) {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '/' && text[j + 1] === '/') {
      const nl = text.indexOf('\n', j);
      j = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === '/' && text[j + 1] === '*') {
      const end = text.indexOf('*/', j + 2);
      j = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      j = literalEnd(text, j);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      if (depth === 0) return j;
      depth -= 1;
    }
    j += 1;
  }
  return text.length;
}

/** `{ from, to }` of the block whose `{` is at `open`, over blanked code, or null. */
function blockAt(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return { from: open, to: i + 1 };
    }
  }
  return null;
}

/** The contents of the string literal whose opening quote is at `quote`, or null if unterminated. */
function readString(source, quote) {
  const end = source.indexOf(source[quote], quote + 1);
  return end < 0 ? null : source.slice(quote + 1, end);
}

/**
 * `{ from, to }` of the object literal that encloses `at`, over ALREADY BLANKED code.
 *
 * Cutting a column's chunk at the next `key: '` — what this gate did until module-toolkit#187 —
 * hands the LAST column of the array everything written below it, so an unrelated `filterType`
 * further down the file is read as a box that column paints (taxes#54).
 */
function enclosingObject(code, at) {
  let depth = 0;
  let from = -1;
  for (let i = at; i >= 0; i -= 1) {
    if (code[i] === '}') depth += 1;
    else if (code[i] === '{') {
      if (depth === 0) {
        from = i;
        break;
      }
      depth -= 1;
    }
  }
  if (from < 0) return null;
  depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return { from, to: i + 1 };
    }
  }
  return null;
}

/** The body between the outermost parentheses starting at `from`, or null when unbalanced. */
export function parenBody(text, from) {
  const open = text.indexOf('(', from);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") inString = true;
    else if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

/** Splits a parenthesised body on the commas at depth 0, so `NUMERIC(10, 2)` survives whole. */
export function topLevelParts(body) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inString = false;
  for (const ch of body) {
    if (inString) {
      current += ch;
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '(') {
      depth += 1;
      current += ch;
    } else if (ch === ')') {
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const NOT_A_COLUMN = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE|INCLUDE)\b/i;

/** `column -> declared type`, first declaration wins, for every column this SQL declares. */
export function declaredColumnTypes(sql) {
  const clean = sql.replace(/--[^\n]*/g, '');
  const types = new Map();
  const remember = (col, type) => {
    const key = col.replace(/"/g, '').toLowerCase();
    if (!types.has(key)) types.set(key, type.trim());
  };

  for (const m of clean.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\w".]+/gi)) {
    const body = parenBody(clean, m.index + m[0].length);
    if (body == null) continue;
    for (const part of topLevelParts(body)) {
      if (NOT_A_COLUMN.test(part)) continue;
      const tokens = part.split(/\s+/);
      if (tokens.length < 2) continue;
      remember(tokens[0], tokens.slice(1).join(' '));
    }
  }

  for (const m of clean.matchAll(
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?[\w".]+\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([^;,]+)/gi,
  )) {
    remember(m[1], m[2]);
  }

  return types;
}

/** Whether a substring match over this column compares text, or a number/date turned into text. */
export function isTextualType(type) {
  return TEXTUAL.test(String(type ?? ''));
}

/** Every `.ts`/`.js` under `dir`, skipping build output and vendored code. */
function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SOURCE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(entry.name) && !/\.test\.(ts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * `query -> column -> [{ filterType, screen }]` — EVERY box the module's own screens paint for the
 * column, in the order they are written, one entry per distinct box.
 *
 * 🔴 All of them, not the first (module-toolkit#187). A column picks its control at runtime often
 * enough to matter — a dropdown while its catalogue is loaded, a text box when it is not — and a
 * gate that reads only the first arm blesses the other one unseen. It is the same for a column two
 * SCREENS paint differently: the manifest has ONE `op`, so if the two boxes disagree about what
 * they need, one of them is lying to the user whichever screen he is on.
 *
 * `offered` is the same map restricted to the columns the table really draws a control for
 * (`filterable: true`), with the implicit `text` box when no `filterType` is written, and keyed by
 * the name the value reaches the runtime under — `f_<name>` (module-toolkit#382). A column the
 * screen takes by hand (`sentAs: null`) is left out: its wire cannot be read, and so is a box an
 * `inlineFilters` table never draws (`INLINE_KINDS`).
 *
 * `unreviewed` lists the screens whose boxes could not be attributed to a list (`query: null` in
 * `listScreens`), so the caller can say they were not looked at (module-toolkit#407).
 */
function paintedBoxes(dir) {
  const painted = new Map();
  const offered = new Map();
  const unreviewed = [];

  for (const abs of sourceFiles(join(dir, 'ui'))) {
    let screens;
    try {
      screens = listScreens(readFileSync(abs, 'utf8'));
    } catch {
      continue; // an unreadable UI file is another gate's problem, not a filter verdict
    }
    const file = relative(dir, abs).split(sep).join('/');
    for (const { query, columns, inline } of screens) {
      if (query == null) {
        unreviewed.push({ screen: file, columns: [...new Set(columns.map((c) => c.key))] });
        continue;
      }
      if (!painted.has(query)) painted.set(query, new Map());
      const forQuery = painted.get(query);
      for (const { key, filterTypes, filterable, sentAs } of columns) {
        if (filterable && sentAs != null) {
          if (!offered.has(query)) offered.set(query, new Map());
          const forOffer = offered.get(query);
          if (!forOffer.has(sentAs)) forOffer.set(sentAs, []);
          for (const filterType of filterTypes.length ? filterTypes : ['text']) {
            if (inline === true && !INLINE_KINDS.has(filterType)) continue; // never drawn
            const boxes = forOffer.get(sentAs);
            if (!boxes.some((b) => b.filterType === filterType && b.inline === inline)) {
              boxes.push({ filterType, inline, screen: file, column: key });
            }
          }
        }
        if (!forQuery.has(key)) forQuery.set(key, []);
        const boxes = forQuery.get(key);
        for (const filterType of filterTypes) {
          if (boxes.some((b) => b.filterType === filterType)) continue;
          boxes.push({ filterType, screen: file });
        }
      }
    }
  }
  return { painted, offered, unreviewed };
}

/** `column -> Set<declared type>` over every postgres migration this manifest declares. */
function moduleColumnTypes(dir, manifest) {
  const types = new Map();
  for (const rel of migrationFiles(manifest, 'postgres')) {
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    let sql;
    try {
      sql = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const [col, type] of declaredColumnTypes(sql)) {
      if (!types.has(col)) types.set(col, new Set());
      types.get(col).add(type);
    }
  }
  return types;
}

/** Boxes whose value travels as a `{from, to}` pair — `f_<col>_from` / `f_<col>_to` on the wire. */
const TWO_BOUNDS = new Set(['range', 'daterange']);

/**
 * The only boxes an `ok-data-table` with `inlineFilters` draws: it puts them in its toolbar and
 * drops the filters drawer, so a text or range box of such a table is never offered. There a
 * `date` box is a FROM → TO pill that sends `{ from, to }`, where the drawer's sends one value
 * (outfitkit `renderInlineFilter`; the residual risk rv-mt-408 left written down).
 */
const INLINE_KINDS = new Set(['select', 'multiselect', 'date', 'daterange']);

/**
 * The parameters one box sends for `column`, as `buildListParams` flattens them. A `date` box whose
 * table decides `inlineFilters` at runtime (`inline: null`) can send either shape, so the list has
 * to accept both.
 */
function wireOf(column, { filterType, inline }) {
  const one = [`f_${column}`];
  const two = [`f_${column}_from`, `f_${column}_to`];
  if (TWO_BOUNDS.has(filterType)) return two;
  if (filterType !== 'date' || inline === false) return one;
  return inline === true ? two : [...one, ...two];
}

/**
 * Every `:name` bind the query's base SQL reads, inline or from its `.sql` file — the third source
 * of `accepted_params` in the runtime. Comments and string bodies are not binds; a `::type` cast
 * reads as a bind named after the type, which no box ever sends as `f_<col>`. An unreadable or multi-statement `sql` yields nothing: then only `list.filters` counts,
 * which can only make this gate ask for a declaration, never let a refused box through.
 */
function sqlBinds(dir, value) {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const out = new Set();
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    let sql = raw.trim();
    if (/\.sql$/i.test(sql)) {
      const path = isAbsolute(sql) ? sql : join(dir, sql);
      try {
        sql = readFileSync(path, 'utf8');
      } catch {
        continue; // a missing file is `validate`'s own finding
      }
    }
    const code = sql
      .replace(/--[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/'(?:[^']|'')*'/g, "''");
    for (const m of code.matchAll(/:([A-Za-z_]\w*)/g)) out.add(m[1]);
  }
  return out;
}

/** The property names of a query's JSON Schema — the fourth source of `accepted_params`. */
function schemaProperties(schema) {
  const props = schema && typeof schema === 'object' ? schema.properties : null;
  return props && typeof props === 'object' ? Object.keys(props) : [];
}

/**
 * The whole door: every filter of this manifest whose box does not mean what it looks like.
 * Returns `{ errors, warnings }` — the shape the other `erplora validate` checks use.
 */
export function checkFilterOps(dir, manifest) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };

  const queries = manifest?.queries;
  const { painted, offered, unreviewed } = paintedBoxes(dir);
  const types = moduleColumnTypes(dir, manifest);

  // A screen of several lists whose table could not be tied to one of them: judging it would be a
  // guess, and a guess rejects correct code — but passing it in silence reads as «reviewed».
  for (const { screen, columns } of unreviewed) {
    warnings.push(
      `[filter-ops] ${screen} conduce varias listas y no se ha podido saber a cuál manda sus filtros ` +
        `la tabla de ${columns.map((c) => `\`${c}\``).join(', ')}: esas cajas NO se han revisado ` +
        '(module-toolkit#407). Átala como las demás —`.columns=${this.<getter>}` y un `@filterChange` ' +
        'que llegue al `setFilter` de UN controlador— para que `erplora validate` la compruebe.',
    );
  }

  /** `query|column -> message`, so a filter is reported once however many rules see it. */
  const found = new Map();
  const report = (query, column, message) => {
    const key = `${query}|${column}`;
    if (!found.has(key)) found.set(key, message);
  };

  /** Every type this module gives the column, or null when it declares none (somebody else's). */
  const typesOf = (column) => types.get(String(column).toLowerCase()) ?? null;
  const isText = (column) => {
    const declared = typesOf(column);
    if (declared == null) return null; // not ours to judge
    return [...declared].some(isTextualType);
  };

  if (queries && typeof queries === 'object') {
    for (const [query, spec] of Object.entries(queries)) {
      if (!spec || typeof spec !== 'object') continue;
      const filters = (spec.list ?? {}).filters;
      if (!filters || typeof filters !== 'object') continue;

      const boxes = painted.get(query) ?? new Map();

      for (const [column, def] of Object.entries(filters)) {
        const op = (def ?? {}).op ?? null;
        const drawn = boxes.get(column) ?? [];
        const textual = isText(column);

        // ── 1 · EVERY box the column can paint has to mean what it looks like ───────────────
        // Not just the first (module-toolkit#187). A column that chooses its control at runtime —
        // a dropdown while its catalogue is loaded, a text box when it is not — has to be honest as
        // both, because the manifest has ONE `op` and the user gets whichever branch his day gave
        // him. Same for a column two SCREENS paint differently.
        const alsoPaints =
          drawn.length > 1
            ? ` Ojo: \`${column}\` puede pintarse de ${drawn.length} formas (` +
              `${[...drawn.map((b) => b.filterType)].sort().map((t) => `\`${t}\``).join(', ')}) y el ` +
              'manifest solo declara UN ' +
              '`op`. Si no hay ninguno que sirva a todas, la rama que no puede responder tiene que ' +
              'dejar de ofrecer filtro, no ofrecerlo en falso.'
            : '';
        let judged = false;
        for (const box of drawn) {
          const expected = EXPECTED_OP[box.filterType];
          if (expected === undefined) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como \`filterType: '${box.filterType}'\`, que esta ` +
                'puerta no conoce: enséñasela (o usa `text`/`select`/`range`/`daterange`).',
            );
            judged = true;
            break;
          }
          if (expected === 'like' && textual === false) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como caja de texto, pero la columna es ` +
                `\`${[...typesOf(column)].join('` / `')}\` — no es texto. El runtime compara ` +
                '`CAST(col AS TEXT) LIKE \'%…%\'`, así que con `like` teclear «2» devolvería también ' +
                '12, 20 y 22, y con `eq` hay que teclear el número entero. Píntala ' +
                "`filterType: 'range'` y declara `op: 'range'` (ADR-0125)." + alsoPaints,
            );
            judged = true;
            break;
          }
          if (op !== expected) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como \`filterType: '${box.filterType}'\` pero ` +
                `\`${query}\` lo filtra con \`op: ${JSON.stringify(op)}\` — ${WHY[box.filterType]}. ` +
                `Que coincidan: o \`op: '${expected}'\` en el manifest, o la caja que corresponda al ` +
                'dato (un dominio cerrado se pinta `select` y se queda en `op: \'eq\'`) (ADR-0125).' +
                alsoPaints,
            );
            judged = true;
            break;
          }
        }
        if (judged) continue;

        // ── 2 · `like` over a column that is not text ───────────────────────────────────────
        if (op === 'like' && textual === false) {
          report(
            query,
            column,
            `\`${query}\` filtra \`${column}\` con \`op: 'like'\`, pero este módulo la declara ` +
              `\`${[...typesOf(column)].join('` / `')}\`. El runtime compone ` +
              '`CAST(col AS TEXT) LIKE \'%…%\'`: no falla, hace algo peor — buscar «2» casa también ' +
              'con 12, 20 y 22, y sobre una fecha casi todo casa con todo. Un número o una fecha se ' +
              'filtran con `op: \'range\'` (ADR-0125).',
          );
          continue;
        }

        // ── 3 · the ADR-0125 whitelist, `eq` direction only, where no screen paints the box ──
        if (drawn.length === 0 && op === 'eq' && FREE_TEXT.has(String(column).toLowerCase())) {
          report(
            query,
            column,
            `\`${query}\` filtra \`${column}\` —columna de texto libre— con \`op: 'eq'\`: exige el ` +
              'valor ENTERO, así que teclear «Ana» no encuentra «Ana García» y la lista vuelve ' +
              "vacía sin error. Declárala `op: 'like'` (ADR-0125).",
          );
        }
      }
    }
  }

  // ── 4 · every box a screen offers has to be a parameter the list ACCEPTS (module-toolkit#382) ─
  // The rules above walk `list.filters`, so a box over a column the manifest never declared was
  // never looked at. The SDK sends it anyway (`buildListParams` flattens every filter to `f_<col>`,
  // or `f_<col>_from`/`_to` for two bounds) and the kernel refuses what the list does not accept —
  // `422 unknown_filter` (hub#1182) — so the person types in the box and the list FAILS instead of
  // filtering. «Accepts» is the runtime's own `accepted_params` (hub/crates/runtime/src/queries.rs):
  // a declared filter, a bind of the base SQL, or a property of the query's schema.
  if (queries && typeof queries === 'object') {
    for (const [query, columns] of offered) {
      // Not declared (the contracts gate's finding), or not a paged list: not this rule's to judge.
      const spec = queries[query];
      const list = spec?.list;
      if (!list || typeof list !== 'object') continue;
      const filters = list.filters && typeof list.filters === 'object' ? list.filters : {};
      let extra = null; // binds + schema properties, read only when a box needs them
      for (const [column, boxes] of columns) {
        if (Object.hasOwn(filters, column)) continue; // declared: rules 1-3 judge its op
        extra ??= new Set([...sqlBinds(dir, spec.sql), ...schemaProperties(spec.schema)]);
        for (const box of boxes) {
          const refused = wireOf(column, box).filter((name) => !extra.has(name));
          if (refused.length === 0) continue;
          const renamed = box.column === column ? '' : ` (la pantalla lo manda como \`${column}\`)`;
          report(
            query,
            column,
            `${box.screen} ofrece un filtro sobre \`${box.column}\`${renamed} (\`filterable: true\`, caja ` +
              `\`${box.filterType}\`), pero \`${query}\` no lo admite: no está en \`list.filters\` y la ` +
              `lista no acepta ${refused.map((n) => `\`${n}\``).join(' ni ')}. En el hub la persona ` +
              'teclea en esa caja y la lista, en vez de filtrar, falla con `422 unknown_filter`. O ' +
              `declara \`list.filters.${column}\` con el \`op\` de su caja (ADR-0125), o quita ` +
              '`filterable` de la columna (module-toolkit#382).',
          );
          break;
        }
      }
    }
  }

  // ── the ratchet ───────────────────────────────────────────────────────────────────────────
  const owed = FILTER_OPS_GRANDFATHERED.filter(([id]) => id === moduleId);
  const excused = new Set(owed.map(([, query, column]) => `${query}|${column}`));

  for (const [key, message] of found) {
    if (excused.has(key)) {
      warnings.push(
        `[filter-ops] ${message} — ABUELADO en module-toolkit#183 mientras se arregla (ERPlora/pm#244).`,
      );
    } else {
      errors.push(message);
    }
  }

  // Every query name the manifest carries, `list.filters` or not: it is what tells a line that no
  // longer covers anything (the module was FIXED, and the line has to go) apart from a manifest
  // that simply is not the one the line is about. Reusing a published id — `tasks`, `invoice`,
  // `cart_checkout`… — is enough to inherit its excuses, and a ratchet that blocks on ABSENCE puts
  // red a module over screens and columns it does not have, with nothing it can touch to fix it
  // (module-toolkit#189). Same split the sister rule `dead-filters` makes (module-toolkit#178).
  const declared = new Set(queries && typeof queries === 'object' ? Object.keys(queries) : []);

  for (const [, query, column] of owed) {
    if (found.has(`${query}|${column}`)) continue;
    const stale =
      `\`${query}\` → \`${column}\` ya NO incumple ADR-0125, pero sigue en la lista de abuelados de ` +
      '`module-toolkit/src/validate-filter-ops.mjs` (`FILTER_OPS_GRANDFATHERED`): una línea que no ' +
      'cubre nada es un permiso permanente para volver a romperlo en verde. Bórrala — esa PR de una ' +
      'línea va DELANTE del arreglo del módulo.';
    // The module that DECLARES the query is the one that can have fixed it: there the line really
    // is spare and it BLOCKS, which is what fixes the order of the two pull requests. A manifest
    // that does not even declare it (a fixture, or a query retired whole) is not the one the line
    // talks about: it is warned, never blocked for somebody else's excuse.
    if (declared.has(query)) errors.push(stale);
    else warnings.push(`[filter-ops] ${stale}`);
  }

  return { errors, warnings };
}
