// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  budgetAmounts,
  budgetCategories,
  budgets,
  budgetStrategies,
  categories,
  categoryGroups,
  type Executor,
  households,
  transactions,
} from '@fiscus/db';
import {
  addMonths,
  type BudgetCategory,
  categoryLimits,
  firstDayOf,
  flex,
  type MonthActivity,
} from '@fiscus/domain';
import type { BudgetScope } from '@fiscus/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { ownersOnDates } from './owners.js';
import { householdRanges, transactionDate } from './ranges.js';

// A budget's month, as the api shows it and notifications (#127) read it: its definition, and
// what happened in its scope (budgeting walkthrough D1, D2). Row-level security limits both to
// what the caller sees; the worker reads them in a member's own context.

type BudgetRow = typeof budgets.$inferSelect;
const monthOfDate = (d: string) => d.slice(0, 7);

/** The strategies a budget can run under. */
export const BUDGET_STRATEGIES = { category: categoryLimits, flex };

export interface BudgetActivityScope {
  householdId: string;
  /** Whose view: "Mine" is theirs; contributions are counted from their side. */
  memberId: string;
  scope: BudgetScope;
  from: string;
  to: string;
}

/**
 * Whose spending a budget counts: a member's own (Mine) is what's theirs alone, by attribution or
 * else the account's owners on its date; the household's (Ours) is what's two or more people's.
 */
export function budgetLens(scope: BudgetScope, memberId: string): SQL {
  const members = sql`coalesce(
    (SELECT array_agg(ta.member_id) FROM transaction_attributions ta WHERE ta.transaction_id = ${transactions.id}),
    (SELECT array_agg(o.member_id)
     FROM fiscus_owners_on(${transactions.accountId}, ${transactions.effectiveDate}) o))`;
  if (scope === 'household') return sql`coalesce(array_length(${members}, 1), 0) >= 2`;
  return sql`${members} = ARRAY[${memberId}::uuid]`;
}

/**
 * What happened in a scope each month from `from` to `to` (D1): spending per category, net of
 * refunds, and income, in the household's currency. Transfers, settle-ups, excluded
 * transactions and split parents don't count; uncategorized ones count as Uncategorized.
 */
export async function budgetActivity(
  tx: Executor,
  { householdId, memberId, scope, from, to }: BudgetActivityScope,
): Promise<Map<string, MonthActivity>> {
  const ranges = await householdRanges(tx, householdId);
  const date = transactionDate(ranges.dateBasis);
  const [h] = await tx
    .select({ currency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, householdId));
  const [uncategorized] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.systemKey, 'uncategorized'));
  const lens = budgetLens(scope, memberId);
  const end = firstDayOf(addMonths(to, 1));
  const rows = await tx
    .select({
      month: sql<string>`to_char(${date}, 'YYYY-MM')`,
      categoryId: transactions.categoryId,
      kind: categoryGroups.kind,
      total: sql<string>`sum(${transactions.amountMinor})::text`,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.hasSplits, false),
        eq(transactions.excluded, false),
        eq(transactions.currency, h!.currency),
        sql`coalesce(${categoryGroups.kind}::text, '') <> 'transfer'`,
        gte(date, firstDayOf(from)),
        sql`${date} < ${end}::date`,
        lens,
      ),
    )
    .groupBy(sql`1`, transactions.categoryId, categoryGroups.kind);
  const out = new Map<
    string,
    {
      spentMinor: Map<string, number>;
      incomeMinor: number;
      incomeByCategory: Map<string, number>;
    }
  >();
  for (const r of rows) {
    const m = out.get(r.month) ?? {
      spentMinor: new Map<string, number>(),
      incomeMinor: 0,
      incomeByCategory: new Map<string, number>(),
    };
    const total = Number(r.total);
    if (r.kind === 'income') {
      m.incomeMinor += total;
      if (r.categoryId) {
        m.incomeByCategory.set(r.categoryId, (m.incomeByCategory.get(r.categoryId) ?? 0) + total);
      }
    } else {
      const id = r.categoryId ?? uncategorized?.id;
      if (id) m.spentMinor.set(id, (m.spentMinor.get(id) ?? 0) - total);
    }
    out.set(r.month, m);
  }
  const contributed = await contributions(tx, memberId, scope, date, from, end, h!.currency);
  const months = new Set([...out.keys(), ...contributed.keys()]);
  return new Map(
    [...months].map((k) => [
      k,
      {
        spentMinor: out.get(k)?.spentMinor ?? new Map<string, number>(),
        incomeMinor: out.get(k)?.incomeMinor ?? 0,
        incomeByCategory: out.get(k)?.incomeByCategory ?? new Map<string, number>(),
        contributionsMinor: contributed.get(k) ?? 0,
      },
    ]),
  );
}

/**
 * Contributions (D2), per month: money moved from a member's own account into a joint one (two
 * or more owners on its date). For the household's budget, what arrived in joint accounts from
 * accounts that aren't joint, including ones you can't see (someone else's own). For yours, what
 * left accounts you own alone for a joint one. Settle-ups aren't contributions.
 */
async function contributions(
  tx: Executor,
  memberId: string,
  scope: BudgetScope,
  date: ReturnType<typeof transactionDate>,
  from: string,
  end: string,
  currency: string,
): Promise<Map<string, number>> {
  const legs = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      group: transactions.transferGroupId,
      effectiveDate: transactions.effectiveDate,
      month: sql<string>`to_char(${date}, 'YYYY-MM')`,
    })
    .from(transactions)
    .where(
      and(
        isNotNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        eq(transactions.excluded, false),
        eq(transactions.isSettlement, false),
        eq(transactions.currency, currency),
        gte(date, firstDayOf(from)),
        sql`${date} < ${end}::date`,
        scope === 'household'
          ? sql`${transactions.amountMinor} > 0`
          : sql`${transactions.amountMinor} < 0`,
      ),
    );
  if (legs.length === 0) return new Map();
  // The other side of each, if you can see it.
  const others = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      group: transactions.transferGroupId,
      effectiveDate: transactions.effectiveDate,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.transferGroupId, [...new Set(legs.map((l) => l.group!))]),
        isNull(transactions.deletedAt),
      ),
    );
  const ownersOn = await ownersOnDates(tx, [
    ...new Set([...legs, ...others].map((r) => r.accountId)),
  ]);
  const joint = (r: { accountId: string; effectiveDate: string }) =>
    ownersOn(r.accountId, r.effectiveDate).length >= 2;
  const out = new Map<string, number>();
  for (const leg of legs) {
    const other = others.find((o) => o.group === leg.group && o.id !== leg.id);
    const owners = ownersOn(leg.accountId, leg.effectiveDate);
    const counts =
      scope === 'household'
        ? joint(leg) && (!other || !joint(other))
        : owners.length === 1 && owners[0]!.memberId === memberId && !!other && joint(other);
    if (counts) out.set(leg.month, (out.get(leg.month) ?? 0) + Math.abs(leg.amountMinor));
  }
  return out;
}

/** A budget's categories, amounts and strategies over time: what computing a month needs. */
export async function loadBudgetDefinition(tx: Executor, row: BudgetRow) {
  const cats = await tx
    .select({
      id: categories.id,
      kind: categoryGroups.kind,
      rollover: budgetCategories.rollover,
      bucket: budgetCategories.bucket,
      yearlyMinor: budgetCategories.yearlyMinor,
      excluded: budgetCategories.excluded,
    })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .leftJoin(
      budgetCategories,
      and(eq(budgetCategories.categoryId, categories.id), eq(budgetCategories.budgetId, row.id)),
    )
    .orderBy(asc(categoryGroups.sortOrder), asc(categories.sortOrder), asc(categories.name));
  const amounts = new Map<string, Map<string, number>>();
  for (const a of await tx.select().from(budgetAmounts).where(eq(budgetAmounts.budgetId, row.id))) {
    const m = amounts.get(monthOfDate(a.month)) ?? new Map<string, number>();
    m.set(a.categoryId, a.amountMinor);
    amounts.set(monthOfDate(a.month), m);
  }
  const periods = await tx
    .select()
    .from(budgetStrategies)
    .where(eq(budgetStrategies.budgetId, row.id));
  return {
    startsMonth: monthOfDate(row.startsMonth),
    periods: periods.map((p) => ({
      fromMonth: monthOfDate(p.fromMonth),
      kind: p.strategy,
      settings: p.settings,
    })),
    // "Don't budget": a category left out is in no row, total, or spending without a limit.
    excluded: cats.filter((c) => c.excluded).map((c) => c.id),
    categories: cats
      .filter((c) => !c.excluded)
      .map((c): BudgetCategory => ({
        id: c.id,
        kind: c.kind,
        rollover: c.rollover ?? false,
        bucket: c.bucket ?? null,
        yearlyMinor: c.yearlyMinor ?? null,
      })),
    amounts,
  };
}
