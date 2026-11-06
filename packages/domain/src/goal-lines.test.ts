// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type BudgetCategory,
  type BudgetDefinition,
  type BudgetGoalLine,
  computeBudgetMonth,
  type MonthActivity,
  planFor,
} from './budget.js';
import type { CategoryLimitsView } from './category-limits.js';
import type { FlexView } from './flex.js';
import type { PercentageView } from './percentage.js';
import { STRATEGY_REGISTRY } from './strategies.js';
import type { ZeroBasedView } from './zero-based.js';

// Goals in a budget (goals and budgets G4, G5, G16): a goal's plan is its line, by month, and
// each strategy treats the line its own way.

const cat = (id: string, kind: BudgetCategory['kind']) => ({
  id,
  kind,
  rollover: false,
  bucket: null,
  yearlyMinor: null,
});
const map = (o: Record<string, number>) => new Map(Object.entries(o));
const japan: BudgetGoalLine = {
  id: 'japan',
  kind: 'save',
  plans: map({ '2026-09': 40000, '2026-11': 45000 }),
  fromMonth: '2026-09',
  untilMonth: null,
};
const visa: BudgetGoalLine = {
  id: 'visa',
  kind: 'pay_down',
  plans: map({ '2026-09': 25000 }),
  fromMonth: '2026-09',
  untilMonth: '2026-10',
};
const definition = (kind: BudgetDefinition['periods'][number]['kind']): BudgetDefinition => ({
  startsMonth: '2026-09',
  periods: [{ fromMonth: '2026-09', kind, settings: {} }],
  categories: [cat('rent', 'fixed'), cat('groceries', 'flexible'), cat('paychecks', 'income')],
  amounts: new Map([['2026-09', map({ rent: 200000, groceries: 60000 })]]),
  goals: [japan, visa],
});
const activity = (
  goals: Record<string, number>,
  extra: Partial<MonthActivity> = {},
): MonthActivity => ({
  spentMinor: map({ rent: 200000, groceries: 50000 }),
  incomeMinor: 500000,
  incomeByCategory: map({ paychecks: 500000 }),
  contributionsMinor: 0,
  goalMovedMinor: map(goals),
  ...extra,
});
const ledger = new Map([
  ['2026-09', activity({ japan: 40000, visa: 10000 })],
  ['2026-10', activity({ japan: 20000 })],
  ['2026-11', activity({ visa: 5000 })],
]);
const run = <V>(kind: BudgetDefinition['periods'][number]['kind'], month: string) =>
  computeBudgetMonth(definition(kind), month, ledger, STRATEGY_REGISTRY).view as V;

describe('goal lines', () => {
  it('reads a plan from a month on, never before (G16)', () => {
    expect(planFor('2026-08', japan.plans)).toBe(0);
    expect(planFor('2026-10', japan.plans)).toBe(40000);
    expect(planFor('2027-03', japan.plans)).toBe(45000);
  });

  it('category limits: planned against moved, never spending (G5)', () => {
    const v = run<CategoryLimitsView>('category', '2026-10');
    expect(v.goals).toEqual([
      { goalId: 'japan', budgetedMinor: 40000, movedMinor: 20000, leftMinor: 20000 },
      { goalId: 'visa', budgetedMinor: 25000, movedMinor: 0, leftMinor: 25000 },
    ]);
    // Not in the limits' totals: a goal never makes the budget over.
    expect(v.totals.budgetedMinor).toBe(260000);
    expect(v.totals.spentMinor).toBe(250000);
  });

  it('drops an archived goal’s line after its month, unless something moved', () => {
    const v = run<CategoryLimitsView>('category', '2026-11');
    expect(v.goals).toEqual([
      { goalId: 'japan', budgetedMinor: 45000, movedMinor: 0, leftMinor: 45000 },
      { goalId: 'visa', budgetedMinor: 0, movedMinor: 5000, leftMinor: -5000 },
    ]);
    const quiet = computeBudgetMonth(definition('category'), '2026-12', ledger, STRATEGY_REGISTRY)
      .view as CategoryLimitsView;
    expect(quiet.goals.map((g) => g.goalId)).toEqual(['japan']);
  });

  it('flex: a fixed line, outside the flexible number', () => {
    const v = run<FlexView>('flex', '2026-09');
    expect(v.goals.map((g) => [g.goalId, g.budgetedMinor, g.movedMinor])).toEqual([
      ['japan', 40000, 40000],
      ['visa', 25000, 10000],
    ]);
    expect(v.totals.fixedBudgetedMinor).toBe(200000);
  });

  it('zero-based: the plan is assigned once the month is, and what’s not moved rolls over', () => {
    const v = run<ZeroBasedView>('zero_based', '2026-09');
    expect(v.goals.map((g) => [g.goalId, g.budgetedMinor, g.sentMinor, g.leftMinor])).toEqual([
      ['japan', 40000, 40000, 0],
      ['visa', 25000, 10000, 15000],
    ]);
    expect(v.ready.assignedMinor).toBe(260000 + 65000);
    // October assigns afresh: nothing's assigned yet, the plan with it, and Visa's 150 carries.
    const october = run<ZeroBasedView>('zero_based', '2026-10');
    expect(october.assigned).toBe(false);
    expect(october.goals.map((g) => [g.goalId, g.budgetedMinor, g.rolledInMinor])).toEqual([
      ['japan', 0, 0],
      ['visa', 0, 15000],
    ]);
    // October moved $200 to Japan with nothing assigned: ahead, not overspent, and nothing carries.
    expect(october.goals.find((g) => g.goalId === 'japan')?.leftMinor).toBe(-20000);
    const categoriesOver = october.rows.filter((r) => r.leftMinor < 0);
    const overspent = categoriesOver.reduce((s, r) => s - r.leftMinor, 0);
    expect(october.totals).toMatchObject({
      overCount: categoriesOver.length,
      overspentMinor: overspent,
    });
    // November has Japan's plan set in it: that's assigned, even before anything else is.
    const november = run<ZeroBasedView>('zero_based', '2026-11');
    expect(november.goals.find((g) => g.goalId === 'japan')).toMatchObject({
      budgetedMinor: 45000,
      rolledInMinor: 0,
    });
    expect(november.ready.overspentMinor).toBe(overspent);
  });

  it('50/30/20: counted in Savings once, adding only what savings transfers didn’t (G5)', () => {
    const l = new Map([
      [
        '2026-09',
        activity(
          { japan: 40000, visa: 10000 },
          { savingsMovedMinor: 40000, goalMovedElsewhereMinor: 10000 },
        ),
      ],
    ]);
    const v = computeBudgetMonth(definition('percentage'), '2026-09', l, STRATEGY_REGISTRY)
      .view as PercentageView;
    const savings = v.buckets.find((b) => b.key === 'savings')!;
    expect(savings).toMatchObject({ spentMinor: 50000, movedToSavingsMinor: 40000 });
    expect(savings.goals).toEqual([
      { goalId: 'japan', movedMinor: 40000 },
      { goalId: 'visa', movedMinor: 10000 },
    ]);
  });
});
