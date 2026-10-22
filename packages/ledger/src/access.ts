// SPDX-License-Identifier: AGPL-3.0-or-later
import { accountOwners, accounts, type Executor } from '@fiscus/db';
import type { AccessLevel } from '@fiscus/shared';
import { and, eq, sql } from 'drizzle-orm';

/** Every account the caller can see, with their level (fiscus_account_access()). */
export async function accessLevels(tx: Executor): Promise<Map<string, AccessLevel>> {
  const { rows } = await tx.execute<{ account_id: string; level: AccessLevel }>(
    sql`SELECT account_id, level FROM fiscus_account_access()`,
  );
  return new Map(rows.map((r) => [r.account_id, r.level]));
}

/**
 * Every account `memberId` can see, with their level, as fiscus_account_access() gives it to them.
 * For system context (the worker), which sees every account, to act within one member's reach:
 * sync links transfers only where the connection's owner could (#80).
 */
export async function memberAccessLevels(
  tx: Executor,
  memberId: string,
): Promise<Map<string, AccessLevel>> {
  const rows = await tx
    .select({ id: accounts.id, visibility: accounts.visibility, owner: accountOwners.memberId })
    .from(accounts)
    .leftJoin(
      accountOwners,
      and(eq(accountOwners.accountId, accounts.id), eq(accountOwners.memberId, memberId)),
    );
  const levels = new Map<string, AccessLevel>();
  for (const r of rows) {
    if (r.owner) levels.set(r.id, 'owner');
    else if (r.visibility !== 'private') levels.set(r.id, r.visibility);
  }
  return levels;
}
