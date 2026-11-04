// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money, timestamps, versioning } from '../columns.js';
import { accounts } from './accounts.js';
import { householdMembers, households } from './households.js';

// Goals (#131; goals walkthrough, goals and budgets G1–G22). A savings goal draws on accounts by
// claims: part of a balance, as a fixed amount or a percentage (G2). Progress is the claims added
// up, never stored. Every change to a claim is kept with its reason (G17). Row-level security:
// migration 0088.

export const goalKind = pgEnum('goal_kind', ['save', 'pay_down']);

export const goals = pgTable(
  'goals',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** Whose (G15): null for the household's (Ours), or the member whose own it is (Mine). */
    memberId: uuid(),
    kind: goalKind().notNull().default('save'),
    name: text().notNull(),
    targetMinor: money('target_minor').notNull(),
    /** Optional: without a date there's no status, just progress (walkthrough §4). */
    targetDate: date({ mode: 'string' }),
    /** The monthly plan (G16); also its budget line's amount, once budgets have goal lines. */
    planMinor: money('plan_minor'),
    /** Priority (G19): lower comes first; the highest number gives way to a shortfall first. */
    position: integer().notNull().default(0),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    unique('goals_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index().on(t.householdId),
    index().on(t.memberId),
    check('goals_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('goals_target', sql`${t.targetMinor} > 0`),
    check('goals_plan', sql`${t.planMinor} IS NULL OR ${t.planMinor} >= 0`),
  ],
);

/**
 * Part of an account's balance earmarked for a goal (G2): a fixed amount, or a percentage in basis
 * points. One per goal and account. Fixed claims are filled first; percentages share what's left
 * (G3). Only the account's owners set them (G7): the policy in 0088.
 */
export const goalClaims = pgTable(
  'goal_claims',
  {
    id: id(),
    householdId: uuid().notNull(),
    goalId: uuid().notNull(),
    accountId: uuid().notNull(),
    amountMinor: money('amount_minor'),
    percentBps: integer(),
    ...timestamps(),
  },
  (t) => [
    unique('goal_claims_goal_account').on(t.goalId, t.accountId),
    foreignKey({
      columns: [t.householdId, t.goalId],
      foreignColumns: [goals.householdId, goals.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    index().on(t.accountId),
    check('goal_claims_one_kind', sql`(${t.amountMinor} IS NULL) <> (${t.percentBps} IS NULL)`),
    check('goal_claims_amount', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} > 0`),
    check(
      'goal_claims_percent',
      sql`${t.percentBps} IS NULL OR ${t.percentBps} BETWEEN 1 AND 10000`,
    ),
  ],
);

export const goalClaimReason = pgEnum('goal_claim_reason', [
  /** Set, or raised, on money already there (G11). */
  'earmarked',
  /** Lowered, or switched between amount and percentage. */
  'changed',
  /** Taken off the goal by someone. */
  'released',
  /** Gave way to a shortfall (G3, G19). */
  'gave_way',
  /** Ended with its account: closed, or no longer the owner's to claim (G8). */
  'ended',
]);

/**
 * Every change to a claim, with its reason (G17): progress on any date, contributions and pace
 * read this history. Kept after the claim and its account go; it goes with its goal.
 */
export const goalClaimEvents = pgTable(
  'goal_claim_events',
  {
    id: id(),
    householdId: uuid().notNull(),
    goalId: uuid().notNull(),
    accountId: uuid().notNull(),
    reason: goalClaimReason().notNull(),
    /** Who did it; null when it happened on its own (an account closing). */
    memberId: uuid(),
    amountBeforeMinor: bigint({ mode: 'number' }),
    amountAfterMinor: bigint({ mode: 'number' }),
    percentBeforeBps: integer(),
    percentAfterBps: integer(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.goalId],
      foreignColumns: [goals.householdId, goals.id],
    }).onDelete('cascade'),
    index().on(t.goalId, t.at),
  ],
);
