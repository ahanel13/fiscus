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
/** How the budget treats a category in every month: rollover (§3.1), a yearly figure (D12). */
export const setBudgetCategorySchema = z
  .object({
    rollover: z.boolean(),
    yearlyMinor: z.number().int().min(0).max(1_000_000_000_00).nullable(),
  })
  .partial()
  .refine((v) => v.rollover !== undefined || v.yearlyMinor !== undefined, 'Nothing to change');

/** The flexible number from a month on (flex, §3.4). */
export const setFlexibleSchema = z.object({
  amountMinor: z.number().int().min(0).max(1_000_000_000_00),
});

/**
 * Switches strategy from a month on (#104, D14): this month or a later one. Earlier months keep
 * the strategy they had, and every amount is kept.
 */
export const switchStrategySchema = z.object({
  strategy: z.enum(['category', 'flex']),
  fromMonth: budgetMonthSchema,
});

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

/** A month of a budget running flex (walkthrough §3.4). */
export interface FlexMonth {
  strategy: 'flex';
  fixed: { categoryId: string; budgetedMinor: number; spentMinor: number; leftMinor: number }[];
  nonMonthly: {
    categoryId: string;
    yearlyMinor: number | null;
    setAsideMinor: number;
    spentMinor: number;
    savedMinor: number;
  }[];
  flexible: {
    budgetedMinor: number;
    spentMinor: number;
    leftMinor: number;
    categories: { categoryId: string; spentMinor: number }[];
  };
  incomeMinor: number;
  contributionsMinor: number;
  totals: {
    fixedBudgetedMinor: number;
    fixedSpentMinor: number;
    setAsideMinor: number;
    spentMinor: number;
  };
}

export interface BudgetMonth {
  budget: BudgetSummary;
  month: string;
  currency: string;
  /** Whether you can change it: owners and members for the household's, you for your own. */
  canEdit: boolean;
  view: CategoryLimitsMonth | FlexMonth;
}

/** What a switch would show in its first month (#104): now, and under the new strategy. */
export interface StrategyPreview {
  fromMonth: string;
  before: CategoryLimitsMonth | FlexMonth;
  after: CategoryLimitsMonth | FlexMonth;
  /** Flex's starting number: the flexible categories' limits added up, so nothing is lost. */
  flexibleMinor: number | null;
}

/** A category's last months in a budget (§4): its limit (null before the budget) and spending. */
export interface BudgetCategoryHistory {
  categoryId: string;
  months: { month: string; budgetedMinor: number | null; spentMinor: number }[];
  /** Over the full months shown that had spending; null without any. */
  averageSpentMinor: number | null;
}
