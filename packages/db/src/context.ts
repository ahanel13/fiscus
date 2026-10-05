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
  /** Worker jobs acting for the whole household (still limited to `householdId`). */
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

/** Context for worker jobs that act for a whole household. */
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
