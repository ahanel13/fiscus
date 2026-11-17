// SPDX-License-Identifier: AGPL-3.0-or-later

// Settling with the fewest transfers (#262, budgeting walkthrough D31). Pair balances say who
// owes whom; a plan says who pays whom so that everyone ends up square, in as few payments as
// possible. "Ada pays Jo $40" instead of "Ada pays Sam $40, Sam pays Jo $40".
//
// A plan is worked out only between people who have all agreed to it, and each sees only the
// payments they're part of (ADR 0006 §4, §7): see `consentedDebts` and `transfersFor`.

/** `from` owes `to` `amountMinor`, positive. Also a payment in a plan: `from` pays `to`. */
export interface Debt {
  from: string;
  to: string;
  amountMinor: number;
}

/** Where each person stands overall: positive, they're owed; negative, they owe. Zeros left out. */
export function netPositions(debts: readonly Debt[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const d of debts) {
    net.set(d.from, (net.get(d.from) ?? 0) - d.amountMinor);
    net.set(d.to, (net.get(d.to) ?? 0) + d.amountMinor);
  }
  for (const [id, v] of net) if (v === 0) net.delete(id);
  return net;
}

/**
 * Only the balances between two people who have both agreed. Anyone else's balances never reach
 * the plan, so nothing about them can be read from it.
 */
export function consentedDebts(debts: readonly Debt[], agreed: ReadonlySet<string>): Debt[] {
  return debts.filter((d) => agreed.has(d.from) && agreed.has(d.to));
}

/** The payments in a plan that `member` makes or receives: all they're shown of it. */
export function transfersFor(member: string, plan: readonly Debt[]): Debt[] {
  return plan.filter((t) => t.from === member || t.to === member);
}

/** Up to this many people with a balance, the plan is the fewest possible; above, it's greedy. */
const EXACT_UP_TO = 14;

/**
 * The fewest payments that square everyone up. Each person's payments add up to where they stand
 * overall, so the plan settles the same amounts as paying each balance, never more payments.
 *
 * The fewest is (people with a balance) − (the most groups they split into whose balances cancel
 * out): each group squares up within itself in one payment fewer than its size. Finding those
 * groups is a search over subsets, fine for a household; past `EXACT_UP_TO` people it's the usual
 * greedy match of largest debt to largest credit instead.
 *
 * The same balances always give the same plan, whatever order they come in.
 */
export function simplifyDebts(debts: readonly Debt[]): Debt[] {
  const net = netPositions(debts);
  const ids = [...net.keys()].sort();
  if (ids.length === 0) return [];
  const groups = ids.length <= EXACT_UP_TO ? zeroSumGroups(ids, net) : [ids];
  const plan = groups.flatMap((g) => greedy(g, net)).sort(order);
  // Greedy can't do worse than paying each balance once the groups are found, but past the exact
  // limit it can: then the balances as they are win.
  const direct = pairwise(debts);
  return plan.length <= direct.length ? plan : direct;
}

/** The balances netted pair by pair, as payments. */
function pairwise(debts: readonly Debt[]): Debt[] {
  const by = new Map<string, number>();
  for (const d of debts) {
    const [a, b] = d.from < d.to ? [d.from, d.to] : [d.to, d.from];
    const key = `${a}\u0000${b}`;
    by.set(key, (by.get(key) ?? 0) + (d.from === a ? d.amountMinor : -d.amountMinor));
  }
  return [...by]
    .filter(([, v]) => v !== 0)
    .map(([key, v]) => {
      const [a, b] = key.split('\u0000') as [string, string];
      return v > 0 ? { from: a, to: b, amountMinor: v } : { from: b, to: a, amountMinor: -v };
    })
    .sort(order);
}

/**
 * Splits `ids` into as many groups as possible whose balances each add up to zero. `best[mask]`
 * is the most such groups among the people in `mask`, counting a group each time a running total
 * returns to zero; walking back through it recovers an order, and the groups are its stretches
 * between zeros.
 */
function zeroSumGroups(ids: string[], net: ReadonlyMap<string, number>): string[][] {
  const n = ids.length;
  const full = (1 << n) - 1;
  const sum = new Array<number>(full + 1).fill(0);
  const best = new Array<number>(full + 1).fill(0);
  for (let mask = 1; mask <= full; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)]! + net.get(ids[low]!)!;
    let most = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) most = Math.max(most, best[mask ^ (1 << i)]!);
    }
    best[mask] = most + (sum[mask] === 0 ? 1 : 0);
  }
  // Take people off the end in the order that keeps the most groups, lowest index first.
  const removed: number[] = [];
  for (let mask = full; mask;) {
    const here = best[mask]! - (sum[mask] === 0 ? 1 : 0);
    let i = 0;
    while (!(mask & (1 << i)) || best[mask ^ (1 << i)] !== here) i++;
    removed.push(i);
    mask ^= 1 << i;
  }
  const groups: string[][] = [];
  let current: string[] = [];
  let mask = 0;
  for (const i of removed.reverse()) {
    current.push(ids[i]!);
    mask |= 1 << i;
    if (sum[mask] === 0) {
      groups.push(current);
      current = [];
    }
  }
  return groups;
}

/** Squares up a group: the largest debt pays the largest credit, until everyone's square. */
function greedy(group: readonly string[], net: ReadonlyMap<string, number>): Debt[] {
  const left = new Map(group.map((id) => [id, net.get(id)!]));
  const out: Debt[] = [];
  const pick = (sign: 1 | -1) =>
    [...left]
      .filter(([, v]) => Math.sign(v) === sign)
      .sort(([a, x], [b, y]) => Math.abs(y) - Math.abs(x) || (a < b ? -1 : 1))[0];
  for (;;) {
    const debtor = pick(-1);
    const creditor = pick(1);
    if (!debtor || !creditor) break;
    const amountMinor = Math.min(-debtor[1], creditor[1]);
    out.push({ from: debtor[0], to: creditor[0], amountMinor });
    left.set(debtor[0], debtor[1] + amountMinor);
    left.set(creditor[0], creditor[1] - amountMinor);
  }
  return out;
}

const order = (a: Debt, b: Debt) =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
