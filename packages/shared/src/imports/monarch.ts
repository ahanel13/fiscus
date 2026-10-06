// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType, BalanceMode } from '../api/accounts.js';
import type { ImportBalance, ImportTransaction } from '../api/imports.js';
import type { CsvTable } from './csv.js';
import { guessAccountType, type RowProblem } from './mapping.js';
import { parseAmount, parseDate } from './values.js';

// Monarch's export (docs/design/imports.md §2), checked against a real one in October 2026:
//   Transactions: Date, Merchant, Category, Account, Original Statement, Notes, Amount, Tags,
//                 Owner, Reviewed, Id   (the last three in newer exports)
//   Balances:     Date, Balance, Account   (one row per account per day)
// Dates are YYYY-MM-DD; amounts are plain decimals already signed the Fiscus way.

const TRANSACTION_HEADERS = ['date', 'merchant', 'category', 'account', 'amount'];
const BALANCE_HEADERS = ['date', 'balance', 'account'];

const lower = (headers: string[]) => headers.map((h) => h.trim().toLowerCase());

export const isMonarchTransactions = (headers: string[]) =>
  TRANSACTION_HEADERS.every((h) => lower(headers).includes(h));

export const isMonarchBalances = (headers: string[]) => {
  const l = lower(headers);
  return l.length === 3 && BALANCE_HEADERS.every((h) => l.includes(h));
};

/** What the wizard shows about each account found in the files. */
export interface MonarchAccount {
  /** The name as in the files, trimmed: the key rows refer to. */
  key: string;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
  balances: number;
  lastBalanceDate: string | null;
  lastBalanceMinor: number | null;
  suggestedType: AccountType;
  /** Accounts with no transactions in the export are valued by hand. */
  suggestedMode: BalanceMode;
  /**
   * The export has no "closed" flag: an account whose balances stop before the export's last day
   * is offered as closed the day after (docs/design/imports.md §2).
   */
  closeOn: string | null;
  /** Its last balance is under one unit (say $1): clearly closed, so the wizard ticks it. */
  closedAtZero: boolean;
}

export interface MonarchImport {
  transactions: ImportTransaction[];
  balances: ImportBalance[];
  accounts: MonarchAccount[];
  /** Names in the Owner column other than "Shared", to map to members. */
  owners: string[];
  problems: RowProblem[];
}

const nextDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** Reads one or both Monarch files into import rows and a summary per account. */
export function readMonarch(
  files: { transactions?: CsvTable; balances?: CsvTable },
  exponent: number,
): MonarchImport {
  const transactions: ImportTransaction[] = [];
  const balances: ImportBalance[] = [];
  const problems: RowProblem[] = [];
  const owners = new Set<string>();
  const amounts = new Map<string, number[]>();
  const stats = new Map<string, MonarchAccount>();
  const account = (key: string) => {
    let a = stats.get(key);
    if (!a) {
      a = {
        key,
        transactions: 0,
        firstDate: null,
        lastDate: null,
        balances: 0,
        lastBalanceDate: null,
        lastBalanceMinor: null,
        suggestedType: 'depository',
        suggestedMode: 'value',
        closeOn: null,
        closedAtZero: false,
      };
      stats.set(key, a);
    }
    return a;
  };

  if (files.transactions) {
    const t = files.transactions;
    const col = (name: string) => lower(t.headers).indexOf(name);
    const c = {
      date: col('date'),
      merchant: col('merchant'),
      category: col('category'),
      account: col('account'),
      statement: col('original statement'),
      notes: col('notes'),
      amount: col('amount'),
      tags: col('tags'),
      owner: col('owner'),
      reviewed: col('reviewed'),
      id: col('id'),
    };
    const get = (row: string[], i: number) => (i < 0 ? '' : (row[i] ?? '').trim());
    t.rows.forEach((row, i) => {
      const line = t.lines[i]!;
      const key = get(row, c.account);
      const date = parseDate(get(row, c.date), 'ymd');
      const amountMinor = parseAmount(get(row, c.amount), '.', exponent);
      if (!key) return problems.push({ line, message: 'No account' });
      if (!date)
        return problems.push({ line, message: `The date “${get(row, c.date)}” isn’t a date` });
      if (amountMinor === null)
        return problems.push({ line, message: 'The amount isn’t a number' });
      const merchant = get(row, c.merchant).slice(0, 200);
      const statement = get(row, c.statement).slice(0, 500);
      const category = get(row, c.category).slice(0, 100);
      const tags = get(row, c.tags)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20);
      const note = get(row, c.notes).slice(0, 5000);
      const owner = get(row, c.owner).slice(0, 100);
      const id = get(row, c.id).slice(0, 100);
      if (owner && owner.toLowerCase() !== 'shared') owners.add(owner);
      transactions.push({
        line,
        account: key,
        date,
        amountMinor,
        description: statement || merchant,
        ...(merchant ? { name: merchant } : {}),
        ...(category ? { category } : {}),
        ...(tags.length ? { tags } : {}),
        ...(note ? { note } : {}),
        ...(id ? { externalId: id } : {}),
        // Blank means Monarch's review flow wasn't used: you curated it there.
        reviewed: get(row, c.reviewed).toLowerCase() !== 'needs review',
        ...(owner && owner.toLowerCase() !== 'shared' ? { owner } : {}),
      });
      const a = account(key);
      a.transactions++;
      if (!a.firstDate || date < a.firstDate) a.firstDate = date;
      if (!a.lastDate || date > a.lastDate) a.lastDate = date;
    });
  }

  if (files.balances) {
    const b = files.balances;
    const col = (name: string) => lower(b.headers).indexOf(name);
    const [cd, cb, ca] = [col('date'), col('balance'), col('account')];
    b.rows.forEach((row, i) => {
      const line = b.lines[i]!;
      const key = (row[ca] ?? '').trim();
      const date = parseDate(row[cd] ?? '', 'ymd');
      const balanceMinor = parseAmount(row[cb] ?? '', '.', exponent);
      if (!key || !date || balanceMinor === null) {
        return problems.push({ line, message: 'This balance row can’t be read' });
      }
      balances.push({ account: key, date, balanceMinor });
      const a = account(key);
      a.balances++;
      amounts.set(key, [...(amounts.get(key) ?? []), balanceMinor]);
      if (!a.lastBalanceDate || date > a.lastBalanceDate) {
        a.lastBalanceDate = date;
        a.lastBalanceMinor = balanceMinor;
      }
    });
  }

  const exportEnd = [...stats.values()].reduce<string | null>(
    (max, a) => (a.lastBalanceDate && (!max || a.lastBalanceDate > max) ? a.lastBalanceDate : max),
    null,
  );
  for (const a of stats.values()) {
    a.suggestedType = guessAccountType(a.key, amounts.get(a.key));
    a.suggestedMode = a.transactions > 0 ? 'transactions' : 'value';
    if (exportEnd && a.lastBalanceDate && a.lastBalanceDate < exportEnd) {
      a.closeOn = nextDay(a.lastBalanceDate);
      a.closedAtZero = Math.abs(a.lastBalanceMinor ?? 0) < 10 ** exponent;
    }
  }
  return {
    transactions,
    balances,
    accounts: [...stats.values()].sort((x, y) => x.key.localeCompare(y.key)),
    owners: [...owners].sort(),
    problems,
  };
}
