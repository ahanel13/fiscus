// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import { auditEvents, householdProof, verifyHouseholdChain } from '@fiscus/db';
import {
  type ActivityItem,
  type ActivityProof,
  type ActivityVerification,
  historyHashSchema,
  type HistoryIntegrityReport,
  historyIntegrityReportSchema,
  historyPointSchema,
} from '@fiscus/shared';
import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter.js';
import { Problem, problems } from '../common/problem.js';
import { ZodPipe } from '../common/zod-pipe.js';
import { Household, type HouseholdContext, HouseholdGuard } from './household-context.js';
import { HouseholdScope } from './household-scope.js';

const listQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** From a verified point (both), or from nothing (neither): a device's first check. */
const proofQuery = z
  .object({
    after: z.coerce.number().pipe(historyPointSchema.shape.seq).optional(),
    hash: historyHashSchema.optional(),
  })
  .strict()
  .refine((q) => (q.after === undefined) === (q.hash === undefined), {
    message: 'Give both after and hash, or neither',
    path: ['hash'],
  });

/** Reports of a failed history check, per member: enough for a few devices, not for spam. */
const REPORT_LIMIT = { limit: 5, windowMs: 60 * 60_000 };

/**
 * The household's activity feed (HH-11/12) and tamper check (ADR 0013). Members see
 * household-visible events, minus events about accounts hidden from them (row-level security).
 *
 * The feed never exposes positions in the hash chain: gaps in them would reveal where hidden
 * events are (accounts-and-visibility §6). Items carry an opaque id, which is the event's position
 * encrypted with the household key and bound to the viewer, and it doubles as the page cursor.
 * The proof (#264) does reveal positions and counts, hidden events included, as hashes only: an
 * accepted disclosure, so a member's browser can check the history for itself.
 */
@Controller('api/v1/households/:householdId/activity')
@UseGuards(HouseholdGuard)
export class ActivityController {
  constructor(
    private readonly scope: HouseholdScope,
    private readonly crypto: FieldCrypto,
    private readonly limiter: RateLimiter,
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
   * Recomputes the household's whole hash chain, including events about accounts hidden from the
   * caller (through fiscus_household_chain(), #271), and reports only whether it's intact.
   */
  @Get('verify')
  async verify(@Household() ctx: HouseholdContext): Promise<{ data: ActivityVerification }> {
    const result = await this.scope.run(ctx, (tx) => verifyHouseholdChain(tx, ctx.householdId));
    return { data: { ok: result.ok, checkedAt: new Date().toISOString() } };
  }

  /**
   * A proof that the history only grew since the caller's last verified point (ADR 0013 §4,
   * #264): the leaves of every entry after it, hidden ones included, and the head. The browser
   * folds them itself, so a server that rewrote history can't just say it's intact.
   */
  @Get('proof')
  async proof(
    @Household() ctx: HouseholdContext,
    @Query(new ZodPipe(proofQuery)) query: z.infer<typeof proofQuery>,
  ): Promise<{ data: ActivityProof }> {
    const from =
      query.after !== undefined && query.hash ? { seq: query.after, hash: query.hash } : undefined;
    const proof = await this.scope.run(ctx, (tx) => householdProof(tx, ctx.householdId, from));
    if (proof.ok) {
      const { ok: _ok, ...data } = proof;
      return { data };
    }
    throw proof.reason === 'history_diverged'
      ? new Problem(
          409,
          'history_diverged',
          'The history no longer contains your last verified point',
          'The entry at that position has a different hash, or no longer exists.',
        )
      : new Problem(
          409,
          'proof_unavailable',
          'This part of the history can’t be proven',
          'It includes entries recorded in an older format.',
        );
  }

  /**
   * A device's report that the history failed its check. Recorded as a household-visible event,
   * as that device's claim, next to the server's own check; the device's warning doesn't wait for
   * it. Any member can report, a few times an hour.
   */
  @Post('integrity-reports')
  @HttpCode(204)
  async report(
    @Household() ctx: HouseholdContext,
    @Body(new ZodPipe(historyIntegrityReportSchema)) body: HistoryIntegrityReport,
  ): Promise<void> {
    const limited = this.limiter.consume(
      `history-report:${ctx.householdId}:${ctx.memberId}`,
      REPORT_LIMIT.limit,
      REPORT_LIMIT.windowMs,
    );
    if (!limited.allowed) throw problems.rateLimited(limited.retryAfterSeconds);
    await this.scope.run(ctx, async (tx, activity) => {
      const server = await verifyHouseholdChain(tx, ctx.householdId);
      await activity.record({
        action: 'history.integrity_check_failed',
        targetType: 'household',
        targetId: ctx.householdId,
        metadata: {
          claim: 'device',
          reason: body.reason,
          lastVerified: body.lastVerified,
          observed: body.observed,
          serverCheck: { ok: server.ok, checkedAt: new Date().toISOString() },
        },
      });
    });
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
