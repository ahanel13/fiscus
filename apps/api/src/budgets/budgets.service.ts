// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accounts,
  budgetAmounts,
  budgetCategories,
  budgetMoves,
  budgets,
  budgetStrategies,
  categories,
  categoryGroups,
  type Executor,
  goals,
  householdMembers,
  households,
} from '@fiscus/db';
import {
  addMonths,
  amountsFor,
  type BudgetStrategyKind,
  type CategoryLimitsView,
  computeBudgetMonth,
  firstDayOf,
  flex,
  flexibleFor,
  type FlexView,
  percentage,
  type PercentageView,
  periodFor,
  STRATEGY_REGISTRY,
  suggestAmounts,
  type ZeroBasedView,
} from '@fiscus/domain';
import {
  budgetActivity,
  type BudgetDefinitionRows,
  householdRanges,
  loadBudgetDefinition,
} from '@fiscus/ledger';
import type {
  BudgetCategoryHistory,
  BudgetGoal,
  BudgetMonth,
  BudgetScope,
  BudgetSuggestion,
  BudgetSummary,
  BudgetYear,
  BudgetYearRow,
  createBudgetSchema,
  MoveMoney,
  ScopePreview,
  setPercentageSchema,
  StrategyPreview,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import type { HouseholdActivity } from '../households/household-scope.js';
import { HouseholdScope } from '../households/household-scope.js';
import { setGoalPlan } from '../goals/goal-plans.js';

type CreateInput = z.infer<typeof createBudgetSchema>;
type BudgetRow = typeof budgets.$inferSelect;

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
      const activity = await budgetActivity(tx, ctx, resolved, months[0]!, months[2]!);
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
      const definition = await loadBudgetDefinition(tx, row);
      const ledger = await budgetActivity(tx, ctx, scope, startsMonth, month);
      const out = computeBudgetMonth(definition, month, ledger, STRATEGY_REGISTRY);
      const [h] = await tx
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, ctx.householdId));
      return {
        budget: summaryOf(row, out.kind),
        month,
        currency: h!.currency,
        canEdit: canEdit(ctx, scope),
        excluded: definition.excluded,
        goals: await goalsOf(
          tx,
          definition.goals.map((g) => g.id),
        ),
        view: viewOf(out.kind, out.view, definition, month),
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
    strategy: SwitchableStrategy,
    fromMonth: string,
  ): Promise<StrategyPreview> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      await checkSwitchMonth(tx, ctx, row, fromMonth);
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      const definition = await loadBudgetDefinition(tx, row);
      const ledger = await budgetActivity(tx, ctx, scope, monthOfDate(row.startsMonth), fromMonth);
      const before = computeBudgetMonth(definition, fromMonth, ledger, STRATEGY_REGISTRY);
      const flexibleMinor = strategy === 'flex' ? flexibleStart(definition, fromMonth) : null;
      const switched = withPeriod(definition, fromMonth, strategy, flexibleMinor);
      if (strategy === 'zero_based' && !definition.amounts.has(fromMonth)) {
        switched.amounts = new Map([
          ...definition.amounts,
          [fromMonth, new Map(amountsFor(fromMonth, definition.amounts))],
        ]);
      }
      const after = computeBudgetMonth(switched, fromMonth, ledger, STRATEGY_REGISTRY);
      return {
        fromMonth,
        before: viewOf(before.kind, before.view, definition, fromMonth),
        after: viewOf(after.kind, after.view, switched, fromMonth),
        flexibleMinor,
      };
    });
  }

  /** Switches strategy from a month on (D14): every amount is kept, earlier months unchanged. */
  async switchStrategy(
    ctx: HouseholdContext,
    budgetId: string,
    strategy: SwitchableStrategy,
    fromMonth: string,
  ): Promise<BudgetSummary> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      await checkSwitchMonth(tx, ctx, row, fromMonth);
      const definition = await loadBudgetDefinition(tx, row);
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
      // Zero-based assigns afresh each month (D8): the month it starts keeps the amounts it had,
      // as what's assigned, so switching loses nothing (D14).
      if (strategy === 'zero_based' && !definition.amounts.has(fromMonth)) {
        await copyAmountsInto(tx, row, fromMonth);
      }
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

  /** What changing scope would show this month (D25): as it counts now, and as it would. */
  async scopePreview(
    ctx: HouseholdContext,
    budgetId: string,
    scope: BudgetScope,
  ): Promise<ScopePreview> {
    return this.scope.run(ctx, async (tx) => {
      const row = await findBudget(tx, budgetId);
      await checkScopeChange(tx, ctx, row, scope);
      const { today } = await householdRanges(tx, ctx.householdId);
      const start = monthOfDate(row.startsMonth);
      const month = monthOfDate(today) < start ? start : monthOfDate(today);
      const definition = await loadBudgetDefinition(tx, row);
      const as = async (s: BudgetScope) => {
        const out = computeBudgetMonth(
          definition,
          month,
          await budgetActivity(tx, ctx, s, start, month),
          STRATEGY_REGISTRY,
        );
        return viewOf(out.kind, out.view, definition, month);
      };
      return {
        month,
        before: await as(row.memberId ? 'mine' : 'household'),
        after: await as(scope),
      };
    });
  }

  /**
   * Share my budget, or Make it mine (D25): the same budget changes scope, keeping its strategy,
   * amounts and past months. What it counts follows the new scope (D1), for every month.
   */
  async setScope(
    ctx: HouseholdContext,
    budgetId: string,
    scope: BudgetScope,
  ): Promise<BudgetSummary> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      await checkScopeChange(tx, ctx, row, scope);
      const [updated] = await tx
        .update(budgets)
        .set({ memberId: scope === 'mine' ? ctx.memberId : null })
        .where(eq(budgets.id, budgetId))
        .returning();
      await record(activity, updated!, 'budget.scope_changed', { scope });
      const { today } = await householdRanges(tx, ctx.householdId);
      return this.#summary(tx, ctx, updated!, monthOfDate(today));
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
   * 50/30/20's split (§3.3): its buckets and what's split, for the period running in `month`, so
   * every month it runs in counts the same way (D13).
   */
  async setPercentage(
    ctx: HouseholdContext,
    budgetId: string,
    month: string,
    settings: z.infer<typeof setPercentageSchema>,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      const [period] = await tx
        .select()
        .from(budgetStrategies)
        .where(
          and(
            eq(budgetStrategies.budgetId, budgetId),
            lte(budgetStrategies.fromMonth, firstDayOf(month)),
          ),
        )
        .orderBy(sql`${budgetStrategies.fromMonth} DESC`)
        .limit(1);
      if (!period || period.strategy !== 'percentage') {
        throw new Problem(409, 'not_percentage', 'The budget doesn’t split by percentage then');
      }
      await tx
        .update(budgetStrategies)
        .set({ settings })
        .where(
          and(
            eq(budgetStrategies.budgetId, budgetId),
            eq(budgetStrategies.fromMonth, period.fromMonth),
          ),
        );
      await record(activity, row, 'budget.split_changed', {
        month,
        buckets: settings.buckets.map((b) => `${b.name} ${b.percent}%`).join(', '),
      });
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
    applyTo: 'month' | 'future' = 'future',
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      if (month < monthOfDate(row.startsMonth)) throw problems.notFound();
      if (!(await budgetedCategories(tx)).has(categoryId)) throw problems.notFound();
      const day = firstDayOf(month);
      const next = firstDayOf(addMonths(month, 1));
      // Zero-based assigns each month afresh (D8): nothing's copied in, or on to later months.
      const zeroBased = await runsZeroBased(tx, budgetId, month);
      if (zeroBased) applyTo = 'month';
      const own = await tx
        .select({ c: budgetAmounts.categoryId })
        .from(budgetAmounts)
        .where(and(eq(budgetAmounts.budgetId, budgetId), eq(budgetAmounts.month, day)))
        .limit(1);
      if (own.length === 0 && !zeroBased) {
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
      // This month only: the next one keeps what it showed, by having its own amounts (copied
      // from this month's, before the change) unless it already has them.
      if (applyTo === 'month' && !zeroBased) {
        await tx.execute(sql`
          INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
          SELECT household_id, budget_id, ${next}::date, category_id, amount_minor
          FROM budget_amounts WHERE budget_id = ${budgetId} AND month = ${day}::date
            AND NOT EXISTS (SELECT 1 FROM budget_amounts n
                            WHERE n.budget_id = ${budgetId} AND n.month = ${next}::date)`);
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
      // Every month after: later months with their own amounts take it too (months without
      // their own already repeat this one).
      if (applyTo === 'future') {
        await tx.execute(sql`
          INSERT INTO budget_amounts AS a (household_id, budget_id, month, category_id, amount_minor)
          SELECT DISTINCT household_id, budget_id, month, ${categoryId}::uuid, ${amountMinor}::bigint
          FROM budget_amounts WHERE budget_id = ${budgetId} AND month > ${day}::date
          ON CONFLICT (budget_id, month, category_id) DO UPDATE
            SET amount_minor = EXCLUDED.amount_minor, version = a.version + 1, updated_at = now()
            WHERE a.amount_minor <> EXCLUDED.amount_minor`);
      }
      await record(
        activity,
        row,
        'budget.amount_changed',
        { month, categoryId, applyTo },
        { before: before?.amountMinor ?? null, after: amountMinor },
      );
    });
  }

  /**
   * A goal's line (G16): its plan, from a month on or for that month only. The goal is the
   * budget's scope's, and still in it; its plan changes with the line.
   */
  async setGoalLine(
    ctx: HouseholdContext,
    budgetId: string,
    month: string,
    goalId: string,
    amountMinor: number,
    applyTo: 'month' | 'future' = 'future',
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      if (month < monthOfDate(row.startsMonth)) throw problems.notFound();
      const [goal] = await tx
        .select({
          id: goals.id,
          householdId: goals.householdId,
          memberId: goals.memberId,
          name: goals.name,
          planMinor: goals.planMinor,
          archivedAt: goals.archivedAt,
        })
        .from(goals)
        .where(eq(goals.id, goalId));
      // Another scope's goal isn't in this budget (G4): an Ours goal is in Ours, a Mine in yours.
      if (!goal || goal.memberId !== row.memberId) throw problems.notFound();
      if (goal.archivedAt) {
        throw new Problem(409, 'goal_archived', `${goal.name} is archived`, 'Bring it back first.');
      }
      const { today } = await householdRanges(tx, ctx.householdId);
      const { before } = await setGoalPlan(
        tx,
        goal,
        month,
        amountMinor,
        applyTo,
        monthOfDate(today),
      );
      await record(
        activity,
        row,
        'budget.goal_line_changed',
        { month, goalId, applyTo },
        { before, after: amountMinor },
      );
    });
  }

  /**
   * Move money, or Cover (zero-based, D9): from one line's available money to another's, in a
   * month that runs zero-based. A line is a category, or a goal of the budget's scope (G4) and
   * its to-move money, never its claims (goals and budgets §7). Ready to assign doesn't change. A
   * line can't give more than it has available; a goal ahead has nothing to give.
   */
  async moveMoney(
    ctx: HouseholdContext,
    budgetId: string,
    month: string,
    move: MoveMoney,
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      const scope: BudgetScope = row.memberId ? 'mine' : 'household';
      checkCanEdit(ctx, scope);
      if (month < monthOfDate(row.startsMonth)) throw problems.notFound();
      const spending = await spendingCategories(tx);
      for (const id of [move.fromCategoryId, move.toCategoryId]) {
        if (id && !spending.has(id)) throw problems.notFound();
      }
      for (const id of [move.fromGoalId, move.toGoalId]) {
        if (!id) continue;
        const [goal] = await tx
          .select({ memberId: goals.memberId, name: goals.name, archivedAt: goals.archivedAt })
          .from(goals)
          .where(eq(goals.id, id));
        // Another scope's goal isn't in this budget (G4).
        if (!goal || goal.memberId !== row.memberId) throw problems.notFound();
        if (goal.archivedAt) {
          throw new Problem(
            409,
            'goal_archived',
            `${goal.name} is archived`,
            'Bring it back first.',
          );
        }
      }
      if (!(await runsZeroBased(tx, budgetId, month))) {
        throw new Problem(
          409,
          'not_zero_based',
          'Money moves between categories in a zero-based budget',
          'The budget doesn’t run zero-based in that month.',
        );
      }
      const definition = await loadBudgetDefinition(tx, row);
      const ledger = await budgetActivity(tx, ctx, scope, monthOfDate(row.startsMonth), month);
      const view = computeBudgetMonth(definition, month, ledger, STRATEGY_REGISTRY)
        .view as ZeroBasedView;
      const available = move.fromGoalId
        ? (view.goals.find((g) => g.goalId === move.fromGoalId)?.leftMinor ?? 0)
        : (view.rows.find((r) => r.categoryId === move.fromCategoryId)?.leftMinor ?? 0);
      if (available < move.amountMinor) {
        throw new Problem(
          422,
          'not_enough_available',
          move.fromGoalId
            ? 'That goal doesn’t have that much to move'
            : 'That category doesn’t have that much',
          available > 0
            ? 'Move what it has available, or less.'
            : 'It has nothing available to move.',
        );
      }
      await tx.insert(budgetMoves).values({
        householdId: ctx.householdId,
        budgetId,
        month: firstDayOf(month),
        fromCategoryId: move.fromCategoryId ?? null,
        fromGoalId: move.fromGoalId ?? null,
        toCategoryId: move.toCategoryId ?? null,
        toGoalId: move.toGoalId ?? null,
        amountMinor: move.amountMinor,
      });
      await record(activity, row, 'budget.money_moved', { month, ...move });
    });
  }

  /**
   * Assign like last month (zero-based): a month assigns afresh (D8), so this copies what the
   * last month with amounts assigned, into one that has none yet.
   */
  async assignLikeLastMonth(ctx: HouseholdContext, budgetId: string, month: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findBudget(tx, budgetId);
      checkCanEdit(ctx, row.memberId ? 'mine' : 'household');
      if (month < monthOfDate(row.startsMonth)) throw problems.notFound();
      const definition = await loadBudgetDefinition(tx, row);
      if (definition.amounts.has(month)) {
        throw new Problem(409, 'already_assigned', 'This month has amounts assigned already');
      }
      const last = lastAssigned(definition, month);
      if (!last) throw new Problem(409, 'nothing_to_copy', 'No earlier month has amounts assigned');
      await copyAmountsInto(tx, row, month);
      await record(activity, row, 'budget.assigned_like_last_month', { month, from: last.month });
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
      const ledger = await budgetActivity(tx, ctx, scope, months[0]!, to);
      const definition = await loadBudgetDefinition(tx, row);
      const startsMonth = monthOfDate(row.startsMonth);
      const out = months.map((month) => ({
        month,
        budgetedMinor:
          month < startsMonth ? null : (budgetedFor(definition, month).get(categoryId) ?? null),
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
      const ledger = await budgetActivity(tx, ctx, scope, months[0]!, months[11]!);
      const definition = await loadBudgetDefinition(tx, row);
      const startsMonth = monthOfDate(row.startsMonth);
      const kinds = new Map(definition.categories.map((c) => [c.id, c]));
      const budgetedIn = (month: string, categoryId: string): number | null => {
        if (month < startsMonth) return null;
        const c = kinds.get(categoryId);
        if (!c) return null;
        // 50/30/20 has no per-category limits (D10).
        if (periodFor(month, definition.periods).kind === 'percentage') return null;
        if (periodFor(month, definition.periods).kind === 'flex') {
          if (c.kind === 'flexible') return null;
          if (c.kind === 'non_monthly')
            return c.yearlyMinor === null ? null : Math.round(c.yearlyMinor / 12);
        }
        return budgetedFor(definition, month).get(categoryId) ?? null;
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
    change: {
      rollover?: boolean | undefined;
      yearlyMinor?: number | null | undefined;
      excluded?: boolean | undefined;
      bucket?: string | null | undefined;
    },
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
          excluded: change.excluded ?? false,
          bucket: change.bucket ?? null,
        })
        .onConflictDoUpdate({
          target: [budgetCategories.budgetId, budgetCategories.categoryId],
          set: {
            ...(change.rollover !== undefined ? { rollover: change.rollover } : {}),
            ...(change.yearlyMinor !== undefined ? { yearlyMinor: change.yearlyMinor } : {}),
            ...(change.excluded !== undefined ? { excluded: change.excluded } : {}),
            ...(change.bucket !== undefined ? { bucket: change.bucket } : {}),
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
  if ((await activeMembers(tx, ctx.householdId)) <= 1) return 'mine';
  return h!.style === 'combined' || h!.style === 'hybrid' ? 'household' : 'mine';
}

/** The household's members now. Row-level security shows those of every household you're in. */
async function activeMembers(tx: Executor, householdId: string): Promise<number> {
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(householdMembers)
    .where(
      and(eq(householdMembers.householdId, householdId), isNull(householdMembers.leftAt)),
    )) as [{ n: number }];
  return n;
}

/**
 * D25: only your own budget can be shared, by you, once there are two or more of you; the
 * household's becomes yours only once you're its one member. Either way, not onto a budget that
 * already exists in that scope.
 */
async function checkScopeChange(
  tx: Executor,
  ctx: HouseholdContext,
  row: BudgetRow,
  scope: BudgetScope,
): Promise<void> {
  if ((row.memberId ? 'mine' : 'household') === scope) {
    throw new Problem(
      409,
      'same_scope',
      scope === 'mine' ? 'It’s yours already' : 'It’s shared already',
    );
  }
  if (ctx.role === 'viewer') throw problems.forbidden('Viewers can’t change the budget.');
  const members = await activeMembers(tx, ctx.householdId);
  if (scope === 'household' && members < 2) {
    throw new Problem(
      409,
      'one_person',
      'A shared budget needs two of you',
      'Share it once someone joins: on your own, a shared budget counts nothing.',
    );
  }
  if (scope === 'mine' && members > 1) {
    throw new Problem(
      409,
      'not_alone',
      'The shared budget is everyone’s',
      'It can become yours once you’re the household’s only member.',
    );
  }
  const [existing] = await tx
    .select({ id: budgets.id })
    .from(budgets)
    .where(scope === 'mine' ? eq(budgets.memberId, ctx.memberId) : isNull(budgets.memberId));
  if (existing) {
    throw new Problem(
      409,
      'budget_exists',
      scope === 'mine' ? 'You already have a budget' : 'The household already has a budget',
    );
  }
}

/**
 * The goals with lines in a budget, as the lines show them (G4): where each one's money goes, by
 * the names of the accounts you see. A claim on someone's private account shows no name (G7).
 */
async function goalsOf(tx: Executor, ids: string[]): Promise<BudgetGoal[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      id: goals.id,
      kind: goals.kind,
      name: goals.name,
      icon: goals.icon,
      color: goals.color,
      imageUpdatedAt: goals.imageUpdatedAt,
      archivedAt: goals.archivedAt,
      debtName: accounts.name,
    })
    .from(goals)
    .leftJoin(accounts, eq(accounts.id, goals.accountId))
    .where(inArray(goals.id, ids));
  const { rows: claims } = await tx.execute<{ goal_id: string; account_name: string | null }>(
    sql`SELECT goal_id, account_name FROM fiscus_goal_claim_values() ORDER BY value_minor DESC`,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids
    .map((id) => byId.get(id))
    .filter((r) => r !== undefined)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      name: r.name,
      icon: r.icon,
      color: r.color,
      imageVersion: r.imageUpdatedAt ? String(r.imageUpdatedAt.getTime()) : null,
      accountNames:
        r.kind === 'pay_down'
          ? r.debtName
            ? [r.debtName]
            : []
          : [
              ...new Set(
                claims
                  .filter((c) => c.goal_id === r.id && c.account_name !== null)
                  .map((c) => c.account_name!),
              ),
            ],
      archived: r.archivedAt !== null,
    }));
}

/** The categories a budget has amounts for: limits on spending, and income expected. */
async function budgetedCategories(tx: Executor): Promise<Set<string>> {
  const rows = await tx
    .select({ id: categories.id })
    .from(categories)
    .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(sql`${categoryGroups.kind} <> 'transfer'`);
  return new Set(rows.map((r) => r.id));
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

/** The strategies a budget can switch to: the ones that are built. */
type SwitchableStrategy = 'category' | 'flex' | 'zero_based' | 'percentage';

/** The api's shape of a strategy's month. */
function viewOf(
  kind: BudgetStrategyKind,
  view: unknown,
  definition: BudgetDefinitionRows,
  month: string,
): BudgetMonth['view'] {
  if (kind === 'flex') return { strategy: 'flex', ...(view as FlexView) };
  if (kind === 'percentage') {
    const { buckets, base, income, expectedMinor } = percentage.settings(
      periodFor(month, definition.periods).settings,
    );
    return {
      strategy: 'percentage',
      ...(view as PercentageView),
      settings: { buckets, base, income, expectedMinor },
    };
  }
  if (kind === 'zero_based') {
    return {
      strategy: 'zero_based',
      ...(view as ZeroBasedView),
      lastAssigned: lastAssigned(definition, month),
    };
  }
  return { strategy: 'category', ...(view as CategoryLimitsView) };
}

/** A month's amounts as its strategy reads them: zero-based only has what's assigned in it. */
function budgetedFor(definition: BudgetDefinitionRows, month: string): ReadonlyMap<string, number> {
  return periodFor(month, definition.periods).kind === 'zero_based'
    ? (definition.amounts.get(month) ?? new Map<string, number>())
    : amountsFor(month, definition.amounts);
}

/** The last month before `month` with amounts of its own, and what it assigned to spending. */
function lastAssigned(
  definition: BudgetDefinitionRows,
  month: string,
): { month: string; assignedMinor: number } | null {
  const earlier = [...definition.amounts.keys()].filter((m) => m < month).sort();
  const last = earlier.at(-1);
  if (!last) return null;
  const spending = new Set(
    definition.categories
      .filter((c) => c.kind !== 'income' && c.kind !== 'transfer')
      .map((c) => c.id),
  );
  let assignedMinor = 0;
  for (const [id, v] of definition.amounts.get(last)!) if (spending.has(id)) assignedMinor += v;
  return { month: last, assignedMinor };
}

/** Whether the budget runs zero-based in `month`. */
async function runsZeroBased(tx: Executor, budgetId: string, month: string): Promise<boolean> {
  const [period] = await tx
    .select({ strategy: budgetStrategies.strategy })
    .from(budgetStrategies)
    .where(
      and(
        eq(budgetStrategies.budgetId, budgetId),
        lte(budgetStrategies.fromMonth, firstDayOf(month)),
      ),
    )
    .orderBy(sql`${budgetStrategies.fromMonth} DESC`)
    .limit(1);
  return period?.strategy === 'zero_based';
}

/** Gives `month` its own amounts: those of the last month before it that had some. */
async function copyAmountsInto(tx: Executor, row: BudgetRow, month: string): Promise<void> {
  const day = firstDayOf(month);
  await tx.execute(sql`
    INSERT INTO budget_amounts (household_id, budget_id, month, category_id, amount_minor)
    SELECT household_id, budget_id, ${day}::date, category_id, amount_minor
    FROM budget_amounts
    WHERE budget_id = ${row.id}
      AND month = (SELECT max(month) FROM budget_amounts
                   WHERE budget_id = ${row.id} AND month < ${day}::date)
    ON CONFLICT DO NOTHING`);
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
function flexibleStart(definition: BudgetDefinitionRows, month: string) {
  const amounts = amountsFor(month, definition.amounts);
  return definition.categories
    .filter((c) => c.kind === 'flexible')
    .reduce((sum, c) => sum + (amounts.get(c.id) ?? 0), 0);
}

/** The definition as it would be with a switch from `fromMonth`, later switches dropped. */
function withPeriod(
  definition: BudgetDefinitionRows,
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
