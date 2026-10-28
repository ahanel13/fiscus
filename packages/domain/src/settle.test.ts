// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { allocate, expenseEffects, pairBalances, type SharedExpense } from './settle.js';
import type { SplitPolicyRow } from './split.js';

const both = [
  { memberId: 'alex', shareBps: 5000 },
  { memberId: 'sam', shareBps: 5000 },
];
const by = (memberId: string) => [{ memberId, shareBps: 10000 }];
const expense = (
  id: string,
  costMinor: number,
  paidBy: SharedExpense['paidBy'],
  over: Partial<SharedExpense> = {},
): SharedExpense => ({
  id,
  date: '2026-10-12',
  categoryId: 'groceries',
  costMinor,
  forMembers: both,
  paidBy,
  ...over,
});

// The walkthrough's October (§8): Alex's card for Costco and a movie, Sam's for the vet and
// dinner, and rent from the joint account, all split equally.
const october: SharedExpense[] = [
  expense('costco', 18640, by('alex')),
  expense('vet', 13162, by('sam'), { categoryId: 'pets' }),
  expense('movie', 4000, by('alex'), { categoryId: 'entertainment' }),
  expense('thai', 8850, by('sam'), { categoryId: 'restaurants' }),
  expense('rent', 215000, both, { categoryId: 'rent' }),
];

describe('allocate', () => {
  it('adds up exactly, the odd cent to whoever comes first', () => {
    expect(
      allocate(
        101,
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
        'b',
      ),
    ).toEqual(
      new Map([
        ['a', 50],
        ['b', 51],
      ]),
    );
    expect(
      allocate(
        -101,
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
        'a',
      ),
    ).toEqual(
      new Map([
        ['a', -51],
        ['b', -50],
      ]),
    );
    expect(
      allocate(
        100,
        new Map([
          ['a', 3333],
          ['b', 3333],
          ['c', 3334],
        ]),
      ),
    ).toEqual(
      new Map([
        ['a', 34],
        ['b', 33],
        ['c', 33],
      ]),
    );
  });
});

describe('who owes whom', () => {
  it('sums what each person paid against what each owes, pair by pair (D17)', () => {
    const balances = pairBalances(expenseEffects(october, []));
    // Sam owes 93.20 + 20.00; Alex owes 65.81 + 44.25. Rent from the joint account evens out.
    expect(balances.owes('sam', 'alex')).toBe(9320 + 2000 - 6581 - 4425);
    expect(balances.withMember('alex')).toEqual(new Map([['sam', 314]]));
    expect(balances.withMember('sam')).toEqual(new Map([['alex', -314]]));
  });

  it('follows a category’s fixed percentages, and a split set by hand wins', () => {
    const policies: SplitPolicyRow[] = [
      {
        categoryId: 'pets',
        effectiveFrom: '2026-01-01',
        rule: {
          method: 'fixed_percent',
          shares: [
            { memberId: 'sam', shareBps: 7000 },
            { memberId: 'alex', shareBps: 3000 },
          ],
        },
      },
    ];
    const vet = expense('vet', 10000, by('sam'), { categoryId: 'pets' });
    expect(pairBalances(expenseEffects([vet], policies)).owes('alex', 'sam')).toBe(3000);
    const byHand = {
      ...vet,
      forMembers: [
        { memberId: 'alex', shareBps: 9000 },
        { memberId: 'sam', shareBps: 1000 },
      ],
    };
    expect(pairBalances(expenseEffects([byHand], policies)).owes('alex', 'sam')).toBe(9000);
  });

  it('works out a fixed monthly amount over the month, the rest equally (#109)', () => {
    const policies: SplitPolicyRow[] = [
      {
        categoryId: 'childcare',
        effectiveFrom: '2026-01-01',
        rule: { method: 'fixed_amount', amounts: [{ memberId: 'alex', amountMinor: 40000 }] },
      },
    ];
    const care = [
      expense('a', 60000, by('sam'), { categoryId: 'childcare', date: '2026-10-03' }),
      expense('b', 40000, by('sam'), { categoryId: 'childcare', date: '2026-10-17' }),
    ];
    // 1,000 in all: Alex 400, Sam the other 600. Sam paid it all, so Alex owes 400.
    expect(pairBalances(expenseEffects(care, policies)).owes('alex', 'sam')).toBe(40000);
    // A cheaper month scales the fixed amount down: Alex never pays more than the month cost.
    const cheap = [expense('c', 30000, by('sam'), { categoryId: 'childcare' })];
    expect(pairBalances(expenseEffects(cheap, policies)).owes('alex', 'sam')).toBe(30000);
  });

  it('shares among three, each debtor paying the creditors in proportion', () => {
    const three = [
      { memberId: 'a', shareBps: 3334 },
      { memberId: 'b', shareBps: 3333 },
      { memberId: 'c', shareBps: 3333 },
    ];
    const effects = expenseEffects(
      [expense('x', 30000, by('a'), { forMembers: three.map((t) => ({ ...t, shareBps: 3333 })) })],
      [],
    );
    const p = pairBalances(effects);
    expect(p.owes('b', 'a')).toBe(10000);
    expect(p.owes('c', 'a')).toBe(10000);
    expect(p.owes('b', 'c')).toBe(0);
  });

  it('reduces the balance for a refund', () => {
    const refund = expense('r', -2000, by('alex'));
    expect(pairBalances(expenseEffects([october[0]!, refund], [])).owes('sam', 'alex')).toBe(
      9320 - 1000,
    );
  });
});
