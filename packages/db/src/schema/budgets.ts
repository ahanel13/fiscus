// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { id, money, timestamps, versioning } from '../columns.js';
import { householdMembers, households } from './households.js';
import { categories } from './ledger.js';

// Budgets (#98, budgeting walkthrough §1): a scope, a strategy per period, and an amount per
// category per month. Spent, left, and rollover are computed from these and the transactions when
// read (D13), never stored. Row-level security: migration 0054.

export const budgetStrategy = pgEnum('budget_strategy', [
  'category',
  'zero_based',
  'percentage',
  'flex',
]);

/** A strategy's own settings; the shapes are in @fiscus/domain (budget.ts). */
export type BudgetSettingsJson = Record<string, unknown>;

/** The first of a month: months are stored as dates so they compare and index as dates. */
const firstOfMonth = (column: unknown) => sql`extract(day from ${column}) = 1`;

export const budgets = pgTable(
  'budgets',
  {
    id: id(),
    householdId: uuid()
      .notNull()
      .references(() => households.id, { onDelete: 'cascade' }),
    /**
     * Whose budget it is (D3): null for the household's shared one (Ours), or the member whose own
     * it is (Mine), which only they see.
     */
    memberId: uuid(),
    /** The first month it covers; earlier months show spending only. */
    startsMonth: date({ mode: 'string' }).notNull(),
    ...versioning(),
    ...timestamps(),
  },
  (t) => [
    unique('budgets_household_id_id').on(t.householdId, t.id),
    // One Ours per household, and one Mine per member.
    unique('budgets_scope').on(t.householdId, t.memberId).nullsNotDistinct(),
    // A member's budget goes when they leave: the trigger in 0054, or this cascade.
    foreignKey({
      columns: [t.householdId, t.memberId],
      foreignColumns: [householdMembers.householdId, householdMembers.id],
    }).onDelete('cascade'),
    index().on(t.memberId),
    check('budgets_starts_month', firstOfMonth(t.startsMonth)),
  ],
);

/**
 * Which strategy a budget runs, from which month (D14). Switching adds a row; earlier months keep
 * the strategy they had, so the past never changes.
 */
export const budgetStrategies = pgTable(
  'budget_strategies',
  {
    householdId: uuid().notNull(),
    budgetId: uuid().notNull(),
    fromMonth: date({ mode: 'string' }).notNull(),
    strategy: budgetStrategy().notNull(),
    settings: jsonb()
      .$type<BudgetSettingsJson>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.budgetId, t.fromMonth] }),
    foreignKey({
      columns: [t.householdId, t.budgetId],
      foreignColumns: [budgets.householdId, budgets.id],
    }).onDelete('cascade'),
    check('budget_strategies_from_month', firstOfMonth(t.fromMonth)),
  ],
);

/**
 * An amount per category per month: a limit, what's assigned, or a fixed cost, as the strategy
 * reads it. Kept whatever the strategy, so switching loses nothing (D14). A month with no amounts
 * repeats the last month that has some; changing one copies that month's amounts first.
 */
export const budgetAmounts = pgTable(
  'budget_amounts',
  {
    householdId: uuid().notNull(),
    budgetId: uuid().notNull(),
    month: date({ mode: 'string' }).notNull(),
    categoryId: uuid().notNull(),
    /** In the household's base currency. */
    amountMinor: money('amount_minor').notNull(),
    /** First save wins (API conventions §8): each amount is one field. */
    version: integer().notNull().default(1),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    primaryKey({ columns: [t.budgetId, t.month, t.categoryId] }),
    foreignKey({
      columns: [t.householdId, t.budgetId],
      foreignColumns: [budgets.householdId, budgets.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
    }).onDelete('cascade'),
    index().on(t.categoryId),
    check('budget_amounts_month', firstOfMonth(t.month)),
    check('budget_amounts_nonnegative', sql`${t.amountMinor} >= 0`),
  ],
);

/** How a budget treats a category, whatever the month. */
export const budgetCategories = pgTable(
  'budget_categories',
  {
    householdId: uuid().notNull(),
    budgetId: uuid().notNull(),
    categoryId: uuid().notNull(),
    /** Category limits: what's left (or overspent) moves to next month (§3.1). */
    rollover: boolean().notNull().default(false),
    /** 50/30/20: the bucket it counts in, when not the one its group's kind gives (D10). */
    bucket: text(),
    /** Non-monthly costs: the yearly figure a twelfth of is set aside each month (D12). */
    yearlyMinor: money('yearly_minor'),
    ...timestamps(),
  },
  (t) => [
    primaryKey({ columns: [t.budgetId, t.categoryId] }),
    foreignKey({
      columns: [t.householdId, t.budgetId],
      foreignColumns: [budgets.householdId, budgets.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.householdId, t.categoryId],
      foreignColumns: [categories.householdId, categories.id],
    }).onDelete('cascade'),
    index().on(t.categoryId),
    check(
      'budget_categories_bucket',
      sql`${t.bucket} IS NULL OR length(btrim(${t.bucket})) BETWEEN 1 AND 40`,
    ),
    check('budget_categories_yearly', sql`${t.yearlyMinor} IS NULL OR ${t.yearlyMinor} >= 0`),
  ],
);
