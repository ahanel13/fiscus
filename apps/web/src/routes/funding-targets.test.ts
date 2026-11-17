// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FundingTarget } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { statusBadge } from './funding-targets.js';

const target = (t: Partial<FundingTarget>): FundingTarget => ({
  id: 't',
  accountId: 'a',
  memberId: 'm',
  method: 'fixed',
  amountMinor: 100_000,
  cadence: 'monthly',
  startsOn: '2026-03-01',
  status: 'on_track',
  contributedMinor: 0,
  differenceMinor: 0,
  leftThisPeriodMinor: 100_000,
  current: null,
  recent: [],
  setByMemberId: 'm',
  ...t,
});

describe('statusBadge', () => {
  it('warns when behind and is positive when on track or ahead', () => {
    expect(statusBadge(target({ status: 'behind', differenceMinor: 30_000 }), 'USD').tone).toBe(
      'warning',
    );
    expect(statusBadge(target({}), 'USD')).toEqual({ tone: 'positive', label: 'On track' });
    expect(statusBadge(target({ status: 'ahead', differenceMinor: 1 }), 'USD').tone).toBe(
      'positive',
    );
  });

  it('says when a target that hasn’t started begins', () => {
    expect(statusBadge(target({ status: 'not_started', startsOn: '2026-04-01' }), 'USD')).toEqual({
      tone: 'neutral',
      label: `Starts ${new Date('2026-04-01T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}`,
    });
  });
});
