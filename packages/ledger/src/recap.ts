// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountOwners,
  accounts,
  budgets,
  categories,
  type Executor,
  householdMembers,
  householdProof,
  households,
  transactions,
} from '@fiscus/db';
import {
  type CategoryLimitsView,
  computeBudgetMonth,
  type FlexView,
  STRATEGY_REGISTRY,
  type ZeroBasedView,
} from '@fiscus/domain';
import {
  addDays,
  type RecapComingUp,
  type RecapWorthALook,
  type WeeklyRecap,
} from '@fiscus/shared';
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { accessLevels } from './access.js';
import { budgetActivity, loadBudgetDefinition } from './budget-activity.js';
import { householdRanges, transactionDate } from './ranges.js';
import { cardStatements, seriesOccurrences } from './recurring.js';

// The weekly recap (#128; bills walkthrough §8, D21): one person's week, built in their own
// context, so row-level security keeps it to what they can see (SYS-02). Sam's private card's
// purchases never reach Alex's recap. The api shows it on the dashboard; notifications (#125,
// #130) render it with renderWeeklyRecapEmail() and send it on Mondays.

/** How many things worth a look, at most. */
const WORTH_A_LOOK = 5;
/** How far back a late bill is still worth a look. */
const LATE_LOOKBACK_DAYS = 62;

export class RecapContextError extends Error {
  constructor() {
    super('A weekly recap is built in its reader’s own context, never system context (SYS-02)');
    this.name = 'RecapContextError';
  }
}

/**
 * One member's recap of the week from `weekStart` (seven days), with what's coming up from
 * `today`. Must run in that member's own context (household, member and user set, not system):
 * everything it reads is what row-level security lets them see.
 */
export async function buildWeeklyRecap(
  tx: Executor,
  { memberId, weekStart, today }: { memberId: string; weekStart: string; today: string },
): Promise<WeeklyRecap> {
  const { rows: ctx } = await tx.execute<{
    system: boolean;
    member: string | null;
    household: string | null;
  }>(
    sql`SELECT fiscus_is_system() AS system, fiscus_member()::text AS member,
               fiscus_household()::text AS household`,
  );
  if (!ctx[0] || ctx[0].system || ctx[0].member !== memberId || !ctx[0].household) {
    throw new RecapContextError();
  }
  const householdId = ctx[0].household;
  const weekEnd = addDays(weekStart, 6);
  const [hh] = await tx
    .select({ name: households.name, currency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, householdId));
  const members = await tx
    .select({
      id: householdMembers.id,
      name: householdMembers.displayName,
      role: householdMembers.role,
    })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), isNull(householdMembers.leftAt)));
  const me = members.find((m) => m.id === memberId)!;
  const nameOf = (id: string) => members.find((m) => m.id === id)?.name ?? null;
  const currency = hh!.currency;
  const ranges = await householdRanges(tx, householdId);
  const date = transactionDate(ranges.dateBasis);
  const levels = await accessLevels(tx);

  // ── Spending: money out, not transfers, excluded ones or split parents (as cash flow counts it).
  const spending = and(
    isNull(transactions.deletedAt),
    eq(transactions.hasSplits, false),
    eq(transactions.excluded, false),
    eq(transactions.currency, currency),
    lt(transactions.amountMinor, 0),
    sql`NOT EXISTS (
      SELECT 1 FROM categories c JOIN category_groups g ON g.id = c.group_id
      WHERE c.id = ${transactions.categoryId} AND g.kind = 'transfer')`,
  );
  const spentBetween = async (from: string, to: string) => {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(-sum(${transactions.amountMinor}), 0)::text` })
      .from(transactions)
      .where(and(spending, gte(date, from), lte(date, to)));
    return Number(row?.total ?? 0);
  };
  const spentMinor = await spentBetween(weekStart, weekEnd);
  const [first] = await tx
    .select({ d: sql<string | null>`min(${date})::text` })
    .from(transactions)
    .where(spending);
  const usualFrom = addDays(weekStart, -28);
  const usualMinor =
    first?.d && first.d <= usualFrom
      ? Math.round((await spentBetween(usualFrom, addDays(weekStart, -1))) / 4)
      : null;

  const worth: RecapWorthALook[] = [];

  // ── This month's budgets you can see: the household's, and your own.
  const month = today.slice(0, 7);
  const monthEnd = addDays(
    new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1))
      .toISOString()
      .slice(0, 10),
    -1,
  );
  const names = new Map(
    (await tx.select({ id: categories.id, name: categories.name }).from(categories)).map((c) => [
      c.id,
      c.name,
    ]),
  );
  let left: number | null = null;
  const over = new Map<string, number>();
  for (const row of await tx.select().from(budgets).orderBy(asc(budgets.createdAt))) {
    const starts = row.startsMonth.slice(0, 7);
    if (starts > month) continue;
    const scope = row.memberId ? 'mine' : 'household';
    const definition = await loadBudgetDefinition(tx, row);
    const activity = await budgetActivity(tx, { householdId, memberId }, scope, starts, month);
    const out = computeBudgetMonth(definition, month, activity, STRATEGY_REGISTRY);
    const overs: [string, number][] = [];
    if (out.kind === 'flex') {
      const v = out.view as FlexView;
      left =
        (left ?? 0) +
        v.flexible.leftMinor +
        v.fixed.reduce((s, f) => s + Math.max(0, f.leftMinor), 0);
      for (const f of v.fixed) if (f.leftMinor < 0) overs.push([f.categoryId, -f.leftMinor]);
    } else if (out.kind === 'zero_based') {
      const v = out.view as ZeroBasedView;
      left = (left ?? 0) + v.totals.availableMinor;
      for (const r of v.rows) if (r.leftMinor < 0) overs.push([r.categoryId, -r.leftMinor]);
    } else {
      const v = out.view as CategoryLimitsView;
      left = (left ?? 0) + v.totals.leftMinor;
      for (const r of v.rows) if (r.leftMinor < 0) overs.push([r.categoryId, -r.leftMinor]);
    }
    for (const [id, by] of overs) over.set(id, Math.max(over.get(id) ?? 0, by));
  }
  for (const [id, overMinor] of [...over].sort((a, b) => b[1] - a[1])) {
    worth.push({ kind: 'over_budget', category: names.get(id) ?? 'A category', overMinor });
  }

  // ── Net worth: every account you see that counts toward it, at the week's end and the start.
  const counted = (
    await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.includeInNetWorth, true), eq(accounts.currency, currency)))
  )
    .map((a) => a.id)
    .filter((id) => levels.has(id));
  const worthOn = async (day: string) => {
    const { rows } = await tx.execute<{ net: string }>(sql`
      SELECT coalesce(sum(s.balance_minor), 0)::text AS net
      FROM unnest(${sql.param(counted)}::uuid[]) AS w(account_id)
      JOIN accounts a ON a.id = w.account_id
      JOIN households h ON h.id = a.household_id
      JOIN LATERAL (
        SELECT b.balance_minor FROM balance_snapshots b
        WHERE b.account_id = w.account_id AND b.as_of <= ${day}::date
        ORDER BY b.as_of DESC LIMIT 1
      ) s ON true
      WHERE a.closed_at IS NULL OR ${day}::date < (a.closed_at AT TIME ZONE h.timezone)::date`);
    return Number(rows[0]?.net ?? 0);
  };
  const netWorth = counted.length
    ? await (async () => {
        const end = await worthOn(weekEnd);
        return { netWorthMinor: end, changeMinor: end - (await worthOn(addDays(weekStart, -1))) };
      })()
    : null;

  // ── Coming up this week: bills, paychecks and card statements; late bills are worth a look.
  const horizon = addDays(today, 6);
  const comingUp: RecapComingUp[] = [];
  const late: RecapWorthALook[] = [];
  for (const s of await seriesOccurrences(tx, {
    start: today,
    end: horizon,
    lateFrom: addDays(today, -LATE_LOOKBACK_DAYS),
    today,
  })) {
    if (s.series.endedOn !== null && s.series.endedOn < today) continue;
    for (const o of s.occurrences) {
      if (o.status === 'late') {
        late.push({ kind: 'late', name: o.name, due: o.due });
      } else if (o.status === 'due' && o.due >= today && o.kind !== 'transfer') {
        const someoneElse =
          o.kind !== 'income' && o.shared && o.memberIds[0] && o.memberIds[0] !== memberId
            ? nameOf(o.memberIds[0])
            : null;
        comingUp.push({
          due: o.due,
          name: o.name,
          kind: o.kind,
          amountMinor: o.expectedMinor,
          about: true,
          lookAfter: someoneElse,
        });
      }
    }
  }
  for (const st of await cardStatements(tx, { from: today, to: horizon, today })) {
    if (st.paid === 'paid' || st.paid === 'minimum') continue;
    comingUp.push({
      due: st.due,
      name: `${st.accountName} statement`,
      kind: 'statement',
      amountMinor: -(st.owedMinor - st.paidSoFarMinor),
      about: false,
      lookAfter: null,
    });
  }
  comingUp.sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));

  // ── The week's biggest purchase. Its account only when you see the account (F1).
  const [biggest] = await tx
    .select({
      name: transactions.displayName,
      amountMinor: transactions.amountMinor,
      accountId: transactions.accountId,
      date: sql<string>`${date}::text`,
    })
    .from(transactions)
    .where(and(spending, gte(date, weekStart), lte(date, weekEnd)))
    .orderBy(asc(transactions.amountMinor))
    .limit(1);
  if (biggest) {
    const level = levels.get(biggest.accountId);
    const shown = level === 'owner' || level === 'full' || level === 'view_only';
    const [account] = shown
      ? await tx
          .select({ name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, biggest.accountId))
      : [];
    worth.push({
      kind: 'biggest_purchase',
      name: biggest.name,
      amountMinor: biggest.amountMinor,
      account: account?.name ?? null,
      date: biggest.date,
    });
  }
  worth.push(...late);

  // ── Your review queue: needing review, in accounts where you can categorize (#44).
  const reviewable = [...levels].filter(([, l]) => l === 'owner' || l === 'full').map(([id]) => id);
  const [review] =
    me.role === 'viewer' || reviewable.length === 0
      ? [{ n: 0 }]
      : await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(transactions)
          .where(
            and(
              eq(transactions.reviewStatus, 'needs_review'),
              isNull(transactions.deletedAt),
              eq(transactions.hasSplits, false),
              inArray(transactions.accountId, reviewable),
            ),
          );

  // ── Whose money it covers (D21): "yours and ours", or "yours"; nothing for someone on their own.
  const owners = await tx.select().from(accountOwners);
  const seen = [...levels].filter(([, l]) => l === 'owner' || l === 'full' || l === 'view_only');
  const onlyYours = seen.every(([id]) => {
    const o = owners.filter((x) => x.accountId === id);
    return o.length === 1 && o[0]!.memberId === memberId;
  });
  const proof = await householdProof(tx, householdId);
  const worthALook = worth.slice(0, WORTH_A_LOOK);

  return {
    householdName: hh!.name,
    memberName: me.name,
    currency,
    weekStart,
    weekEnd,
    today,
    sees: members.length <= 1 ? null : onlyYours ? 'yours' : 'yours_and_ours',
    spending: { spentMinor, usualMinor },
    budgets: left === null ? null : { month, leftMinor: left, daysLeft: daysFrom(today, monthEnd) },
    netWorth,
    comingUp,
    worthALook,
    toReview: review?.n ?? 0,
    history: { seq: proof.ok ? proof.head.seq : 0, hash: proof.ok ? proof.head.hash : '' },
    quiet: spentMinor === 0 && comingUp.length === 0 && worthALook.length === 0,
  };
}

/** Days from `from` to `to`, both included. */
const daysFrom = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

/** The latest whole week before `today`, as the household counts weeks (its week start). */
export function lastWeekStart(today: string, firstDay: number): string {
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const back = (weekday - firstDay + 7) % 7;
  return addDays(today, -back - 7);
}
