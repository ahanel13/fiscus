// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, goalPlans, goals } from '@fiscus/db';
import { addMonths, firstDayOf, planFor } from '@fiscus/domain';
import { and, eq, gt, sql } from 'drizzle-orm';

/**
 * Sets a goal's plan, which is its budget line (G16), from `month` on, or for that month only,
 * as budget amounts change. The months before keep theirs. `goals.plan_minor` follows this
 * month's, unless `sync` is off because the caller just set it.
 */
export async function setGoalPlan(
  tx: Executor,
  goal: { id: string; householdId: string; planMinor: number | null },
  month: string,
  amountMinor: number,
  applyTo: 'month' | 'future',
  thisMonth: string,
  sync = true,
): Promise<{ before: number; planMinor: number | null }> {
  const rows = await tx.select().from(goalPlans).where(eq(goalPlans.goalId, goal.id));
  const plans = new Map(rows.map((r) => [r.month.slice(0, 7), r.amountMinor]));
  const before = planFor(month, plans);
  const put = async (m: string, amount: number) => {
    await tx
      .insert(goalPlans)
      .values({
        householdId: goal.householdId,
        goalId: goal.id,
        month: firstDayOf(m),
        amountMinor: amount,
      })
      .onConflictDoUpdate({
        target: [goalPlans.goalId, goalPlans.month],
        set: { amountMinor: amount },
      });
    plans.set(m, amount);
  };
  if (applyTo === 'month') {
    // The next month keeps what it had, by having its own.
    const next = addMonths(month, 1);
    if (!plans.has(next)) await put(next, planFor(next, plans));
  } else {
    await tx
      .delete(goalPlans)
      .where(and(eq(goalPlans.goalId, goal.id), gt(goalPlans.month, firstDayOf(month))));
    for (const m of [...plans.keys()]) if (m > month) plans.delete(m);
  }
  await put(month, amountMinor);
  const now = planFor(thisMonth, plans);
  const planMinor = now > 0 ? now : null;
  if (sync && planMinor !== goal.planMinor) {
    await tx
      .update(goals)
      .set({ planMinor, version: sql`${goals.version} + 1` })
      .where(eq(goals.id, goal.id));
  }
  return { before, planMinor };
}
