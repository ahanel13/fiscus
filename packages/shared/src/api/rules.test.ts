// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { ruleConditionsSchema, ruleMatches, type RuleSubject } from './rules.js';

const t = (extra: Partial<RuleSubject> = {}): RuleSubject => ({
  displayName: 'Trader Joe’s',
  originalDescription: 'TRADER JOE S #123  SALT LAKE',
  amountMinor: -4512,
  accountId: 'a1',
  categoryId: null,
  ...extra,
});

describe('ruleMatches', () => {
  it('matches the bank’s text or the name, ignoring case and spacing', () => {
    expect(ruleMatches({ description: { op: 'contains', value: 'trader joe s' } }, t())).toBe(true);
    expect(ruleMatches({ description: { op: 'starts_with', value: 'Trader' } }, t())).toBe(true);
    expect(ruleMatches({ description: { op: 'equals', value: 'trader joe’s' } }, t())).toBe(true);
    expect(ruleMatches({ description: { op: 'contains', value: 'costco' } }, t())).toBe(false);
  });

  it('needs every condition by default, or any one with match: any', () => {
    const walmart = t({ displayName: 'Wal-Mart', originalDescription: 'WAL-MART #1182' });
    const wm = t({ displayName: 'WM Supercenter', originalDescription: 'WM SUPERCENTER #1182' });
    const either = {
      match: 'any' as const,
      descriptions: [
        { op: 'contains' as const, value: 'wal-mart' },
        { op: 'starts_with' as const, value: 'wm super' },
      ],
    };
    expect(ruleMatches(either, walmart)).toBe(true);
    expect(ruleMatches(either, wm)).toBe(true);
    expect(ruleMatches(either, t())).toBe(false);
    // Every description check must hold without match: any.
    expect(ruleMatches({ descriptions: either.descriptions }, walmart)).toBe(false);
    expect(
      ruleMatches(
        {
          descriptions: [
            { op: 'contains', value: 'trader' },
            { op: 'contains', value: 'salt lake' },
          ],
        },
        t(),
      ),
    ).toBe(true);
    // Any one condition of any kind: here the amount, though the name doesn't match.
    expect(
      ruleMatches(
        {
          match: 'any',
          descriptions: [{ op: 'contains', value: 'costco' }],
          amount: { min: 4512, max: 4512 },
        },
        t(),
      ),
    ).toBe(true);
    expect(
      ruleMatches(
        { match: 'all', description: { op: 'contains', value: 'trader' }, direction: 'in' },
        t(),
      ),
    ).toBe(false);
  });

  it('needs a real condition, and one way of giving descriptions', () => {
    expect(ruleConditionsSchema.safeParse({ match: 'any' }).success).toBe(false);
    expect(
      ruleConditionsSchema.safeParse({
        description: { op: 'contains', value: 'a' },
        descriptions: [{ op: 'contains', value: 'b' }],
      }).success,
    ).toBe(false);
    expect(
      ruleConditionsSchema.safeParse({
        match: 'any',
        descriptions: [{ op: 'contains', value: 'b' }],
      }).success,
    ).toBe(true);
  });

  it('checks the amount’s size and direction, accounts, and category', () => {
    expect(ruleMatches({ amount: { min: 4000, max: 5000 } }, t())).toBe(true);
    expect(ruleMatches({ amount: { max: 4000 } }, t())).toBe(false);
    expect(ruleMatches({ direction: 'out' }, t())).toBe(true);
    expect(ruleMatches({ direction: 'in' }, t())).toBe(false);
    expect(ruleMatches({ accountIds: ['a2'] }, t())).toBe(false);
    // "Uncategorized" counts as no category.
    expect(ruleMatches({ categoryId: null }, t({ categoryId: 'unc' }), 'unc')).toBe(true);
    expect(ruleMatches({ categoryId: null }, t({ categoryId: 'groceries' }), 'unc')).toBe(false);
  });

  it('needs at least one condition', () => {
    expect(ruleConditionsSchema.safeParse({}).success).toBe(false);
  });
});
