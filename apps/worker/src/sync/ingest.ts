// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import { accounts, connections, type Executor, transactions } from '@fiscus/db';
import type {
  ProviderAccount,
  ProviderBalance,
  ProviderRemovedTransaction,
  ProviderTransaction,
  SyncPage,
} from '@fiscus/domain';
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
import type { AccessLevel } from '@fiscus/shared';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { bankChanges, type Namer, namer, type Row, rowKey } from './fields.js';
import { type Arrival, holdPossibleDuplicates, matchExisting, reportedDate } from './match.js';
import { mergePosted, postedInWindow, postPending, removedByBank } from './pending.js';

// Bringing a sync's pages into the ledger (#80, the bank connections walkthrough D5–D9), merged
// into one and applied in the caller's transaction, in the household's system context. Every
// write is recorded as activity by the system, for the connection's owner; nothing here logs.

export interface SyncTarget {
  householdId: string;
  connectionId: string;
  /** Whose reach transfers are linked within, and who the activity is recorded for. */
  ownerMemberId: string;
}

export interface IngestOptions {
  /** Posted transactions name the pending one they replace (`capabilities.pendingLinks`). */
  pendingLinks: boolean;
  /** For a shared note that moves when a pending transaction posts (#88). */
  crypto: FieldCrypto;
}

/** What a sync did, as counts: what the activity's metadata says, and what tests check. */
export interface PageResult {
  added: number;
  /** Attached to a transaction already here (D7). */
  matched: number;
  updated: number;
  /** Pending transactions that became their posted ones (#88). */
  posted: number;
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

/** A pending transaction the posted one can still become: live, or removed by the bank. */
const revivable = (r: Row) => !r.deletedAt || removedByBank(r);

/**
 * Applies a sync's pages, merged by mergePages. New transactions arrive needing review, then rules run on them with their
 * authors' reach (D9, RULE-05) and transfers are linked within the connection owner's reach;
 * changes from the bank touch only what the bank owns; a pending transaction that posted becomes
 * the posted one, keeping everything a person did (#88); removals soft-delete. Balances the pages
 * report are written last. The caller advances the cursor in the same transaction.
 */
export async function applyPage(
  tx: Executor,
  activity: HouseholdActivity,
  target: SyncTarget,
  page: SyncPage,
  options: IngestOptions,
): Promise<PageResult> {
  const result: PageResult = {
    added: 0,
    matched: 0,
    updated: 0,
    posted: 0,
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
  let reach: Map<string, AccessLevel> | undefined;
  // Within the owner's reach: sync never links across a line they couldn't (#80).
  const ownerReach = async () => (reach ??= await memberAccessLevels(tx, target.ownerMemberId));

  // The latest of each transaction, in a tracked account; the rest are ignored.
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
  // A posted transaction naming the pending one it replaces (Plaid's link, #88).
  const replaces = (a: Arrival) =>
    !a.t.pending && a.t.pendingTransactionId
      ? rowKey(a.accountId, a.t.pendingTransactionId)
      : undefined;
  const replaced = new Set([...incoming.values()].flatMap((a) => replaces(a) ?? []));
  const existing = await rowsByKey(tx, [...incoming.keys(), ...removals, ...replaced]);
  const postedAlready = await pendingIdsPosted(
    tx,
    [...incoming].flatMap(([key, a]) => (a.t.pending ? [key] : [])),
  );

  const nameFrom = await namer(tx, target.householdId);
  const fresh: Arrival[] = [];
  const updates: { row: Row; t: ProviderTransaction }[] = [];
  const promotions: { row: Row; t: ProviderTransaction }[] = [];
  const merges: { pending: Row; posted: Row; t: ProviderTransaction }[] = [];
  const claimed = new Set<string>();
  for (const [key, arrival] of incoming) {
    const { t } = arrival;
    const account = tracked.get(t.providerAccountId)!;
    // It posted already, or posts in this sync: the pending version is history (#88).
    if (t.pending && (replaced.has(key) || postedAlready.has(key))) continue;
    const row = existing.get(key);
    // A provider row a person deleted stays deleted.
    if (row?.deletedAt) continue;
    const named = existing.get(replaces(arrival) ?? '');
    const pending = named?.pending && !named.parentId && !claimed.has(named.id) ? named : undefined;
    if (t.currency !== account.currency || (t.amountMinor === 0 && !t.pending)) {
      result.skipped++;
    } else if (row && pending && pending.id !== row.id && revivable(pending)) {
      // Here twice: the posted one on its own, and the pending one it replaces.
      claimed.add(pending.id);
      merges.push({ pending, posted: row, t });
    } else if (row) {
      updates.push({ row, t });
    } else if (pending) {
      // Promoted in place, deleted or not: one a person deleted stays deleted, as the posted one.
      claimed.add(pending.id);
      promotions.push({ row: pending, t });
    } else if (account.syncFrom && reportedDate(t) < account.syncFrom) {
      // D6: providers send what they have (Plaid always 730 days); the account starts here.
      result.skipped++;
    } else {
      fresh.push(arrival);
    }
  }

  // Without links (SimpleFIN), a pending transaction a window no longer returns may have posted:
  // matched before the window's missing rows are dropped, and before D7 could take its posted one.
  if (!options.pendingLinks && page.mode === 'window' && page.window) {
    const { accountIds, returned } = windowScope(page, tracked);
    for (const m of await postedInWindow(tx, page.window, accountIds, returned, fresh)) {
      if (m.arrival) {
        fresh.splice(fresh.indexOf(m.arrival), 1);
        promotions.push({ row: m.pending, t: m.arrival.t });
      } else {
        const posted = m.posted!;
        const at = updates.findIndex((u) => u.row.id === posted.id);
        if (at === -1) continue;
        merges.push({ pending: m.pending, posted, t: updates[at]!.t });
        updates.splice(at, 1);
      }
    }
  }

  // Pending → posted (#88): everything a person did stays, and rules don't run again. Pending
  // transactions are never linked as transfers, so detection runs once they've posted.
  const settled = new Set<string>();
  const redetect: string[] = [];
  for (const { row, t } of promotions) {
    settled.add(row.id);
    if (await postPending(tx, activity, row, t, nameFrom)) redetect.push(row.id);
    touched.add(row.accountId);
    result.posted++;
  }
  for (const { pending, posted, t } of merges) {
    settled.add(pending.id).add(posted.id);
    if (await mergePosted(tx, activity, options.crypto, pending, posted, t, nameFrom)) {
      redetect.push(pending.id);
    }
    touched.add(pending.accountId);
    result.posted++;
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
    await detectTransfers(tx, activity, ids, await ownerReach(), true);
  }

  for (const { row, t } of updates) {
    if (await applyChange(tx, activity, row, t, nameFrom)) {
      result.updated++;
      touched.add(row.accountId);
      // Posted under the same id (SimpleFIN may keep it): now it can be a transfer.
      if (row.pending && !t.pending) redetect.push(row.id);
    }
  }
  if (redetect.length) await detectTransfers(tx, activity, redetect, await ownerReach(), true);

  // What posted in this sync isn't removed with its pending id.
  const dropped = removals.flatMap((key) => {
    const row = existing.get(key);
    return row && !row.deletedAt && !settled.has(row.id) ? [row] : [];
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

/**
 * A sync's pages as one, in order: a transaction's latest word wins, whether that's an add, a
 * change or a removal, so a pending transaction removed on one page and its posted version added
 * on another are seen together and reconciled (#88). The cursor and `historicalComplete` are the
 * last page's (the latter as soon as any page says so); balances and accounts the latest each.
 * A `window` page is the only one its sync has.
 */
export function mergePages(pages: SyncPage[]): SyncPage {
  const last = pages.at(-1);
  if (!last) throw new Error('A sync has at least one page');
  if (pages.length === 1) return last;
  const key = (t: { providerAccountId: string; providerTransactionId: string }) =>
    rowKey(t.providerAccountId, t.providerTransactionId);
  const latest = new Map<
    string,
    | { kind: 'added' | 'modified'; t: ProviderTransaction }
    | { kind: 'removed'; r: ProviderRemovedTransaction }
  >();
  const balances = new Map<string, ProviderBalance>();
  const accountsSeen = new Map<string, ProviderAccount>();
  for (const page of pages) {
    for (const t of page.added) latest.set(key(t), { kind: 'added', t });
    for (const t of page.modified) latest.set(key(t), { kind: 'modified', t });
    for (const r of page.removed) latest.set(key(r), { kind: 'removed', r });
    for (const b of page.balances ?? []) balances.set(b.providerAccountId, b);
    for (const a of page.accounts ?? []) accountsSeen.set(a.providerAccountId, a);
  }
  const merged: SyncPage = { ...last, added: [], modified: [], removed: [] };
  for (const entry of latest.values()) {
    if (entry.kind === 'removed') merged.removed.push(entry.r);
    else merged[entry.kind].push(entry.t);
  }
  if (balances.size) merged.balances = [...balances.values()];
  if (accountsSeen.size) merged.accounts = [...accountsSeen.values()];
  if (pages.some((p) => p.historicalComplete)) merged.historicalComplete = true;
  return merged;
}

/** Advances the connection past a sync's pages, in the transaction that applied them. */
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

const unnestKeys = (part: [string, string][]) =>
  sql`SELECT * FROM unnest(${sql.param(part.map(([a]) => a))}::uuid[],
                           ${sql.param(part.map(([, p]) => p))}::text[])`;

/** Existing transactions by (account, provider id), deleted ones included. */
async function rowsByKey(tx: Executor, keys: string[]): Promise<Map<string, Row>> {
  const unique = [...new Set(keys)].map((k) => k.split('\u0000') as [string, string]);
  const out = new Map<string, Row>();
  for (const part of chunks(unique)) {
    const rows = await tx
      .select()
      .from(transactions)
      .where(
        sql`(${transactions.accountId}, ${transactions.providerTransactionId}) IN (${unnestKeys(part)})`,
      );
    for (const r of rows) out.set(rowKey(r.accountId, r.providerTransactionId!), r);
  }
  return out;
}

/** Of these (account, pending id) keys, the ones a transaction here already posted from (#88). */
async function pendingIdsPosted(tx: Executor, keys: string[]): Promise<Set<string>> {
  const unique = [...new Set(keys)].map((k) => k.split('\u0000') as [string, string]);
  const out = new Set<string>();
  for (const part of chunks(unique)) {
    const rows = await tx
      .select({ accountId: transactions.accountId, pendingId: transactions.providerPendingId })
      .from(transactions)
      .where(
        sql`(${transactions.accountId}, ${transactions.providerPendingId}) IN (${unnestKeys(part)})`,
      );
    for (const r of rows) out.add(rowKey(r.accountId, r.pendingId!));
  }
  return out;
}

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
 * What the bank changed about a transaction (bankChanges): only what it owns. A transfer whose
 * amount changed is unlinked: its legs no longer match. Returns whether anything changed.
 */
async function applyChange(
  tx: Executor,
  activity: HouseholdActivity,
  row: Row,
  t: ProviderTransaction,
  name: Namer,
): Promise<boolean> {
  const { set, before, after } = bankChanges(row, t, name);
  if (Object.keys(set).length === 0) return false;
  await tx
    .update(transactions)
    .set({ ...set, version: sql`${transactions.version} + 1` })
    .where(eq(transactions.id, row.id));
  if (set.amountMinor !== undefined && row.transferGroupId) {
    await unlinkTransfers(tx, activity, [row.transferGroupId], 'bank_changed');
  }
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

/** The accounts a window page covers, and the transactions it returned in them. */
function windowScope(page: SyncPage, tracked: Map<string, Tracked>) {
  const accountIds = page.window!.providerAccountIds.flatMap((p) => {
    const account = tracked.get(p);
    return account ? [account.id] : [];
  });
  const returned = new Set(
    page.added.flatMap((t) => {
      const account = tracked.get(t.providerAccountId);
      return account ? [rowKey(account.id, t.providerTransactionId)] : [];
    }),
  );
  return { accountIds, returned };
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
  const { accountIds, returned } = windowScope(page, tracked);
  if (accountIds.length === 0) return [];
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
 * them, and a transfer they were in is unlinked; `provider_removed_at` says the bank did it, so a
 * pending one can still come back as its posted version in a later sync (#88). One that was yours
 * before the bank's id was attached to it (D7) stays yours: it lets go of the id instead. Returns
 * how many.
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
      const at = new Date();
      ids = (
        await tx
          .update(transactions)
          .set({
            deletedAt: at,
            providerRemovedAt: at,
            version: sql`${transactions.version} + 1`,
          })
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
