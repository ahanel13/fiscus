// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, households } from '@fiscus/db';
import {
  budgetGoalLines,
  type GoalMovedMonth,
  goalMoved,
  type HouseholdRanges,
  transactionDate,
} from '@fiscus/ledger';
import {
  addDays,
  addMonths,
  budgetMonthOf,
  budgetMonthStart,
  type ClaimAt,
  monthIndex,
  monthOf,
  paceOf,
  type PaceInput,
} from '@fiscus/shared';
import { eq, sql } from 'drizzle-orm';
import type { HouseholdContext } from '../households/household-context.js';

// What a savings goal's pace and history read (#135, #137; goals walkthrough G17, G18): its claims
// as they stood at each month's end, from fiscus_goal_claim_history() (0119), and what moved in to
// its accounts, as its budget line counts it (G4). Months are budget months (G10). Runs in the
// reader's context, so a newer member's window (#256) and the transactions they see apply.

/** The goal's fields these read. */
export interface PacedGoal {
  id: string;
  kind: 'save' | 'pay_down';
  memberId: string | null;
  targetMinor: number;
  targetDate: string | null;
  planMinor: number | null;
  archivedAt: Date | null;
}

/** The last day of a budget month. */
export const monthEnd = (month: string, startDay: number) =>
  addDays(budgetMonthStart(addMonths(`${month}-01`, 1).slice(0, 7), startDay), -1);

/** Where today is in this budget month, from 0 to 1. */
export function monthFraction(ranges: HouseholdRanges): number {
  const start = budgetMonthStart(ranges.budgetMonth, ranges.budgetStartDay);
  const end = monthEnd(ranges.budgetMonth, ranges.budgetStartDay);
  const days = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  return Math.min(1, (days(ranges.today) - days(start) + 1) / (days(end) - days(start) + 1));
}

/** The caller's history window, as a budget month (#256); null for all of it. */
export async function windowMonth(tx: Executor, startDay: number): Promise<string | null> {
  const { rows } = await tx.execute<{ from: string | null }>(
    sql`SELECT fiscus_history_from()::text AS "from"`,
  );
  const from = rows[0]?.from ?? null;
  return from ? budgetMonthOf(from, startDay) : null;
}

/** Each goal's first budget month: when it was made, or its first plan, whichever is first. */
export async function firstMonths(
  tx: Executor,
  ctx: HouseholdContext,
): Promise<Map<string, string>> {
  const lines = [
    ...(await budgetGoalLines(tx, ctx.householdId, null)),
    ...(await budgetGoalLines(tx, ctx.householdId, ctx.memberId)),
  ];
  return new Map(lines.map((l) => [l.id, l.fromMonth]));
}

/** What moved in to savings goals, month by month from `from` through this month (G4). */
export async function movedIn(
  tx: Executor,
  ctx: HouseholdContext,
  ranges: HouseholdRanges,
  from: string,
): Promise<Map<string, GoalMovedMonth>> {
  const [h] = await tx
    .select({ currency: households.baseCurrency })
    .from(households)
    .where(eq(households.id, ctx.householdId));
  const end = addDays(monthEnd(ranges.budgetMonth, ranges.budgetStartDay), 1);
  const date = transactionDate(ranges.dateBasis);
  const out = new Map<string, GoalMovedMonth>();
  for (const owner of [null, ctx.memberId]) {
    const lines = await budgetGoalLines(tx, ctx.householdId, owner);
    const moved = await goalMoved(
      tx,
      owner,
      lines.filter((l) => l.kind === 'save'),
      date,
      from,
      end,
      h!.currency,
      ranges.budgetStartDay,
    );
    for (const [month, m] of moved) {
      const into = out.get(month) ?? {
        byGoal: new Map<string, number>(),
        byGoalAccount: new Map<string, Map<string, number>>(),
        elsewhereMinor: 0,
      };
      for (const [g, v] of m.byGoal) into.byGoal.set(g, v);
      for (const [g, v] of m.byGoalAccount) into.byGoalAccount.set(g, v);
      into.elsewhereMinor += m.elsewhereMinor;
      out.set(month, into);
    }
  }
  return out;
}

/** A goal's claims as they stood when each day ended, from 0119. Days outside the window go. */
export async function claimsOn(
  tx: Executor,
  goalId: string,
  days: string[],
): Promise<Map<string, ClaimAt[]>> {
  const out = new Map<string, ClaimAt[]>();
  if (days.length === 0) return out;
  const { rows } = await tx.execute<{
    day: string;
    account_id: string;
    amount_minor: string | null;
    percent_bps: number | null;
    value_minor: string;
  }>(
    sql`SELECT day::text AS day, account_id, amount_minor, percent_bps, value_minor
        FROM fiscus_goal_claim_history(${goalId}::uuid, ${`{${days.join(',')}}`}::date[])`,
  );
  for (const r of rows) {
    out.set(r.day, [
      ...(out.get(r.day) ?? []),
      {
        accountId: r.account_id,
        amountMinor: r.amount_minor === null ? null : Number(r.amount_minor),
        percentBps: r.percent_bps,
        valueMinor: Number(r.value_minor),
      },
    ]);
  }
  return out;
}

/** A goal's moved figures by month, from what `movedIn` found. */
export const movedOf = (moved: Map<string, GoalMovedMonth>, goalId: string) =>
  new Map([...moved].map(([month, m]) => [month, m.byGoal.get(goalId) ?? 0]));

/** What a goal's status takes besides itself (G18): its pace, and the steady line to its date. */
export type PaceExtra = Pick<PaceInput, 'paceMinor' | 'steady'>;

/**
 * Each savings goal's pace and steady line, for the status in the list (#137): what moved in over
 * the last three months, or its plan while it's newer, and where it began (its claims as its first
 * month ended, or as the caller's window began).
 */
export async function paces(
  tx: Executor,
  ctx: HouseholdContext,
  ranges: HouseholdRanges,
  goals: PacedGoal[],
): Promise<Map<string, PaceExtra>> {
  const out = new Map<string, PaceExtra>();
  const saving = goals.filter((g) => g.kind === 'save' && !g.archivedAt);
  if (saving.length === 0) return out;
  const thisMonth = ranges.budgetMonth;
  const first = await firstMonths(tx, ctx);
  const moved = await movedIn(tx, ctx, ranges, monthOf(monthIndex(thisMonth) - 3));
  const window = await windowMonth(tx, ranges.budgetStartDay);
  const at = monthIndex(thisMonth) - 1 + monthFraction(ranges);
  for (const g of saving) {
    const firstMonth = first.get(g.id) ?? thisMonth;
    const { paceMinor } = paceOf({
      thisMonth,
      firstMonth,
      planMinor: g.planMinor,
      moved: movedOf(moved, g.id),
    });
    let steady: PaceExtra['steady'] = null;
    if (g.targetDate) {
      const start = await startOf(tx, g, firstMonth, window, ranges);
      steady = {
        fromMonth: start.month,
        fromMinor: Math.min(start.minor, g.targetMinor),
        toMonth: g.targetDate.slice(0, 7),
        toMinor: g.targetMinor,
        at,
      };
    }
    out.set(g.id, { paceMinor, steady });
  }
  return out;
}

/**
 * Where a goal began: what its claims were worth as its first month ended (or this month so far,
 * when that's now), or as the first month of the caller's window ended, for a newer member.
 */
export async function startOf(
  tx: Executor,
  g: PacedGoal,
  firstMonth: string,
  window: string | null,
  ranges: HouseholdRanges,
): Promise<{ month: string; minor: number }> {
  const month = window && g.memberId === null && window > firstMonth ? window : firstMonth;
  const day = month >= ranges.budgetMonth ? ranges.today : monthEnd(month, ranges.budgetStartDay);
  const claims = (await claimsOn(tx, g.id, [day])).get(day) ?? [];
  return { month, minor: claims.reduce((s, c) => s + c.valueMinor, 0) };
}
