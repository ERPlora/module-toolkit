// Types of `@erplora/module-toolkit/money-input` (ERPlora/combos#9). The contract lives in
// `money-input.mjs`; this file only lets a module's TypeScript import it typed.

export type MoneyInputErrorCode = 'not_an_amount' | 'ambiguous_amount';

export type MoneyInput =
  /** `minor: null` — nothing was typed (empty is not the same as free). */
  | { ok: true; minor: number | null }
  | { ok: false; code: 'not_an_amount' }
  /** A lone separator + exactly three digits (`1.250`): both readings, in minor units. */
  | { ok: false; code: 'ambiguous_amount'; readings: { grouped: number; decimal: number } };

/** What a person typed or pasted → minor units of a currency with `decimals` (0–4). */
export function parseMoneyInput(typed: unknown, decimals: number): MoneyInput;

/** Minor units → the field's text: hub locale, currency decimals, no grouping. `null` → `''`. */
export function formatMoneyInput(minor: number | null | undefined, decimals: number, locale?: string): string;

/** The field on blur: rewritten when readable, exactly as typed when not. */
export function normaliseMoneyInput(typed: string, decimals: number, locale?: string): string;
