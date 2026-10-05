// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import { auditEvents, verifyChain } from '@fiscus/db';
import type { ActivityItem, ActivityVerification } from '@fiscus/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { Problem } from '../common/problem.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { Household, type HouseholdContext, HouseholdGuard } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The household's activity feed (HH-11/12) and tamper check (ADR 0013). Members see
 * household-visible events, minus events about accounts hidden from them (row-level security).
 *
 * Positions in the hash chain are never exposed: gaps in them would reveal that hidden events
 * exist (accounts-and-visibility §6). Items carry an opaque id, which is the event's position
 * encrypted with the household key and bound to the viewer, and it doubles as the page cursor.
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
  ): Promise<{ data: ActivityItem[]; meta: { nextCursor: string | null } }> {
    const before = query.cursor ? await this.#decodeCursor(ctx, query.cursor) : undefined;
    const rows = await this.scope.run(ctx, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.householdId, ctx.householdId),
            eq(auditEvents.visibleToHousehold, true),
            isNotNull(auditEvents.seq),
            before ? lt(auditEvents.seq, before) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.seq))
        .limit(query.limit),
    );
    const data = await Promise.all(
      rows.map(async (r): Promise<ActivityItem> => ({
        id: await this.#encodeCursor(ctx, r.seq!),
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
    return {
      data,
      meta: { nextCursor: rows.length === query.limit ? (data.at(-1)?.id ?? null) : null },
    };
  }

  /**
   * Recomputes the household's whole hash chain. It runs in system context, since members can't
   * see events about accounts hidden from them, and it reports only whether the history is intact.
   */
  @Get('verify')
  async verify(@Household() ctx: HouseholdContext): Promise<{ data: ActivityVerification }> {
    const result = await this.scope.asSystem(
      ctx.householdId,
      { kind: 'user', userId: ctx.userId, memberId: ctx.memberId },
      (tx) => verifyChain(tx, ctx.householdId),
    );
    return { data: { ok: result.ok, checkedAt: new Date().toISOString() } };
  }

  #cursorContext(ctx: HouseholdContext) {
    return {
      householdId: ctx.householdId,
      table: 'audit_events',
      column: 'feed_cursor',
      rowId: ctx.memberId,
    };
  }

  async #encodeCursor(ctx: HouseholdContext, seq: number): Promise<string> {
    return (await this.crypto.encrypt(this.#cursorContext(ctx), String(seq))).toString('base64url');
  }

  async #decodeCursor(ctx: HouseholdContext, cursor: string): Promise<number> {
    try {
      const seq = Number(
        await this.crypto.decrypt(this.#cursorContext(ctx), Buffer.from(cursor, 'base64url')),
      );
      if (Number.isSafeInteger(seq) && seq > 0) return seq;
    } catch {
      // Tampered, from another member, or from another household: all the same to the caller.
    }
    throw new Problem(
      422,
      'invalid_cursor',
      'Invalid page cursor',
      'Start again from the first page.',
    );
  }
}
