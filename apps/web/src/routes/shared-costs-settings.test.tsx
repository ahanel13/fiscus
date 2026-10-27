// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdMember } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { describeRule } from './shared-costs-settings.js';

const members = [
  { id: 'a', displayName: 'Alex', isYou: true },
  { id: 's', displayName: 'Sam', isYou: false },
] as HouseholdMember[];

describe('describeRule', () => {
  it('says each rule the way the walkthrough does', () => {
    expect(describeRule({ method: 'equal' }, members, 'USD')).toBe('Equal');
    expect(
      describeRule(
        {
          method: 'fixed_percent',
          shares: [
            { memberId: 'a', shareBps: 3000 },
            { memberId: 's', shareBps: 7000 },
          ],
        },
        members,
        'USD',
      ),
    ).toBe('Sam 70% · you 30%');
    expect(
      describeRule(
        { method: 'fixed_amount', amounts: [{ memberId: 'a', amountMinor: 40000 }] },
        members,
        'USD',
      ),
    ).toBe('You $400.00 a month · the rest equally');
    expect(describeRule(null, members, 'USD')).toBe('The household default');
  });

  it('names someone who left without guessing', () => {
    expect(
      describeRule(
        {
          method: 'fixed_percent',
          shares: [
            { memberId: 'gone', shareBps: 5000 },
            { memberId: 's', shareBps: 5000 },
          ],
        },
        members,
        'USD',
      ),
    ).toBe('Someone who left 50% · Sam 50%');
  });
});
