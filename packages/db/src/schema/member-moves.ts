// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.js';
import { householdMembers, households } from './households.js';

// Moving out (#253, ADR 0012 step 3, permissions HH-20, budgeting walkthrough D37): a member
// spins off into a household of their own and takes their data with them. The api creates the new
// household and this row in it, in one transaction; the worker does the move under
// fiscus_maintenance, a step at a time. Row-level security: migration 0121.

/**
 * `pending` until the worker starts, `moving` while it works through the steps, then `done`, or
 * `failed` with a code when something stopped it before anything had moved.
 */
export const memberMoveStatus = pgEnum('member_move_status', [
  'pending',
  'moving',
  'done',
  'failed',
]);

/** One balance from the final settle-up, frozen when the move started (ADR 0012 step 3.2). */
export interface MemberMoveBalance {
  /** The other member, in the household being left. */
  memberId: string;
  displayName: string;
  /** Positive: they owe the person moving out. Negative: the person moving out owes them. */
  amountMinor: number;
  currency: string;
}

/**
 * A move, kept in the household it moves into: only the person moving sees it. It names the
 * household they left by id, with no foreign key, since a reference across households is what the
 * data model rules out everywhere else (ADR 0012, design constraint 2); the worker checks it.
 */
export const memberMoves = pgTable(
  'member_moves',
  {
    id: id(),
    /** The new household. */
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Who's moving, as a member of the new household (its owner). */
    memberId: uuid().notNull(),
    /** The household they're leaving, and who they were there. */
    fromHouseholdId: uuid().notNull(),
    fromMemberId: uuid().notNull(),
    status: memberMoveStatus().notNull().default('pending'),
    /** The last step finished (the worker's `MOVE_STEPS`): a restart carries on after it. */
    step: smallint().notNull().default(0),
    /** What moves, as ids, worked out by the worker when it starts, so a restart moves the same. */
    plan: jsonb().$type<Record<string, unknown>>(),
    /** The settle-up with each member when the move started (ADR 0012 step 3.2). */
    finalBalances: jsonb()
      .$type<MemberMoveBalance[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Why it failed: a code, never a message. */
    errorCode: text(),
    attempts: integer().notNull().default(0),
    /** A worker holds it until then. */
    leaseUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    // One move at a time for each membership.
    uniqueIndex('member_moves_open')
      .on(t.fromMemberId)
      .where(sql`${t.status} IN ('pending', 'moving')`),
    index().on(t.householdId),
    index('member_moves_due')
      .on(t.createdAt)
      .where(sql`${t.status} IN ('pending', 'moving')`),
    check('member_moves_households', sql`${t.householdId} <> ${t.fromHouseholdId}`),
    check(
      'member_moves_finished',
      sql`(${t.status} IN ('done', 'failed')) = (${t.finishedAt} IS NOT NULL)`,
    ),
    check('member_moves_error', sql`(${t.status} = 'failed') = (${t.errorCode} IS NOT NULL)`),
  ],
);
