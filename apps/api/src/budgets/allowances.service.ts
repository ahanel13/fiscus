// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  allowances,
  budgets,
  categories,
  categoryGroups,
  type Executor,
  householdMembers,
} from '@fiscus/db';
import { firstDayOf } from '@fiscus/domain';
import { householdRanges } from '@fiscus/ledger';
import type { Allowance, setAllowanceSchema } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type SetInput = z.infer<typeof setAllowanceSchema>;

const monthOfDate = (d: string) => d.slice(0, 7);

/**
 * Allowances, or fun money (#114; budgeting walkthrough D15; ADR 0006 §7.4): a line in the
 * household's budget that funds a member's own, each month. Everyone sees the amounts, as they see
 * the household's budget (BUD-07); owners and members set them (BUD-08). How an allowance was
 * spent is only ever in its member's own budget, which only they see (D3).
 */
@Injectable()
export class AllowancesService {
  constructor(private readonly scope: HouseholdScope) {}

  /** Each member's allowance this month, and a change set for later. */
  async list(ctx: HouseholdContext): Promise<Allowance[]> {
    return this.scope.run(ctx, async (tx) => {
      const { budgetMonth } = await householdRanges(tx, ctx.householdId);
      return listAllowances(tx, ctx.householdId, budgetMonth);
    });
  }

  /**
   * Sets a member's allowance from a month on: this one, or a later one. Earlier months keep what
   * they had, and a change already set for after it gives way. Zero stops it.
   */
  async set(ctx: HouseholdContext, memberId: string, input: SetInput): Promise<Allowance[]> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (ctx.role !== 'owner' && ctx.role !== 'member') {
        throw problems.forbidden('Viewers can’t change the budget.');
      }
      const [member] = await tx
        .select({ id: householdMembers.id })
        .from(householdMembers)
        .where(
          and(
            eq(householdMembers.householdId, ctx.householdId),
            eq(householdMembers.id, memberId),
            isNull(householdMembers.leftAt),
          ),
        );
      if (!member) throw problems.notFound();
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(householdMembers)
        .where(
          and(eq(householdMembers.householdId, ctx.householdId), isNull(householdMembers.leftAt)),
        )) as [{ n: number }];
      if (n < 2) {
        throw new Problem(
          409,
          'one_person',
          'Allowances are for two or more of you',
          'On your own, all of it is your money already.',
        );
      }
      const [shared] = await tx
        .select({ id: budgets.id })
        .from(budgets)
        .where(and(eq(budgets.householdId, ctx.householdId), isNull(budgets.memberId)));
      if (!shared) {
        throw new Problem(
          409,
          'no_shared_budget',
          'An allowance is a line in the shared budget',
          'Start the shared budget first.',
        );
      }
      const [category] = await tx
        .select({ id: categories.id })
        .from(categories)
        .innerJoin(categoryGroups, eq(categoryGroups.id, categories.groupId))
        .where(
          and(
            eq(categories.id, input.categoryId),
            isNull(categories.archivedAt),
            sql`${categoryGroups.kind} NOT IN ('income', 'transfer')`,
          ),
        );
      if (!category) throw problems.notFound();
      // Budget months (#71): an allowance starts in the budget month today is in, or later.
      const { budgetMonth: thisMonth } = await householdRanges(tx, ctx.householdId);
      const month = input.fromMonth ?? thisMonth;
      if (month < thisMonth) {
        throw new Problem(
          422,
          'month_started',
          'An allowance changes from this month or a later one',
          'Earlier months keep what they had.',
        );
      }
      const day = firstDayOf(month);
      const mine = and(
        eq(allowances.householdId, ctx.householdId),
        eq(allowances.memberId, memberId),
      );
      const [before] = await tx
        .select({ amountMinor: allowances.amountMinor })
        .from(allowances)
        .where(and(mine, sql`${allowances.month} <= ${day}::date`))
        .orderBy(sql`${allowances.month} DESC`)
        .limit(1);
      // A change already set for this month or later gives way to this one.
      await tx.delete(allowances).where(and(mine, gte(allowances.month, day)));
      // Stopping one that isn't running before then leaves nothing to say.
      const [earlier] = await tx
        .select({ amountMinor: allowances.amountMinor })
        .from(allowances)
        .where(and(mine, lt(allowances.month, day)))
        .orderBy(sql`${allowances.month} DESC`)
        .limit(1);
      if (input.amountMinor > 0 || (earlier && earlier.amountMinor > 0)) {
        await tx.insert(allowances).values({
          householdId: ctx.householdId,
          memberId,
          month: day,
          categoryId: input.categoryId,
          amountMinor: input.amountMinor,
        });
      }
      await activity.record({
        action: input.amountMinor > 0 ? 'allowance.set' : 'allowance.stopped',
        targetType: 'allowance',
        targetId: memberId,
        metadata: { fromMonth: month, categoryId: input.categoryId },
        visibleToHousehold: true,
        changes: {
          before: { amountMinor: before?.amountMinor ?? 0 },
          after: { amountMinor: input.amountMinor },
        },
      });
      return listAllowances(tx, ctx.householdId, thisMonth);
    });
  }
}

/** Each member's allowance in `month`, and the next change after it, for members still here. */
async function listAllowances(
  tx: Executor,
  householdId: string,
  month: string,
): Promise<Allowance[]> {
  const rows = await tx
    .select({
      memberId: allowances.memberId,
      month: allowances.month,
      categoryId: allowances.categoryId,
      amountMinor: allowances.amountMinor,
    })
    .from(allowances)
    .innerJoin(
      householdMembers,
      and(
        eq(householdMembers.householdId, allowances.householdId),
        eq(householdMembers.id, allowances.memberId),
      ),
    )
    .where(and(eq(allowances.householdId, householdId), isNull(householdMembers.leftAt)))
    .orderBy(asc(householdMembers.joinedAt), asc(allowances.month));
  const byMember = new Map<string, typeof rows>();
  for (const r of rows) byMember.set(r.memberId, [...(byMember.get(r.memberId) ?? []), r]);
  const out: Allowance[] = [];
  for (const [memberId, list] of byMember) {
    const current = list.filter((r) => monthOfDate(r.month) <= month).at(-1);
    const next = list.find((r) => monthOfDate(r.month) > month);
    if (!next && (!current || current.amountMinor === 0)) continue;
    out.push({
      memberId,
      categoryId: (current?.amountMinor ? current : (next ?? current))!.categoryId,
      amountMinor: current?.amountMinor ?? 0,
      fromMonth: current ? monthOfDate(current.month) : monthOfDate(next!.month),
      next: next ? { month: monthOfDate(next.month), amountMinor: next.amountMinor } : null,
    });
  }
  return out;
}
