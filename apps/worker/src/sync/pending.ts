// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FieldCrypto } from '@fiscus/crypto';
import { type Executor, transactionAttributions, transactionNotes, transactions } from '@fiscus/db';
import type { ProviderTransaction, SyncWindow } from '@fiscus/domain';
import { type HouseholdActivity, unlinkTransfers } from '@fiscus/ledger';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { bankChanges, type Namer, type Row, rowKey } from './fields.js';
import { type Arrival, reportedDate } from './match.js';

// Pending → posted (#88, #47, the bank connections walkthrough D8): when a pending transaction
// posts, the transaction you've been editing becomes the posted one, so every edit, note, tag,
// attribution and history entry stays with it. Plaid says which pending transaction a posted one
// replaces; for SimpleFIN, which doesn't, the posted one is recognized by its amount and date.

/** How far apart a pending transaction and its posted version may be dated, without a link. */
export const POSTED_WITHIN_DAYS = 5;

const DAY_MS = 86_400_000;

const rowDate = (r: Row) =>
  reportedDate({ postedDate: r.postedDate ?? undefined, authorizedDate: r.authorizedDate });

/** A tombstone the bank made (sync's removals set both at once), not one a person did. */
export const removedByBank = (row: Row) =>
  row.deletedAt !== null &&
  row.providerRemovedAt !== null &&
  row.deletedAt.getTime() === row.providerRemovedAt.getTime();

/** The fields a posting changed, as the history shows them; that it posted is the entry itself. */
const shownFields = (after: Record<string, unknown>) =>
  Object.keys(after).filter((f) => f !== 'pending');

/** The amount and both dates before and after, always: what it was while pending (#88). */
function postedChanges(
  from: Row,
  to: Pick<Row, 'amountMinor' | 'postedDate' | 'authorizedDate'>,
  before: Record<string, unknown> = {},
  after: Record<string, unknown> = {},
) {
  return {
    before: {
      ...before,
      amountMinor: from.amountMinor,
      postedDate: from.postedDate,
      authorizedDate: from.authorizedDate,
    },
    after: {
      ...after,
      amountMinor: to.amountMinor,
      postedDate: to.postedDate,
      authorizedDate: to.authorizedDate,
    },
  };
}

/**
 * Promotes a pending transaction in place: it takes the posted id, keeps its old one as
 * `provider_pending_id`, and gets what the bank owns (the amount, its dates, its text), never
 * what a person set. Nothing else moves, and rules don't run again. One the bank had removed in
 * an earlier sync comes back as the posted one, its split parts with it; one a person deleted
 * takes the posted id and stays deleted, so the posted version can't arrive on its own. Returns
 * whether it's live.
 */
export async function postPending(
  tx: Executor,
  activity: HouseholdActivity,
  row: Row,
  t: ProviderTransaction,
  name: Namer,
  merge?: { merged: Row; carried: string[] },
): Promise<boolean> {
  const revived = removedByBank(row);
  const live = row.deletedAt === null || revived;
  const { set, before, after } = bankChanges(row, t, name);
  await tx
    .update(transactions)
    .set({
      ...set,
      pending: false,
      providerTransactionId: t.providerTransactionId,
      providerPendingId: row.providerTransactionId,
      ...(revived && { deletedAt: null, providerRemovedAt: null }),
      version: sql`${transactions.version} + 1`,
    })
    .where(eq(transactions.id, row.id));
  if (revived) {
    await tx
      .update(transactions)
      .set({ deletedAt: null, version: sql`${transactions.version} + 1` })
      .where(and(eq(transactions.parentId, row.id), eq(transactions.deletedAt, row.deletedAt!)));
  }
  if (live && set.amountMinor !== undefined && row.transferGroupId) {
    await unlinkTransfers(tx, activity, [row.transferGroupId], 'bank_changed');
  }
  await activity.record({
    action: 'transaction.posted',
    targetType: 'transaction',
    targetId: row.id,
    accountId: row.accountId,
    metadata: {
      fields: shownFields(after),
      ...(revived && { revived: true }),
      ...(!live && { deleted: true }),
      ...(merge && { merged: true, carried: merge.carried }),
    },
    changes: postedChanges(
      row,
      {
        amountMinor: set.amountMinor ?? row.amountMinor,
        postedDate: set.postedDate === undefined ? row.postedDate : set.postedDate,
        authorizedDate: set.authorizedDate ?? row.authorizedDate,
      },
      before,
      after,
    ),
    transactionIds: merge ? [row.id, merge.merged.id] : [row.id],
  });
  return live;
}

/** What a person can set on a transaction (their `field_versions` keys), as its columns. */
const PERSON_COLUMNS: Record<string, (keyof Row)[]> = {
  displayName: ['displayName'],
  categoryId: ['categoryId'],
  reviewStatus: ['reviewStatus'],
  excluded: ['excluded'],
  isBusiness: ['isBusiness'],
  transferExternal: ['transferExternal'],
  date: ['dateOverride'],
};

const noteContext = (householdId: string, transactionId: string, author: string | null) => ({
  householdId,
  table: 'transaction_notes',
  column: 'body_enc',
  rowId: `${transactionId}:${author ?? 'shared'}`,
});

/** A posted transaction as it's stored, in the bank's terms, for promoting to it. */
export const asPosted = (r: Row, providerAccountId: string): ProviderTransaction => ({
  providerTransactionId: r.providerTransactionId!,
  providerAccountId,
  amountMinor: r.amountMinor,
  currency: r.currency,
  pending: false,
  ...(r.postedDate !== null && { postedDate: r.postedDate }),
  authorizedDate: r.authorizedDate,
  description: r.originalDescription,
  ...(r.foreignAmountMinor !== null && { foreignAmountMinor: r.foreignAmountMinor }),
  ...(r.foreignCurrency !== null && { foreignCurrency: r.foreignCurrency }),
});

/**
 * The fallback, when the posted transaction is already here on its own (its events came in
 * another order, or a separate sync brought it): the two become one. The pending one is still the
 * one that stays, promoted to the posted id as postPending does, because its private notes can
 * only stay with it (a note is sealed to its transaction and readable only by its author, not by
 * sync). The separate copy, there for a sync or so, is tombstoned without the bank's id, and what
 * was done to it fills in what the pending one lacks: each field a person set there and not here,
 * its attribution, its split, its shared note and its history, and all its tags. A private note
 * on the copy stays with the copy, and a transfer it was in is unlinked (detection runs on the
 * promoted one). Returns whether the promoted one is live.
 */
export async function mergePosted(
  tx: Executor,
  activity: HouseholdActivity,
  crypto: FieldCrypto,
  pending: Row,
  posted: Row,
  t: ProviderTransaction,
  name: Namer,
): Promise<boolean> {
  const householdId = pending.householdId;
  const ours = new Set(Object.keys(pending.fieldVersions));
  const carried = Object.keys(posted.fieldVersions).filter((f) => !ours.has(f));
  const sharedNotes = await tx
    .select()
    .from(transactionNotes)
    .where(
      and(
        inArray(transactionNotes.transactionId, [pending.id, posted.id]),
        isNull(transactionNotes.authorMemberId),
      ),
    );

  // The copy lets go of the bank's id first: it's unique per account.
  await tx
    .update(transactions)
    .set({
      deletedAt: new Date(),
      providerTransactionId: null,
      version: sql`${transactions.version} + 1`,
    })
    .where(eq(transactions.id, posted.id));
  if (posted.transferGroupId) {
    await unlinkTransfers(tx, activity, [posted.transferGroupId], 'deleted');
  }

  const columns: Partial<Row> = {};
  for (const field of carried) {
    for (const column of PERSON_COLUMNS[field] ?? []) {
      Object.assign(columns, { [column]: posted[column] });
    }
  }
  const split = posted.hasSplits && !pending.hasSplits;
  if (carried.length || split) {
    await tx
      .update(transactions)
      .set({
        ...columns,
        ...(split && { hasSplits: true }),
        ...(carried.length && {
          fieldVersions: sql`${transactions.fieldVersions} || jsonb_build_object(${sql.join(
            carried.map((f) => sql`${f}::text, ${transactions.version} + 1`),
            sql`, `,
          )})`,
        }),
        version: sql`${transactions.version} + 1`,
      })
      .where(eq(transactions.id, pending.id));
  }
  if (split) {
    // Its parts move over whole; the parent's own attribution is the parts' now.
    await tx
      .update(transactions)
      .set({ parentId: pending.id, version: sql`${transactions.version} + 1` })
      .where(eq(transactions.parentId, posted.id));
    await tx
      .delete(transactionAttributions)
      .where(eq(transactionAttributions.transactionId, pending.id));
  }
  // Tags add up: each one is something a person chose, and none of them is lost.
  await tx.execute(sql`
    INSERT INTO transaction_tags (transaction_id, tag_id, household_id)
    SELECT ${pending.id}::uuid, tag_id, household_id FROM transaction_tags
    WHERE transaction_id = ${posted.id}::uuid
    ON CONFLICT DO NOTHING`);
  if (!ours.has('attribution') && !pending.hasSplits && !split) {
    const shares = await tx
      .select()
      .from(transactionAttributions)
      .where(inArray(transactionAttributions.transactionId, [pending.id, posted.id]));
    const theirs = shares.filter((s) => s.transactionId === posted.id);
    if (theirs.length && !shares.some((s) => s.transactionId === pending.id)) {
      await tx
        .insert(transactionAttributions)
        .values(theirs.map((s) => ({ ...s, transactionId: pending.id })));
    }
  }
  // A note is sealed to its transaction: the shared one moves by being sealed again.
  const note = sharedNotes.find((n) => n.transactionId === posted.id);
  if (note && !sharedNotes.some((n) => n.transactionId === pending.id)) {
    const body = await crypto.decrypt(noteContext(householdId, posted.id, null), note.bodyEnc);
    await tx.insert(transactionNotes).values({
      householdId,
      transactionId: pending.id,
      authorMemberId: null,
      bodyEnc: await crypto.encrypt(noteContext(householdId, pending.id, null), body),
      updatedByMemberId: note.updatedByMemberId,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    });
    await tx.delete(transactionNotes).where(eq(transactionNotes.id, note.id));
  }
  // The copy's history becomes part of this one's: the same entries, linked here too (#46).
  await tx.execute(sql`
    INSERT INTO activity_transactions (household_id, seq, transaction_id)
    SELECT household_id, seq, ${pending.id}::uuid FROM activity_transactions
    WHERE household_id = ${householdId}::uuid AND transaction_id = ${posted.id}::uuid
    ON CONFLICT DO NOTHING`);

  return postPending(tx, activity, pending, t, name, { merged: posted, carried });
}

/** A pending transaction gone from a window, and the posted one it became. */
export interface WindowPosting {
  pending: Row;
  /** Arriving in this sync: the pending one is promoted to it. */
  arrival?: Arrival;
  /** Already here, since it arrived in an earlier sync: the fallback. */
  posted?: Row;
}

/**
 * For providers that don't link a posted transaction to its pending one (SimpleFIN): a pending
 * transaction a window no longer returns became the posted one that is new on the same account,
 * with the same amount, dated within POSTED_WITHIN_DAYS: when there's exactly one such posted
 * transaction, and it could have come from no other pending one. "New" means arriving in this
 * sync, or already here having arrived no earlier than the pending one, still unclaimed. Anything
 * less certain isn't matched: the pending one is dropped with the window's other missing rows and
 * the posted one stands alone, so nothing is lost or counted twice. A changed amount (a tip) never
 * matches, and its edits stay with the dropped pending one.
 */
export async function postedInWindow(
  tx: Executor,
  window: SyncWindow,
  accountIds: string[],
  returned: Set<string>,
  fresh: Arrival[],
): Promise<WindowPosting[]> {
  if (accountIds.length === 0) return [];
  const reported = sql`coalesce(${transactions.postedDate}, ${transactions.authorizedDate})`;
  const gone = (
    await tx
      .select()
      .from(transactions)
      .where(
        and(
          inArray(transactions.accountId, accountIds),
          isNotNull(transactions.providerTransactionId),
          eq(transactions.pending, true),
          eq(transactions.source, 'provider'),
          isNull(transactions.deletedAt),
          isNull(transactions.parentId),
          sql`${reported} BETWEEN ${window.from}::date AND ${window.to}::date`,
        ),
      )
  ).filter((r) => !returned.has(rowKey(r.accountId, r.providerTransactionId!)));
  if (gone.length === 0) return [];

  const days = POSTED_WITHIN_DAYS;
  const here = (
    await tx
      .select()
      .from(transactions)
      .where(
        and(
          inArray(transactions.accountId, [...new Set(gone.map((r) => r.accountId))]),
          inArray(transactions.amountMinor, [...new Set(gone.map((r) => r.amountMinor))]),
          isNotNull(transactions.providerTransactionId),
          isNull(transactions.providerPendingId),
          eq(transactions.pending, false),
          eq(transactions.source, 'provider'),
          isNull(transactions.deletedAt),
          isNull(transactions.parentId),
          sql`${reported} BETWEEN ${window.from}::date - ${days}::int
              AND ${window.to}::date + ${days}::int`,
        ),
      )
  ).filter((r) => returned.has(rowKey(r.accountId, r.providerTransactionId!)));

  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * DAY_MS;
  const candidates = new Map<Row, (Arrival | Row)[]>();
  const claims = new Map<Arrival | Row, number>();
  for (const p of gone) {
    const list: (Arrival | Row)[] = [
      ...fresh.filter(
        (a) =>
          !a.t.pending &&
          a.accountId === p.accountId &&
          a.t.amountMinor === p.amountMinor &&
          a.t.currency === p.currency &&
          near(reportedDate(a.t), rowDate(p)),
      ),
      ...here.filter(
        (r) =>
          r.accountId === p.accountId &&
          r.amountMinor === p.amountMinor &&
          r.currency === p.currency &&
          r.createdAt >= p.createdAt &&
          near(rowDate(r), rowDate(p)),
      ),
    ];
    candidates.set(p, list);
    for (const c of list) claims.set(c, (claims.get(c) ?? 0) + 1);
  }
  const out: WindowPosting[] = [];
  for (const [pending, list] of candidates) {
    const [only] = list;
    if (list.length !== 1 || claims.get(only!) !== 1) continue;
    out.push('t' in only! ? { pending, arrival: only } : { pending, posted: only! });
  }
  return out;
}
