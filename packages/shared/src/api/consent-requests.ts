// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// Consent requests (ADR 0012 §Departures item 5, #265, budgeting walkthrough D34): asking another
// member to agree to something only they can agree to. Each waits 14 days for an answer; after
// that it has expired, and whoever asked can ask again.

/**
 * What can be asked. A split by income (F4, D19) is answered by agreeing under Shared costs.
 * Deleting or transferring a joint account (ADR 0012) come with those actions.
 */
export const CONSENT_REQUEST_KINDS = ['income_split'] as const;
export const consentRequestKindSchema = z.enum(CONSENT_REQUEST_KINDS);
export type ConsentRequestKind = z.infer<typeof consentRequestKindSchema>;

export const CONSENT_REQUEST_STATUSES = [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
] as const;
export type ConsentRequestStatus = (typeof CONSENT_REQUEST_STATUSES)[number];

/** How long a request waits for an answer. */
export const CONSENT_REQUEST_DAYS = 14;

export const createConsentRequestSchema = z.strictObject({
  kind: consentRequestKindSchema,
  /** Who's asked: another current member who isn't a viewer. */
  memberId: z.uuid(),
});
export type CreateConsentRequest = z.infer<typeof createConsentRequestSchema>;

/** A request, as everyone in the household sees it. */
export interface ConsentRequest {
  id: string;
  kind: ConsentRequestKind;
  requestedByMemberId: string;
  memberId: string;
  /** `pending` until it's answered, withdrawn, or its 14 days are over. */
  status: ConsentRequestStatus;
  createdAt: string;
  expiresAt: string;
  /** When it stopped being pending. */
  closedAt: string | null;
}
