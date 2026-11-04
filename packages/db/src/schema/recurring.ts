// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, timestamps, versioning } from '../columns.js';
import { accounts } from './accounts.js';
import { householdMembers, households } from './households.js';
import { transactions } from './ledger.js';

// Recurring series (#118; bills walkthrough §1, D1, D2, D11): a payment that comes at a steady
// pace, on one account. Its payments aren't stored: they're the transactions that match it near
// each date, worked out when it's read. Row-level security: migration 0068.

export const recurringKind = pgEnum('recurring_kind', [
  'bill',
  'subscription',
  'income',
  'transfer',
]);

/** What a series matches and when it's due; the shapes are in @fiscus/shared (api/recurring.ts). */
export type RecurringJson = Record<string, unknown>;

export const recurringSeries = pgTable(
  'recurring_series',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /** The account its payments move through: whoever sees it sees the series (D10). */
    accountId: uuid().notNull(),
    name: text().notNull(),
    kind: recurringKind().notNull(),
    match: jsonb().$type<RecurringJson>().notNull(),
    schedule: jsonb().$type<RecurringJson>().notNull(),
    /** How many days either side of its date a payment still counts. */
    windowDays: integer().notNull().default(3),
    /** No more are expected after this day (D12). */
    endedOn: date({ mode: 'string' }),
    createdByMemberId: uuid().notNull(),
    /**
     * Who looks after it and gets its reminders (D13, #121): someone who can see its account.
     * Null: worked out when read (the account's only owner, else whoever made it). Income has
     * "for" instead, from its payments' attribution. Row-level security and hand-over: 0077.
     */
    responsibleMemberId: uuid(),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    unique('recurring_series_household_id_id').on(t.householdId, t.id),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.responsibleMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.accountId),
    index().on(t.responsibleMemberId),
    check('recurring_series_name', sql`length(btrim(${t.name})) BETWEEN 1 AND 80`),
    check('recurring_series_window', sql`${t.windowDays} BETWEEN 0 AND 15`),
  ],
);

export const recurringMark = pgEnum('recurring_mark', ['paid', 'skipped']);

/**
 * What someone said about one date a series was due (D12): paid, by a transaction or another way
 * (`transaction_id` null), or skipped. Without one, a date's payment is worked out from the
 * transactions. Row-level security: migration 0070.
 */
export const recurringMarks = pgTable(
  'recurring_marks',
  {
    householdId: uuid().notNull(),
    seriesId: uuid().notNull(),
    due: date({ mode: 'string' }).notNull(),
    mark: recurringMark().notNull(),
    transactionId: uuid(),
    createdByMemberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.seriesId, t.due] }),
    foreignKey({
      columns: [t.householdId, t.seriesId],
      foreignColumns: [recurringSeries.householdId, recurringSeries.id],
    }).onDelete('cascade'),
    // The transaction going takes the mark with it: the date is worked out again.
    foreignKey({
      columns: [t.householdId, t.transactionId],
      foreignColumns: [transactions.householdId, transactions.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    unique('recurring_marks_transaction').on(t.seriesId, t.transactionId),
    index().on(t.transactionId),
    check(
      'recurring_marks_transaction_paid',
      sql`${t.transactionId} IS NULL OR ${t.mark} = 'paid'`,
    ),
  ],
);

/**
 * Payments someone said aren't recurring (D5): one account, one direction, one name. Detection
 * doesn't suggest them again. Row-level security: migration 0072.
 */
export const recurringDismissals = pgTable(
  'recurring_dismissals',
  {
    householdId: uuid().notNull(),
    accountId: uuid().notNull(),
    direction: text().notNull(),
    /** The name, cleaned up as detection groups it. */
    key: text().notNull(),
    createdByMemberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.direction, t.key] }),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    check('recurring_dismissals_direction', sql`${t.direction} IN ('in', 'out')`),
    check('recurring_dismissals_key', sql`length(${t.key}) BETWEEN 1 AND 200`),
  ],
);
