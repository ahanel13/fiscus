// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AccountType, BalanceMode } from '../api/accounts.js';
import type { ImportBalance, ImportTransaction } from '../api/imports.js';
import type { CsvTable } from './csv.js';
import { explainAccountType, type RowProblem } from './mapping.js';
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
  firstBalanceDate: string | null;
  lastBalanceDate: string | null;
  lastBalanceMinor: number | null;
  suggestedType: AccountType;
  /** The name said what type it is; otherwise the guess comes from balances (or is a default). */
  typeFromName: boolean;
  /** Accounts with no transactions in the export are valued by hand. */
  suggestedMode: BalanceMode;
  /**
   * The export has no "closed" flag: an account whose balances stop before the export's last day
   * is offered as closed the day after (docs/design/imports.md §2).
   */
  closeOn: string | null;
  /** Its last balance is under ten units (say $10): clearly closed, so the wizard ticks it. */
  closedAtZero: boolean;
  /**
   * Another account in the file with the same balance on every day both have (30 days or
   * more), and this one has no transactions of its own: the same account connected twice in
   * Monarch. The wizard leaves it out unless you choose otherwise.
   */
  duplicateOf: string | null;
  /**
   * An account with a similar name whose history starts within a week after this one's ends:
   * the same thing re-added in Monarch (a vehicle switched to automatic valuation, say). The
   * wizard suggests combining them into one account.
   */
  continuedBy: string | null;
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
  const byDay = new Map<string, Map<string, number>>();
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
        firstBalanceDate: null,
        lastBalanceDate: null,
        lastBalanceMinor: null,
        suggestedType: 'depository',
        typeFromName: false,
        suggestedMode: 'value',
        closeOn: null,
        closedAtZero: false,
        duplicateOf: null,
        continuedBy: null,
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
      const days = byDay.get(key) ?? new Map<string, number>();
      days.set(date, balanceMinor);
      byDay.set(key, days);
      const a = account(key);
      a.balances++;
      amounts.set(key, [...(amounts.get(key) ?? []), balanceMinor]);
      if (!a.firstBalanceDate || date < a.firstBalanceDate) a.firstBalanceDate = date;
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
    const guess = explainAccountType(a.key, amounts.get(a.key), exponent);
    a.suggestedType = guess.type;
    a.typeFromName = guess.fromName;
    a.suggestedMode = a.transactions > 0 ? 'transactions' : 'value';
    if (exportEnd && a.lastBalanceDate && a.lastBalanceDate < exportEnd) {
      a.closeOn = nextDay(a.lastBalanceDate);
      a.closedAtZero = Math.abs(a.lastBalanceMinor ?? 0) < 10 * 10 ** exponent;
    }
  }
  findDuplicates([...stats.values()], byDay);
  findContinuations([...stats.values()], byDay);
  return {
    transactions,
    balances,
    accounts: [...stats.values()].sort((x, y) => x.key.localeCompare(y.key)),
    owners: [...owners].sort(),
    problems,
  };
}

/** Marks accounts that mirror another account's balances day for day (see `duplicateOf`). */
function findDuplicates(accounts: MonarchAccount[], byDay: Map<string, Map<string, number>>) {
  const MIN_DAYS = 30;
  // Keep the one with transactions, then the one with more history; mark the other.
  const rank = (a: MonarchAccount) => [a.transactions, a.balances, a.key.length];
  const better = (x: MonarchAccount, y: MonarchAccount) => {
    const [a, b] = [rank(x), rank(y)];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
    return x.key < y.key;
  };
  for (const a of accounts) {
    const mine = byDay.get(a.key);
    if (a.transactions > 0 || !mine || mine.size < MIN_DAYS) continue;
    for (const b of accounts) {
      const theirs = byDay.get(b.key);
      if (b === a || b.duplicateOf || !theirs || !better(b, a)) continue;
      let shared = 0;
      let same = true;
      for (const [day, value] of mine) {
        const other = theirs.get(day);
        if (other === undefined) continue;
        shared++;
        if (other !== value) {
          same = false;
          break;
        }
      }
      if (same && shared >= MIN_DAYS) {
        a.duplicateOf = b.key;
        break;
      }
    }
  }
}

/** "2019 Ford F-150 XLT (...1234)" → "ford f-150 xlt": names compared loosely. */
export const looseName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\(\.{3}\d+\)/g, '')
    .replace(/\b(19|20)\d{2}\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Marks accounts another one picks up from (see `continuedBy`). */
function findContinuations(accounts: MonarchAccount[], byDay: Map<string, Map<string, number>>) {
  const span = (key: string) => {
    const days = [...(byDay.get(key)?.keys() ?? [])].sort();
    return days.length ? { first: days[0]!, last: days.at(-1)! } : null;
  };
  for (const a of accounts) {
    const mine = span(a.key);
    if (!mine || a.duplicateOf || !a.closeOn) continue;
    const name = looseName(a.key);
    if (name.length < 4) continue;
    const next = accounts.find((b) => {
      const theirs = span(b.key);
      if (b === a || !theirs || b.duplicateOf || b.continuedBy) return false;
      const other = looseName(b.key);
      const similar = other.includes(name) || name.includes(other);
      const gap = (Date.parse(theirs.first) - Date.parse(mine.last)) / 86_400_000;
      return similar && other.length >= 4 && gap >= 1 && gap <= 7;
    });
    if (next) a.continuedBy = next.key;
  }
}
