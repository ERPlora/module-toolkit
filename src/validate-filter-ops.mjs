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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
  // cash_register — 2
  ['cash_register', 'cash_register.sessions.list', 'session_number'],
  ['cash_register', 'cash_register.sessions.list', 'difference'],
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
  // verifactu — 11
  ['verifactu', 'verifactu.records.list', 'sequence_number'],
  ['verifactu', 'verifactu.records.list', 'invoice_number'],
  ['verifactu', 'verifactu.records.list', 'invoice_type'],
  ['verifactu', 'verifactu.contingency.list', 'record_id'],
  ['verifactu', 'verifactu.contingency.list', 'priority'],
  ['verifactu', 'verifactu.contingency.list', 'attempts'],
  ['verifactu', 'verifactu.contingency.list', 'last_error'],
  ['verifactu', 'verifactu.contingency.list', 'status'],
  ['verifactu', 'verifactu.events.list', 'event_type'],
  ['verifactu', 'verifactu.aeat.records.list', 'invoice_number'],
  ['verifactu', 'verifactu.aeat.records.list', 'estado'],
  // whatsapp_inbox — 4
  ['whatsapp_inbox', 'whatsapp_inbox.conversations.list', 'contact_name'],
  ['whatsapp_inbox', 'whatsapp_inbox.requests.list', 'reference_number'],
  ['whatsapp_inbox', 'whatsapp_inbox.requests.list', 'contact_name'],
  ['whatsapp_inbox', 'whatsapp_inbox.templates.list', 'language'],
];

/**
 * Every list screen a component source declares, as `{ query, columns }`.
 *
 * `createListController(erplora(), '<query>', …)` is the one way a screen binds itself to a
 * paginated list, so a table written tomorrow cannot be born outside this gate without anybody
 * remembering to register it.
 *
 * A file that drives MORE THAN ONE list is returned with its columns attached to each — the caller
 * drops those, because the column list of such a file cannot be attributed to one query without
 * guessing, and a guess here rejects correct code.
 */
export function listScreens(source) {
  const queries = [...source.matchAll(/createListController[^(]*\(\s*erplora\(\)\s*,\s*'([^']+)'/g)].map(
    (m) => m[1],
  );
  if (queries.length === 0) return [];

  const columns = [];
  for (const chunk of source.split("key: '").slice(1)) {
    const key = chunk.split("'")[0];
    const kind = /filterType: '(\w+)'/.exec(chunk);
    columns.push({ key, filterType: kind ? kind[1] : null });
  }
  return queries.map((query) => ({ query, columns }));
}

/** The body between the outermost parentheses starting at `from`, or null when unbalanced. */
function parenBody(text, from) {
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
function topLevelParts(body) {
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
 * `query -> column -> { filterType, screen }` for every box the module's own screens paint.
 *
 * A column two screens paint DIFFERENTLY is dropped: without a way to tell which one the user is
 * looking at, judging it would reject one of two correct screens.
 */
function paintedBoxes(dir) {
  const painted = new Map();
  const ambiguous = new Set();

  for (const abs of sourceFiles(join(dir, 'ui'))) {
    let screens;
    try {
      screens = listScreens(readFileSync(abs, 'utf8'));
    } catch {
      continue; // an unreadable UI file is another gate's problem, not a filter verdict
    }
    if (screens.length !== 1) continue; // see `listScreens`: cannot attribute columns to a query
    const [{ query, columns }] = screens;
    const file = relative(dir, abs).split(sep).join('/');
    if (!painted.has(query)) painted.set(query, new Map());
    const forQuery = painted.get(query);
    for (const { key, filterType } of columns) {
      if (filterType == null) continue;
      const seen = forQuery.get(key);
      if (seen && seen.filterType !== filterType) {
        ambiguous.add(`${query}|${key}`);
        continue;
      }
      forQuery.set(key, { filterType, screen: file });
    }
  }

  for (const id of ambiguous) {
    const [query, key] = id.split('|');
    painted.get(query)?.delete(key);
  }
  return painted;
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
  const painted = paintedBoxes(dir);
  const types = moduleColumnTypes(dir, manifest);

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
        const box = boxes.get(column);
        const textual = isText(column);

        // ── 1 · the box has to mean what it looks like ──────────────────────────────────────
        if (box) {
          const expected = EXPECTED_OP[box.filterType];
          if (expected === undefined) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como \`filterType: '${box.filterType}'\`, que esta ` +
                'puerta no conoce: enséñasela (o usa `text`/`select`/`range`/`daterange`).',
            );
            continue;
          }
          if (expected === 'like' && textual === false) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como caja de texto, pero la columna es ` +
                `\`${[...typesOf(column)].join('` / `')}\` — no es texto. El runtime compara ` +
                '`CAST(col AS TEXT) LIKE \'%…%\'`, así que con `like` teclear «2» devolvería también ' +
                '12, 20 y 22, y con `eq` hay que teclear el número entero. Píntala ' +
                "`filterType: 'range'` y declara `op: 'range'` (ADR-0125).",
            );
            continue;
          }
          if (op !== expected) {
            report(
              query,
              column,
              `${box.screen} pinta \`${column}\` como \`filterType: '${box.filterType}'\` pero ` +
                `\`${query}\` lo filtra con \`op: ${JSON.stringify(op)}\` — ${WHY[box.filterType]}. ` +
                `Que coincidan: o \`op: '${expected}'\` en el manifest, o la caja que corresponda al ` +
                'dato (un dominio cerrado se pinta `select` y se queda en `op: \'eq\'`) (ADR-0125).',
            );
            continue;
          }
        }

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
        if (!box && op === 'eq' && FREE_TEXT.has(String(column).toLowerCase())) {
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

  for (const [, query, column] of owed) {
    if (found.has(`${query}|${column}`)) continue;
    errors.push(
      `\`${query}\` → \`${column}\` ya NO incumple ADR-0125, pero sigue en la lista de abuelados de ` +
        '`module-toolkit/src/validate-filter-ops.mjs` (`FILTER_OPS_GRANDFATHERED`): una línea que no ' +
        'cubre nada es un permiso permanente para volver a romperlo en verde. Bórrala — esa PR de una ' +
        'línea va DELANTE del arreglo del módulo.',
    );
  }

  return { errors, warnings };
}
