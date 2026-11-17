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
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money } from '../columns.js';
import { accounts } from './accounts.js';
import { householdMembers, households } from './households.js';
import { categories, transactions } from './ledger.js';

// Shared costs (ADR 0006 §7, budgeting walkthrough §9, #109): how a shared expense is split
// between the people it's for. Row-level security: migration 0059.

export const splitMethod = pgEnum('split_method', [
  'equal',
  // Counts only while every affected member consents (F4, #110): `income_split_consents`.
  'income_proportional',
  'fixed_percent',
  'fixed_amount',
]);

/** A method's own parameters; the shapes are in @fiscus/shared (api/shared-costs.ts). */
export type SplitParamsJson = Record<string, unknown>;

/**
 * The household's split rules, each from a month on. A row with no category is the household's
 * default; one with a category overrides it for that category, or, with no method, goes back to
 * the default. What applies in a month is the latest row starting on or before it. Rows are never
 * changed in place for a month that has started: a change adds a row from a later month, so a
 * settled month never moves (walkthrough §9).
 */
export const splitPolicies = pgTable(
  'split_policies',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    categoryId: uuid(),
    /** The first of the month it applies from. */
    effectiveFrom: date({ mode: 'string' }).notNull(),
    /** Null only for a category going back to the household's default. */
    method: splitMethod(),
    params: jsonb()
      .$type<SplitParamsJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByMemberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('split_policies_household_id_id').on(t.householdId, t.id),
    unique('split_policies_from')
      .on(t.householdId, t.categoryId, t.effectiveFrom)
      .nullsNotDistinct(),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.categoryId),
    check('split_policies_from_month', sql`extract(day from ${t.effectiveFrom}) = 1`),
    check(
      'split_policies_default_method',
      sql`${t.categoryId} IS NOT NULL OR ${t.method} IS NOT NULL`,
    ),
  ],
);

/** What a member's share of a split by income is worked out from (F4, #110). */
export const incomeBasis = pgEnum('income_basis', [
  // A monthly figure they enter.
  'declared',
  // Their income over the 3 months before: income transactions attributed to them.
  'actual',
]);

/**
 * Each member's consent to a split by income (F4, #110, walkthrough D19), from a day on. A row
 * with a basis consents from `effective_from`; one without withdraws from it. What holds on a day
 * is the member's latest row starting on or before it, so a change never reaches back. Only the
 * member reads their own rows (migration 0100): others learn only whether they've consented and
 * the split it makes, through definer functions that never return an income.
 */
export const incomeSplitConsents = pgTable(
  'income_split_consents',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    memberId: uuid().notNull(),
    effectiveFrom: date({ mode: 'string' }).notNull(),
    /** Null: withdrawn from `effective_from`. */
    basis: incomeBasis(),
    /** For `declared`: the monthly figure, in the household's currency. */
    declaredMonthlyMinor: money('declared_monthly_minor'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('income_split_consents_from').on(t.householdId, t.memberId, t.effectiveFrom),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.memberId),
    check(
      'income_split_consents_declared',
      sql`coalesce(${t.basis} = 'declared', false) = (${t.declaredMonthlyMinor} IS NOT NULL) AND coalesce(${t.declaredMonthlyMinor}, 0) >= 0`,
    ),
  ],
);

/**
 * Settle-ups (#112, walkthrough §10, D20): money one member paid another to square up. Linked to
 * the transfer that paid it when it's in Fiscus (which is then marked `is_settlement`), or not:
 * cash, a payment app, an account Fiscus doesn't have, or an adjustment with a note. Each lowers
 * what `from` owes `to`. Only the two of them see it. Row-level security: migration 0061.
 */
export const settlements = pgTable(
  'settlements',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    fromMemberId: uuid().notNull(),
    toMemberId: uuid().notNull(),
    amountMinor: money('amount_minor').notNull(),
    date: date({ mode: 'string' }).notNull(),
    /** `transfer`: a transfer in Fiscus paid it; `paid`: paid another way; `adjustment`: anything else. */
    kind: text().notNull(),
    /** The transfer that paid it, when it's in Fiscus (the api checks it's this household's). */
    transactionId: uuid().references(() => transactions.id, { onDelete: 'set null' }),
    note: text(),
    createdByMemberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('settlements_household_id_id').on(t.householdId, t.id),
    unique('settlements_transaction').on(t.transactionId),
    foreignKey({
      columns: [t.householdId, t.fromMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.toMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.fromMemberId),
    index().on(t.toMemberId),
    check('settlements_amount', sql`${t.amountMinor} > 0`),
    check('settlements_members', sql`${t.fromMemberId} <> ${t.toMemberId}`),
    check('settlements_note', sql`${t.note} IS NULL OR length(${t.note}) <= 500`),
    check(
      'settlements_kind',
      sql`(${t.kind} = 'transfer') = (${t.transactionId} IS NOT NULL) AND ${t.kind} IN ('transfer', 'paid', 'adjustment')`,
    ),
  ],
);

/**
 * A flagged attribution change (ADR 0006 F6, #60, walkthrough D18): someone it involves contests
 * who a transaction is for. While it's open, the expense waits outside the balance; the paying
 * account's owners resolve it, or whoever flagged it withdraws. Kept once resolved, as a record.
 */
export const attributionFlags = pgTable(
  'attribution_flags',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    transactionId: uuid()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    flaggedByMemberId: uuid().notNull(),
    note: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp({ withTimezone: true }),
    resolvedByMemberId: uuid(),
  },
  (t) => [
    foreignKey({
      columns: [t.householdId, t.flaggedByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.resolvedByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    // One open flag per transaction.
    uniqueIndex('attribution_flags_open')
      .on(t.transactionId)
      .where(sql`${t.resolvedAt} IS NULL`),
    index().on(t.householdId, t.resolvedAt),
    check('attribution_flags_note', sql`${t.note} IS NULL OR length(${t.note}) <= 500`),
    check(
      'attribution_flags_resolved',
      sql`(${t.resolvedAt} IS NULL) = (${t.resolvedByMemberId} IS NULL)`,
    ),
  ],
);

/** How a funding target is set: an amount each period, or a share of the member's income. */
export const fundingMethod = pgEnum('funding_method', [
  'fixed',
  // Needs the member's consent first (F4, #110); not accepted by the api until then.
  'percent_of_income',
]);

/** How often a funding target is due. Monthly ones follow calendar months. */
export const fundingCadence = pgEnum('funding_cadence', ['weekly', 'every_two_weeks', 'monthly']);

/**
 * Joint-account funding targets (ADR 0006 §7.3, #113): what a member has agreed to move into a
 * joint account each period, from accounts of their own. What they've sent is read from the
 * transfers into the account (contributions, budgeting walkthrough D2), so nothing is stored but
 * the target. One per member and account. Seen by whoever sees the account's transactions, and
 * set or changed only by its owners.
 * Row-level security: migration 0104.
 */
export const fundingTargets = pgTable(
  'funding_targets',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    accountId: uuid().notNull(),
    memberId: uuid().notNull(),
    method: fundingMethod().notNull(),
    /** For `fixed`: the amount each period, in the account's currency. */
    amountMinor: money('amount_minor'),
    /** For `percent_of_income`: the share of the member's income, in basis points. */
    percentBps: integer(),
    cadence: fundingCadence().notNull(),
    /** Counting starts here: the first period starts on it (for monthly, the first of a month). */
    startsOn: date({ mode: 'string' }).notNull(),
    createdByMemberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('funding_targets_household_id_id').on(t.householdId, t.id),
    unique('funding_targets_account_member').on(t.accountId, t.memberId),
    foreignKey({
      columns: [t.householdId, t.accountId],
      foreignColumns: [accounts.householdId, accounts.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    foreignKey({
      columns: [t.householdId, t.createdByMemberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }),
    index().on(t.memberId),
    check(
      'funding_targets_amount',
      sql`(${t.method} = 'fixed' AND ${t.amountMinor} > 0 AND ${t.percentBps} IS NULL)
        OR (${t.method} = 'percent_of_income' AND ${t.amountMinor} IS NULL
          AND ${t.percentBps} BETWEEN 1 AND 10000)`,
    ),
    check(
      'funding_targets_monthly_start',
      sql`${t.cadence} <> 'monthly' OR extract(day from ${t.startsOn}) = 1`,
    ),
  ],
);

/**
 * Who has agreed to settle with the fewest transfers (#262, walkthrough D31). A plan is worked out
 * only between people who have all agreed, since it can hint at balances between others: if you
 * pay Jo for Sam, you know Sam owed Jo. Each member adds or removes their own row; everyone in the
 * household sees who has agreed. Row-level security: migration 0111.
 */
export const settleUpSimplifyConsents = pgTable(
  'settle_up_simplify_consents',
  {
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    memberId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.householdId, t.memberId] }),
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
  ],
);
