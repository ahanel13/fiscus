// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import { auditEvents, verifyChain } from '@fiscus/db';
import type { ActivityItem, ActivityVerification } from '@fiscus/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { ZodPipe } from '../common/zod-pipe.js';
import { Household, type HouseholdContext, HouseholdGuard } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

const listQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The household's activity feed (HH-11/12) and tamper check (ADR 0013). Members see
 * household-visible events; per-record visibility filtering arrives with accounts (#20).
 */
@Controller('api/v1/households/:householdId/activity')
@UseGuards(HouseholdGuard)
export class ActivityController {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
  ) {}

  @Get()
  async list(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(listQuery)) query: z.infer<typeof listQuery>,
  ): Promise<{ data: ActivityItem[]; meta: { nextBefore: number | null } }> {
    const rows = await this.scope.run(ctx, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.householdId, ctx.householdId),
            eq(auditEvents.visibleToHousehold, true),
            isNotNull(auditEvents.seq),
            query.before ? lt(auditEvents.seq, query.before) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.seq))
        .limit(query.limit),
    );
    const data = await Promise.all(
      rows.map(async (r): Promise<ActivityItem> => ({
        seq: r.seq!,
        occurredAt: r.occurredAt.toISOString(),
        action: r.action,
        actorKind: r.actorKind,
        actorMemberId: r.actorMemberId,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
        changes: r.changesEnc
          ? (JSON.parse(
              await this.crypto.decrypt(
                {
                  householdId: ctx.householdId,
                  table: 'audit_events',
                  column: 'changes_enc',
                  rowId: `${ctx.householdId}:${r.seq}`,
                },
                r.changesEnc,
              ),
            ) as ActivityItem['changes'])
          : null,
      })),
    );
    const last = rows.at(-1);
    return { data, meta: { nextBefore: rows.length === query.limit && last ? last.seq : null } };
  }

  /** Recomputes the household's hash chain. Clients pin the head to detect rewrites (#264). */
  @Get('verify')
  async verify(@Household() ctx: HouseholdContext): Promise<{ data: ActivityVerification }> {
    const { scopeId: _scope, ...result } = await this.scope.run(ctx, (tx) =>
      verifyChain(tx, ctx.householdId),
    );
    return { data: result };
  }
}
