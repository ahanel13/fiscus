// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Executor } from '@fiscus/db';
import type { IncomeShares } from '@fiscus/domain';
import { sql } from 'drizzle-orm';

/**
 * The split by income on each of `dates`, between those who had agreed by then (F4, #110): shares
 * in basis points from fiscus_income_split_shares(), never an income. Runs in the reader's own
 * context, like everything that reads it (Shared costs and the settle-up notifications, #116).
 */
export async function incomeShares(tx: Executor, dates: readonly string[]): Promise<IncomeShares> {
  const days = [...new Set(dates)];
  const byDay = new Map<string, { memberId: string; shareBps: number }[]>();
  if (days.length > 0) {
    const { rows } = await tx.execute<{ day: string; member_id: string; share_bps: number }>(
      sql`SELECT day::text AS day, member_id, share_bps
          FROM fiscus_income_split_shares(${`{${days.join(',')}}`}::date[])
          ORDER BY member_id`,
    );
    for (const r of rows) {
      byDay.set(r.day, [
        ...(byDay.get(r.day) ?? []),
        { memberId: r.member_id, shareBps: r.share_bps },
      ]);
    }
  }
  return (date) => byDay.get(date) ?? null;
}
