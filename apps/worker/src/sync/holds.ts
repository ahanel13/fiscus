// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, syncHolds, transactions } from '@fiscus/db';
import type { ProviderTransaction, SyncPage } from '@fiscus/domain';
import type { HouseholdActivity } from '@fiscus/ledger';
import { addDays } from '@fiscus/shared';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { type Namer, providerColumns, rowKey } from './fields.js';
import type { SyncTarget } from './ingest.js';
import { type Arrival, reportedDate } from './match.js';

// Possible duplicates (bank connections walkthrough D7, #80): a synced transaction that looks like
// one already in the account without matching it exactly waits in `sync_holds`, outside the
// ledger, until an owner decides (the api's possible-duplicates review). Later syncs keep it as
// the bank last said it, and drop it if the bank does.

/** How many days apart the bank's date and yours may be (imports.md §4's overlap). */
export const HOLD_WINDOW_DAYS = 3;
/** The closest few are enough to choose from. */
const MAX_CANDIDATES = 5;

export type Hold = typeof syncHolds.$inferSelect;

const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** Holds by (account, provider id). */
export async function holdsByKey(tx: Executor, keys: string[]): Promise<Map<string, Hold>> {
  const unique = [...new Set(keys)].map((k) => k.split('\u0000') as [string, string]);
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(syncHolds)
    .where(
      sql`(${syncHolds.accountId}, ${syncHolds.providerTransactionId}) IN (
        SELECT * FROM unnest(${sql.param(unique.map(([a]) => a))}::uuid[],
                             ${sql.param(unique.map(([, p]) => p))}::text[]))`,
    );
  return new Map(rows.map((h) => [rowKey(h.accountId, h.providerTransactionId), h]));
}

/**
 * Holds the arrivals that look like a transaction already in their account: the same amount and
 * currency within HOLD_WINDOW_DAYS, in one that isn't the provider's (no provider id; not deleted,
 * not a split part). Exact one-to-one matches were attached before this (matchExisting), so what's
 * left is another day, or more than one like it. Pending arrivals are never held: the bank
 * replaces them. Returns the arrivals to insert, and how many were held.
 */
export async function holdPossibleDuplicates(
  tx: Executor,
  activity: HouseholdActivity,
  target: SyncTarget,
  arrivals: Arrival[],
  name: Namer,
): Promise<{ insert: Arrival[]; held: number }> {
  const posted = arrivals.filter((a) => !a.t.pending);
  if (posted.length === 0) return { insert: arrivals, held: 0 };
  const dates = posted.map((a) => reportedDate(a.t)).sort();
  const reported = sql<string>`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})`;
  const existing = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      currency: transactions.currency,
      date: sql<string>`${reported}::text`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, [...new Set(posted.map((a) => a.accountId))]),
        inArray(transactions.amountMinor, [...new Set(posted.map((a) => a.t.amountMinor))]),
        sql`${reported} BETWEEN ${addDays(dates[0]!, -HOLD_WINDOW_DAYS)}::date
            AND ${addDays(dates.at(-1)!, HOLD_WINDOW_DAYS)}::date`,
        isNull(transactions.providerTransactionId),
        ne(transactions.source, 'provider'),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
      ),
    );
  const held: { arrival: Arrival; candidateIds: string[] }[] = [];
  for (const arrival of posted) {
    const date = reportedDate(arrival.t);
    const near = existing
      .filter(
        (e) =>
          e.accountId === arrival.accountId &&
          e.amountMinor === arrival.t.amountMinor &&
          e.currency === arrival.t.currency &&
          Math.abs(days(e.date, date)) <= HOLD_WINDOW_DAYS,
      )
      .sort((x, y) => Math.abs(days(x.date, date)) - Math.abs(days(y.date, date)));
    if (near.length) {
      held.push({ arrival, candidateIds: near.slice(0, MAX_CANDIDATES).map((e) => e.id) });
    }
  }
  if (held.length === 0) return { insert: arrivals, held: 0 };

  await tx.insert(syncHolds).values(
    held.map(({ arrival: { t, accountId }, candidateIds }) => ({
      householdId: target.householdId,
      connectionId: target.connectionId,
      accountId,
      providerTransactionId: t.providerTransactionId,
      ...providerColumns(t, name),
      candidateIds,
    })),
  );
  // Counts only: what each one is waits in the review, for the account's owners.
  for (const [accountId, list] of Map.groupBy(held, (h) => h.arrival.accountId)) {
    await activity.record({
      action: 'sync.transactions_held',
      targetType: 'account',
      targetId: accountId,
      accountId,
      metadata: { connectionId: target.connectionId, count: list.length },
    });
  }
  const isHeld = new Set(held.map((h) => h.arrival));
  return { insert: arrivals.filter((a) => !isHeld.has(a)), held: held.length };
}

/** The bank said something new about a held transaction: the hold keeps its latest word. */
export async function refreshHold(
  tx: Executor,
  hold: Hold,
  t: ProviderTransaction,
  name: Namer,
): Promise<void> {
  const next = providerColumns(t, name);
  const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== hold[k]);
  if (!changed) return;
  await tx
    .update(syncHolds)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(syncHolds.id, hold.id));
}

/** Holds the bank no longer has (removed, or missing from a window), or that stopped applying. */
export async function dropHolds(tx: Executor, ids: string[]): Promise<void> {
  if (ids.length) await tx.delete(syncHolds).where(inArray(syncHolds.id, ids));
}

/** A window page's holds in its dates for the accounts it lists that it didn't return. */
export async function holdsMissingFromWindow(
  tx: Executor,
  page: SyncPage,
  accountIds: string[],
  returned: Set<string>,
): Promise<string[]> {
  if (!page.window || accountIds.length === 0) return [];
  const rows = await tx
    .select({
      id: syncHolds.id,
      accountId: syncHolds.accountId,
      providerTransactionId: syncHolds.providerTransactionId,
    })
    .from(syncHolds)
    .where(
      and(
        inArray(syncHolds.accountId, accountIds),
        sql`coalesce(${syncHolds.postedDate}, ${syncHolds.authorizedDate})
            BETWEEN ${page.window.from}::date AND ${page.window.to}::date`,
      ),
    );
  return rows
    .filter((h) => !returned.has(rowKey(h.accountId, h.providerTransactionId)))
    .map((h) => h.id);
}
