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
  /**
   * `future` (the default): this month and every month after it, including later months that
   * had their own amount. `month`: this month only; the next one keeps what it had.
   */
  applyTo: z.enum(['month', 'future']).default('future'),
});
/**
 * How the budget treats a category in every month: rollover (§3.1), a yearly figure (D12), or
 * left out of it altogether ("Don't budget").
 */
export const setBudgetCategorySchema = z
  .object({
    rollover: z.boolean(),
    yearlyMinor: z.number().int().min(0).max(1_000_000_000_00).nullable(),
    excluded: z.boolean(),
  })
  .partial()
  .refine(
    (v) => v.rollover !== undefined || v.yearlyMinor !== undefined || v.excluded !== undefined,
    'Nothing to change',
  );

/** The flexible number from a month on (flex, §3.4). */
export const setFlexibleSchema = z.object({
  amountMinor: z.number().int().min(0).max(1_000_000_000_00),
});

/**
 * Switches strategy from a month on (#104, D14): this month or a later one. Earlier months keep
 * the strategy they had, and every amount is kept.
 */
export const switchStrategySchema = z.object({
  strategy: z.enum(['category', 'flex', 'zero_based']),
  fromMonth: budgetMonthSchema,
});

/**
 * Move money, or Cover (zero-based, D9): from one category's available money to another's, this
 * month. Ready to assign doesn't change.
 */
export const moveMoneySchema = z
  .object({
    fromCategoryId: z.uuid(),
    toCategoryId: z.uuid(),
    amountMinor: z.number().int().min(1).max(1_000_000_000_00),
  })
  .refine((m) => m.fromCategoryId !== m.toCategoryId, 'Move money between two categories');

export interface CategoryLimitRow {
  categoryId: string;
  budgetedMinor: number;
  rolledInMinor: number;
  spentMinor: number;
  leftMinor: number;
  rollover: boolean;
}

/** An income category: what you expect this month, and what came in. */
export interface IncomeRow {
  categoryId: string;
  budgetedMinor: number;
  receivedMinor: number;
}

/** A month of a budget running category limits (walkthrough §3.1). */
export interface CategoryLimitsMonth {
  strategy: 'category';
  rows: CategoryLimitRow[];
  /** Income categories with an amount expected, or money in this month. */
  income: IncomeRow[];
  notBudgeted: { categoryId: string; spentMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  totals: {
    budgetedMinor: number;
    incomeBudgetedMinor: number;
    spentMinor: number;
    leftMinor: number;
    overCount: number;
  };
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

/** A month of a zero-based budget (walkthrough §3.2). */
export interface ZeroBasedMonth {
  strategy: 'zero_based';
  /** Rows are envelopes: `budgetedMinor` is assigned, `leftMinor` available; all roll over. */
  rows: (CategoryLimitRow & { movedMinor: number })[];
  /** Goal lines (goals and budgets G5); none until goals exist. */
  goals: {
    goalId: string;
    budgetedMinor: number;
    movedMinor: number;
    rolledInMinor: number;
    sentMinor: number;
    leftMinor: number;
  }[];
  income: { categoryId: string; receivedMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  ready: {
    carriedMinor: number;
    cameInMinor: number;
    overspentMinor: number;
    assignedMinor: number;
    readyMinor: number;
  };
  /** Whether anything's been assigned this month: amounts don't repeat in zero-based. */
  assigned: boolean;
  /** What the last month with amounts assigned, for "Assign like last month"; null without one. */
  lastAssigned: { month: string; assignedMinor: number } | null;
  totals: {
    assignedMinor: number;
    spentMinor: number;
    availableMinor: number;
    overCount: number;
    overspentMinor: number;
  };
}

export type BudgetMonthView = CategoryLimitsMonth | FlexMonth | ZeroBasedMonth;

export interface BudgetMonth {
  budget: BudgetSummary;
  month: string;
  currency: string;
  /** Whether you can change it: owners and members for the household's, you for your own. */
  canEdit: boolean;
  /** Spending categories left out of this budget ("Don't budget"): in no row or total. */
  excluded: string[];
  view: BudgetMonthView;
}

/** What a switch would show in its first month (#104): now, and under the new strategy. */
export interface StrategyPreview {
  fromMonth: string;
  before: BudgetMonthView;
  after: BudgetMonthView;
  /** Flex's starting number: the flexible categories' limits added up, so nothing is lost. */
  flexibleMinor: number | null;
}

/**
 * Changing a budget's scope (D25): **Share my budget** (`household`, your own budget, two or more
 * of you) or **Make it mine** (`mine`, the household's, once you're its only member).
 */
export const setBudgetScopeSchema = z.object({ scope: budgetScopeSchema });

/** What a scope change would show this month: the month as it counts now, and as it would. */
export interface ScopePreview {
  month: string;
  before: BudgetMonthView;
  after: BudgetMonthView;
}

/** A category's last months in a budget (§4): its limit (null before the budget) and spending. */
export interface BudgetCategoryHistory {
  categoryId: string;
  months: { month: string; budgetedMinor: number | null; spentMinor: number }[];
  /** Over the full months shown that had spending; null without any. */
  averageSpentMinor: number | null;
}

/** One category in a budget year (#106): each month's spending and, once budgeted, its limit. */
export interface BudgetYearRow {
  categoryId: string;
  /** In month order; `budgetedMinor` is null before the budget, or where flex has no limit. */
  months: { spentMinor: number; budgetedMinor: number | null }[];
  spentMinor: number;
  budgetedMinor: number;
}

/** A budget's year (walkthrough §6), from the household's fiscal year start. */
export interface BudgetYear {
  year: number;
  /** The twelve months, `YYYY-MM`. */
  months: string[];
  rows: BudgetYearRow[];
  /** Flex's flexible number in each month it ran, else null. */
  flexible: (number | null)[];
  /** Everything spent in each month. */
  spentMinor: number[];
}
