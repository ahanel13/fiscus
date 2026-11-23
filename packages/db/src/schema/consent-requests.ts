// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.js';
import { householdMembers, households } from './households.js';

// Consent requests (ADR 0012 §Departures item 5, #265, budgeting walkthrough D34): one member
// asking another to agree to something only that person can agree to. Row-level security:
// migration 0114.

/**
 * What's asked. A split by income (F4, D19) is the first: it's answered by agreeing under Shared
 * costs (`income_split_consents`). Deleting or transferring a joint account (ADR 0012) adds kinds
 * here once those actions exist.
 */
export const consentRequestKind = pgEnum('consent_request_kind', ['income_split']);

/** `pending` until answered, withdrawn by whoever asked, or 14 days pass (`expired`). */
export const consentRequestStatus = pgEnum('consent_request_status', [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
]);

/** How long a request waits for an answer (ADR 0012 §Departures item 5). */
export const CONSENT_REQUEST_DAYS = 14;

/**
 * One request from one member to another. Never deleted: what was asked and how it ended stays,
 * as it does in the activity history. At most one is pending for each kind and person asked.
 */
export const consentRequests = pgTable(
  'consent_requests',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    kind: consentRequestKind().notNull(),
    requestedByMemberId: uuid().notNull(),
    /** Who's asked. */
    memberId: uuid().notNull(),
    status: consentRequestStatus().notNull().default('pending'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true })
      .notNull()
      .default(sql.raw(`(now() + interval '${CONSENT_REQUEST_DAYS} days')`)),
    /** When it stopped being pending: answered, withdrawn or expired. */
    closedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.requestedByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    uniqueIndex('consent_requests_pending')
      .on(t.householdId, t.kind, t.memberId)
      .where(sql`${t.status} = 'pending'`),
    index().on(t.memberId),
    index().on(t.requestedByMemberId),
    check('consent_requests_not_yourself', sql`${t.requestedByMemberId} <> ${t.memberId}`),
    check('consent_requests_closed', sql`(${t.status} = 'pending') = (${t.closedAt} IS NULL)`),
    check('consent_requests_expires', sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);
