// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, connections, type Executor, households, transactions } from '@fiscus/db';
import type { ProviderTransaction, SyncPage } from '@fiscus/domain';
import {
  activeRules,
  detectTransfers,
  type HouseholdActivity,
  memberAccessLevels,
  recomputeBalances,
  runRules,
  unlinkTransfers,
  writeProviderBalances,
} from '@fiscus/ledger';
import { cleanMerchantName } from '@fiscus/shared';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { type Arrival, holdPossibleDuplicates, matchExisting, reportedDate } from './match.js';

// Bringing one page of a sync into the ledger (#80, the bank connections walkthrough D5–D9), in
// the caller's transaction, in the household's system context. Every write is recorded as
// activity by the system, for the connection's owner; nothing here logs.

type Row = typeof transactions.$inferSelect;

export interface SyncTarget {
  householdId: string;
  connectionId: string;
  /** Whose reach transfers are linked within, and who the activity is recorded for. */
  ownerMemberId: string;
}

/** What a page did, as counts: what the activity's metadata says, and what tests check. */
export interface PageResult {
  added: number;
  /** Attached to a transaction already here (D7). */
  matched: number;
  updated: number;
  removed: number;
  /** Before the account's `sync_from`, in another currency, or a posted zero. */
  skipped: number;
  balances: number;
}

interface Tracked {
  id: string;
  syncFrom: string | null;
  currency: string;
}

const CHUNK = 1000;
const chunks = <T>(list: T[]) =>
  Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) =>
    list.slice(i * CHUNK, (i + 1) * CHUNK),
  );

const rowKey = (accountId: string, providerTransactionId: string) =>
  `${accountId}\u0000${providerTransactionId}`;

/**
 * Applies one page. New transactions arrive needing review, then rules run on them with their
 * authors' reach (D9, RULE-05) and transfers are linked within the connection owner's reach;
 * changes from the bank touch only what the bank owns; removals soft-delete. Balances the page
 * reports are written last. The caller advances the cursor in the same transaction.
 */
export async function applyPage(
  tx: Executor,
  activity: HouseholdActivity,
  target: SyncTarget,
  page: SyncPage,
): Promise<PageResult> {
  const result: PageResult = {
    added: 0,
    matched: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    balances: 0,
  };
  const tracked = new Map(
    (
      await tx
        .select({
          id: accounts.id,
          providerAccountId: accounts.providerAccountId,
          syncFrom: accounts.syncFrom,
          currency: accounts.currency,
        })
        .from(accounts)
        .where(
          and(
            eq(accounts.connectionId, target.connectionId),
            isNotNull(accounts.providerAccountId),
          ),
        )
    ).map((a): [string, Tracked] => [a.providerAccountId!, a]),
  );
  const touched = new Set<string>();

  // The latest of each transaction on the page, in a tracked account; the rest are ignored.
  const incoming = new Map<string, Arrival>();
  for (const t of [...page.added, ...page.modified]) {
    const account = tracked.get(t.providerAccountId);
    if (account)
      incoming.set(rowKey(account.id, t.providerTransactionId), { t, accountId: account.id });
  }
  const removals = page.removed.flatMap((r) => {
    const account = tracked.get(r.providerAccountId);
    return account ? [rowKey(account.id, r.providerTransactionId)] : [];
  });
  const existing = await rowsByKey(tx, [...incoming.keys(), ...removals]);

  const nameFrom = await namer(tx, target.householdId);
  const fresh: Arrival[] = [];
  const updates: { row: Row; t: ProviderTransaction }[] = [];
  for (const [key, arrival] of incoming) {
    const { t } = arrival;
    const account = tracked.get(t.providerAccountId)!;
    const row = existing.get(key);
    // A provider row a person deleted stays deleted.
    if (row?.deletedAt) continue;
    if (t.currency !== account.currency || (t.amountMinor === 0 && !t.pending)) {
      result.skipped++;
    } else if (row) {
      updates.push({ row, t });
    } else if (account.syncFrom && reportedDate(t) < account.syncFrom) {
      // D6: providers send what they have (Plaid always 730 days); the account starts here.
      result.skipped++;
    } else {
      fresh.push(arrival);
    }
  }

  // D7: one you already have gets the bank's id instead of a copy.
  const { attached, rest } = await matchExisting(tx, fresh);
  for (const { arrival, transactionId } of attached) {
    await tx
      .update(transactions)
      .set({
        providerTransactionId: arrival.t.providerTransactionId,
        version: sql`${transactions.version} + 1`,
      })
      .where(eq(transactions.id, transactionId));
  }
  for (const [accountId, list] of Map.groupBy(attached, (a) => a.arrival.accountId)) {
    await activity.record({
      action: 'sync.transactions_matched',
      targetType: 'account',
      targetId: accountId,
      accountId,
      metadata: { connectionId: target.connectionId, count: list.length },
      transactionIds: list.map((a) => a.transactionId),
    });
  }
  result.matched = attached.length;

  const inserted = await insertArrivals(
    tx,
    activity,
    target,
    await holdPossibleDuplicates(tx, rest),
    nameFrom,
  );
  result.added = inserted.length;
  for (const r of inserted) touched.add(r.accountId);
  if (inserted.length) {
    const ids = inserted.map((r) => r.id);
    // As on import: the household's rules, then each owner's, within each author's reach (D9).
    await runRules(
      tx,
      target.householdId,
      await tx.select().from(transactions).where(inArray(transactions.id, ids)),
      await activeRules(tx),
      null,
      activity,
    );
    // Within the owner's reach: sync never links across a line they couldn't (#80).
    await detectTransfers(
      tx,
      activity,
      ids,
      await memberAccessLevels(tx, target.ownerMemberId),
      true,
    );
  }

  for (const { row, t } of updates) {
    if (await applyChange(tx, activity, row, t, nameFrom)) {
      result.updated++;
      touched.add(row.accountId);
    }
  }

  const dropped = removals.flatMap((key) => {
    const row = existing.get(key);
    return row && !row.deletedAt ? [row] : [];
  });
  if (page.mode === 'window' && page.window) {
    dropped.push(...(await missingFromWindow(tx, page, tracked)));
  }
  for (const row of dropped) touched.add(row.accountId);
  result.removed = await drop(tx, activity, dropped);

  if (page.balances?.length) {
    result.balances = (await writeProviderBalances(tx, target.connectionId, page.balances)).written;
  }
  for (const accountId of touched) await recomputeBalances(tx, accountId);
  return result;
}

/** Advances the connection past a page, in the page's transaction. */
export async function advanceConnection(
  tx: Executor,
  connectionId: string,
  page: SyncPage,
): Promise<void> {
  const cursor = page.mode === 'delta' && page.nextCursor !== null;
  if (!cursor && !page.historicalComplete) return;
  await tx
    .update(connections)
    .set({
      ...(cursor && { syncCursor: page.nextCursor }),
      ...(page.historicalComplete && { historicalComplete: true }),
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connectionId));
}

/** Existing transactions by (account, provider id), deleted ones included. */
async function rowsByKey(tx: Executor, keys: string[]): Promise<Map<string, Row>> {
  const unique = [...new Set(keys)].map((k) => k.split('\u0000') as [string, string]);
  const out = new Map<string, Row>();
  for (const part of chunks(unique)) {
    const rows = await tx
      .select()
      .from(transactions)
      .where(
        sql`(${transactions.accountId}, ${transactions.providerTransactionId}) IN (
          SELECT * FROM unnest(${sql.param(part.map(([a]) => a))}::uuid[],
                               ${sql.param(part.map(([, p]) => p))}::text[]))`,
      );
    for (const r of rows) out.set(rowKey(r.accountId, r.providerTransactionId!), r);
  }
  return out;
}

/** The name a synced transaction gets: the bank's merchant name, or its cleaned-up text (#42). */
async function namer(tx: Executor, householdId: string) {
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
type Namer = Awaited<ReturnType<typeof namer>>;

/** New transactions: the provider's, needing review. One activity entry per account. */
async function insertArrivals(
  tx: Executor,
  activity: HouseholdActivity,
  target: SyncTarget,
  arrivals: Arrival[],
  name: Namer,
): Promise<{ id: string; accountId: string }[]> {
  const inserted: { id: string; accountId: string }[] = [];
  for (const part of chunks(arrivals)) {
    inserted.push(
      ...(await tx
        .insert(transactions)
        .values(
          part.map(({ t, accountId }) => ({
            householdId: target.householdId,
            accountId,
            amountMinor: t.amountMinor,
            currency: t.currency,
            postedDate: t.postedDate ?? null,
            authorizedDate: t.authorizedDate,
            pending: t.pending,
            originalDescription: t.description.trim() || t.merchantName?.trim() || '',
            displayName: name.of(t),
            reviewStatus: 'needs_review' as const,
            source: 'provider' as const,
            providerTransactionId: t.providerTransactionId,
            providerPendingId: t.pendingTransactionId ?? null,
            foreignAmountMinor: t.foreignAmountMinor ?? null,
            foreignCurrency: t.foreignCurrency ?? null,
          })),
        )
        .returning({ id: transactions.id, accountId: transactions.accountId })),
    );
  }
  // Recorded before rules and transfers run, so each one's history starts with arriving (#46).
  for (const [accountId, list] of Map.groupBy(inserted, (r) => r.accountId)) {
    await activity.record({
      action: 'sync.transactions_added',
      targetType: 'account',
      targetId: accountId,
      accountId,
      metadata: { connectionId: target.connectionId, count: list.length },
      transactionIds: list.map((r) => r.id),
    });
  }
  return inserted;
}

/**
 * What the bank changed about a transaction: only what it owns (the amount, its dates, pending,
 * its text, the foreign amount), never what a person set (field_versions) or a date override. The
 * name follows the bank's text only while it's still the name that text gave. A transfer whose
 * amount changed is unlinked: its legs no longer match. Returns whether anything changed.
 */
async function applyChange(
  tx: Executor,
  activity: HouseholdActivity,
  row: Row,
  t: ProviderTransaction,
  name: Namer,
): Promise<boolean> {
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
  const set: Partial<typeof next & { displayName: string }> = {};
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
  if (Object.keys(set).length === 0) return false;
  await tx
    .update(transactions)
    .set({ ...set, version: sql`${transactions.version} + 1` })
    .where(eq(transactions.id, row.id));
  if (set.amountMinor !== undefined && row.transferGroupId) {
    await unlinkTransfers(tx, activity, [row.transferGroupId], 'bank_changed');
  }

  // For the history: the fields as a person reads them; the bank's date is the date it reports.
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const note = (field: string, from: unknown, to: unknown) => {
    if (from === to) return;
    before[field] = from;
    after[field] = to;
  };
  note('amountMinor', row.amountMinor, set.amountMinor ?? row.amountMinor);
  note(
    'date',
    reportedDate({ postedDate: row.postedDate ?? undefined, authorizedDate: row.authorizedDate }),
    reportedDate({
      postedDate: (set.postedDate === undefined ? row.postedDate : set.postedDate) ?? undefined,
      authorizedDate: set.authorizedDate ?? row.authorizedDate,
    }),
  );
  note('pending', row.pending, set.pending ?? row.pending);
  note('displayName', row.displayName, set.displayName ?? row.displayName);
  note(
    'originalDescription',
    row.originalDescription,
    set.originalDescription ?? row.originalDescription,
  );
  note(
    'foreignAmountMinor',
    row.foreignAmountMinor,
    set.foreignAmountMinor === undefined ? row.foreignAmountMinor : set.foreignAmountMinor,
  );
  await activity.record({
    action: 'transaction.provider_updated',
    targetType: 'transaction',
    targetId: row.id,
    accountId: row.accountId,
    metadata: { fields: Object.keys(after) },
    changes: { before, after },
    transactionIds: [row.id],
  });
  return true;
}

/**
 * A window page is everything in its dates for the accounts it lists: the provider's rows there
 * that it didn't return are gone at the bank (SimpleFIN never says so otherwise).
 */
async function missingFromWindow(
  tx: Executor,
  page: SyncPage,
  tracked: Map<string, Tracked>,
): Promise<Row[]> {
  const window = page.window!;
  const accountIds = window.providerAccountIds.flatMap((p) => {
    const account = tracked.get(p);
    return account ? [account.id] : [];
  });
  if (accountIds.length === 0) return [];
  const returned = new Set(
    page.added.flatMap((t) => {
      const account = tracked.get(t.providerAccountId);
      return account ? [rowKey(account.id, t.providerTransactionId)] : [];
    }),
  );
  const reported = sql`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})`;
  const rows = await tx
    .select()
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, accountIds),
        isNotNull(transactions.providerTransactionId),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
        sql`${reported} BETWEEN ${window.from}::date AND ${window.to}::date`,
      ),
    );
  return rows.filter((r) => !returned.has(rowKey(r.accountId, r.providerTransactionId!)));
}

/**
 * Transactions the bank removed. The provider's own are soft-deleted, their split parts with
 * them, and a transfer they were in is unlinked. One that was yours before the bank's id was
 * attached to it (D7) stays yours: it lets go of the id instead. Returns how many.
 */
async function drop(tx: Executor, activity: HouseholdActivity, rows: Row[]): Promise<number> {
  const seen = new Set<string>();
  let count = 0;
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const kept = row.source !== 'provider';
    let ids = [row.id];
    if (kept) {
      await tx
        .update(transactions)
        .set({ providerTransactionId: null, version: sql`${transactions.version} + 1` })
        .where(eq(transactions.id, row.id));
    } else {
      ids = (
        await tx
          .update(transactions)
          .set({ deletedAt: new Date(), version: sql`${transactions.version} + 1` })
          .where(or(eq(transactions.id, row.id), eq(transactions.parentId, row.id)))
          .returning({ id: transactions.id })
      ).map((r) => r.id);
      if (row.transferGroupId) {
        await unlinkTransfers(tx, activity, [row.transferGroupId], 'deleted');
      }
    }
    await activity.record({
      action: 'transaction.provider_removed',
      targetType: 'transaction',
      targetId: row.id,
      accountId: row.accountId,
      metadata: { kept },
      transactionIds: ids,
    });
    count++;
  }
  return count;
}
