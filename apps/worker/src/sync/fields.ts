// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, households, transactions } from '@fiscus/db';
import type { ProviderTransaction } from '@fiscus/domain';
import { cleanMerchantName } from '@fiscus/shared';
import { eq } from 'drizzle-orm';
import { reportedDate } from './match.js';

// What the bank owns about a synced transaction, and what changes when it says something new
// about one (#80, #88).

export type Row = typeof transactions.$inferSelect;

/** A synced transaction's identity: its account and the provider's id. */
export const rowKey = (accountId: string, providerTransactionId: string) =>
  `${accountId}\u0000${providerTransactionId}`;

/** The name a synced transaction gets: the bank's merchant name, or its cleaned-up text (#42). */
export async function namer(tx: Executor, householdId: string) {
  const [household] = await tx
    .select({ clean: households.cleanMerchantNames })
    .from(households)
    .where(eq(households.id, householdId));
  const fromDescription = (description: string) =>
    household?.clean === false ? description.trim() : cleanMerchantName(description);
  return {
    fromDescription,
    of: (t: ProviderTransaction) =>
      t.merchantName?.trim() || fromDescription(t.description) || t.description.trim(),
  };
}
export type Namer = Awaited<ReturnType<typeof namer>>;

/**
 * A new synced transaction's columns, as the bank sent it: what a new row gets, and what a
 * possible duplicate keeps while it waits (#80).
 */
export const providerColumns = (t: ProviderTransaction, name: Namer) => ({
  amountMinor: t.amountMinor,
  currency: t.currency,
  postedDate: t.postedDate ?? null,
  authorizedDate: t.authorizedDate,
  originalDescription: t.description.trim() || t.merchantName?.trim() || '',
  displayName: name.of(t),
  providerPendingId: t.pendingTransactionId ?? null,
  foreignAmountMinor: t.foreignAmountMinor ?? null,
  foreignCurrency: t.foreignCurrency ?? null,
});

type BankFields = Pick<
  Row,
  | 'amountMinor'
  | 'postedDate'
  | 'authorizedDate'
  | 'pending'
  | 'originalDescription'
  | 'foreignAmountMinor'
  | 'foreignCurrency'
  | 'displayName'
>;

export interface BankChanges {
  /** The columns to write: only what differs, and never what a person set. */
  set: Partial<BankFields>;
  /** The fields as a person reads them, for the history: the bank's date is the date it reports. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * What the bank's latest word on a transaction changes: only what it owns (the amount, its dates,
 * pending, its text, the foreign amount), never what a person set (field_versions) or a date
 * override. The name follows the bank's text only while it's still the name that text gave.
 */
export function bankChanges(row: Row, t: ProviderTransaction, name: Namer): BankChanges {
  const personSet = new Set(Object.keys(row.fieldVersions));
  const description = t.description.trim() || row.originalDescription;
  const next = {
    amountMinor: t.amountMinor,
    postedDate: t.postedDate ?? null,
    authorizedDate: t.authorizedDate,
    pending: t.pending,
    originalDescription: description,
    foreignAmountMinor: t.foreignAmountMinor ?? null,
    foreignCurrency: t.foreignCurrency ?? null,
  };
  const set: Partial<BankFields> = {};
  for (const field of Object.keys(next) as (keyof typeof next)[]) {
    if (next[field] !== row[field] && !personSet.has(field))
      Object.assign(set, { [field]: next[field] });
  }
  if (
    !personSet.has('displayName') &&
    row.displayName === name.fromDescription(row.originalDescription) &&
    description !== row.originalDescription
  ) {
    const renamed = name.of(t);
    if (renamed !== row.displayName) set.displayName = renamed;
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    if (from === to) return;
    before[field] = from;
    after[field] = to;
  };
  const now = <K extends keyof BankFields>(field: K): BankFields[K] =>
    set[field] === undefined ? row[field] : (set[field] as BankFields[K]);
  note('amountMinor', row.amountMinor, now('amountMinor'));
  note(
    'date',
    reportedDate({ postedDate: row.postedDate ?? undefined, authorizedDate: row.authorizedDate }),
    reportedDate({
      postedDate: now('postedDate') ?? undefined,
      authorizedDate: now('authorizedDate'),
    }),
  );
  note('pending', row.pending, now('pending'));
  note('displayName', row.displayName, now('displayName'));
  note('originalDescription', row.originalDescription, now('originalDescription'));
  note('foreignAmountMinor', row.foreignAmountMinor, now('foreignAmountMinor'));
  return { set, before, after };
}
