// SPDX-License-Identifier: AGPL-3.0-or-later

// Paying down debt (goals walkthrough §8, G9, #134): how several loans and cards come down month
// by month, with interest, under a strategy. The minimum is each debt's bill; the extra is its
// goal's plan. Avalanche and snowball pool every payment and roll a paid-off debt's onto the next;
// "planned" pays each its own; "minimums" is the comparison, the minimums alone.

export const PAYOFF_STRATEGIES = ['planned', 'avalanche', 'snowball', 'minimums'] as const;
export type PayoffStrategy = (typeof PAYOFF_STRATEGIES)[number];

/** Projections stop here: 50 years. A debt not paid off by then never is, at these payments. */
export const PAYOFF_HORIZON_MONTHS = 600;

export interface PayoffDebt {
  id: string;
  /** What's owed now, positive. */
  owedMinor: number;
  /** Annual rate in basis points; null counts as no interest. */
  aprBps: number | null;
  /** The required payment each month. */
  minimumMinor: number;
  /** What's paid over the minimum each month: its goal's plan. */
  extraMinor: number;
}

export interface PayoffMonth {
  /** `YYYY-MM`. */
  month: string;
  /** What each debt still owes at the month's end, in the debts' order. */
  owedMinor: number[];
}

export interface Payoff {
  strategy: PayoffStrategy;
  /** Each month from this one until the last is paid off, or the horizon. */
  months: PayoffMonth[];
  /** The month each debt is paid off, by id; null when it never is at these payments. */
  paidOff: Record<string, string | null>;
  /** The month the last one is paid off; null when one never is. */
  debtFreeMonth: string | null;
  /** The interest paid until then (until the horizon when it never is). */
  interestMinor: number;
  /** Which comes first for the extra: the strategy's order, by id. */
  order: string[];
}

/**
 * A minimum to assume when the bank doesn't say and none is entered: 2% of what's owed, at least
 * 25 of the currency. It's shown as an estimate.
 */
export const estimatedMinimum = (owedMinor: number) =>
  Math.min(owedMinor, Math.max(2_500, Math.ceil(owedMinor * 0.02)));

const monthIndex = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return y * 12 + m - 1;
};
const monthOf = (index: number) =>
  `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;

/** Whom the extra goes to first: the highest rate (avalanche), or the smallest balance (snowball). */
function orderFor(debts: PayoffDebt[], strategy: PayoffStrategy): PayoffDebt[] {
  const apr = (d: PayoffDebt) => d.aprBps ?? 0;
  if (strategy === 'avalanche') {
    return [...debts].sort((a, b) => apr(b) - apr(a) || a.owedMinor - b.owedMinor);
  }
  if (strategy === 'snowball') {
    return [...debts].sort((a, b) => a.owedMinor - b.owedMinor || apr(b) - apr(a));
  }
  return debts;
}

/**
 * Projects paying the debts down from `thisMonth`. Each month adds its interest (the annual rate
 * over twelve, on what's owed), then pays. Minimums stay as they are now, as a fixed payment.
 */
export function payoff(debts: PayoffDebt[], strategy: PayoffStrategy, thisMonth: string): Payoff {
  const order = orderFor(debts, strategy);
  const owed = new Map(debts.map((d) => [d.id, Math.max(0, d.owedMinor)]));
  const paidOff: Record<string, string | null> = Object.fromEntries(
    debts.map((d) => [d.id, d.owedMinor <= 0 ? thisMonth : null]),
  );
  // Pooled, the month's budget is every debt's payment, whether or not it's paid off yet.
  const pool = debts.reduce((s, d) => s + d.minimumMinor + d.extraMinor, 0);
  const months: PayoffMonth[] = [];
  let interest = 0;
  const start = monthIndex(thisMonth);
  for (let i = 0; i < PAYOFF_HORIZON_MONTHS; i++) {
    if ([...owed.values()].every((o) => o === 0)) break;
    const month = monthOf(start + i);
    for (const d of debts) {
      const o = owed.get(d.id)!;
      if (o === 0) continue;
      const add = Math.round((o * (d.aprBps ?? 0)) / 120_000);
      interest += add;
      owed.set(d.id, o + add);
    }
    const pay = (d: PayoffDebt, amount: number) => {
      const o = owed.get(d.id)!;
      const paid = Math.min(o, Math.max(0, amount));
      owed.set(d.id, o - paid);
      if (o > 0 && o - paid === 0) paidOff[d.id] = month;
      return paid;
    };
    if (strategy === 'planned' || strategy === 'minimums') {
      for (const d of debts) {
        pay(d, d.minimumMinor + (strategy === 'planned' ? d.extraMinor : 0));
      }
    } else {
      let left = pool;
      for (const d of debts) left -= pay(d, Math.min(left, d.minimumMinor));
      for (const d of order) left -= pay(d, left);
    }
    months.push({ month, owedMinor: debts.map((d) => owed.get(d.id)!) });
  }
  const ends = Object.values(paidOff);
  const debtFreeMonth = ends.every((m) => m !== null)
    ? (ends as string[]).reduce((a, b) => (a > b ? a : b), thisMonth)
    : null;
  return {
    strategy,
    months,
    paidOff,
    debtFreeMonth,
    interestMinor: interest,
    order: order.map((d) => d.id),
  };
}
