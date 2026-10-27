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
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { id } from '../columns.js';
import { householdMembers, households } from './households.js';
import { categories } from './ledger.js';

// Shared costs (ADR 0006 §7, budgeting walkthrough §9, #109): how a shared expense is split
// between the people it's for. Row-level security: migration 0054.

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
