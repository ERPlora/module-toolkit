// `fill` on an Ionic form control only paints in `md` — checked at the module author's door.
//
// Ionic decides it in one line (`@ionic/core/dist/collection/components/input/input.js`):
//
//     const hasOutlineFill = mode === 'md' && this.fill === 'outline';
//
// and `input.ios.css` ships no `input-fill-*` rule at all. The Hub shell pins `mode: 'ios'`
// (ADR-0143, `hub/apps/web/src/main.ts`), so a `fill` on an `ion-input` / `ion-select` /
// `ion-textarea` is a SILENT no-op: the control renders with no box, no border and no surface, and
// the user cannot see where to type. Nothing throws, nothing warns — which is why it needs
// something that looks at it on your behalf.
//
// The Hub caught it on its own screens (hub#760, `apps/web/src/theme/ionic-fill-needs-md.test.ts`)
// and the Cloud Portal carries the twin (saas#1080). Neither reads the MODULES, and that is where
// most of the forms a merchant fills in live — 25 repos of Lit Web Components, 322 controls with a
// `fill`, zero with `mode="md"`.
//
// 🔴 A PORT, NOT A COPY. The Hub's scanner reads `.vue`, where a tag ends at the first `>`. In a
// Lit template it does not: `@ionChange=${(e: any) => this.patch({ id: e.target.value })}` puts
// both `>` and `{}` inside the tag. Cutting at the first `>` would read every attribute after an
// arrow function as absent — `mode="md"` included — and report a control that is perfectly fine.
// A false positive here turns a correct module's gate red, which is worse than the bug it chases.
//
// Mirror alarm: the premise (Ionic paints `fill` only in md; the Hub pins `ios`) is asserted in
// `test/validate-ionic-fill.test.mjs` and `test/canonical-mirrors.test.mjs`. The day either stops
// being true, those fail and say to DELETE this file instead of letting it outlive its cause.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** The three controls where `fill` is mode-dependent. `ion-button` styles it in both modes. */
export const FILL_CONTROLS = ['input', 'select', 'textarea'];

const CONTROL_START = new RegExp(`<ion-(?:${FILL_CONTROLS.join('|')})(?=[\\s/>])`, 'g');

/** `fill="outline"`, `fill='solid'`, `fill=${…}` — any of them is dead outside `md`. */
const DECLARES_FILL = /(?:^|[\s({[])fill=/;

/** The one thing that makes `fill` real, written the three ways a Lit template writes it. */
const DECLARES_MD = /\bmode=(?:"md"|'md'|\$\{\s*['"`]md['"`]\s*\})/;

/** Directories that are build output or somebody else's code: never source to fix. */
const NOT_SOURCE = new Set(['dist', 'node_modules', '.git', 'coverage']);

/**
 * What is ALREADY published and would not meet this contract, as `[moduleId, file, count]`.
 *
 * 🔴 WHY A RATCHET AND NOT A BIG BANG. Turning this into an error outright puts all 25 module repos
 * in red the same day, for a reason unrelated to whatever each was publishing — and a gate that
 * blocks everything gets switched off, not obeyed. So the pass is per FILE **and per COUNT**: the
 * controls a file has today are tolerated, one more is not. A brand-new component inherits nothing.
 *
 * 🔴 This list may only SHRINK, and a test fails the moment it grows. It is emptied by the sweep
 * (ERPlora/pm#152), module by module — not by adding a line here. What comes out is never a count
 * edited down to fit: it is a module whose `ui/` declares `mode="md"` on every control, so the entry
 * stops covering anything. Trimming a number to match a half-done fix grandfathers the broken half.
 *
 * WHERE THE SWEEP IS — 170 dead controls left, in 27 files across 14 modules. It started at 275 in
 * 45 files across 22 the day the check landed.
 *
 *   done, and out of the list  customers · inventory · kitchen · pricing · printing · staff ·
 *                              tasks · whatsapp_inbox   (105 controls, 18 files)
 *   still owing, worst first   taxes 18 · invoice 16 · online_booking 16 · reservations 16 ·
 *                              services 16 · tables 15 · cash_register 14 · schedules 14 ·
 *                              tickets 14 · appointments 9 · payment_gateways 8 ·
 *                              invoice_series 6 · payments 5 · cart_checkout 3
 *
 * `sales`, `verifactu` and `flows` were never here: their `fill` sits on `ion-button`, where it paints.
 */
export const FILL_GRANDFATHERED = [
  // Measured on 2026-08-20 over `origin/main` of the 25 module repos — what is PUBLISHED, not what
  // happens to be in a checkout other workers are editing.
  ['appointments', 'ui/components/erp-appointments-list/erp-appointments-list.ts', 9],
  ['cart_checkout', 'ui/components/erp-cart-checkout-carts/erp-cart-checkout-carts.ts', 3],
  ['cash_register', 'ui/components/erp-cashregister-dashboard/erp-cashregister-dashboard.ts', 11],
  ['cash_register', 'ui/components/erp-cashregister-open/erp-cashregister-open.ts', 3],
  ['invoice', 'ui/components/erp-invoice-list/erp-invoice-list.ts', 10],
  ['invoice', 'ui/components/erp-invoice-settings/erp-invoice-settings.ts', 6],
  ['invoice_series', 'ui/components/erp-invoice-series-list/erp-invoice-series-list.ts', 6],
  ['online_booking', 'ui/components/erp-online-booking-list/erp-online-booking-list.ts', 6],
  ['online_booking', 'ui/components/erp-online-booking-settings/erp-online-booking-settings.ts', 10],
  ['payment_gateways', 'ui/components/erp-payment-gateways-gateways/erp-payment-gateways-gateways.ts', 3],
  ['payment_gateways', 'ui/components/erp-payment-gateways-transactions/erp-payment-gateways-transactions.ts', 5],
  ['payments', 'ui/components/erp-payments-list/erp-payments-list.ts', 5],
  ['reservations', 'ui/components/erp-reservations-availability/erp-reservations-availability.ts', 6],
  ['reservations', 'ui/components/erp-reservations-list/erp-reservations-list.ts', 5],
  ['reservations', 'ui/components/erp-reservations-waitlist/erp-reservations-waitlist.ts', 5],
  ['schedules', 'ui/components/erp-schedules-hours/erp-schedules-hours.ts', 14],
  ['services', 'ui/components/erp-services-categories/erp-services-categories.ts', 3],
  ['services', 'ui/components/erp-services-list/erp-services-list.ts', 5],
  ['services', 'ui/components/erp-services-packages/erp-services-packages.ts', 8],
  ['tables', 'ui/components/erp-tables-canvas/erp-tables-canvas.ts', 9],
  ['tables', 'ui/components/erp-tables-floor-plan/erp-tables-floor-plan.ts', 3],
  ['tables', 'ui/components/erp-tables-zones/erp-tables-zones.ts', 3],
  ['taxes', 'ui/components/erp-taxes-aliases/erp-taxes-aliases.ts', 3],
  ['taxes', 'ui/components/erp-taxes-categories/erp-taxes-categories.ts', 3],
  ['taxes', 'ui/components/erp-taxes-rules/erp-taxes-rules.ts', 12],
  ['tickets', 'ui/components/erp-tickets-list/erp-tickets-list.ts', 10],
  ['tickets', 'ui/components/erp-tickets-sla/erp-tickets-sla.ts', 4],
];

/** How many dead controls `file` of `moduleId` is allowed to keep. 0 = none. */
function allowanceFor(moduleId, file) {
  const entry = FILL_GRANDFATHERED.find(([m, f]) => m === moduleId && f === file);
  return entry ? entry[2] : 0;
}

/**
 * Reads ONE opening tag from `source`, starting at `from` (the `<`), and returns the index just
 * past its closing `>`.
 *
 * Everything this function exists for is knowing which `>` is the real one. Inside a Lit tag there
 * are three places a `>` can hide and mean nothing: an attribute string (`placeholder="a > b"`), a
 * `${…}` expression (`(e) => …`, a generic, a comparison) and a nested template inside that
 * expression. Braces are counted so an object literal or an arrow body does not close the
 * expression early.
 *
 * Returns `-1` when the tag never closes — a runaway on markup this does not understand. Reporting
 * nothing is the right way to be wrong: a missed control ships a bug, a false one blocks a module.
 */
function endOfTag(source, from) {
  let depth = 0; // `${ … }` / `{ … }` nesting
  let quote = null; // ", ' or ` while inside a literal
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      depth += 1;
      i += 1;
      continue;
    }
    if (depth > 0 && ch === '{') {
      depth += 1;
      continue;
    }
    if (depth > 0 && ch === '}') {
      depth -= 1;
      continue;
    }
    if (depth === 0 && ch === '>') return i + 1;
  }
  return -1;
}

/**
 * Every `ion-input` / `ion-select` / `ion-textarea` opening tag in `source`, as
 * `{ tag, index, line }`. `line` is 1-based and points at where the control OPENS, which is the
 * line the author has to go to even when the tag spans four.
 */
export function controlTags(source) {
  const found = [];
  for (const m of source.matchAll(CONTROL_START)) {
    const end = endOfTag(source, m.index);
    if (end === -1) continue;
    found.push({
      tag: source.slice(m.index, end),
      index: m.index,
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return found;
}

/** The controls of `source` whose `fill` will never paint: it is declared and `mode="md"` is not. */
export function controlsWithDeadFill(source) {
  const dead = [];
  for (const control of controlTags(source)) {
    if (!DECLARES_FILL.test(control.tag)) continue;
    if (DECLARES_MD.test(control.tag)) continue;
    dead.push({ ...control, tag: control.tag.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return dead;
}

/** Every `.ts`/`.js` under `dir`, skipping build output and vendored code. */
function sourceFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (NOT_SOURCE.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * The whole door: every control of the module's `ui/` that declares a `fill` the Hub will not
 * paint. Returns `{ errors, warnings }`; a module with no `ui/` (purely declarative) says nothing.
 */
export function checkIonicFill(dir, manifest) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };

  for (const abs of sourceFiles(join(dir, 'ui'))) {
    const file = relative(dir, abs).split(sep).join('/');
    let dead;
    try {
      dead = controlsWithDeadFill(readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push(`${file}: no se pudo leer (${e.message})`);
      continue;
    }
    if (!dead.length) continue;

    const allowed = allowanceFor(moduleId, file);
    if (dead.length <= allowed) continue;

    const shown = dead.slice(allowed).map((d) => `L${d.line}: ${d.tag}`);
    errors.push(
      `${file}: ${dead.length} control(es) declaran \`fill\` sin \`mode="md"\`` +
        (allowed ? ` (${allowed} venían de antes y se toleran; sobran ${dead.length - allowed})` : '') +
        '. El shell del hub fija `mode: \'ios\'` (ADR-0143) y ahí Ionic NO pinta el `fill`: ' +
        'el campo sale sin caja, sin borde y sin fondo, y el usuario no ve dónde escribir. ' +
        `Añade \`mode="md"\` a cada uno:\n      ${shown.join('\n      ')}`,
    );
  }
  return { errors, warnings };
}
