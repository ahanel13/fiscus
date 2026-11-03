// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountOwners,
  accounts,
  type Executor,
  householdMembers,
  recurringSeries,
} from '@fiscus/db';
import { whoLooksAfter } from '@fiscus/shared';
import { asc, eq, sql } from 'drizzle-orm';

// Who sees a series, and who looks after it (#121; bills walkthrough D13, D22). For the api's
// pages, and for notifications (#127), which remind only the person who looks after a bill.
// Row-level security limits what's read to what the caller sees; in system context (the worker),
// everything in the household.

export interface SeriesPeople {
  /** The household's current members who see an account's series, in the order they joined. */
  seenBy(accountId: string): string[];
  /** An account's current owners, largest share first. */
  owners(accountId: string): string[];
  /** The household's current owners, in the order they joined. */
  householdOwners: string[];
}

/**
 * Who sees each account's series: its owners, and everyone in the household when it's shared in
 * full or view-only (balance-only members see the balance, not the transactions).
 */
export async function seriesPeople(tx: Executor): Promise<SeriesPeople> {
  const members = await tx
    .select({ id: householdMembers.id, role: householdMembers.role })
    .from(householdMembers)
    .where(
      sql`${householdMembers.householdId} = fiscus_household() AND ${householdMembers.leftAt} IS NULL`,
    )
    .orderBy(asc(householdMembers.joinedAt), asc(householdMembers.id));
  const current = new Set(members.map((m) => m.id));
  const visibility = new Map(
    (await tx.select({ id: accounts.id, visibility: accounts.visibility }).from(accounts)).map(
      (a) => [a.id, a.visibility],
    ),
  );
  const owners = new Map<string, { memberId: string; shareBps: number }[]>();
  for (const o of await tx.select().from(accountOwners)) {
    if (!current.has(o.memberId)) continue;
    owners.set(o.accountId, [...(owners.get(o.accountId) ?? []), o]);
  }
  const ownersOf = (accountId: string) =>
    (owners.get(accountId) ?? [])
      .sort((a, b) => b.shareBps - a.shareBps || a.memberId.localeCompare(b.memberId))
      .map((o) => o.memberId);
  return {
    owners: ownersOf,
    seenBy: (accountId) => {
      const v = visibility.get(accountId);
      if (!v) return [];
      const own = new Set(ownersOf(accountId));
      const shared = v === 'full' || v === 'view_only';
      return members.filter((m) => shared || own.has(m.id)).map((m) => m.id);
    },
    householdOwners: members.filter((m) => m.role === 'owner').map((m) => m.id),
  };
}

/**
 * Who gets the reminders for a series' occurrences (D13): the one person who looks after it, while
 * they still see its account; otherwise whoever the defaults give. Empty for income (no reminders),
 * for a series nobody left can see, and for one the caller can't see. Every occurrence of a series
 * goes to the same person, so this takes the series.
 */
export async function reminderRecipients(tx: Executor, seriesId: string): Promise<string[]> {
  const [s] = await tx
    .select({
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      responsibleMemberId: recurringSeries.responsibleMemberId,
      createdByMemberId: recurringSeries.createdByMemberId,
    })
    .from(recurringSeries)
    .where(eq(recurringSeries.id, seriesId));
  if (!s) return [];
  const people = await seriesPeople(tx);
  const who = whoLooksAfter({
    ...s,
    seenBy: people.seenBy(s.accountId),
    accountOwners: people.owners(s.accountId),
    householdOwners: people.householdOwners,
  });
  return who ? [who] : [];
}

/** Every series a member looks after, for their reminders: not income, not ended before `today`. */
export async function seriesLookedAfterBy(
  tx: Executor,
  memberId: string,
  today: string,
): Promise<string[]> {
  const rows = await tx
    .select({
      id: recurringSeries.id,
      kind: recurringSeries.kind,
      accountId: recurringSeries.accountId,
      responsibleMemberId: recurringSeries.responsibleMemberId,
      createdByMemberId: recurringSeries.createdByMemberId,
      endedOn: recurringSeries.endedOn,
    })
    .from(recurringSeries)
    .where(sql`${recurringSeries.endedOn} IS NULL OR ${recurringSeries.endedOn} >= ${today}`);
  const people = await seriesPeople(tx);
  return rows
    .filter(
      (s) =>
        whoLooksAfter({
          ...s,
          seenBy: people.seenBy(s.accountId),
          accountOwners: people.owners(s.accountId),
          householdOwners: people.householdOwners,
        }) === memberId,
    )
    .map((s) => s.id);
}
