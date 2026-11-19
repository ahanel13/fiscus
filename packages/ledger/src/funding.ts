// SPDX-License-Identifier: AGPL-3.0-or-later
import { type Executor, transactions } from '@fiscus/db';
import { and, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { ownersOnDates } from './owners.js';
import { type HouseholdRanges, transactionDate } from './ranges.js';

/** Money a member moved into a joint account (budgeting walkthrough D2). */
export interface MemberContribution {
  transactionId: string;
  accountId: string;
  memberId: string;
  /** The date it counts on, per the household's date basis. */
  date: string;
  amountMinor: number;
}

/**
 * Contributions into `accountIds` from `from` on, by who made them (#113): transfers in whose
 * other side is an account one member owns alone. When that account is hidden from the caller,
 * the member comes from fiscus_transfer_counterparts(), which names people, never the account
 * (F1). The same transfers the household's budget counts as contributions; settle-ups and
 * excluded transactions aren't.
 */
export async function memberContributions(
  tx: Executor,
  accountIds: readonly string[],
  from: string,
  dateBasis: HouseholdRanges['dateBasis'],
): Promise<MemberContribution[]> {
  if (accountIds.length === 0) return [];
  const date = transactionDate(dateBasis);
  const legs = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amountMinor: transactions.amountMinor,
      group: transactions.transferGroupId,
      date: sql<string>`${date}::text`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.accountId, [...accountIds]),
        isNotNull(transactions.transferGroupId),
        isNull(transactions.deletedAt),
        eq(transactions.excluded, false),
        eq(transactions.isSettlement, false),
        sql`${transactions.amountMinor} > 0`,
        gte(date, from),
      ),
    );
  if (legs.length === 0) return [];
  // The other side of each, where the caller can see it.
  const others = await tx
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      group: transactions.transferGroupId,
      effectiveDate: transactions.effectiveDate,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.transferGroupId, [...new Set(legs.map((l) => l.group!))]),
        isNull(transactions.deletedAt),
      ),
    );
  const ownersOn = await ownersOnDates(tx, [...new Set(others.map((o) => o.accountId))]);
  const hidden = legs.filter((l) => !others.some((o) => o.group === l.group && o.id !== l.id));
  const counterparts = new Map<string, string[]>();
  if (hidden.length) {
    const { rows } = await tx.execute<{ transaction_id: string; member_id: string }>(
      sql`SELECT transaction_id, member_id FROM fiscus_transfer_counterparts(${sql.param(hidden.map((h) => h.id))}::uuid[])`,
    );
    for (const r of rows) {
      counterparts.set(r.transaction_id, [
        ...(counterparts.get(r.transaction_id) ?? []),
        r.member_id,
      ]);
    }
  }
  const out: MemberContribution[] = [];
  for (const leg of legs) {
    const other = others.find((o) => o.group === leg.group && o.id !== leg.id);
    const owners = other
      ? ownersOn(other.accountId, other.effectiveDate).map((o) => o.memberId)
      : (counterparts.get(leg.id) ?? []);
    // From one person's own account: a move between joint accounts is no one's contribution.
    if (owners.length !== 1) continue;
    out.push({
      transactionId: leg.id,
      accountId: leg.accountId,
      memberId: owners[0]!,
      date: leg.date,
      amountMinor: leg.amountMinor,
    });
  }
  return out;
}
