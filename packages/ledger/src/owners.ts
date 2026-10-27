// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountOwnerPeriods, accountOwners, type Executor } from '@fiscus/db';
import type { OwnersFrom } from '@fiscus/shared';
import { and, eq, inArray, max } from 'drizzle-orm';

// Who owned an account when (#447). A transaction with no attribution of its own is for whoever
// owned its account on its date, so changing owners needn't rewrite the past. Who can see an
// account still follows today's owners alone (fiscus_account_access()).

export interface OwnerShare {
  memberId: string;
  shareBps: number;
}

const byShare = (a: OwnerShare, b: OwnerShare) =>
  b.shareBps - a.shareBps || (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0);

/**
 * The owners of `accountIds` on any date, as fiscus_owners_on() gives them: the period covering
 * the date, else today's owners. Largest share first. Row-level security limits it to accounts
 * the caller can see.
 */
export async function ownersOnDates(
  tx: Executor,
  accountIds: readonly string[],
): Promise<(accountId: string, date: string) => OwnerShare[]> {
  if (accountIds.length === 0) return () => [];
  const ids = [...new Set(accountIds)];
  const current = new Map<string, OwnerShare[]>();
  for (const o of await tx
    .select()
    .from(accountOwners)
    .where(inArray(accountOwners.accountId, ids))) {
    current.set(o.accountId, [
      ...(current.get(o.accountId) ?? []),
      { memberId: o.memberId, shareBps: o.shareBps },
    ]);
  }
  const periods = new Map<string, Map<string, { from: string | null; owners: OwnerShare[] }>>();
  for (const p of await tx
    .select()
    .from(accountOwnerPeriods)
    .where(inArray(accountOwnerPeriods.accountId, ids))) {
    const byEnd = periods.get(p.accountId) ?? new Map();
    const period = byEnd.get(p.validUntil) ?? { from: p.validFrom, owners: [] };
    period.owners.push({ memberId: p.memberId, shareBps: p.shareBps });
    byEnd.set(p.validUntil, period);
    periods.set(p.accountId, byEnd);
  }
  for (const list of current.values()) list.sort(byShare);
  for (const byEnd of periods.values()) for (const p of byEnd.values()) p.owners.sort(byShare);

  return (accountId, date) => {
    for (const [until, p] of periods.get(accountId) ?? []) {
      if (date < until && (p.from === null || p.from <= date)) return p.owners;
    }
    return current.get(accountId) ?? [];
  };
}

/**
 * Replaces an account's owners. `from: 'today'` keeps earlier dates with the owners they had: the
 * current owners become a period ending `today` (a second change the same day replaces the first).
 * `from: 'always'` makes the new owners count for every date, clearing the periods. The caller
 * checks who may change them (ACC-08); row-level security checks it again.
 */
export async function replaceOwners(
  tx: Executor,
  input: {
    householdId: string;
    accountId: string;
    before: readonly OwnerShare[];
    after: readonly OwnerShare[];
    from: OwnersFrom;
    /** Today in the household's time zone. */
    today: string;
  },
): Promise<void> {
  const { householdId, accountId, before, after, from, today } = input;
  if (from === 'always') {
    await tx.delete(accountOwnerPeriods).where(eq(accountOwnerPeriods.accountId, accountId));
  } else {
    const [last] = await tx
      .select({ until: max(accountOwnerPeriods.validUntil) })
      .from(accountOwnerPeriods)
      .where(eq(accountOwnerPeriods.accountId, accountId));
    const since = last?.until ?? null;
    // Already changed today: the owners from earlier today never counted for a whole day.
    if (since !== today && before.length > 0) {
      await tx.insert(accountOwnerPeriods).values(
        before.map((o) => ({
          householdId,
          accountId,
          memberId: o.memberId,
          shareBps: o.shareBps,
          validFrom: since,
          validUntil: today,
        })),
      );
    }
  }
  await tx
    .delete(accountOwners)
    .where(and(eq(accountOwners.accountId, accountId), eq(accountOwners.householdId, householdId)));
  await tx
    .insert(accountOwners)
    .values(
      after.map((o) => ({ accountId, householdId, memberId: o.memberId, shareBps: o.shareBps })),
    );
}
