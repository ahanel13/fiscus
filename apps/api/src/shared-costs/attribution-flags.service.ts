// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  accountOwners,
  attributionFlags,
  auditEvents,
  type Executor,
  transactionAttributions,
  transactions,
} from '@fiscus/db';
import { accessLevels } from '@fiscus/ledger';
import type { AttributionFlag, AttributionFlagStatus } from '@fiscus/shared';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Problem, problems } from '../common/problem.js';
import type { HouseholdContext } from '../households/household-context.js';
import { HouseholdScope } from '../households/household-scope.js';

type Row = typeof attributionFlags.$inferSelect;

/**
 * Flagging an attribution change (ADR 0006 F6, #60, walkthrough D18). Anyone it involves (who it
 * was for before the last change, who it's for now, and who paid) may flag it; it then waits
 * outside the balance on Shared costs. The paying account's owners resolve it, or whoever
 * flagged it withdraws. No approval workflow: resolving is saying it's sorted, whatever changed.
 */
@Injectable()
export class AttributionFlagsService {
  constructor(private readonly scope: HouseholdScope) {}

  async status(ctx: HouseholdContext, transactionId: string): Promise<AttributionFlagStatus> {
    return this.scope.run(ctx, async (tx) => {
      const t = await this.#transaction(tx, transactionId);
      const flag = await this.#open(tx, transactionId);
      const change = await this.#lastChange(tx, ctx, transactionId);
      const involved = await this.#involved(tx, t, change);
      const changed = change !== null || involved.explicit;
      const owner = (await accessLevels(tx)).get(t.accountId) === 'owner';
      const writer = ctx.role !== 'viewer';
      return {
        flag: flag ? present(flag) : null,
        canFlag:
          writer &&
          !flag &&
          changed &&
          change?.actorMemberId !== ctx.memberId &&
          involved.members.has(ctx.memberId),
        canResolve: writer && !!flag && (owner || flag.flaggedByMemberId === ctx.memberId),
        changedByMemberId: change?.actorMemberId ?? null,
      };
    });
  }

  /** ATT-03: someone the last attribution change involves flags it. */
  async flag(
    ctx: HouseholdContext,
    transactionId: string,
    note: string | undefined,
  ): Promise<AttributionFlag> {
    return this.scope.run(ctx, async (tx, activity) => {
      const t = await this.#transaction(tx, transactionId);
      const change = await this.#lastChange(tx, ctx, transactionId);
      const involved = await this.#involved(tx, t, change);
      if (!change && !involved.explicit) {
        throw new Problem(422, 'nothing_to_flag', 'Who this is for hasn’t been changed');
      }
      if (change?.actorMemberId === ctx.memberId) {
        throw new Problem(422, 'own_change', 'You made this change: change it back instead');
      }
      if (!involved.members.has(ctx.memberId)) {
        throw problems.forbidden('Only the people a change involves can flag it.');
      }
      if (await this.#open(tx, transactionId)) {
        throw new Problem(409, 'already_flagged', 'This change is already flagged');
      }
      const [row] = await tx
        .insert(attributionFlags)
        .values({
          householdId: ctx.householdId,
          transactionId,
          flaggedByMemberId: ctx.memberId,
          note: note ?? null,
        })
        .returning();
      await activity.record({
        action: 'transaction.attribution_flagged',
        targetType: 'transaction',
        targetId: transactionId,
        accountId: t.accountId,
        transactionIds: [transactionId],
        metadata: { changedBy: change?.actorMemberId ?? null },
        ...(note ? { changes: { after: { note } } } : {}),
      });
      return present(row!);
    });
  }

  /** ATT-04: the paying account's owners resolve a flag; whoever raised it may withdraw it. */
  async resolve(ctx: HouseholdContext, transactionId: string): Promise<void> {
    await this.scope.run(ctx, async (tx, activity) => {
      const t = await this.#transaction(tx, transactionId);
      const flag = await this.#open(tx, transactionId);
      if (!flag) throw problems.notFound();
      const owner = (await accessLevels(tx)).get(t.accountId) === 'owner';
      const withdrawn = flag.flaggedByMemberId === ctx.memberId;
      if (!owner && !withdrawn) {
        throw problems.forbidden('Only the owners of the paying account can resolve a flag.');
      }
      await tx
        .update(attributionFlags)
        .set({ resolvedAt: sql`now()`, resolvedByMemberId: ctx.memberId })
        .where(eq(attributionFlags.id, flag.id));
      await activity.record({
        action: withdrawn
          ? 'transaction.attribution_flag_withdrawn'
          : 'transaction.attribution_flag_resolved',
        targetType: 'transaction',
        targetId: transactionId,
        accountId: t.accountId,
        transactionIds: [transactionId],
        metadata: { flaggedBy: flag.flaggedByMemberId },
      });
    });
  }

  async #transaction(tx: Executor, id: string) {
    const [t] = await tx
      .select({ id: transactions.id, accountId: transactions.accountId })
      .from(transactions)
      .where(and(eq(transactions.id, id), isNull(transactions.deletedAt)));
    if (!t) throw problems.notFound();
    return t;
  }

  async #open(tx: Executor, transactionId: string): Promise<Row | undefined> {
    const [row] = await tx
      .select()
      .from(attributionFlags)
      .where(
        and(eq(attributionFlags.transactionId, transactionId), isNull(attributionFlags.resolvedAt)),
      );
    return row;
  }

  /**
   * The last change to who it's for that you can see. Row-level security hides changes to an
   * account you can't see, so someone it's shared with only through attribution (F1) sees none:
   * for them, that it's set by a person at all (`explicit`) is the change.
   */
  async #lastChange(tx: Executor, ctx: HouseholdContext, transactionId: string) {
    const [e] = await tx
      .select({ actorMemberId: auditEvents.actorMemberId, metadata: auditEvents.metadata })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.householdId, ctx.householdId),
          eq(auditEvents.action, 'transaction.attribution_changed'),
          eq(auditEvents.targetType, 'transaction'),
          eq(auditEvents.targetId, transactionId),
        ),
      )
      .orderBy(desc(auditEvents.id))
      .limit(1);
    return e ?? null;
  }

  /**
   * Who the last change involves: who it was for before, who it's for now, and who paid. And
   * whether who it's for was set by a person, rather than inherited from the account's owners.
   */
  async #involved(
    tx: Executor,
    t: { id: string; accountId: string },
    change: { metadata: Record<string, unknown> } | null,
  ): Promise<{ members: Set<string>; explicit: boolean }> {
    const involved = new Set<string>(
      Array.isArray(change?.metadata.before) ? (change.metadata.before as string[]) : [],
    );
    const attributed = await tx
      .select({ memberId: transactionAttributions.memberId })
      .from(transactionAttributions)
      .where(eq(transactionAttributions.transactionId, t.id));
    for (const a of attributed) involved.add(a.memberId);
    for (const o of await tx
      .select({ memberId: accountOwners.memberId })
      .from(accountOwners)
      .where(eq(accountOwners.accountId, t.accountId))) {
      involved.add(o.memberId);
    }
    // Who paid, for a transaction you see only because it's for you (F1).
    const { rows } = await tx.execute<{ member_id: string }>(
      sql`SELECT member_id FROM fiscus_attributed_payers() WHERE transaction_id = ${t.id}`,
    );
    for (const p of rows) involved.add(p.member_id);
    return { members: involved, explicit: attributed.length > 0 };
  }
}

function present(row: Row): AttributionFlag {
  return {
    id: row.id,
    flaggedByMemberId: row.flaggedByMemberId,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}
