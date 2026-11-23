// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// Moving out (#253, ADR 0012 step 3, permissions HH-20, budgeting walkthrough D37): a member
// spins off into a household of their own, taking what's theirs. Nobody can stop it; the owners
// are told, and it's in both households' activity.

/** Why someone can't move out yet. */
export const MOVE_OUT_BLOCKERS = ['dependent', 'last_owner', 'only_member'] as const;
export type MoveOutBlockerCode = (typeof MOVE_OUT_BLOCKERS)[number];

export const MOVE_OUT_BLOCKER_TEXT: Record<MoveOutBlockerCode, string> = {
  dependent:
    'A dependent’s profile needs its own login before it can move out: they claim it first, so the person leaving always agrees themselves.',
  last_owner:
    'You’re the only owner. Make someone else an owner first, so the household isn’t left without one.',
  only_member: 'You’re the only member, so this household is already yours alone.',
};

/** GET …/move-out/preview: what would move, stay, and be copied, right now. */
export interface MoveOutPreview {
  blockers: MoveOutBlockerCode[];
  /** Already moving: the new household's id, while the move runs. */
  moving: { householdId: string } | null;
  moves: {
    accounts: {
      id: string;
      name: string;
      transactionCount: number;
      /** Its bank connection moves too; or it needs re-linking in the new household. */
      connection: 'moves' | 'relink' | null;
    }[];
    connections: {
      id: string;
      institutionName: string | null;
      outcome: 'moves' | 'relink';
      accountCount: number;
    }[];
    /** Your own budget (Mine). */
    budget: boolean;
    goals: { id: string; name: string; wasHousehold: boolean }[];
    rules: { id: string; name: string | null }[];
    /** Purchases on your accounts that were for someone else: they become yours. */
    forOthers: number;
  };
  stays: {
    /** Joint accounts: you're no longer an owner, and your share goes to the others. */
    jointAccounts: {
      id: string;
      name: string;
      owners: { memberId: string; displayName: string; shareBps: number }[];
      /** Your bank login is behind it: the others re-link it with theirs. */
      relink: boolean;
    }[];
    /** Purchases on other people's accounts that were for you: they're the payer's. */
    attributedElsewhere: number;
    /** Your own pay-down goals on a joint debt, and rules only for accounts that stay. */
    goalsLeft: { id: string; name: string }[];
    rulesLeft: { id: string; name: string | null }[];
    /** Claims that end: one of your goals on an account that stays, or the reverse. */
    claimsEnding: number;
  };
  copied: {
    categories: { id: string; name: string; groupName: string }[];
    tags: { id: string; name: string }[];
  };
  /** The final settle-up with each member, recorded in both households (ADR 0012 step 3.2). */
  settleUp: { memberId: string; displayName: string; amountMinor: number; currency: string }[];
  /** The new household's settings start as copies of these. */
  household: { name: string; baseCurrency: string; timezone: string };
}

/** POST …/move-out: the new household's name; its settings are copied from this one. */
export const startMoveOutSchema = z.object({
  name: z.string().trim().min(1).max(80),
});
export type StartMoveOut = z.infer<typeof startMoveOutSchema>;

export const MEMBER_MOVE_STATUSES = ['pending', 'moving', 'done', 'failed'] as const;
export type MemberMoveStatus = (typeof MEMBER_MOVE_STATUSES)[number];

/** GET /households/:id/move-in, in the new household: how the move is going. */
export interface MemberMove {
  id: string;
  status: MemberMoveStatus;
  /** Steps done of `steps`. */
  step: number;
  steps: number;
  errorCode: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The settle-up when the move started, with the members of the household left. */
  finalBalances: { memberId: string; displayName: string; amountMinor: number; currency: string }[];
}

/** How many steps the worker's move has (apps/worker move-out). */
export const MEMBER_MOVE_STEPS = 5;
