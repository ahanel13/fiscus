// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';

// Budgets (#98, #99; budgeting walkthrough). Money in minor units of the household's currency.

/** `YYYY-MM`. */
export const budgetMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month, YYYY-MM');

/**
 * Whose budget: the household's shared one, or your own (D1). Viewer-relative: the api never
 * says whose another member's budget is, because nobody else sees it (D3).
 */
export const budgetScopeSchema = z.enum(['household', 'mine']);
export type BudgetScope = z.infer<typeof budgetScopeSchema>;

export type BudgetStrategyName = 'category' | 'zero_based' | 'percentage' | 'flex';

export interface BudgetSummary {
  id: string;
  scope: BudgetScope;
  /** The first month it covers. */
  startsMonth: string;
  /** The strategy it runs this month. */
  strategy: BudgetStrategyName;
}

const amount = z.object({
  categoryId: z.uuid(),
  amountMinor: z.number().int().min(0).max(1_000_000_000_00),
});

/**
 * Starts a budget this month, as category limits (D5). `scope` defaults from the household's
 * finance style (D21): yours alone in a household of one, or in Separate and Roommates ones.
 */
export const createBudgetSchema = z.object({
  scope: budgetScopeSchema.optional(),
  amounts: z
    .array(amount)
    .max(500)
    .refine((a) => new Set(a.map((x) => x.categoryId)).size === a.length, 'Each category once'),
});

/** What to start a budget from (D5): the last full months' spending in its scope. */
export interface BudgetSuggestion {
  scope: BudgetScope;
  /** The months averaged, oldest first (`YYYY-MM`); empty ones are left out. */
  months: string[];
  /** Rounded to $5, categories with spending only. */
  average: { categoryId: string; amountMinor: number }[];
  lastMonth: { categoryId: string; amountMinor: number }[];
}

export const setBudgetAmountSchema = z.object({
  amountMinor: z.number().int().min(0).max(1_000_000_000_00),
});
export const setBudgetCategorySchema = z.object({ rollover: z.boolean() });

export interface CategoryLimitRow {
  categoryId: string;
  budgetedMinor: number;
  rolledInMinor: number;
  spentMinor: number;
  leftMinor: number;
  rollover: boolean;
}

/** A month of a budget running category limits (walkthrough §3.1). */
export interface CategoryLimitsMonth {
  strategy: 'category';
  rows: CategoryLimitRow[];
  notBudgeted: { categoryId: string; spentMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  totals: { budgetedMinor: number; spentMinor: number; leftMinor: number; overCount: number };
}

export interface BudgetMonth {
  budget: BudgetSummary;
  month: string;
  currency: string;
  /** Whether you can change it: owners and members for the household's, you for your own. */
  canEdit: boolean;
  view: CategoryLimitsMonth;
}
