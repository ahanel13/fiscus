// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { describeActions, describeConditions } from './rules.js';

const names = {
  accounts: new Map([['a1', 'Checking']]),
  categories: new Map([['c1', 'Groceries']]),
  tags: new Map([['t1', 'Food']]),
  members: new Map([['m1', 'Bea']]),
};

describe('rules in words', () => {
  it('describes conditions', () => {
    expect(
      describeConditions(
        {
          description: { op: 'contains', value: 'trader joe' },
          direction: 'out',
          amount: { min: 4000 },
          accountIds: ['a1'],
          categoryId: null,
        },
        names,
        'USD',
      ),
    ).toBe(
      'Description contains “trader joe” · money out · $40.00 or more · in Checking · uncategorized',
    );
    expect(describeConditions({ amount: { min: 500, max: 500 } }, names, 'USD')).toBe(
      'amount $5.00',
    );
  });

  it('describes actions', () => {
    expect(
      describeActions(
        {
          rename: 'Trader Joe’s',
          categoryId: 'c1',
          addTagIds: ['t1'],
          attribution: [{ memberId: 'm1' }],
          markReviewed: true,
        },
        names,
      ),
    ).toBe('Rename to “Trader Joe’s” · Groceries · tag Food · for Bea · mark reviewed');
  });
});
