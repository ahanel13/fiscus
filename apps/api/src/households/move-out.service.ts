// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type Executor,
  householdMembers,
  HouseholdKeyStore,
  households,
  type MemberMoveBalance,
  memberMoves,
} from '@fiscus/db';
import type { MoveOutPlan } from '@fiscus/domain';
import { buildSharedCosts, planMemberMoveOut } from '@fiscus/ledger';
import {
  type CurrentUser,
  MEMBER_COLORS,
  MEMBER_MOVE_STEPS,
  type MemberMove,
  type MoveOutPreview,
  type StartMoveOut,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { violatedConstraint } from '../common/db-errors.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

// Moving out (#253, ADR 0012 step 3, permissions HH-20, budgeting walkthrough D37). The preview
// and the move share one plan (@fiscus/domain planMoveOut). Starting it makes the new household,
// with the person moving as its owner, and the move in it, in one transaction; the worker then
// moves their data across, in its maintenance role. Nobody can stop it, and nobody but the person
// moving sees where they went (ADR 0012 §Departures item 10).

const blocked = (plan: MoveOutPlan) =>
  new Problem(
    409,
    'move_out_blocked',
    'You can’t move out yet',
    undefined,
    undefined,
    {},
    { blockers: plan.blockers },
  );
const alreadyMoving = () => new Problem(409, 'already_moving', 'You’re already moving out');

/** This month, `YYYY-MM`, in a time zone. */
const monthIn = (timeZone: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .format(now)
    .slice(0, 7);

@Injectable()
export class MoveOutService {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly keys: HouseholdKeyStore,
  ) {}

  /** HH-20: what would move, stay and be copied. Only ever about you. */
  async preview(ctx: HouseholdContext): Promise<MoveOutPreview> {
    return this.scope.run(ctx, async (tx) => {
      const { plan, input } = await planMemberMoveOut(tx, ctx.householdId, ctx.memberId);
      const [h] = await tx.select().from(households).where(eq(households.id, ctx.householdId));
      if (!h) throw problems.notFound();
      const names = new Map(input.members.map((m) => [m.id, m.displayName]));
      return {
        blockers: plan.blockers,
        moving: await this.#moving(tx, ctx.memberId),
        moves: {
          accounts: plan.accounts,
          connections: plan.connections.map((c) => ({
            id: c.id,
            institutionName: c.institutionName,
            outcome: c.outcome,
            accountCount: c.accountIds.length,
          })),
          budget: plan.budgetId !== null,
          goals: plan.goals,
          rules: plan.rules,
          forOthers: plan.forOthers,
        },
        stays: {
          jointAccounts: plan.jointAccounts.map((a) => ({
            id: a.id,
            name: a.name,
            relink: a.relink,
            owners: a.owners.map((o) => ({ ...o, displayName: names.get(o.memberId) ?? '' })),
          })),
          attributedElsewhere: plan.attributedElsewhere,
          goalsLeft: plan.goalsLeft,
          rulesLeft: plan.rulesLeft,
          claimsEnding: plan.claimsEnding.length,
        },
        copied: {
          categories: plan.categories.map((c) => ({
            id: c.id,
            name: c.name,
            groupName: c.groupName,
          })),
          tags: plan.tags.map((t) => ({ id: t.id, name: t.name })),
        },
        settleUp: plan.blockers.includes('dependent')
          ? []
          : await this.#settleUp(tx, ctx, h.timezone, names),
        household: { name: h.name, baseCurrency: h.baseCurrency, timezone: h.timezone },
      };
    });
  }

  /**
   * HH-20: starts moving out. Settle-up is worked out first and kept with the move; then the new
   * household is made, its settings copied from this one, and the worker takes it from there.
   */
  async start(
    ctx: HouseholdContext,
    user: CurrentUser,
    input: StartMoveOut,
  ): Promise<{ householdId: string; moveId: string }> {
    const before = await this.scope.run(ctx, async (tx) => {
      const { plan, input: read } = await planMemberMoveOut(tx, ctx.householdId, ctx.memberId);
      if (plan.blockers.length > 0) throw blocked(plan);
      if (await this.#moving(tx, ctx.memberId)) throw alreadyMoving();
      const [h] = await tx.select().from(households).where(eq(households.id, ctx.householdId));
      const [me] = await tx
        .select({ displayName: householdMembers.displayName })
        .from(householdMembers)
        .where(eq(householdMembers.id, ctx.memberId));
      const names = new Map(read.members.map((m) => [m.id, m.displayName]));
      return {
        household: h!,
        displayName: me!.displayName,
        balances: await this.#settleUp(tx, ctx, h!.timezone, names),
      };
    });
    const h = before.household;
    const id = uuidv7();
    const moveId = uuidv7();
    await this.scope
      .join(
        id,
        user.id,
        async (tx) => {
          const { rows } = await tx.execute<{ member_id: string }>(
            sql`SELECT fiscus_create_household(${input.name}, ${h.baseCurrency}, ${h.timezone},
                  ${before.displayName}, ${MEMBER_COLORS[0]!}) AS member_id`,
          );
          return { userId: user.id, memberId: rows[0]!.member_id };
        },
        async (tx, activity, { memberId }) => {
          // Its settings start as copies of the household being left (ADR 0012 step 3.3).
          await tx
            .update(households)
            .set({
              weekStart: h.weekStart,
              fiscalYearStartMonth: h.fiscalYearStartMonth,
              budgetMonthStartDay: h.budgetMonthStartDay,
              dateBasis: h.dateBasis,
              financeStyle: h.financeStyle,
              categorizeMarksReviewed: h.categorizeMarksReviewed,
              reviewScope: h.reviewScope,
              cleanMerchantNames: h.cleanMerchantNames,
            })
            .where(eq(households.id, id));
          await this.keys.createForHousehold(id, tx);
          await tx.execute(sql`SELECT fiscus_seed_default_categories(${id})`);
          await activity.record({
            action: 'household.created',
            targetType: 'household',
            targetId: id,
          });
          await tx.insert(memberMoves).values({
            id: moveId,
            householdId: id,
            memberId,
            fromHouseholdId: ctx.householdId,
            fromMemberId: ctx.memberId,
            finalBalances: before.balances,
          });
          await activity.record({
            action: 'member_move.started',
            targetType: 'member_move',
            targetId: moveId,
          });
        },
      )
      .catch((err: unknown) => {
        if (violatedConstraint(err) === 'member_moves_open') throw alreadyMoving();
        throw err;
      });
    return { householdId: id, moveId };
  }

  /** In the new household: how the move into it is going. */
  async moveIn(ctx: HouseholdContext): Promise<MemberMove> {
    return this.scope.run(ctx, async (tx) => {
      const [row] = await tx
        .select()
        .from(memberMoves)
        .where(eq(memberMoves.householdId, ctx.householdId))
        .orderBy(desc(memberMoves.createdAt))
        .limit(1);
      if (!row) throw problems.notFound();
      return {
        id: row.id,
        status: row.status,
        step: row.step,
        steps: MEMBER_MOVE_STEPS,
        errorCode: row.errorCode,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        finalBalances: row.finalBalances,
      };
    });
  }

  async #moving(tx: Executor, memberId: string): Promise<{ householdId: string } | null> {
    const { rows } = await tx.execute<{ household_id: string | null }>(
      sql`SELECT fiscus_open_member_move(${memberId}) AS household_id`,
    );
    const householdId = rows[0]?.household_id ?? null;
    return householdId ? { householdId } : null;
  }

  /** Your balance with each member now, from your own Shared costs (SHR-04): nobody else's. */
  async #settleUp(
    tx: Executor,
    ctx: HouseholdContext,
    timeZone: string,
    names: Map<string, string>,
  ): Promise<MemberMoveBalance[]> {
    const costs = await buildSharedCosts(tx, {
      memberId: ctx.memberId,
      month: monthIn(timeZone),
    });
    return costs.balances
      .filter((b) => b.amountMinor !== 0)
      .map((b) => ({
        memberId: b.memberId,
        displayName: names.get(b.memberId) ?? '',
        amountMinor: b.amountMinor,
        currency: costs.currency,
      }));
  }
}
