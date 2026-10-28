// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id, money } from '../columns.js';
import { householdMembers, households } from './households.js';
import { categories, transactions } from './ledger.js';

// Shared costs (ADR 0006 §7, budgeting walkthrough §9, #109): how a shared expense is split
// between the people it's for. Row-level security: migration 0059.

export const splitMethod = pgEnum('split_method', [
  'equal',
  // Needs every affected member's consent first (F4, #110); not accepted by the api until then.
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
