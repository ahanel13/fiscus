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
