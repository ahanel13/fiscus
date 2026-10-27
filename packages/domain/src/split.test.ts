// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { type SplitPolicyRow, splitRuleFor, splitShares } from './split.js';

const shares = (s: Record<string, number>) => ({
  method: 'fixed_percent' as const,
  shares: Object.entries(s).map(([memberId, shareBps]) => ({ memberId, shareBps })),
});

describe('splitRuleFor', () => {
  const policies: SplitPolicyRow[] = [
    { categoryId: null, effectiveFrom: '2026-01-01', rule: { method: 'equal' } },
    { categoryId: null, effectiveFrom: '2026-09-01', rule: shares({ a: 6000, b: 4000 }) },
    { categoryId: 'pets', effectiveFrom: '2026-06-01', rule: shares({ a: 3000, b: 7000 }) },
    // Pets go back to the household's default from November.
    { categoryId: 'pets', effectiveFrom: '2026-11-01', rule: null },
  ];

  it('uses the category’s own rule from its month, else the default from then', () => {
    expect(splitRuleFor(policies, 'pets', '2026-05-31')).toEqual({ method: 'equal' });
    expect(splitRuleFor(policies, 'pets', '2026-06-01')).toEqual(shares({ a: 3000, b: 7000 }));
    expect(splitRuleFor(policies, 'pets', '2026-11-15')).toEqual(shares({ a: 6000, b: 4000 }));
    expect(splitRuleFor(policies, 'groceries', '2026-08-31')).toEqual({ method: 'equal' });
    expect(splitRuleFor(policies, null, '2026-09-01')).toEqual(shares({ a: 6000, b: 4000 }));
  });

  it('splits equally with no rules at all, or before the first', () => {
    expect(splitRuleFor([], 'pets', '2026-10-01')).toEqual({ method: 'equal' });
    expect(splitRuleFor(policies, 'pets', '2025-12-31')).toEqual({ method: 'equal' });
  });
});

describe('splitShares', () => {
  it('splits equally, giving odd basis points to the first members', () => {
    expect(splitShares({ method: 'equal' }, ['a', 'b'])).toEqual(
      new Map([
        ['a', 5000],
        ['b', 5000],
      ]),
    );
    expect(splitShares({ method: 'equal' }, ['a', 'b', 'c'])).toEqual(
      new Map([
        ['a', 3334],
        ['b', 3333],
        ['c', 3333],
      ]),
    );
  });

  it('scales fixed percentages to the members an expense is for', () => {
    const rule = shares({ a: 5000, b: 3000, c: 2000 });
    expect(splitShares(rule, ['a', 'b', 'c'])).toEqual(
      new Map([
        ['a', 5000],
        ['b', 3000],
        ['c', 2000],
      ]),
    );
    // For a and b only: 5:3.
    expect(splitShares(rule, ['a', 'b'])).toEqual(
      new Map([
        ['a', 6250],
        ['b', 3750],
      ]),
    );
    // Someone the rule doesn't name pays nothing of it…
    expect(splitShares(rule, ['a', 'd'])).toEqual(new Map([['a', 10000]]));
    // …unless nobody it's for is named: then it's equal.
    expect(splitShares(rule, ['d', 'e'])).toEqual(
      new Map([
        ['d', 5000],
        ['e', 5000],
      ]),
    );
  });

  it('always adds up to 10 000', () => {
    const rule = shares({ a: 3333, b: 3333, c: 3334 });
    for (const members of [
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
      ['a', 'b', 'c'],
    ]) {
      const out = splitShares(rule, members)!;
      expect([...out.values()].reduce((x, y) => x + y, 0)).toBe(10000);
    }
  });

  it('leaves fixed amounts to the month, and has nothing to split for nobody', () => {
    expect(
      splitShares({ method: 'fixed_amount', amounts: [{ memberId: 'a', amountMinor: 40000 }] }, [
        'a',
        'b',
      ]),
    ).toBeNull();
    expect(splitShares({ method: 'equal' }, [])).toEqual(new Map());
  });
});
