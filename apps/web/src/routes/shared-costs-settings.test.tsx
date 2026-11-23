// SPDX-License-Identifier: AGPL-3.0-or-later
import type { HouseholdMember } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { describeIncomeSplit, describeRule } from './shared-costs-settings.js';

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
    expect(describeRule({ method: 'income_proportional' }, members, 'USD')).toBe('By income');
  });

  it('says when a rule prorates for people who join or leave (#261)', () => {
    expect(describeRule({ method: 'equal', prorate: true }, members, 'USD')).toBe(
      'Equal · by days in the household',
    );
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

describe('describeIncomeSplit', () => {
  const split = (consented: Record<string, boolean>, shares: Record<string, number> = {}) => ({
    today: '2026-11-17',
    members: Object.entries(consented).map(([memberId, c]) => ({ memberId, consented: c })),
    shares: Object.entries(shares).map(([memberId, shareBps]) => ({ memberId, shareBps })),
    yours: null,
  });

  it('says who it’s waiting for, you first', () => {
    expect(describeIncomeSplit(split({ a: true, s: false }, { a: 10000 }), members)).toBe(
      'Waiting for Sam',
    );
    expect(describeIncomeSplit(split({ a: false, s: false }), members)).toBe(
      'Waiting for you and Sam',
    );
  });

  it('shows the split once everyone has agreed, never an income', () => {
    expect(describeIncomeSplit(split({ a: true, s: true }, { a: 4300, s: 5700 }), members)).toBe(
      'Sam 57% · you 43%',
    );
  });
});
