// The money a person TYPES, read the same way in every module (ERPlora/combos#9).
//
// Each module wrote its own half of this, and most wrote `.replace(',', '.')`: `1.250,50` — verbatim
// what the screen prints next to the field, because since hub#1090 money is ALWAYS grouped — became
// `1.250.50`, `Number` answered NaN, and the SDK's `majorToMinor` turned NaN into a silent 0 in an
// INTEGER column. The price was saved as FREE with no error. combos#7 fixed it for combos alone;
// these cases pin the rule ONCE, where every module gets it by importing the piece:
//
//   * both separators, always; two different ones → the LAST is the decimal (combos#7);
//   * the same one repeated → grouping, and a grouping that does not group in threes is refused;
//   * a lone separator + exactly three digits is refused as AMBIGUOUS (×1000 either way), except in
//     a currency with no decimals, where it can only be grouping (sales#377, inventory#101);
//   * garbage is an ERROR CODE the screen explains, never 0 — and never a number made of its digits;
//   * digits, not floats: `1.005` is HALF_UP 101 cents, not IEEE-754's 100 (sales, ADR-0123);
//   * whatever `formatMoney` prints (hub#1090) reads back to the same minor units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMoneyInput, formatMoneyInput, normaliseMoneyInput } from '../src/money-input.mjs';

const ok = (minor) => ({ ok: true, minor });

test('the five shapes of the brief read to the same money, or refuse in words (combos#9)', () => {
  assert.deepEqual(parseMoneyInput('1.250,50', 2), ok(125050), 'es, grouped — what the screen prints');
  assert.deepEqual(parseMoneyInput('1250,5', 2), ok(125050), 'es, ungrouped, one decimal');
  assert.deepEqual(parseMoneyInput('1,250.50', 2), ok(125050), 'en, grouped');
  assert.deepEqual(parseMoneyInput('12', 2), ok(1200), 'a whole amount');
  assert.deepEqual(parseMoneyInput('', 2), { ok: true, minor: null }, 'empty is "nothing typed", not 0');
  assert.deepEqual(parseMoneyInput('   ', 2), { ok: true, minor: null }, 'blank is empty too');
  assert.deepEqual(parseMoneyInput(undefined, 2), { ok: true, minor: null });
  assert.deepEqual(parseMoneyInput(null, 2), { ok: true, minor: null });
});

test('garbage is an error code, never 0 and never the number its digits spell', () => {
  for (const junk of ['abc', '-', '.', ',', '€', 'n/a', '1a2', '12-5', '1..250', '1.250,50,3', '1,250.500.5', '1,2.5', '1.250.5', '1.2.500', '12,5 0', '1 2a,50', '0x1', '0x1,50', '1e2', '12 34,5x6', '--5']) {
    assert.deepEqual(parseMoneyInput(junk, 2), { ok: false, code: 'not_an_amount' }, `«${junk}»`);
  }
});

test('a lone separator followed by exactly three digits is refused, with its two readings', () => {
  assert.deepEqual(parseMoneyInput('1.250', 2), {
    ok: false,
    code: 'ambiguous_amount',
    readings: { grouped: 125000, decimal: 125 },
  });
  assert.deepEqual(parseMoneyInput('2,500 €', 2, { currency: 'EUR', locale: 'es' }), {
    ok: false,
    code: 'ambiguous_amount',
    readings: { grouped: 250000, decimal: 250 },
  });
  assert.deepEqual(parseMoneyInput('-1.250', 2), {
    ok: false,
    code: 'ambiguous_amount',
    readings: { grouped: -125000, decimal: -125 },
  }, 'both readings keep the sign');
  assert.deepEqual(parseMoneyInput('1 250,500', 2), {
    ok: false,
    code: 'ambiguous_amount',
    readings: { grouped: 125050000, decimal: 125050 },
  }, 'space groups before the lone separator');
  assert.deepEqual(parseMoneyInput('999 999 999 999 999,250', 2), { ok: false, code: 'not_an_amount' }, 'too large either way');
  // Three decimals ARE the currency's scale (KWD): the reading is the decimal one.
  assert.deepEqual(parseMoneyInput('1.250', 3), ok(1250));
  // No decimals at all (JPY): it can only be grouping.
  assert.deepEqual(parseMoneyInput('1.250', 0), ok(1250));
  assert.deepEqual(parseMoneyInput('1,250', 0), ok(1250));
  // Any other tail length is not ambiguous.
  assert.deepEqual(parseMoneyInput('1.25', 2), ok(125));
  assert.deepEqual(parseMoneyInput('1,2', 2), ok(120));
  assert.deepEqual(parseMoneyInput('1,2500', 2), ok(125));
  // Only ambiguous when the grouping reading is itself a valid grouping.
  assert.deepEqual(parseMoneyInput('0,250', 2), ok(25), 'a leading 0 is never a thousands group');
  assert.deepEqual(parseMoneyInput(',250', 2), ok(25));
  assert.deepEqual(parseMoneyInput('1250,500', 2), ok(125050), 'four digits before it: not a group');
});

test('the same separator repeated is grouping, and grouping comes in threes (or the Indian 2-2-3)', () => {
  assert.deepEqual(parseMoneyInput('1.250.000', 2), ok(125000000));
  assert.deepEqual(parseMoneyInput('1,250,000', 2), ok(125000000));
  assert.deepEqual(parseMoneyInput('1.250.000,75', 2), ok(125000075));
  assert.deepEqual(parseMoneyInput('1,25,050.50', 2), ok(12505050), 'en-IN lakh grouping');
  assert.deepEqual(parseMoneyInput('12.50.000', 2), ok(125000000), 'en-IN lakh grouping, other separator');
  assert.deepEqual(parseMoneyInput('1.25.00', 2), { ok: false, code: 'not_an_amount' }, 'last group is not three');
  assert.deepEqual(parseMoneyInput('01.250.000', 2), { ok: false, code: 'not_an_amount' }, 'a group never starts with 0');
  assert.deepEqual(parseMoneyInput('1234.567,5', 2), { ok: false, code: 'not_an_amount' }, 'first group longer than three');
});

test('currency symbols, codes, spaces, NBSP, NNBSP, thin space and apostrophes are cleaned away', () => {
  const eurEs = { currency: 'EUR', locale: 'es' };
  assert.deepEqual(parseMoneyInput('1.250,50 €', 2, eurEs), ok(125050));
  assert.deepEqual(parseMoneyInput('€1,250.50', 2, { currency: 'EUR', locale: 'en' }), ok(125050));
  assert.deepEqual(parseMoneyInput('EUR 1.250,50', 2, eurEs), ok(125050));
  assert.deepEqual(parseMoneyInput('1 250,50 €', 2, eurEs), ok(125050), 'NBSP');
  assert.deepEqual(parseMoneyInput('1 250,50 €', 2, { currency: 'EUR', locale: 'fr' }), ok(125050), 'NNBSP (fr, odoo#106534)');
  assert.deepEqual(parseMoneyInput('1 250,50', 2), ok(125050), 'thin space');
  assert.deepEqual(parseMoneyInput("CHF 1'250.50", 2, { currency: 'CHF', locale: 'de-CH' }), ok(125050));
  assert.deepEqual(parseMoneyInput('CHF 1’250.50', 2, { currency: 'CHF', locale: 'de-CH' }), ok(125050), 'de-CH right single quote');
  assert.deepEqual(parseMoneyInput('kr. 12,50', 2, { currency: 'DKK', locale: 'da' }), ok(1250), 'a dot inside the currency is not a separator');
});

// ERPlora/module-toolkit#396: «1.5k» was saved as 1,50 and «12abc» as 12 — the letters were cleaned
// away as if they were the currency. Like Odoo's monetary field, only THIS hub's currency is cleaned
// (what the screen prints in the hub's language, its narrow symbol and its ISO code) plus the
// universal currency signs (\p{Sc}); any other letter is an error the screen shows, never a number.
test('letters glued to the amount are refused unless they are the hub currency (module-toolkit#396)', () => {
  const eurEs = { currency: 'EUR', locale: 'es' };
  for (const junk of ['1.5k', '2M', '12abc', 'hola 1.250,50', '12 euros', 'EURO 12', '12 kr', 'CHF 12', 'Fr. 12.50', 'k12']) {
    assert.deepEqual(parseMoneyInput(junk, 2, eurEs), { ok: false, code: 'not_an_amount' }, `EUR «${junk}»`);
  }
  for (const junk of ['1.5k', '12abc', 'EUR 12', '12 kr']) {
    assert.deepEqual(parseMoneyInput(junk, 2), { ok: false, code: 'not_an_amount' }, `no currency given: «${junk}»`);
  }
  assert.deepEqual(parseMoneyInput('12 kr', 2, { currency: 'SEK', locale: 'sv' }), ok(1200), 'kr IS the SEK of a Swedish hub');
  assert.deepEqual(parseMoneyInput('12 kr', 2, { currency: 'SEK', locale: 'es' }), ok(1200), 'the narrow symbol counts too');
  assert.deepEqual(parseMoneyInput('SEK 12', 2, { currency: 'SEK', locale: 'sv' }), ok(1200), 'the ISO code always counts');
  assert.deepEqual(parseMoneyInput('eur 12', 2, eurEs), ok(1200), 'the code, whatever its case');
  assert.deepEqual(parseMoneyInput('US$ 12.50', 2, { currency: 'USD', locale: 'es' }), ok(1250));
  assert.deepEqual(parseMoneyInput('R$ 12,50', 2, { currency: 'BRL', locale: 'pt-BR' }), ok(1250));
  assert.deepEqual(parseMoneyInput('-S/ 12.50', 2, { currency: 'PEN', locale: 'es-PE' }), ok(-1250));
  assert.deepEqual(parseMoneyInput('k12r', 2, { currency: 'SEK', locale: 'sv' }), { ok: false, code: 'not_an_amount' }, 'the words do not join across the digits');
  assert.deepEqual(parseMoneyInput('ksekr 12', 2, { currency: 'SEK', locale: 'sv' }), { ok: false, code: 'not_an_amount' }, 'nor around a word taken out');
  assert.deepEqual(parseMoneyInput('12 абв', 2, { currency: 'EUR', locale: 'es' }), { ok: false, code: 'not_an_amount' }, 'letters of any script');
  assert.deepEqual(parseMoneyInput('12 د.ك.', 2, { currency: 'EUR', locale: 'es' }), { ok: false, code: 'not_an_amount' }, 'the KWD of an Arabic hub is not EUR');
  assert.deepEqual(parseMoneyInput('12,50 PLN', 2, { currency: 'PLN' }), ok(1250), 'no locale → en');
  assert.deepEqual(parseMoneyInput('12,50 zł', 2, { currency: 'PLN' }), ok(1250), 'en prints zł as the narrow symbol');
  assert.deepEqual(parseMoneyInput('12,50 zł', 2, { currency: 'EUR' }), { ok: false, code: 'not_an_amount' }, 'but not for EUR');
});

test('without a currency any currency sign is cleaned; with one, only its own', () => {
  for (const [typed, minor] of [['12 €', 1200], ['$12', 1200], ['£12.50', 1250], ['-¥1250', -125000]]) {
    assert.deepEqual(parseMoneyInput(typed, 2), ok(minor), `«${typed}»`);
  }
  const eurEs = { currency: 'EUR', locale: 'es' };
  assert.deepEqual(parseMoneyInput('12 €', 2, eurEs), ok(1200));
  for (const foreign of ['$12', '12 £', '-¥1250', '12 ₿', '12 ¤']) {
    assert.deepEqual(parseMoneyInput(foreign, 2, eurEs), { ok: false, code: 'not_an_amount' }, `a euro hub, «${foreign}»`);
  }
  // The keyboard's symbol is not always the one the hub's language prints: English's counts too.
  assert.deepEqual(parseMoneyInput('¥1250', 0, { currency: 'JPY', locale: 'ja' }), ok(1250), 'ja prints ￥, the keyboard types ¥');
  assert.deepEqual(parseMoneyInput('CA$ 12', 2, { currency: 'CAD', locale: 'fr-CA' }), ok(1200), 'fr-CA prints $, English CA$');
});

// rv-397: not only letters — «5½» was saved as 5, «12%» as 12 and «١٢ 5» as 5. Next to the digits
// only the hub currency, spaces, the direction marks Intl prints (he, ar) and one sign may sit.
test('any other character next to the digits is not an amount, never the number that is left', () => {
  const eurEs = { currency: 'EUR', locale: 'es' };
  for (const junk of ['5½', '12%', '#12', '12²', '١٢ 5', '~12', '12*', '@12', '12 =', '12 €!']) {
    assert.deepEqual(parseMoneyInput(junk, 2, eurEs), { ok: false, code: 'not_an_amount' }, `EUR «${junk}»`);
    assert.deepEqual(parseMoneyInput(junk, 2), { ok: false, code: 'not_an_amount' }, `no currency given: «${junk}»`);
  }
  assert.deepEqual(parseMoneyInput('12.', 2, eurEs), ok(1200), 'a separator with nothing after it');
  assert.deepEqual(parseMoneyInput('+12', 2, eurEs), ok(1200), 'one sign');
  assert.deepEqual(parseMoneyInput('‏12 €', 2, eurEs), ok(1200), 'a direction mark is not a letter');
});

// Every currency Intl knows, in the languages with their own way of printing it: nothing the
// screen prints is refused by the characters it puts around the digits.
test('what Intl prints for any currency reads back in the hub language', () => {
  const locales = ['es', 'en', 'fr-CA', 'de-CH', 'da', 'sv', 'pt-BR', 'es-PE', 'en-IN', 'ja', 'he', 'ar-EG-u-nu-latn', 'fa-u-nu-latn', 'ko'];
  for (const currency of Intl.supportedValuesOf('currency')) {
    const d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    for (const locale of locales) {
      for (const major of [Number((1234.5678).toFixed(d)), -7]) {
        const printed = new Intl.NumberFormat(locale, { style: 'currency', currency, useGrouping: true }).format(major);
        const read = parseMoneyInput(printed, d, { currency, locale });
        assert.deepEqual(read, ok(Math.round(major * 10 ** d)), `${locale} ${currency} «${printed}»`);
      }
    }
  }
});

test('a currency that is not an ISO code is a programming error, not a silent pass', () => {
  for (const bad of ['EURO', 'eu', 12, '']) {
    assert.throws(() => parseMoneyInput('12', 2, { currency: bad }), /money_input_currency_invalid/, String(bad));
  }
});

test('the sign is kept: hyphen-minus and the Unicode minus Intl prints', () => {
  assert.deepEqual(parseMoneyInput('-1.250,50', 2), ok(-125050));
  assert.deepEqual(parseMoneyInput('−1 250,50 kr', 2, { currency: 'SEK', locale: 'sv' }), ok(-125050), 'sv minus sign');
  assert.deepEqual(parseMoneyInput('-€12.50', 2), ok(-1250));
  assert.deepEqual(parseMoneyInput('-0', 2), ok(0));
  assert.ok(!Object.is(parseMoneyInput('-0', 2).minor, -0), 'no negative zero');
  assert.deepEqual(parseMoneyInput('12-', 2), { ok: false, code: 'not_an_amount' }, 'a trailing minus is not a sign');
  assert.deepEqual(parseMoneyInput('12−', 2), { ok: false, code: 'not_an_amount' }, 'nor a trailing Unicode minus');
  assert.deepEqual(parseMoneyInput('+12', 2), ok(1200), 'a lone plus is a sign too');
});

// A spreadsheet pastes a negative in accounting brackets — `(1.250,50 €)` — and cleaning the brackets
// away as if they were a currency symbol flips the sign in silence. Two signs are no sign at all.
test('accounting brackets and doubled or trailing signs are refused, never read with a guessed sign', () => {
  for (const junk of ['(12)', '(1.250,50 €)', '€(12.50)', '12)', '+-12', '-+12', '++12', '12+', '1.250,50 +']) {
    assert.deepEqual(parseMoneyInput(junk, 2), { ok: false, code: 'not_an_amount' }, `«${junk}»`);
  }
});

test('digits, not floats: HALF_UP on the typed digits (ADR-0123)', () => {
  assert.deepEqual(parseMoneyInput('1.005', 3), ok(1005));
  assert.deepEqual(parseMoneyInput('1,005', 2), { ok: false, code: 'ambiguous_amount', readings: { grouped: 100500, decimal: 101 } });
  assert.deepEqual(parseMoneyInput('1,0051', 2), ok(101));
  assert.deepEqual(parseMoneyInput('1,0049', 2), ok(100));
  assert.deepEqual(parseMoneyInput('0,29', 2), ok(29), '0.29 * 100 is 28.999… in IEEE-754');
  assert.deepEqual(parseMoneyInput('2,675', 3), ok(2675));
  assert.deepEqual(parseMoneyInput('2,6749', 2), ok(267));
  assert.deepEqual(parseMoneyInput('12,5', 0), ok(13), 'no decimals: other fractions round to the unit');
  assert.deepEqual(parseMoneyInput('-2,345', 3), ok(-2345));
  assert.deepEqual(parseMoneyInput('-2,3451', 2), ok(-235), 'HALF_UP is away from zero on the magnitude');
  assert.deepEqual(parseMoneyInput('1.250,505', 2), ok(125051), 'HALF_UP with both separators too');
  assert.deepEqual(parseMoneyInput('1,250.5049', 2), ok(125050));
  assert.deepEqual(parseMoneyInput(',5', 2), ok(50));
  assert.deepEqual(parseMoneyInput('.5', 2), ok(50));
});

test('an amount beyond what a number can hold exactly is refused, not rounded', () => {
  assert.deepEqual(parseMoneyInput('999999999999999999', 2), { ok: false, code: 'not_an_amount' });
});

test('numbers are accepted as input too (a value already in the major unit)', () => {
  assert.deepEqual(parseMoneyInput(12.5, 2), ok(1250));
  assert.deepEqual(parseMoneyInput(0, 2), ok(0));
  assert.deepEqual(parseMoneyInput(1.255, 2), ok(126), 'a number has a decimal point, never an ambiguous one');
  assert.deepEqual(parseMoneyInput(1250, 2), ok(125000));
  assert.deepEqual(parseMoneyInput(-0.5, 2), ok(-50));
  assert.deepEqual(parseMoneyInput(Number.NaN, 2), { ok: false, code: 'not_an_amount' });
  assert.deepEqual(parseMoneyInput(Number.POSITIVE_INFINITY, 2), { ok: false, code: 'not_an_amount' });
  assert.deepEqual(parseMoneyInput(1e21, 2), { ok: false, code: 'not_an_amount' });
});

test('the scale has to be a currency scale: anything else is a programming error, not 0', () => {
  for (const bad of [-1, 1.5, Number.NaN, '2', undefined, 7]) {
    assert.throws(() => parseMoneyInput('12', bad), /money_input_decimals_invalid/, String(bad));
  }
});

// Whatever the screen prints has to read back: this is the exact `Intl` call of the shell's
// `formatMoney` (hub apps/web/src/lib/money.ts, hub#1090 — `useGrouping: true`, currency style).
test('every amount formatMoney prints reads back to the same minor units', () => {
  const screen = (locale, currency, major) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency, useGrouping: true }).format(major);
  const cases = [
    ['es-ES', 'EUR', 2, 1250.5],
    ['es-ES', 'EUR', 2, 1234567.89],
    ['es-ES', 'EUR', 2, -1250.5],
    ['en-US', 'USD', 2, 1250.5],
    ['fr-FR', 'EUR', 2, 1250.5],
    ['de-DE', 'EUR', 2, 1250.5],
    ['de-CH', 'CHF', 2, 1250.5],
    ['sv-SE', 'SEK', 2, -1250.5],
    ['da-DK', 'DKK', 2, 1250.5],
    ['en-SE', 'SEK', 2, 1250.5],
    ['es-ES', 'USD', 2, 1250.5],
    ['pt-BR', 'BRL', 2, -1250.5],
    ['es-PE', 'PEN', 2, 1250.5],
    ['pl-PL', 'PLN', 2, 1250.5],
    ['en-IN', 'INR', 2, 125050.5],
    ['ja-JP', 'JPY', 0, 1250],
    ['en-US', 'KWD', 3, 1250.5],
    ['es-ES', 'EUR', 2, 0.29],
  ];
  for (const [locale, currency, d, major] of cases) {
    const printed = screen(locale, currency, major);
    assert.deepEqual(parseMoneyInput(printed, d, { currency, locale }), ok(Math.round(major * 10 ** d)), `${locale} ${currency} «${printed}»`);
  }
});

test('formatMoneyInput: the hub locale, the currency scale, and NO grouping', () => {
  assert.equal(formatMoneyInput(125050, 2, 'es'), '1250,50');
  assert.equal(formatMoneyInput(125050, 2, 'en'), '1250.50');
  assert.equal(formatMoneyInput(1350, 2, 'es-ES'), '13,50');
  assert.equal(formatMoneyInput(1999, 0, 'ja'), '1999');
  assert.equal(formatMoneyInput(1250, 3, 'en'), '1.250');
  assert.equal(formatMoneyInput(-125050, 2, 'es'), '-1250,50');
  assert.equal(formatMoneyInput(12345678, 2, 'fr'), '123456,78');
  assert.equal(formatMoneyInput(125050, 2, ''), '1250.50', 'no locale → en');
  assert.equal(formatMoneyInput(125050, 2, 'ar-EG'), '1250.50', 'Latin digits: the field must read back');
  assert.equal(formatMoneyInput(null, 2, 'es'), '', 'nothing stored → an empty field, not 0');
  assert.equal(formatMoneyInput(undefined, 2, 'es'), '');
});

test('what formatMoneyInput writes, parseMoneyInput reads back — in every locale', () => {
  for (const locale of ['es', 'en', 'fr', 'de', 'de-CH', 'sv', 'en-IN', 'ar-EG', 'ja']) {
    for (const [minor, d] of [[125050, 2], [-125050, 2], [5, 2], [1250, 3], [1999, 0], [123456789, 2]]) {
      const typed = formatMoneyInput(minor, d, locale);
      assert.deepEqual(parseMoneyInput(typed, d), ok(minor), `${locale} ${d} «${typed}»`);
    }
  }
});

test('normaliseMoneyInput rewrites what it can read and leaves the rest EXACTLY as typed', () => {
  assert.equal(normaliseMoneyInput('1.250,5', 2, 'es'), '1250,50');
  assert.equal(normaliseMoneyInput('1,250.5', 2, 'es'), '1250,50');
  assert.equal(normaliseMoneyInput('12', 2, 'en'), '12.00');
  assert.equal(normaliseMoneyInput('1.250', 2, 'es'), '1.250', 'ambiguous: no reading is picked');
  assert.equal(normaliseMoneyInput('abc', 2, 'es'), 'abc', 'garbage: what they wrote is not thrown away');
  assert.equal(normaliseMoneyInput('  ', 2, 'es'), '  ', 'empty stays empty, not 0,00');
  assert.equal(normaliseMoneyInput('EUR 12', 2, 'es', 'EUR'), '12,00', 'the hub currency is cleaned');
  assert.equal(normaliseMoneyInput('12 kr', 2, 'sv', 'SEK'), '12,00', 'with the hub locale');
  assert.equal(normaliseMoneyInput('US$ 12', 2, 'es', 'USD'), '12,00', 'what the hub locale prints (en prints $)');
  assert.equal(normaliseMoneyInput('1.5k', 2, 'es', 'EUR'), '1.5k', 'letters: left as typed, never 1,50');
  assert.equal(normaliseMoneyInput('12 kr', 2, 'es', 'EUR'), '12 kr', 'another currency: left as typed');
});

test('the package exports it as `@erplora/module-toolkit/money-input`, typed', async () => {
  // Self-reference by package name resolves through `exports`, exactly as a module's test will.
  const viaPackage = await import('@erplora/module-toolkit/money-input');
  assert.equal(viaPackage.parseMoneyInput, parseMoneyInput);
  const repo = new URL('..', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', repo), 'utf8'));
  assert.equal(pkg.exports['./money-input'].default, './src/money-input.mjs');
  assert.equal(pkg.exports['./money-input'].types, './src/money-input.d.mts');
  const dts = readFileSync(new URL('src/money-input.d.mts', repo), 'utf8');
  for (const name of Object.keys(viaPackage)) assert.match(dts, new RegExp(`export (declare )?function ${name}\\b`), name);
  for (const code of ['not_an_amount', 'ambiguous_amount']) assert.match(dts, new RegExp(`'${code}'`), code);
  assert.match(dts, /parseMoneyInput\(typed: unknown, decimals: number, options\?: MoneyInputOptions\)/, 'the currency option is typed');
  assert.match(dts, /normaliseMoneyInput\(typed: string, decimals: number, locale\?: string, currency\?: string\)/);
});
