// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import type { Rule } from '@fiscus/shared';
import { describeActions, describeConditions, suggestMatchText, suggestRule } from './rules.js';

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

describe('rule suggestions', () => {
  const t = {
    originalDescription: 'TRADER JOE S #123 SALT LAKE',
    accountId: 'a1',
    amountMinor: -4512,
  };
  const rule = (actions: Rule['actions'], enabled = true) =>
    ({
      id: 'r',
      name: null,
      position: 1,
      enabled,
      conditions: { description: { op: 'contains', value: 'trader joe' } },
      actions,
      authorMemberId: 'm',
      authorLeft: false,
      version: 1,
      updatedAt: '',
    }) as Rule;

  it('matches the words before store numbers', () => {
    expect(suggestMatchText('TRADER JOE S #123 SALT LAKE')).toBe('TRADER JOE');
    expect(suggestMatchText('SQ *BLUE BOTTLE')).toBe('BLUE BOTTLE');
    expect(suggestMatchText('TST* SHAKE SHACK 123')).toBe('SHAKE SHACK');
    expect(suggestMatchText('PAYPAL *NETFLIX.COM')).toBe('NETFLIX.COM');
    expect(suggestMatchText('7-ELEVEN 1234')).toBe('7-ELEVEN 1234');
    expect(suggestMatchText('SEATGEEK TICKETS NEW YORK NY')).toBe('SEATGEEK TICKETS NEW');
    expect(suggestMatchText('9640 AMC ONLINE*9640LEAWOOD')).toBe('AMC ONLINE');
    expect(suggestMatchText('EBAY O*13-13869-45791')).toBe('EBAY');
    expect(suggestMatchText('Subway 15048')).toBe('Subway');
  });

  it('suggests a rule for a rename or a new category', () => {
    expect(
      suggestRule(t, { displayName: 'Trader Joe’s', categoryId: 'groc' }, [], [], 'unc'),
    ).toEqual({
      matchText: 'TRADER JOE',
      conditions: { description: { op: 'contains', value: 'TRADER JOE' } },
      actions: { rename: 'Trader Joe’s', categoryId: 'groc' },
    });
  });

  it('suggests adding the tags you added', () => {
    expect(suggestRule(t, { addedTagIds: ['sub'] }, [], [], 'unc')?.actions).toEqual({
      addTagIds: ['sub'],
    });
    const tagged = { ...rule({}), actions: { addTagIds: ['sub'] } } as Rule;
    expect(suggestRule(t, { addedTagIds: ['sub'] }, [tagged], [], 'unc')).toBeNull();
  });

  it('stays quiet when there’s nothing to learn, a rule already does it, or it’s muted', () => {
    expect(suggestRule(t, { categoryId: 'unc' }, [], [], 'unc')).toBeNull();
    expect(
      suggestRule(t, { categoryId: 'groc' }, [rule({ categoryId: 'groc' })], [], 'unc'),
    ).toBeNull();
    expect(
      suggestRule(t, { categoryId: 'groc' }, [rule({ categoryId: 'groc' }, false)], [], 'unc'),
    ).not.toBeNull();
    expect(
      suggestRule(t, { categoryId: 'groc' }, [rule({ categoryId: 'dining' })], [], 'unc'),
    ).not.toBeNull();
    expect(suggestRule(t, { categoryId: 'groc' }, [], ['trader joe'], 'unc')).toBeNull();
  });
});
