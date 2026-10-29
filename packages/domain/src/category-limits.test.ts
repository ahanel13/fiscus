// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type BudgetCategory, type BudgetDefinition, computeBudgetMonth } from './budget.js';
import { categoryLimits, type CategoryLimitsView, suggestAmounts } from './category-limits.js';

const cat = (id: string, kind: BudgetCategory['kind'] = 'flexible', rollover = false) => ({
  id,
  kind,
  rollover,
  bucket: null,
  yearlyMinor: null,
});
const map = (o: Record<string, number>) => new Map(Object.entries(o));
const month = (spent: Record<string, number>, incomeMinor = 0) => ({
  spentMinor: map(spent),
  incomeMinor,
  incomeByCategory: new Map(),
  contributionsMinor: 0,
});

// The walkthrough's October (§3.1), smaller: Groceries rolls over, Restaurants doesn't.
const budget: BudgetDefinition = {
  startsMonth: '2026-09',
  periods: [{ fromMonth: '2026-09', kind: 'category', settings: {} }],
  categories: [
    cat('paychecks', 'income'),
    cat('groceries', 'flexible', true),
    cat('restaurants'),
    cat('electronics'),
    cat('transfer', 'transfer'),
  ],
  amounts: new Map([['2026-09', map({ groceries: 70000, restaurants: 25000 })]]),
};
const ledger = new Map([
  ['2026-09', month({ groceries: 64800, restaurants: 20000 }, 500000)],
  [
    '2026-10',
    month({ groceries: 61248, restaurants: 29130, electronics: 5999, transfer: 1 }, 460000),
  ],
]);
const october = () =>
  computeBudgetMonth(budget, '2026-10', ledger, { category: categoryLimits })
    .view as CategoryLimitsView;

describe('category limits', () => {
  it('shows income expected beside what came in, kept out of the spending limits', () => {
    const withPay: BudgetDefinition = {
      ...budget,
      amounts: new Map([['2026-09', map({ paychecks: 450000, groceries: 70000, restaurants: 0 })]]),
    };
    const pay = new Map([
      [
        '2026-10',
        { ...month({ restaurants: 3000 }, 460000), incomeByCategory: map({ paychecks: 460000 }) },
      ],
    ]);
    const v = computeBudgetMonth(withPay, '2026-10', pay, { category: categoryLimits })
      .view as CategoryLimitsView;
    expect(v.income).toEqual([
      { categoryId: 'paychecks', budgetedMinor: 450000, receivedMinor: 460000 },
    ]);
    expect(v.totals).toMatchObject({ budgetedMinor: 70000, incomeBudgetedMinor: 450000 });
    // A limit of zero is no limit: Restaurants' spending shows as not budgeted, not as over.
    expect(v.rows.map((r) => r.categoryId)).toEqual(['groceries']);
    expect(v.notBudgeted).toEqual([{ categoryId: 'restaurants', spentMinor: 3000 }]);
  });

  it('shows each limit, what’s been spent, and what’s left, rolling over where it’s on', () => {
    const v = october();
    expect(v.rows).toEqual([
      {
        categoryId: 'groceries',
        budgetedMinor: 70000,
        rolledInMinor: 5200, // 700 − 648 in September
        spentMinor: 61248,
        leftMinor: 70000 + 5200 - 61248,
        rollover: true,
      },
      {
        categoryId: 'restaurants',
        budgetedMinor: 25000,
        rolledInMinor: 0, // September's 50 left didn't roll over
        spentMinor: 29130,
        leftMinor: -4130,
        rollover: false,
      },
    ]);
  });

  it('keeps spending without a limit in view, and leaves out income and transfers (D6)', () => {
    const v = october();
    expect(v.notBudgeted).toEqual([{ categoryId: 'electronics', spentMinor: 5999 }]);
    expect(v.incomeMinor).toBe(460000);
    expect(v.totals).toEqual({
      budgetedMinor: 95000,
      incomeBudgetedMinor: 0,
      spentMinor: 61248 + 29130 + 5999,
      leftMinor: 70000 + 5200 - 61248 - 4130,
      overCount: 1,
    });
  });

  it('carries overspending too, as a smaller limit', () => {
    const over = new Map([
      ['2026-09', month({ groceries: 80000 })],
      ['2026-10', month({})],
    ]);
    const v = computeBudgetMonth(budget, '2026-10', over, { category: categoryLimits })
      .view as CategoryLimitsView;
    expect(v.rows[0]).toMatchObject({ rolledInMinor: -10000, leftMinor: 60000 });
  });

  it('keeps a rollover balance showing after its limit is removed', () => {
    const removed: BudgetDefinition = {
      ...budget,
      amounts: new Map([
        ['2026-09', map({ groceries: 70000, restaurants: 25000 })],
        ['2026-10', map({ restaurants: 25000 })],
      ]),
    };
    const v = computeBudgetMonth(removed, '2026-10', ledger, { category: categoryLimits })
      .view as CategoryLimitsView;
    expect(v.rows.find((r) => r.categoryId === 'groceries')).toMatchObject({
      budgetedMinor: 0,
      rolledInMinor: 5200,
      leftMinor: 5200 - 61248,
    });
  });
});

describe('suggestAmounts', () => {
  it('averages the months with spending, rounded to $5 (D5)', () => {
    const out = suggestAmounts([
      map({ groceries: 68825, coffee: 2840 }),
      map({}), // a month with nothing at all: left out
      map({ groceries: 61290, coffee: 3100, gifts: 200 }),
    ]);
    // Groceries (688.25 + 612.90) / 2 = 650.58 → 650; coffee 29.70 → 30; gifts 1 → 0, left out.
    expect(out).toEqual(map({ groceries: 65000, coffee: 3000 }));
  });

  it('suggests nothing without history', () => {
    expect(suggestAmounts([]).size).toBe(0);
    expect(suggestAmounts([map({}), map({})]).size).toBe(0);
  });
});
