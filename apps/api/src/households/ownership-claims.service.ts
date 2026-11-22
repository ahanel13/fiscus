// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, householdMembers, households, ownershipClaims, users } from '@fiscus/db';
import { OWNERS_AWAY_DAYS, type OwnershipClaim, type OwnershipClaimState } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { violatedConstraint } from '../common/db-errors.js';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

// Ownership claims (#267, ADR 0012 §Departures item 7, permissions HH-17, D35). A member starts
// one only while every owner has been away from Fiscus for 30 days; any owner rejects it, and the
// claimant withdraws it. The worker tells the owners, cancels it if one comes back, and makes the
// claimant an owner once the 30 days are over. The database checks each of these too (0116).

type Row = typeof ownershipClaims.$inferSelect;

const toClaim = (r: Row): OwnershipClaim => ({
  id: r.id,
  claimantMemberId: r.claimantMemberId,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
});

const ownersActive = () =>
  new Problem(
    409,
    'owners_active',
    'An owner has used Fiscus recently',
    `You can claim ownership once no owner has used Fiscus for ${OWNERS_AWAY_DAYS} days. Until then, ask them directly.`,
  );
const claimOpen = () =>
  new Problem(409, 'claim_open', 'Someone has already claimed ownership of this household');
const claimEnded = () => new Problem(409, 'claim_ended', 'This claim has already ended');

@Injectable()
export class OwnershipClaimsService {
  constructor(private readonly scope: HouseholdScope) {}

  /** The open claim, and whether you could start one: only members ever learn that. */
  async current(ctx: HouseholdContext): Promise<OwnershipClaimState> {
    return this.scope.run(ctx, async (tx) => {
      const open = await this.#open(tx, ctx.householdId);
      const canClaim =
        ctx.role === 'member' && !open && (await this.#ownersAway(tx, ctx.householdId));
      return { claim: open ? toClaim(open) : null, canClaim };
    });
  }

  /** HH-17: a member claims ownership. Owners and viewers are refused before this (403). */
  async start(ctx: HouseholdContext): Promise<OwnershipClaim> {
    return this.scope
      .run(ctx, async (tx, activity) => {
        await this.#lockHousehold(tx, ctx.householdId);
        if (await this.#open(tx, ctx.householdId)) throw claimOpen();
        if (!(await this.#ownersAway(tx, ctx.householdId))) throw ownersActive();
        const [row] = await tx
          .insert(ownershipClaims)
          .values({ householdId: ctx.householdId, claimantMemberId: ctx.memberId })
          .returning();
        await activity.record({
          action: 'ownership_claim.started',
          targetType: 'ownership_claim',
          targetId: row!.id,
          metadata: { claimantMemberId: ctx.memberId, endsAt: row!.endsAt.toISOString() },
        });
        return toClaim(row!);
      })
      .catch((err: unknown) => {
        const constraint = violatedConstraint(err);
        if (constraint === 'ownership_claims_owners_away') throw ownersActive();
        if (constraint === 'ownership_claims_open') throw claimOpen();
        throw err;
      });
  }

  /** HH-17: any owner rejects a claim, while it's open. One click: no reason needed. */
  async reject(ctx: HouseholdContext, claimId: string): Promise<void> {
    await this.#end(ctx, claimId, 'rejected');
  }

  /** The claimant withdraws their own claim. */
  async withdraw(ctx: HouseholdContext, claimId: string): Promise<void> {
    await this.#end(ctx, claimId, 'withdrawn');
  }

  async #end(
    ctx: HouseholdContext,
    claimId: string,
    status: 'rejected' | 'withdrawn',
  ): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      await this.#lockHousehold(tx, ctx.householdId);
      const [claim] = await tx
        .select()
        .from(ownershipClaims)
        .where(
          and(eq(ownershipClaims.id, claimId), eq(ownershipClaims.householdId, ctx.householdId)),
        )
        .for('update');
      if (!claim) throw problems.notFound();
      if (status === 'withdrawn' && claim.claimantMemberId !== ctx.memberId) {
        throw problems.forbidden('Only whoever claimed ownership can withdraw the claim.');
      }
      if (claim.status !== 'open') throw claimEnded();
      await tx
        .update(ownershipClaims)
        .set({ status, closedByMemberId: ctx.memberId })
        .where(eq(ownershipClaims.id, claimId));
      await activity.record({
        action: `ownership_claim.${status}`,
        targetType: 'ownership_claim',
        targetId: claimId,
        metadata: { claimantMemberId: claim.claimantMemberId },
      });
    });
  }

  async #open(tx: Executor, householdId: string): Promise<Row | undefined> {
    const [row] = await tx
      .select()
      .from(ownershipClaims)
      .where(and(eq(ownershipClaims.householdId, householdId), eq(ownershipClaims.status, 'open')));
    return row;
  }

  /** Whether no current owner has used Fiscus for OWNERS_AWAY_DAYS. */
  async #ownersAway(tx: Executor, householdId: string): Promise<boolean> {
    const [recent] = await tx
      .select({ id: householdMembers.id })
      .from(householdMembers)
      .innerJoin(users, eq(users.id, householdMembers.userId))
      .where(
        and(
          eq(householdMembers.householdId, householdId),
          eq(householdMembers.role, 'owner'),
          isNull(householdMembers.leftAt),
          gt(users.lastActiveAt, sql`now() - make_interval(days => ${OWNERS_AWAY_DAYS})`),
        ),
      )
      .limit(1);
    return !recent;
  }

  /** As for role changes: one step at a time in a household. */
  async #lockHousehold(tx: Executor, householdId: string): Promise<void> {
    await tx
      .select({ id: households.id })
      .from(households)
      .where(eq(households.id, householdId))
      .for('update');
  }
}
