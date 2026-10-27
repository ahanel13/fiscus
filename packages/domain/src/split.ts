// SPDX-License-Identifier: AGPL-3.0-or-later

// Splitting a shared expense between the people it's for (ADR 0006 §7, #109): which rule applies,
// and each person's share of it. Settle-up (#111) builds on this.

/** A split rule, as @fiscus/shared's `splitRuleSchema` gives it. */
export type SplitRuleInput =
  | { method: 'equal' }
  | { method: 'fixed_percent'; shares: readonly { memberId: string; shareBps: number }[] }
  | { method: 'fixed_amount'; amounts: readonly { memberId: string; amountMinor: number }[] };

export interface SplitPolicyRow {
  /** Null for the household's default. */
  categoryId: string | null;
  /** `YYYY-MM-DD`, the first of a month. */
  effectiveFrom: string;
  /** Null: the category goes back to the household's default. */
  rule: SplitRuleInput | null;
}

const EQUAL: SplitRuleInput = { method: 'equal' };

const latest = (rows: readonly SplitPolicyRow[], date: string) => {
  let found: SplitPolicyRow | undefined;
  for (const r of rows) {
    if (r.effectiveFrom <= date && (!found || r.effectiveFrom > found.effectiveFrom)) found = r;
  }
  return found;
};

/**
 * The rule for an expense in `categoryId` on `date`: the category's own rule from then, else the
 * household's default from then, else an equal split.
 */
export function splitRuleFor(
  policies: readonly SplitPolicyRow[],
  categoryId: string | null,
  date: string,
): SplitRuleInput {
  if (categoryId !== null) {
    const own = latest(
      policies.filter((p) => p.categoryId === categoryId),
      date,
    );
    if (own?.rule) return own.rule;
  }
  return (
    latest(
      policies.filter((p) => p.categoryId === null),
      date,
    )?.rule ?? EQUAL
  );
}

/**
 * Each member's share of one expense, in basis points adding up to 10 000, for the members it's
 * for. `equal` divides evenly; `fixed_percent` scales the rule's shares to the members present,
 * and splits evenly if none of them have one. Basis points that don't divide evenly go one each to
 * the members first in `members`' order, so the result never depends on anything else.
 *
 * `fixed_amount` is a monthly amount, not a share of one expense: it returns null, and settle-up
 * works it out over the month.
 */
export function splitShares(
  rule: SplitRuleInput,
  members: readonly string[],
): Map<string, number> | null {
  const unique = [...new Set(members)];
  if (unique.length === 0) return new Map();
  if (rule.method === 'fixed_amount') return null;
  const weights =
    rule.method === 'fixed_percent'
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
