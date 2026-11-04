// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type BudgetCategory,
  type BudgetDefinition,
  BudgetSettingsError,
  computeBudgetMonth,
} from './budget.js';
import { percentage, type PercentageView } from './percentage.js';
import { STRATEGY_REGISTRY } from './strategies.js';

const cat = (id: string, kind: BudgetCategory['kind'], bucket: string | null = null) => ({
  id,
  kind,
  rollover: false,
  bucket,
  yearlyMinor: null,
});
const map = (o: Record<string, number>) => new Map(Object.entries(o));

// The walkthrough's 50/30/20 screen (§3.3): Alex's own budget.
const budget: BudgetDefinition = {
  scope: 'mine',
  startsMonth: '2026-10',
  periods: [{ fromMonth: '2026-10', kind: 'percentage', settings: {} }],
  categories: [
    cat('internet', 'fixed'),
    cat('loans', 'fixed'),
    cat('medical', 'flexible', 'needs'),
    cat('restaurants', 'flexible'),
    cat('flights', 'non_monthly'),
    cat('investments', 'savings'),
    cat('paychecks', 'income'),
  ],
  amounts: new Map(),
};
const ledger = new Map([
  [
    '2026-10',
    {
      spentMinor: map({
        internet: 6500,
        loans: 31000,
        medical: 4000,
        restaurants: 21430,
        flights: 35000,
        investments: 50000,
      }),
      incomeMinor: 570000,
      incomeByCategory: map({ paychecks: 570000 }),
      contributionsMinor: 260000,
      savingsMovedMinor: 20000,
    },
  ],
]);
const view = (b = budget) =>
  computeBudgetMonth(b, '2026-10', ledger, STRATEGY_REGISTRY).view as PercentageView;
const bucket = (v: PercentageView, key: string) => v.buckets.find((b) => b.key === key)!;

describe('50/30/20', () => {
  it('splits income after contributions by percentage (D11)', () => {
    const v = view();
    expect(v.base).toEqual({ kind: 'after_contributions', income: 'actual', amountMinor: 310000 });
    expect(v.buckets.map((b) => [b.key, b.targetMinor])).toEqual([
      ['needs', 155000],
      ['wants', 93000],
      ['savings', 62000],
    ]);
  });

  it('fills buckets by group kind, with a moved category where it was moved (D10)', () => {
    const v = view();
    expect(bucket(v, 'needs').spentMinor).toBe(6500 + 31000 + 4000);
    expect(bucket(v, 'needs').categories[0]).toEqual({ categoryId: 'loans', spentMinor: 31000 });
    expect(bucket(v, 'wants').spentMinor).toBe(21430 + 35000);
  });

  it('counts money moved into savings in Savings, where over is good', () => {
    const s = bucket(view(), 'savings');
    expect(s).toMatchObject({ spentMinor: 70000, movedToSavingsMinor: 20000, saving: true });
    expect(s.spentMinor).toBeGreaterThan(s.targetMinor);
  });

  it('can split the whole income, counting contributions as a need', () => {
    const whole: BudgetDefinition = {
      ...budget,
      periods: [{ fromMonth: '2026-10', kind: 'percentage', settings: { base: 'whole' } }],
    };
    const v = view(whole);
    expect(v.base.amountMinor).toBe(570000);
    expect(bucket(v, 'needs').spentMinor).toBe(41500 + 260000);
  });

  it('can split an expected income, and any number of buckets', () => {
    const custom: BudgetDefinition = {
      ...budget,
      periods: [
        {
          fromMonth: '2026-10',
          kind: 'percentage',
          settings: {
            income: 'expected',
            expectedMinor: 400000,
            buckets: [
              { key: 'needs', name: 'Needs', percent: 60 },
              { key: 'savings', name: 'Savings', percent: 40 },
            ],
          },
        },
      ],
    };
    const v = view(custom);
    expect(v.base.amountMinor).toBe(400000 - 260000);
    // Wants has no bucket here: its spending still shows.
    expect(v.notInBucket.map((n) => n.categoryId).sort()).toEqual(['flights', 'restaurants']);
  });

  it('turns down buckets that don’t add up to 100%', () => {
    expect(() =>
      percentage.settings({ buckets: [{ key: 'needs', name: 'Needs', percent: 90 }] }),
    ).toThrow(BudgetSettingsError);
  });
});
