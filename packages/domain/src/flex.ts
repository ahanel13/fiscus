// SPDX-License-Identifier: AGPL-3.0-or-later
import { BudgetSettingsError, type BudgetStrategy, type Carry, type Month } from './budget.js';

// Flex (#102, budgeting walkthrough §3.4): Monarch's model. Fixed costs (and savings) are budgeted
// one by one; non-monthly costs set aside a twelfth of a yearly figure each month, which builds
// up and is spent from (D12); everything flexible shares one number.

export interface FlexSettings {
  /**
   * The flexible number by month (`YYYY-MM` → minor units), each repeating until the next, as
   * amounts do: changing it from a month never rewrites the months before.
   */
  flexibleMinor: ReadonlyMap<Month, number>;
}

export interface FlexFixedRow {
  categoryId: string;
  budgetedMinor: number;
  spentMinor: number;
  leftMinor: number;
}

export interface FlexNonMonthlyRow {
  categoryId: string;
  /** The yearly figure, or null when none is set (nothing is set aside). */
  yearlyMinor: number | null;
  /** A twelfth of it, set aside this month. */
  setAsideMinor: number;
  spentMinor: number;
  /** What's been set aside and not spent, this month included; negative when spent ahead. */
  savedMinor: number;
}

export interface FlexView {
  fixed: FlexFixedRow[];
  nonMonthly: FlexNonMonthlyRow[];
  flexible: {
    budgetedMinor: number;
    spentMinor: number;
    leftMinor: number;
    /** Each flexible category's spending, no limits. */
    categories: { categoryId: string; spentMinor: number }[];
  };
  incomeMinor: number;
  contributionsMinor: number;
  totals: {
    fixedBudgetedMinor: number;
    fixedSpentMinor: number;
    setAsideMinor: number;
    /** Everything spent. */
    spentMinor: number;
  };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The flexible number in `month`: its own, or the last month's before it that had one. */
export function flexibleFor(month: Month, byMonth: ReadonlyMap<Month, number>): number {
  let best: Month | undefined;
  for (const m of byMonth.keys()) if (m <= month && (best === undefined || m > best)) best = m;
  return best === undefined ? 0 : byMonth.get(best)!;
}

export const flex: BudgetStrategy<FlexSettings, FlexView> = {
  kind: 'flex',
  settings(raw) {
    const out = new Map<Month, number>();
    const given = raw.flexibleMinor ?? {};
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
      throw new BudgetSettingsError('flexibleMinor must map months to amounts');
    }
    for (const [m, v] of Object.entries(given as Record<string, unknown>)) {
      if (!MONTH.test(m) || typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
        throw new BudgetSettingsError(`Not a flexible amount: ${m}`);
      }
      out.set(m, v);
    }
    return { flexibleMinor: out };
  },
  month({ month, settings, categories, amounts, activity, carry }) {
    const fixed: FlexFixedRow[] = [];
    const nonMonthly: FlexNonMonthlyRow[] = [];
    const flexibleCats: { categoryId: string; spentMinor: number }[] = [];
    const balances = new Map<string, number>();
    for (const c of categories) {
      const spent = activity.spentMinor.get(c.id) ?? 0;
      if (c.kind === 'income' || c.kind === 'transfer') continue;
      if (c.kind === 'non_monthly') {
        const setAside = c.yearlyMinor === null ? 0 : Math.round(c.yearlyMinor / 12);
        const saved = (carry.balances.get(c.id) ?? 0) + setAside - spent;
        if (c.yearlyMinor !== null || spent !== 0 || saved !== 0) {
          nonMonthly.push({
            categoryId: c.id,
            yearlyMinor: c.yearlyMinor,
            setAsideMinor: setAside,
            spentMinor: spent,
            savedMinor: saved,
          });
        }
        if (saved !== 0) balances.set(c.id, saved);
      } else if (c.kind === 'fixed' || c.kind === 'savings') {
        const budgeted = amounts.get(c.id);
        if (budgeted !== undefined || spent !== 0) {
          fixed.push({
            categoryId: c.id,
            budgetedMinor: budgeted ?? 0,
            spentMinor: spent,
            leftMinor: (budgeted ?? 0) - spent,
          });
        }
      } else if (spent !== 0) {
        flexibleCats.push({ categoryId: c.id, spentMinor: spent });
      }
    }
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const flexibleBudgeted = flexibleFor(month, settings.flexibleMinor);
    const flexibleSpent = sum(flexibleCats.map((c) => c.spentMinor));
    flexibleCats.sort((a, b) => b.spentMinor - a.spentMinor);
    const out: Carry = { balances, unassignedMinor: 0 };
    return {
      view: {
        fixed,
        nonMonthly,
        flexible: {
          budgetedMinor: flexibleBudgeted,
          spentMinor: flexibleSpent,
          leftMinor: flexibleBudgeted - flexibleSpent,
          categories: flexibleCats,
        },
        incomeMinor: activity.incomeMinor,
        contributionsMinor: activity.contributionsMinor,
        totals: {
          fixedBudgetedMinor: sum(fixed.map((r) => r.budgetedMinor)),
          fixedSpentMinor: sum(fixed.map((r) => r.spentMinor)),
          setAsideMinor: sum(nonMonthly.map((r) => r.setAsideMinor)),
          spentMinor:
            sum(fixed.map((r) => r.spentMinor)) +
            sum(nonMonthly.map((r) => r.spentMinor)) +
            flexibleSpent,
        },
      },
      carry: out,
    };
  },
};
