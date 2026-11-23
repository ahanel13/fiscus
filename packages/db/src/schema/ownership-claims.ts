// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.js';
import { householdMembers, households } from './households.js';

// Ownership claims (#267, ADR 0012 §Departures item 7, permissions HH-17, budgeting walkthrough
// D35): a member asking to become an owner too, when no owner has used Fiscus for 30 days. Row-
// level security and the rules for each step: migration 0116.

/**
 * `open` for its 30 days. An owner rejects it, or the claimant withdraws it; the worker cancels it
 * when an owner comes back or the claimant can no longer claim, and grants it once the 30 days are
 * over.
 */
export const ownershipClaimStatus = pgEnum('ownership_claim_status', [
  'open',
  'rejected',
  'withdrawn',
  'cancelled',
  'granted',
]);

/** The notice period (ADR 0012): how long owners have to answer. */
const CLAIM_NOTICE_DAYS = 30;

/**
 * One claim. Never deleted: who claimed and how it ended stays, as it does in the activity
 * history. At most one is open in a household.
 */
export const ownershipClaims = pgTable(
  'ownership_claims',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    claimantMemberId: uuid().notNull(),
    status: ownershipClaimStatus().notNull().default('open'),
    /** Set by the database when it's made, as is `ends_at`: nobody chooses a shorter notice. */
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql.raw(`(now() + interval '${CLAIM_NOTICE_DAYS} days')`)),
    /** When it stopped being open. */
    closedAt: timestamp({ withTimezone: true }),
    /** The owner who rejected it, or the claimant who withdrew it. Null when the worker ended it. */
    closedByMemberId: uuid(),
    /** Why the worker cancelled it: `owner_returned` or `claimant_ineligible`. */
    cancelReason: text(),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.claimantMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.closedByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    uniqueIndex('ownership_claims_open')
      .on(t.householdId)
      .where(sql`${t.status} = 'open'`),
    index().on(t.claimantMemberId),
    check('ownership_claims_closed', sql`(${t.status} = 'open') = (${t.closedAt} IS NULL)`),
    check('ownership_claims_ends', sql`${t.endsAt} > ${t.createdAt}`),
    check(
      'ownership_claims_cancel_reason',
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} IS NOT NULL) AND (${t.cancelReason} IS NULL OR ${t.cancelReason} IN ('owner_returned', 'claimant_ineligible'))`,
    ),
    check(
      'ownership_claims_closed_by',
      sql`${t.closedByMemberId} IS NULL OR ${t.status} IN ('rejected', 'withdrawn')`,
    ),
  ],
);
