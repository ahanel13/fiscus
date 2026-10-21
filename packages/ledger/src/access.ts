// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Executor } from '@fiscus/db';
import type { AccessLevel } from '@fiscus/shared';
import { sql } from 'drizzle-orm';

/** Every account the caller can see, with their level (fiscus_account_access()). */
export async function accessLevels(tx: Executor): Promise<Map<string, AccessLevel>> {
  const { rows } = await tx.execute<{ account_id: string; level: AccessLevel }>(
    sql`SELECT account_id, level FROM fiscus_account_access()`,
  );
  return new Map(rows.map((r) => [r.account_id, r.level]));
}
