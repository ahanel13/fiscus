// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ConsentRequest, HouseholdMember } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import {
  describeIncomeSplit,
  describeRequest,
  describeRule,
  latestRequest,
} from './shared-costs-settings.js';

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

describe('consent requests (#265, D34)', () => {
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  const request = (over: Partial<ConsentRequest>): ConsentRequest => ({
    id: 'r1',
    kind: 'income_split',
    requestedByMemberId: 'a',
    memberId: 's',
    status: 'pending',
    createdAt: '2026-11-21T15:00:00.000Z',
    expiresAt: '2026-12-05T15:00:00.000Z',
    closedAt: null,
    ...over,
  });

  it('says who asked, and when it ends', () => {
    expect(describeRequest(request({}), members)).toBe(
      `You asked on ${day('2026-11-21T15:00:00.000Z')}. It ends on ${day('2026-12-05T15:00:00.000Z')}.`,
    );
    expect(describeRequest(request({ requestedByMemberId: 's', memberId: 'a' }), members)).toMatch(
      /^Sam asked on /,
    );
  });

  it('says how it ended, when that still matters', () => {
    const closedAt = '2026-11-22T10:00:00.000Z';
    expect(describeRequest(request({ status: 'declined', closedAt }), members)).toBe(
      `Declined on ${day(closedAt)}.`,
    );
    expect(describeRequest(request({ status: 'expired', closedAt }), members)).toBe(
      `Didn’t answer by ${day('2026-12-05T15:00:00.000Z')}.`,
    );
  });

  it('uses the latest request to someone, and forgets withdrawn or answered ones', () => {
    const old = request({ id: 'old', status: 'declined', createdAt: '2026-11-01T00:00:00.000Z' });
    const now = request({ id: 'now' });
    expect(latestRequest([old, now], 's')?.id).toBe('now');
    expect(latestRequest([old], 's')?.id).toBe('old');
    expect(latestRequest([old, request({ id: 'w', status: 'withdrawn' })], 's')).toBeNull();
    expect(latestRequest([now], 'a')).toBeNull();
  });
});
