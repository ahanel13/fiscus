// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType } from '../api/accounts.js';
import type { CsvMapping, ImportTransaction } from '../api/imports.js';
import type { CategoryKind } from '../api/ledger.js';
import type { CsvTable } from './csv.js';
import { detectDateFormat, detectDecimalSeparator, parseAmount, parseDate } from './values.js';

// Turning a bank's CSV into import rows with a column mapping (docs/design/imports.md §1).

export interface RowProblem {
  line: number;
  message: string;
}

const norm = (h: string) => h.trim().toLowerCase();

/** Headers as a profile stores them, to recognize the same bank's next file. */
export const headerSignature = (headers: string[]) => headers.map(norm);

/** A saved profile fits a file when every column it uses is in the file. */
export function profileFits(mapping: CsvMapping, headers: string[]): boolean {
  const have = new Set(headers.map(norm));
  const used = [
    mapping.date,
    mapping.description,
    ...(mapping.amount.kind === 'signed'
      ? [mapping.amount.column]
      : [mapping.amount.debit, mapping.amount.credit]),
    mapping.name,
    mapping.category,
    mapping.notes,
    mapping.tags,
    mapping.account,
    mapping.id,
  ].filter((c): c is string => !!c);
  return used.every((c) => have.has(norm(c)));
}

const HINTS: [keyof CsvMapping | 'debit' | 'credit', RegExp][] = [
  ['date', /^(transaction |trans\.? |posting |posted |post )?date$/],
  ['debit', /^(debit|withdrawals?|money out|paid out)( amount)?$/],
  ['credit', /^(credit|deposits?|money in|paid in)( amount)?$/],
  [
    'description',
    /^(description|original description|details|memo|narrative|payee|original statement)$/,
  ],
  ['name', /^(merchant|merchant name|name|payee name)$/],
  ['category', /^category$/],
  ['notes', /^(notes?|comments?)$/],
  ['tags', /^(tags?|labels?)$/],
  ['account', /^(account|account name)$/],
  ['id', /^(id|transaction id|reference|ref)$/],
];

/** A first guess at the mapping from header names and the data, for the wizard to show. */
export function suggestMapping(table: CsvTable): Partial<CsvMapping> {
  const found: Partial<Record<string, string>> = {};
  for (const header of table.headers) {
    const h = norm(header);
    for (const [field, re] of HINTS) {
      if (!found[field] && re.test(h)) found[field] = header;
    }
  }
  const amount = table.headers.find((h) => /^(amount|transaction amount|value)$/.test(norm(h)));
  const column = (header: string | undefined) =>
    header === undefined
      ? []
      : table.rows.slice(0, 200).map((r) => r[table.headers.indexOf(header)] ?? '');
  const out: Partial<CsvMapping> = {
    date: found.date,
    description: found.description ?? found.name,
    name: found.description ? found.name : undefined,
    category: found.category,
    notes: found.notes,
    tags: found.tags,
    account: found.account,
    id: found.id,
  };
  if (found.date) out.dateFormat = detectDateFormat(column(found.date)).formats[0];
  if (amount) {
    out.amount = { kind: 'signed', column: amount, negate: false };
    out.decimal = detectDecimalSeparator(column(amount));
  } else if (found.debit && found.credit) {
    out.amount = { kind: 'split', debit: found.debit, credit: found.credit };
    out.decimal = detectDecimalSeparator([...column(found.debit), ...column(found.credit)]);
  }
  return out;
}

/**
 * Reads every row with a mapping. Rows that can't be read are reported with their line and left
 * out; the rest are imported (docs/design/imports.md, "errors only block their own rows").
 */
export function applyMapping(
  table: CsvTable,
  mapping: CsvMapping,
  options: { exponent: number; account: string },
): { transactions: ImportTransaction[]; problems: RowProblem[] } {
  const index = new Map(table.headers.map((h, i) => [norm(h), i]));
  const get = (row: string[], column: string | undefined) =>
    column === undefined ? '' : (row[index.get(norm(column)) ?? -1] ?? '').trim();
  const transactions: ImportTransaction[] = [];
  const problems: RowProblem[] = [];

  table.rows.forEach((row, i) => {
    const line = table.lines[i]!;
    const rawDate = get(row, mapping.date);
    const date = parseDate(rawDate, mapping.dateFormat);
    if (!date) {
      problems.push({ line, message: `The date “${rawDate}” isn’t a date in the chosen format` });
      return;
    }
    let amountMinor: number | null;
    if (mapping.amount.kind === 'signed') {
      const raw = get(row, mapping.amount.column);
      amountMinor = parseAmount(raw, mapping.decimal, options.exponent);
      if (amountMinor !== null && mapping.amount.negate) amountMinor = -amountMinor || 0;
    } else {
      const debit = get(row, mapping.amount.debit);
      const credit = get(row, mapping.amount.credit);
      const d = debit ? parseAmount(debit, mapping.decimal, options.exponent) : 0;
      const c = credit ? parseAmount(credit, mapping.decimal, options.exponent) : 0;
      amountMinor = d === null || c === null ? null : Math.abs(c) - Math.abs(d);
    }
    if (amountMinor === null) {
      problems.push({ line, message: 'The amount isn’t a number' });
      return;
    }
    const description = get(row, mapping.description).slice(0, 500);
    const name = get(row, mapping.name).slice(0, 200);
    const tags = get(row, mapping.tags)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    transactions.push({
      line,
      account: get(row, mapping.account) || options.account,
      date,
      amountMinor,
      description: description || name,
      ...(name ? { name } : {}),
      ...(get(row, mapping.category) ? { category: get(row, mapping.category).slice(0, 100) } : {}),
      ...(tags.length ? { tags: tags.slice(0, 20) } : {}),
      ...(get(row, mapping.notes) ? { note: get(row, mapping.notes).slice(0, 5000) } : {}),
      ...(get(row, mapping.id) ? { externalId: get(row, mapping.id).slice(0, 100) } : {}),
    });
  });
  return { transactions, problems };
}

/** Lower-cased and single-spaced, so spacing and case changes between exports still match. */
export function normalizeDescription(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Category names that mean money moving between your own accounts. */
const TRANSFER_NAMES = new Set([
  'transfer',
  'transfers',
  'credit card payment',
  'balance adjustments',
]);

/**
 * The kind for a category the import creates: transfers by name, income when every amount in it
 * is money in, otherwise everyday spending (docs/design/imports.md §2).
 */
export function inferCategoryKind(name: string, amounts: number[]): CategoryKind {
  if (TRANSFER_NAMES.has(name.trim().toLowerCase())) return 'transfer';
  if (amounts.length > 0 && amounts.every((a) => a > 0)) return 'income';
  return 'flexible';
}

const TYPE_HINTS: [AccountType, RegExp][] = [
  ['loan', /\b(loan|mortgage|heloc|student)\b/i],
  [
    'investment',
    /\b(ira|roth|401\s?k|403\s?b|brokerage|invest(ing|ment)?s?|hsa|stocks?|fidelity|vanguard|schwab|robinhood|529)\b/i,
  ],
  ['crypto', /\b(crypto|bitcoin|btc|eth|coinbase)\b/i],
  ['vehicle', /\b(car|truck|vehicle|auto|tacoma|toyota|honda|ford|tesla|subaru|motorcycle)\b/i],
  ['property', /\b(house|home|property|condo|zillow|residence)\b/i],
  // A street address: "123 Main St".
  [
    'property',
    /^\d+ .*\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|way|blvd|pl|place|cir|circle)\b/i,
  ],
  [
    'credit',
    /\b(credit|card|visa|mastercard|amex|american express|discover|sapphire|freedom|preferred|rewards|signature|quicksilver|venture|savor|platinum)\b|®/i,
  ],
  ['depository', /\b(checking|savings|cd|money market|cash|bank)\b/i],
];

/**
 * A first guess at an account's type from its name and balances, for the wizard to show and you to
 * change. A name that says "loan" wins over "auto"; mostly-negative balances suggest a card, or a
 * loan when they're large.
 */
export function guessAccountType(name: string, balances: number[] = [], exponent = 2): AccountType {
  return explainAccountType(name, balances, exponent).type;
}

/** The guess, and whether the name said so (a surer guess than balances alone). */
export function explainAccountType(
  name: string,
  balances: number[] = [],
  exponent = 2,
): { type: AccountType; fromName: boolean } {
  for (const [type, re] of TYPE_HINTS) if (re.test(name)) return { type, fromName: true };
  return { type: typeFromBalances(balances, exponent), fromName: false };
}

function typeFromBalances(balances: number[], exponent: number): AccountType {
  const negative = balances.filter((b) => b < 0);
  if (balances.length > 0 && negative.length > balances.length / 2) {
    // Owing tens of thousands is a loan (a mortgage, say), not a card.
    const typical = [...negative].sort((x, y) => x - y)[Math.floor(negative.length / 2)]!;
    return -typical >= 50_000 * 10 ** exponent ? 'loan' : 'credit';
  }
  return 'depository';
}

/**
 * Splits an account's rows into request-sized parts by date, never splitting a day: rows that
 * look identical (two coffees on one day) must arrive together to be counted as two.
 */
export function chunkRowsByDate<T extends { date: string }>(rows: T[], max: number): T[][] {
  const byDate = [...Map.groupBy(rows, (r) => r.date)].sort(([a], [b]) => a.localeCompare(b));
  const parts: T[][] = [];
  let current: T[] = [];
  for (const [, day] of byDate) {
    if (current.length > 0 && current.length + day.length > max) {
      parts.push(current);
      current = [];
    }
    current.push(...day);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}
