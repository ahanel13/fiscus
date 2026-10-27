// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest';
import {
  addMonths,
  amountsFor,
  type BudgetCategory,
  type BudgetDefinition,
  type BudgetStrategy,
  type Carry,
  computeBudgetMonth,
  firstDayOf,
  type MonthActivity,
  monthOf,
  periodFor,
} from './budget.js';

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
  contributionsMinor: 0,
});
const amounts = (a: Record<string, number>) => new Map(Object.entries(a));

// Two strategies small enough to check by hand. Envelopes: every category keeps its balance, and
// income not assigned waits. Limits: only rollover categories carry, and nothing else does.
const envelopes: BudgetStrategy<object, { available: Record<string, number> }> = {
  kind: 'zero_based',
  settings: () => ({}),
  month({ categories, amounts: a, activity: act, carry }) {
    const balances = new Map<string, number>();
    let assigned = 0;
    for (const c of categories) {
      const amount = a.get(c.id) ?? 0;
      assigned += amount;
      balances.set(
        c.id,
        (carry.balances.get(c.id) ?? 0) + amount - (act.spentMinor.get(c.id) ?? 0),
      );
    }
    const unassignedMinor =
      carry.unassignedMinor + act.incomeMinor + act.contributionsMinor - assigned;
    return {
      view: { available: Object.fromEntries(balances) },
      carry: { balances, unassignedMinor },
    };
  },
};
const limits: BudgetStrategy<object, { left: Record<string, number> }> = {
  kind: 'category',
  settings: () => ({}),
  month({ categories, amounts: a, activity: act, carry }) {
    const left = new Map<string, number>();
    for (const c of categories) {
      left.set(
        c.id,
        (carry.balances.get(c.id) ?? 0) + (a.get(c.id) ?? 0) - (act.spentMinor.get(c.id) ?? 0),
      );
    }
    const carried: Carry = {
      balances: new Map(categories.filter((c) => c.rollover).map((c) => [c.id, left.get(c.id)!])),
      unassignedMinor: 0,
    };
    return { view: { left: Object.fromEntries(left) }, carry: carried };
  },
};

describe('months', () => {
  it('steps across years, both ways', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -22)).toBe('2024-12');
    expect(addMonths('2026-10', 0)).toBe('2026-10');
  });

  it('converts between dates and months, and refuses anything else', () => {
    expect(monthOf('2026-10-26')).toBe('2026-10');
    expect(firstDayOf('2026-10')).toBe('2026-10-01');
    expect(() => addMonths('2026-13', 1)).toThrow(RangeError);
    expect(() => monthOf('Oct 2026')).toThrow(RangeError);
    expect(() => firstDayOf('2026-1')).toThrow(RangeError);
  });
});

describe('amountsFor', () => {
  const byMonth = new Map([
    ['2026-08', amounts({ groceries: 65000 })],
    ['2026-10', amounts({ groceries: 70000, dining: 25000 })],
  ]);

  it('uses a month’s own amounts, or the last month before it that had some', () => {
    expect(amountsFor('2026-08', byMonth)).toEqual(amounts({ groceries: 65000 }));
    expect(amountsFor('2026-09', byMonth)).toEqual(amounts({ groceries: 65000 }));
    expect(amountsFor('2026-10', byMonth)).toEqual(amounts({ groceries: 70000, dining: 25000 }));
    expect(amountsFor('2027-03', byMonth)).toEqual(amounts({ groceries: 70000, dining: 25000 }));
  });

  it('has none before the first month with any', () => {
    expect(amountsFor('2026-07', byMonth).size).toBe(0);
    expect(amountsFor('2026-07', new Map()).size).toBe(0);
  });
});

describe('periodFor', () => {
  const periods = [
    { fromMonth: '2026-08', kind: 'category' as const, settings: {} },
    { fromMonth: '2026-11', kind: 'zero_based' as const, settings: {} },
  ];

  it('picks the last period starting on or before the month, in any order', () => {
    expect(periodFor('2026-10', periods).kind).toBe('category');
    expect(periodFor('2026-11', periods).kind).toBe('zero_based');
    expect(periodFor('2027-01', [...periods].reverse()).kind).toBe('zero_based');
    expect(() => periodFor('2026-07', periods)).toThrow(RangeError);
  });
});

describe('computeBudgetMonth', () => {
  const budget = (over: Partial<BudgetDefinition> = {}): BudgetDefinition => ({
    startsMonth: '2026-08',
    periods: [{ fromMonth: '2026-08', kind: 'zero_based', settings: {} }],
    categories: [cat('groceries', true), cat('dining')],
    amounts: new Map([['2026-08', amounts({ groceries: 70000, dining: 25000 })]]),
    ...over,
  });
  const ledger = new Map([
    ['2026-08', activity({ groceries: 61200, dining: 30000 }, 100000)],
    // September: nothing happened.
    ['2026-10', activity({ groceries: 80000 }, 100000)],
  ]);

  it('carries each month into the next, with months that had no activity', () => {
    const out = computeBudgetMonth(budget(), '2026-10', ledger, { zero_based: envelopes });
    expect(out.kind).toBe('zero_based');
    // Groceries: 700 a month, 612 then 0 then 800 spent. Dining: 250 a month, 300 then 0 then 0.
    expect(out.view).toEqual({
      available: { groceries: 70000 * 3 - 61200 - 80000, dining: 25000 * 3 - 30000 },
    });
    // Income 2,000 over three months, 950 assigned each month.
    expect(out.carry.unassignedMinor).toBe(200000 - 95000 * 3);
  });

  it('shows the first month on its own', () => {
    const out = computeBudgetMonth(budget(), '2026-08', ledger, { zero_based: envelopes });
    expect(out.view).toEqual({ available: { groceries: 70000 - 61200, dining: 25000 - 30000 } });
  });

  it('carries across a change of strategy what the earlier one carried (D14)', () => {
    const switched = budget({
      periods: [
        { fromMonth: '2026-08', kind: 'category', settings: {} },
        { fromMonth: '2026-10', kind: 'zero_based', settings: {} },
      ],
    });
    const out = computeBudgetMonth(switched, '2026-10', ledger, {
      category: limits,
      zero_based: envelopes,
    });
    expect(out.kind).toBe('zero_based');
    // Under limits only Groceries rolled over: 700 − 612 in August, plus 700 in September.
    // Dining started October from nothing, though it was 50 over in August.
    expect(out.view).toEqual({
      available: { groceries: 70000 - 61200 + 70000 + 70000 - 80000, dining: 25000 },
    });
    // Nothing unassigned carried out of category limits: October's income is all there is.
    expect(out.carry.unassignedMinor).toBe(100000 - 95000);
  });

  it('reads each period’s settings once', () => {
    const settings = vi.fn(envelopes.settings);
    computeBudgetMonth(budget(), '2027-07', ledger, { zero_based: { ...envelopes, settings } });
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it('refuses a month before the budget starts, or a strategy that isn’t there', () => {
    expect(() =>
      computeBudgetMonth(budget(), '2026-07', ledger, { zero_based: envelopes }),
    ).toThrow(RangeError);
    expect(() => computeBudgetMonth(budget(), '2026-08', ledger, { category: limits })).toThrow(
      /zero_based strategy isn't available/,
    );
  });
});
