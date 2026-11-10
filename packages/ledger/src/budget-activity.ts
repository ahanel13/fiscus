// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accounts,
  budgetAmounts,
  budgetCategories,
  budgetMoves,
  type budgets,
  budgetStrategies,
  categories,
  categoryGroups,
  type Executor,
  households,
  transactions,
} from '@fiscus/db';
import { addMonths, type BudgetCategory, firstDayOf, type MonthActivity } from '@fiscus/domain';
import type { BudgetScope } from '@fiscus/shared';
import { and, asc, eq, gte, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import { budgetGoalLines, goalMoved } from './goal-lines.js';
import { ownersOnDates } from './owners.js';
import { householdRanges, transactionDate } from './ranges.js';

// What a budget counts, month by month (budgeting walkthrough D1, D2, D13), for the api's budget
// pages and the weekly recap (#128). Runs in the reader's context: row-level security limits it
// to what they see, and a member's own budget to them.

type BudgetRow = typeof budgets.$inferSelect;
const monthOfDate = (d: string) => d.slice(0, 7);

/** Who's reading: the household, and the member a budget of their own ("mine") belongs to. */
export interface BudgetReader {
  householdId: string;
  memberId: string;
}

/** Who a transaction is for: its attribution, else its account's owners on its date (#447). */
export const attributedMembers = sql`coalesce(
    (SELECT array_agg(ta.member_id) FROM transaction_attributions ta WHERE ta.transaction_id = ${transactions.id}),
    (SELECT array_agg(o.member_id)
     FROM fiscus_owners_on(${transactions.accountId}, ${transactions.effectiveDate}) o))`;

/** For one member alone. */
export const attributedTo = (memberId: string): SQL =>
  sql`${attributedMembers} = ARRAY[${memberId}::uuid]`;

/** For two or more: shared. */
export const attributedToTwoOrMore: SQL = sql`coalesce(array_length(${attributedMembers}, 1), 0) >= 2`;

export type BudgetDefinitionRows = Awaited<ReturnType<typeof loadBudgetDefinition>>;

/**
 * What happened in a scope each month from `from` to `to` (D1): spending per category, net of
 * refunds, and income, in the household's currency. Transfers, settle-ups, excluded
 * transactions and split parents don't count; uncategorized ones count as Uncategorized.
 */
export async function budgetActivity(
  tx: Executor,
  ctx: BudgetReader,
  scope: BudgetScope,
  from: string,
  to: string,
): Promise<Map<string, MonthActivity>> {
  const ranges = await householdRanges(tx, ctx.householdId);
  const date = transactionDate(ranges.dateBasis);
  const [h] = await tx
    .select({ currency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, ctx.householdId));
  const [uncategorized] = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.systemKey, 'uncategorized'));
  const lens = scope === 'mine' ? attributedTo(ctx.memberId) : attributedToTwoOrMore;
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
  const contributed = await contributions(tx, ctx, scope, date, from, end, h!.currency);
  const saved = await savingsMoved(tx, ctx, scope, date, from, end, h!.currency);
  const owner = scope === 'mine' ? ctx.memberId : null;
  const toGoals = await goalMoved(
    tx,
    owner,
    await budgetGoalLines(tx, ctx.householdId, owner),
    date,
    from,
    end,
    h!.currency,
  );
  const months = new Set([
    ...out.keys(),
    ...contributed.keys(),
    ...saved.keys(),
    ...toGoals.keys(),
  ]);
  return new Map(
    [...months].map((k) => [
      k,
      {
        spentMinor: out.get(k)?.spentMinor ?? new Map<string, number>(),
        incomeMinor: out.get(k)?.incomeMinor ?? 0,
        incomeByCategory: out.get(k)?.incomeByCategory ?? new Map<string, number>(),
        contributionsMinor: contributed.get(k) ?? 0,
        savingsMovedMinor: saved.get(k) ?? 0,
        goalMovedMinor: toGoals.get(k)?.byGoal ?? new Map<string, number>(),
        goalMovedElsewhereMinor: toGoals.get(k)?.elsewhereMinor ?? 0,
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
  ctx: BudgetReader,
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
        : owners.length === 1 && owners[0]!.memberId === ctx.memberId && !!other && joint(other);
    if (counts) out.set(leg.month, (out.get(leg.month) ?? 0) + Math.abs(leg.amountMinor));
  }
  return out;
}

/** Savings and investment accounts: investment ones, and bank accounts for saving. */
const savingsAccount = sql`(${accounts.type} = 'investment' OR (${accounts.type} = 'depository'
  AND lower(coalesce(${accounts.subtype}, '')) ~ '(saving|money market|cd|certificate|hysa|high yield)'))`;

/**
 * Money moved into savings (50/30/20's Savings bucket, D10), per month: transfers into savings
 * and investment accounts in the scope (joint ones for the household's budget, yours alone for
 * your own) from accounts that aren't for saving. Moving between savings accounts isn't saving.
 */
async function savingsMoved(
  tx: Executor,
  ctx: BudgetReader,
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
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(
      and(
        isNotNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        eq(transactions.excluded, false),
        eq(transactions.isSettlement, false),
        eq(transactions.currency, currency),
        sql`${transactions.amountMinor} > 0`,
        // Counted already when filed under a spending category (a savings one, say).
        sql`coalesce(${categoryGroups.kind}::text, 'transfer') = 'transfer'`,
        savingsAccount,
        gte(date, firstDayOf(from)),
        sql`${date} < ${end}::date`,
      ),
    );
  if (legs.length === 0) return new Map();
  // Where each came from, if you can see it: from another savings account, it isn't saving.
  const sources = await tx
    .select({ group: transactions.transferGroupId, id: transactions.id })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(
      and(
        inArray(transactions.transferGroupId, [...new Set(legs.map((l) => l.group!))]),
        isNull(transactions.deletedAt),
        savingsAccount,
      ),
    );
  const ownersOn = await ownersOnDates(tx, [...new Set(legs.map((l) => l.accountId))]);
  const out = new Map<string, number>();
  for (const leg of legs) {
    if (sources.some((s) => s.group === leg.group && s.id !== leg.id)) continue;
    const owners = ownersOn(leg.accountId, leg.effectiveDate);
    const inScope =
      scope === 'household'
        ? owners.length >= 2
        : owners.length === 1 && owners[0]!.memberId === ctx.memberId;
    if (inScope) out.set(leg.month, (out.get(leg.month) ?? 0) + leg.amountMinor);
  }
  return out;
}

/** A budget's categories, amounts, strategies and goals, as computeBudgetMonth() reads them. */
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
  // Move money and Cover (zero-based, D9), net per line (a category or a goal) per month.
  const moves = new Map<string, Map<string, number>>();
  for (const m of await tx.select().from(budgetMoves).where(eq(budgetMoves.budgetId, row.id))) {
    const net = moves.get(monthOfDate(m.month)) ?? new Map<string, number>();
    const from = (m.fromCategoryId ?? m.fromGoalId)!;
    const to = (m.toCategoryId ?? m.toGoalId)!;
    net.set(from, (net.get(from) ?? 0) - m.amountMinor);
    net.set(to, (net.get(to) ?? 0) + m.amountMinor);
    moves.set(monthOfDate(m.month), net);
  }
  return {
    scope: (row.memberId ? 'mine' : 'household') as BudgetScope,
    goals: await budgetGoalLines(tx, row.householdId, row.memberId),
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
    moves,
  };
}
