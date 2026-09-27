// Types of `@erplora/module-toolkit/money-display-guard` (ERPlora/pm#505). The contract lives in
// `money-display-guard.mjs`; this file only lets a module's TypeScript test import it typed.

export type MoneyDisplayFindingCode =
  | 'hand_formatted_money'
  | 'outfitkit_barrel_import'
  | 'stale_exception'
  | 'witness_required'
  | 'witness_file_not_scanned'
  | 'witness_content_missing'
  | 'outfitkit_import_not_read';

export interface MoneyDisplayFinding {
  code: MoneyDisplayFindingCode;
  /** Relative to the module's `ui/`; empty when the finding is about the whole scan. */
  file: string;
  detail: string;
}

export interface MoneyDisplayOptions {
  /** The module test's `import.meta.url`, or any path inside the module. */
  from: string;
  /** Files (relative to `ui/`) whose comment-stripped code must hold `text` — count the CALL. */
  witnesses: Record<string, string | { text: string; atLeast?: number }>;
  /** `'file: exact code line'` → why it is not a screen amount. Each covers one occurrence. */
  notDisplay?: Record<string, string>;
  /** Files that must each import OutfitKit; by default at least one scanned file must. */
  outfitkitImporters?: string[];
}

export function checkMoneyDisplay(opts: MoneyDisplayOptions): MoneyDisplayFinding[];
export function stripComments(src: string): string;
export function handFormattedMoney(src: string): string[];
export function outfitkitImports(src: string): string[];
export function barrelValueImports(src: string): string[];
export function unexpectedHits(found: string[], allowed: Record<string, string>): string[];
export function moduleRootFrom(from: string): string;
