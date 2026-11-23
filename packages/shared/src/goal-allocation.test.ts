// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  type AllocationAccount,
  splitByClaims,
  suggestAllocation,
  takeFromLowest,
} from './goal-allocation.js';

describe('takeFromLowest (G19)', () => {
  it('takes a shortfall from the lowest priority first, then the next', () => {
    const claims = [
      { goalId: 'trip', amountMinor: 120000 },
      { goalId: 'house', amountMinor: 1400000 },
    ];
    expect(takeFromLowest(170000, claims)).toEqual([
      { goalId: 'trip', amountMinor: 120000 },
      { goalId: 'house', amountMinor: 50000 },
    ]);
    expect(takeFromLowest(50000, claims)).toEqual([{ goalId: 'trip', amountMinor: 50000 }]);
  });

  it('never takes more than the claims hold, and nothing when nothing is short', () => {
    const claims = [{ goalId: 'trip', amountMinor: 1000 }];
    expect(takeFromLowest(5000, claims)).toEqual([{ goalId: 'trip', amountMinor: 1000 }]);
    expect(takeFromLowest(0, claims)).toEqual([]);
  });
});

describe('splitByClaims (walkthrough §5)', () => {
  it('splits by claim, the cents to the largest remainders, adding up exactly', () => {
    const split = splitByClaims(100, [
      { goalId: 'a', amountMinor: 1 },
      { goalId: 'b', amountMinor: 1 },
      { goalId: 'c', amountMinor: 1 },
    ]);
    // Three equal claims of 1 cent can give only 3 cents between them.
    expect(split).toEqual([
      { goalId: 'a', amountMinor: 1 },
      { goalId: 'b', amountMinor: 1 },
      { goalId: 'c', amountMinor: 1 },
    ]);
    const even = splitByClaims(1000, [
      { goalId: 'a', amountMinor: 3000 },
      { goalId: 'b', amountMinor: 3000 },
      { goalId: 'c', amountMinor: 3000 },
    ]);
    expect(even.map((x) => x.amountMinor)).toEqual([334, 333, 333]);
    expect(even.reduce((s, x) => s + x.amountMinor, 0)).toBe(1000);
  });

  it('never splits beyond the claims: goals you can’t see hold the rest', () => {
    // The account is $1,000.00 short, but the goals here only claim $600.00 of it.
    const split = splitByClaims(100000, [
      { goalId: 'a', amountMinor: 40000 },
      { goalId: 'b', amountMinor: 20000 },
    ]);
    expect(split).toEqual([
      { goalId: 'a', amountMinor: 40000 },
      { goalId: 'b', amountMinor: 20000 },
    ]);
  });

  it('is proportional', () => {
    expect(
      splitByClaims(170000, [
        { goalId: 'trip', amountMinor: 320000 },
        { goalId: 'house', amountMinor: 1400000 },
      ]),
    ).toEqual([
      { goalId: 'trip', amountMinor: 31628 },
      { goalId: 'house', amountMinor: 138372 },
    ]);
  });

  it('is empty when nothing is short or nothing is claimed', () => {
    expect(splitByClaims(0, [{ goalId: 'a', amountMinor: 10 }])).toEqual([]);
    expect(splitByClaims(10, [])).toEqual([]);
  });
});

describe('suggestAllocation (G25)', () => {
  const savings: AllocationAccount = {
    accountId: 'harbor',
    type: 'depository',
    subtype: 'savings',
    unclaimedMinor: 280000,
  };
  const checking: AllocationAccount = {
    accountId: 'checking',
    type: 'depository',
    subtype: 'checking',
    unclaimedMinor: 500000,
  };
  const brokerage: AllocationAccount = {
    accountId: 'brokerage',
    type: 'investment',
    subtype: 'brokerage',
    unclaimedMinor: 900000,
  };

  it('fills the highest priority first, up to what it needs, then the next', () => {
    expect(
      suggestAllocation(
        [
          { goalId: 'cushion', needMinor: 200000, claims: [] },
          { goalId: 'trip', needMinor: 500000, claims: [] },
        ],
        [savings],
      ),
    ).toEqual([
      { goalId: 'cushion', accountId: 'harbor', amountMinor: 200000 },
      { goalId: 'trip', accountId: 'harbor', amountMinor: 80000 },
    ]);
  });

  it('skips goals that are done, and stops when the money runs out', () => {
    expect(
      suggestAllocation(
        [
          { goalId: 'done', needMinor: 0, claims: [] },
          { goalId: 'trip', needMinor: 500000, claims: [] },
          { goalId: 'car', needMinor: 100000, claims: [] },
        ],
        [savings],
      ),
    ).toEqual([{ goalId: 'trip', accountId: 'harbor', amountMinor: 280000 }]);
  });

  it('leaves checking and investments a goal doesn’t draw on alone', () => {
    expect(
      suggestAllocation([{ goalId: 'trip', needMinor: 100000, claims: [] }], [checking, brokerage]),
    ).toEqual([]);
  });

  it('raises a fixed claim the goal already has first, on any account', () => {
    expect(
      suggestAllocation(
        [
          {
            goalId: 'house',
            needMinor: 1000000,
            claims: [{ accountId: 'brokerage', fixed: true }],
          },
        ],
        [savings, checking, brokerage],
      ),
    ).toEqual([
      { goalId: 'house', accountId: 'brokerage', amountMinor: 900000 },
      { goalId: 'house', accountId: 'harbor', amountMinor: 100000 },
    ]);
  });

  it('doesn’t offer an account a goal claims by percentage', () => {
    expect(
      suggestAllocation(
        [{ goalId: 'house', needMinor: 1000, claims: [{ accountId: 'harbor', fixed: false }] }],
        [savings],
      ),
    ).toEqual([]);
  });

  it('takes from the savings account with the most unclaimed first', () => {
    const small = { ...savings, accountId: 'small', unclaimedMinor: 5000 };
    expect(
      suggestAllocation([{ goalId: 'trip', needMinor: 282000, claims: [] }], [small, savings]),
    ).toEqual([
      { goalId: 'trip', accountId: 'harbor', amountMinor: 280000 },
      { goalId: 'trip', accountId: 'small', amountMinor: 2000 },
    ]);
  });

  it('offers nothing without unclaimed money', () => {
    expect(
      suggestAllocation(
        [{ goalId: 'trip', needMinor: 1000, claims: [] }],
        [{ ...savings, unclaimedMinor: 0 }],
      ),
    ).toEqual([]);
  });
});
