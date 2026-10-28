// SPDX-License-Identifier: AGPL-3.0-or-later
import { type SplitPolicyRow, type SplitRuleInput, splitRuleFor, splitShares } from './split.js';

// Who owes whom (#111, ADR 0006 §7.2, budgeting walkthrough §8): for each shared expense, what
// each person paid (the account's owners on its date) against what each owes (the split rule for
// its category, among the people it's for). The difference builds a balance between each pair.
// Computed when read, as budgets are: changing a transaction changes the balance at once.

/** A shared expense: one attributed to two or more people (D1, D17). */
export interface SharedExpense {
  id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  categoryId: string | null;
  /** What it cost, positive; a refund is negative. */
  costMinor: number;
  /** Who it's for, with their attribution shares (bps adding to 10 000). */
  forMembers: readonly { memberId: string; shareBps: number }[];
  /** Who paid: the account's owners on its date, with their shares. */
  paidBy: readonly { memberId: string; shareBps: number }[];
}

/** What one expense does: each person's paid and owed, and the net (paid − owed). */
export interface ExpenseEffect {
  expenseId: string;
  paid: Map<string, number>;
  owed: Map<string, number>;
  net: Map<string, number>;
}

/**
 * `total` split by basis points, in minor units that add up exactly: rounding leftovers go to
 * `first`, then in order (the payer takes the odd cent, the walkthrough's open question).
 */
export function allocate(
  total: number,
  shares: ReadonlyMap<string, number>,
  first?: string,
): Map<string, number> {
  const out = new Map<string, number>();
  const ids = [...shares.keys()];
  if (ids.length === 0) return out;
  const sum = [...shares.values()].reduce((a, b) => a + b, 0);
  let given = 0;
  for (const id of ids) {
    const part = Math.trunc((total * shares.get(id)!) / sum);
    out.set(id, part);
    given += part;
  }
  const order = first && out.has(first) ? [first, ...ids.filter((i) => i !== first)] : ids;
  let left = total - given;
  const step = Math.sign(left);
  for (let i = 0; left !== 0; i = (i + 1) % order.length) {
    out.set(order[i]!, out.get(order[i]!)! + step);
    left -= step;
  }
  return out;
}

const shareMap = (xs: readonly { memberId: string; shareBps: number }[]) =>
  new Map(xs.map((x) => [x.memberId, x.shareBps]));

/** The largest payer, for odd cents. */
const mainPayer = (e: SharedExpense) =>
  [...e.paidBy].sort((a, b) => b.shareBps - a.shareBps || (a.memberId < b.memberId ? -1 : 1))[0]
    ?.memberId;

/**
 * Each expense's effect, under the split rules (#109). An attribution with unequal shares set by
 * hand is a split of its own and wins; otherwise the category's rule decides. A fixed monthly
 * amount ("You $400 · the rest equally") is worked out over the month: those named pay their
 * amounts, scaled down if the month cost less, and the rest is split equally among the others.
 */
export function expenseEffects(
  expenses: readonly SharedExpense[],
  policies: readonly SplitPolicyRow[],
): ExpenseEffect[] {
  const effects: ExpenseEffect[] = [];
  // Fixed-amount rules are settled per category per month, across that month's expenses.
  const fixedGroups = new Map<
    string,
    { rule: Extract<SplitRuleInput, { method: 'fixed_amount' }>; items: SharedExpense[] }
  >();
  for (const e of expenses) {
    const unequal = new Set(e.forMembers.map((f) => f.shareBps)).size > 1;
    const rule = splitRuleFor(policies, e.categoryId, e.date);
    if (!unequal && rule.method === 'fixed_amount') {
      const key = `${e.categoryId}|${e.date.slice(0, 7)}`;
      const g = fixedGroups.get(key) ?? { rule, items: [] };
      g.items.push(e);
      fixedGroups.set(key, g);
      continue;
    }
    // Equal splits divide the money itself, so three ways of 300.00 is 100.00 each.
    const shares = unequal
      ? shareMap(e.forMembers)
      : rule.method === 'equal'
        ? new Map(e.forMembers.map((f) => [f.memberId, 1]))
        : (splitShares(
            rule,
            e.forMembers.map((f) => f.memberId),
          ) ?? shareMap(e.forMembers));
    effects.push(effectOf(e, allocate(e.costMinor, shares, mainPayer(e))));
  }
  for (const { rule, items } of fixedGroups.values()) {
    const total = items.reduce((s, e) => s + e.costMinor, 0);
    const members = [...new Set(items.flatMap((e) => e.forMembers.map((f) => f.memberId)))];
    const fixed = rule.amounts.filter((a) => members.includes(a.memberId));
    const fixedTotal = fixed.reduce((s, a) => s + a.amountMinor, 0);
    const scale = fixedTotal > Math.max(total, 0) ? Math.max(total, 0) / fixedTotal : 1;
    const monthOwed = new Map<string, number>(
      fixed.map((a) => [a.memberId, Math.round(a.amountMinor * scale)]),
    );
    const rest = members.filter((m) => !monthOwed.has(m));
    const remainder = total - [...monthOwed.values()].reduce((s, v) => s + v, 0);
    if (rest.length) {
      for (const [m, v] of allocate(remainder, new Map(rest.map((r) => [r, 1])))) {
        monthOwed.set(m, v);
      }
    } else if (fixed.length) {
      // Everyone named a fixed amount: what's left over is shared in proportion to them.
      for (const [m, v] of allocate(
        remainder,
        new Map(fixed.map((a) => [a.memberId, a.amountMinor || 1])),
      )) {
        monthOwed.set(m, (monthOwed.get(m) ?? 0) + v);
      }
    }
    // Each expense carries its part of the month's owed amounts, in proportion to its cost.
    let given = new Map<string, number>();
    items.forEach((e, i) => {
      const last = i === items.length - 1;
      const owed = new Map<string, number>();
      for (const [m, v] of monthOwed) {
        const part = last
          ? v - (given.get(m) ?? 0)
          : total === 0
            ? 0
            : Math.round((v * e.costMinor) / total);
        owed.set(m, part);
        given.set(m, (given.get(m) ?? 0) + part);
      }
      effects.push(effectOf(e, owed));
    });
    given = new Map();
  }
  return effects;
}

function effectOf(e: SharedExpense, owed: Map<string, number>): ExpenseEffect {
  const paid = allocate(e.costMinor, shareMap(e.paidBy), mainPayer(e));
  const net = new Map<string, number>();
  for (const id of new Set([...paid.keys(), ...owed.keys()])) {
    net.set(id, (paid.get(id) ?? 0) - (owed.get(id) ?? 0));
  }
  return { expenseId: e.id, paid, owed, net };
}

/**
 * What each pair owes from a set of effects: for each expense, those owing pay those owed in
 * proportion to what each is owed. `owes(a, b)` positive means a owes b.
 */
export function pairBalances(effects: readonly ExpenseEffect[]): PairBalances {
  const owes = new Map<string, number>(); // `${from}→${to}` → minor units
  for (const e of effects) {
    const credit = [...e.net].filter(([, v]) => v > 0);
    const debit = [...e.net].filter(([, v]) => v < 0);
    const creditTotal = credit.reduce((s, [, v]) => s + v, 0);
    if (creditTotal === 0) continue;
    for (const [d, dv] of debit) {
      const parts = allocate(-dv, new Map(credit));
      for (const [c, v] of parts) {
        const key = `${d}→${c}`;
        owes.set(key, (owes.get(key) ?? 0) + v);
      }
    }
  }
  return new PairBalances(owes);
}

export class PairBalances {
  constructor(private readonly raw: Map<string, number>) {}

  /** What `a` owes `b`, net of what `b` owes `a`: negative when `b` owes `a`. */
  owes(a: string, b: string): number {
    return (this.raw.get(`${a}→${b}`) ?? 0) - (this.raw.get(`${b}→${a}`) ?? 0);
  }

  /** Everyone `member` has a balance with, and the balance from their side (positive: owed). */
  withMember(member: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const key of this.raw.keys()) {
      const [from, to] = key.split('→') as [string, string];
      const other = from === member ? to : to === member ? from : undefined;
      if (other) out.set(other, this.owes(other, member));
    }
    return out;
  }
}
