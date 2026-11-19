// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  allowancesIn,
  type BudgetAllowance,
  type BudgetCategory,
  type BudgetDefinition,
  computeBudgetMonth,
  type MonthActivity,
} from './budget.js';
import type { CategoryLimitsView } from './category-limits.js';
import { STRATEGY_REGISTRY } from './strategies.js';
import type { ZeroBasedView } from './zero-based.js';

// Allowances (#114, budgeting walkthrough D15): a line in Ours that funds a Mine.

const FUN = 'fun';
const GROCERIES = 'groceries';
const cat = (id: string, rollover = false): BudgetCategory => ({
  id,
  kind: 'flexible',
  rollover,
  bucket: null,
  yearlyMinor: null,
});
const activity = (spent: Record<string, number>, incomeMinor = 0): MonthActivity => ({
  spentMinor: new Map(Object.entries(spent)),
  incomeMinor,
  incomeByCategory: new Map(),
  contributionsMinor: 0,
});
const allowance = (
  memberId: string,
  month: string,
  amountMinor: number,
  untilMonth: string | null = null,
): BudgetAllowance => ({ memberId, month, categoryId: FUN, amountMinor, untilMonth });

const budget = (
  scope: 'household' | 'mine',
  allowances: BudgetAllowance[],
  kind: 'category' | 'zero_based' = 'category',
  rollover = false,
): BudgetDefinition => ({
  scope,
  startsMonth: '2026-09',
  periods: [{ fromMonth: '2026-09', kind, settings: {} }],
  categories: [cat(GROCERIES), cat(FUN, rollover)],
  amounts: new Map([['2026-09', new Map([[GROCERIES, 60000]])]]),
  allowances,
});

describe('allowancesIn', () => {
  it('takes each member’s last change on or before the month, and drops stopped ones', () => {
    const rows = [
      allowance('alex', '2026-09', 15000),
      allowance('alex', '2026-11', 20000),
      allowance('sam', '2026-09', 10000),
      allowance('sam', '2026-10', 0),
    ];
    expect(allowancesIn('2026-08', rows)).toEqual([]);
    expect(allowancesIn('2026-09', rows)).toEqual([
      { memberId: 'alex', categoryId: FUN, amountMinor: 15000 },
      { memberId: 'sam', categoryId: FUN, amountMinor: 10000 },
    ]);
    expect(allowancesIn('2026-10', rows)).toEqual([
      { memberId: 'alex', categoryId: FUN, amountMinor: 15000 },
    ]);
    expect(allowancesIn('2027-01', rows)).toEqual([
      { memberId: 'alex', categoryId: FUN, amountMinor: 20000 },
    ]);
  });

  it('ends after the month its member left in', () => {
    const rows = [allowance('alex', '2026-09', 15000, '2026-10')];
    expect(allowancesIn('2026-10', rows)).toHaveLength(1);
    expect(allowancesIn('2026-11', rows)).toEqual([]);
  });
});

describe('the household’s budget', () => {
  it('has the allowances as their category’s amount, spent in full, and nothing of how', () => {
    const def = budget('household', [
      allowance('alex', '2026-09', 15000),
      allowance('sam', '2026-09', 10000),
    ]);
    // What either spends on their own never reaches Ours (D1): only shared spending is here.
    const ledger = new Map([['2026-10', activity({ [GROCERIES]: 41000 })]]);
    const view = computeBudgetMonth(def, '2026-10', ledger, STRATEGY_REGISTRY)
      .view as CategoryLimitsView;
    expect(view.rows.find((r) => r.categoryId === FUN)).toMatchObject({
      budgetedMinor: 25000,
      spentMinor: 25000,
      leftMinor: 0,
    });
    expect(view.totals.spentMinor).toBe(41000 + 25000);
  });

  it('replaces an amount the budget had for that category', () => {
    const def = budget('household', [allowance('alex', '2026-09', 15000)]);
    def.amounts = new Map([['2026-09', new Map([[FUN, 99900]])]]);
    const view = computeBudgetMonth(def, '2026-09', new Map(), STRATEGY_REGISTRY)
      .view as CategoryLimitsView;
    expect(view.rows.find((r) => r.categoryId === FUN)?.budgetedMinor).toBe(15000);
  });

  it('zero-based: assigns it every month, and takes it from Ready to assign', () => {
    const def = budget('household', [allowance('alex', '2026-09', 15000)], 'zero_based');
    const ledger = new Map([
      ['2026-09', activity({}, 300000)],
      ['2026-10', activity({}, 300000)],
    ]);
    // October has no amounts of its own, so nothing else is assigned yet.
    const view = computeBudgetMonth(def, '2026-10', ledger, STRATEGY_REGISTRY)
      .view as ZeroBasedView;
    expect(view.rows.find((r) => r.categoryId === FUN)).toMatchObject({
      budgetedMinor: 15000,
      spentMinor: 15000,
      leftMinor: 0,
    });
    expect(view.ready.assignedMinor).toBe(15000);
  });
});

describe('the member’s own budget', () => {
  it('gets the allowance as money in, and its category’s limit', () => {
    const def = budget('mine', [allowance('alex', '2026-09', 15000)]);
    const ledger = new Map([['2026-10', activity({ [FUN]: 4000 }, 100000)]]);
    const view = computeBudgetMonth(def, '2026-10', ledger, STRATEGY_REGISTRY)
      .view as CategoryLimitsView;
    expect(view.incomeMinor).toBe(115000);
    expect(view.rows.find((r) => r.categoryId === FUN)).toMatchObject({
      budgetedMinor: 15000,
      spentMinor: 4000,
      leftMinor: 11000,
    });
  });

  it('rolls what’s left over when its member turns rollover on', () => {
    const def = budget('mine', [allowance('alex', '2026-09', 15000)], 'category', true);
    const ledger = new Map([
      ['2026-09', activity({ [FUN]: 5000 })],
      ['2026-10', activity({ [FUN]: 2000 })],
    ]);
    const view = computeBudgetMonth(def, '2026-10', ledger, STRATEGY_REGISTRY)
      .view as CategoryLimitsView;
    expect(view.rows.find((r) => r.categoryId === FUN)).toMatchObject({
      rolledInMinor: 10000,
      leftMinor: 23000,
    });
  });

  it('zero-based: arrives and is assigned to its category, so Ready to assign is unchanged', () => {
    const def = budget('mine', [allowance('alex', '2026-09', 15000)], 'zero_based');
    def.amounts = new Map();
    const view = computeBudgetMonth(
      def,
      '2026-09',
      new Map([['2026-09', activity({})]]),
      STRATEGY_REGISTRY,
    ).view as ZeroBasedView;
    expect(view.ready.cameInMinor).toBe(15000);
    expect(view.ready.readyMinor).toBe(0);
    expect(view.rows.find((r) => r.categoryId === FUN)?.leftMinor).toBe(15000);
  });
});
