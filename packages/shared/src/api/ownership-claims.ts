// SPDX-License-Identifier: AGPL-3.0-or-later

// Ownership claims (#267, ADR 0012 §Departures item 7, permissions HH-17, budgeting walkthrough
// D35). When no owner has used Fiscus for a while, an adult member can ask to become an owner
// too. Every owner is told, and has 30 days to reject it; any owner using Fiscus in that time ends
// it. Otherwise the member becomes an additional owner. Nobody is demoted.

/** How long every owner must have been away before a claim can start. */
export const OWNERS_AWAY_DAYS = 30;
/** How long owners have to answer a claim: the notice period. */
export const CLAIM_NOTICE_DAYS = 30;
/** When owners are reminded, in days before the notice ends. */
export const CLAIM_REMINDER_DAYS = [7, 1] as const;

export const OWNERSHIP_CLAIM_STATUSES = [
  'open',
  'rejected',
  'withdrawn',
  'cancelled',
  'granted',
] as const;
export type OwnershipClaimStatus = (typeof OWNERSHIP_CLAIM_STATUSES)[number];

/** Why the worker ended a claim without granting it. */
export const OWNERSHIP_CLAIM_CANCEL_REASONS = ['owner_returned', 'claimant_ineligible'] as const;
export type OwnershipClaimCancelReason = (typeof OWNERSHIP_CLAIM_CANCEL_REASONS)[number];

/** An open claim, as everyone in the household sees it. */
export interface OwnershipClaim {
  id: string;
  claimantMemberId: string;
  status: OwnershipClaimStatus;
  createdAt: string;
  /** When the claimant becomes an owner, unless an owner rejects it or comes back first. */
  endsAt: string;
}

/** GET …/ownership-claims/current. */
export interface OwnershipClaimState {
  /** The household's open claim, if there is one. */
  claim: OwnershipClaim | null;
  /**
   * Whether you can start one now: you're a member (not an owner or viewer), none is open, and no
   * owner has used Fiscus for OWNERS_AWAY_DAYS. Only ever true for members, so nobody else learns
   * when the owners were last here.
   */
  canClaim: boolean;
}
