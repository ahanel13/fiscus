// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, type Executor, syncHolds, transactions } from '@fiscus/db';
import {
  accessLevels,
  activeRules,
  detectTransfers,
  householdRanges,
  recomputeBalances,
  runRules,
  transactionDate,
} from '@fiscus/ledger';
import type {
  decidePossibleDuplicateSchema,
  PossibleDuplicate,
  PossibleDuplicateDecision,
  TransferReviewTransaction,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type Decision = z.infer<typeof decidePossibleDuplicateSchema>;
type Hold = typeof syncHolds.$inferSelect;

/** How many the review lists at once; the count says how many there are. */
const LIST_LIMIT = 500;

/**
 * Possible duplicates (bank connections walkthrough D7, #80): synced transactions the worker held
 * because they look like ones already in the account. Only the account's owners see and decide
 * them (row-level security, migration 0050): "different" adds a transaction and rebuilds the
 * account's balances, which only owners may do, as with imports (TXN-09).
 */
@Injectable()
export class DuplicatesService {
  constructor(private readonly scope: HouseholdScope) {}

  async list(ctx: HouseholdContext): Promise<PossibleDuplicate[]> {
    return this.scope.run(ctx, async (tx) => {
      if (ctx.role === 'viewer') return [];
      const holds = await tx
        .select()
        .from(syncHolds)
        .orderBy(
          asc(sql`coalesce(${syncHolds.postedDate}, ${syncHolds.authorizedDate})`),
          asc(syncHolds.id),
        )
        .limit(LIST_LIMIT);
      if (holds.length === 0) return [];
      const names = new Map(
        (
          await tx
            .select({ id: accounts.id, name: accounts.name })
            .from(accounts)
            .where(inArray(accounts.id, [...new Set(holds.map((h) => h.accountId))]))
        ).map((a) => [a.id, a.name]),
      );
      const { dateBasis } = await householdRanges(tx, ctx.householdId);
      const candidates = await this.#candidates(
        tx,
        holds.flatMap((h) => h.candidateIds),
        dateBasis,
        names,
      );
      return holds.map((h) => ({
        id: h.id,
        account: { id: h.accountId, name: names.get(h.accountId) ?? '' },
        bank: {
          date: dateBasis === 'authorized' ? h.authorizedDate : (h.postedDate ?? h.authorizedDate),
          amountMinor: h.amountMinor,
          currency: h.currency,
          displayName: h.displayName,
          originalDescription: h.originalDescription,
        },
        candidates: h.candidateIds.flatMap((id) => {
          const c = candidates.get(id);
          return c && c.account.id === h.accountId ? [c] : [];
        }),
        heldAt: h.createdAt.toISOString(),
      }));
    });
  }

  async decide(
    ctx: HouseholdContext,
    holdId: string,
    input: Decision,
  ): Promise<PossibleDuplicateDecision> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (ctx.role === 'viewer') {
        throw problems.forbidden('Viewers can’t decide possible duplicates.');
      }
      const [hold] = await tx
        .select()
        .from(syncHolds)
        .where(eq(syncHolds.id, holdId))
        .for('update');
      if (!hold) throw problems.notFound();

      if (input.decision === 'same') {
        if (!hold.candidateIds.includes(input.transactionId)) {
          throw new Problem(
            422,
            'not_a_candidate',
            'That transaction isn’t one this may be',
            'Choose one of the transactions listed with it.',
          );
        }
        const [mine] = await tx
          .update(transactions)
          .set({
            providerTransactionId: hold.providerTransactionId,
            providerPendingId: hold.providerPendingId,
            version: sql`${transactions.version} + 1`,
          })
          .where(and(eq(transactions.id, input.transactionId), ...unattached(hold)))
          .returning({ id: transactions.id });
        if (!mine) {
          throw new Problem(
            409,
            'candidate_gone',
            'That transaction can’t be matched any more',
            'It was deleted, or another of the bank’s transactions was matched to it.',
          );
        }
        await tx.delete(syncHolds).where(eq(syncHolds.id, hold.id));
        await activity.record({
          action: 'transaction.matched_to_bank',
          targetType: 'transaction',
          targetId: mine.id,
          accountId: hold.accountId,
          metadata: { connectionId: hold.connectionId },
          transactionIds: [mine.id],
        });
        return { transactionId: mine.id };
      }

      // Different: it comes in as sync would have brought it, needing review.
      const id = uuidv7();
      await tx.insert(transactions).values({
        id,
        householdId: ctx.householdId,
        accountId: hold.accountId,
        amountMinor: hold.amountMinor,
        currency: hold.currency,
        postedDate: hold.postedDate,
        authorizedDate: hold.authorizedDate,
        pending: false,
        originalDescription: hold.originalDescription,
        displayName: hold.displayName,
        reviewStatus: 'needs_review',
        source: 'provider',
        providerTransactionId: hold.providerTransactionId,
        providerPendingId: hold.providerPendingId,
        foreignAmountMinor: hold.foreignAmountMinor,
        foreignCurrency: hold.foreignCurrency,
      });
      await tx.delete(syncHolds).where(eq(syncHolds.id, hold.id));
      // Recorded first, so its history starts with arriving (#46).
      await activity.record({
        action: 'transaction.added_from_bank',
        targetType: 'transaction',
        targetId: id,
        accountId: hold.accountId,
        metadata: { connectionId: hold.connectionId },
        transactionIds: [id],
      });
      // As sync would: the rules, within each author's reach (D9), then transfers within yours.
      await runRules(
        tx,
        ctx.householdId,
        await tx.select().from(transactions).where(eq(transactions.id, id)),
        await activeRules(tx, [hold.accountId]),
        null,
        activity,
      );
      await detectTransfers(tx, activity, [id], await accessLevels(tx));
      await recomputeBalances(tx, hold.accountId);
      return { transactionId: id };
    });
  }

  /** The candidates still waiting to be matched, as the review shows them. */
  async #candidates(
    tx: Executor,
    ids: string[],
    dateBasis: 'posted' | 'authorized',
    names: Map<string, string>,
  ): Promise<Map<string, TransferReviewTransaction>> {
    if (ids.length === 0) return new Map();
    const rows = await tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: sql<string>`${transactionDate(dateBasis)}::text`,
        amountMinor: transactions.amountMinor,
        currency: transactions.currency,
        displayName: transactions.displayName,
        categoryId: transactions.categoryId,
        version: transactions.version,
      })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, [...new Set(ids)]),
          isNull(transactions.providerTransactionId),
          ne(transactions.source, 'provider'),
          isNull(transactions.deletedAt),
          isNull(transactions.parentId),
        ),
      );
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          date: r.date,
          amountMinor: r.amountMinor,
          currency: r.currency,
          displayName: r.displayName,
          categoryId: r.categoryId,
          account: { id: r.accountId, name: names.get(r.accountId) ?? '' },
          version: r.version,
        },
      ]),
    );
  }
}

/** A transaction in the hold's account that's still yours alone: live, and not the bank's. */
const unattached = (hold: Hold) => [
  eq(transactions.accountId, hold.accountId),
  isNull(transactions.providerTransactionId),
  ne(transactions.source, 'provider'),
  isNull(transactions.deletedAt),
  isNull(transactions.parentId),
];
