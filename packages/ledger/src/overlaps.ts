// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, transactions } from '@fiscus/db';
import { addDays, type ImportRowResult } from '@fiscus/shared';
import { and, eq, gte, isNull, lte, ne, or } from 'drizzle-orm';

/** A row that would duplicate one already in the account: same amount, within this many days. */
export const OVERLAP_DAYS = 3;

/** What the matcher needs of an incoming row: its line, date, and amount. */
export interface OverlapCandidate {
  row: { line: number; date: string; amountMinor: number };
}

const days = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * Possible duplicates of transactions already in the account (entered by hand, synced, or from
 * another file), not counting earlier parts of this batch: same amount within three days. Each
 * existing transaction matches at most one row, closest date first. Flagged in `results` and left
 * out unless the row's line is in `include`. Returns the rows kept, in line order.
 */
export async function removeOverlaps<P extends OverlapCandidate>(
  tx: Executor,
  accountId: string | null,
  batchId: string | null,
  planned: P[],
  results: ImportRowResult[],
  include: Set<number>,
): Promise<P[]> {
  if (!accountId || planned.length === 0) return planned;
  const dates = planned.map((p) => p.row.date).sort();
  const existing = await tx
    .select({
      id: transactions.id,
      amount: transactions.amountMinor,
      date: transactions.authorizedDate,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        isNull(transactions.deletedAt),
        isNull(transactions.parentId),
        gte(transactions.authorizedDate, addDays(dates[0]!, -OVERLAP_DAYS)),
        lte(transactions.authorizedDate, addDays(dates.at(-1)!, OVERLAP_DAYS)),
        batchId
          ? or(isNull(transactions.importBatchId), ne(transactions.importBatchId, batchId))
          : undefined,
      ),
    );
  const byAmount = Map.groupBy(existing, (e) => e.amount);
  const claimed = new Set<string>();
  const kept: P[] = [];
  for (const p of [...planned].sort((a, b) => a.row.date.localeCompare(b.row.date))) {
    const match = (byAmount.get(p.row.amountMinor) ?? [])
      .filter((e) => !claimed.has(e.id) && days(e.date, p.row.date) <= OVERLAP_DAYS)
      .sort((a, b) => days(a.date, p.row.date) - days(b.date, p.row.date))[0];
    if (match) claimed.add(match.id);
    if (match && !include.has(p.row.line)) {
      results.push({
        line: p.row.line,
        status: 'overlap',
        matchId: match.id,
        message: 'May already be in this account',
      });
    } else kept.push(p);
  }
  return kept.sort((a, b) => a.row.line - b.row.line);
}
