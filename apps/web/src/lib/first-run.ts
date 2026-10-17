// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MemberRole } from '@fiscus/shared';

/**
 * The member preference that turns on the dashboard's first-run checklist (#354). Creating a
 * household writes it, so households set up before the checklist existed never see it.
 */
export const FIRST_RUN_KEY = 'first-run';

export interface FirstRun {
  /** "Me and others" when the household was created: the checklist asks to invite them. */
  shared: boolean;
  /** Hidden by hand, or every step was done once: it doesn't come back. */
  closed?: boolean;
}

/** The stored preference, or null when it's missing or not one. */
export function parseFirstRun(value: unknown): FirstRun | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.shared !== 'boolean') return null;
  return { shared: v.shared, ...(v.closed === true ? { closed: true } : {}) };
}

export type FirstRunStepKey = 'accounts' | 'invite' | 'review';

export interface FirstRunStep {
  key: FirstRunStepKey;
  done: boolean;
}

/**
 * The checklist's steps, in order: add or import accounts; invite the others (owners of a
 * household created for more than one, until someone joins or has an invite); review what came in
 * (once something has, until nothing waits for review).
 */
export function firstRunSteps(input: {
  pref: FirstRun;
  role: MemberRole;
  accounts: number;
  members: number;
  pendingInvites: number;
  hasTransactions: boolean;
  toReview: number;
}): FirstRunStep[] {
  const steps: FirstRunStep[] = [{ key: 'accounts', done: input.accounts > 0 }];
  if (input.pref.shared && input.role === 'owner') {
    steps.push({ key: 'invite', done: input.members > 1 || input.pendingInvites > 0 });
  }
  steps.push({ key: 'review', done: input.hasTransactions && input.toReview === 0 });
  return steps;
}
