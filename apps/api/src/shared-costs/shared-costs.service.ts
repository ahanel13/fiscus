// SPDX-License-Identifier: AGPL-3.0-or-later
import { accounts, categories, householdMembers, settlements, transactions } from '@fiscus/db';
import { accessLevels, buildSharedCosts, householdRanges } from '@fiscus/ledger';
import {
  type recordSettlementSchema,
  type SharedCosts,
  type Settlement,
  type SettlementCandidate,
} from '@fiscus/shared';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type RecordSettlement = z.infer<typeof recordSettlementSchema>;

/**
 * Who owes whom (#111, ADR 0006 §7.2): computed when read from every shared expense up to the
 * month's end (`buildSharedCosts`, shared with the worker's settle-up notifications, #116). Only
 * the balances that involve you are returned, from expenses you're part of: those attributed to
 * you are visible to you (F1), and so are those paid from accounts you own.
 */
@Injectable()
export class SharedCostsService {
  constructor(private readonly scope: HouseholdScope) {}

  async get(ctx: HouseholdContext, month: string): Promise<SharedCosts> {
    return this.scope.run(ctx, (tx) => buildSharedCosts(tx, { memberId: ctx.memberId, month }));
  }

  /**
   * Records a settle-up between you and another member (SHR-04, D20). A transfer must be in an
   * account you own, money in when they paid you or out when you paid them, and not already a
   * settle-up; it's then marked as one, so it stops counting as income or spending.
   */
  async record(ctx: HouseholdContext, input: RecordSettlement): Promise<Settlement> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (input.memberId === ctx.memberId) {
        throw new Problem(422, 'settle_with_yourself', 'A settle-up is between two people');
      }
      const [other] = await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(and(eq(householdMembers.id, input.memberId), isNull(householdMembers.leftAt)));
      if (!other) throw problems.notFound();
      const from = input.direction === 'they_paid' ? input.memberId : ctx.memberId;
      const to = input.direction === 'they_paid' ? ctx.memberId : input.memberId;
      if (input.transactionId) {
        const [t] = await tx
          .select({
            id: transactions.id,
            accountId: transactions.accountId,
            amountMinor: transactions.amountMinor,
            isSettlement: transactions.isSettlement,
          })
          .from(transactions)
          .where(and(eq(transactions.id, input.transactionId), isNull(transactions.deletedAt)));
        const level = t ? (await accessLevels(tx)).get(t.accountId) : undefined;
        if (!t || level !== 'owner') throw problems.notFound();
        const inbound = input.direction === 'they_paid';
        if (t.isSettlement || (inbound ? t.amountMinor <= 0 : t.amountMinor >= 0)) {
          throw new Problem(
            422,
            'not_a_settlement_transfer',
            inbound
              ? 'Choose money that came into your account'
              : 'Choose money that went out of your account',
          );
        }
        const [settlement] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.systemKey, 'settlement'));
        await tx
          .update(transactions)
          .set({
            isSettlement: true,
            ...(settlement ? { categoryId: settlement.id } : {}),
            version: sql`${transactions.version} + 1`,
          })
          .where(eq(transactions.id, t.id));
      }
      const [row] = await tx
        .insert(settlements)
        .values({
          householdId: ctx.householdId,
          fromMemberId: from,
          toMemberId: to,
          amountMinor: input.amountMinor,
          date: input.date,
          kind: input.kind,
          transactionId: input.transactionId ?? null,
          note: input.note ?? null,
          createdByMemberId: ctx.memberId,
        })
        .returning();
      await activity.record({
        action: 'settlement.recorded',
        targetType: 'settlement',
        targetId: row!.id,
        metadata: { kind: input.kind, from, to },
        ...(input.transactionId ? { transactionIds: [input.transactionId] } : {}),
        changes: { after: { amountMinor: input.amountMinor, date: input.date } },
      });
      return {
        id: row!.id,
        date: row!.date,
        fromMemberId: from,
        toMemberId: to,
        amountMinor: row!.amountMinor,
        kind: input.kind,
        transactionId: row!.transactionId,
        note: row!.note,
      };
    });
  }

  /** Removes a settle-up (SHR-04): its transfer counts as a transfer again. */
  async remove(ctx: HouseholdContext, id: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx.select().from(settlements).where(eq(settlements.id, id));
      if (!row) throw problems.notFound();
      await tx.delete(settlements).where(eq(settlements.id, id));
      if (row.transactionId) {
        const [transfer] = await tx
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.systemKey, 'transfer'));
        await tx
          .update(transactions)
          .set({
            isSettlement: false,
            ...(transfer ? { categoryId: transfer.id } : {}),
            version: sql`${transactions.version} + 1`,
          })
          .where(eq(transactions.id, row.transactionId));
      }
      await activity.record({
        action: 'settlement.removed',
        targetType: 'settlement',
        targetId: id,
        metadata: { kind: row.kind },
        ...(row.transactionId ? { transactionIds: [row.transactionId] } : {}),
        changes: { before: { amountMinor: row.amountMinor, date: row.date } },
      });
    });
  }

  /**
   * Transfers that could settle up with `memberId` (D20): in accounts you own, money in when they
   * owe you or out when you owe them, from the last 60 days, closest to the balance first.
   */
  async candidates(
    ctx: HouseholdContext,
    memberId: string,
    balanceMinor: number,
  ): Promise<SettlementCandidate[]> {
    return this.scope.run(ctx, async (tx) => {
      const owned = [...(await accessLevels(tx))]
        .filter(([, level]) => level === 'owner')
        .map(([id]) => id);
      if (owned.length === 0 || balanceMinor === 0) return [];
      const { today } = await householdRanges(tx, ctx.householdId);
      const since = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const rows = await tx
        .select({
          id: transactions.id,
          date: sql<string>`${transactions.effectiveDate}::text`,
          displayName: transactions.displayName,
          accountName: accounts.name,
          amountMinor: transactions.amountMinor,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(
          and(
            inArray(transactions.accountId, owned),
            isNull(transactions.deletedAt),
            eq(transactions.isSettlement, false),
            eq(transactions.hasSplits, false),
            sql`${transactions.effectiveDate} >= ${since}::date`,
            balanceMinor > 0
              ? sql`${transactions.amountMinor} > 0`
              : sql`${transactions.amountMinor} < 0`,
          ),
        );
      void memberId;
      return rows
        .sort(
          (a, b) =>
            Math.abs(Math.abs(a.amountMinor) - Math.abs(balanceMinor)) -
            Math.abs(Math.abs(b.amountMinor) - Math.abs(balanceMinor)),
        )
        .slice(0, 5)
        .map((r) => ({
          transactionId: r.id,
          date: r.date,
          displayName: r.displayName,
          accountName: r.accountName,
          amountMinor: r.amountMinor,
        }));
    });
  }
}
