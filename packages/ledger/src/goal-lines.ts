// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountLiabilities,
  accounts,
  balanceSnapshots,
  categories,
  categoryGroups,
  type Executor,
  goalClaims,
  goalPlans,
  goals,
  households,
  transactions,
} from '@fiscus/db';
import type { BudgetGoalLine } from '@fiscus/domain';
import { estimatedMinimum } from '@fiscus/shared';
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { transactionDate } from './ranges.js';

// Goals in a budget (goals and budgets G4, G9, G13, G16): which goals have a line in a budget,
// their plans by month, and what reached each one in a month. Runs in the reader's context:
// row-level security limits it to the goals they see, and to the transactions they see.

/** A budget's goals: the household's (Ours) for its budget, a member's own (Mine) for theirs. */
const ofScope = (memberId: string | null) =>
  memberId === null ? isNull(goals.memberId) : eq(goals.memberId, memberId);

/** Savings and investment accounts, as 50/30/20's Savings counts transfers into them (D10). */
const savingsAccount = sql<boolean>`(${accounts.type} = 'investment' OR (${accounts.type} = 'depository'
  AND lower(coalesce(${accounts.subtype}, '')) ~ '(saving|money market|cd|certificate|hysa|high yield)'))`;

/** The goal lines of a budget whose owner is `memberId` (null: the household's), in priority order. */
export async function budgetGoalLines(
  tx: Executor,
  householdId: string,
  memberId: string | null,
): Promise<BudgetGoalLine[]> {
  const [h] = await tx
    .select({ tz: households.timezone })
    .from(households)
    .where(eq(households.id, householdId));
  const tz = h?.tz ?? 'UTC';
  const rows = await tx
    .select({
      id: goals.id,
      kind: goals.kind,
      fromMonth: sql<string>`to_char(${goals.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM')`,
      untilMonth: sql<string | null>`to_char(${goals.archivedAt} AT TIME ZONE ${tz}, 'YYYY-MM')`,
    })
    .from(goals)
    .where(ofScope(memberId))
    .orderBy(asc(goals.position), asc(goals.createdAt));
  if (rows.length === 0) return [];
  const plans = new Map<string, Map<string, number>>();
  for (const p of await tx
    .select()
    .from(goalPlans)
    .where(
      inArray(
        goalPlans.goalId,
        rows.map((r) => r.id),
      ),
    )) {
    const m = plans.get(p.goalId) ?? new Map<string, number>();
    m.set(p.month.slice(0, 7), p.amountMinor);
    plans.set(p.goalId, m);
  }
  return rows.map((r) => {
    const own = plans.get(r.id) ?? new Map<string, number>();
    const first = [...own.keys()].sort()[0];
    return {
      id: r.id,
      kind: r.kind,
      plans: own,
      fromMonth: first !== undefined && first < r.fromMonth ? first : r.fromMonth,
      untilMonth: r.untilMonth,
    };
  });
}

/** What reached goals in a month (G4), and the part 50/30/20's Savings doesn't count already. */
export interface GoalMovedMonth {
  byGoal: Map<string, number>;
  elsewhereMinor: number;
}

/**
 * What reached each of a budget's goals, month by month (G4):
 * - A savings goal: money moved into the accounts it draws on, from anywhere but another of its
 *   own. An account backing two goals splits it by their claims (G13).
 * - A pay-down goal: what was paid on its loan or card over the minimum (G9); the minimum is a
 *   bill. The rate and minimum entered on the goal go first, then the bank's, else 2% of what's
 *   owed (at least $25).
 * Only months the goal's in the budget count.
 */
export async function goalMoved(
  tx: Executor,
  memberId: string | null,
  lines: readonly BudgetGoalLine[],
  date: ReturnType<typeof transactionDate>,
  from: string,
  end: string,
  currency: string,
): Promise<Map<string, GoalMovedMonth>> {
  const out = new Map<string, GoalMovedMonth>();
  if (lines.length === 0) return out;
  const ids = lines.map((l) => l.id);
  const goalRows = await tx
    .select({
      id: goals.id,
      kind: goals.kind,
      accountId: goals.accountId,
      minimumMinor: sql<
        number | null
      >`coalesce(${goals.minimumMinor}, ${accountLiabilities.minimumPaymentMinor})`,
    })
    .from(goals)
    .leftJoin(accountLiabilities, eq(accountLiabilities.accountId, goals.accountId))
    .where(and(ofScope(memberId), inArray(goals.id, ids)));
  const claims = await tx
    .select({ goalId: goalClaims.goalId, accountId: goalClaims.accountId, id: goalClaims.id })
    .from(goalClaims)
    .where(inArray(goalClaims.goalId, ids));
  // The goals on each account, weighted by what their claims are worth now (G13).
  const worth = new Map<string, number>();
  if (claims.length) {
    const { rows } = await tx.execute<{ claim_id: string; value_minor: string }>(
      sql`SELECT claim_id, value_minor FROM fiscus_goal_claim_values()`,
    );
    for (const r of rows) worth.set(r.claim_id, Number(r.value_minor));
  }
  const onAccount = new Map<string, { goalId: string; weight: number }[]>();
  for (const c of claims) {
    onAccount.set(c.accountId, [
      ...(onAccount.get(c.accountId) ?? []),
      { goalId: c.goalId, weight: worth.get(c.id) ?? 0 },
    ]);
  }
  const debts = goalRows.filter((g) => g.kind === 'pay_down' && g.accountId);
  for (const d of debts) {
    onAccount.set(d.accountId!, [
      ...(onAccount.get(d.accountId!) ?? []),
      { goalId: d.id, weight: 1 },
    ]);
  }
  const accountIds = [...onAccount.keys()];
  if (accountIds.length === 0) return out;
  // Money in: linked transfers, and anything filed as a transfer.
  const legs = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      group: transactions.transferGroupId,
      savings: savingsAccount,
      month: sql<string>`to_char(${date}, 'YYYY-MM')`,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(
      and(
        inArray(transactions.accountId, accountIds),
        isNull(transactions.deletedAt),
        eq(transactions.excluded, false),
        eq(transactions.hasSplits, false),
        eq(transactions.currency, currency),
        sql`${transactions.amountMinor} > 0`,
        or(
          sql`${transactions.transferGroupId} IS NOT NULL`,
          sql`${categoryGroups.kind} = 'transfer'`,
        ),
        gte(date, `${from}-01`),
        sql`${date} < ${end}::date`,
      ),
    );
  if (legs.length === 0) return out;
  // Where each came from, where you see it: from another of the same goal's accounts, it's not new.
  const groups = [...new Set(legs.map((l) => l.group).filter((g): g is string => g !== null))];
  const sources = groups.length
    ? await tx
        .select({
          id: transactions.id,
          group: transactions.transferGroupId,
          accountId: transactions.accountId,
        })
        .from(transactions)
        .where(and(inArray(transactions.transferGroupId, groups), isNull(transactions.deletedAt)))
    : [];
  const accountsOf = new Map<string, Set<string>>();
  for (const [accountId, gs] of onAccount) {
    for (const g of gs)
      accountsOf.set(g.goalId, (accountsOf.get(g.goalId) ?? new Set()).add(accountId));
  }
  const line = new Map(lines.map((l) => [l.id, l]));
  const inBudget = (goalId: string, month: string) => {
    const l = line.get(goalId)!;
    return month >= l.fromMonth && (l.untilMonth === null || month <= l.untilMonth);
  };
  const add = (month: string, goalId: string, amount: number, elsewhere: boolean) => {
    const m = out.get(month) ?? { byGoal: new Map<string, number>(), elsewhereMinor: 0 };
    m.byGoal.set(goalId, (m.byGoal.get(goalId) ?? 0) + amount);
    if (elsewhere) m.elsewhereMinor += amount;
    out.set(month, m);
  };
  // Payments on each debt, by month, to take the minimum from.
  const paid = new Map<string, Map<string, number>>();
  const debtOf = new Map(debts.map((d) => [d.accountId!, d]));
  for (const leg of legs) {
    const debt = debtOf.get(leg.accountId);
    if (debt) {
      if (!inBudget(debt.id, leg.month)) continue;
      const m = paid.get(debt.id) ?? new Map<string, number>();
      m.set(leg.month, (m.get(leg.month) ?? 0) + leg.amountMinor);
      paid.set(debt.id, m);
      continue;
    }
    const source = sources.find((s) => s.group === leg.group && s.id !== leg.id);
    const gs = (onAccount.get(leg.accountId) ?? []).filter(
      (g) =>
        inBudget(g.goalId, leg.month) &&
        !(source && accountsOf.get(g.goalId)?.has(source.accountId)),
    );
    if (gs.length === 0) continue;
    const total = gs.reduce((s, g) => s + g.weight, 0);
    // Split by the claims' worth; with nothing claimed yet, evenly. The last takes the rounding.
    let left = leg.amountMinor;
    gs.forEach((g, i) => {
      const share =
        i === gs.length - 1
          ? left
          : Math.round(
              (leg.amountMinor * (total > 0 ? g.weight : 1)) / (total > 0 ? total : gs.length),
            );
      left -= share;
      add(leg.month, g.goalId, share, !leg.savings);
    });
  }
  if (paid.size) {
    // What's owed now, for a minimum the goal and the bank don't give.
    const owed = new Map<string, number>();
    for (const b of await tx
      .selectDistinctOn([balanceSnapshots.accountId], {
        accountId: balanceSnapshots.accountId,
        balanceMinor: balanceSnapshots.balanceMinor,
      })
      .from(balanceSnapshots)
      .where(inArray(balanceSnapshots.accountId, [...debtOf.keys()]))
      .orderBy(balanceSnapshots.accountId, desc(balanceSnapshots.asOf))) {
      owed.set(b.accountId, Math.max(0, -b.balanceMinor));
    }
    for (const d of debts) {
      const minimum = d.minimumMinor ?? estimatedMinimum(owed.get(d.accountId!) ?? 0);
      for (const [month, amount] of paid.get(d.id) ?? []) {
        const extra = Math.max(0, amount - minimum);
        if (extra > 0) add(month, d.id, extra, true);
      }
    }
  }
  return out;
}
