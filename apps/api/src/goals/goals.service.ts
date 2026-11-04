// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountOwners,
  accounts,
  type Executor,
  goalClaimEvents,
  goalClaims,
  goals,
  householdMembers,
  households,
} from '@fiscus/db';
import { householdRanges } from '@fiscus/ledger';
import {
  type createGoalSchema,
  formatMoney,
  type Goal,
  type GoalAccount,
  type GoalClaim,
  type GoalShortfall,
  type GoalsOverview,
  type updateGoalSchema,
} from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { z } from 'zod';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import type { HouseholdActivity } from '../households/household-scope.js';
import { HouseholdScope } from '../households/household-scope.js';

type GoalRow = typeof goals.$inferSelect;
type ClaimRow = typeof goalClaims.$inferSelect;
type ClaimInput = { amountMinor?: number | undefined; percentBps?: number | undefined };

/** A claim's worth, from fiscus_goal_claim_values() (0084): balances stay in the database. */
interface ClaimValue {
  claim_id: string;
  goal_id: string;
  account_id: string;
  value_minor: string;
  short_minor: string;
  account_name: string | null;
  owner_ids: string[] | null;
}

/**
 * Goals (GOAL-01–07; goals walkthrough): savings goals that draw on accounts by claims (G2). The
 * household's are everyone's, your own are yours alone (row-level security, 0084); claims are set
 * by the account's owners (G7), never beyond what's free (G3). Each claim change is kept (G17).
 */
@Injectable()
export class GoalsService {
  constructor(private readonly scope: HouseholdScope) {}

  /** Every goal you see, the accounts you can claim, and any shortfall (walkthrough §1, §5). */
  async overview(ctx: HouseholdContext): Promise<GoalsOverview> {
    return this.scope.run(ctx, async (tx) => {
      const { today } = await householdRanges(tx, ctx.householdId);
      const rows = await tx.select().from(goals).orderBy(asc(goals.position), asc(goals.createdAt));
      const claims = rows.length
        ? await tx
            .select()
            .from(goalClaims)
            .where(
              inArray(
                goalClaims.goalId,
                rows.map((g) => g.id),
              ),
            )
        : [];
      const values = await claimValues(tx);
      const mine = await ownedAccounts(tx, ctx);
      const owned = new Set(mine.map((a) => a.accountId));
      const goalList = rows.map((g) => present(ctx, g, claims, values, owned, today.slice(0, 7)));
      return {
        goals: goalList,
        accounts: mine,
        shortfalls: shortfalls(rows, claims, values, owned),
        totals: {
          savedMinor: goalList.reduce((s, g) => s + g.progressMinor, 0),
          plannedMinor: goalList.reduce((s, g) => s + (g.planMinor ?? 0), 0),
          unclaimedMinor: mine.reduce((s, a) => s + a.unclaimedMinor, 0),
        },
        canCreate: ctx.role !== 'viewer',
      };
    });
  }

  /** New goal (walkthrough §2): last in priority, with its claims (G2, G3). */
  async create(ctx: HouseholdContext, input: z.infer<typeof createGoalSchema>): Promise<Goal> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (ctx.role === 'viewer') {
        throw problems.forbidden(
          'Viewers don’t have goals of their own, or change the household’s.',
        );
      }
      const scope =
        input.scope ?? ((await activeMembers(tx, ctx.householdId)) > 1 ? 'household' : 'mine');
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${goals.position}) + 1, 0)::int` })
        .from(goals);
      const [row] = await tx
        .insert(goals)
        .values({
          householdId: ctx.householdId,
          memberId: scope === 'mine' ? ctx.memberId : null,
          name: input.name,
          targetMinor: input.targetMinor,
          targetDate: input.targetDate ?? null,
          planMinor: input.planMinor ?? null,
          position: last?.n ?? 0,
        })
        .returning();
      for (const c of input.claims) await setClaim(tx, ctx, row!, c.accountId, c);
      await record(activity, row!, 'goal.created', {
        name: row!.name,
        targetMinor: row!.targetMinor,
        accounts: input.claims.length,
      });
      return this.#one(tx, ctx, row!.id);
    });
  }

  /** Name, target, date and plan (GOAL-03/04): first save wins. */
  async update(
    ctx: HouseholdContext,
    goalId: string,
    patch: z.infer<typeof updateGoalSchema>,
    baseVersion: number,
  ): Promise<Goal> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findGoal(tx, goalId);
      checkCanEdit(ctx, row);
      if (row.version !== baseVersion) {
        throw new Problem(
          409,
          'edit_conflict',
          'Someone else changed this goal first',
          'Look again, then make your change.',
        );
      }
      const [updated] = await tx
        .update(goals)
        .set({ ...patch, version: sql`${goals.version} + 1` })
        .where(eq(goals.id, goalId))
        .returning();
      await record(activity, updated!, 'goal.changed', { name: updated!.name, ...patch });
      return this.#one(tx, ctx, goalId);
    });
  }

  /** Deletes a goal, its claims and history; the money stays where it is. */
  async remove(ctx: HouseholdContext, goalId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const row = await findGoal(tx, goalId);
      checkCanEdit(ctx, row);
      await tx.delete(goals).where(eq(goals.id, goalId));
      await record(activity, row, 'goal.deleted', { name: row.name });
    });
  }

  /** Claims an account, or changes a claim (GOAL-05): the account's owners, within what's free. */
  async claim(
    ctx: HouseholdContext,
    goalId: string,
    accountId: string,
    claim: ClaimInput,
  ): Promise<Goal> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findGoal(tx, goalId);
      if (ctx.role === 'viewer') throw problems.forbidden('Viewers don’t claim accounts.');
      await setClaim(tx, ctx, row, accountId, claim);
      await record(activity, row, 'goal.claim_set', { name: row.name, ...claim });
      return this.#one(tx, ctx, goalId);
    });
  }

  /** Takes a claim off (GOAL-05): the money stays in the account, unclaimed. */
  async release(ctx: HouseholdContext, goalId: string, accountId: string): Promise<Goal> {
    return this.scope.run(ctx, async (tx, activity) => {
      const row = await findGoal(tx, goalId);
      const [there] = await tx
        .select({ id: goalClaims.id })
        .from(goalClaims)
        .where(and(eq(goalClaims.goalId, goalId), eq(goalClaims.accountId, accountId)));
      if (!there) throw problems.notFound();
      const [gone] = await tx
        .delete(goalClaims)
        .where(and(eq(goalClaims.goalId, goalId), eq(goalClaims.accountId, accountId)))
        .returning();
      if (!gone) {
        throw problems.forbidden('Only the account’s owners take its claims off.');
      }
      await event(tx, ctx, gone, 'released', null);
      await record(activity, row, 'goal.claim_released', { name: row.name });
      return this.#one(tx, ctx, goalId);
    });
  }

  /** Priority (G19): every goal you see, highest first. */
  async order(ctx: HouseholdContext, ids: string[]): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      if (ctx.role === 'viewer') throw problems.forbidden('Viewers can’t change goals.');
      const seen = await tx.select({ id: goals.id }).from(goals);
      if (seen.length !== ids.length || seen.some((g) => !ids.includes(g.id))) {
        throw new Problem(422, 'every_goal', 'List every goal once, in the order you want');
      }
      for (const [position, id] of ids.entries()) {
        await tx.update(goals).set({ position }).where(eq(goals.id, id));
      }
      await activity.record({
        action: 'goal.reordered',
        targetType: 'goal',
        metadata: { goals: ids.length },
        visibleToHousehold: true,
      });
    });
  }

  /**
   * A shortfall's choice (G3, G19): the account's owners take it off fixed claims on goals they
   * see, by as much as it's short and no more.
   */
  async giveWay(
    ctx: HouseholdContext,
    accountId: string,
    take: { goalId: string; amountMinor: number }[],
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const [own] = await accountClaimed(tx, accountId);
      if (!own) throw problems.forbidden('Only the account’s owners choose which goal gives way.');
      const short = Math.max(
        0,
        ...(await claimValues(tx))
          .filter((v) => v.account_id === accountId)
          .map((v) => Number(v.short_minor)),
      );
      const total = take.reduce((s, t) => s + t.amountMinor, 0);
      if (short === 0 || total > short) {
        throw new Problem(
          422,
          'more_than_short',
          short === 0 ? 'Nothing’s short on this account' : 'That’s more than it’s short',
        );
      }
      for (const t of take) {
        const [c] = await tx
          .select()
          .from(goalClaims)
          .where(and(eq(goalClaims.goalId, t.goalId), eq(goalClaims.accountId, accountId)));
        if (!c || c.amountMinor === null || c.amountMinor < t.amountMinor) {
          throw new Problem(
            422,
            'not_that_much',
            'A goal gives way from its fixed claim, and no more than it has',
          );
        }
        const left = c.amountMinor - t.amountMinor;
        const [after] =
          left === 0
            ? await tx.delete(goalClaims).where(eq(goalClaims.id, c.id)).returning()
            : await tx
                .update(goalClaims)
                .set({ amountMinor: left })
                .where(eq(goalClaims.id, c.id))
                .returning();
        await event(tx, ctx, c, 'gave_way', left === 0 ? null : after!);
        const goal = await findGoal(tx, t.goalId);
        await record(activity, goal, 'goal.gave_way', {
          name: goal.name,
          amountMinor: t.amountMinor,
        });
      }
    });
  }

  async #one(tx: Executor, ctx: HouseholdContext, goalId: string): Promise<Goal> {
    const row = await findGoal(tx, goalId);
    const claims = await tx.select().from(goalClaims).where(eq(goalClaims.goalId, goalId));
    const owned = new Set((await ownedAccounts(tx, ctx)).map((a) => a.accountId));
    const { today } = await householdRanges(tx, ctx.householdId);
    return present(ctx, row, claims, await claimValues(tx), owned, today.slice(0, 7));
  }
}

async function claimValues(tx: Executor): Promise<ClaimValue[]> {
  const { rows } = await tx.execute<ClaimValue & Record<string, unknown>>(
    sql`SELECT * FROM fiscus_goal_claim_values()`,
  );
  return rows;
}

async function accountClaimed(tx: Executor, accountId: string) {
  const { rows } = await tx.execute<{
    balance_minor: string;
    fixed_minor: string;
    percent_bps: number;
  }>(sql`SELECT * FROM fiscus_account_claimed(${accountId}::uuid)`);
  return rows.map((r) => ({
    balance: Number(r.balance_minor),
    fixed: Number(r.fixed_minor),
    percentBps: r.percent_bps,
  }));
}

/** What claims take of a balance: fixed amounts, then percentages of it, never more than it. */
const claimedOf = (balance: number, fixed: number, percentBps: number) =>
  Math.min(balance, fixed + Math.floor((balance * percentBps) / 10_000));

/** Accounts you own that savings goals can draw on: bank and investment accounts, open. */
async function ownedAccounts(tx: Executor, ctx: HouseholdContext): Promise<GoalAccount[]> {
  const rows = await tx
    .select({ id: accounts.id, name: accounts.name, type: accounts.type })
    .from(accounts)
    .innerJoin(
      accountOwners,
      and(eq(accountOwners.accountId, accounts.id), eq(accountOwners.memberId, ctx.memberId)),
    )
    .where(and(isNull(accounts.closedAt), inArray(accounts.type, ['depository', 'investment'])))
    .orderBy(asc(accounts.name));
  const out: GoalAccount[] = [];
  for (const r of rows) {
    const [c] = await accountClaimed(tx, r.id);
    if (!c) continue;
    const claimed = claimedOf(c.balance, c.fixed, c.percentBps);
    out.push({
      accountId: r.id,
      name: r.name,
      type: r.type as GoalAccount['type'],
      balanceMinor: c.balance,
      claimedMinor: claimed,
      unclaimedMinor: Math.max(0, c.balance - claimed),
    });
  }
  return out;
}

/**
 * Sets a goal's claim on an account (G2), keeping its history (G17). Only an owner can (the
 * database refuses anyone else, G7), on a bank or investment account, and never beyond the
 * balance less every other goal's claims (G3).
 */
async function setClaim(
  tx: Executor,
  ctx: HouseholdContext,
  goal: GoalRow,
  accountId: string,
  claim: ClaimInput,
): Promise<void> {
  const [own] = await accountClaimed(tx, accountId);
  const [account] = own
    ? await tx
        .select({ name: accounts.name, type: accounts.type, closedAt: accounts.closedAt })
        .from(accounts)
        .where(eq(accounts.id, accountId))
    : [];
  if (!own || !account) {
    throw problems.forbidden('Only an account’s owners can claim it for a goal.');
  }
  if ((account.type !== 'depository' && account.type !== 'investment') || account.closedAt) {
    throw new Problem(
      422,
      'not_a_savings_account',
      'A goal draws on open bank or investment accounts',
    );
  }
  const [existing] = await tx
    .select()
    .from(goalClaims)
    .where(and(eq(goalClaims.goalId, goal.id), eq(goalClaims.accountId, accountId)));
  const fixedOther = own.fixed - (existing?.amountMinor ?? 0);
  const percentOther = own.percentBps - (existing?.percentBps ?? 0);
  const free = own.balance - claimedOf(own.balance, fixedOther, percentOther);
  const wants =
    claim.amountMinor !== undefined
      ? claim.amountMinor
      : Math.floor((own.balance * claim.percentBps!) / 10_000);
  if (wants > free || percentOther + (claim.percentBps ?? 0) > 10_000) {
    const [h] = await tx
      .select({ currency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, ctx.householdId));
    throw new Problem(
      422,
      'claim_too_large',
      'That’s more than the account has free',
      `${account.name} has ${formatMoney(Math.max(0, free), h!.currency)} free for this goal.`,
    );
  }
  const values = { amountMinor: claim.amountMinor ?? null, percentBps: claim.percentBps ?? null };
  const [after] = existing
    ? await tx.update(goalClaims).set(values).where(eq(goalClaims.id, existing.id)).returning()
    : await tx
        .insert(goalClaims)
        .values({ householdId: ctx.householdId, goalId: goal.id, accountId, ...values })
        .returning();
  // Raising a claim earmarks more of what's there (G11); lowering it, or switching, changes it.
  const before = existing
    ? (existing.amountMinor ?? Math.floor((own.balance * existing.percentBps!) / 10_000))
    : 0;
  await event(
    tx,
    ctx,
    existing ?? null,
    !existing || wants > before ? 'earmarked' : 'changed',
    after!,
    {
      accountId,
      goalId: goal.id,
    },
  );
}

async function event(
  tx: Executor,
  ctx: HouseholdContext,
  before: ClaimRow | null,
  reason: (typeof goalClaimEvents.$inferInsert)['reason'],
  after: ClaimRow | null,
  ids?: { accountId: string; goalId: string },
): Promise<void> {
  await tx.insert(goalClaimEvents).values({
    id: uuidv7(),
    householdId: ctx.householdId,
    goalId: ids?.goalId ?? before?.goalId ?? after!.goalId,
    accountId: ids?.accountId ?? before?.accountId ?? after!.accountId,
    reason,
    memberId: ctx.memberId,
    amountBeforeMinor: before?.amountMinor ?? null,
    amountAfterMinor: after?.amountMinor ?? null,
    percentBeforeBps: before?.percentBps ?? null,
    percentAfterBps: after?.percentBps ?? null,
  });
}

/** The api's goal: its claims with what they're worth, progress, and what makes its date. */
function present(
  ctx: HouseholdContext,
  g: GoalRow,
  claims: ClaimRow[],
  values: ClaimValue[],
  owned: Set<string>,
  thisMonth: string,
): Goal {
  const worth = new Map(values.map((v) => [v.claim_id, v]));
  const list: GoalClaim[] = claims
    .filter((c) => c.goalId === g.id)
    .map((c) => {
      const v = worth.get(c.id);
      return {
        accountId: c.accountId,
        accountName: v?.account_name ?? null,
        ownerIds: v?.owner_ids ?? [],
        amountMinor: c.amountMinor,
        percentBps: c.percentBps,
        valueMinor: Number(v?.value_minor ?? 0),
        shortMinor: Number(v?.short_minor ?? 0),
        yours: owned.has(c.accountId),
      };
    });
  const progress = list.reduce((s, c) => s + c.valueMinor, 0);
  const done = progress >= g.targetMinor;
  let toMakeDate: number | null = null;
  if (g.targetDate && !done) {
    const [y, m] = g.targetDate.split('-').map(Number) as [number, number];
    const [ty, tm] = thisMonth.split('-').map(Number) as [number, number];
    const months = (y - ty) * 12 + (m - tm) + 1;
    if (months >= 1) toMakeDate = Math.ceil((g.targetMinor - progress) / months);
  }
  return {
    id: g.id,
    scope: g.memberId ? 'mine' : 'household',
    kind: 'save',
    name: g.name,
    targetMinor: g.targetMinor,
    targetDate: g.targetDate,
    planMinor: g.planMinor,
    position: g.position,
    progressMinor: progress,
    // A fixed claim on an account that's short leaves the goal short too (G3).
    shortMinor: list
      .filter((c) => c.amountMinor !== null)
      .reduce((s, c) => s + Math.min(c.shortMinor, c.amountMinor!), 0),
    toMakeDateMinor: toMakeDate,
    done,
    claims: list,
    canEdit: canEdit(ctx, g),
    version: g.version,
    createdAt: g.createdAt.toISOString(),
  };
}

/** Accounts below their fixed claims (G3), with what priority suggests giving way (G19). */
function shortfalls(
  rows: GoalRow[],
  claims: ClaimRow[],
  values: ClaimValue[],
  owned: Set<string>,
): GoalShortfall[] {
  const byAccount = new Map<string, ClaimValue>();
  for (const v of values) if (Number(v.short_minor) > 0) byAccount.set(v.account_id, v);
  // Priority is the list's order: position, then the older goal first (positions are per viewer,
  // so two can share one).
  const position = new Map(rows.map((g, i) => [g.id, { ...g, position: i }]));
  return [...byAccount.values()].map((v) => {
    const short = Number(v.short_minor);
    // Lowest priority first: the highest position gives way first.
    const fixed = claims
      .filter(
        (c) => c.accountId === v.account_id && c.amountMinor !== null && position.has(c.goalId),
      )
      .sort((a, b) => position.get(b.goalId)!.position - position.get(a.goalId)!.position);
    let left = short;
    const suggestion: GoalShortfall['suggestion'] = [];
    for (const c of fixed) {
      if (left === 0) break;
      const take = Math.min(left, c.amountMinor!);
      suggestion.push({ goalId: c.goalId, amountMinor: take });
      left -= take;
    }
    return {
      accountId: v.account_id,
      accountName: v.account_name,
      shortMinor: short,
      goals: fixed.map((c) => ({
        goalId: c.goalId,
        name: position.get(c.goalId)!.name,
        amountMinor: c.amountMinor!,
      })),
      suggestion,
      canResolve: owned.has(v.account_id),
    };
  });
}

const canEdit = (ctx: HouseholdContext, g: GoalRow) =>
  ctx.role !== 'viewer' && (g.memberId === null || g.memberId === ctx.memberId);

/** GOAL-03/04: owners and members change the household's goals, you change yours. */
function checkCanEdit(ctx: HouseholdContext, g: GoalRow): void {
  if (!canEdit(ctx, g)) throw problems.forbidden('Viewers can’t change goals.');
}

/** Row-level security hides another member's goal: it's simply not found (G15). */
async function findGoal(tx: Executor, id: string): Promise<GoalRow> {
  const [row] = await tx.select().from(goals).where(eq(goals.id, id));
  if (!row) throw problems.notFound();
  return row;
}

async function activeMembers(tx: Executor, householdId: string): Promise<number> {
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(householdMembers)
    .where(
      and(eq(householdMembers.householdId, householdId), isNull(householdMembers.leftAt)),
    )) as [{ n: number }];
  return n;
}

/** Changes to the household's goals are in its activity; your own goals' are yours. */
async function record(
  activity: HouseholdActivity,
  row: GoalRow,
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await activity.record({
    action,
    targetType: 'goal',
    targetId: row.id,
    metadata,
    visibleToHousehold: row.memberId === null,
  });
}
