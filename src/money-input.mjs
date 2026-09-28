// The money a person TYPES into a field, read once for every module (ERPlora/combos#9).
//
// The SDK owns two money borders — `majorToMinor`/`minorToMajor` and `formatMoney` (ADR-0007/0123,
// hub#1090). The third one, what a human types, each module wrote for itself, and most wrote
// `.replace(',', '.')`: `1.250,50` — verbatim what `formatMoney` prints next to the field — became
// `1.250.50`, `Number` said NaN, `majorToMinor` said 0, and the price was saved FREE, in silence.
//
// This is combos#7's reading (decided from the market: 12+ references and their forums, combos#3),
// with the two things other modules had already got right folded in: a currency with no decimals
// has nothing to be ambiguous about (sales#377, inventory#101), and the arithmetic is on the typed
// DIGITS, HALF_UP, never on a float (`1.005 * 100` is 100.49999… in IEEE-754 — sales, ADR-0123).
//
// Dependency-free on purpose: a module's UI bundles it (`erplora build` resolves it from the
// toolkit that builds, `resolve-plugin.mjs`), and its tests import it through the same link the
// gate already makes for `money-display-guard`.

/** Characters that only ever GROUP digits: spaces (NBSP, NNBSP and thin space are `\s` too) and the
 *  apostrophes Swiss German groups with. They are never a decimal separator. */
const SPACING = "\\s'\\u2019\\u02bc";
/** Any character that can sit between two digit groups. */
const GROUP_SEP = new RegExp(`[.,${SPACING}]`);
const MINUS = /[-\u2212]/;
const SIGN = /[-+\u2212]/;
const SIGNS = /[-+\u2212]/g;
/** Accounting brackets: a spreadsheet's negative. Cleaned away like a symbol, they flip the sign. */
const BRACKET = /[()]/;

const NOT_AN_AMOUNT = Object.freeze({ ok: false, code: 'not_an_amount' });

function checkDecimals(decimals) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) {
    throw new RangeError(`money_input_decimals_invalid: ${String(decimals)}`);
  }
}

/** The integer part split by its grouping characters is a real grouping: 1–3 digits first (not
 *  starting with 0), 2–3 digits in the middle (the Indian lakh), exactly 3 last. */
function isGrouping(intPart) {
  const groups = intPart.split(GROUP_SEP);
  if (groups.length < 2) return false;
  const [first, ...rest] = groups;
  const last = rest.pop();
  return /^[1-9]\d{0,2}$/.test(first) && rest.every((g) => /^\d{2,3}$/.test(g)) && /^\d{3}$/.test(last);
}

/** HALF_UP on the typed digits: `intDigits.fracDigits` in the major unit → minor units, or null
 *  when the result is beyond what a number holds exactly. */
function digitsToMinor(intDigits, fracDigits, decimals) {
  const padded = fracDigits.padEnd(decimals + 1, '0');
  const kept = (intDigits || '0') + padded.slice(0, decimals);
  let minor = Number(kept);
  if (Number(padded[decimals]) >= 5) minor += 1;
  return Number.isSafeInteger(minor) ? minor : null;
}

function signed(minor, negative) {
  return negative && minor !== 0 ? -minor : minor;
}

/**
 * Split a separator-bearing core into integer and fraction, or say why it cannot be.
 * @returns {{ intPart: string, frac: string } | { ambiguous: { intPart: string, tail: string } } | null}
 */
function splitCore(core, decimals) {
  const dots = (core.match(/\./g) ?? []).length;
  const commas = (core.match(/,/g) ?? []).length;
  if (dots && commas) {
    // Two different separators → the LAST one is the decimal and may appear only once.
    const dec = core.lastIndexOf('.') > core.lastIndexOf(',') ? '.' : ',';
    if ((dec === '.' ? dots : commas) !== 1) return null;
    const at = core.lastIndexOf(dec);
    return { intPart: core.slice(0, at), frac: core.slice(at + 1) };
  }
  // None, or the same one repeated (`1.250.000`): it can only be grouping.
  if (dots + commas !== 1) return { intPart: core, frac: '' };
  const at = Math.max(core.lastIndexOf('.'), core.lastIndexOf(','));
  const intPart = core.slice(0, at);
  const tail = core.slice(at + 1);
  if (tail.length === 3 && isGrouping(core)) {
    // `1.250`: 1250 to whoever grouped it, 1,25 to whoever meant a decimal — ×1000 either way.
    if (decimals === 0) return { intPart: core, frac: '' }; // no decimals: only grouping is possible
    if (decimals !== 3) return { ambiguous: { intPart, tail } };
  }
  return { intPart, frac: tail };
}

/** Digits of the integer part once its grouping is checked, or null when it is not a grouping. */
function intDigits(intPart) {
  if (!GROUP_SEP.test(intPart)) return /^\d*$/.test(intPart) ? intPart : null;
  return isGrouping(intPart) ? intPart.replace(/\D/g, '') : null;
}

/**
 * What a person typed (or pasted) into a money field → minor units of a currency with `decimals`.
 *
 * - `{ ok: true, minor: null }` — nothing was typed (empty is not the same as free);
 * - `{ ok: true, minor }` — the amount, signed;
 * - `{ ok: false, code: 'not_an_amount' }` — garbage; the screen says so, it never becomes 0;
 * - `{ ok: false, code: 'ambiguous_amount', readings: { grouped, decimal } }` — a lone separator
 *   followed by exactly three digits in a currency without three decimals (`1.250`), with the two
 *   readings in minor units so the message can show both.
 *
 * Both separators are read, always; symbols, currency codes, spaces, NBSP/NNBSP/thin space and
 * apostrophes are cleaned away; the sign is ONE `-`, `−` or `+` before the first digit — two signs, a
 * sign after the digits or accounting brackets `(12)` are refused, not guessed.
 *
 * @param {unknown} typed
 * @param {number} decimals the currency's scale (`erplora().currencyDecimals`), 0–4
 */
export function parseMoneyInput(typed, decimals) {
  checkDecimals(decimals);
  if (typeof typed === 'number') return parseNumber(typed, decimals);
  const raw = String(typed ?? '').trim();
  if (!raw) return { ok: true, minor: null };

  const firstDigit = raw.search(/\d/);
  if (firstDigit < 0) return NOT_AN_AMOUNT;
  // `,5` / `.5`: a separator right before the first digit belongs to the amount.
  const start = firstDigit > 0 && /[.,]/.test(raw[firstDigit - 1]) ? firstDigit - 1 : firstDigit;
  const end = raw.search(/\d\D*$/) + 1;
  const prefix = raw.slice(0, start);
  const suffix = raw.slice(end);
  const core = raw.slice(start, end);

  const signs = prefix.match(SIGNS) ?? [];
  if (signs.length > 1 || SIGN.test(suffix) || BRACKET.test(prefix + suffix)) return NOT_AN_AMOUNT;
  const negative = signs.length === 1 && MINUS.test(signs[0]);

  const split = splitCore(core, decimals);
  if (!split) return NOT_AN_AMOUNT;
  if ('ambiguous' in split) {
    const { intPart, tail } = split.ambiguous;
    // `intPart` may still hold space groups (`1 250,500`), and with them any number of digits.
    const digits = intPart.replace(/\D/g, '');
    const grouped = digitsToMinor(digits + tail, '', decimals);
    const decimal = digitsToMinor(digits, tail, decimals);
    if (grouped === null || decimal === null) return NOT_AN_AMOUNT;
    return {
      ok: false,
      code: 'ambiguous_amount',
      readings: { grouped: signed(grouped, negative), decimal: signed(decimal, negative) },
    };
  }
  const whole = intDigits(split.intPart);
  if (whole === null || (split.frac && !/^\d+$/.test(split.frac))) return NOT_AN_AMOUNT;
  const minor = digitsToMinor(whole, split.frac, decimals);
  return minor === null ? NOT_AN_AMOUNT : { ok: true, minor: signed(minor, negative) };
}

/** A value already in the major unit: its `.` is a decimal point, never an ambiguous one. */
function parseNumber(n, decimals) {
  // NaN, Infinity and exponent notation (far beyond any amount) do not match.
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(Math.abs(n)));
  if (!m) return NOT_AN_AMOUNT;
  const minor = digitsToMinor(m[1], m[2] ?? '', decimals);
  return minor === null ? NOT_AN_AMOUNT : { ok: true, minor: signed(minor, n < 0) };
}

/**
 * Minor units → what the field shows for editing: the hub's locale, the currency's decimals, and
 * NO grouping — `1.250,50` inside an editable field is the ×10 Business Central had to fix for
 * Spain and the field Odoo blanked (odoo#19357); grouping belongs on read-only surfaces (hub#1090).
 * Latin digits always, so the field reads back through `parseMoneyInput`. Nothing stored → `''`.
 *
 * @param {number | null | undefined} minor
 * @param {number} decimals
 * @param {string} [locale] the hub locale (`erplora().locale`); empty → `en`
 */
export function formatMoneyInput(minor, decimals, locale) {
  checkDecimals(decimals);
  if (minor == null) return '';
  return new Intl.NumberFormat(locale || 'en', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
    numberingSystem: 'latn',
  }).format(minor / 10 ** decimals);
}

/**
 * What the field shows once the person leaves it: rewritten in the hub's format when it can be
 * read, EXACTLY as typed when it cannot — rewriting garbage throws away what they wrote, and
 * rewriting an ambiguous amount picks one of its two readings, the guess this piece refuses.
 *
 * @param {string} typed
 * @param {number} decimals
 * @param {string} [locale]
 */
export function normaliseMoneyInput(typed, decimals, locale) {
  const parsed = parseMoneyInput(typed, decimals);
  return parsed.ok && parsed.minor !== null ? formatMoneyInput(parsed.minor, decimals, locale) : typed;
}
