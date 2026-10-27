// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  budgetAmounts,
  budgetCategories,
  budgets,
  budgetStrategies,
  categories,
  categoryGroups,
  type Executor,
  householdMembers,
  households,
  transactions,
} from '@fiscus/db';
import {
  addMonths,
  amountsFor,
  type BudgetCategory,
  type BudgetStrategyKind,
  categoryLimits,
  type CategoryLimitsView,
  computeBudgetMonth,
  firstDayOf,
  flex,
  flexibleFor,
  type FlexView,
  periodFor,
  type MonthActivity,
  suggestAmounts,
} from '@fiscus/domain';
import { householdRanges, transactionDate } from '@fiscus/ledger';
import type {
  BudgetCategoryHistory,
  BudgetMonth,
  BudgetScope,
  BudgetSuggestion,
  BudgetSummary,
  BudgetYear,
  BudgetYearRow,
  createBudgetSchema,
  StrategyPreview,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import type { HouseholdActivity } from '../households/household-scope.js';
import { HouseholdScope } from '../households/household-scope.js';
import { spendingLensFilter } from '../visibility/visibility-scope.js';

type CreateInput = z.infer<typeof createBudgetSchema>;
type BudgetRow = typeof budgets.$inferSelect;

const STRATEGIES = { category: categoryLimits, flex };
const monthOfDate = (d: string) => d.slice(0, 7);

/**
 * Budgets (BUD-01–05; budgeting walkthrough): the household's, which everyone sees and owners
 * and members change, and each member's own, which only they see (row-level security, 0054).
 * A month is computed from the amounts and the ledger whenever it's read (D13).
 */
@Injectable()
export class BudgetsService {
  constructor(private readonly scope: HouseholdScope) {}

  /** The budgets you can see: the household's, and your own. */
  async list(ctx: HouseholdContext): Promise<BudgetSummary[]> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(budgets)
        .orderBy(sql`${budgets.memberId} IS NOT NULL`);
      const { today } = await householdRanges(tx, ctx.householdId);
      return Promise.all(rows.map((b) => this.#summary(tx, ctx, b, monthOfDate(today))));
    });
  }

  /** What to start a budget from (D5): the last three full months, and the last one. */
  async suggestion(ctx: HouseholdContext, scope?: BudgetScope): Promise<BudgetSuggestion> {
    return this.scope.run(ctx, async (tx) => {
      const resolved = scope ?? (await defaultScope(tx, ctx));
      const { today } = await householdRanges(tx, ctx.householdId);
      const thisMonth = monthOfDate(today);
      const months = [-3, -2, -1].map((n) => addMonths(thisMonth, n));
      const activity = await this.#activity(tx, ctx, resolved, months[0]!, months[2]!);
      const spent = months.map((m) => activity.get(m)?.spentMinor ?? new Map<string, number>());
      const spending = await spendingCategories(tx);
      const keep = (m: ReadonlyMap<string, number>) =>
        new Map([...m].filter(([id, v]) => spending.has(id) && v > 0));
      const list = (m: Map<string, number>) =>
        [...m].map(([categoryId, amountMinor]) => ({ categoryId, amountMinor }));
      return {
        scope: resolved,
        months: months.filter((_, i) => [...spent[i]!.values()].some((v) => v !== 0)),
        average: list(suggestAmounts(spent.map(keep))),
        lastMonth: list(keep(spent[2]!) as Map<string, number>),
      };
    });
  }

  /** Starts a budget this month, as category limits (D5), scoped by the finance style (D21). */
  async create(ctx: HouseholdContext, input: CreateInput): Promise<BudgetSummary> {
    return this.scope.run(ctx, async (tx, activity) => {
      const scope = input.scope ?? (await defaultScope(tx, ctx));
      checkCanEdit(ctx, scope);
      const { today } = await householdRanges(tx, ctx.householdId);
      const month = monthOfDate(today);
      const spending = await spendingCategories(tx);
      if (input.amounts.some((a) => !spending.has(a.categoryId))) {
        throw new Problem(
          422,
          'not_a_spending_category',
          'A budget has limits for spending categories only',
          'Income and transfer categories aren’t budgeted.',
        );
      }
      const memberId = scope === 'mine' ? ctx.memberId : null;
      const [existing] = await tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(memberId ? eq(budgets.memberId, memberId) : isNull(budgets.memberId));
      if (existing) {
        throw new Problem(
          409,
          'budget_exists',
          scope === 'mine' ? 'You already have a budget' : 'The household already has a budget',
          'Change its amounts instead.',
        );
      }
      const [row] = await tx
        .insert(budgets)
        .values({ householdId: ctx.householdId, memberId, startsMonth: firstDayOf(month) })
        .returning();
      await tx.insert(budgetStrategies).values({
        householdId: ctx.householdId,
        budgetId: row!.id,
        fromMonth: firstDayOf(month),
        strategy: 'category',
      });
      if (input.amounts.length) {
        await tx.insert(budgetAmounts).values(
          input.amounts.map((a) => ({
            householdId: ctx.householdId,
            budgetId: row!.id,
            month: firstDayOf(month),
            categoryId: a.categoryId,
            amountMinor: a.amountMinor,
          })),
        );
      }
      await record(activity, row!, 'budget.created', {
        startsMonth: month,
        categories: input.amounts.length,
      });
      return this.#summary(tx, ctx, row!, month);
    });
  }

  /** A month of a budget (D13): computed from its first month to this one. */
  async month(ctx: HouseholdContext, budgetId: string, month: string): Promise<BudgetMonth> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      const startsMonth = monthOfDate(row.startsMonth);
      if (month < startsMonth) {
        throw new Problem(
          404,
          'before_budget',
          `This budget starts in ${startsMonth}`,
          'Earlier months have spending only.',
        );
      }
      const definition = await loadDefinition(tx, row);
      const ledger = await this.#activity(tx, ctx, scope, startsMonth, month);
      const out = computeBudgetMonth(definition, month, ledger, STRATEGIES);
      const [h] = await tx
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      return {
        budget: summaryOf(row, out.kind),
        month,
        currency: h!.currency,
        canEdit: canEdit(ctx, scope),
        view: viewOf(out.kind, out.view),
      };
    });
  }

  /**
   * What switching to `strategy` from `fromMonth` would show in that month (#104): the month as
   * it is, and as it would be. Flex starts from the flexible categories' limits added up.
   */
  async preview(
    ctx: HouseholdContext,
    budgetId: string,
    strategy: 'category' | 'flex',
    fromMonth: string,
  ): Promise<StrategyPreview> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      await checkSwitchMonth(tx, ctx, row, fromMonth);
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      const definition = await loadDefinition(tx, row);
      const ledger = await this.#activity(tx, ctx, scope, monthOfDate(row.startsMonth), fromMonth);
      const before = computeBudgetMonth(definition, fromMonth, ledger, STRATEGIES);
      const flexibleMinor = strategy === 'flex' ? flexibleStart(definition, fromMonth) : null;
      const switched = withPeriod(definition, fromMonth, strategy, flexibleMinor);
      const after = computeBudgetMonth(switched, fromMonth, ledger, STRATEGIES);
      return {
        fromMonth,
        before: viewOf(before.kind, before.view),
        after: viewOf(after.kind, after.view),
        flexibleMinor,
      };
    });
  }

  /** Switches strategy from a month on (D14): every amount is kept, earlier months unchanged. */
  async switchStrategy(
    ctx: HouseholdContext,
    budgetId: string,
    strategy: 'category' | 'flex',
    fromMonth: string,
  ): Promise<BudgetSummary> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      await checkSwitchMonth(tx, ctx, row, fromMonth);
      const definition = await loadDefinition(tx, row);
      const current = definition.periods
        .filter((p) => p.fromMonth <= fromMonth)
        .sort((a, b) => (a.fromMonth < b.fromMonth ? 1 : -1))[0];
      if (current?.kind === strategy) {
        throw new Problem(409, 'same_strategy', 'The budget already runs this way then');
      }
      const settings =
        strategy === 'flex'
          ? { flexibleMinor: { [fromMonth]: flexibleStart(definition, fromMonth) } }
          : {};
      await tx
        .insert(budgetStrategies)
        .values({
          householdId: ctx.householdId,
          budgetId,
          fromMonth: firstDayOf(fromMonth),
          strategy,
          settings,
        })
        .onConflictDoUpdate({
          target: [budgetStrategies.budgetId, budgetStrategies.fromMonth],
          set: { strategy, settings },
        });
      // A later switch already scheduled would hide this one: it goes.
      await tx
        .delete(budgetStrategies)
        .where(
          and(
            eq(budgetStrategies.budgetId, budgetId),
            sql`${budgetStrategies.fromMonth} > ${firstDayOf(fromMonth)}::date`,
          ),
        );
      await record(activity, row, 'budget.strategy_switched', {
        strategy,
        fromMonth,
        from: current?.kind ?? null,
      });
      const { today } = await householdRanges(tx, ctx.householdId);
      return this.#summary(tx, ctx, row, monthOfDate(today));
    });
  }

  /** The flexible number from a month on (flex, §3.4). */
  async setFlexible(
    ctx: HouseholdContext,
    budgetId: string,
    month: string,
    amountMinor: number,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      const periods = await tx
        .select()
        .from(budgetStrategies)
        .where(eq(budgetStrategies.budgetId, budgetId));
      const period = periods
        .filter((p) => monthOfDate(p.fromMonth) <= month)
        .sort((a, b) => (a.fromMonth < b.fromMonth ? 1 : -1))[0];
      if (!period || period.strategy !== 'flex') {
        throw new Problem(409, 'not_flex', 'The budget doesn’t use flex in that month');
      }
      const given = (period.settings.flexibleMinor ?? {}) as Record<string, number>;
      await tx
        .update(budgetStrategies)
        .set({
          settings: { ...period.settings, flexibleMinor: { ...given, [month]: amountMinor } },
        })
        .where(
          and(
            eq(budgetStrategies.budgetId, budgetId),
            eq(budgetStrategies.fromMonth, period.fromMonth),
          ),
        );
      await record(
        activity,
        row,
        'budget.flexible_changed',
        { month },
        { before: flexibleFor(month, new Map(Object.entries(given))), after: amountMinor },
      );
    });
  }

  /**
   * Sets a category's amount for a month. A month without amounts of its own repeats the last
   * one that had some, so those are copied into it first, and only this one changes.
   */
  async setAmount(
    ctx: HouseholdContext,
    budgetId: string,
    month: string,
    categoryId: string,
    amountMinor: number,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      if (month < monthOfDate(row.startsMonth)) throw problems.notFound();
      if (!(await spendingCategories(tx)).has(categoryId)) throw problems.notFound();
      const day = firstDayOf(month);
      const own = await tx
        .select({ c: budgetAmounts.categoryId })
        .from(budgetAmounts)
        .where(and(eq(budgetAmounts.budgetId, budgetId), eq(budgetAmounts.month, day)))
        .limit(1);
      if (own.length === 0) {
        const [last] = await tx
          .select({ month: sql<string>`max(${budgetAmounts.month})::text` })
          .from(budgetAmounts)
          .where(and(eq(budgetAmounts.budgetId, budgetId), lte(budgetAmounts.month, day)));
        if (last?.month) {
          await tx.execute(sql`
            INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
            SELECT household_id, budget_id, ${day}::date, category_id, amount_minor
            FROM budget_amounts WHERE budget_id = ${budgetId} AND month = ${last.month}::date`);
        }
      }
      const [before] = await tx
        .select({ amountMinor: budgetAmounts.amountMinor })
        .from(budgetAmounts)
        .where(
          and(
            eq(budgetAmounts.budgetId, budgetId),
            eq(budgetAmounts.month, day),
            eq(budgetAmounts.categoryId, categoryId),
          ),
        );
      await tx
        .insert(budgetAmounts)
        .values({ householdId: ctx.householdId, budgetId, month: day, categoryId, amountMinor })
        .onConflictDoUpdate({
          target: [budgetAmounts.budgetId, budgetAmounts.month, budgetAmounts.categoryId],
          set: { amountMinor, version: sql`${budgetAmounts.version} + 1` },
        });
      await record(
        activity,
        row,
        'budget.amount_changed',
        { month, categoryId },
        { before: before?.amountMinor ?? null, after: amountMinor },
      );
    });
  }

  /**
   * A category's last `count` months up to `to` (§4): its limit in each month the budget covers,
   * and what was spent in each, before the budget started too.
   */
  async history(
    ctx: HouseholdContext,
    budgetId: string,
    categoryId: string,
    to: string,
    count = 6,
  ): Promise<BudgetCategoryHistory> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      if (!(await spendingCategories(tx)).has(categoryId)) throw problems.notFound();
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      const months = Array.from({ length: count }, (_, i) => addMonths(to, i - count + 1));
      const ledger = await this.#activity(tx, ctx, scope, months[0]!, to);
      const definition = await loadDefinition(tx, row);
      const startsMonth = monthOfDate(row.startsMonth);
      const out = months.map((month) => ({
        month,
        budgetedMinor:
          month < startsMonth
            ? null
            : (amountsFor(month, definition.amounts).get(categoryId) ?? null),
        spentMinor: ledger.get(month)?.spentMinor.get(categoryId) ?? 0,
      }));
      // The average of the full months shown with any spending (as setup's suggestion counts).
      const full = out.filter((m) => m.month < to && m.spentMinor !== 0);
      return {
        categoryId,
        months: out,
        averageSpentMinor: full.length
          ? Math.round(full.reduce((s, m) => s + m.spentMinor, 0) / full.length)
          : null,
      };
    });
  }

  /**
   * A budget's year (§6, #106): twelve months from the household's fiscal year start, each
   * category's spending in every one, and its limit in each the budget covered, as that month's
   * strategy reads it: flex has no limit for flexible categories, and sets a twelfth of a
   * non-monthly one's yearly figure aside.
   */
  async year(ctx: HouseholdContext, budgetId: string, year: number): Promise<BudgetYear> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      const ranges = await householdRanges(tx, ctx.householdId);
      const first = `${year}-${String(ranges.settings.fiscalYearStartMonth).padStart(2, '0')}`;
      const months = Array.from({ length: 12 }, (_, i) => addMonths(first, i));
      const ledger = await this.#activity(tx, ctx, scope, months[0]!, months[11]!);
      const definition = await loadDefinition(tx, row);
      const startsMonth = monthOfDate(row.startsMonth);
      const kinds = new Map(definition.categories.map((c) => [c.id, c]));
      const budgetedIn = (month: string, categoryId: string): number | null => {
        if (month < startsMonth) return null;
        const c = kinds.get(categoryId);
        if (!c) return null;
        if (periodFor(month, definition.periods).kind === 'flex') {
          if (c.kind === 'flexible') return null;
          if (c.kind === 'non_monthly')
            return c.yearlyMinor === null ? null : Math.round(c.yearlyMinor / 12);
        }
        return amountsFor(month, definition.amounts).get(categoryId) ?? null;
      };
      const spending = await spendingCategories(tx);
      const rows: BudgetYearRow[] = definition.categories
        .filter((c) => spending.has(c.id))
        .map((c) => {
          const cells = months.map((m) => ({
            spentMinor: ledger.get(m)?.spentMinor.get(c.id) ?? 0,
            budgetedMinor: budgetedIn(m, c.id),
          }));
          return {
            categoryId: c.id,
            months: cells,
            spentMinor: cells.reduce((sum, x) => sum + x.spentMinor, 0),
            budgetedMinor: cells.reduce((sum, x) => sum + (x.budgetedMinor ?? 0), 0),
          };
        })
        .filter((r) => r.spentMinor !== 0 || r.months.some((m) => m.budgetedMinor !== null));
      const flexible = months.map((m) => {
        if (m < startsMonth) return null;
        const p = periodFor(m, definition.periods);
        if (p.kind !== 'flex') return null;
        return flexibleFor(m, flex.settings(p.settings).flexibleMinor);
      });
      return {
        year,
        months,
        rows,
        flexible,
        spentMinor: months.map((_, i) => rows.reduce((sum, r) => sum + r.months[i]!.spentMinor, 0)),
      };
    });
  }

  /** Turns a category's rollover on or off, for every month (§3.1). */
  async setCategory(
    ctx: HouseholdContext,
    budgetId: string,
    categoryId: string,
    change: { rollover?: boolean | undefined; yearlyMinor?: number | null | undefined },
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      if (!(await spendingCategories(tx)).has(categoryId)) throw problems.notFound();
      await tx
        .insert(budgetCategories)
        .values({
          householdId: ctx.householdId,
          budgetId,
          categoryId,
          rollover: change.rollover ?? false,
          yearlyMinor: change.yearlyMinor ?? null,
        })
        .onConflictDoUpdate({
          target: [budgetCategories.budgetId, budgetCategories.categoryId],
          set: {
            ...(change.rollover !== undefined ? { rollover: change.rollover } : {}),
            ...(change.yearlyMinor !== undefined ? { yearlyMinor: change.yearlyMinor } : {}),
          },
        });
      await record(activity, row, 'budget.category_changed', { categoryId, ...change });
    });
  }

  async #summary(
    tx: Executor,
    _ctx: HouseholdContext,
    row: BudgetRow,
    month: string,
  ): Promise<BudgetSummary> {
    const [current] = await tx
      .select({ strategy: budgetStrategies.strategy })
      .from(budgetStrategies)
      .where(
        and(
          eq(budgetStrategies.budgetId, row.id),
          lte(
            budgetStrategies.fromMonth,
            firstDayOf(month < monthOfDate(row.startsMonth) ? monthOfDate(row.startsMonth) : month),
          ),
        ),
      )
      .orderBy(sql`${budgetStrategies.fromMonth} DESC`)
      .limit(1);
    return summaryOf(row, current?.strategy ?? 'category');
  }

  /**
   * What happened in a scope each month from `from` to `to` (D1): spending per category, net of
   * refunds, and income, in the household's currency. Transfers, settle-ups, excluded
   * transactions and split parents don't count; uncategorized ones count as Uncategorized.
   */
  async #activity(
    tx: Executor,
    ctx: HouseholdContext,
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
    const lens = await spendingLensFilter(tx, ctx, scope === 'mine' ? 'me' : 'shared');
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
    const out = new Map<string, { spentMinor: Map<string, number>; incomeMinor: number }>();
    for (const r of rows) {
      const m = out.get(r.month) ?? { spentMinor: new Map<string, number>(), incomeMinor: 0 };
      const total = Number(r.total);
      if (r.kind === 'income') m.incomeMinor += total;
      else {
        const id = r.categoryId ?? uncategorized?.id;
        if (id) m.spentMinor.set(id, (m.spentMinor.get(id) ?? 0) - total);
      }
      out.set(r.month, m);
    }
    // Contributions (D2) come with budgets that follow the finance style (#107).
    return new Map([...out].map(([k, v]) => [k, { ...v, contributionsMinor: 0 }]));
  }
}

const summaryOf = (row: BudgetRow, strategy: BudgetStrategyKind): BudgetSummary => ({
  id: row.id,
  scope: row.memberId ? 'mine' : 'household',
  startsMonth: monthOfDate(row.startsMonth),
  strategy,
});

const canEdit = (ctx: HouseholdContext, scope: BudgetScope) =>
  ctx.role !== 'viewer' && (scope === 'mine' || ctx.role === 'owner' || ctx.role === 'member');

/** BUD-03/04: owners and members change the household's; you change your own; viewers neither. */
function checkCanEdit(ctx: HouseholdContext, scope: BudgetScope): void {
  if (!canEdit(ctx, scope)) {
    throw problems.forbidden(
      scope === 'mine'
        ? 'Viewers don’t have a budget of their own.'
        : 'Viewers can’t change the budget.',
    );
  }
}

/** Row-level security hides another member's budget: it's simply not found (D3). */
async function findBudget(tx: Executor, id: string): Promise<BudgetRow> {
  const [row] = await tx.select().from(budgets).where(eq(budgets.id, id));
  if (!row) throw problems.notFound();
  return row;
}

/**
 * Whose a new budget is (D21): yours alone in a household of one, or where each keeps their own
 * (Separate, Roommates); the household's where money is shared (Combined, Hybrid).
 */
async function defaultScope(tx: Executor, ctx: HouseholdContext): Promise<BudgetScope> {
  const [h] = await tx
    .select({ style: households.financeStyle })
    .from(households)
    .where(eq(households.id, ctx.householdId));
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(householdMembers)
    .where(isNull(householdMembers.leftAt))) as [{ n: number }];
  if (n <= 1) return 'mine';
  return h!.style === 'combined' || h!.style === 'hybrid' ? 'household' : 'mine';
}

/** The categories a budget limits: everything but income and transfers. */
async function spendingCategories(tx: Executor): Promise<Set<string>> {
  const rows = await tx
    .select({ id: categories.id })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(sql`${categoryGroups.kind} NOT IN ('income', 'transfer')`);
  return new Set(rows.map((r) => r.id));
}

async function loadDefinition(tx: Executor, row: BudgetRow) {
  const cats = await tx
    .select({
      id: categories.id,
      kind: categoryGroups.kind,
      rollover: budgetCategories.rollover,
      bucket: budgetCategories.bucket,
      yearlyMinor: budgetCategories.yearlyMinor,
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
    categories: cats.map((c): BudgetCategory => ({
      id: c.id,
      kind: c.kind,
      rollover: c.rollover ?? false,
      bucket: c.bucket ?? null,
      yearlyMinor: c.yearlyMinor ?? null,
    })),
    amounts,
  };
}

/** Changes to the household's budget are in its activity (D4); your own budget's are yours. */
async function record(
  activity: HouseholdActivity,
  row: BudgetRow,
  action: string,
  metadata: Record<string, unknown>,
  changes?: { before: unknown; after: unknown },
): Promise<void> {
  await activity.record({
    action,
    targetType: 'budget',
    targetId: row.id,
    metadata,
    visibleToHousehold: row.memberId === null,
    ...(changes
      ? {
          changes: {
            before: { amountMinor: changes.before },
            after: { amountMinor: changes.after },
          },
        }
      : {}),
  });
}

/** The api's shape of a strategy's month. */
function viewOf(kind: BudgetStrategyKind, view: unknown): BudgetMonth['view'] {
  if (kind === 'flex') return { strategy: 'flex', ...(view as FlexView) };
  return { strategy: 'category', ...(view as CategoryLimitsView) };
}

/** A switch starts this month or later (D14): months that have started keep their strategy. */
async function checkSwitchMonth(
  tx: Executor,
  ctx: HouseholdContext,
  row: BudgetRow,
  fromMonth: string,
): Promise<void> {
  const { today } = await householdRanges(tx, ctx.householdId);
  const thisMonth = monthOfDate(today);
  if (fromMonth < thisMonth || fromMonth < monthOfDate(row.startsMonth)) {
    throw new Problem(
      422,
      'switch_month_started',
      'A budget changes strategy from this month or a later one',
      'Earlier months keep the strategy they had.',
    );
  }
}

/** Flex's first flexible number: the flexible categories' amounts in that month, added up. */
function flexibleStart(definition: Awaited<ReturnType<typeof loadDefinition>>, month: string) {
  const amounts = amountsFor(month, definition.amounts);
  return definition.categories
    .filter((c) => c.kind === 'flexible')
    .reduce((sum, c) => sum + (amounts.get(c.id) ?? 0), 0);
}

/** The definition as it would be with a switch from `fromMonth`, later switches dropped. */
function withPeriod(
  definition: Awaited<ReturnType<typeof loadDefinition>>,
  fromMonth: string,
  strategy: BudgetStrategyKind,
  flexibleMinor: number | null,
) {
  return {
    ...definition,
    periods: [
      ...definition.periods.filter((p) => p.fromMonth < fromMonth),
      {
        fromMonth,
        kind: strategy,
        settings: flexibleMinor === null ? {} : { flexibleMinor: { [fromMonth]: flexibleMinor } },
      },
    ],
  };
}
