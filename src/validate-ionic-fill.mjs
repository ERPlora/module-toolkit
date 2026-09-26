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
 * 🔴 AND AN ENTRY MAY NOT OUTLIVE ITS MODULE. A line that covers a file with nothing left to cover
 * is not harmless bookkeeping: it is a standing permit to bring the dead controls back, in green.
 * It happened — `tickets` finished on 2026-08-22 and its two lines sat here for two days, so the
 * list tolerated 170 controls while reality was 156. `checkIonicFill` now FAILS the module's own
 * gate on a stale entry, which fixes the order of a sweep: the two-line pull request that deletes
 * the entry goes FIRST, and the module's fix merges behind it.
 *
 * It fails the module that SHIPS components — the only one that can have deleted or renamed the
 * file. A manifest with no `ui/` at all is not the module the line talks about (a fixture, or a
 * third party who reused a published id): it is WARNED, never blocked for somebody else's
 * allowance (module-toolkit#189; `test/validate-grandfathered-scope.test.mjs` holds that line for
 * every grandfathered list in `src/`).
 *
 * WHERE THE SWEEP IS — 101 dead controls left, in 17 files across 10 modules. It started at 275 in
 * 45 files across 22 the day the check landed.
 *
 *   done, and out of the list  appointments · cash_register · customers · inventory · kitchen ·
 *                              pricing · printing · staff · tables · tasks · tickets · whatsapp_inbox
 *                              (157 controls, 26 files; plus taxes' rules screen, 12 controls)
 *   still owing, worst first   invoice 16 · online_booking 16 · services 16 · schedules 14 ·
 *                              reservations 11 · payment_gateways 8 · taxes 6 · invoice_series 6 ·
 *                              payments 5 · cart_checkout 3
 *
 * ⚠️ Four of those modules are RETIRED and nobody is going to pay their debt: `invoice_series`
 * (ADR-0369) and `cart_checkout` / `payments` / `online_booking` (saas migration 0058) — 30 of the
 * 101. Their entries stay while their `ui/` still ships the dead controls, because the rule above is
 * measured, not declared; they leave with the repos when those are archived.
 *
 * `sales`, `verifactu` and `flows` were never here: their `fill` sits on `ion-button`, where it paints.
 */
export const FILL_GRANDFATHERED = [
  // Measured on 2026-08-20 over `origin/main` of the 25 module repos — what is PUBLISHED, not what
  // happens to be in a checkout other workers are editing.
  ['cart_checkout', 'ui/components/erp-cart-checkout-carts/erp-cart-checkout-carts.ts', 3],
  ['invoice', 'ui/components/erp-invoice-list/erp-invoice-list.ts', 10],
  ['invoice', 'ui/components/erp-invoice-settings/erp-invoice-settings.ts', 6],
  ['invoice_series', 'ui/components/erp-invoice-series-list/erp-invoice-series-list.ts', 6],
  ['online_booking', 'ui/components/erp-online-booking-list/erp-online-booking-list.ts', 6],
  ['online_booking', 'ui/components/erp-online-booking-settings/erp-online-booking-settings.ts', 10],
  ['payment_gateways', 'ui/components/erp-payment-gateways-gateways/erp-payment-gateways-gateways.ts', 3],
  ['payment_gateways', 'ui/components/erp-payment-gateways-transactions/erp-payment-gateways-transactions.ts', 5],
  ['payments', 'ui/components/erp-payments-list/erp-payments-list.ts', 5],
  ['reservations', 'ui/components/erp-reservations-availability/erp-reservations-availability.ts', 6],
  ['reservations', 'ui/components/erp-reservations-waitlist/erp-reservations-waitlist.ts', 5],
  ['schedules', 'ui/components/erp-schedules-hours/erp-schedules-hours.ts', 14],
  ['services', 'ui/components/erp-services-categories/erp-services-categories.ts', 3],
  ['services', 'ui/components/erp-services-list/erp-services-list.ts', 5],
  ['services', 'ui/components/erp-services-packages/erp-services-packages.ts', 8],
  ['taxes', 'ui/components/erp-taxes-aliases/erp-taxes-aliases.ts', 3],
  ['taxes', 'ui/components/erp-taxes-categories/erp-taxes-categories.ts', 3],
];

/** How many offending controls `file` of `moduleId` is allowed to keep in `list`. 0 = none. */
function allowanceFor(list, moduleId, file) {
  const entry = list.find(([m, f]) => m === moduleId && f === file);
  return entry ? entry[2] : 0;
}

/** The entries of `list` this module is carrying, as `[file, count]`. Empty for a module never listed. */
function grandfatheredFor(list, moduleId) {
  return list.filter(([m]) => m === moduleId).map(([, file, count]) => [file, count]);
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
export function endOfTag(source, from) {
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
 * The ratchet both doors of this file share: what a file ships TODAY is compared with what `list`
 * tolerates for it, per FILE and per COUNT, and an entry may not outlive its file.
 *
 * `scan(source)` returns the offending controls of one file; `say` words the four outcomes —
 * `over(file, found, allowed)`, `gone(file, allowed)`, `clean(file, allowed)` and
 * `looser(file, today, allowed)`. `skip(file)` leaves a file out entirely. Returns `{ errors,
 * warnings }`; a module with no `ui/` (purely declarative) says nothing about its own code.
 */
function ratchet(dir, manifest, { scan, list, say, skip = () => false }) {
  const errors = [];
  const warnings = [];
  const moduleId = manifest?.id;
  if (!moduleId) return { errors, warnings };

  /** file → how many offending controls it has TODAY, for every file read. Feeds the staleness check. */
  const perFile = new Map();

  for (const abs of sourceFiles(join(dir, 'ui'))) {
    const file = relative(dir, abs).split(sep).join('/');
    if (skip(file)) continue;
    let found;
    try {
      found = scan(readFileSync(abs, 'utf8'));
    } catch (e) {
      errors.push(`${file}: no se pudo leer (${e.message})`);
      continue;
    }
    perFile.set(file, found.length);
    if (!found.length) continue;

    const allowed = allowanceFor(list, moduleId, file);
    if (found.length <= allowed) continue;
    errors.push(say.over(file, found, allowed));
  }

  // The OTHER half of the ratchet: an allowance may not outlive the file it was written for.
  //
  // 🔴 Measured, not imagined. `tickets` finished its sweep on 2026-08-22 and its two lines stayed
  // in the list for two days (ERPlora/pm#152): the list tolerated 170 controls while reality was
  // 156. In that window `tickets` could have brought all 14 dead controls back and this gate would
  // have said nothing — grandfathering had turned into a standing permit. Everything above asks
  // «is the module worse than the list?»; this asks the question nobody was asking, «is the list
  // looser than the module?».
  //
  // Whether this manifest is the module the lines are about AT ALL. Reusing a published id —
  // `taxes`, `appointments`, `services`… — is enough to inherit its allowances, and a ratchet that
  // blocks on ABSENCE puts red a manifest over components it never had, naming files it cannot
  // delete (module-toolkit#189, same split as `FILTER_OPS_GRANDFATHERED` and
  // `DEAD_FILTERS_GRANDFATHERED`). A module that DOES ship components is the one that can have
  // renamed or deleted the file, so there the stale line still BLOCKS — which is what pm#152 asked
  // for and what fixes the order of the two pull requests.
  const shipsComponents = perFile.size > 0;

  for (const [file, allowed] of grandfatheredFor(list, moduleId)) {
    const today = perFile.get(file);
    if (today === undefined) {
      if (shipsComponents) errors.push(say.gone(file, allowed));
      else warnings.push(say.gone(file, allowed));
      continue;
    }
    if (today === 0) {
      errors.push(say.clean(file, allowed));
      continue;
    }
    if (today < allowed) warnings.push(say.looser(file, today, allowed));
  }
  return { errors, warnings };
}

/** `L<line>: <tag>` for every control past the allowance — the ones the author has to go and fix. */
function listed(found, allowed) {
  return found
    .slice(allowed)
    .map((d) => `L${d.line}: ${d.tag}`)
    .join('\n      ');
}

/**
 * The whole door: every control of the module's `ui/` that declares a `fill` the Hub will not
 * paint. Returns `{ errors, warnings }`; a module with no `ui/` (purely declarative) says nothing.
 */
export function checkIonicFill(dir, manifest) {
  return ratchet(dir, manifest, {
    scan: controlsWithDeadFill,
    list: FILL_GRANDFATHERED,
    say: {
      over: (file, dead, allowed) =>
        `${file}: ${dead.length} control(es) declaran \`fill\` sin \`mode="md"\`` +
        (allowed ? ` (${allowed} venían de antes y se toleran; sobran ${dead.length - allowed})` : '') +
        '. El shell del hub fija `mode: \'ios\'` (ADR-0143) y ahí Ionic NO pinta el `fill`: ' +
        'el campo sale sin caja, sin borde y sin fondo, y el usuario no ve dónde escribir. ' +
        `Añade \`mode="md"\` a cada uno:\n      ${listed(dead, allowed)}`,
      gone: (file, allowed) =>
        `${file}: su entrada en \`FILL_GRANDFATHERED\` (${allowed} control(es) tolerados) apunta a un ` +
        'fichero que ya no está en `ui/` — se borró o se renombró. Una tolerancia sin fichero al ' +
        'que aplicar no protege nada y sobrevive a su motivo: bórrala de ' +
        '`module-toolkit/src/validate-ionic-fill.mjs` (ERPlora/pm#152).',
      clean: (file, allowed) =>
        `${file}: ya no tiene NINGÚN \`fill\` sin \`mode="md"\` — el barrido de este fichero está ` +
        `hecho — pero sigue con su entrada en \`FILL_GRANDFATHERED\` (${allowed} control(es) ` +
        'tolerados). Mientras esa línea siga ahí, el módulo puede reintroducir esos ' +
        `${allowed} control(es) muertos y el gate lo dejará pasar en verde. Bórrala de ` +
        '`module-toolkit/src/validate-ionic-fill.mjs` (ERPlora/pm#152) y vuelve a pasar el gate: ' +
        'ese PR va PRIMERO, y el del módulo detrás.',
      looser: (file, today, allowed) =>
        `${file}: quedan ${today} de los ${allowed} control(es) que tolera ` +
        '`FILL_GRANDFATHERED` — la lista va más floja que la realidad. No es un fallo (ir a ' +
        'menos es el objetivo), pero el número NO se recorta para que cuadre: se termina el ' +
        'fichero y entonces se borra la entrada entera (ERPlora/pm#152).',
    },
  });
}

// ── The control that asks for no box at all (ERPlora/pm#479) ─────────────────────────────────
//
// Everything above looks at controls that DECLARE a `fill`. The Hub shell repairs those on its
// own — it moves any control that declares one to `md` (hub#1060, `apps/web/src/lib/ionic-fill.ts`)
// — and this file asks for `mode="md"` so the module does not depend on that repair. A control that
// declares NO `fill` gets neither: it stays in the pinned `ios` mode, which draws no box, no border
// and no surface. That is how the rate and the operation class of a new tax rule shipped as a label
// floating on the page (ERPlora/taxes#73) while this gate said green — it never looked at them.
//
// The one place a bare control is right is a LIST ROW: inside an `<ion-item>` the row is the
// surface, and Ionic styles the control for it (the settings lists of `verifactu`). Those are left
// alone. Everything else gets the same recipe as the rest of the modules: `fill="outline" mode="md"`.

/** An `<ion-item>` opening tag (not `ion-item-divider`, `-group`, `-sliding`…) or its closing tag. */
const ITEM_EDGE = /<(\/?)ion-item(?=[\s/>])/g;

/**
 * What is ALREADY published with a bare form control outside a list row, as `[moduleId, file,
 * count]` — measured over `origin/main` of the module repos on 2026-09-26, with the same scanner
 * the gate runs.
 *
 * 🔴 Same contract as `FILL_GRANDFATHERED`: it may only SHRINK (a test fails the moment it grows),
 * the pass is per FILE and per COUNT so a new component inherits nothing, and an entry that no
 * longer covers anything FAILS the module's own gate until it is deleted — the two-line PR that
 * deletes it goes first and the module's fix merges behind it. A module with no `ui/` that reuses a
 * listed id is warned, never blocked (module-toolkit#189). Each module still owing has its own
 * issue (Sale de ERPlora/pm#479); a line leaves when that issue lands, never by editing a count down.
 */
export const MISSING_FILL_GRANDFATHERED = [
  // Measured on 2026-09-26 over `origin/main` of the 27 module repos. `taxes` is NOT here: its two
  // (the rate and the operation class of a new rule) are fixed by taxes#75, which merges first.
  ['appointments', 'ui/components/erp-appointments-list/erp-appointments-list.ts', 2], // appointments#221
  ['appointments', 'ui/components/erp-appointments-series/erp-appointments-series.ts', 4], // appointments#221
  ['printing', 'ui/components/erp-printing-settings/erp-printing-settings.ts', 4], // printing#50
  ['reservations', 'ui/components/erp-reservations-list/erp-reservations-list.ts', 6], // reservations#71
  ['sales', 'ui/components/erp-pos-touch/erp-pos-touch.ts', 5], // sales#414
  ['sales', 'ui/components/erp-sale-refund/erp-sale-refund.ts', 3], // sales#414
];

/**
 * A test file is not UI: `ui/test/testids.test.ts` of 16 modules quotes bare controls as fixtures of
 * its own guard, and none of it reaches a screen.
 */
const TEST_FILE = /\.(?:test|spec)\.(?:ts|js)$/;

/**
 * Whether the tag at `index` opens on a comment line (`//`, `/*`, ` * `). Seven modules name
 * `<ion-select>` in their doc comments; reporting prose would put them red for nothing. A template
 * line never starts with one of those, and commented-out markup renders nothing either.
 */
function onCommentLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return /^\s*(?:\/\/|\/\*|\*)/.test(source.slice(lineStart, index));
}

/**
 * Whether the tag at `index` sits inside an open `<ion-item>` of `source` — a list row. An edge on a
 * comment line is prose, not markup: counted, it would leave the rest of the file one row deep.
 */
function insideListRow(source, index) {
  let depth = 0;
  for (const m of source.slice(0, index).matchAll(ITEM_EDGE)) {
    if (onCommentLine(source, m.index)) continue;
    depth += m[1] ? -1 : 1;
  }
  return depth > 0;
}

/**
 * The controls of `source` that declare no `fill` and are not inside a list row — the ones that
 * render with no box in the Hub. Same `{ tag, index, line }` shape as `controlsWithDeadFill`.
 */
export function controlsWithoutFill(source) {
  const bare = [];
  for (const control of controlTags(source)) {
    if (DECLARES_FILL.test(control.tag)) continue;
    if (onCommentLine(source, control.index)) continue;
    if (insideListRow(source, control.index)) continue;
    bare.push({ ...control, tag: control.tag.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return bare;
}

/**
 * The door: every control of the module's `ui/` that asks for no box outside a list row. Returns
 * `{ errors, warnings }`; a module with no `ui/` (purely declarative) says nothing.
 */
export function checkIonicMissingFill(dir, manifest) {
  return ratchet(dir, manifest, {
    scan: controlsWithoutFill,
    list: MISSING_FILL_GRANDFATHERED,
    skip: (file) => TEST_FILE.test(file),
    say: {
      over: (file, bare, allowed) =>
        `${file}: ${bare.length} control(es) no declaran \`fill\` y no van dentro de un \`ion-item\`` +
        (allowed ? ` (${allowed} venían de antes y se toleran; sobran ${bare.length - allowed})` : '') +
        '. Sin `fill` el shell del hub los deja en `mode: \'ios\'` (ADR-0143), que no dibuja caja: ' +
        'el campo sale como texto suelto y el usuario no ve dónde escribir (ERPlora/pm#479). ' +
        `Pon \`fill="outline" mode="md"\` a cada uno:\n      ${listed(bare, allowed)}`,
      gone: (file, allowed) =>
        `${file}: su entrada en \`MISSING_FILL_GRANDFATHERED\` (${allowed} control(es) tolerados) ` +
        'apunta a un fichero que ya no está en `ui/` — se borró o se renombró. Bórrala de ' +
        '`module-toolkit/src/validate-ionic-fill.mjs` (ERPlora/pm#479).',
      clean: (file, allowed) =>
        `${file}: ya no tiene NINGÚN control sin \`fill\` fuera de una fila de lista, pero sigue con ` +
        `su entrada en \`MISSING_FILL_GRANDFATHERED\` (${allowed} control(es) tolerados): mientras ` +
        'siga ahí, el módulo puede volver a quitarles la caja y el gate lo dejará pasar en verde. ' +
        'Bórrala de `module-toolkit/src/validate-ionic-fill.mjs` (ERPlora/pm#479): ese PR va ' +
        'PRIMERO, y el del módulo detrás.',
      looser: (file, today, allowed) =>
        `${file}: quedan ${today} de los ${allowed} control(es) sin \`fill\` que tolera ` +
        '`MISSING_FILL_GRANDFATHERED`. No es un fallo, pero el número NO se recorta para que ' +
        'cuadre: se termina el fichero y entonces se borra la entrada entera (ERPlora/pm#479).',
    },
  });
}
