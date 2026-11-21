// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  attributionFlags,
  categories,
  categoryGroups,
  type Executor,
  households,
  settlements,
  splitPolicies,
  transactionAttributions,
  transactions,
} from '@fiscus/db';
import {
  addMonths,
  type ExpenseEffect,
  expenseEffects,
  firstDayOf,
  pairBalances,
  settlementEffect,
  type SharedExpense,
  type SplitPolicyRow,
} from '@fiscus/domain';
import { type Settlement, type SharedCosts, type SplitRule, splitRuleSchema } from '@fiscus/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { attributedToTwoOrMore } from './budget-activity.js';
import { incomeShares } from './income-split.js';
import { ownersOnDates } from './owners.js';
import { householdRanges, transactionDate } from './ranges.js';

// Who owes whom (#111, ADR 0006 §7.2): computed when read from every shared expense up to the
// month's end, for one person. The api shows it on Shared costs; the worker's settle-up
// reminders and monthly summaries (#116) send it. Both read it here, in the reader's own context,
// so a notification never says more than their Shared costs page does (SYS-02).

export class SharedCostsContextError extends Error {
  constructor() {
    super('Shared costs are built in their reader’s own context, never system context (SYS-02)');
    this.name = 'SharedCostsContextError';
  }
}

interface SharedRow {
  id: string;
  accountId: string;
  /** The date it counts on, per the household's date basis. */
  date: string;
  effectiveDate: string;
  categoryId: string | null;
  amountMinor: number;
  displayName: string;
}

/**
 * One member's shared costs for `month` (`YYYY-MM`). Only the balances that involve them are
 * returned, from expenses they're part of: those attributed to them are visible to them (F1), and
 * so are those paid from accounts they own. Must run in that member's own context (household,
 * member and user set, not system).
 */
export async function buildSharedCosts(
  tx: Executor,
  { memberId: me, month }: { memberId: string; month: string },
): Promise<Omit<SharedCosts, 'simplify'>> {
  const { rows: ctx } = await tx.execute<{
    system: boolean;
    member: string | null;
    household: string | null;
  }>(
    sql`SELECT fiscus_is_system() AS system, fiscus_member()::text AS member,
               fiscus_household()::text AS household`,
  );
  if (!ctx[0] || ctx[0].system || ctx[0].member !== me || !ctx[0].household) {
    throw new SharedCostsContextError();
  }
  const householdId = ctx[0].household;
  const [h] = await tx
    .select({ currency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, householdId));
  const currency = h!.currency;
  const end = firstDayOf(addMonths(month, 1));
  const rows = await sharedRows(tx, householdId, currency, end);
  const expenses = await sharedExpenses(tx, rows);
  const policies = await loadPolicies(tx);
  const involving = expenses.filter(
    (e) => e.forMembers.some((f) => f.memberId === me) || e.paidBy.some((p) => p.memberId === me),
  );
  // Shares for a split by income, on the days it might count (F4, #110). Read in this member's
  // own context, so they come as shares, never anyone's income.
  const income = await incomeShares(
    tx,
    policies.some((p) => p.rule?.method === 'income_proportional')
      ? involving.map((e) => e.date)
      : [],
  );
  // Flagged changes wait outside the balance until they're resolved (#60, D18).
  const flags = new Map(
    (await tx.select().from(attributionFlags).where(isNull(attributionFlags.resolvedAt))).map(
      (f) => [f.transactionId, f],
    ),
  );
  const mine = involving.filter((e) => !flags.has(e.id));
  const flagged = involving.filter((e) => flags.has(e.id));
  const settled = await tx
    .select()
    .from(settlements)
    .where(sql`${settlements.date} < ${end}::date`);
  const effects = [
    ...expenseEffects(mine, policies, income),
    ...settled.map((x) => settlementEffect(x.id, x.fromMemberId, x.toMemberId, x.amountMinor)),
  ];
  const beforeSet = new Set([
    ...mine.filter((e) => e.date < firstDayOf(month)).map((e) => e.id),
    ...settled.filter((x) => x.date < firstDayOf(month)).map((x) => x.id),
  ]);
  const list = (m: Map<string, number>) =>
    [...m]
      .filter(([id, v]) => id !== me && v !== 0)
      .map(([memberId, amountMinor]) => ({ memberId, amountMinor }));

  const inMonth = mine.filter((e) => e.date >= firstDayOf(month));
  const effectOf = new Map(effects.map((e) => [e.expenseId, e]));
  const names = new Map(rows.map((r) => [r.id, r]));
  const line = (e: SharedExpense, eff: ExpenseEffect) => {
    const single = pairBalances([eff]).withMember(me);
    return {
      transactionId: e.id,
      date: e.date,
      displayName: names.get(e.id)!.displayName,
      categoryId: e.categoryId,
      costMinor: e.costMinor,
      paidBy: e.paidBy.map((p) => p.memberId),
      forMembers: e.forMembers.map((f) => f.memberId),
      effect: list(single),
      evensOut: [...eff.net.values()].every((v) => v === 0),
    };
  };
  const newest = (a: { date: string }, b: { date: string }) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  const lines = inMonth.map((e) => line(e, effectOf.get(e.id)!)).sort(newest);
  // Each disputed expense on its own: what it would do if it counted as it stands.
  const disputed = flagged
    .map((e) => {
      const f = flags.get(e.id)!;
      const { evensOut: _e, ...l } = line(e, expenseEffects([e], policies, income)[0]!);
      return {
        ...l,
        flag: {
          id: f.id,
          flaggedByMemberId: f.flaggedByMemberId,
          note: f.note,
          createdAt: f.createdAt.toISOString(),
        },
      };
    })
    .sort(newest);
  return {
    month,
    currency,
    balances: list(pairBalances(effects).withMember(me)),
    carried: list(pairBalances(effects.filter((e) => beforeSet.has(e.expenseId))).withMember(me)),
    expenses: lines.map(({ evensOut: _e, ...l }) => l),
    disputed,
    settlements: settled
      .filter((x) => x.date >= firstDayOf(month))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((x) => ({
        id: x.id,
        date: x.date,
        fromMemberId: x.fromMemberId,
        toMemberId: x.toMemberId,
        amountMinor: x.amountMinor,
        kind: x.kind as Settlement['kind'],
        transactionId: x.transactionId,
        note: x.note,
      })),
    sharedSpendingMinor: lines.reduce((s, l) => s + l.costMinor, 0),
    evensOutMinor: lines.filter((l) => l.evensOut).reduce((s, l) => s + l.costMinor, 0),
  };
}

/** Shared transactions before `end` (D1): attributed to two or more, spending, counted. */
async function sharedRows(
  tx: Executor,
  householdId: string,
  currency: string,
  end: string,
): Promise<SharedRow[]> {
  const ranges = await householdRanges(tx, householdId);
  const date = transactionDate(ranges.dateBasis);
  return tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      date: sql<string>`${date}::text`,
      effectiveDate: transactions.effectiveDate,
      categoryId: transactions.categoryId,
      amountMinor: transactions.amountMinor,
      displayName: transactions.displayName,
    })
    .from(transactions)
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
    .where(
      and(
        isNull(transactions.deletedAt),
        eq(transactions.hasSplits, false),
        eq(transactions.excluded, false),
        eq(transactions.currency, currency),
        sql`coalesce(${categoryGroups.kind}::text, '') NOT IN ('transfer', 'income')`,
        sql`${date} < ${end}::date`,
        attributedToTwoOrMore,
      ),
    );
}

/** Who each is for, and who paid: the account's owners on its date, as people (F1). */
async function sharedExpenses(tx: Executor, rows: SharedRow[]): Promise<SharedExpense[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const explicit = new Map<string, { memberId: string; shareBps: number }[]>();
  for (const a of await tx
    .select()
    .from(transactionAttributions)
    .where(inArray(transactionAttributions.transactionId, ids))) {
    explicit.set(a.transactionId, [
      ...(explicit.get(a.transactionId) ?? []),
      { memberId: a.memberId, shareBps: a.shareBps },
    ]);
  }
  const ownersOn = await ownersOnDates(
    tx,
    rows.map((r) => r.accountId),
  );
  // For a transaction on an account you can't see, who paid comes as people only (F1).
  const payers = new Map<string, string[]>();
  const { rows: hidden } = await tx.execute<{ transaction_id: string; member_id: string }>(
    sql`SELECT transaction_id, member_id FROM fiscus_attributed_payers()`,
  );
  for (const p of hidden) {
    payers.set(p.transaction_id, [...(payers.get(p.transaction_id) ?? []), p.member_id]);
  }
  return rows.map((r) => {
    const owners = ownersOn(r.accountId, r.effectiveDate);
    const paidBy = owners.length
      ? owners
      : (payers.get(r.id) ?? []).map((memberId, _i, all) => ({
          memberId,
          shareBps: Math.round(10000 / all.length),
        }));
    return {
      id: r.id,
      date: r.date,
      categoryId: r.categoryId,
      costMinor: -r.amountMinor,
      forMembers: explicit.get(r.id) ?? owners,
      paidBy,
    };
  });
}

async function loadPolicies(tx: Executor): Promise<SplitPolicyRow[]> {
  const rows = await tx.select().from(splitPolicies);
  return rows.map((r) => ({
    categoryId: r.categoryId,
    effectiveFrom: r.effectiveFrom,
    rule:
      r.method === null
        ? null
        : (splitRuleSchema.parse({ method: r.method, ...r.params }) as SplitRule),
  }));
}
