// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BudgetStrategy, Carry } from './budget.js';

// Category limits (#99, budgeting walkthrough §3.1): a limit per category and what's left of it.
// What's left (or overspent) carries into next month only for categories with rollover on.

export interface CategoryLimitRow {
  categoryId: string;
  /** This month's limit. */
  budgetedMinor: number;
  /** Carried from last month: positive left over, negative overspent. 0 without rollover. */
  rolledInMinor: number;
  spentMinor: number;
  /** `budgeted + rolledIn − spent`: negative is over. */
  leftMinor: number;
  rollover: boolean;
}

/** An income category: what you expect this month, and what came in. */
export interface IncomeRow {
  categoryId: string;
  /** Expected this month; 0 when none is set. */
  budgetedMinor: number;
  receivedMinor: number;
}

export interface CategoryLimitsView {
  /** Categories with a limit this month. */
  rows: CategoryLimitRow[];
  /** Income categories with an amount expected, or money in this month. */
  income: IncomeRow[];
  /** Spending in categories without one (D6), so nothing spent goes missing. */
  notBudgeted: { categoryId: string; spentMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  totals: {
    /** Limits on spending; expected income isn't in it. */
    budgetedMinor: number;
    incomeBudgetedMinor: number;
    /** Everything spent: budgeted categories and the rest. */
    spentMinor: number;
    /** The rows' left, overspent ones counting against it. */
    leftMinor: number;
    overCount: number;
  };
}

/** Category limits takes no settings. */
export type CategoryLimitsSettings = Record<string, never>;

export const categoryLimits: BudgetStrategy<CategoryLimitsSettings, CategoryLimitsView> = {
  kind: 'category',
  settings: () => ({}),
  month({ categories, amounts, activity, carry }) {
    const rows: CategoryLimitRow[] = [];
    const notBudgeted: CategoryLimitsView['notBudgeted'] = [];
    const income: IncomeRow[] = [];
    const balances = new Map<string, number>();
    for (const c of categories) {
      if (c.kind === 'transfer') continue;
      if (c.kind === 'income') {
        const budgetedMinor = amounts.get(c.id) ?? 0;
        const receivedMinor = activity.incomeByCategory.get(c.id) ?? 0;
        if (budgetedMinor !== 0 || receivedMinor !== 0) {
          income.push({ categoryId: c.id, budgetedMinor, receivedMinor });
        }
        continue;
      }
      const spent = activity.spentMinor.get(c.id) ?? 0;
      const budgeted = amounts.get(c.id);
      // Rollover carries whatever the category ended with, including after its limit was removed.
      const rolledIn = c.rollover ? (carry.balances.get(c.id) ?? 0) : 0;
      // A limit of zero is no limit, unless what's overspent against it rolls over.
      if ((budgeted === undefined || (budgeted === 0 && !c.rollover)) && rolledIn === 0) {
        if (spent !== 0) notBudgeted.push({ categoryId: c.id, spentMinor: spent });
        continue;
      }
      const left = (budgeted ?? 0) + rolledIn - spent;
      rows.push({
        categoryId: c.id,
        budgetedMinor: budgeted ?? 0,
        rolledInMinor: rolledIn,
        spentMinor: spent,
        leftMinor: left,
        rollover: c.rollover,
      });
      if (c.rollover) balances.set(c.id, left);
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const out: Carry = { balances, unassignedMinor: 0 };
    return {
      view: {
        rows,
        income,
        notBudgeted,
        incomeMinor: activity.incomeMinor,
        contributionsMinor: activity.contributionsMinor,
        totals: {
          budgetedMinor: sum(rows.map((r) => r.budgetedMinor)),
          incomeBudgetedMinor: sum(income.map((r) => r.budgetedMinor)),
          spentMinor:
            sum(rows.map((r) => r.spentMinor)) + sum(notBudgeted.map((n) => n.spentMinor)),
          leftMinor: sum(rows.map((r) => r.leftMinor)),
          overCount: rows.filter((r) => r.leftMinor < 0).length,
        },
      },
      carry: out,
    };
  },
};

/**
 * Starting amounts from history (D5): each category's average over the months given, leaving out
 * months with no spending at all (as Fiscus's averages do), rounded to the nearest `roundTo`
 * minor units. Categories that average to nothing are left out.
 */
export function suggestAmounts(
  months: readonly ReadonlyMap<string, number>[],
  roundTo = 500,
): Map<string, number> {
  const counted = months.filter((m) => [...m.values()].some((v) => v !== 0));
  const out = new Map<string, number>();
  if (counted.length === 0) return out;
  const totals = new Map<string, number>();
  for (const m of counted) {
    for (const [id, v] of m) totals.set(id, (totals.get(id) ?? 0) + v);
  }
  for (const [id, total] of totals) {
    const rounded = Math.round(total / counted.length / roundTo) * roundTo;
    if (rounded > 0) out.set(id, rounded);
  }
  return out;
}
