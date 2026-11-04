// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BudgetSettingsError,
  type BudgetCategory,
  type BudgetStrategy,
  type Carry,
} from './budget.js';

// 50/30/20, or any split (#101, budgeting walkthrough §3.3): income is split into buckets by
// percentage, and each bucket counts what its categories spent. No per-category limits (D10).
// Buckets follow category groups' kinds unless a category is moved (D10); Savings also counts
// money moved into savings and investment accounts. The base is income after contributions by
// default, actual or expected (D11).

export interface PercentageBucket {
  /** Stable key: categories moved into it name it. */
  key: string;
  name: string;
  /** Whole percent, 1–100. */
  percent: number;
}

export interface PercentageSettings {
  buckets: PercentageBucket[];
  /** Income after contributions (the default), or the whole of it with contributions as Needs. */
  base: 'after_contributions' | 'whole';
  /** This month's actual income, or a figure you expect, for people paid irregularly. */
  income: 'actual' | 'expected';
  expectedMinor: number | null;
}

/** The preset, 50/30/20. */
export const FIFTY_THIRTY_TWENTY: PercentageBucket[] = [
  { key: 'needs', name: 'Needs', percent: 50 },
  { key: 'wants', name: 'Wants', percent: 30 },
  { key: 'savings', name: 'Savings', percent: 20 },
];

/** The bucket a category's group kind puts it in (D10). */
export function bucketOfKind(kind: BudgetCategory['kind']): string | null {
  if (kind === 'fixed') return 'needs';
  if (kind === 'flexible' || kind === 'non_monthly') return 'wants';
  if (kind === 'savings') return 'savings';
  return null;
}

export interface PercentageBucketView extends PercentageBucket {
  /** `base × percent`. */
  targetMinor: number;
  /** Spent in its categories, plus, for Savings, money moved into savings accounts. */
  spentMinor: number;
  /** Its categories with spending, biggest first. */
  categories: { categoryId: string; spentMinor: number }[];
  /** Savings only: transfers into savings and investment accounts. */
  movedToSavingsMinor: number;
  /** Over is good for Savings, and a warning for the rest. */
  saving: boolean;
}

export interface PercentageView {
  buckets: PercentageBucketView[];
  /** Spending in categories that aren't in any bucket (D6): nothing spent goes missing. */
  notInBucket: { categoryId: string; spentMinor: number }[];
  incomeMinor: number;
  contributionsMinor: number;
  base: {
    kind: PercentageSettings['base'];
    income: PercentageSettings['income'];
    /** What's split. */
    amountMinor: number;
  };
  totals: {
    spentMinor: number;
    /** What's split, less what every bucket but Savings spent and what Savings set aside. */
    notSpentMinor: number;
  };
}

const KEY = /^[a-z0-9_-]{1,40}$/;

export const percentage: BudgetStrategy<PercentageSettings, PercentageView> = {
  kind: 'percentage',
  settings(raw) {
    const buckets = raw.buckets === undefined ? FIFTY_THIRTY_TWENTY : raw.buckets;
    if (!Array.isArray(buckets) || buckets.length === 0 || buckets.length > 10) {
      throw new BudgetSettingsError('buckets must list one to ten buckets');
    }
    const keys = new Set<string>();
    const out: PercentageBucket[] = [];
    for (const b of buckets as unknown[]) {
      const { key, name, percent } = (b ?? {}) as Record<string, unknown>;
      if (
        typeof key !== 'string' ||
        !KEY.test(key) ||
        keys.has(key) ||
        typeof name !== 'string' ||
        name.trim().length === 0 ||
        name.length > 40 ||
        typeof percent !== 'number' ||
        !Number.isInteger(percent) ||
        percent < 1 ||
        percent > 100
      ) {
        throw new BudgetSettingsError('Not a bucket');
      }
      keys.add(key);
      out.push({ key, name: name.trim(), percent });
    }
    if (out.reduce((s, b) => s + b.percent, 0) !== 100) {
      throw new BudgetSettingsError('Buckets add up to 100%');
    }
    const base = raw.base ?? 'after_contributions';
    const income = raw.income ?? 'actual';
    const expected = raw.expectedMinor ?? null;
    if (base !== 'after_contributions' && base !== 'whole') {
      throw new BudgetSettingsError('Not a base');
    }
    if (income !== 'actual' && income !== 'expected') {
      throw new BudgetSettingsError('Not an income');
    }
    if (expected !== null && (typeof expected !== 'number' || !Number.isSafeInteger(expected))) {
      throw new BudgetSettingsError('Not an expected income');
    }
    return { buckets: out, base, income, expectedMinor: expected as number | null };
  },
  month({ settings, scope, categories, activity }) {
    const keys = new Set(settings.buckets.map((b) => b.key));
    const byBucket = new Map<string, { categoryId: string; spentMinor: number }[]>();
    const notInBucket: PercentageView['notInBucket'] = [];
    for (const c of categories) {
      if (c.kind === 'income' || c.kind === 'transfer') continue;
      const spent = activity.spentMinor.get(c.id) ?? 0;
      if (spent === 0) continue;
      const own = c.bucket !== null && keys.has(c.bucket) ? c.bucket : null;
      const key = own ?? bucketOfKind(c.kind);
      if (key === null || !keys.has(key)) {
        notInBucket.push({ categoryId: c.id, spentMinor: spent });
        continue;
      }
      byBucket.set(key, [...(byBucket.get(key) ?? []), { categoryId: c.id, spentMinor: spent }]);
    }
    // Contributions: the household's money in; your own budget's money out to it (D2, D11).
    const mine = scope === 'mine';
    const income =
      settings.income === 'expected' && settings.expectedMinor !== null
        ? settings.expectedMinor
        : activity.incomeMinor + (mine ? 0 : activity.contributionsMinor);
    const afterContributions = mine && settings.base === 'after_contributions';
    const base = afterContributions ? income - activity.contributionsMinor : income;
    const movedToSavings = activity.savingsMovedMinor ?? 0;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const buckets = settings.buckets.map((b): PercentageBucketView => {
      const cats = (byBucket.get(b.key) ?? []).sort((x, y) => y.spentMinor - x.spentMinor);
      const saving = b.key === 'savings';
      // With the whole income as the base, what you send to Ours is a need (D11).
      const contributed = mine && !afterContributions && b.key === 'needs';
      const moved = saving ? movedToSavings : 0;
      return {
        ...b,
        targetMinor: Math.round((Math.max(base, 0) * b.percent) / 100),
        spentMinor:
          sum(cats.map((c) => c.spentMinor)) +
          moved +
          (contributed ? activity.contributionsMinor : 0),
        categories: cats,
        movedToSavingsMinor: moved,
        saving,
      };
    });
    const spent = sum(buckets.map((b) => b.spentMinor)) + sum(notInBucket.map((n) => n.spentMinor));
    const out: Carry = { balances: new Map(), unassignedMinor: 0 };
    return {
      view: {
        buckets,
        notInBucket,
        incomeMinor: activity.incomeMinor,
        contributionsMinor: activity.contributionsMinor,
        base: { kind: settings.base, income: settings.income, amountMinor: base },
        totals: { spentMinor: spent, notSpentMinor: base - spent },
      },
      carry: out,
    };
  },
};
