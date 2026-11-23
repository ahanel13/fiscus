// SPDX-License-Identifier: AGPL-3.0-or-later

// Goal priority's suggestions (#136; goals walkthrough §5, G3, G19, G25). Pure arithmetic on
// minor units: what priority suggests when a balance falls short, and where unclaimed money could
// go. These only suggest. Nothing here changes a claim; the account's owners confirm first.

/** A fixed claim on an account, for a goal. */
export interface FixedClaim {
  goalId: string;
  amountMinor: number;
}

/** How much to take off which goal's claim, or to add to it. */
export interface ClaimChange {
  goalId: string;
  amountMinor: number;
}

/**
 * Priority's suggestion for a shortfall (G19): the lowest-priority goal gives way first, then the
 * next, each by no more than its fixed claim. `claims` are lowest priority first. What the claims
 * can't cover stays short.
 */
export function takeFromLowest(shortMinor: number, claims: FixedClaim[]): ClaimChange[] {
  let left = Math.max(0, shortMinor);
  const out: ClaimChange[] = [];
  for (const c of claims) {
    if (left === 0) break;
    const take = Math.min(left, c.amountMinor);
    if (take <= 0) continue;
    out.push({ goalId: c.goalId, amountMinor: take });
    left -= take;
  }
  return out;
}

/**
 * A shortfall split by the goals' claims (walkthrough §5): each gives way in proportion to its
 * claim, the cents rounding leaves going to the largest remainders, and none beyond its claim. When
 * the claims add up to less than the shortfall, they all go and the rest stays short.
 */
export function splitByClaims(shortMinor: number, claims: FixedClaim[]): ClaimChange[] {
  const total = claims.reduce((s, c) => s + Math.max(0, c.amountMinor), 0);
  if (total === 0 || shortMinor <= 0) return [];
  const take = Math.min(shortMinor, total);
  const shares = claims.map((c, i) => {
    const exact = (take * Math.max(0, c.amountMinor)) / total;
    return { i, goalId: c.goalId, amountMinor: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left = take - shares.reduce((s, x) => s + x.amountMinor, 0);
  // Largest remainder first; ties to the earlier claim, so the answer doesn't depend on chance.
  for (const x of [...shares].sort((a, b) => b.rest - a.rest || a.i - b.i)) {
    if (left === 0) break;
    if (x.amountMinor < claims[x.i]!.amountMinor) {
      x.amountMinor += 1;
      left -= 1;
    }
  }
  return shares
    .filter((x) => x.amountMinor > 0)
    .map(({ goalId, amountMinor }) => ({
      goalId,
      amountMinor,
    }));
}

/** An account you own, and what's unclaimed in it (G3). */
export interface AllocationAccount {
  accountId: string;
  type: 'depository' | 'investment';
  /** The bank's subtype: checking money is for spending, so it isn't offered unless asked. */
  subtype: string | null;
  unclaimedMinor: number;
}

/** A savings goal, in priority order, and what it still needs to reach its target. */
export interface AllocationGoal {
  goalId: string;
  needMinor: number;
  /** Its claims on accounts you own: a fixed one can be raised; a percentage one can't take more. */
  claims: { accountId: string; fixed: boolean }[];
}

/** One step of a suggestion: earmark this much of the account for the goal. */
export interface AllocationStep {
  goalId: string;
  accountId: string;
  amountMinor: number;
}

/** Everyday accounts: their money is for spending, so suggestions leave it be (G25). */
const SPENDING_SUBTYPES = new Set(['checking', 'paypal', 'prepaid', 'cash management', 'ebt']);

/**
 * Where unclaimed money could go, by priority (G25): the highest-priority goal first, up to what
 * it needs to reach its target, then the next. For each goal, accounts it already draws on by a
 * fixed amount come first (raising that claim), then savings accounts, the most unclaimed first.
 * Checking and other everyday accounts, and investments a goal doesn't already draw on, aren't
 * offered: percentages suit investments (G2), and spending money isn't savings. An account a goal
 * claims by percentage isn't offered to that goal, since one goal has one claim per account.
 */
export function suggestAllocation(
  goals: AllocationGoal[],
  accounts: AllocationAccount[],
): AllocationStep[] {
  const free = new Map(accounts.map((a) => [a.accountId, Math.max(0, a.unclaimedMinor)]));
  const out: AllocationStep[] = [];
  for (const g of goals) {
    let need = Math.max(0, g.needMinor);
    if (need === 0) continue;
    const fixed = new Set(g.claims.filter((c) => c.fixed).map((c) => c.accountId));
    const percent = new Set(g.claims.filter((c) => !c.fixed).map((c) => c.accountId));
    const offered = accounts
      .filter((a) => !percent.has(a.accountId))
      .filter(
        (a) =>
          fixed.has(a.accountId) ||
          (a.type === 'depository' && !SPENDING_SUBTYPES.has(a.subtype ?? '')),
      )
      .sort(
        (a, b) =>
          Number(fixed.has(b.accountId)) - Number(fixed.has(a.accountId)) ||
          free.get(b.accountId)! - free.get(a.accountId)! ||
          a.accountId.localeCompare(b.accountId),
      );
    for (const a of offered) {
      if (need === 0) break;
      const take = Math.min(need, free.get(a.accountId)!);
      if (take <= 0) continue;
      out.push({ goalId: g.goalId, accountId: a.accountId, amountMinor: take });
      free.set(a.accountId, free.get(a.accountId)! - take);
      need -= take;
    }
  }
  return out;
}
