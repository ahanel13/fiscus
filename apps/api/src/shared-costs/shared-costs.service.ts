// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accounts,
  categories,
  categoryGroups,
  type Executor,
  householdMembers,
  households,
  settlements,
  splitPolicies,
  transactionAttributions,
  transactions,
} from '@fiscus/db';
import {
  addMonths,
  expenseEffects,
  firstDayOf,
  pairBalances,
  settlementEffect,
  type SharedExpense,
  type SplitPolicyRow,
} from '@fiscus/domain';
import { accessLevels, householdRanges, ownersOnDates, transactionDate } from '@fiscus/ledger';
import {
  type recordSettlementSchema,
  type SharedCosts,
  type Settlement,
  type SettlementCandidate,
  type SplitRule,
  splitRuleSchema,
} from '@fiscus/shared';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { spendingLensFilter } from '../visibility/visibility-scope.js';

type RecordSettlement = z.infer<typeof recordSettlementSchema>;

interface SharedRow {
  id: string;
  accountId: string;
  /** The date it counts on, per the household's date basis. */
  date: string;
  effectiveDate: string;
  categoryId: string | null;
  amountMinor: number;
  displayName: string;
}

/**
 * Who owes whom (#111, ADR 0006 §7.2): computed when read from every shared expense up to the
 * month's end. Only the balances that involve you are returned, from expenses you're part of:
 * those attributed to you are visible to you (F1), and so are those paid from accounts you own.
 */
@Injectable()
export class SharedCostsService {
  constructor(private readonly scope: HouseholdScope) {}

  async get(ctx: HouseholdContext, month: string): Promise<SharedCosts> {
    return this.scope.run(ctx, async (tx) => {
      const [h] = await tx
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      const currency = h!.currency;
      const end = firstDayOf(addMonths(month, 1));
      const rows = await this.#shared(tx, ctx, currency, end);
      const expenses = await this.#expenses(tx, rows);
      const policies = await loadPolicies(tx);
      const me = ctx.memberId;
      const mine = expenses.filter(
        (e) =>
          e.forMembers.some((f) => f.memberId === me) || e.paidBy.some((p) => p.memberId === me),
      );
      const settled = await tx
        .select()
        .from(settlements)
        .where(sql`${settlements.date} < ${end}::date`);
      const effects = [
        ...expenseEffects(mine, policies),
        ...settled.map((x) => settlementEffect(x.id, x.fromMemberId, x.toMemberId, x.amountMinor)),
      ];
      const beforeSet = new Set([
        ...mine.filter((e) => e.date < firstDayOf(month)).map((e) => e.id),
        ...settled.filter((x) => x.date < firstDayOf(month)).map((x) => x.id),
      ]);
      const list = (m: Map<string, number>) =>
        [...m]
          .filter(([id, v]) => id !== me && v !== 0)
          .map(([memberId, amountMinor]) => ({ memberId, amountMinor }));

      const inMonth = mine.filter((e) => e.date >= firstDayOf(month));
      const effectOf = new Map(effects.map((e) => [e.expenseId, e]));
      const names = new Map(rows.map((r) => [r.id, r]));
      const lines = inMonth
        .map((e) => {
          const eff = effectOf.get(e.id)!;
          const single = pairBalances([eff]).withMember(me);
          return {
            transactionId: e.id,
            date: e.date,
            displayName: names.get(e.id)!.displayName,
            categoryId: e.categoryId,
            costMinor: e.costMinor,
            paidBy: e.paidBy.map((p) => p.memberId),
            forMembers: e.forMembers.map((f) => f.memberId),
            effect: list(single),
            evensOut: [...eff.net.values()].every((v) => v === 0),
          };
        })
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return {
        month,
        currency,
        balances: list(pairBalances(effects).withMember(me)),
        carried: list(
          pairBalances(effects.filter((e) => beforeSet.has(e.expenseId))).withMember(me),
        ),
        expenses: lines.map(({ evensOut: _e, ...l }) => l),
        settlements: settled
          .filter((x) => x.date >= firstDayOf(month))
          .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
          .map((x) => ({
            id: x.id,
            date: x.date,
            fromMemberId: x.fromMemberId,
            toMemberId: x.toMemberId,
            amountMinor: x.amountMinor,
            kind: x.kind as Settlement['kind'],
            transactionId: x.transactionId,
            note: x.note,
          })),
        sharedSpendingMinor: lines.reduce((s, l) => s + l.costMinor, 0),
        evensOutMinor: lines.filter((l) => l.evensOut).reduce((s, l) => s + l.costMinor, 0),
      };
    });
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

  /** Shared transactions before `end` (D1): attributed to two or more, spending, counted. */
  async #shared(
    tx: Executor,
    ctx: HouseholdContext,
    currency: string,
    end: string,
  ): Promise<SharedRow[]> {
    const ranges = await householdRanges(tx, ctx.householdId);
    const date = transactionDate(ranges.dateBasis);
    const lens = await spendingLensFilter(tx, ctx, 'shared');
    return tx
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        date: sql<string>`${date}::text`,
        effectiveDate: transactions.effectiveDate,
        categoryId: transactions.categoryId,
        amountMinor: transactions.amountMinor,
        displayName: transactions.displayName,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .leftJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
      .where(
        and(
          isNull(transactions.deletedAt),
          eq(transactions.hasSplits, false),
          eq(transactions.excluded, false),
          eq(transactions.currency, currency),
          sql`coalesce(${categoryGroups.kind}::text, '') NOT IN ('transfer', 'income')`,
          sql`${date} < ${end}::date`,
          lens,
        ),
      );
  }

  /** Who each is for, and who paid: the account's owners on its date, as people (F1). */
  async #expenses(tx: Executor, rows: SharedRow[]): Promise<SharedExpense[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const explicit = new Map<string, { memberId: string; shareBps: number }[]>();
    for (const a of await tx
      .select()
      .from(transactionAttributions)
      .where(inArray(transactionAttributions.transactionId, ids))) {
      explicit.set(a.transactionId, [
        ...(explicit.get(a.transactionId) ?? []),
        { memberId: a.memberId, shareBps: a.shareBps },
      ]);
    }
    const ownersOn = await ownersOnDates(
      tx,
      rows.map((r) => r.accountId),
    );
    // For a transaction on an account you can't see, who paid comes as people only (F1).
    const payers = new Map<string, string[]>();
    const { rows: hidden } = await tx.execute<{ transaction_id: string; member_id: string }>(
      sql`SELECT transaction_id, member_id FROM fiscus_attributed_payers()`,
    );
    for (const p of hidden) {
      payers.set(p.transaction_id, [...(payers.get(p.transaction_id) ?? []), p.member_id]);
    }
    return rows.map((r) => {
      const owners = ownersOn(r.accountId, r.effectiveDate);
      const paidBy = owners.length
        ? owners
        : (payers.get(r.id) ?? []).map((memberId, _i, all) => ({
            memberId,
            shareBps: Math.round(10000 / all.length),
          }));
      return {
        id: r.id,
        date: r.date,
        categoryId: r.categoryId,
        costMinor: -r.amountMinor,
        forMembers: explicit.get(r.id) ?? owners,
        paidBy,
      };
    });
  }
}

async function loadPolicies(tx: Executor): Promise<SplitPolicyRow[]> {
  const rows = await tx.select().from(splitPolicies);
  return rows.map((r) => ({
    categoryId: r.categoryId,
    effectiveFrom: r.effectiveFrom,
    rule:
      r.method === null || r.method === 'income_proportional'
        ? null
        : (splitRuleSchema.parse({ method: r.method, ...r.params }) as SplitRule),
  }));
}
