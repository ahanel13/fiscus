// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Account,
  type AccountType,
  applyMapping,
  type BalanceMode,
  type CategoryGroup,
  type CategoryKind,
  chunkRowsByDate,
  type CsvMapping,
  type CsvTable,
  IMPORT_LIMITS,
  type ImportBalance,
  type ImportPreview,
  type ImportRequest,
  type ImportRowResult,
  type ImportRowsResult,
  type ImportRun,
  type ImportTransaction,
  inferCategoryKind,
  isMonarchBalances,
  isMonarchTransactions,
  looseName,
  type MonarchAccount,
  readMonarch,
  type RowProblem,
} from '@fiscus/shared';
import { api } from '../api/client.js';

// The import wizard's logic, kept out of the components so it can be tested
// (docs/design/imports.md §1).

export type FileKind = 'monarch-transactions' | 'monarch-balances' | 'csv';

export interface LoadedFile {
  name: string;
  table: CsvTable;
  kind: FileKind;
}

export const classifyFile = (table: CsvTable): FileKind =>
  isMonarchTransactions(table.headers)
    ? 'monarch-transactions'
    : isMonarchBalances(table.headers)
      ? 'monarch-balances'
      : 'csv';

/** Where one account in the file goes. */
export interface AccountChoice {
  key: string;
  /** `combine`: into the same account as `sameAs`, another account in the file. */
  mode: 'new' | 'existing' | 'skip' | 'combine';
  accountId: string | null;
  sameAs: string | null;
  name: string;
  type: AccountType;
  balanceMode: BalanceMode;
  /** Close it from `closeOn` (the file shows it closed). */
  close: boolean;
  closeOn: string | null;
  /** What the file has for it, to show in the list. */
  transactions: number;
  balances: number;
  firstDate: string | null;
  lastDate: string | null;
  /** Its last balance in the file (negative: owed, on a card or loan). */
  lastBalance: number | null;
  /** The whole history in the file, transactions and balances: what combining can't overlap. */
  from: string | null;
  to: string | null;
  /** The account this one seems to duplicate (connected twice in Monarch). */
  duplicateOf: string | null;
  /** The account that picks up where this one stops (re-added in Monarch). */
  continuedBy: string | null;
  /**
   * Why to look at this one before importing, decided when the file is read (so rows don't move
   * while you edit). Empty: the wizard is confident; it goes in "Ready to import".
   */
  check: CheckReason[];
}

/** What makes an account worth a look on the Accounts step. */
export type CheckReason =
  /** Same balances as another account, no transactions: probably a second copy. */
  | 'duplicate'
  /** Another account picks up where it stops: probably one account, re-added. */
  | 'continued'
  /**
   * Its history stops early with money in it, or still owed on it (a card or loan): closed, or
   * did it just stop syncing?
   */
  | 'closed_with_money'
  /** The name doesn't say what type it is, and its balances suggest a card or a loan. */
  | 'type_unsure';

const lower = (s: string) => s.trim().toLowerCase();

const span = (a: MonarchAccount) => {
  const days = [a.firstDate, a.lastDate, a.firstBalanceDate, a.lastBalanceDate]
    .filter((d): d is string => !!d)
    .sort();
  return { from: days[0] ?? null, to: days.at(-1) ?? null };
};

/**
 * First choices for the Accounts step: an existing account with the same name if there is one
 * (a later export of the same Monarch data), else a new account with the guessed type. Closed
 * accounts are ticked to close when their last balance was about zero.
 */
export function suggestAccounts(found: MonarchAccount[], existing: Account[]): AccountChoice[] {
  const owned = existing.filter((a) => a.yourAccess === 'owner');
  return found.map((a) => {
    const match = owned.find((e) => lower(e.name) === lower(a.key));
    return {
      key: a.key,
      // A second copy of another account is left out, and one another account continues is
      // combined with it, unless you choose otherwise.
      mode: match ? 'existing' : a.duplicateOf ? 'skip' : a.continuedBy ? 'combine' : 'new',
      accountId: match?.id ?? null,
      sameAs: !match && !a.duplicateOf ? a.continuedBy : null,
      name: a.key,
      type: a.suggestedType,
      balanceMode: a.suggestedMode,
      close: !match?.closedAt && !a.continuedBy && a.closeOn !== null && a.closedAtZero,
      closeOn: match?.closedAt ? null : a.closeOn,
      transactions: a.transactions,
      balances: a.balances,
      firstDate: a.firstDate,
      lastDate: a.lastDate ?? a.lastBalanceDate,
      ...span(a),
      lastBalance: a.lastBalanceMinor,
      duplicateOf: a.duplicateOf,
      continuedBy: a.continuedBy,
      check: match
        ? []
        : ([
            a.duplicateOf ? 'duplicate' : null,
            a.continuedBy ? 'continued' : null,
            a.closeOn && !a.closedAtZero && !a.duplicateOf && !a.continuedBy
              ? 'closed_with_money'
              : null,
            // Unnamed accounts default to checking or savings, usually right and easy to change;
            // a guess of card or loan from the balances is worth a look.
            !a.typeFromName && a.suggestedType !== 'depository' && !a.duplicateOf && !a.continuedBy
              ? 'type_unsure'
              : null,
          ].filter((r) => r !== null) as CheckReason[]),
    };
  });
}

/** Where a category name in the file goes: an existing category, or a new one of a kind. */
export interface CategoryChoice {
  name: string;
  count: number;
  categoryId: string | null;
  kind: CategoryKind;
  /** Mapped the way an earlier import did. */
  remembered: boolean;
}

/**
 * First choices for the Categories step: how an earlier import mapped the name, else a category
 * of the same name (or the system one), else a new category.
 */
export function suggestCategories(
  rows: ImportTransaction[],
  groups: CategoryGroup[],
  remembered: Record<string, string> = {},
): CategoryChoice[] {
  const all = groups.flatMap((g) => g.categories.filter((c) => !c.archived));
  const counts = new Map<string, { name: string; count: number; amounts: number[] }>();
  for (const r of rows) {
    if (!r.category?.trim()) continue;
    const k = lower(r.category);
    const c = counts.get(k) ?? { name: r.category.trim(), count: 0, amounts: [] };
    c.count++;
    c.amounts.push(r.amountMinor);
    counts.set(k, c);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(({ name, count, amounts }) => {
      const earlier = all.find((c) => c.id === remembered[lower(name)]);
      const match =
        earlier ??
        all.find((c) => lower(c.name) === lower(name)) ??
        all.find((c) => c.systemKey !== null && c.systemKey === lower(name));
      return {
        name,
        count,
        categoryId: match?.id ?? null,
        remembered: !!earlier && lower(earlier.name) !== lower(name),
        // The same guess the server makes: transfers by name, income when it's all money in.
        kind: inferCategoryKind(name, amounts),
      };
    });
}

/** The rows of a file, ready to send, plus the lines that couldn't be read. */
export interface FileRows {
  transactions: ImportTransaction[];
  balances: ImportBalance[];
  problems: RowProblem[];
  monarchAccounts: MonarchAccount[];
  owners: string[];
}

/** Monarch: both files read together; every account in either is listed. */
export function readMonarchFiles(files: LoadedFile[], exponent: number): FileRows {
  const t = files.find((f) => f.kind === 'monarch-transactions');
  const b = files.find((f) => f.kind === 'monarch-balances');
  const m = readMonarch(
    { ...(t ? { transactions: t.table } : {}), ...(b ? { balances: b.table } : {}) },
    exponent,
  );
  return {
    transactions: m.transactions,
    balances: m.balances,
    problems: m.problems,
    monarchAccounts: m.accounts,
    owners: m.owners,
  };
}

/** The key a bank file's rows use when the file has no Account column. */
export const FILE_ACCOUNT = 'This file';

/** A bank CSV with a column mapping. Without an Account column it's all one account. */
export function readCsvFile(file: LoadedFile, mapping: CsvMapping, exponent: number): FileRows {
  const { transactions, problems } = applyMapping(file.table, mapping, {
    exponent,
    account: FILE_ACCOUNT,
  });
  const byAccount = Map.groupBy(transactions, (t) => t.account);
  const monarchAccounts: MonarchAccount[] = [...byAccount].map(([key, rows]) => {
    const dates = rows.map((r) => r.date).sort();
    return {
      key,
      transactions: rows.length,
      firstDate: dates[0] ?? null,
      lastDate: dates.at(-1) ?? null,
      balances: 0,
      firstBalanceDate: null,
      lastBalanceDate: null,
      lastBalanceMinor: null,
      suggestedType: 'depository',
      typeFromName: false,
      suggestedMode: 'transactions',
      closeOn: null,
      closedAtZero: false,
      duplicateOf: null,
      continuedBy: null,
    };
  });
  return { transactions, balances: [], problems, monarchAccounts, owners: [] };
}

export interface WizardChoices {
  format: 'csv' | 'monarch';
  filename: string;
  profileId?: string;
  accounts: AccountChoice[];
  categories: CategoryChoice[];
  members: { name: string; memberId: string | null }[];
}

const accountMapping = (choices: AccountChoice[]) =>
  choices.map((a) =>
    a.mode === 'skip'
      ? { key: a.key, skip: true }
      : a.mode === 'combine'
        ? { key: a.key, sameAs: a.sameAs! }
        : {
            key: a.key,
            ...(a.mode === 'existing'
              ? { accountId: a.accountId! }
              : {
                  create: {
                    name: a.name.trim() || a.key,
                    type: a.type,
                    balanceMode: a.balanceMode,
                  },
                }),
            ...(a.close && a.closeOn ? { closeOn: a.closeOn } : {}),
          },
  );

const categoryMapping = (choices: CategoryChoice[]) =>
  choices.map((c) =>
    c.categoryId ? { name: c.name, categoryId: c.categoryId } : { name: c.name, kind: c.kind },
  );

/** The preview request: the whole file and every choice. */
export function previewRequest(
  choices: WizardChoices,
  rows: FileRows,
  includeOverlaps: number[] = [],
): ImportRequest {
  return {
    format: choices.format,
    filename: choices.filename,
    ...(choices.profileId ? { profileId: choices.profileId } : {}),
    accounts: accountMapping(choices.accounts),
    categories: categoryMapping(choices.categories),
    members: choices.members,
    transactions: rows.transactions,
    balances: rows.balances,
    includeOverlaps,
  };
}

export interface Progress {
  /** Accounts finished, of all accounts being imported. */
  accountsDone: number;
  accountsTotal: number;
  /** Transactions sent so far, of all. */
  rowsDone: number;
  rowsTotal: number;
  /** The account being imported now. */
  current: string | null;
}

export interface ImportState {
  run: ImportRun;
  /** Batches finished, by file account key. */
  done: Set<string>;
  added: number;
  balances: number;
  /** Transfers between your accounts linked along the way (#40). */
  transfers: number;
  rows: ImportRowResult[];
  /** Set when a part failed: the account and why. Retrying sends the rest again. */
  failed: { key: string; message: string } | null;
}

/** Starts a run: new accounts, categories, and tags, closed accounts, a batch per account. */
export async function startImport(
  householdId: string,
  choices: WizardChoices,
  rows: FileRows,
): Promise<ImportRun> {
  const used = new Set(choices.accounts.filter((a) => a.mode !== 'skip').map((a) => a.key));
  const kept = rows.transactions.filter((t) => used.has(t.account));
  const res = await api<{ data: ImportRun }>('POST', `/api/v1/households/${householdId}/imports`, {
    body: {
      format: choices.format,
      filename: choices.filename,
      ...(choices.profileId ? { profileId: choices.profileId } : {}),
      accounts: accountMapping(choices.accounts),
      categories: categoryMapping(choices.categories),
      members: choices.members,
      categoryNames: [...new Set(kept.map((t) => t.category?.trim()).filter((n) => !!n))],
      tags: [...new Set(kept.flatMap((t) => t.tags ?? []))],
    },
  });
  return res.data;
}

/**
 * Sends each account's rows in parts (a day never split), then its balances, reporting progress.
 * Accounts already in `state.done` are skipped, so calling it again after a failure retries the
 * rest; parts that did arrive are recognized as already imported.
 */
export async function sendRows(
  householdId: string,
  state: ImportState,
  rows: FileRows,
  includeOverlaps: Set<number>,
  onProgress: (p: Progress) => void,
): Promise<ImportState> {
  const next: ImportState = { ...state, done: new Set(state.done), failed: null };
  const batches = state.run.batches;
  const keys = new Set(batches.map((b) => b.key));
  const rowsTotal = rows.transactions.filter((t) => keys.has(t.account)).length;
  let rowsDone = rows.transactions.filter((t) => next.done.has(t.account)).length;
  const report = (current: string | null) =>
    onProgress({
      accountsDone: next.done.size,
      accountsTotal: batches.length,
      rowsDone,
      rowsTotal,
      current,
    });

  for (const batch of batches) {
    if (next.done.has(batch.key)) continue;
    report(batch.key);
    const mine = rows.transactions.filter((t) => t.account === batch.key);
    const parts: { transactions?: unknown[]; balances?: unknown[]; includeOverlaps?: number[] }[] =
      chunkRowsByDate(mine, IMPORT_LIMITS.rowsPerRequest).map((part) => ({
        transactions: part.map(({ account: _, ...row }) => row),
        includeOverlaps: part.filter((r) => includeOverlaps.has(r.line)).map((r) => r.line),
      }));
    const balances = rows.balances
      .filter((b) => b.account === batch.key)
      .map(({ account: _, ...b }) => b);
    if (balances.length) parts.push({ balances });
    try {
      for (const part of parts) {
        const r = await api<{ data: ImportRowsResult }>(
          'POST',
          `/api/v1/households/${householdId}/imports/${batch.batchId}/rows`,
          { body: part },
        );
        next.added += r.data.added;
        next.transfers += r.data.transfersLinked;
        next.balances += r.data.balances;
        next.rows.push(...r.data.rows.filter((x) => x.status !== 'duplicate'));
        rowsDone += part.transactions?.length ?? 0;
        report(batch.key);
      }
    } catch (err) {
      next.failed = { key: batch.key, message: (err as Error).message };
      return next;
    }
    next.done.add(batch.key);
  }
  report(null);
  return next;
}

export const undoRun = (householdId: string, runId: string) =>
  api('POST', `/api/v1/households/${householdId}/import-runs/${runId}/revert`);

export const previewImport = async (householdId: string, body: ImportRequest) =>
  (
    await api<{ data: ImportPreview }>(
      'POST',
      `/api/v1/households/${householdId}/imports/preview`,
      {
        body,
      },
    )
  ).data;

/** "1 204 new transactions, 38 already imported, 3 possible duplicates": only what's there. */
export function summarize(totals: ImportPreview['totals']): string {
  const n = (x: number) => x.toLocaleString('en-US');
  const parts = [
    `${n(totals.new)} new ${totals.new === 1 ? 'transaction' : 'transactions'}`,
    totals.duplicates ? `${n(totals.duplicates)} already imported` : '',
    totals.overlaps
      ? `${n(totals.overlaps)} possible ${totals.overlaps === 1 ? 'duplicate' : 'duplicates'}`
      : '',
    totals.skipped ? `${n(totals.skipped)} skipped` : '',
    totals.errors ? `${n(totals.errors)} with problems` : '',
  ].filter(Boolean);
  return parts.join(', ');
}

/**
 * Applies one account's new choice. Accounts combined with it go back to "new" if it no longer
 * stands on its own (skipped, or combined itself).
 */
export function chooseAccount(
  choices: AccountChoice[],
  key: string,
  patch: Partial<AccountChoice>,
): AccountChoice[] {
  const next = choices.map((c) => (c.key === key ? { ...c, ...patch } : c));
  const self = next.find((c) => c.key === key)!;
  if (self.mode === 'new' || self.mode === 'existing') return next;
  return next.map((c) =>
    c.mode === 'combine' && c.sameAs === key ? { ...c, mode: 'new', sameAs: null } : c,
  );
}

/**
 * Accounts `key` can be combined with: imported on their own, and with a history that doesn't
 * overlap it (two balances for one day can't both be right). Similar names first.
 */
export function combineTargets(choices: AccountChoice[], key: string): AccountChoice[] {
  const self = choices.find((c) => c.key === key)!;
  const overlaps = (o: AccountChoice) =>
    !!self.from && !!self.to && !!o.from && !!o.to && self.from <= o.to && o.from <= self.to;
  const name = looseName(self.key);
  const similar = (o: AccountChoice) => {
    const other = looseName(o.key);
    return other.includes(name) || name.includes(other);
  };
  return choices
    .filter((o) => o.key !== key && (o.mode === 'new' || o.mode === 'existing') && !overlaps(o))
    .sort((a, b) => Number(similar(b)) - Number(similar(a)) || a.key.localeCompare(b.key));
}

/** Accounts combined into `key`. */
export const combinedInto = (choices: AccountChoice[], key: string) =>
  choices.filter((c) => c.mode === 'combine' && c.sameAs === key);

/** Changes an account's type; bank-style accounts with transactions follow them, others are valued. */
export function withType(c: AccountChoice, type: AccountType): Partial<AccountChoice> {
  return {
    type,
    balanceMode:
      c.transactions > 0 && ['depository', 'credit', 'loan'].includes(type)
        ? 'transactions'
        : c.transactions > 0
          ? c.balanceMode
          : 'value',
  };
}

/** Applies a change to several accounts at once (bulk actions). */
export function chooseMany(
  choices: AccountChoice[],
  keys: Iterable<string>,
  patch: (c: AccountChoice) => Partial<AccountChoice>,
): AccountChoice[] {
  let next = choices;
  for (const key of keys) {
    const c = next.find((x) => x.key === key);
    if (c) next = chooseAccount(next, key, patch(c));
  }
  return next;
}

/** Days between an account's last day and the first day of the one that continues it. */
export function continuationGap(choices: AccountChoice[], c: AccountChoice): number | null {
  const next = choices.find((o) => o.key === c.continuedBy);
  if (!c.to || !next?.from) return null;
  return Math.round((Date.parse(next.from) - Date.parse(c.to)) / 86_400_000);
}
