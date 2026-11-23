// SPDX-License-Identifier: AGPL-3.0-or-later
import { consentRequests, type Executor, householdMembers } from '@fiscus/db';
import { householdRanges, type HouseholdActivity } from '@fiscus/ledger';
import type { ConsentRequest, ConsentRequestKind, CreateConsentRequest } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

/** How long an ended request stays in the list. */
const ENDED_SHOWN_DAYS = 30;

/**
 * Consent requests (ADR 0012 §Departures item 5, #265, D34): asking another member to agree to
 * something only they can agree to. A request waits 14 days. The person asked answers it, by
 * agreeing (for a split by income, under Shared costs: `acceptConsentRequests`) or declining;
 * whoever asked can withdraw it. Once the 14 days are over it has expired, and whoever asked can
 * ask again. Each step is in the household's activity. Only the worker ends one as expired (and
 * tells whoever asked); until it gets to one, it's shown as expired here, and can't be answered.
 *
 * Asking never changes anything by itself: until someone agrees, what needed their agreement
 * doesn't happen (a split by income falls back to the household default).
 */
@Injectable()
export class ConsentRequestsService {
  constructor(private readonly scope: HouseholdScope) {}

  /** Open requests, and those that ended in the last 30 days, newest first. */
  async list(ctx: HouseholdContext): Promise<ConsentRequest[]> {
    return this.scope.run(ctx, async (tx) => {
      const rows = await tx
        .select()
        .from(consentRequests)
        .where(
          or(
            eq(consentRequests.status, 'pending'),
            gt(consentRequests.closedAt, sql`now() - make_interval(days => ${ENDED_SHOWN_DAYS})`),
          ),
        )
        .orderBy(desc(consentRequests.createdAt))
        .limit(200);
      return rows.map(toApi);
    });
  }

  async create(ctx: HouseholdContext, input: CreateConsentRequest): Promise<ConsentRequest> {
    return this.scope.run(ctx, async (tx, activity) => {
      if (input.memberId === ctx.memberId) {
        throw new Problem(422, 'ask_yourself', 'Agree for yourself instead of asking');
      }
      const [them] = await tx
        .select({ role: householdMembers.role, userId: householdMembers.userId })
        .from(householdMembers)
        .where(and(eq(householdMembers.id, input.memberId), isNull(householdMembers.leftAt)));
      if (!them) throw problems.notFound();
      if (them.role === 'viewer' || !them.userId) {
        throw new Problem(
          422,
          'cannot_agree',
          'Only someone who signs in, and isn’t a viewer, can agree',
        );
      }
      if (await agreed(tx, input.kind, input.memberId, ctx.householdId)) {
        throw new Problem(409, 'already_agreed', 'They’ve already agreed');
      }
      const [row] = await tx
        .insert(consentRequests)
        .values({
          householdId: ctx.householdId,
          kind: input.kind,
          requestedByMemberId: ctx.memberId,
          memberId: input.memberId,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) {
        throw new Problem(
          409,
          'already_asked',
          'They’ve already been asked',
          'They have until the request ends to answer it.',
        );
      }
      await activity.record({
        action: 'consent_request.created',
        targetType: 'consent_request',
        targetId: row.id,
        metadata: { kind: row.kind, memberId: row.memberId, expiresAt: row.expiresAt },
      });
      return toApi(row);
    });
  }

  /** The person asked says no. Nothing changes: it's as if they'd never been asked. */
  async decline(ctx: HouseholdContext, id: string): Promise<ConsentRequest> {
    return this.#end(ctx, id, 'declined');
  }

  /** Whoever asked takes it back. */
  async withdraw(ctx: HouseholdContext, id: string): Promise<ConsentRequest> {
    return this.#end(ctx, id, 'withdrawn');
  }

  async #end(
    ctx: HouseholdContext,
    id: string,
    status: 'declined' | 'withdrawn',
  ): Promise<ConsentRequest> {
    return this.scope.run(ctx, async (tx, activity) => {
      const [row] = await tx
        .select()
        .from(consentRequests)
        .where(
          and(
            eq(consentRequests.id, id),
            status === 'declined'
              ? eq(consentRequests.memberId, ctx.memberId)
              : eq(consentRequests.requestedByMemberId, ctx.memberId),
          ),
        );
      if (!row) throw problems.notFound();
      if (toApi(row).status !== 'pending') {
        throw new Problem(409, 'request_ended', 'This request has already ended');
      }
      const [ended] = await tx
        .update(consentRequests)
        .set({ status, closedAt: sql`now()` })
        .where(eq(consentRequests.id, id))
        .returning();
      await activity.record({
        action: `consent_request.${status}`,
        targetType: 'consent_request',
        targetId: id,
        metadata: { kind: row.kind, memberId: row.memberId },
      });
      return toApi(ended!);
    });
  }
}

/**
 * Agreeing answers every open request of that kind to you: called in the same transaction as the
 * agreement itself (a split by income: `IncomeSplitService.consent`).
 */
export async function acceptConsentRequests(
  tx: Executor,
  activity: HouseholdActivity,
  memberId: string,
  kind: ConsentRequestKind,
): Promise<void> {
  const accepted = await tx
    .update(consentRequests)
    .set({ status: 'accepted', closedAt: sql`now()` })
    .where(
      and(
        eq(consentRequests.memberId, memberId),
        eq(consentRequests.kind, kind),
        eq(consentRequests.status, 'pending'),
        gt(consentRequests.expiresAt, sql`now()`),
      ),
    )
    .returning();
  for (const row of accepted) {
    await activity.record({
      action: 'consent_request.accepted',
      targetType: 'consent_request',
      targetId: row.id,
      metadata: { kind: row.kind, memberId: row.memberId },
    });
  }
}

/** Whether they've already agreed, today. */
async function agreed(
  tx: Executor,
  kind: ConsentRequestKind,
  memberId: string,
  householdId: string,
): Promise<boolean> {
  switch (kind) {
    case 'income_split': {
      const { today } = await householdRanges(tx, householdId);
      const { rows } = await tx.execute<{ consented: boolean }>(
        sql`SELECT consented FROM fiscus_income_split_status(${today}::date)
            WHERE member_id = ${memberId}`,
      );
      return rows[0]?.consented ?? false;
    }
  }
}

/** One whose 14 days are over is expired, whether or not the worker has got to it yet. */
function toApi(row: typeof consentRequests.$inferSelect): ConsentRequest {
  const lapsed = row.status === 'pending' && row.expiresAt.getTime() <= Date.now();
  return {
    id: row.id,
    kind: row.kind,
    requestedByMemberId: row.requestedByMemberId,
    memberId: row.memberId,
    status: lapsed ? 'expired' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
  };
}
