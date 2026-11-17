// SPDX-License-Identifier: AGPL-3.0-or-later
import { FieldCrypto } from '@fiscus/crypto';
import {
  type DbHandle,
  type Executor,
  householdMembers,
  setContext,
  settleUpSimplifyConsents,
  withContext,
} from '@fiscus/db';
import { guardActivity, type HouseholdActivity } from '@fiscus/ledger';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { DB } from '../database/database.module.js';
import type { HouseholdContext } from './household-context.js';

// The activity gate lives in @fiscus/ledger, so the worker records its writes the same way. This
// is the api's side of it: a Nest provider that opens the request's household transaction.
export {
  type Actor,
  type ActivityInput,
  HouseholdActivity,
  UnrecordedWriteError,
} from '@fiscus/ledger';

/**
 * The only way household feature code reaches the database. Every query runs in a transaction
 * carrying the household context that row-level security enforces (#18/#19), and any transaction
 * that writes household data must record activity, or it rolls back (ADR 0013).
 * Enforced by architecture.test.ts.
 */
@Injectable()
export class HouseholdScope {
  constructor(
    @Inject(DB) private readonly db: DbHandle,
    private readonly crypto: FieldCrypto,
  ) {}

  run<T>(
    ctx: HouseholdContext,
    fn: (tx: Executor, activity: HouseholdActivity) => Promise<T>,
  ): Promise<T> {
    return withContext(
      this.db.db,
      { householdId: ctx.householdId, memberId: ctx.memberId, userId: ctx.userId, system: false },
      (tx) =>
        guardActivity(
          tx,
          ctx.householdId,
          { kind: 'user', userId: ctx.userId, memberId: ctx.memberId },
          this.crypto,
          fn,
        ),
    );
  }

  /**
   * For becoming a member: creating a household, or joining one. `enter` runs in the household's
   * context with the user (if known yet) and no member, and makes the membership through a
   * definer function that checks that context (fiscus_create_household, fiscus_join_household;
   * #271). Then `fn` runs as the new member, under the usual policies. The api never has system
   * context: only the worker's database role does.
   */
  join<T>(
    householdId: string,
    userId: string | null,
    enter: (tx: Executor) => Promise<{ userId: string; memberId: string }>,
    fn: (tx: Executor, activity: HouseholdActivity, member: { memberId: string }) => Promise<T>,
  ): Promise<T> {
    return withContext(
      this.db.db,
      { householdId, memberId: null, userId, system: false },
      async (tx) => {
        const who = await enter(tx);
        await setContext(tx, who);
        return guardActivity(
          tx,
          householdId,
          { kind: 'user', userId: who.userId, memberId: who.memberId },
          this.crypto,
          (tx, activity) => fn(tx, activity, { memberId: who.memberId }),
        );
      },
    );
  }

  /**
   * Reads what another member sees, for the one thing they agreed to: settling with the fewest
   * transfers (#262, D31). A plan between three or more people needs everyone's balances with each
   * other, and no one person can see them all. So this runs `fn` in `memberId`'s own context, as
   * the worker does for their notifications, and only when both of you have agreed. It's read-only:
   * nothing can be written as them. What comes back stays on the server; the caller returns only
   * the payments you're part of.
   */
  readAsAgreed<T>(
    ctx: HouseholdContext,
    memberId: string,
    fn: (tx: Executor) => Promise<T>,
  ): Promise<T> {
    return withContext(
      this.db.db,
      { householdId: ctx.householdId, memberId: ctx.memberId, userId: ctx.userId, system: false },
      async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ ONLY`);
        const rows = await tx
          .select({ memberId: householdMembers.id, userId: householdMembers.userId })
          .from(householdMembers)
          .innerJoin(
            settleUpSimplifyConsents,
            and(
              eq(settleUpSimplifyConsents.householdId, householdMembers.householdId),
              eq(settleUpSimplifyConsents.memberId, householdMembers.id),
            ),
          )
          .where(
            and(
              inArray(householdMembers.id, [ctx.memberId, memberId]),
              isNull(householdMembers.leftAt),
              isNotNull(householdMembers.userId),
              ne(householdMembers.role, 'viewer'),
            ),
          );
        const them = rows.find((r) => r.memberId === memberId);
        if (memberId === ctx.memberId || rows.length !== 2 || !them?.userId) {
          throw new Error('Both members must have agreed to settle with the fewest transfers');
        }
        await setContext(tx, { userId: them.userId, memberId });
        return fn(tx);
      },
    );
  }
}
