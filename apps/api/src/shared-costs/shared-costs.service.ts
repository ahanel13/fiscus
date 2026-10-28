// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  categories,
  categoryGroups,
  type Executor,
  households,
  splitPolicies,
  transactionAttributions,
  transactions,
} from '@fiscus/db';
import {
  addMonths,
  expenseEffects,
  firstDayOf,
  pairBalances,
  type SharedExpense,
  type SplitPolicyRow,
} from '@fiscus/domain';
import { householdRanges, ownersOnDates, transactionDate } from '@fiscus/ledger';
import { type SharedCosts, type SplitRule, splitRuleSchema } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';
import { spendingLensFilter } from '../visibility/visibility-scope.js';

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
      const effects = expenseEffects(mine, policies);
      const before = mine.filter((e) => e.date < firstDayOf(month)).map((e) => e.id);
      const beforeSet = new Set(before);
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
        sharedSpendingMinor: lines.reduce((s, l) => s + l.costMinor, 0),
        evensOutMinor: lines.filter((l) => l.evensOut).reduce((s, l) => s + l.costMinor, 0),
      };
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
