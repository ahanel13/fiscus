// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type BudgetCategory,
  type BudgetDefinition,
  BudgetSettingsError,
  computeBudgetMonth,
} from './budget.js';
import { categoryLimits } from './category-limits.js';
import { flex, flexibleFor, type FlexView } from './flex.js';

const cat = (id: string, kind: BudgetCategory['kind'], yearlyMinor: number | null = null) => ({
  id,
  kind,
  rollover: false,
  bucket: null,
  yearlyMinor,
});
const map = (o: Record<string, number>) => new Map(Object.entries(o));
const month = (spent: Record<string, number>) => ({
  spentMinor: map(spent),
  incomeMinor: 460000,
  incomeByCategory: new Map(),
  contributionsMinor: 0,
});

// The walkthrough's flex screen (§3.4), smaller.
const budget: BudgetDefinition = {
  startsMonth: '2026-08',
  periods: [
    { fromMonth: '2026-08', kind: 'flex', settings: { flexibleMinor: { '2026-08': 150500 } } },
  ],
  categories: [
    cat('rent', 'fixed'),
    cat('internet', 'fixed'),
    cat('travel', 'non_monthly', 360000),
    cat('gifts', 'non_monthly'),
    cat('groceries', 'flexible'),
    cat('restaurants', 'flexible'),
    cat('paychecks', 'income'),
    cat('transfer', 'transfer'),
  ],
  amounts: new Map([['2026-08', map({ rent: 215000, internet: 9500 })]]),
};
const ledger = new Map([
  ['2026-08', month({ rent: 215000, internet: 9500, groceries: 60000 })],
  // A flight in September: more than the two months set aside.
  ['2026-09', month({ rent: 215000, internet: 9500, travel: 80000, groceries: 61000 })],
  [
    '2026-10',
    month({ rent: 215000, internet: 9500, groceries: 61248, restaurants: 29130, transfer: 1 }),
  ],
]);
const view = (m: string, b = budget) =>
  computeBudgetMonth(b, m, ledger, { flex, category: categoryLimits }).view as FlexView;

describe('flex', () => {
  it('budgets fixed costs one by one, and flexible spending as one number', () => {
    const v = view('2026-10');
    expect(v.fixed).toEqual([
      { categoryId: 'rent', budgetedMinor: 215000, spentMinor: 215000, leftMinor: 0 },
      { categoryId: 'internet', budgetedMinor: 9500, spentMinor: 9500, leftMinor: 0 },
    ]);
    expect(v.flexible).toEqual({
      budgetedMinor: 150500,
      spentMinor: 61248 + 29130,
      leftMinor: 150500 - 61248 - 29130,
      categories: [
        { categoryId: 'groceries', spentMinor: 61248 },
        { categoryId: 'restaurants', spentMinor: 29130 },
      ],
    });
    expect(v.totals.spentMinor).toBe(215000 + 9500 + 61248 + 29130);
  });

  it('sets aside a twelfth of a yearly figure each month, and spends from it (D12)', () => {
    // 300 a month: 300 in August, 600 − 800 = −200 after September's flight, 100 in October.
    expect(view('2026-08').nonMonthly).toEqual([
      {
        categoryId: 'travel',
        yearlyMinor: 360000,
        setAsideMinor: 30000,
        spentMinor: 0,
        savedMinor: 30000,
      },
    ]);
    expect(view('2026-09').nonMonthly[0]).toMatchObject({ spentMinor: 80000, savedMinor: -20000 });
    expect(view('2026-10').nonMonthly[0]).toMatchObject({ savedMinor: 10000 });
    // Gifts has no yearly figure and no spending: nothing to show.
    expect(view('2026-10').nonMonthly.map((r) => r.categoryId)).toEqual(['travel']);
  });

  it('changes the flexible number from a month on, never before', () => {
    const changed: BudgetDefinition = {
      ...budget,
      periods: [
        {
          fromMonth: '2026-08',
          kind: 'flex',
          settings: { flexibleMinor: { '2026-08': 150500, '2026-10': 120000 } },
        },
      ],
    };
    expect(view('2026-09', changed).flexible.budgetedMinor).toBe(150500);
    expect(view('2026-10', changed).flexible.budgetedMinor).toBe(120000);
    expect(flexibleFor('2026-07', new Map([['2026-08', 1]]))).toBe(0);
  });

  it('refuses settings that aren’t months to amounts', () => {
    expect(() => flex.settings({ flexibleMinor: { October: 1 } })).toThrow(BudgetSettingsError);
    expect(() => flex.settings({ flexibleMinor: { '2026-10': -1 } })).toThrow(BudgetSettingsError);
    expect(flex.settings({}).flexibleMinor.size).toBe(0);
  });
});
