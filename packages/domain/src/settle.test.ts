// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import {
  allocate,
  expenseEffects,
  type MemberSpan,
  pairBalances,
  prorationFor,
  settlementEffect,
  type SharedExpense,
} from './settle.js';
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

  it('splits by income once both have agreed, and by the default before (#110)', () => {
    const policies: SplitPolicyRow[] = [
      { categoryId: 'rent', effectiveFrom: '2026-10-01', rule: { method: 'income_proportional' } },
    ];
    const income = (date: string) =>
      date >= '2026-10-10'
        ? [
            { memberId: 'alex', shareBps: 6000 },
            { memberId: 'sam', shareBps: 4000 },
          ]
        : null;
    const rent = (date: string) => expense(date, 200000, by('sam'), { categoryId: 'rent', date });
    // Before they agreed: equally, so Alex owes half.
    expect(
      pairBalances(expenseEffects([rent('2026-10-01')], policies, income)).owes('alex', 'sam'),
    ).toBe(100000);
    // After: Alex's 60%.
    expect(
      pairBalances(expenseEffects([rent('2026-10-12')], policies, income)).owes('alex', 'sam'),
    ).toBe(120000);
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

describe('settling up', () => {
  it('lowers what the payer owed, and can go past zero', () => {
    const effects = expenseEffects(october.slice(0, 1), []); // Sam owes Alex 93.20
    expect(
      pairBalances([...effects, settlementEffect('s', 'sam', 'alex', 9320)]).owes('sam', 'alex'),
    ).toBe(0);
    expect(
      pairBalances([...effects, settlementEffect('s', 'sam', 'alex', 10000)]).owes('alex', 'sam'),
    ).toBe(680);
  });
});

// Prorated shared costs (#261, D33): rent in a 30-day September, with Jo joining on the 16th.
describe('prorating for people who join or leave', () => {
  // As an equal attribution stores three: the remainder to the first.
  const three = [
    { memberId: 'alex', shareBps: 3334 },
    { memberId: 'sam', shareBps: 3333 },
    { memberId: 'jo', shareBps: 3333 },
  ];
  const rent = (over: Partial<SharedExpense> = {}) =>
    expense('rent', 150000, by('alex'), {
      date: '2026-09-01',
      categoryId: 'rent',
      forMembers: three,
      ...over,
    });
  const prorated = (rule: SplitPolicyRow['rule']): SplitPolicyRow[] => [
    { categoryId: 'rent', effectiveFrom: '2026-01-01', rule },
  ];
  const spans: MemberSpan[] = [
    { memberId: 'alex', from: '2025-01-01', to: null },
    { memberId: 'sam', from: '2025-01-01', to: null },
    { memberId: 'jo', from: '2026-09-16', to: null },
  ];
  const owed = (e: SharedExpense, p: SplitPolicyRow[], s = spans) =>
    Object.fromEntries(expenseEffects([e], p, undefined, s)[0]!.owed);

  it('weights an equal split by days in the household that month', () => {
    // 30 + 30 + 15 days: 600, 600 and 300 of 1,500.
    expect(owed(rent(), prorated({ method: 'equal', prorate: true }))).toEqual({
      alex: 60000,
      sam: 60000,
      jo: 30000,
    });
    expect(prorationFor(rent(), prorated({ method: 'equal', prorate: true }), spans)).toEqual([
      { memberId: 'jo', days: 15, ofDays: 30 },
    ]);
  });

  it('leaves a rule without prorate, and the household default, as they were', () => {
    expect(owed(rent(), prorated({ method: 'equal' }))).toEqual({
      alex: 50000,
      sam: 50000,
      jo: 50000,
    });
    // The default never prorates: it covers one-off expenses too.
    expect(
      owed(rent(), [{ categoryId: null, effectiveFrom: '2026-01-01', rule: { method: 'equal' } }]),
    ).toEqual({ alex: 50000, sam: 50000, jo: 50000 });
  });

  it('counts the day someone leaves as not theirs', () => {
    const left: MemberSpan[] = [
      { memberId: 'alex', from: '2025-01-01', to: null },
      { memberId: 'sam', from: '2025-01-01', to: '2026-09-11' },
      { memberId: 'jo', from: '2025-01-01', to: null },
    ];
    // Sam: the 1st to the 10th, 10 days. 30 + 10 + 30 = 70; odd cents from the payer on.
    expect(owed(rent(), prorated({ method: 'equal', prorate: true }), left)).toEqual({
      alex: 64286,
      sam: 21429,
      jo: 64285,
    });
  });

  it('is unchanged in months everyone was there for', () => {
    expect(
      owed(rent({ date: '2026-10-01' }), prorated({ method: 'equal', prorate: true })),
    ).toEqual({ alex: 50000, sam: 50000, jo: 50000 });
  });

  it('scales percentages by days, the others covering the rest in their proportions', () => {
    const rule = {
      method: 'fixed_percent' as const,
      shares: [
        { memberId: 'alex', shareBps: 5000 },
        { memberId: 'sam', shareBps: 2500 },
        { memberId: 'jo', shareBps: 2500 },
      ],
      prorate: true,
    };
    // Weights 50×30, 25×30, 25×15: 1500, 750, 375 of 2625.
    expect(owed(rent(), prorated(rule))).toEqual({ alex: 85715, sam: 42857, jo: 21428 });
  });

  it('prorates a fixed monthly amount', () => {
    const rule = {
      method: 'fixed_amount' as const,
      amounts: [{ memberId: 'jo', amountMinor: 40000 }],
      prorate: true,
    };
    // Jo: half of 400.00. The other 1,300.00 equally between Alex and Sam.
    expect(owed(rent(), prorated(rule))).toEqual({ jo: 20000, alex: 65000, sam: 65000 });
  });

  it('splits a three-way attribution by the rule, as an even split', () => {
    const rule = {
      method: 'fixed_percent' as const,
      shares: [
        { memberId: 'alex', shareBps: 5000 },
        { memberId: 'sam', shareBps: 2500 },
        { memberId: 'jo', shareBps: 2500 },
      ],
    };
    expect(owed(rent({ date: '2026-10-01' }), prorated(rule))).toEqual({
      alex: 75000,
      sam: 37500,
      jo: 37500,
    });
  });

  it('leaves shares set by hand alone', () => {
    const byHand = [
      { memberId: 'alex', shareBps: 5000 },
      { memberId: 'sam', shareBps: 3000 },
      { memberId: 'jo', shareBps: 2000 },
    ];
    expect(
      owed(rent({ forMembers: byHand }), prorated({ method: 'equal', prorate: true })),
    ).toEqual({ alex: 75000, sam: 45000, jo: 30000 });
  });
});
