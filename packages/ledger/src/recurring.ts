// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountLiabilities,
  accountOwners,
  accounts,
  type Executor,
  householdMembers,
  recurringSeries,
  transactions,
} from '@fiscus/db';
import {
  addDays,
  LATE_AFTER_DAYS,
  type StatementPaid,
  statementPaid,
  whoLooksAfter,
} from '@fiscus/shared';
import { and, asc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

// Who sees a series, and who looks after it (#121; bills walkthrough D13, D22). For the api's
// pages, and for notifications (#127), which remind only the person who looks after a bill.
// Row-level security limits what's read to what the caller sees; in system context (the worker),
// everything in the household.

export interface SeriesPeople {
  /** The household's current members who see an account's series, in the order they joined. */
  seenBy(accountId: string): string[];
  /** An account's current owners, largest share first. */
  owners(accountId: string): string[];
  /**
   * The household's current members who see a card's statement: its owners, and everyone when
   * it's shared in full (statement details are for owner and full access, migration 0041).
   */
  seeStatement(accountId: string): string[];
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
    seeStatement: (accountId) => {
      const v = visibility.get(accountId);
      if (!v) return [];
      const own = new Set(ownersOf(accountId));
      return members.filter((m) => v === 'full' || own.has(m.id)).map((m) => m.id);
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

// ── Card statements (#122; bills walkthrough D9) ────────────────────────────────────────────

/** A card's statement, from the bank (Plaid liabilities, #86): what's owed, by when, and paid. */
export interface CardStatement {
  accountId: string;
  accountName: string;
  currency: string;
  due: string;
  /** The day the statement closed; payments after it count toward it. */
  statementDate: string | null;
  /** Its balance, positive. */
  owedMinor: number;
  minimumMinor: number | null;
  /** What's gone into the card since the statement date. */
  paidSoFarMinor: number;
  paid: StatementPaid;
  /**
   * `paid` once the balance or the minimum is paid; else `late` two days after its due date
   * (D12), or `due`.
   */
  status: 'paid' | 'due' | 'late';
}

/**
 * Card statements due from `from` to `to` (D9), on the cards the caller sees statements of (owner
 * and full access; everything in system context). Payments into the card since the statement
 * date pay it: all of it, its minimum, or part. Cards with no statement from the bank (SimpleFIN,
 * manual ones) have none. `accountIds` narrows it to some cards.
 */
export async function cardStatements(
  tx: Executor,
  {
    from,
    to,
    today,
    accountIds,
  }: { from: string; to: string; today: string; accountIds?: string[] },
): Promise<CardStatement[]> {
  if (accountIds && accountIds.length === 0) return [];
  const rows = await tx
    .select({ l: accountLiabilities, name: accounts.name, currency: accounts.currency })
    .from(accountLiabilities)
    .innerJoin(accounts, eq(accounts.id, accountLiabilities.accountId))
    .where(
      and(
        gte(accountLiabilities.nextDueDate, from),
        lte(accountLiabilities.nextDueDate, to),
        accountIds ? inArray(accountLiabilities.accountId, accountIds) : undefined,
      ),
    )
    .orderBy(asc(accountLiabilities.nextDueDate), asc(accounts.name));
  const out: CardStatement[] = [];
  for (const { l, name, currency } of rows) {
    const owed = -(l.lastStatementBalanceMinor ?? 0);
    if (owed <= 0 || !l.nextDueDate) continue;
    const [sum] = await tx
      .select({ total: sql<string>`coalesce(sum(${transactions.amountMinor}), 0)` })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, l.accountId),
          isNull(transactions.parentId),
          isNull(transactions.deletedAt),
          gt(transactions.amountMinor, 0),
          l.lastStatementDate ? gt(transactions.effectiveDate, l.lastStatementDate) : undefined,
        ),
      );
    const paidSoFar = Number(sum?.total ?? 0);
    const paid = statementPaid(owed, l.minimumPaymentMinor, paidSoFar);
    out.push({
      accountId: l.accountId,
      accountName: name,
      currency,
      due: l.nextDueDate,
      statementDate: l.lastStatementDate,
      owedMinor: owed,
      minimumMinor: l.minimumPaymentMinor,
      paidSoFarMinor: paidSoFar,
      paid,
      status:
        paid === 'paid' || paid === 'minimum'
          ? 'paid'
          : addDays(l.nextDueDate, LATE_AFTER_DAYS) < today
            ? 'late'
            : 'due',
    });
  }
  return out;
}

/**
 * For the "A card statement is due" notification (#127): statements due from `today` to
 * `withinDays` days after it, on cards `memberId` owns, not yet paid in full.
 */
export async function cardStatementsDue(
  tx: Executor,
  { memberId, today, withinDays }: { memberId: string; today: string; withinDays: number },
): Promise<CardStatement[]> {
  const owned = await tx
    .select({ accountId: accountOwners.accountId })
    .from(accountOwners)
    .where(eq(accountOwners.memberId, memberId));
  const statements = await cardStatements(tx, {
    from: today,
    to: addDays(today, withinDays),
    today,
    accountIds: owned.map((o) => o.accountId),
  });
  return statements.filter((s) => s.paid !== 'paid');
}
