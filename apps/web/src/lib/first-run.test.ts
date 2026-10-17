// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MemberRole } from '@fiscus/shared';
import { describe, expect, it } from 'vitest';
import { firstRunSteps, parseFirstRun } from './first-run.js';

describe('first-run checklist (#354)', () => {
  const start = {
    role: 'owner' as MemberRole,
    accounts: 0,
    members: 1,
    pendingInvites: 0,
    hasTransactions: false,
    toReview: 0,
  };
  const steps = (input: Partial<typeof start> & { shared?: boolean }) =>
    firstRunSteps({ ...start, ...input, pref: { shared: input.shared ?? false } }).map(
      (s) => `${s.key}:${s.done ? 'done' : 'todo'}`,
    );

  it('asks for accounts, then a review of what came in', () => {
    expect(steps({})).toEqual(['accounts:todo', 'review:todo']);
    // An account and nothing in it yet: nothing to have reviewed.
    expect(steps({ accounts: 1 })).toEqual(['accounts:done', 'review:todo']);
    expect(steps({ accounts: 2, hasTransactions: true, toReview: 40 })).toEqual([
      'accounts:done',
      'review:todo',
    ]);
    expect(steps({ accounts: 2, hasTransactions: true })).toEqual(['accounts:done', 'review:done']);
  });

  it('asks owners of a household for more than one to invite them, until someone joins', () => {
    expect(steps({ shared: true })).toEqual(['accounts:todo', 'invite:todo', 'review:todo']);
    expect(steps({ shared: true, pendingInvites: 1 })).toContain('invite:done');
    expect(steps({ shared: true, members: 2 })).toContain('invite:done');
    // Only owners can invite.
    expect(steps({ shared: true, role: 'member' })).toEqual(['accounts:todo', 'review:todo']);
  });

  it('reads only a well-formed preference', () => {
    expect(parseFirstRun({ shared: true })).toEqual({ shared: true });
    expect(parseFirstRun({ shared: false, closed: true })).toEqual({ shared: false, closed: true });
    expect(parseFirstRun(undefined)).toBeNull();
    expect(parseFirstRun({ closed: true })).toBeNull();
    expect(parseFirstRun('yes')).toBeNull();
  });
});
