// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { estimatedMinimum, payoff, type PayoffDebt } from './payoff.js';

const card: PayoffDebt = {
  id: 'card',
  owedMinor: 300_000,
  aprBps: 2400,
  minimumMinor: 10_000,
  extraMinor: 0,
};
const loan: PayoffDebt = {
  id: 'loan',
  owedMinor: 100_000,
  aprBps: 600,
  minimumMinor: 10_000,
  extraMinor: 0,
};

describe('payoff (walkthrough §8)', () => {
  it('adds a month’s interest, then pays', () => {
    const p = payoff([{ ...card, owedMinor: 100_000 }], 'minimums', '2026-11');
    // 2% a month: $1,000 + $20, less $100.
    expect(p.months[0]).toEqual({ month: '2026-11', owedMinor: [92_000] });
    expect(p.interestMinor).toBeGreaterThan(0);
  });

  it('pays off without interest exactly, counting this month', () => {
    const p = payoff([{ ...loan, aprBps: null }], 'minimums', '2026-11');
    expect(p.paidOff.loan).toBe('2027-08');
    expect(p.debtFreeMonth).toBe('2027-08');
    expect(p.interestMinor).toBe(0);
    expect(p.months).toHaveLength(10);
  });

  it('never pays off when the payment doesn’t cover the interest', () => {
    const p = payoff([{ ...card, minimumMinor: 5_000 }], 'minimums', '2026-11');
    expect(p.paidOff.card).toBeNull();
    expect(p.debtFreeMonth).toBeNull();
  });

  it('avalanche puts the extra on the highest rate, snowball on the smallest balance', () => {
    const debts = [loan, { ...card, extraMinor: 20_000 }];
    expect(payoff(debts, 'avalanche', '2026-11').order).toEqual(['card', 'loan']);
    expect(payoff(debts, 'snowball', '2026-11').order).toEqual(['loan', 'card']);
  });

  it('rolls a paid-off debt’s payment onto the next, so pooling beats paying each its own', () => {
    // The loan's paid off in under a year; pooled, its $100 then goes to the card.
    const debts = [loan, { ...card, owedMinor: 600_000, extraMinor: 20_000 }];
    const planned = payoff(debts, 'planned', '2026-11');
    const avalanche = payoff(debts, 'avalanche', '2026-11');
    const minimums = payoff(debts, 'minimums', '2026-11');
    expect(avalanche.debtFreeMonth! < planned.debtFreeMonth!).toBe(true);
    expect(avalanche.interestMinor).toBeLessThan(planned.interestMinor);
    expect(planned.interestMinor).toBeLessThan(minimums.interestMinor);
    // Each month pays no more than the pool: $400.
    const total = (i: number) => avalanche.months[i]!.owedMinor.reduce((a, b) => a + b, 0);
    expect(total(0)).toBeGreaterThanOrEqual(700_000 - 40_000);
  });

  it('avalanche pays less interest than snowball when the big debt costs more', () => {
    const debts = [loan, { ...card, extraMinor: 20_000 }];
    expect(payoff(debts, 'avalanche', '2026-11').interestMinor).toBeLessThanOrEqual(
      payoff(debts, 'snowball', '2026-11').interestMinor,
    );
  });

  it('is debt-free already with nothing owed', () => {
    const p = payoff([{ ...card, owedMinor: 0 }], 'planned', '2026-11');
    expect(p).toMatchObject({ debtFreeMonth: '2026-11', interestMinor: 0, months: [] });
  });

  it('estimates a minimum of 2%, at least 25, never more than what’s owed', () => {
    expect(estimatedMinimum(500_000)).toBe(10_000);
    expect(estimatedMinimum(50_000)).toBe(2_500);
    expect(estimatedMinimum(1_000)).toBe(1_000);
  });
});
