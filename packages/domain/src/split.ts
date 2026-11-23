// SPDX-License-Identifier: AGPL-3.0-or-later

// Splitting a shared expense between the people it's for (ADR 0006 §7, #109): which rule applies,
// and each person's share of it. Settle-up (#111) builds on this.

/**
 * A split rule, as @fiscus/shared's `splitRuleSchema` gives it. `prorate`: people who join or
 * leave during a month pay for the days of it they were in the household (#261, D33).
 */
export type SplitRuleInput = (
  | { method: 'equal' }
  | { method: 'fixed_percent'; shares: readonly { memberId: string; shareBps: number }[] }
  | { method: 'fixed_amount'; amounts: readonly { memberId: string; amountMinor: number }[] }
  | { method: 'income_proportional' }
) & { prorate?: boolean };

/** A rule as it applies to one expense: a split by income comes as the shares it makes that day. */
export type AppliedRule =
  | Exclude<SplitRuleInput, { method: 'income_proportional' }>
  | {
      method: 'income_proportional';
      shares: readonly { memberId: string; shareBps: number }[];
      prorate?: boolean;
    };

/**
 * The split by income on a day (F4, #110), between everyone who had agreed to it by then; null
 * when nobody had. The shares come from the database, never the incomes behind them.
 */
export type IncomeShares = (
  date: string,
) => readonly { memberId: string; shareBps: number }[] | null;

export interface SplitPolicyRow {
  /** Null for the household's default. */
  categoryId: string | null;
  /** `YYYY-MM-DD`, the first of a month. */
  effectiveFrom: string;
  /** Null: the category goes back to the household's default. */
  rule: SplitRuleInput | null;
}

const EQUAL: AppliedRule = { method: 'equal' };

const latest = (rows: readonly SplitPolicyRow[], date: string) => {
  let found: SplitPolicyRow | undefined;
  for (const r of rows) {
    if (r.effectiveFrom <= date && (!found || r.effectiveFrom > found.effectiveFrom)) found = r;
  }
  return found;
};

/**
 * The rule for an expense in `categoryId` on `date`, for the people in `forMembers`: the
 * category's own rule from then, else the household's default from then, else an equal split.
 *
 * A split by income counts only when everyone the expense is for had agreed to it by `date` (F4,
 * #110). Until then it's as if it weren't there: a category's goes to the household default, and
 * the default's to an equal split.
 */
export function splitRuleFor(
  policies: readonly SplitPolicyRow[],
  categoryId: string | null,
  date: string,
  forMembers: readonly string[] = [],
  incomeShares?: IncomeShares,
): AppliedRule {
  const applied = (rule: SplitRuleInput | null | undefined): AppliedRule | null => {
    if (!rule) return null;
    if (rule.method !== 'income_proportional') return rule;
    const shares = incomeShares?.(date);
    if (!shares || forMembers.length === 0) return null;
    const agreed = new Set(shares.map((s) => s.memberId));
    return forMembers.every((m) => agreed.has(m)) ? { method: rule.method, shares } : null;
  };
  if (categoryId !== null) {
    const own = latest(
      policies.filter((p) => p.categoryId === categoryId),
      date,
    );
    const rule = applied(own?.rule);
    if (rule) return rule;
  }
  return (
    applied(
      latest(
        policies.filter((p) => p.categoryId === null),
        date,
      )?.rule,
    ) ?? EQUAL
  );
}

/**
 * Whether expenses in `categoryId` on `date` are prorated for people who join or leave that month
 * (#261, D33). The category's own rule decides, even while a split by income it names waits for
 * agreement: rent covers the month whichever way it's split. A category without a rule of its own
 * never prorates, since the household default also covers one-off expenses.
 */
export function prorates(
  policies: readonly SplitPolicyRow[],
  categoryId: string | null,
  date: string,
): boolean {
  if (categoryId === null) return false;
  return (
    latest(
      policies.filter((p) => p.categoryId === categoryId),
      date,
    )?.rule?.prorate === true
  );
}

/**
 * Each member's share of one expense, in basis points adding up to 10 000, for the members it's
 * for. `equal` divides evenly; `fixed_percent` and `income_proportional` scale the rule's shares to
 * the members present, and split evenly if none of them have one. Basis points that don't divide evenly go one each to
 * the members first in `members`' order, so the result never depends on anything else.
 *
 * `fixed_amount` is a monthly amount, not a share of one expense: it returns null, and settle-up
 * works it out over the month.
 */
export function splitShares(
  rule: AppliedRule,
  members: readonly string[],
): Map<string, number> | null {
  const unique = [...new Set(members)];
  if (unique.length === 0) return new Map();
  if (rule.method === 'fixed_amount') return null;
  const weights =
    rule.method === 'fixed_percent' || rule.method === 'income_proportional'
      ? unique.map((m) => rule.shares.find((s) => s.memberId === m)?.shareBps ?? 0)
      : unique.map(() => 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const scaled = total === 0 ? unique.map(() => 1) : weights;
  const sum = total === 0 ? unique.length : total;
  const shares = scaled.map((w) => Math.floor((w * 10000) / sum));
  let left = 10000 - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % shares.length) {
    if (scaled[i]! > 0) {
      shares[i]! += 1;
      left--;
    }
  }
  return new Map(unique.map((m, i) => [m, shares[i]!] as const).filter(([, s]) => s > 0));
}
