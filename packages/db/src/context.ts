// SPDX-License-Identifier: AGPL-3.0-or-later
import { sql } from 'drizzle-orm';
import type { Database, Executor } from './client.js';

/**
 * Who a query runs for. Every household-scoped query runs inside `withContext`, which sets these
 * as transaction-local Postgres settings (data model §4.2) that row-level security reads (#19).
 */
export interface DbContext {
  /** Null for user-level work that spans households (listing your own memberships). */
  householdId: string | null;
  memberId: string | null;
  userId: string | null;
  /**
   * Worker jobs acting for the whole household (still limited to `householdId`). The worker's
   * only: the api never sets it (#271), and from #376 only the fiscus_worker login gets it.
   */
  system: boolean;
}

export async function withContext<T>(
  db: Database,
  ctx: DbContext,
  fn: (tx: Executor) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    // set_config(..., true) is transaction-local, so pooled connections never leak context.
    await tx.execute(sql`
      SELECT set_config('app.household_id', ${ctx.householdId ?? ''}, true),
             set_config('app.member_id', ${ctx.memberId ?? ''}, true),
             set_config('app.user_id', ${ctx.userId ?? ''}, true),
             set_config('app.system', ${ctx.system ? 'on' : 'off'}, true)`);
    return fn(tx);
  });
}

/**
 * Changes who the transaction runs for, part way through: after a definer function has made the
 * caller a member (creating or joining a household), the rest runs as that member.
 */
export async function setContext(
  tx: Executor,
  ctx: Partial<Pick<DbContext, 'userId' | 'memberId'>>,
): Promise<void> {
  if (ctx.userId !== undefined) {
    await tx.execute(sql`SELECT set_config('app.user_id', ${ctx.userId ?? ''}, true)`);
  }
  if (ctx.memberId !== undefined) {
    await tx.execute(sql`SELECT set_config('app.member_id', ${ctx.memberId ?? ''}, true)`);
  }
}

/** Context for worker jobs that act for a whole household. Works only as fiscus_worker (#271). */
export const systemContext = (householdId: string): DbContext => ({
  householdId,
  memberId: null,
  userId: null,
  system: true,
});

/** Context for user-level reads across households: only the user's own memberships are visible. */
export const userContext = (userId: string): DbContext => ({
  householdId: null,
  memberId: null,
  userId,
  system: false,
});
